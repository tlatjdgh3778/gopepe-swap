import {
  type Address,
  type Hash,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  http,
  isAddressEqual,
  maxUint256,
  parseAbi,
  parseEventLogs,
  toHex,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import type { FeeTier } from "@/config/uniswap-v3";
import { type BatchCall, buildBatchCalls } from "@/lib/batch-calls";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";
import { DEFAULT_SLIPPAGE_BPS, getAmountOutMinimum } from "@/lib/slippage";
import { getSwapDeadline } from "@/lib/swap-transaction";
import { readTokenAllowance } from "@/lib/token-allowance";
import { readTokenBalance } from "@/lib/token-balances";

// 계획 T-10. global-setup.ts가 전용 포트(8547)에 띄운 실제 anvil Ethereum 포크(상수로 고정한 포크 블록)에서 검증한다.
// mock 허용 경계 없음(실제 anvil 포크, `vi.stubEnv`, 준비 단계의 anvil 직접 상태 변경만).
// 준비 단계에서만 러너가 anvil 상태를 직접 바꾼다(`anvil_setBalance`, `anvil_dealERC20`, `anvil_setCode` 위임 표식,
// `evm_snapshot`/`evm_revert`). calls는 앱 `buildBatchCalls`로 만들고, 판정은 프록시를 거친 읽기로 한다.
// 데이터 격리: 테스트마다 시작 전 anvil snapshot, 끝에 revert. 포크 테스트 파일은 순차 실행.
// 실행 컨트랙트(T-1 확정): 포크 블록에 있는 eth-infinitism Simple7702Account
// `0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9`(executeBatch, self-call만 허용, 실패 시 전체 revert).
// 위임: snapshot 뒤 `anvil_setCode(계정, 0xef0100‖주소)` 위임 표식으로 둔다(revert로 원복).
// 미검증: 실제 지갑의 위임 컨트랙트와 Base·Arbitrum 실행은 증명하지 못한다.
const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;
const PROXY_URL = `${SAME_SITE_ORIGIN}/api/rpc/1`;

// 제품 config의 Ethereum SwapRouter02(approve spender, swap 대상).
const ETHEREUM_SWAP_ROUTER_02 = CONTRACTS_BY_CHAIN[1].swapRouter02;

// 전송 계정: anvil 기본 계정 0(잠금 해제). 포크 블록에서 다른(sweeper) 위임 코드가 있으므로
// 테스트마다 snapshot 뒤 Simple7702Account 위임 표식으로 바꾸고 계정 코드를 단정한다(T-1 (a)(b)).
const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// 준비 단계에서 계정에 넣는 가스용 ETH(100 ETH).
const ACCOUNT_ETH_BALANCE = 100_000_000_000_000_000_000n;

// T-1 (b) 실행 컨트랙트: eth-infinitism Simple7702Account(포크 블록에 배포돼 있음).
const SIMPLE_7702_ACCOUNT: Address = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
// EIP-7702 위임 표식: `0xef0100` + 위임 대상 주소(20바이트).
const SIMPLE_7702_DELEGATION_CODE: Hex = `0xef0100${SIMPLE_7702_ACCOUNT.slice(2).toLowerCase()}`;

// 출처: eth-infinitism account-abstraction v0.8 `BaseAccount.executeBatch(Call[] calls)`.
// T-1 (b) 기록의 셀렉터 0x34fcd5be와 맞는지 테스트 안에서 확인한다.
const simple7702AccountAbi = parseAbi([
  "struct Call { address target; uint256 value; bytes data; }",
  "function executeBatch(Call[] calls)",
]);
const EXECUTE_BATCH_SELECTOR = "0x34fcd5be";

// Ethereum 토큰 주소(리터럴).
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const QUOTER_V2: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// T-1 (b) 표본: 일반 ERC-20 입력(0 초기화 대상 아님) USDC 5(decimals 6) → DAI, 티어 100.
const SWAP_AMOUNT_IN_RAW = 5_000_000n;
const SWAP_FEE: FeeTier = 100;

// 배치 트랜잭션의 명시 gas. 성공 표본은 T-1 (b)에서 추정 178360·gasUsed 167860이었으나, snapshot revert 뒤
// anvil 가스 추정이 실제 채굴보다 부족할 수 있어 넉넉한 명시 gas를 쓴다. revert 표본은 가스 추정 자체가
// `ExecuteError`로 실패하므로 명시 gas가 필수다(T-1 (b): 800k).
const BATCH_SUCCESS_GAS = 1_000_000n;
const BATCH_REVERT_GAS = 800_000n;

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

// anvil 전용 JSON-RPC. 준비 단계에서만 쓴다.
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

// 판정 읽기(allowance, 잔액, nonce, 영수증)용 클라이언트. 모든 요청이 프록시 핸들러를 거친다.
const proxiedClient = createPublicClient({
  chain: mainnet,
  transport: http(PROXY_URL, { fetchFn: proxyFetch, timeout: 25_000, retryCount: 0 }),
});

// 프록시를 거친 제품 allowance 읽기(spender는 Ethereum SwapRouter02).
async function readRouterAllowanceViaProxy(token: Address): Promise<bigint> {
  return await readTokenAllowance(proxiedClient, {
    owner: ACCOUNT,
    spender: ETHEREUM_SWAP_ROUTER_02,
    token,
  });
}

// 프록시를 거친 제품 잔액 읽기.
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
async function sendFromAccount(to: Address, data: Hex, gas?: bigint): Promise<Hash> {
  const hash = await anvilWalletClient.sendTransaction({ to, data, gas });
  await waitForAnvilReceipt(hash);
  return hash;
}

// 준비: 계정에 가스용 ETH와 보내는 토큰을 넣는다(토큰 잔액은 절대값).
async function prepareAccountFunds(token: Address, amount: bigint): Promise<void> {
  await anvilRequest("anvil_setBalance", [ACCOUNT, toHex(ACCOUNT_ETH_BALANCE)]);
  await anvilRequest("anvil_dealERC20", [ACCOUNT, token, toHex(amount)]);
}

// 준비: 테스트 쪽 ABI(viem `erc20Abi`)로 라우터 allowance를 정하고 성공을 확인한다.
async function prepareRouterApprove(token: Address, amount: bigint): Promise<void> {
  const hash = await sendFromAccount(
    token,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ETHEREUM_SWAP_ROUTER_02, amount],
    }),
  );
  const receipt = await anvilClient.getTransactionReceipt({ hash });
  expect(receipt.status, `준비 approve ${token} ${amount}`).toBe("success");
}

// 준비: snapshot 뒤 계정 코드를 Simple7702Account 위임 표식으로 바꾸고 바뀌었는지 단정한다.
// 기존 sweeper 위임이 남아 있으면 자기 호출을 삼켜 판정이 무의미해진다(T-1 (a)).
async function delegateToSimple7702Account(): Promise<void> {
  await anvilRequest("anvil_setCode", [ACCOUNT, SIMPLE_7702_DELEGATION_CODE]);
  const code = await anvilClient.getCode({ address: ACCOUNT });
  expect(code?.toLowerCase(), "위임 표식을 둔 뒤 계정 코드").toBe(SIMPLE_7702_DELEGATION_CODE);
}

// 준비: 같은 블록에서 anvil에 QuoterV2를 직접 호출한 수령량.
async function quoteViaAnvil(): Promise<bigint> {
  const { result } = await anvilClient.simulateContract({
    address: QUOTER_V2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: USDC,
        tokenOut: DAI,
        amountIn: SWAP_AMOUNT_IN_RAW,
        fee: SWAP_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return result[0];
}

// 준비 공통: 위임 표식, 가스용 ETH와 보내는 토큰, 라우터 allowance 0(표본 금액보다 작음).
// 실행 전 allowance는 프록시를 거친 제품 읽기로 돌려준다.
async function prepareDelegatedAccountWithInsufficientAllowance(): Promise<bigint> {
  await delegateToSimple7702Account();
  await prepareAccountFunds(USDC, SWAP_AMOUNT_IN_RAW);
  await prepareRouterApprove(USDC, 0n);
  const allowance = await readRouterAllowanceViaProxy(USDC);
  expect(allowance < SWAP_AMOUNT_IN_RAW, `실행 전 allowance ${allowance}`).toBe(true);
  return allowance;
}

// 앱 `buildBatchCalls`로 표본 페어의 calls를 만든다. deadline은 전송 직전 시각으로 정한다.
function buildSampleCalls(allowance: bigint, amountOutMinimum: bigint): BatchCall[] {
  return buildBatchCalls({
    chainId: 1,
    token: USDC,
    allowance,
    swap: {
      tokenOut: { address: DAI },
      fee: SWAP_FEE,
      account: ACCOUNT,
      amountInRaw: SWAP_AMOUNT_IN_RAW,
      amountOutMinimum,
      deadline: getSwapDeadline(Date.now()),
    },
  });
}

// 표본 전제: 일반 ERC-20 입력이므로 calls가 [approve(SwapRouter02, maxUint256), SwapRouter02 swap]이다.
function expectApproveThenSwap(calls: BatchCall[]): void {
  expect(calls).toHaveLength(2);
  const [approveCall, swapCall] = calls;
  expect(isAddressEqual(approveCall.to, USDC), "첫 call 대상").toBe(true);
  const decoded = decodeFunctionData({ abi: erc20Abi, data: approveCall.data });
  expect(decoded.functionName).toBe("approve");
  expect(decoded.args).toEqual([ETHEREUM_SWAP_ROUTER_02, maxUint256]);
  expect(isAddressEqual(swapCall.to, ETHEREUM_SWAP_ROUTER_02), "둘째 call 대상").toBe(true);
}

// 앱 calls를 Simple7702Account `executeBatch(calls)` calldata로 감싼다. `value`가 없으면 0이다.
function encodeExecuteBatch(calls: BatchCall[]): Hex {
  const data = encodeFunctionData({
    abi: simple7702AccountAbi,
    functionName: "executeBatch",
    args: [calls.map((call) => ({ target: call.to, value: call.value ?? 0n, data: call.data }))],
  });
  expect(data.slice(0, 10), "executeBatch 셀렉터").toBe(EXECUTE_BATCH_SELECTOR);
  return data;
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

describe("배치 실행 — Ethereum 포크에서 approve와 swap이 트랜잭션 하나로 함께 체결되거나 함께 되돌려진다", () => {
  // 판정과 분리한 anvil 직접 사전 읽기. cold 포크에서 프록시 상류 시간 제한(5초)을 넘어
  // 판정 읽기가 공개 RPC로 넘어가지 않도록 판정이 읽는 상태와 스왑 경로 상태를 미리 포크에 올린다.
  beforeAll(async () => {
    await anvilClient.getCode({ address: SIMPLE_7702_ACCOUNT });
    await anvilClient.getCode({ address: ETHEREUM_SWAP_ROUTER_02 });
    await quoteViaAnvil();
    await anvilClient.getTransactionCount({ address: ACCOUNT });
    for (const token of [USDC, DAI]) {
      await anvilClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [ACCOUNT, ETHEREUM_SWAP_ROUTER_02],
      });
      await anvilClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ACCOUNT],
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

  describe("allowance가 부족한 ERC-20 입력을 배치로 스왑할 때", () => {
    isolateWritesWithSnapshot();

    // 참고: USDC는 max allowance에서도 차감되므로 성공 뒤 allowance == maxUint256 판정을 쓰지 않는다.
    /**
     * @spec DoD-30
     * @given 상수로 고정한 포크 블록의 Ethereum anvil 포크에서 테스트 시작에 snapshot을 잡아 끝에 revert하며, 포크 블록의 Simple7702Account로 위임 표식을 둔 계정에 표본 페어(일반 ERC-20 입력, 0 초기화 대상 아님)의 보내는 토큰을 표본 금액 이상 넣고 SwapRouter02 allowance가 표본 금액보다 작게 두며, 같은 블록에서 QuoterV2를 직접 호출한 견적으로 최소 수령량을 만들고 받는 토큰의 실행 전 잔액을 읽어 둔다
     * @when 앱이 그 토큰·allowance·스왑 조건으로 만든 `calls`([approve(SwapRouter02, maxUint256), SwapRouter02 multicall(deadline, …)])를 그 계정 자신에게 보내는 Simple7702Account `executeBatch(calls)` 트랜잭션 하나로 보내고 영수증을 기다린다
     * @then approve와 swap이 트랜잭션 1건으로 실행된다
     * @then 그 트랜잭션의 영수증이 성공이다
     * @then 받는 토큰 잔액이 실행 전보다 늘었다
     */
    it(
      "[DoD-30] 앱이 만든 calls가 트랜잭션 하나로 체결되고 받는 토큰 잔액이 는다",
      async () => {
        // 준비: 위임 표식, 보내는 토큰(USDC) 표본 금액, 표본 금액보다 작은 라우터 allowance.
        const allowanceBefore = await prepareDelegatedAccountWithInsufficientAllowance();

        // 준비: 같은 블록 QuoterV2 직접 견적으로 기본 슬리피지 최소 수령량을 만든다. 0이면 판정이 무의미하다.
        const quotedAmountOut = await quoteViaAnvil();
        const amountOutMinimum = getAmountOutMinimum(quotedAmountOut, DEFAULT_SLIPPAGE_BPS);
        expect(amountOutMinimum > 0n, `최소 수령량 ${amountOutMinimum}`).toBe(true);

        // 준비: 프록시를 거친 읽기로 받는 토큰(DAI) 실행 전 잔액과 계정 nonce.
        const daiBefore = await readBalanceViaProxy(DAI);
        const nonceBefore = await proxiedClient.getTransactionCount({ address: ACCOUNT });

        // 앱이 만든 calls를 계정 자신에게 보내는 `executeBatch(calls)` 트랜잭션 하나로 보낸다.
        const calls = buildSampleCalls(allowanceBefore, amountOutMinimum);
        expectApproveThenSwap(calls);
        const hash = await sendFromAccount(ACCOUNT, encodeExecuteBatch(calls), BATCH_SUCCESS_GAS);

        // 그 트랜잭션의 영수증이 성공이다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // approve와 swap이 트랜잭션 1건으로 실행된다: 계정 nonce가 1만 늘었고,
        // 같은 영수증에 approve의 Approval(계정 → SwapRouter02)과 swap의 DAI 수령 Transfer가 함께 있다.
        const nonceAfter = await proxiedClient.getTransactionCount({ address: ACCOUNT });
        expect(nonceAfter - nonceBefore).toBe(1);
        expect(isAddressEqual(receipt.from, ACCOUNT)).toBe(true);
        expect(receipt.to !== null && isAddressEqual(receipt.to, ACCOUNT)).toBe(true);
        const logs = parseEventLogs({ abi: erc20Abi, logs: receipt.logs });
        const approvedInTx = logs.some(
          (log) =>
            log.eventName === "Approval" &&
            isAddressEqual(log.address, USDC) &&
            isAddressEqual(log.args.owner, ACCOUNT) &&
            isAddressEqual(log.args.spender, ETHEREUM_SWAP_ROUTER_02),
        );
        expect(approvedInTx, "같은 영수증의 USDC Approval").toBe(true);
        const receivedInTx = logs.some(
          (log) =>
            log.eventName === "Transfer" &&
            isAddressEqual(log.address, DAI) &&
            isAddressEqual(log.args.to, ACCOUNT),
        );
        expect(receivedInTx, "같은 영수증의 DAI 수령 Transfer").toBe(true);

        // 받는 토큰 잔액이 실행 전보다 늘었다.
        const daiAfter = await readBalanceViaProxy(DAI);
        expect(daiAfter > daiBefore, `DAI ${daiBefore} → ${daiAfter}`).toBe(true);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });

  describe("배치 안의 swap이 revert할 때", () => {
    isolateWritesWithSnapshot();

    // 참고: revert 표본은 가스 추정(estimateGas)이 실패하므로 명시 gas로 보낸다.
    /**
     * @spec DoD-31
     * @given DoD-30과 같은 포크·snapshot/revert·Simple7702Account로 위임 표식을 둔 계정·표본 페어와 금액에서 SwapRouter02 allowance가 표본 금액보다 작고 그 실행 전 allowance를 읽어 두며, 최소 수령량을 같은 블록 QuoterV2 직접 견적보다 크게 둔다
     * @when 앱이 그 조건으로 만든 `calls`(approve와 swap)를 그 계정 자신에게 보내는 Simple7702Account `executeBatch(calls)` 트랜잭션 하나로 revert 관찰용 명시 gas로 보내고 영수증을 기다린다
     * @then 그 트랜잭션의 영수증이 reverted다
     * @then 보내는 토큰의 SwapRouter02 allowance가 실행 전과 같아 approve도 되돌려졌다
     */
    it(
      "[DoD-31] swap이 revert하는 calls는 approve도 되돌려 allowance가 실행 전과 같다",
      async () => {
        // 준비: DoD-30과 같은 위임 표식·표본 금액·표본 금액보다 작은 라우터 allowance. 실행 전 allowance를 읽어 둔다.
        const allowanceBefore = await prepareDelegatedAccountWithInsufficientAllowance();

        // 준비: 최소 수령량을 같은 블록 QuoterV2 직접 견적보다 크게 둔다(T-1 (b): 견적 + 1).
        const quotedAmountOut = await quoteViaAnvil();
        const amountOutMinimum = quotedAmountOut + 1n;

        // 앱이 만든 calls(approve와 swap)를 `executeBatch(calls)` 트랜잭션 하나로 명시 gas로 보낸다.
        const calls = buildSampleCalls(allowanceBefore, amountOutMinimum);
        expectApproveThenSwap(calls);
        const hash = await sendFromAccount(ACCOUNT, encodeExecuteBatch(calls), BATCH_REVERT_GAS);

        // 그 트랜잭션의 영수증이 reverted다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("reverted");

        // 보내는 토큰의 SwapRouter02 allowance가 실행 전과 같아 approve도 되돌려졌다.
        const allowanceAfter = await readRouterAllowanceViaProxy(USDC);
        expect(allowanceAfter).toBe(allowanceBefore);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });
});
