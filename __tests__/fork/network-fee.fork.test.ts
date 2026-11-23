import {
  type Address,
  BaseError,
  ExecutionRevertedError,
  type Hash,
  type Hex,
  createClient,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  maxUint256,
  parseAbi,
  toHex,
} from "viem";
import { getBalance } from "viem/actions";
import { mainnet } from "viem/chains";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import { NATIVE_ETH_ADDRESS } from "@/config/tokens";
import type { FeeTier } from "@/config/uniswap-v3";
import { type NetworkFeeTxRequest, buildNetworkFeeTxRequest } from "@/lib/network-fee";
import { type NetworkFeeEstimate, estimateNetworkFee } from "@/lib/read-network-fee";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";
import { DEFAULT_SLIPPAGE_BPS, getAmountOutMinimum } from "@/lib/slippage";
import { getSwapDeadline } from "@/lib/swap-transaction";

// T-11. global-setup.ts가 전용 포트(8547)에 띄운 Ethereum anvil 포크(상수로 고정한 포크 블록)에서 검증한다.
// 판정 대상 추정은 제품 요청 조립(`buildNetworkFeeTxRequest`)과 제품 추정 읽기(`estimateNetworkFee`, chainId 1)를 쓰고,
// viem `http` transport의 `fetchFn`을 프록시 핸들러에 연결해 같은 사이트 `POST /api/rpc/1` 요청으로 보낸다.
// 스왑의 최소 수령량은 같은 블록에서 anvil에 QuoterV2를 직접 호출한 견적으로 만든다(판정과 분리한 직접 읽기).
// 표본 금액·토큰·계정은 사전 확인 T-1 (1)~(3) 결과를 따른다.
// 계정 조건은 코드 없는 새 주소(`anvil_setBalance`·`anvil_dealERC20`로 준비)를 쓰거나, anvil 기본 계정이면 snapshot 뒤 EIP-7702 위임 코드를 지운다.
// cold 포크 추정 지연이 프록시 상류 시간 제한(5초)을 넘지 않도록 판정 전에 anvil에 같은 추정을 직접 보내 예열한다(T-1 (6)).
// mock 경계: 없음. `vi.stubEnv`로 프록시의 Ethereum 대상만 anvil로 바꾸고 vi.mock·fetch 스텁을 쓰지 않는다. Base·Arbitrum은 증명하지 않는다.
// 데이터 격리: 테스트마다 anvil snapshot을 잡고 끝에 revert(true 확인), 전용 포트 8547, 파일 순차 실행(vitest.fork.config.mts). env 스텁은 테스트마다 원복한다.
// DoD-8은 한 테스트 안에서 표본마다 안쪽 snapshot을 잡고 끝에 revert해 표본끼리 상태(allowance·잔액)를 나누지 않는다.

const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;
const PROXY_URL = `${SAME_SITE_ORIGIN}/api/rpc/1`;

const ETHEREUM_CHAIN_ID = 1;

// 제품 config의 Ethereum SwapRouter02와 WETH(요청 대상, allowance spender).
const ETHEREUM_SWAP_ROUTER_02 = CONTRACTS_BY_CHAIN[ETHEREUM_CHAIN_ID].swapRouter02;
const ETHEREUM_WETH = CONTRACTS_BY_CHAIN[ETHEREUM_CHAIN_ID].weth;

// 추정 계정: anvil 기본 계정 0(잠금 해제). 포크 블록에서 EIP-7702 위임 코드가 있어 snapshot 뒤 지운다(T-1 (1)).
const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// 준비 단계에서 계정에 넣는 ETH(100 ETH). 가스와 ETH 표본 금액을 넘는다.
const ACCOUNT_ETH_BALANCE = 100_000_000_000_000_000_000n;

// Ethereum 주소(리터럴).
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const QUOTER_V2: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// EIP-7702 위임 표식: `0xef0100` + 위임 대상 주소(20바이트).
const DELEGATION_DESIGNATOR_PATTERN = /^0xef0100[0-9a-f]{40}$/i;

// T-1 (1)(2) 표본. 스왑 표본은 모두 티어 100 견적이다.
const SAMPLE_FEE: FeeTier = 100;
// approve: USDC 5개(decimals 6)를 보내는 approve-required 상태.
const APPROVE_AMOUNT_RAW = 5_000_000n;
// ERC-20 스왑: USDC→DAI 5 USDC(DoD-9 표본과 같다), USDC→WETH 1000 USDC.
const USDC_TO_DAI_AMOUNT_RAW = 5_000_000n;
const USDC_TO_WETH_AMOUNT_RAW = 1_000_000_000n;
// ETH 입력 스왑: ETH→USDC 1 ETH.
const ETH_IN_AMOUNT_RAW = 1_000_000_000_000_000_000n;
// ETH 출력 스왑: USDC→ETH 1000 USDC(`unwrapWETH9`).
const ETH_OUT_AMOUNT_RAW = 1_000_000_000n;
// wrap 1 ETH.
const WRAP_AMOUNT_RAW = 1_000_000_000_000_000_000n;
// unwrap: WETH 1개를 절대값으로 주입하고 그중 0.5개를 withdraw한다.
const UNWRAP_WETH_INJECTED_RAW = 1_000_000_000_000_000_000n;
const UNWRAP_AMOUNT_RAW = 500_000_000_000_000_000n;

// cold 포크의 첫 상태 읽기는 업체 RPC에서 가져와 수 초가 걸린다.
const WARM_UP_TIMEOUT_MS = 120_000;
const SINGLE_SAMPLE_TEST_TIMEOUT_MS = 120_000;
const MULTI_SAMPLE_TEST_TIMEOUT_MS = 300_000;

// 출처: Uniswap v3-periphery `IQuoterV2.quoteExactInputSingle`.
const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// 판정과 분리한 anvil 직접 읽기·전송(준비, 예열, 영수증 동기화).
const anvilClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: WARM_UP_TIMEOUT_MS - 10_000, retryCount: 0 }),
});

const anvilWalletClient = createWalletClient({
  account: ACCOUNT,
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: 60_000, retryCount: 0 }),
});

type JsonRpcResponse = { result?: unknown; error?: { code?: number; message?: string } };

// anvil 전용 JSON-RPC(`anvil_dealERC20`, `anvil_setBalance`, `anvil_setCode`, `evm_snapshot`, `evm_revert`).
// 준비 단계에서만 쓴다.
async function anvilRequest(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as JsonRpcResponse;
  if (!response.ok || body.error) {
    throw new Error(`[anvil] ${method} 실패: ${response.status} ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

type JsonRpcItem = { method?: unknown; params?: unknown };

type ProxiedCall = {
  items: JsonRpcItem[];
  status: number;
  hasRpcError: boolean;
};

// 프록시 핸들러를 거치는 요청 기록.
let proxiedCalls: ProxiedCall[] = [];

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function rpcItemsOf(body: string): JsonRpcItem[] {
  const payload = JSON.parse(body) as JsonRpcItem | JsonRpcItem[];
  return Array.isArray(payload) ? payload : [payload];
}

function containsRpcError(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some(
    (item) => typeof item !== "object" || item === null || "error" in item || !("result" in item),
  );
}

// viem의 모든 RPC 요청을 같은 사이트 `POST /api/rpc/1` 요청으로 만들어 프록시 핸들러에 넘긴다.
async function proxyFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  const request = new Request(PROXY_URL, {
    method: "POST",
    headers: {
      ...headersToRecord(init?.headers),
      host: SAME_SITE_HOST,
      origin: SAME_SITE_ORIGIN,
    },
    body,
    signal: init?.signal,
  });

  const response = await handleRpcProxyRequest(request, String(ETHEREUM_CHAIN_ID));
  const hasRpcError = await response
    .clone()
    .json()
    .then(containsRpcError, () => true);
  proxiedCalls.push({ items: rpcItemsOf(body), status: response.status, hasRpcError });
  return response;
}

// 판정 대상 클라이언트. 제품이 받는 wagmi `config.getClient()`처럼 액션 확장이 없는 기본 Client이고,
// 모든 요청이 프록시 핸들러를 거친다.
const proxiedClient = createClient({
  chain: mainnet,
  transport: http(PROXY_URL, { fetchFn: proxyFetch, timeout: 25_000, retryCount: 0 }),
});

// 준비 단계의 영수증 대기 상한과 폴링 간격.
const RECEIPT_WAIT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_INTERVAL_MS = 100;

// anvil에 `eth_getTransactionReceipt`를 직접 폴링해 영수증이 나올 때까지 기다린다(F5 포크 관례).
async function waitForAnvilReceipt(hash: Hash): Promise<void> {
  const deadline = Date.now() + RECEIPT_WAIT_TIMEOUT_MS;
  for (;;) {
    const receipt = await anvilRequest("eth_getTransactionReceipt", [hash]);
    if (receipt !== null && receipt !== undefined) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `[anvil] ${RECEIPT_WAIT_TIMEOUT_MS}ms 안에 ${hash}의 영수증이 나오지 않았습니다.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS));
  }
}

// 가스 추정값에 곱하는 여유분(×1.2). 포크 직후·snapshot revert 뒤 anvil 추정이 실제 채굴 가스보다 작을 수 있다.
const GAS_ESTIMATE_MARGIN_NUMERATOR = 12n;
const GAS_ESTIMATE_MARGIN_DENOMINATOR = 10n;

// 준비 전송: anvil 직접 추정에 여유분을 더한 gas 상한으로 보내고 영수증 성공을 확인한다.
async function sendPreparationTx(to: Address, data: Hex): Promise<void> {
  const estimated = await anvilClient.estimateGas({ account: ACCOUNT, to, data });
  const gas = (estimated * GAS_ESTIMATE_MARGIN_NUMERATOR) / GAS_ESTIMATE_MARGIN_DENOMINATOR;
  const hash = await anvilWalletClient.sendTransaction({ to, data, gas });
  await waitForAnvilReceipt(hash);
  const receipt = await anvilClient.getTransactionReceipt({ hash });
  expect(receipt.status, `준비 전송 ${to}`).toBe("success");
}

// 준비: 계정에 ETH를 넣고, 토큰이 주어지면 그 토큰 잔액을 절대값으로 맞춘다.
async function prepareAccountFunds(token?: Address, amount?: bigint): Promise<void> {
  await anvilRequest("anvil_setBalance", [ACCOUNT, toHex(ACCOUNT_ETH_BALANCE)]);
  if (token !== undefined && amount !== undefined) {
    await anvilRequest("anvil_dealERC20", [ACCOUNT, token, toHex(amount)]);
  }
}

// 준비: 테스트 쪽 ABI(viem `erc20Abi`)로 SwapRouter02에 최대 allowance를 approve한다.
async function prepareMaxAllowance(token: Address): Promise<void> {
  await sendPreparationTx(
    token,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ETHEREUM_SWAP_ROUTER_02, maxUint256],
    }),
  );
}

// 전제 확인: anvil 직접 읽기로 계정의 SwapRouter02 allowance.
async function readAllowanceDirectly(token: Address): Promise<bigint> {
  return await anvilClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [ACCOUNT, ETHEREUM_SWAP_ROUTER_02],
  });
}

// 전제 확인: anvil 직접 읽기로 계정의 ERC-20 잔액.
async function readTokenBalanceDirectly(token: Address): Promise<bigint> {
  return await anvilClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACCOUNT],
  });
}

// 준비: 지우기 전 계정 코드가 EIP-7702 위임 표식인지 확인하고 `anvil_setCode`로 지운다(snapshot 뒤에만 부른다).
async function clearDelegationCode(): Promise<void> {
  const code = await anvilClient.getCode({ address: ACCOUNT });
  expect(code, "지우기 전 계정 코드").toMatch(DELEGATION_DESIGNATOR_PATTERN);
  await anvilRequest("anvil_setCode", [ACCOUNT, "0x"]);
  expect(await anvilClient.getCode({ address: ACCOUNT }), "지운 뒤 계정 코드").toBeUndefined();
}

// 준비: 같은 블록에서 anvil에 QuoterV2를 직접 호출한 수령량으로 기본 슬리피지 최소 수령량을 만든다
// (F4 `useAmountOutMinimum()`과 같은 계산). 0이면 추정 판정이 무의미하므로 0보다 큰지 확인한다.
async function amountOutMinimumViaAnvil(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<bigint> {
  const { result } = await anvilClient.simulateContract({
    address: QUOTER_V2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee: SAMPLE_FEE, sqrtPriceLimitX96: 0n }],
  });
  const amountOutMinimum = getAmountOutMinimum(result[0], DEFAULT_SLIPPAGE_BPS);
  expect(amountOutMinimum > 0n, `최소 수령량 ${tokenIn}→${tokenOut} ${amountOutMinimum}`).toBe(
    true,
  );
  return amountOutMinimum;
}

// 전제 확인: 프록시의 Ethereum 대상이 anvil 포크인지 본다. 준비 단계에서 넣은 ETH 잔액(anvil에만 있는 상태)을
// 프록시를 거쳐 읽는다.
async function expectProxyReachesAnvil(): Promise<void> {
  const balance = await getBalance(proxiedClient, { address: ACCOUNT });
  expect(balance, "프록시를 거친 계정 ETH 잔액").toBe(ACCOUNT_ETH_BALANCE);
}

// 예열: 판정 전에 anvil에 같은 추정을 직접 보내 cold 포크 상태를 올린다(T-1 (6)). 결과는 판정에 쓰지 않는다.
async function warmUpEstimate(request: NetworkFeeTxRequest): Promise<void> {
  try {
    await anvilClient.estimateGas({
      account: ACCOUNT,
      to: request.to,
      data: request.data,
      value: request.value,
    });
  } catch {
    // 판정은 프록시를 거친 제품 추정만으로 한다.
  }
}

type ProxiedEstimate = {
  estimate: NetworkFeeEstimate | undefined;
  error: unknown;
  calls: ProxiedCall[];
};

// 판정: 제품 추정 읽기(`estimateNetworkFee`)를 프록시를 거친 클라이언트로 부른다.
async function estimateViaProxy(request: NetworkFeeTxRequest): Promise<ProxiedEstimate> {
  proxiedCalls = [];
  let estimate: NetworkFeeEstimate | undefined;
  let error: unknown;
  try {
    estimate = await estimateNetworkFee(proxiedClient, {
      chainId: ETHEREUM_CHAIN_ID,
      account: ACCOUNT,
      request,
    });
  } catch (caught) {
    error = caught;
  }
  return { estimate, error, calls: proxiedCalls };
}

function describeError(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  return error instanceof BaseError ? error.shortMessage : String(error);
}

function sameHex(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

// 판정 보조: 요청한 `{ from, to, data, value }`의 `eth_estimateGas`가 프록시를 거쳐 상태 200으로 오갔는지 본다.
function expectEstimateGasThroughProxy(
  request: NetworkFeeTxRequest,
  calls: ProxiedCall[],
  label: string,
): void {
  const estimateCalls = calls.filter((call) =>
    call.items.some((item) => {
      if (item.method !== "eth_estimateGas" || !Array.isArray(item.params)) return false;
      const tx = item.params[0] as
        | { from?: unknown; to?: unknown; data?: unknown; input?: unknown; value?: unknown }
        | undefined;
      if (tx === undefined) return false;
      const valueMatches =
        request.value === undefined
          ? tx.value === undefined || sameHex(tx.value, "0x0")
          : sameHex(tx.value, toHex(request.value));
      return (
        sameHex(tx.from, ACCOUNT) &&
        sameHex(tx.to, request.to) &&
        (sameHex(tx.data, request.data) || sameHex(tx.input, request.data)) &&
        valueMatches
      );
    }),
  );
  expect(estimateCalls.length, `${label}: 프록시를 거친 eth_estimateGas`).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.status, `${label}: 프록시 응답 상태`).toBe(200);
  }
}

function isExecutionRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ExecutionRevertedError) !== null
  );
}

// 쓰기 테스트 격리: 테스트마다 snapshot을 새로 잡고 끝에 revert한다. revert한 id는 다시 쓸 수 없다.
// `evm_revert`는 실패해도 오류 없이 false를 돌려주므로 true를 확인한다.
function isolateWritesWithSnapshot(): void {
  let snapshotId: string | undefined;

  beforeEach(async () => {
    snapshotId = (await anvilRequest("evm_snapshot", [])) as string;
  });

  afterEach(async () => {
    if (snapshotId === undefined) return;
    const id = snapshotId;
    snapshotId = undefined;
    const reverted = await anvilRequest("evm_revert", [id]);
    expect(reverted, `evm_revert ${id}`).toBe(true);
  });
}

// 표본 격리: 안쪽 snapshot을 잡고 표본 하나를 실행한 뒤 revert한다(바깥 격리 snapshot과 별개).
async function withSampleSnapshot<T>(run: () => Promise<T>): Promise<T> {
  const snapshotId = (await anvilRequest("evm_snapshot", [])) as string;
  try {
    return await run();
  } finally {
    const reverted = await anvilRequest("evm_revert", [snapshotId]);
    expect(reverted, `표본 evm_revert ${snapshotId}`).toBe(true);
  }
}

type FeeSample = {
  // DoD-8 표본 종류(`@then`의 주어).
  label: string;
  // 표본의 주 버튼 상태 전제를 준비·확인하고 제품 요청 조립으로 추정 요청을 만든다.
  prepare: () => Promise<NetworkFeeTxRequest>;
};

// 스왑 표본의 제품 요청 조립(DoD-2). 최소 수령량은 anvil QuoterV2 직접 견적, deadline은 조립 시각 기준이다.
async function buildSwapSampleRequest(
  tokenIn: Address,
  tokenOut: Address,
  amountInRaw: bigint,
): Promise<NetworkFeeTxRequest> {
  const quoteTokenIn = tokenIn === NATIVE_ETH_ADDRESS ? ETHEREUM_WETH : tokenIn;
  const quoteTokenOut = tokenOut === NATIVE_ETH_ADDRESS ? ETHEREUM_WETH : tokenOut;
  const amountOutMinimum = await amountOutMinimumViaAnvil(quoteTokenIn, quoteTokenOut, amountInRaw);
  return buildNetworkFeeTxRequest({
    kind: "swap",
    chainId: ETHEREUM_CHAIN_ID,
    tokenIn: { address: tokenIn },
    tokenOut: { address: tokenOut },
    fee: SAMPLE_FEE,
    account: ACCOUNT,
    amountInRaw,
    amountOutMinimum,
    deadline: getSwapDeadline(Date.now()),
  });
}

// 표본: 보내는 ERC-20 잔액과 SwapRouter02 allowance가 표본 금액 이상인 ERC-20 입력 스왑(swap-ready).
async function prepareErc20InSwap(
  tokenOut: Address,
  amountInRaw: bigint,
): Promise<NetworkFeeTxRequest> {
  await prepareAccountFunds(USDC, amountInRaw);
  await prepareMaxAllowance(USDC);
  expect((await readTokenBalanceDirectly(USDC)) >= amountInRaw, "USDC 잔액 ≥ 표본 금액").toBe(true);
  expect((await readAllowanceDirectly(USDC)) >= amountInRaw, "USDC allowance ≥ 표본 금액").toBe(
    true,
  );
  return await buildSwapSampleRequest(USDC, tokenOut, amountInRaw);
}

const FEE_SAMPLES: FeeSample[] = [
  {
    label: "approve(USDC)",
    prepare: async () => {
      await prepareAccountFunds(USDC, APPROVE_AMOUNT_RAW);
      expect((await readTokenBalanceDirectly(USDC)) >= APPROVE_AMOUNT_RAW, "USDC 잔액").toBe(true);
      const allowance = await readAllowanceDirectly(USDC);
      expect(allowance < APPROVE_AMOUNT_RAW, `approve-required allowance ${allowance}`).toBe(true);
      return buildNetworkFeeTxRequest({
        kind: "approve",
        chainId: ETHEREUM_CHAIN_ID,
        token: USDC,
        allowance,
        amountInRaw: APPROVE_AMOUNT_RAW,
      });
    },
  },
  {
    label: "ERC-20 스왑(USDC→DAI)",
    prepare: async () => await prepareErc20InSwap(DAI, USDC_TO_DAI_AMOUNT_RAW),
  },
  {
    label: "ERC-20 스왑(USDC→WETH)",
    prepare: async () => await prepareErc20InSwap(ETHEREUM_WETH, USDC_TO_WETH_AMOUNT_RAW),
  },
  {
    label: "ETH 입력 스왑(ETH→USDC)",
    prepare: async () => {
      await prepareAccountFunds();
      expect(ACCOUNT_ETH_BALANCE > ETH_IN_AMOUNT_RAW, "ETH 잔액 > 표본 금액").toBe(true);
      const request = await buildSwapSampleRequest(NATIVE_ETH_ADDRESS, USDC, ETH_IN_AMOUNT_RAW);
      expect(request.value, "ETH 입력 value").toBe(ETH_IN_AMOUNT_RAW);
      return request;
    },
  },
  {
    label: "ETH 출력 스왑(USDC→ETH)",
    prepare: async () => await prepareErc20InSwap(NATIVE_ETH_ADDRESS, ETH_OUT_AMOUNT_RAW),
  },
  {
    label: "wrap",
    prepare: async () => {
      await prepareAccountFunds();
      expect(ACCOUNT_ETH_BALANCE > WRAP_AMOUNT_RAW, "ETH 잔액 > 표본 금액").toBe(true);
      return buildNetworkFeeTxRequest({
        kind: "wrap",
        chainId: ETHEREUM_CHAIN_ID,
        amountInRaw: WRAP_AMOUNT_RAW,
      });
    },
  },
  {
    label: "unwrap",
    prepare: async () => {
      await prepareAccountFunds(ETHEREUM_WETH, UNWRAP_WETH_INJECTED_RAW);
      expect(
        (await readTokenBalanceDirectly(ETHEREUM_WETH)) >= UNWRAP_AMOUNT_RAW,
        "WETH 잔액",
      ).toBe(true);
      return buildNetworkFeeTxRequest({
        kind: "unwrap",
        chainId: ETHEREUM_CHAIN_ID,
        amountInRaw: UNWRAP_AMOUNT_RAW,
      });
    },
  },
];

describe("네트워크 수수료 추정 — Ethereum 포크에서 주 버튼이 보낼 트랜잭션의 수수료를 추정한다", () => {
  // 판정과 분리한 anvil 직접 사전 읽기. cold 포크에서 프록시 상류 시간 제한(5초)을 넘어
  // 판정 요청이 공개 RPC로 넘어가지 않도록 추정이 읽는 컨트랙트·풀 상태를 미리 포크에 올린다.
  // 표본별 같은 추정의 직접 예열은 상태를 준비한 뒤 각 표본에서 한다(`warmUpEstimate`).
  beforeAll(async () => {
    for (const address of [ACCOUNT, ETHEREUM_SWAP_ROUTER_02, ETHEREUM_WETH, USDC, DAI]) {
      await anvilClient.getCode({ address });
    }
    await anvilClient.getBalance({ address: ACCOUNT });
    for (const token of [USDC, ETHEREUM_WETH]) {
      await readTokenBalanceDirectly(token);
      await readAllowanceDirectly(token);
    }
    await amountOutMinimumViaAnvil(USDC, DAI, USDC_TO_DAI_AMOUNT_RAW);
    await amountOutMinimumViaAnvil(USDC, ETHEREUM_WETH, USDC_TO_WETH_AMOUNT_RAW);
    await amountOutMinimumViaAnvil(ETHEREUM_WETH, USDC, ETH_IN_AMOUNT_RAW);
  }, WARM_UP_TIMEOUT_MS);

  beforeEach(() => {
    vi.stubEnv("ETH_MAINNET_RPC_URL", ANVIL_URL);
    proxiedCalls = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("주 버튼이 보낼 수 있는 여섯 종류의 트랜잭션", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-8
     * @given 프록시의 Ethereum 대상이 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트마다 anvil snapshot을 잡아 끝에 revert하며, 표본 6종(approve, ERC-20 스왑, ETH 입력 스왑, ETH 출력 스왑, wrap, unwrap — 토큰·금액은 T-1 (1)을 따른다)을 하나씩 반복하고, 표본마다 계정(코드 없는 새 주소 또는 위임 코드를 지운 anvil 계정)에 가스용 ETH를 넣고 그 표본의 주 버튼 상태 전제를 준비한다: approve는 보내는 ERC-20 잔액이 표본 금액 이상이고 Ethereum `swapRouter02` 대상 allowance가 표본 금액 미만, ERC-20 스왑과 ETH 출력 스왑은 보내는 ERC-20 잔액과 `swapRouter02` 대상 allowance가 표본 금액 이상, ETH 입력 스왑과 wrap은 ETH 잔액이 가스와 표본 금액을 넘고, unwrap은 WETH 잔액이 표본 금액 이상이며, 스왑 표본은 같은 블록에서 anvil에 QuoterV2를 직접 호출한 견적의 수수료 티어와 수령량으로 0보다 큰 최소 수령량을 만들어 둔다
     * @when 표본마다 DoD-1~3과 같은 요청(approve는 보낼 approve의 `to`·`data`, 스왑은 `buildSwapTransactionRequest` 기반 `to`·`value`·calldata로 ERC-20 입력·ETH 입력(`value`)·ETH 출력(`unwrapWETH9`), wrap은 WETH `deposit` + `value`, unwrap은 WETH `withdraw`, `from`=그 계정)을 제품 요청 조립으로 만들어 프록시를 거친 제품 추정 읽기로 Ethereum에서 `eth_estimateGas`를 보낸다
     * @then approve 추정이 오류 없이 gas 값을 돌려준다
     * @then ERC-20 스왑 추정이 오류 없이 gas 값을 돌려준다
     * @then ETH 입력 스왑 추정이 오류 없이 gas 값을 돌려준다
     * @then ETH 출력 스왑 추정이 오류 없이 gas 값을 돌려준다
     * @then wrap 추정이 오류 없이 gas 값을 돌려준다
     * @then unwrap 추정이 오류 없이 gas 값을 돌려준다
     */
    it(
      "[DoD-8] approve, ERC-20 스왑, ETH 입력·출력 스왑, wrap, unwrap 추정이 모두 성공한다",
      async () => {
        // 준비(바깥 snapshot 뒤): 계정의 7702 위임 코드를 지운다. 표본 snapshot은 지운 상태를 잡는다.
        await clearDelegationCode();

        // 전제: 프록시의 Ethereum 대상이 anvil 포크다.
        await prepareAccountFunds();
        await expectProxyReachesAnvil();

        // 표본을 하나씩 반복한다. 표본마다 안쪽 snapshot에서 전제를 준비하고 프록시를 거쳐 추정한다.
        const outcomes: (ProxiedEstimate & { label: string; request: NetworkFeeTxRequest })[] = [];
        for (const sample of FEE_SAMPLES) {
          const outcome = await withSampleSnapshot(async () => {
            const request = await sample.prepare();
            await warmUpEstimate(request);
            return { request, ...(await estimateViaProxy(request)) };
          });
          outcomes.push({ label: sample.label, ...outcome });
        }

        // 표본마다 추정이 오류 없이 gas 값을 돌려준다.
        expect(outcomes.map((outcome) => outcome.label)).toEqual(
          FEE_SAMPLES.map((sample) => sample.label),
        );
        for (const { label, request, estimate, error, calls } of outcomes) {
          expect(describeError(error), `${label}: 추정 오류`).toBeUndefined();
          expect(typeof estimate?.gas, `${label}: gas`).toBe("bigint");
          expect((estimate?.gas ?? 0n) > 0n, `${label}: gas ${estimate?.gas}`).toBe(true);
          expectEstimateGasThroughProxy(request, calls, label);
          for (const call of calls) {
            expect(call.hasRpcError, `${label}: 프록시 응답의 JSON-RPC 오류`).toBe(false);
          }
        }
      },
      MULTI_SAMPLE_TEST_TIMEOUT_MS,
    );
  });

  describe("allowance가 없는 ERC-20 스왑", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-9
     * @given 프록시의 Ethereum 대상이 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, 계정(코드 없는 새 주소 또는 위임 코드를 지운 anvil 계정)에 가스용 ETH와 T-1 표본 금액(ERC-20 스왑, T-1 (2)를 따른다) 이상의 보내는 ERC-20을 넣고, 그 계정의 Ethereum `swapRouter02` 대상 allowance가 0임을 직접 읽기로 확인하며, 같은 블록에서 anvil에 QuoterV2를 직접 호출한 견적의 수수료 티어와 수령량으로 0보다 큰 최소 수령량을 만들어 둔다
     * @when DoD-2와 같은 ERC-20 입력 스왑 요청(`buildSwapTransactionRequest` 기반 `to`·calldata, `from`=그 계정)을 제품 요청 조립으로 만들어 프록시를 거친 제품 추정 읽기로 Ethereum에서 `eth_estimateGas`를 보낸다
     * @then 추정이 실행 revert 오류로 실패한다
     * @then 추정이 gas 값을 돌려주지 않는다
     */
    it(
      "[DoD-9] allowance가 0인 계정의 ERC-20 스왑 추정은 revert한다",
      async () => {
        // 준비(snapshot 뒤): 계정의 7702 위임 코드를 지운다.
        await clearDelegationCode();

        // 준비: 가스용 ETH와 표본 금액(USDC→DAI 5 USDC)의 USDC를 넣는다.
        await prepareAccountFunds(USDC, USDC_TO_DAI_AMOUNT_RAW);
        await expectProxyReachesAnvil();
        expect(
          (await readTokenBalanceDirectly(USDC)) >= USDC_TO_DAI_AMOUNT_RAW,
          "USDC 잔액 ≥ 표본 금액",
        ).toBe(true);

        // 전제: 직접 읽기로 SwapRouter02 allowance가 0이다.
        expect(await readAllowanceDirectly(USDC), "USDC allowance").toBe(0n);

        // DoD-2와 같은 ERC-20 입력 스왑 요청을 제품 요청 조립으로 만든다(최소 수령량은 QuoterV2 직접 견적).
        const request = await buildSwapSampleRequest(USDC, DAI, USDC_TO_DAI_AMOUNT_RAW);
        await warmUpEstimate(request);

        const { estimate, error, calls } = await estimateViaProxy(request);

        // 추정이 실행 revert 오류로 실패한다.
        expect(error, "추정 오류").toBeInstanceOf(BaseError);
        expect(isExecutionRevert(error), `revert 오류: ${describeError(error)}`).toBe(true);
        // 추정이 gas 값을 돌려주지 않는다.
        expect(estimate).toBeUndefined();
        // revert는 프록시를 거친 eth_estimateGas 응답이다.
        expectEstimateGasThroughProxy(request, calls, "allowance 0 ERC-20 스왑");
      },
      SINGLE_SAMPLE_TEST_TIMEOUT_MS,
    );
  });
});
