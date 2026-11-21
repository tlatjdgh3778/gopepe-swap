import {
  type Address,
  type Hash,
  type Hex,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseAbi,
  toHex,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import { NATIVE_ETH_ADDRESS } from "@/config/tokens";
import type { FeeTier } from "@/config/uniswap-v3";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";
import { DEFAULT_SLIPPAGE_BPS, getAmountOutMinimum } from "@/lib/slippage";
import {
  buildApproveRequest,
  buildSwapTransactionRequest,
  buildUnwrapRequest,
  buildWrapRequest,
  encodeApproveCalldata,
  encodeSwapTransactionCalldata,
  encodeWethCalldata,
  getSwapDeadline,
} from "@/lib/swap-transaction";
import { readTokenAllowance } from "@/lib/token-allowance";
import { readTokenBalance } from "@/lib/token-balances";

// global-setup.ts가 전용 포트(8547)에 띄운 Ethereum anvil 포크(상수로 고정한 포크 블록)에서 검증한다.
// mock 경계(D-3 사용자 확정, 2026-11-20): mock 없음. 준비 단계에서만 러너가 anvil 상태를 직접 바꾼다
// (`anvil_setBalance`, `anvil_dealERC20`, `anvil_setCode` 위임 코드 제거, `evm_snapshot`/`evm_revert`).
// 판정은 제품 calldata와 프록시를 거친 읽기로 한다.
// 데이터 격리: 포크 테스트 파일은 순차 실행하고, 테스트마다 시작 전 anvil snapshot을 잡고 끝에 revert한다
// (revert 반환 true 단정).
// 표본 페어·금액은 사전 확인 T-1의 결과를 쓴다.
const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;
const PROXY_URL = `${SAME_SITE_ORIGIN}/api/rpc/1`;

// 제품 config의 Ethereum SwapRouter02와 WETH(전송 대상).
const ETHEREUM_SWAP_ROUTER_02 = CONTRACTS_BY_CHAIN[1].swapRouter02;
const ETHEREUM_WETH = CONTRACTS_BY_CHAIN[1].weth;

// 전송 계정: anvil 기본 계정 0(잠금 해제). 포크 블록에서 EIP-7702 위임 코드가 있다(T-1 (1)).
const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// 준비 단계에서 계정에 넣는 ETH(100 ETH). 가스와 ETH 표본 금액을 넘는다.
const ACCOUNT_ETH_BALANCE = 100_000_000_000_000_000_000n;

// Ethereum 토큰 주소(리터럴).
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const QUOTER_V2: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// EIP-7702 위임 표식: `0xef0100` + 위임 대상 주소(20바이트).
const DELEGATION_DESIGNATOR_PATTERN = /^0xef0100[0-9a-f]{40}$/i;

// T-1 (2)(9) 표본: ETH→USDC 1 ETH, 티어 100, 예상 수령량 2375903197, 기본 슬리피지(50bps) 최소 2364023681.
const ETH_IN_AMOUNT_RAW = 1_000_000_000_000_000_000n;
const ETH_IN_FEE: FeeTier = 100;
const T1_ETH_IN_AMOUNT_OUT = 2_375_903_197n;
const T1_ETH_IN_AMOUNT_OUT_MINIMUM = 2_364_023_681n;

// T-1 (3)(9) 표본: USDC→ETH 1000 USDC(decimals 6), 티어 100,
// 예상 수령량 420740162332425437, 기본 슬리피지(50bps) 최소 418636461520763309.
const USDC_IN_AMOUNT_RAW = 1_000_000_000n;
const USDC_IN_FEE: FeeTier = 100;
const T1_ETH_OUT_AMOUNT_OUT = 420_740_162_332_425_437n;
const T1_ETH_OUT_AMOUNT_OUT_MINIMUM = 418_636_461_520_763_309n;

// wrap 표본: T-1 (2)의 ETH 표본 금액과 같은 1 ETH.
const WRAP_AMOUNT_RAW = 1_000_000_000_000_000_000n;
// unwrap 표본: T-1 (1)(7)처럼 WETH 1개를 절대값으로 주입하고 그중 0.5개를 withdraw한다.
const UNWRAP_WETH_INJECTED_RAW = 1_000_000_000_000_000_000n;
const UNWRAP_AMOUNT_RAW = 500_000_000_000_000_000n;

// cold 포크의 첫 상태 읽기는 업체 RPC에서 가져와 수 초가 걸린다.
const WARM_UP_TIMEOUT_MS = 120_000;
const WRITE_TEST_TIMEOUT_MS = 120_000;

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

type ProxiedCall = {
  methods: string[];
  status: number;
  hasRpcError: boolean;
};

// 프록시 핸들러를 거치는 요청 기록.
let proxiedCalls: ProxiedCall[] = [];

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function rpcMethodsOf(body: string): string[] {
  const payload = JSON.parse(body) as { method?: unknown } | { method?: unknown }[];
  const items = Array.isArray(payload) ? payload : [payload];
  return items.map((item) => String(item.method));
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

  const response = await handleRpcProxyRequest(request, "1");
  const hasRpcError = await response
    .clone()
    .json()
    .then(containsRpcError, () => true);
  proxiedCalls.push({ methods: rpcMethodsOf(body), status: response.status, hasRpcError });
  return response;
}

// 판정 읽기(잔액, 영수증, 계정 코드)용 클라이언트. 모든 요청이 프록시 핸들러를 거친다.
const proxiedClient = createPublicClient({
  chain: mainnet,
  transport: http(PROXY_URL, { fetchFn: proxyFetch, timeout: 25_000, retryCount: 0 }),
});

// 프록시를 거친 제품 잔액 읽기. `NATIVE_ETH_ADDRESS`이면 ETH 잔액, 그 밖에는 ERC-20 `balanceOf`다.
async function readBalanceViaProxy(token: Address): Promise<bigint> {
  return await readTokenBalance(proxiedClient, { account: ACCOUNT, token: { address: token } });
}

// 프록시를 거친 영수증 읽기. 전송은 anvil 직접이며 영수증이 나온 뒤에 읽는다.
async function readReceiptViaProxy(hash: Hash) {
  return await proxiedClient.getTransactionReceipt({ hash });
}

// 프록시를 거친 요청이 모두 정상 응답했는지 확인한다(판정 읽기가 실패 응답에 기대지 않았음을 보인다).
function expectProxiedCallsOk(): void {
  expect(proxiedCalls.length).toBeGreaterThan(0);
  for (const call of proxiedCalls) {
    expect(call.status, call.methods.join(",")).toBe(200);
    expect(call.hasRpcError, call.methods.join(",")).toBe(false);
  }
}

// 준비 단계의 영수증 대기 상한과 폴링 간격.
const RECEIPT_WAIT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_INTERVAL_MS = 100;

// anvil에 `eth_getTransactionReceipt`를 직접 폴링해 영수증이 나올 때까지 기다린다.
// viem `waitForTransactionReceipt`는 블록 이벤트 기반이라 automine에서 끝나지 않을 수 있다(F5 포크 관례).
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

// anvil 계정 전송으로 트랜잭션을 보내고 anvil 직접 영수증으로 체결을 기다린다.
// `value`는 제품 요청의 값을 그대로 싣는다(`undefined`이면 요청에 `value`가 없다).
async function sendFromAccount(
  to: Address,
  data: Hex,
  value: bigint | undefined,
  gas?: bigint,
): Promise<Hash> {
  const hash = await anvilWalletClient.sendTransaction({ to, data, value, gas });
  await waitForAnvilReceipt(hash);
  return hash;
}

// 가스 추정값에 곱하는 여유분(×1.2).
const GAS_ESTIMATE_MARGIN_NUMERATOR = 12n;
const GAS_ESTIMATE_MARGIN_DENOMINATOR = 10n;

// 지갑 역할의 전송: 같은 요청으로 anvil `eth_estimateGas`를 한 뒤 여유분을 더한 gas 상한을 지정해 보낸다.
// 이 파일의 모든 쓰기 전송이 이 함수를 쓴다. 포크 직후 첫 트랜잭션이나 snapshot revert 뒤에는 latest가
// 포크 블록(옛 timestamp)으로 돌아가 anvil이 그 기준으로 가스를 추정하는데,
// 실제 채굴 블록은 현재 시각이어서 풀 오라클 관측값 기록 같은 추가 가스가 든다. gas를 지정하지 않으면
// 추정 상한에 걸려 OutOfGas로 revert할 수 있다(제품은 gas를 정하지 않고 지갑이 정한다). anvil 상태는 바꾸지 않는다.
async function sendFromAccountWithGasMargin(
  to: Address,
  data: Hex,
  value: bigint | undefined,
): Promise<Hash> {
  const estimated = await anvilClient.estimateGas({ account: ACCOUNT, to, data, value });
  const gas = (estimated * GAS_ESTIMATE_MARGIN_NUMERATOR) / GAS_ESTIMATE_MARGIN_DENOMINATOR;
  return await sendFromAccount(to, data, value, gas);
}

// 준비: 계정에 ETH를 넣고, 토큰이 주어지면 그 토큰 잔액을 절대값으로 맞춘다.
async function prepareAccountFunds(token?: Address, amount?: bigint): Promise<void> {
  await anvilRequest("anvil_setBalance", [ACCOUNT, toHex(ACCOUNT_ETH_BALANCE)]);
  if (token !== undefined && amount !== undefined) {
    await anvilRequest("anvil_dealERC20", [ACCOUNT, token, toHex(amount)]);
  }
}

// 준비: 지우기 전 계정 코드가 EIP-7702 위임 표식인지 확인한다. 확인한 코드를 돌려준다.
async function readDelegationCode(): Promise<Hex> {
  const code = await anvilClient.getCode({ address: ACCOUNT });
  expect(code, "지우기 전 계정 코드").toBeDefined();
  expect(code, "지우기 전 계정 코드").toMatch(DELEGATION_DESIGNATOR_PATTERN);
  return code as Hex;
}

// 준비: snapshot을 잡은 뒤 `anvil_setCode`로 계정의 위임 코드를 지우고 지워졌는지 확인한다.
async function clearDelegationCode(): Promise<void> {
  await anvilRequest("anvil_setCode", [ACCOUNT, "0x"]);
  expect(await anvilClient.getCode({ address: ACCOUNT }), "지운 뒤 계정 코드").toBeUndefined();
}

// 준비: 같은 블록에서 anvil에 QuoterV2를 직접 호출한 수령량.
async function quoteViaAnvil(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  fee: FeeTier,
): Promise<bigint> {
  const { result } = await anvilClient.simulateContract({
    address: QUOTER_V2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
  });
  return result[0];
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

describe("ETH 스왑과 wrap·unwrap — Ethereum 포크에서 네이티브 ETH 트랜잭션이 체결된다", () => {
  // 판정과 분리한 anvil 직접 사전 읽기. cold 포크에서 프록시 상류 시간 제한(5초)을 넘어
  // 판정 읽기가 공개 RPC로 넘어가지 않도록 판정이 읽는 상태와 스왑 경로 상태를 미리 포크에 올린다.
  beforeAll(async () => {
    await anvilClient.getCode({ address: ACCOUNT });
    await anvilClient.getCode({ address: ETHEREUM_SWAP_ROUTER_02 });
    await anvilClient.getCode({ address: ETHEREUM_WETH });
    await anvilClient.getBalance({ address: ACCOUNT });
    await quoteViaAnvil(ETHEREUM_WETH, USDC, ETH_IN_AMOUNT_RAW, ETH_IN_FEE);
    await quoteViaAnvil(USDC, ETHEREUM_WETH, USDC_IN_AMOUNT_RAW, USDC_IN_FEE);
    for (const token of [USDC, ETHEREUM_WETH]) {
      await anvilClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ACCOUNT],
      });
      await anvilClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [ACCOUNT, ETHEREUM_SWAP_ROUTER_02],
      });
    }
  }, WARM_UP_TIMEOUT_MS);

  beforeEach(() => {
    vi.stubEnv("ETH_MAINNET_RPC_URL", ANVIL_URL);
    proxiedCalls = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("ETH를 보내 ERC-20을 받는 스왑", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-11
     * @given 프록시의 Ethereum 대상이 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, 준비 단계에서 anvil 계정에 가스와 T-1 표본 금액(ETH→USDC, 값은 T-1 결과를 따른다)을 넘는 ETH를 넣고, 같은 블록에서 anvil에 QuoterV2를 직접 호출한 견적(`tokenIn`은 WETH 치환 주소)의 수수료 티어와 수령량으로 `amountOutMinimum`을 만들어 두고 그 `amountOutMinimum`이 0보다 크며(T-1 (9)에서 확인한 표본 금액), 프록시를 거친 읽기로 계정의 스왑 전 USDC 잔액을 읽어 둔다
     * @when 제품 `lib/swap-transaction.ts` 함수로 DoD-7·8 인코딩(`tokenIn` WETH 치환 주소, `tokenOut` USDC, `recipient` anvil 계정, `amountIn` 표본 금액, `amountOutMinimum`을 담은 `multicall(deadline, [exactInputSingle(params)])`, `value` = 표본 `amountInRaw`)의 요청을 만들어 anvil 계정 전송으로 Ethereum `swapRouter02`에 보내고 영수증을 기다린다
     * @then 영수증이 성공이어서 스왑이 체결된다
     * @then 프록시를 거친 읽기로 잰 계정의 USDC 잔액 증가량이 `amountOutMinimum` 이상이다
     */
    it(
      "[DoD-11] ETH→USDC 스왑이 체결되고 USDC 잔액 증가량이 amountOutMinimum 이상이다",
      async () => {
        // 준비: 가스와 표본 금액을 넘는 ETH를 넣는다.
        await prepareAccountFunds();

        // 준비: 같은 블록에서 anvil에 QuoterV2를 직접 호출한다(`tokenIn`은 WETH 치환 주소).
        const quotedAmountOut = await quoteViaAnvil(
          ETHEREUM_WETH,
          USDC,
          ETH_IN_AMOUNT_RAW,
          ETH_IN_FEE,
        );
        // 표본 전제: 포크 블록 풀 상태 그대로의 T-1 수령량이다.
        expect(quotedAmountOut).toBe(T1_ETH_IN_AMOUNT_OUT);

        // 기본 슬리피지의 최소 수령량(F4 `useAmountOutMinimum()`과 같은 계산). 0이면 판정이 무의미하다.
        const amountOutMinimum = getAmountOutMinimum(quotedAmountOut, DEFAULT_SLIPPAGE_BPS);
        expect(amountOutMinimum).toBe(T1_ETH_IN_AMOUNT_OUT_MINIMUM);
        expect(amountOutMinimum > 0n).toBe(true);

        // 준비: 프록시를 거친 읽기로 계정의 스왑 전 USDC 잔액.
        const usdcBefore = await readBalanceViaProxy(USDC);

        // 제품 함수로 DoD-7·8 인코딩의 요청을 만든다(`tokenIn` ETH → WETH 치환, `value` = amountInRaw).
        const request = buildSwapTransactionRequest({
          chainId: 1,
          tokenIn: { address: NATIVE_ETH_ADDRESS },
          tokenOut: { address: USDC },
          fee: ETH_IN_FEE,
          account: ACCOUNT,
          amountInRaw: ETH_IN_AMOUNT_RAW,
          amountOutMinimum,
          deadline: getSwapDeadline(Date.now()),
        });
        expect(request.to).toBe(ETHEREUM_SWAP_ROUTER_02);
        expect(request.value).toBe(ETH_IN_AMOUNT_RAW);
        const hash = await sendFromAccountWithGasMargin(
          request.to,
          encodeSwapTransactionCalldata(request),
          request.value,
        );

        // 영수증이 성공이어서 스왑이 체결된다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // 프록시를 거친 읽기로 잰 USDC 잔액 증가량이 amountOutMinimum 이상이다.
        const usdcAfter = await readBalanceViaProxy(USDC);
        expect(usdcAfter - usdcBefore >= amountOutMinimum, `증가량 ${usdcAfter - usdcBefore}`).toBe(
          true,
        );

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });

  describe("ERC-20을 보내 ETH를 받는 스왑", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-12
     * @given 프록시의 Ethereum 대상이 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, snapshot을 잡은 뒤 준비 단계에서 `eth_getCode`로 읽은 anvil 계정의 지우기 전 코드가 비어 있지 않은 EIP-7702 위임 표식(`0xef0100`으로 시작)임을 확인하고 `anvil_setCode`로 그 위임 코드를 지운 다음, anvil 계정에 가스용 ETH와 T-1 표본 금액(USDC→ETH, 값은 T-1 결과를 따른다) 이상의 USDC를 넣고 Ethereum `swapRouter02`에 대한 USDC allowance를 표본 금액 이상으로 approve해 영수증 성공까지 기다리며, 같은 블록에서 anvil에 QuoterV2를 직접 호출한 견적(`tokenOut`은 WETH 치환 주소)의 수수료 티어와 수령량으로 `amountOutMinimum`을 만들어 두고 그 `amountOutMinimum`이 0보다 크며(T-1 (9)에서 확인한 표본 금액), approve 뒤 프록시를 거친 잔액 읽기로 계정의 스왑 전 ETH 잔액을 읽어 둔다
     * @when 제품 `lib/swap-transaction.ts` 함수로 DoD-9 인코딩(`tokenIn` USDC, `tokenOut` WETH 치환 주소, `params.recipient` `ADDRESS_THIS`, `amountIn` 표본 금액, `unwrapWETH9(amountOutMinimum, anvil 계정)`을 담은 `multicall(deadline, [exactInputSingle(params), unwrapWETH9(amountMinimum, recipient)])`, `value` 없음 또는 0)의 요청을 만들어 anvil 계정 전송으로 Ethereum `swapRouter02`에 보내고 영수증을 기다린다
     * @then 영수증이 성공이어서 스왑이 체결된다
     * @then 프록시를 거친 잔액 읽기로 잰 계정의 ETH 잔액 변화에 영수증으로 계산한 스왑 트랜잭션 가스 비용(`gasUsed` × `effectiveGasPrice`)을 더한 값이 `amountOutMinimum` 이상이다
     */
    it(
      "[DoD-12] approve 뒤 USDC→ETH 스왑이 체결되고 받은 ETH(잔액 변화 + 가스 비용)가 amountOutMinimum 이상이다",
      async () => {
        // 준비(snapshot 뒤): 지우기 전 계정 코드가 위임 표식임을 확인하고 위임 코드를 지운다.
        await readDelegationCode();
        await clearDelegationCode();

        // 준비: 가스용 ETH와 표본 금액의 USDC를 넣는다.
        await prepareAccountFunds(USDC, USDC_IN_AMOUNT_RAW);

        // 준비: 제품 approve 인코딩으로 SwapRouter02 allowance를 표본 금액 이상으로 만든다.
        const allowanceBefore = await readTokenAllowance(anvilClient, {
          owner: ACCOUNT,
          spender: ETHEREUM_SWAP_ROUTER_02,
          token: USDC,
        });
        const approveRequest = buildApproveRequest({
          chainId: 1,
          token: USDC,
          allowance: allowanceBefore,
          amountInRaw: USDC_IN_AMOUNT_RAW,
        });
        const approveHash = await sendFromAccountWithGasMargin(
          approveRequest.to,
          encodeApproveCalldata(approveRequest),
          undefined,
        );
        const approveReceipt = await anvilClient.getTransactionReceipt({ hash: approveHash });
        expect(approveReceipt.status, "준비 approve").toBe("success");
        const allowanceAfter = await readTokenAllowance(anvilClient, {
          owner: ACCOUNT,
          spender: ETHEREUM_SWAP_ROUTER_02,
          token: USDC,
        });
        expect(allowanceAfter >= USDC_IN_AMOUNT_RAW, `allowance ${allowanceAfter}`).toBe(true);

        // 준비: 같은 블록에서 anvil에 QuoterV2를 직접 호출한다(`tokenOut`은 WETH 치환 주소).
        const quotedAmountOut = await quoteViaAnvil(
          USDC,
          ETHEREUM_WETH,
          USDC_IN_AMOUNT_RAW,
          USDC_IN_FEE,
        );
        // 표본 전제: 포크 블록 풀 상태 그대로의 T-1 수령량이다(준비 트랜잭션은 풀을 건드리지 않는다).
        expect(quotedAmountOut).toBe(T1_ETH_OUT_AMOUNT_OUT);

        const amountOutMinimum = getAmountOutMinimum(quotedAmountOut, DEFAULT_SLIPPAGE_BPS);
        expect(amountOutMinimum).toBe(T1_ETH_OUT_AMOUNT_OUT_MINIMUM);
        expect(amountOutMinimum > 0n).toBe(true);

        // 준비: approve 뒤 프록시를 거친 잔액 읽기로 계정의 스왑 전 ETH 잔액.
        const ethBefore = await readBalanceViaProxy(NATIVE_ETH_ADDRESS);

        // 제품 함수로 DoD-9 인코딩의 요청을 만든다
        // (`params.recipient` ADDRESS_THIS + `unwrapWETH9(amountOutMinimum, 계정)`, `value` 없음).
        const request = buildSwapTransactionRequest({
          chainId: 1,
          tokenIn: { address: USDC },
          tokenOut: { address: NATIVE_ETH_ADDRESS },
          fee: USDC_IN_FEE,
          account: ACCOUNT,
          amountInRaw: USDC_IN_AMOUNT_RAW,
          amountOutMinimum,
          deadline: getSwapDeadline(Date.now()),
        });
        expect(request.to).toBe(ETHEREUM_SWAP_ROUTER_02);
        expect(request.value ?? 0n).toBe(0n);
        const hash = await sendFromAccountWithGasMargin(
          request.to,
          encodeSwapTransactionCalldata(request),
          request.value,
        );

        // 영수증이 성공이어서 스왑이 체결된다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // 받은 ETH = 잔액 변화 + 영수증으로 계산한 스왑 트랜잭션 가스 비용. amountOutMinimum 이상이다.
        const ethAfter = await readBalanceViaProxy(NATIVE_ETH_ADDRESS);
        const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
        const receivedEth = ethAfter - ethBefore + gasCost;
        expect(receivedEth >= amountOutMinimum, `받은 ETH ${receivedEth}`).toBe(true);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });

  describe("ETH를 WETH로 wrap", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-24
     * @given 프록시의 Ethereum 대상이 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, 준비 단계에서 anvil 계정에 가스와 T-1 표본 금액(ETH→WETH, 값은 T-1 결과를 따른다)을 넘는 ETH를 넣고, 프록시를 거친 읽기로 계정의 wrap 전 WETH 잔액을 읽어 둔다
     * @when 제품 `lib/swap-transaction.ts` 함수로 DoD-21 인코딩(Ethereum WETH 주소에 `deposit()`, `value` = 표본 `amountInRaw`)의 요청을 만들어 anvil 계정 전송으로 보내고 영수증을 기다린다
     * @then 영수증이 성공이어서 wrap이 체결된다
     * @then 프록시를 거친 읽기로 잰 계정의 WETH 잔액 증가량이 표본 금액과 같다
     */
    it(
      "[DoD-24] wrap이 체결되고 WETH 잔액이 금액만큼 늘어난다",
      async () => {
        // 준비: 가스와 표본 금액을 넘는 ETH를 넣는다.
        await prepareAccountFunds();

        // 준비: 프록시를 거친 읽기로 계정의 wrap 전 WETH 잔액.
        const wethBefore = await readBalanceViaProxy(ETHEREUM_WETH);

        // 제품 함수로 DoD-21 인코딩의 요청을 만든다(WETH 주소에 `deposit()`, `value` = amountInRaw).
        const request = buildWrapRequest({ chainId: 1, amountInRaw: WRAP_AMOUNT_RAW });
        expect(request.to).toBe(ETHEREUM_WETH);
        expect(request.value).toBe(WRAP_AMOUNT_RAW);
        const hash = await sendFromAccountWithGasMargin(
          request.to,
          encodeWethCalldata(request),
          request.value,
        );

        // 영수증이 성공이어서 wrap이 체결된다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // 프록시를 거친 읽기로 잰 WETH 잔액 증가량이 표본 금액과 같다.
        const wethAfter = await readBalanceViaProxy(ETHEREUM_WETH);
        expect(wethAfter - wethBefore).toBe(WRAP_AMOUNT_RAW);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });

  describe("WETH를 ETH로 unwrap", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-25
     * @given 프록시의 Ethereum 대상이 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡은 뒤, 준비 단계에서 `eth_getCode`로 읽은 anvil 계정의 지우기 전 코드가 비어 있지 않은 EIP-7702 위임 표식(`0xef0100`으로 시작)임을 확인하고 `anvil_setCode`로 그 위임 코드를 지우며, 계정에 가스용 ETH를 넣고 T-1 표본 금액(WETH→ETH, 값은 T-1 결과를 따른다) 이상의 WETH를 절대값으로 주입하며(T-1 (7) 결과를 따른다), 프록시를 거친 읽기로 계정의 unwrap 전 WETH 잔액을 읽어 둔다
     * @when 제품 `lib/swap-transaction.ts` 함수로 DoD-22 인코딩(Ethereum WETH 주소에 `withdraw(표본 amountInRaw)`, `value` 없음 또는 0)의 요청을 만들어 anvil 계정 전송으로 보내고 영수증을 기다린다
     * @then 영수증이 성공이어서 unwrap이 체결된다
     * @then 프록시를 거친 읽기로 잰 계정의 WETH 잔액 감소량이 표본 금액과 같다
     */
    it(
      "[DoD-25] 위임 코드를 지운 계정에서 unwrap이 체결되고 WETH 잔액이 금액만큼 줄어든다",
      async () => {
        // 준비(snapshot 뒤): 지우기 전 계정 코드가 위임 표식임을 확인하고 위임 코드를 지운다.
        await readDelegationCode();
        await clearDelegationCode();

        // 준비: 가스용 ETH를 넣고 WETH를 절대값으로 주입한다(T-1 (7)).
        await prepareAccountFunds(ETHEREUM_WETH, UNWRAP_WETH_INJECTED_RAW);

        // 준비: 프록시를 거친 읽기로 계정의 unwrap 전 WETH 잔액. 주입한 절대값이다.
        const wethBefore = await readBalanceViaProxy(ETHEREUM_WETH);
        expect(wethBefore).toBe(UNWRAP_WETH_INJECTED_RAW);

        // 제품 함수로 DoD-22 인코딩의 요청을 만든다(WETH 주소에 `withdraw(amountInRaw)`, `value` 없음).
        const request = buildUnwrapRequest({ chainId: 1, amountInRaw: UNWRAP_AMOUNT_RAW });
        expect(request.to).toBe(ETHEREUM_WETH);
        expect(request.value ?? 0n).toBe(0n);
        const hash = await sendFromAccountWithGasMargin(
          request.to,
          encodeWethCalldata(request),
          request.value,
        );

        // 영수증이 성공이어서 unwrap이 체결된다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // 프록시를 거친 읽기로 잰 WETH 잔액 감소량이 표본 금액과 같다.
        const wethAfter = await readBalanceViaProxy(ETHEREUM_WETH);
        expect(wethBefore - wethAfter).toBe(UNWRAP_AMOUNT_RAW);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );

    /**
     * @spec DoD-25
     * @given (보조 확인) 고정 포크 블록의 anvil 포크에서 anvil 계정의 코드를 `eth_getCode`로 읽어 두고 그 코드가 비어 있지 않은 EIP-7702 위임 표식(`0xef0100`으로 시작)임을 확인하며, anvil snapshot을 잡은 뒤 `anvil_setCode`로 그 계정의 위임 코드를 지운다
     * @when 잡아 둔 snapshot으로 anvil을 revert한다
     * @then revert가 true를 반환한다
     * @then revert 뒤 `eth_getCode`로 읽은 계정 코드가 지우기 전에 읽어 둔 위임 코드(비어 있지 않음)와 같다
     */
    it(
      "[DoD-25] 위임 코드를 지운 뒤 snapshot으로 revert하면 위임 코드가 복원된다",
      async () => {
        // 준비: 지우기 전 계정 코드를 읽어 두고 위임 표식임을 확인한다.
        const codeBefore = await readDelegationCode();

        // 준비: snapshot을 잡은 뒤 위임 코드를 지운다(바깥 격리 snapshot과 별개의 안쪽 snapshot).
        const snapshotId = (await anvilRequest("evm_snapshot", [])) as string;
        await clearDelegationCode();

        // 잡아 둔 snapshot으로 revert한다. revert가 true를 반환한다.
        const reverted = await anvilRequest("evm_revert", [snapshotId]);
        expect(reverted).toBe(true);

        // revert 뒤 프록시를 거친 `eth_getCode`로 읽은 계정 코드가 지우기 전 위임 코드(비어 있지 않음)와 같다.
        const codeAfter = await proxiedClient.getCode({ address: ACCOUNT });
        expect(codeAfter).toBeDefined();
        expect(codeAfter?.toLowerCase()).toBe(codeBefore.toLowerCase());

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });
});
