import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  createPublicClient,
  erc20Abi,
  http,
  numberToHex,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";

import { E2E_ANVIL_PORT } from "../../config/e2e";

// 러너가 E2E용 Ethereum anvil 포크에 직접 보내는 상태 주입·조회 요청.
// 앱(브라우저)의 요청은 가로채지 않는다. 앱은 프록시(`/api/rpc/1`)를 거쳐 같은 anvil을 읽는다.
const ANVIL_URL = `http://127.0.0.1:${E2E_ANVIL_PORT}`;

// cold 포크의 스냅샷 토큰 일괄 읽기는 업체 RPC에서 상태를 가져와 수 분이 걸린다(T-1: 약 95~170초).
export const ANVIL_WARM_UP_TIMEOUT_MS = 300_000;

const anvilClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: 30_000, retryCount: 0 }),
});

const anvilWarmUpClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: ANVIL_WARM_UP_TIMEOUT_MS - 20_000, retryCount: 0 }),
});

type JsonRpcResponse = { result?: unknown; error?: { code: number; message: string } };

// viem 스키마에 없는 anvil 전용 메서드를 보낸다.
async function anvilRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`[e2e] anvil ${method} HTTP ${response.status}`);
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) throw new Error(`[e2e] anvil ${method} 실패: ${body.error.message}`);
  return body.result;
}

// 계정의 ERC-20 잔액을 절대값으로 바꾼다. 인자 순서는 (계정, 토큰, 양)이다(T-1 확인).
export async function setErc20Balance(
  account: Address,
  token: Address,
  amount: bigint,
): Promise<void> {
  await anvilRpc("anvil_dealERC20", [account, token, numberToHex(amount)]);
}

// 계정의 ERC-20 잔액 정수를 anvil에서 직접 읽는다.
export async function readErc20Balance(account: Address, token: Address): Promise<bigint> {
  return anvilClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

// 계정의 ETH 잔액 정수(wei)를 anvil에서 직접 읽는다.
export async function readEthBalance(account: Address): Promise<bigint> {
  return anvilClient.getBalance({ address: account });
}

// 앱의 모달 일괄 읽기가 프록시 상류 시간 제한 안에 끝나도록, 같은 계정의 토큰 잔액을 미리 읽어
// 포크 상태(토큰 코드·저장소 슬롯, Multicall3)를 데운다. 판정에는 쓰지 않는다.
export async function warmUpTokenBalances(
  account: Address,
  tokens: readonly Address[],
): Promise<void> {
  await Promise.all([
    anvilWarmUpClient.getBalance({ address: account }),
    anvilWarmUpClient.multicall({
      contracts: tokens.map((address) => ({
        address,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [account] as const,
      })),
      allowFailure: true,
      batchSize: 10_000,
    }),
  ]);
}

// Ethereum QuoterV2 주소(리터럴). 기대값 읽기는 제품 config를 거치지 않는다.
// 출처: Uniswap v3 Ethereum 배포 문서.
export const QUOTER_V2_ADDRESS: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// 스펙 DoD-1의 네 수수료 티어. 낮은 수수료 순.
export const DIRECT_QUOTE_FEE_TIERS = [100, 500, 3000, 10000] as const;
export type DirectQuoteFeeTier = (typeof DIRECT_QUOTE_FEE_TIERS)[number];

export type DirectTierQuote =
  | { status: "revert" }
  | { status: "ok"; amountOut: bigint; sqrtPriceX96After: bigint };

export type DirectTierQuotes = Record<DirectQuoteFeeTier, DirectTierQuote>;

// 출처: Uniswap v3-periphery `IQuoterV2.quoteExactInputSingle`.
const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// cold 포크의 첫 견적은 업체 RPC에서 풀 상태를 가져와 6~7초가 걸려 프록시 상류 제한(5초)을 넘는다(T-1).
// 예열 hook의 시간 제한만 이만큼 늘린다.
export const QUOTE_WARM_UP_TIMEOUT_MS = 120_000;

const anvilQuoteWarmUpClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: QUOTE_WARM_UP_TIMEOUT_MS - 20_000, retryCount: 0 }),
});

function isRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError || cause instanceof ExecutionRevertedError,
    ) !== null
  );
}

async function quoteEachTierWith(
  client: typeof anvilClient,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<DirectTierQuotes> {
  const entries = await Promise.all(
    DIRECT_QUOTE_FEE_TIERS.map(async (fee): Promise<[DirectQuoteFeeTier, DirectTierQuote]> => {
      try {
        const { result } = await client.simulateContract({
          address: QUOTER_V2_ADDRESS,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        const [amountOut, sqrtPriceX96After] = result;
        return [fee, { status: "ok", amountOut, sqrtPriceX96After }];
      } catch (error) {
        if (isRevert(error)) return [fee, { status: "revert" }];
        throw error;
      }
    }),
  );
  return Object.fromEntries(entries) as DirectTierQuotes;
}

// 러너가 anvil의 QuoterV2를 수수료 티어마다 따로 직접 호출한다(앱 요청과 분리, 판정의 기대값용).
// revert는 그 티어의 결과로 남기고, 그 밖의 실패(연결·시간 초과)는 그대로 던진다.
export async function quoteEachTierDirectly(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<DirectTierQuotes> {
  return quoteEachTierWith(anvilClient, tokenIn, tokenOut, amountIn);
}

// 앱의 견적 aggregate3가 프록시 상류 시간 제한 안에 끝나도록, 같은 입력의 티어별 견적을 미리 불러
// 포크에 풀 상태(slot0·tick·유동성)를 올린다. 판정에는 쓰지 않는다.
export async function warmUpSwapQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<void> {
  await quoteEachTierWith(anvilQuoteWarmUpClient, tokenIn, tokenOut, amountIn);
}
