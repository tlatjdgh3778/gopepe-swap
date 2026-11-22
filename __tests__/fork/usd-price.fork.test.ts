import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  type Hex,
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FORK_BLOCK_NUMBER, FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "@/config/tokens";
import { readTokenUsdPrices } from "@/lib/read-token-usd-price";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";
import type { UsdPrice } from "@/lib/token-usd-price";

// 골격(T-12). global-setup.ts가 전용 포트(8547)에 띄운 Ethereum anvil 포크(상수로 고정한 포크 블록)에서 읽기 전용으로 검증한다.
// 판정 대상 단가 읽기는 viem `http` transport의 `fetchFn`을 프록시 핸들러에 연결해 같은 사이트 `POST /api/rpc/1` 요청으로 보내고,
// 기대값과 전제 확인은 판정과 분리한 anvil 직접 읽기(QuoterV2 티어별 직접 호출, 테스트 쪽 티어 선택, 고른 티어 풀 `slot0`)로 얻는다.
// 테스트 쪽 티어 선택: 풀 없음 revert·수령량 0·유동성 소진(견적 후 가격이 방향별 한계값) 티어를 빼고 수령량이 가장 많은 티어, 같으면 수수료가 가장 낮은 티어.
// 주소·ABI는 리터럴이고 기대값 계산은 제품 config를 거치지 않는다. 표본 토큰(USDC 직접 경로 ERC-20, WETH 경유 토큰, 풀 없는 토큰)은 사전 확인 T-1 (2)·(3) 결과를 따른다.
// cold 포크 지연이 프록시 상류 시간 제한(5초)을 넘지 않도록 판정 전에 직접 읽기로 단가 경로 풀을 예열한다.
// mock 경계(사용자 확정 2026-11-22): 없음. `vi.stubEnv`로 프록시의 Ethereum 대상만 anvil로 바꾸고 vi.mock·fetch 스텁을 쓰지 않는다.
// 데이터 격리: 읽기 전용(쓰기 트랜잭션 없음), 전용 포트 8547, 파일 순차 실행(vitest.fork.config.mts). env 스텁은 테스트마다 원복한다.

const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;
const FORK_BLOCK = BigInt(FORK_BLOCK_NUMBER);

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;
const PROXY_URL = `${SAME_SITE_ORIGIN}/api/rpc/1`;

// Ethereum 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
const QUOTER_V2: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const UNISWAP_V3_FACTORY: Address = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// DoD-5 표본(T-1 (2)): USDC 직접 경로 후보 티어가 있는 WETH 외 ERC-20.
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
// DoD-6 표본(T-1 (2)): USDC 네 티어 후보가 없고 WETH 후보 티어가 있는 토큰. API3는 WETH 대비 token0, KNC는 token1.
const API3: Address = "0x0b38210ea11411557c13457D4dA7dC6ea731B88a";
const KNC: Address = "0xdd974D5C2e2928deA5F71b9825b8b646686BD200";
// EC-18 표본(T-1 (3)): Ethereum 토큰 목록 안에 있고 USDC·WETH 풀이 모두 없는 토큰.
const SOLV: Address = "0x169E36F327cAA83d004f5c2668AC25A1424C940d";

// 표본 토큰의 소수 자릿수(리터럴). 전제 확인에서 포크의 `decimals()`와 대조한다.
const DECIMALS_18 = 18;

// 스펙 DoD-1의 네 수수료 티어. 낮은 수수료 순.
const FEE_TIERS = [100, 500, 3000, 10000] as const;
type FeeTier = (typeof FEE_TIERS)[number];

// QuoterV2가 `sqrtPriceLimitX96 = 0`일 때 쓰는 방향별 한계값.
// 출처: Uniswap v3-core `TickMath.MIN_SQRT_RATIO`·`MAX_SQRT_RATIO`, v3-periphery `QuoterV2`.
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q192 = 2n ** 192n;

// 출처: Uniswap v3-periphery `IQuoterV2`, v3-core `IUniswapV3Factory`·`IUniswapV3PoolState`, Multicall3, ERC-20.
const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);

// cold 포크의 첫 단가 읽기는 업체 RPC에서 상태를 가져와 7초 안팎이 걸린다(T-1 (9)). 예열 hook의 시간 제한만 늘린다.
const WARM_UP_TIMEOUT_MS = 120_000;

const anvilClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: 60_000, retryCount: 0 }),
});

type DirectTierQuote =
  | { status: "revert" }
  | { status: "ok"; amountOut: bigint; sqrtPriceX96After: bigint };

type DirectQuotes = Record<FeeTier, DirectTierQuote>;

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

  const response = await handleRpcProxyRequest(request, "1");
  const hasRpcError = await response
    .clone()
    .json()
    .then(containsRpcError, () => true);
  proxiedCalls.push({ items: rpcItemsOf(body), status: response.status, hasRpcError });
  return response;
}

const proxiedClient = createPublicClient({
  chain: mainnet,
  transport: http(PROXY_URL, { fetchFn: proxyFetch, timeout: 25_000, retryCount: 0 }),
});

function sameAddress(a: Address, b: Address): boolean {
  return getAddress(a) === getAddress(b);
}

function lowercaseKey(address: Address): Address {
  return address.toLowerCase() as Address;
}

function isRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError || cause instanceof ExecutionRevertedError,
    ) !== null
  );
}

// 판정과 분리한 anvil 직접 호출. 고정 포크 블록에서 QuoterV2를 티어마다 따로 호출한다.
// revert는 그 티어의 결과로 남기고, 그 밖의 실패(연결·시간 초과)는 그대로 던진다.
// 같은 호출이 견적 경로(티어별 풀 주소 포함) 상태를 포크에 올려 판정 대상 요청을 예열한다.
async function quoteEachTierDirectly(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<DirectQuotes> {
  const entries = await Promise.all(
    FEE_TIERS.map(async (fee): Promise<[FeeTier, DirectTierQuote]> => {
      try {
        const { result } = await anvilClient.simulateContract({
          address: QUOTER_V2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
          blockNumber: FORK_BLOCK,
        });
        const [amountOut, sqrtPriceX96After] = result;
        return [fee, { status: "ok", amountOut, sqrtPriceX96After }];
      } catch (error) {
        if (isRevert(error)) return [fee, { status: "revert" }];
        throw error;
      }
    }),
  );
  return Object.fromEntries(entries) as DirectQuotes;
}

// 스펙 DoD-1의 기존 티어 선택 규칙을 테스트 쪽에서 따로 적용한다.
// revert, 수령량 0, 유동성 소진(견적 후 가격이 방향별 한계값) 티어를 빼고
// 수령량이 가장 많은 티어, 같으면 수수료가 가장 낮은 티어를 고른다.
function pickExpectedTier(
  tokenIn: Address,
  tokenOut: Address,
  quotes: DirectQuotes,
): FeeTier | null {
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  const candidates = FEE_TIERS.flatMap((fee) => {
    const quote = quotes[fee];
    if (quote.status !== "ok") return [];
    if (quote.amountOut === 0n) return [];
    if (quote.sqrtPriceX96After === limit) return [];
    return [{ fee, amountOut: quote.amountOut }];
  });

  candidates.sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    return a.fee - b.fee;
  });
  return candidates[0]?.fee ?? null;
}

// 고른 티어 풀의 `slot0.sqrtPriceX96`를 직접 읽는다. 풀 주소는 Factory `getPool`로 얻는다.
async function readSlot0SqrtPriceDirectly(
  tokenA: Address,
  tokenB: Address,
  fee: FeeTier,
): Promise<bigint> {
  const pool = await anvilClient.readContract({
    address: UNISWAP_V3_FACTORY,
    abi: factoryAbi,
    functionName: "getPool",
    args: [tokenA, tokenB, fee],
    blockNumber: FORK_BLOCK,
  });
  if (sameAddress(pool, zeroAddress)) {
    throw new Error(`고른 티어 ${fee}의 풀이 없습니다: ${tokenA}/${tokenB}`);
  }
  const [sqrtPriceX96] = await anvilClient.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "slot0",
    blockNumber: FORK_BLOCK,
  });
  return sqrtPriceX96;
}

async function readDecimalsDirectly(token: Address): Promise<number> {
  return await anvilClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "decimals",
    blockNumber: FORK_BLOCK,
  });
}

// 스펙 계약의 현물가(기준 토큰 raw / 대상 토큰 raw). 대상 토큰이 token0이면 sqrtP² / 2^192, token1이면 2^192 / sqrtP².
function specSpotPrice(token: Address, quoteToken: Address, sqrtPriceX96: bigint): UsdPrice {
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  return BigInt(token) < BigInt(quoteToken)
    ? { numerator: priceX192, denominator: Q192 }
    : { numerator: Q192, denominator: priceX192 };
}

type DirectPairPrice = { quotes: DirectQuotes; fee: FeeTier | null; price: UsdPrice | null };

// 쌍 하나(토큰 1개 → 기준 토큰)의 기대 현물가를 직접 읽기로 구한다. 고를 티어가 없으면 `price`가 `null`이다.
async function readPairPriceDirectly(
  token: Address,
  quoteToken: Address,
  amountIn: bigint,
): Promise<DirectPairPrice> {
  const quotes = await quoteEachTierDirectly(token, quoteToken, amountIn);
  const fee = pickExpectedTier(token, quoteToken, quotes);
  if (fee === null) return { quotes, fee, price: null };
  const sqrtPriceX96 = await readSlot0SqrtPriceDirectly(token, quoteToken, fee);
  return { quotes, fee, price: specSpotPrice(token, quoteToken, sqrtPriceX96) };
}

// 유리수 값이 같은지 교차 곱으로 본다(제품 결과는 약분하지 않을 수 있다).
function expectSameValue(
  actual: UsdPrice | null | undefined,
  expected: UsdPrice,
  label: string,
): void {
  expect(actual, label).toBeDefined();
  expect(actual, label).not.toBeNull();
  if (actual === null || actual === undefined) return;
  expect(actual.denominator > 0n, `${label}: 분모가 0보다 크다`).toBe(true);
  expect(actual.numerator * expected.denominator, `${label}: 유리수 값이 기대값과 같다`).toBe(
    expected.numerator * actual.denominator,
  );
}

function expectAllProxiedCallsOk(): void {
  expect(proxiedCalls.length).toBeGreaterThan(0);
  for (const call of proxiedCalls) {
    const methods = call.items.map((item) => String(item.method)).join(",");
    expect(call.status, methods).toBe(200);
    expect(call.hasRpcError, methods).toBe(false);
  }
  expect(proxiedCalls.flatMap((call) => call.items.map((item) => item.method))).toContain(
    "eth_call",
  );
}

// 프록시 기록의 Multicall3 aggregate3 `eth_call`에서 QuoterV2 하위 호출의 (tokenIn, tokenOut) 쌍을 디코딩한다.
function quotedPairsInProxiedCalls(): [Address, Address][] {
  const pairs: [Address, Address][] = [];
  for (const call of proxiedCalls) {
    for (const item of call.items) {
      if (item.method !== "eth_call" || !Array.isArray(item.params)) continue;
      const tx = item.params[0] as { to?: Address; data?: Hex; input?: Hex } | undefined;
      const data = tx?.data ?? tx?.input;
      if (!tx?.to || !data || !sameAddress(tx.to, MULTICALL3)) continue;

      const decoded = decodeFunctionData({ abi: multicall3Abi, data });
      if (decoded.functionName !== "aggregate3") continue;
      for (const subcall of decoded.args[0]) {
        if (!sameAddress(subcall.target, QUOTER_V2)) continue;
        const quote = decodeFunctionData({ abi: quoterV2Abi, data: subcall.callData });
        const [params] = quote.args;
        pairs.push([params.tokenIn, params.tokenOut]);
      }
    }
  }
  return pairs;
}

describe("달러 단가 — Ethereum 포크 고정 블록에서 프록시를 거친 단가가 QuoterV2·slot0 직접 읽기로 계산한 값과 같다", () => {
  beforeEach(() => {
    vi.stubEnv("ETH_MAINNET_RPC_URL", ANVIL_URL);
    proxiedCalls = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("USDC 직접 경로가 있는 토큰", () => {
    let wethDecimals: number;
    let daiDecimals: number;
    let ethExpected: DirectPairPrice;
    let daiExpected: DirectPairPrice;

    // 판정과 분리한 anvil 직접 읽기로 기대값을 구한다. 같은 금액의 티어별 호출과 slot0 읽기가 단가 경로 상태를 포크에 올려
    // 판정 대상 요청이 프록시 상류 시간 제한(5초)을 넘어 공개 RPC로 넘어가지 않게 한다.
    beforeAll(async () => {
      await anvilClient.getCode({ address: MULTICALL3 });
      [wethDecimals, daiDecimals] = await Promise.all([
        readDecimalsDirectly(WETH),
        readDecimalsDirectly(DAI),
      ]);
      [ethExpected, daiExpected] = await Promise.all([
        readPairPriceDirectly(WETH, USDC, 10n ** BigInt(DECIMALS_18)),
        readPairPriceDirectly(DAI, USDC, 10n ** BigInt(DECIMALS_18)),
      ]);
    }, WARM_UP_TIMEOUT_MS);

    /**
     * @spec DoD-5
     * @given 프록시의 Ethereum 대상이 상수로 고정한 포크 블록의 anvil 포크로 맞춰져 있고 단가 읽기의 RPC 요청은 프록시 핸들러를 거친다. 표본은 ETH(`NATIVE_ETH_ADDRESS`)와 사전 확인 T-1 (2)에서 고른 WETH가 아닌 USDC 직접 경로 ERC-20 토큰 하나다. 기대 단가는 판정과 분리한 anvil 직접 읽기로 구한다: 대상 토큰(ETH는 WETH 주소) 1개(10^decimals)를 체인 네이티브 USDC로 QuoterV2 티어 100·500·3000·10000별로 직접 호출해 테스트 쪽 규칙으로 티어를 고르고(표본마다 후보 티어가 있음을 확인), 그 티어 풀의 `slot0.sqrtPriceX96`로 현물가(USDC raw / 대상 토큰 raw)를 계산한다
     * @when 두 표본 주소로 프록시를 거쳐 Ethereum 단가를 읽는다
     * @then 결과 맵에서 각 표본의 소문자 주소 키의 단가가 `null`이 아니고, 그 유리수 값이 직접 읽기로 계산한 현물가와 같다
     * @then 단가 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답한다
     */
    it("[DoD-5] ETH와 USDC 직접 경로 토큰의 단가가 QuoterV2·slot0 직접 읽기로 계산한 값과 같다", async () => {
      // 전제: 표본 토큰의 소수 자릿수가 18(토큰 1개 = 10^18)이고, 두 표본 모두 USDC 직접 경로 후보 티어가 있다.
      expect(wethDecimals, "WETH decimals").toBe(DECIMALS_18);
      expect(daiDecimals, "DAI decimals").toBe(DECIMALS_18);
      expect(ethExpected.price, "ETH(WETH)의 USDC 후보 티어").not.toBeNull();
      expect(daiExpected.price, "DAI의 USDC 후보 티어").not.toBeNull();
      if (ethExpected.price === null || daiExpected.price === null) return;

      // RPC 실패라면 읽기가 throw해 여기서 테스트가 실패한다.
      const prices = await readTokenUsdPrices(proxiedClient, {
        chainId: 1,
        tokens: [NATIVE_ETH_ADDRESS, DAI],
      });

      // 넘긴 소문자 주소 키의 단가가 직접 읽기로 계산한 현물가와 같다.
      expectSameValue(prices.get(lowercaseKey(NATIVE_ETH_ADDRESS)), ethExpected.price, "ETH");
      expectSameValue(prices.get(lowercaseKey(DAI)), daiExpected.price, "DAI");

      // 단가 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답했다.
      expectAllProxiedCallsOk();
    });
  });

  describe("WETH 경유만 가능한 토큰", () => {
    let api3Decimals: number;
    let kncDecimals: number;
    let api3Direct: DirectPairPrice;
    let kncDirect: DirectPairPrice;
    let api3ToWeth: DirectPairPrice;
    let kncToWeth: DirectPairPrice;
    let wethToUsdc: DirectPairPrice;

    // 판정과 분리한 anvil 직접 읽기로 전제와 두 구간 기대값을 구하고, 1차(USDC)·2차(WETH, WETH→USDC) 경로를 예열한다.
    beforeAll(async () => {
      await anvilClient.getCode({ address: MULTICALL3 });
      [api3Decimals, kncDecimals] = await Promise.all([
        readDecimalsDirectly(API3),
        readDecimalsDirectly(KNC),
      ]);
      const oneToken = 10n ** BigInt(DECIMALS_18);
      [api3Direct, kncDirect, api3ToWeth, kncToWeth, wethToUsdc] = await Promise.all([
        readPairPriceDirectly(API3, USDC, oneToken),
        readPairPriceDirectly(KNC, USDC, oneToken),
        readPairPriceDirectly(API3, WETH, oneToken),
        readPairPriceDirectly(KNC, WETH, oneToken),
        // WETH 1개(10^18) → USDC 구간.
        readPairPriceDirectly(WETH, USDC, 10n ** 18n),
      ]);
    }, WARM_UP_TIMEOUT_MS);

    /**
     * @spec DoD-6
     * @given 프록시의 Ethereum 대상이 상수로 고정한 포크 블록의 anvil 포크로 맞춰져 있고 단가 읽기의 RPC 요청은 프록시 핸들러를 거친다. 표본은 사전 확인 T-1 (2)에서 고른 토큰으로 WETH 대비 token0인 토큰과 token1인 토큰이며, 판정과 분리한 anvil 직접 호출로 각 토큰의 USDC 네 티어가 모두 후보에서 빠지고 WETH 후보 티어가 있음을 확인해 둔다. 기대 단가는 직접 읽기로 구한다: 토큰 1개(10^decimals)→WETH 구간과 WETH 1개(10^18)→USDC 구간 각각 QuoterV2 티어별 직접 호출로 테스트 쪽 규칙에 따라 티어를 고르고, 고른 티어 풀 `slot0.sqrtPriceX96`로 구한 두 구간 현물가를 곱한다
     * @when 두 표본 주소로 프록시를 거쳐 Ethereum 단가를 읽는다
     * @then 결과 맵에서 각 표본의 소문자 주소 키의 단가가 `null`이 아니고, 그 유리수 값이 직접 읽기로 계산한 토큰→WETH 현물가 × WETH→USDC 현물가와 같다
     * @then 단가 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답한다
     */
    it("[DoD-6] WETH 경유만 가능한 토큰의 단가가 두 구간 직접 읽기로 계산한 값과 같다", async () => {
      // 전제: 소수 자릿수 18, API3는 WETH 대비 token0·KNC는 token1(주소 수치 비교),
      // 두 토큰 모두 USDC 네 티어가 후보에서 빠지고 WETH 후보 티어가 있으며, WETH→USDC 후보 티어가 있다.
      expect(api3Decimals, "API3 decimals").toBe(DECIMALS_18);
      expect(kncDecimals, "KNC decimals").toBe(DECIMALS_18);
      expect(BigInt(API3) < BigInt(WETH), "API3는 WETH 대비 token0").toBe(true);
      expect(BigInt(KNC) > BigInt(WETH), "KNC는 WETH 대비 token1").toBe(true);
      expect(api3Direct.fee, "API3의 USDC 후보 티어 없음").toBeNull();
      expect(kncDirect.fee, "KNC의 USDC 후보 티어 없음").toBeNull();
      expect(api3ToWeth.price, "API3의 WETH 후보 티어").not.toBeNull();
      expect(kncToWeth.price, "KNC의 WETH 후보 티어").not.toBeNull();
      expect(wethToUsdc.price, "WETH의 USDC 후보 티어").not.toBeNull();
      if (api3ToWeth.price === null || kncToWeth.price === null || wethToUsdc.price === null)
        return;

      // 기대 단가 = 토큰→WETH 현물가 × WETH→USDC 현물가(테스트 쪽 유리수 곱).
      const routed = (tokenToWeth: UsdPrice, wethToUsdcPrice: UsdPrice): UsdPrice => ({
        numerator: tokenToWeth.numerator * wethToUsdcPrice.numerator,
        denominator: tokenToWeth.denominator * wethToUsdcPrice.denominator,
      });

      const prices = await readTokenUsdPrices(proxiedClient, { chainId: 1, tokens: [API3, KNC] });

      expectSameValue(
        prices.get(lowercaseKey(API3)),
        routed(api3ToWeth.price, wethToUsdc.price),
        "API3",
      );
      expectSameValue(
        prices.get(lowercaseKey(KNC)),
        routed(kncToWeth.price, wethToUsdc.price),
        "KNC",
      );

      // 단가 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답했다.
      expectAllProxiedCallsOk();
    });
  });

  describe("USDC·WETH 풀이 모두 없는 토큰", () => {
    let solvDecimals: number;
    let solvToUsdc: DirectPairPrice;
    let solvToWeth: DirectPairPrice;

    // 판정과 분리한 anvil 직접 읽기로 두 경로 모두 후보 티어가 없음을 확인할 견적을 읽고, 두 경로를 예열한다.
    beforeAll(async () => {
      await anvilClient.getCode({ address: MULTICALL3 });
      solvDecimals = await readDecimalsDirectly(SOLV);
      const oneToken = 10n ** BigInt(DECIMALS_18);
      [solvToUsdc, solvToWeth] = await Promise.all([
        readPairPriceDirectly(SOLV, USDC, oneToken),
        readPairPriceDirectly(SOLV, WETH, oneToken),
      ]);
      // WETH→USDC 구간도 2차 요청에 실리므로 예열한다.
      await quoteEachTierDirectly(WETH, USDC, 10n ** 18n);
    }, WARM_UP_TIMEOUT_MS);

    /**
     * @spec EC-18
     * @given 프록시의 Ethereum 대상이 상수로 고정한 포크 블록의 anvil 포크로 맞춰져 있고 단가 읽기의 RPC 요청은 프록시 핸들러를 거친다. 표본은 Ethereum 앱 토큰 목록(`config/tokens-1.json` 기반 목록)에 있는 토큰으로 사전 확인 T-1 (3)에서 고른 토큰이며, 판정과 분리한 anvil 직접 호출로 그 토큰 1개(10^decimals)의 USDC 네 티어와 WETH 네 티어 견적이 모두 후보에서 빠짐을 확인해 둔다
     * @when 그 토큰 주소로 프록시를 거쳐 Ethereum 단가를 읽는다
     * @then 단가 읽기가 실패(throw)하지 않고 결과 맵에서 그 토큰의 소문자 주소 키의 값이 `null`이다
     * @then 단가 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답해 RPC 실패가 아님이 드러난다
     * @then 프록시 `fetchFn` 기록에 그 토큰의 (토큰, USDC) 쌍과 (토큰, WETH) 쌍이 담긴 단가 요청이 있어, 목록 밖 주소로 걸러져 요청 없이 `null`이 된 것이 아님이 드러난다
     */
    it("[EC-18] USDC·WETH 풀이 모두 없는 토큰의 단가 결과는 null이다", async () => {
      // 전제: 표본이 Ethereum 앱 토큰 목록에 있고(목록 밖 주소 필터가 아님), 소수 자릿수 18이며,
      // 토큰 1개의 USDC 네 티어와 WETH 네 티어 견적이 모두 후보에서 빠진다.
      expect(
        TOKENS_BY_CHAIN[1].some((token) => sameAddress(token.address, SOLV)),
        "SOLV가 Ethereum 토큰 목록에 있다",
      ).toBe(true);
      expect(solvDecimals, "SOLV decimals").toBe(DECIMALS_18);
      expect(solvToUsdc.fee, "SOLV의 USDC 후보 티어 없음").toBeNull();
      expect(solvToWeth.fee, "SOLV의 WETH 후보 티어 없음").toBeNull();

      // RPC 실패라면 읽기가 throw해 여기서 테스트가 실패한다.
      const prices = await readTokenUsdPrices(proxiedClient, { chainId: 1, tokens: [SOLV] });

      // 그 토큰의 소문자 주소 키가 있고 값이 `null`이다.
      expect(prices.has(lowercaseKey(SOLV)), "결과 맵에 SOLV 키가 있다").toBe(true);
      expect(prices.get(lowercaseKey(SOLV))).toBeNull();

      // 단가 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답해 RPC 실패가 아니다.
      expectAllProxiedCallsOk();

      // 프록시 기록에 (SOLV, USDC)·(SOLV, WETH) 쌍의 QuoterV2 하위 호출이 담긴 단가 요청이 있다.
      const pairs = quotedPairsInProxiedCalls();
      const hasPair = (tokenIn: Address, tokenOut: Address) =>
        pairs.some(
          ([pairIn, pairOut]) => sameAddress(pairIn, tokenIn) && sameAddress(pairOut, tokenOut),
        );
      expect(hasPair(SOLV, USDC), "(SOLV, USDC) 단가 요청").toBe(true);
      expect(hasPair(SOLV, WETH), "(SOLV, WETH) 단가 요청").toBe(true);
    });
  });
});
