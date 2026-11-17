import {
  type Address,
  type Hash,
  type Hex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  toHex,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { FORK_BLOCK_NUMBER, FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import type { FeeTier } from "@/config/uniswap-v3";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";
import { DEFAULT_SLIPPAGE_BPS, getAmountOutMinimum } from "@/lib/slippage";
import {
  buildApproveRequest,
  buildExactInputSingleParams,
  encodeApproveCalldata,
  encodeSwapMulticallCalldata,
  getSwapDeadline,
} from "@/lib/swap-transaction";
import { readTokenAllowance } from "@/lib/token-allowance";
import { readTokenBalance } from "@/lib/token-balances";

// global-setup.ts가 전용 포트(8547)에 띄운 Ethereum anvil 포크(상수로 고정한 포크 블록)에서 검증한다.
// mock 경계(사용자 확정): 실제 anvil 포크와 프록시 코드, `vi.stubEnv`만 쓴다. anvil 직접 상태 변경
// (`anvil_dealERC20`, 잠금 해제 계정 전송과 부분 allowance 준비, snapshot/revert)은 준비 단계에만 쓰고,
// 판정은 제품 함수와 프록시를 거친 읽기로 한다.
// 데이터 격리: 포크 테스트 파일은 순차 실행하고(`vitest.fork.config.mts`의 `fileParallelism: false`),
// 쓰기 트랜잭션을 보내는 테스트는 테스트마다 시작 전 anvil snapshot을 잡고 끝에 revert한다.
// 표본 페어·금액은 사전 확인 T-1 (3)(4)의 결과를 쓴다(ERC-20 페어 USDC→DAI, 초기화 대상 Ethereum USDT).
const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;
const FORK_BLOCK = BigInt(FORK_BLOCK_NUMBER);

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;
const PROXY_URL = `${SAME_SITE_ORIGIN}/api/rpc/1`;

// 제품 config의 Ethereum SwapRouter02(approve spender, swap 대상).
const ETHEREUM_SWAP_ROUTER_02 = CONTRACTS_BY_CHAIN[1].swapRouter02;
// 스펙 §4.1의 Ethereum SwapRouter02 리터럴. 보낸 calldata의 spender 판정에만 쓴다.
const SPEC_ETHEREUM_SWAP_ROUTER_02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

// 전송 계정: anvil 기본 계정 0(잠금 해제). T-1이 같은 계정으로 체결을 확인했다.
const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// 준비 단계에서 계정에 넣는 가스용 ETH(100 ETH).
const ACCOUNT_ETH_BALANCE = 100_000_000_000_000_000_000n;

// Ethereum 토큰 주소(리터럴).
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const QUOTER_V2: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// T-1 (4) 표본: USDC 5(decimals 6) → DAI. 포크 블록 기준 선택 티어 100(10000 티어는 유동성 소진),
// 예상 수령량 4999293837387471838, 기본 슬리피지(50bps) 최소 수령량 4974297368200534478.
const SWAP_AMOUNT_IN_RAW = 5_000_000n;
const T1_SELECTED_FEE: FeeTier = 100;
const T1_AMOUNT_OUT = 4_999_293_837_387_471_838n;
const T1_AMOUNT_OUT_MINIMUM = 4_974_297_368_200_534_478n;

// T-1 (3) 표본: Ethereum USDT 부분 allowance 1 USDT < amountInRaw 5 USDT(decimals 6).
const USDT_AMOUNT_IN_RAW = 5_000_000n;
const USDT_PARTIAL_ALLOWANCE = 1_000_000n;

// EC-12 대조에서 revert를 영수증으로 관찰하려고 직접 지정하는 가스 한도(지정하지 않으면 가스 추정 단계에서 실패한다).
const CONTROL_APPROVE_GAS = 100_000n;

// cold 포크의 첫 상태 읽기는 업체 RPC에서 가져와 수 초가 걸린다(T-1: USDC→DAI 견적 약 9초).
const WARM_UP_TIMEOUT_MS = 120_000;
const WRITE_TEST_TIMEOUT_MS = 120_000;

// 출처: Uniswap v3-periphery `IQuoterV2.quoteExactInputSingle`.
const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// 보낸 approve calldata 판정용 ABI(테스트 쪽 리터럴). 출처: EIP-20 `approve`.
const approveAbi = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);

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

// anvil 전용 JSON-RPC(`anvil_dealERC20`, `anvil_setBalance`, `evm_snapshot`, `evm_revert`). 준비 단계에서만 쓴다.
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

// 판정 읽기(allowance, 잔액, 영수증)용 클라이언트. 모든 요청이 프록시 핸들러를 거친다.
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

// 준비: anvil 계정 전송으로 트랜잭션을 보내고 anvil 직접 영수증으로 체결을 기다린다.
async function sendFromAccount(to: Address, data: Hex, gas?: bigint): Promise<Hash> {
  const hash = await anvilWalletClient.sendTransaction({ to, data, gas });
  await waitForAnvilReceipt(hash);
  return hash;
}

// 준비 단계의 영수증 대기 상한과 폴링 간격.
const RECEIPT_WAIT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_INTERVAL_MS = 100;

// anvil에 `eth_getTransactionReceipt`를 직접 폴링해 영수증이 나올 때까지 기다린다.
// viem `waitForTransactionReceipt`는 블록 이벤트 기반이라, automine에서 첫 조회 직후 채굴된 블록을 건너뛰면
// 새 트랜잭션이 없어 다음 블록이 생기지 않아 끝나지 않는다. 블록을 추가로 채굴하지 않고 영수증만 다시 조회한다.
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

// 준비: 테스트 쪽 ABI(viem `erc20Abi`)로 approve를 보내고 성공을 확인한다.
async function prepareApprove(token: Address, amount: bigint): Promise<void> {
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

// 준비: 계정에 가스용 ETH와 토큰을 넣는다.
async function prepareAccountFunds(token?: Address, amount?: bigint): Promise<void> {
  await anvilRequest("anvil_setBalance", [ACCOUNT, toHex(ACCOUNT_ETH_BALANCE)]);
  if (token !== undefined && amount !== undefined) {
    await anvilRequest("anvil_dealERC20", [ACCOUNT, token, toHex(amount)]);
  }
}

// 준비: USDT allowance를 0 < allowance < amountInRaw로 만든다.
// USDT는 0이 아닌 allowance 위 0이 아닌 approve가 revert하므로 먼저 0으로 맞춘다.
async function prepareUsdtPartialAllowance(): Promise<void> {
  await prepareAccountFunds();
  await prepareApprove(USDT, 0n);
  await prepareApprove(USDT, USDT_PARTIAL_ALLOWANCE);
}

// 쓰기 테스트 격리: 테스트마다 snapshot을 새로 잡고 끝에 revert한다. revert한 id는 다시 쓸 수 없다(T-1).
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

describe("approve → swap — Ethereum 포크에서 승인과 단일 홉 스왑이 체결된다", () => {
  // 판정과 분리한 anvil 직접 사전 읽기. cold 포크에서 프록시 상류 시간 제한(5초)을 넘어
  // 판정 읽기가 공개 RPC로 넘어가지 않도록 판정이 읽는 상태와 스왑 경로 상태를 미리 포크에 올린다.
  beforeAll(async () => {
    await anvilClient.getCode({ address: ETHEREUM_SWAP_ROUTER_02 });
    await anvilClient.simulateContract({
      address: QUOTER_V2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: USDC,
          tokenOut: DAI,
          amountIn: SWAP_AMOUNT_IN_RAW,
          fee: T1_SELECTED_FEE,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    for (const token of [USDC, USDT, DAI]) {
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

  describe("라우터 주소", () => {
    /**
     * @spec DoD-2
     * @given 상수로 고정한 포크 블록의 Ethereum anvil 포크와 Ethereum config의 `swapRouter02` 주소가 있다(읽기 전용, 상태 변경 없음)
     * @when 포크에 고정 블록 기준으로 그 주소의 코드를 `eth_getCode`로 조회한다
     * @then 그 주소에 컨트랙트 코드가 있다
     */
    it("[DoD-2] Ethereum 포크 고정 블록에서 swapRouter02 주소에 컨트랙트 코드가 있다", async () => {
      const code = await anvilClient.getCode({
        address: ETHEREUM_SWAP_ROUTER_02,
        blockNumber: FORK_BLOCK,
      });

      // viem은 빈 코드(`0x`)를 undefined로 돌려준다.
      expect(code, ETHEREUM_SWAP_ROUTER_02).toBeDefined();
      expect(code, ETHEREUM_SWAP_ROUTER_02).not.toBe("0x");
    });
  });

  describe("allowance가 부족한 ERC-20을 승인할 때", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-13
     * @given 프록시의 Ethereum 대상이 `vi.stubEnv`로 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, 준비 단계에서 `anvil_dealERC20`으로 anvil 계정에 T-1 (4) 표본 페어의 보내는 토큰(USDC)을 표본 금액 이상 주입하고, 프록시를 거친 제품 allowance 읽기로 그 계정의 Ethereum `swapRouter02`에 대한 USDC allowance가 표본 금액(`amountInRaw`)보다 작아 `approve-required` 조건임을 확인해 둔다
     * @when 제품 `lib/swap-transaction.ts` 함수로 그 토큰·현재 allowance·`amountInRaw`에 맞는 approve calldata를 만들어 anvil 계정 전송으로 USDC 컨트랙트에 보내고 영수증을 기다린다
     * @then 영수증이 성공이다
     * @then 프록시를 거친 제품 allowance 읽기로 읽은 그 계정의 Ethereum `swapRouter02`에 대한 USDC allowance가 `maxUint256`이다
     */
    it(
      "[DoD-13] approve 체결 뒤 swapRouter02에 대한 allowance가 maxUint256이다",
      async () => {
        // 준비: 가스용 ETH와 보내는 토큰(USDC)을 표본 금액만큼 넣는다.
        await prepareAccountFunds(USDC, SWAP_AMOUNT_IN_RAW);

        // 전제: 프록시를 거친 제품 읽기로 allowance < amountInRaw(`approve-required` 조건).
        const allowanceBefore = await readRouterAllowanceViaProxy(USDC);
        expect(allowanceBefore < SWAP_AMOUNT_IN_RAW).toBe(true);

        // 제품 함수로 approve 대상·금액과 calldata를 만들어 anvil 계정으로 보낸다.
        const request = buildApproveRequest({
          chainId: 1,
          token: USDC,
          allowance: allowanceBefore,
          amountInRaw: SWAP_AMOUNT_IN_RAW,
        });
        const hash = await sendFromAccount(request.to, encodeApproveCalldata(request));

        // 영수증이 성공이다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // 프록시를 거친 제품 allowance 읽기로 maxUint256이다.
        expect(await readRouterAllowanceViaProxy(USDC)).toBe(maxUint256);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });

  describe("allowance가 충분한 ERC-20 페어를 스왑할 때", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec DoD-18
     * @given 프록시의 Ethereum 대상이 `vi.stubEnv`로 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, 준비 단계에서 anvil 계정에 T-1 (4) 표본 페어(USDC→DAI)의 보내는 토큰을 표본 금액 이상 주입하고 Ethereum `swapRouter02`에 대한 allowance를 표본 금액 이상으로 만들어 두며, 같은 블록에서 anvil에 QuoterV2를 직접 호출한 견적의 수수료 티어와 수령량으로 `amountOutMinimum`을 만들어 두고(T-1 (4)에서 0이 아님을 확인한 표본 금액), 프록시를 거친 읽기로 받는 토큰(DAI)의 스왑 전 잔액을 읽어 둔다
     * @when 제품 `lib/swap-transaction.ts` 함수로 `tokenIn` USDC, `tokenOut` DAI, `fee` 직접 견적 티어, `recipient` anvil 계정, `amountIn` 표본 금액(`amountInRaw`), `amountOutMinimum`, `sqrtPriceLimitX96` 0인 `exactInputSingle`을 담은 `multicall(deadline, [exactInputSingle(params)])` calldata와 deadline을 만들어 anvil 계정 전송으로 Ethereum `swapRouter02`에 보내고 영수증을 기다린다
     * @then 영수증이 성공이어서 스왑이 체결된다
     * @then 프록시를 거친 읽기로 잰 받는 토큰(DAI) 잔액 증가량이 `amountOutMinimum` 이상이다
     */
    it(
      "[DoD-18] 스왑이 체결되고 받는 토큰 증가량이 amountOutMinimum 이상이다",
      async () => {
        // 준비: 보내는 토큰(USDC)을 표본 금액만큼 넣고 라우터 allowance를 표본 금액 이상(max)으로 만든다.
        await prepareAccountFunds(USDC, SWAP_AMOUNT_IN_RAW);
        await prepareApprove(USDC, maxUint256);

        // 준비: 스왑 직전 블록에서 anvil에 QuoterV2를 직접 호출해 T-1 (4) 선택 티어의 수령량을 얻는다.
        const { result } = await anvilClient.simulateContract({
          address: QUOTER_V2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: USDC,
              tokenOut: DAI,
              amountIn: SWAP_AMOUNT_IN_RAW,
              fee: T1_SELECTED_FEE,
              sqrtPriceLimitX96: 0n,
            },
          ],
        });
        const [quotedAmountOut] = result;
        // 표본 전제: 포크 블록 풀 상태 그대로의 T-1 (4) 수령량이다(준비 트랜잭션은 풀을 건드리지 않는다).
        expect(quotedAmountOut).toBe(T1_AMOUNT_OUT);

        // 기본 슬리피지의 최소 수령량(F4 `useAmountOutMinimum()`과 같은 계산). 0이면 판정이 무의미하다.
        const amountOutMinimum = getAmountOutMinimum(quotedAmountOut, DEFAULT_SLIPPAGE_BPS);
        expect(amountOutMinimum).toBe(T1_AMOUNT_OUT_MINIMUM);
        expect(amountOutMinimum > 0n).toBe(true);

        // 준비: 프록시를 거친 읽기로 받는 토큰(DAI)의 스왑 전 잔액.
        const daiBefore = await readTokenBalance(proxiedClient, {
          account: ACCOUNT,
          token: { address: DAI },
        });

        // 제품 함수로 `multicall(deadline, [exactInputSingle(params)])` calldata를 만들어 라우터에 보낸다.
        // 포크 블록 timestamp가 클라이언트 시각보다 과거라 전송 직전 시각 + 1800초 deadline이 통과한다(T-1 (5)).
        const params = buildExactInputSingleParams({
          chainId: 1,
          tokenIn: { address: USDC },
          tokenOut: { address: DAI },
          fee: T1_SELECTED_FEE,
          recipient: ACCOUNT,
          amountInRaw: SWAP_AMOUNT_IN_RAW,
          amountOutMinimum,
        });
        const deadline = getSwapDeadline(Date.now());
        const hash = await sendFromAccount(
          ETHEREUM_SWAP_ROUTER_02,
          encodeSwapMulticallCalldata({ deadline, params }),
        );

        // 영수증이 성공이어서 스왑이 체결된다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // 프록시를 거친 읽기로 잰 DAI 잔액 증가량이 amountOutMinimum 이상이다.
        const daiAfter = await readTokenBalance(proxiedClient, {
          account: ACCOUNT,
          token: { address: DAI },
        });
        expect(daiAfter - daiBefore >= amountOutMinimum, `증가량 ${daiAfter - daiBefore}`).toBe(
          true,
        );

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });

  describe("allowance 초기화 대상 토큰(Ethereum USDT)의 allowance가 일부만 있을 때", () => {
    isolateWritesWithSnapshot();

    /**
     * @spec EC-12
     * @given 프록시의 Ethereum 대상이 `vi.stubEnv`로 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, 준비 단계에서 anvil 계정 전송으로 그 계정의 Ethereum USDT `swapRouter02` allowance를 0보다 크고 T-1 (3) 표본 금액(`amountInRaw`)보다 작게 만들고, 프록시를 거친 제품 allowance 읽기로 0 < allowance < `amountInRaw`임을 확인해 둔다
     * @when 제품 `lib/swap-transaction.ts` 함수로 그 토큰·현재 allowance·`amountInRaw`에 맞는 approve calldata를 만들어 anvil 계정 전송으로 USDT 컨트랙트에 보내고 영수증을 기다린다
     * @then 보낸 calldata가 `approve(swapRouter02, 0)`이다
     * @then 영수증이 성공이다
     * @then 프록시를 거친 제품 allowance 읽기로 읽은 그 계정의 Ethereum `swapRouter02`에 대한 USDT allowance가 0이다
     */
    it(
      "[EC-12] 일부 allowance가 있는 USDT는 approve(swapRouter02, 0)로 0이 된다",
      async () => {
        await prepareUsdtPartialAllowance();

        // 전제: 프록시를 거친 제품 읽기로 0 < allowance < amountInRaw.
        const allowanceBefore = await readRouterAllowanceViaProxy(USDT);
        expect(allowanceBefore).toBe(USDT_PARTIAL_ALLOWANCE);
        expect(allowanceBefore > 0n && allowanceBefore < USDT_AMOUNT_IN_RAW).toBe(true);

        // 제품 함수로 approve 대상·금액과 calldata를 만든다.
        const request = buildApproveRequest({
          chainId: 1,
          token: USDT,
          allowance: allowanceBefore,
          amountInRaw: USDT_AMOUNT_IN_RAW,
        });
        const data = encodeApproveCalldata(request);

        // 보낸 calldata가 USDT 컨트랙트로 가는 `approve(swapRouter02, 0)`이다(테스트 쪽 ABI·스펙 주소 리터럴로 디코딩).
        expect(getAddress(request.to)).toBe(getAddress(USDT));
        const decoded = decodeFunctionData({ abi: approveAbi, data });
        expect(decoded.functionName).toBe("approve");
        const [spender, amount] = decoded.args;
        expect(getAddress(spender)).toBe(getAddress(SPEC_ETHEREUM_SWAP_ROUTER_02));
        expect(amount).toBe(0n);

        // USDT approve는 반환 데이터가 없어 simulate 없이 calldata로 보낸다(T-1 (3)).
        const hash = await sendFromAccount(request.to, data);

        // 영수증이 성공이다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("success");

        // 프록시를 거친 제품 allowance 읽기로 0이다.
        expect(await readRouterAllowanceViaProxy(USDT)).toBe(0n);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );

    /**
     * @spec EC-12
     * @given (전제 대조) 프록시의 Ethereum 대상이 `vi.stubEnv`로 고정 포크 블록의 anvil 포크로 맞춰져 있고 테스트 시작에 anvil snapshot을 잡아 끝에 revert하며, 준비 단계에서 anvil 계정 전송으로 그 계정의 Ethereum USDT `swapRouter02` allowance를 0보다 크고 T-1 (3) 표본 금액보다 작게 만들어 둔다
     * @when 0이 아닌 금액의 `approve(swapRouter02, maxUint256)`을 anvil 계정 전송으로 USDT 컨트랙트에 보낸다
     * @then 트랜잭션이 revert한다
     * @then 프록시를 거친 제품 allowance 읽기로 읽은 allowance가 준비한 값 그대로다
     */
    it(
      "[EC-12] 0이 아닌 USDT allowance 위에 0이 아닌 approve를 보내면 revert한다",
      async () => {
        await prepareUsdtPartialAllowance();

        // 0이 아닌 금액(maxUint256)의 approve를 보낸다. 가스 한도를 직접 지정해 체결된 영수증으로 revert를 본다.
        const hash = await sendFromAccount(
          USDT,
          encodeFunctionData({
            abi: approveAbi,
            functionName: "approve",
            args: [SPEC_ETHEREUM_SWAP_ROUTER_02, maxUint256],
          }),
          CONTROL_APPROVE_GAS,
        );

        // 트랜잭션이 revert한다.
        const receipt = await readReceiptViaProxy(hash);
        expect(receipt.status).toBe("reverted");

        // 프록시를 거친 제품 allowance 읽기로 준비한 값 그대로다.
        expect(await readRouterAllowanceViaProxy(USDT)).toBe(USDT_PARTIAL_ALLOWANCE);

        expectProxiedCallsOk();
      },
      WRITE_TEST_TIMEOUT_MS,
    );
  });
});
