import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  createPublicClient,
  getAddress,
  http,
  parseAbi,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FORK_BLOCK_NUMBER, FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "@/config/tokens";
import { readSwapQuote } from "@/lib/read-swap-quote";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";
import { planSwapQuote } from "@/lib/swap-quote";

// global-setup.ts가 전용 포트(8547)에 띄운 Ethereum anvil 포크(상수로 고정한 포크 블록)에서 읽기 전용으로 검증한다.
// 판정 대상 견적 읽기는 viem `http` transport의 `fetchFn`을 프록시 핸들러에 연결해 보내고,
// 기대값과 전제 확인은 판정과 분리한 anvil 직접 읽기로 얻는다.
const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;
const FORK_BLOCK = BigInt(FORK_BLOCK_NUMBER);

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;
const PROXY_URL = `${SAME_SITE_ORIGIN}/api/rpc/1`;

// Ethereum 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
const QUOTER_V2: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
// EC-4 표본: T-1 (1)에서 포크 블록 26250000 기준 네 티어 모두 `getPool`이 0 주소이고 견적이 revert한 페어.
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const PENDLE: Address = "0x808507121B80c02388fAd14726482e061B8da827";

// 견적 금액. 두 표본 모두 보내는 토큰의 소수 자릿수가 18이므로 1 단위다.
const ONE_UNIT_18 = 1_000_000_000_000_000_000n;

// 스펙 DoD-1의 네 수수료 티어. 낮은 수수료 순.
const FEE_TIERS = [100, 500, 3000, 10000] as const;
type FeeTier = (typeof FEE_TIERS)[number];

// QuoterV2가 `sqrtPriceLimitX96 = 0`일 때 쓰는 방향별 한계값.
// 출처: Uniswap v3-core `TickMath.MIN_SQRT_RATIO`·`MAX_SQRT_RATIO`, v3-periphery `QuoterV2`.
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// 출처: Uniswap v3-periphery `IQuoterV2.quoteExactInputSingle`.
const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// cold 포크의 첫 견적은 업체 RPC에서 상태를 가져와 6~7초가 걸린다(T-1). 예열 hook의 시간 제한만 늘린다.
const WARM_UP_TIMEOUT_MS = 120_000;

const anvilClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: 60_000, retryCount: 0 }),
});

type DirectTierQuote =
  | { status: "revert" }
  | { status: "ok"; amountOut: bigint; sqrtPriceX96After: bigint };

type DirectQuotes = Record<FeeTier, DirectTierQuote>;

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

const proxiedClient = createPublicClient({
  chain: mainnet,
  transport: http(PROXY_URL, { fetchFn: proxyFetch, timeout: 25_000, retryCount: 0 }),
});

function sameAddress(a: Address, b: Address): boolean {
  return getAddress(a) === getAddress(b);
}

function findEthereumToken(address: Address) {
  const token = TOKENS_BY_CHAIN[1].find((candidate) => sameAddress(candidate.address, address));
  if (!token) throw new Error(`Ethereum 토큰 목록에 ${address}가 없습니다.`);
  return token;
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

// 스펙 §5.1·DoD-2·DoD-3 규칙을 테스트 쪽에서 따로 적용한다.
// revert(EC-1), 수령량 0(EC-2), 유동성 소진(EC-3, 견적 후 가격이 방향별 한계값) 티어를 빼고
// 수령량이 가장 많은 티어, 같으면 수수료가 가장 낮은 티어를 고른다.
function pickExpectedTier(
  tokenIn: Address,
  tokenOut: Address,
  quotes: DirectQuotes,
): { fee: FeeTier; amountOut: bigint } | null {
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
  return candidates[0] ?? null;
}

describe("스왑 견적 — Ethereum 포크 고정 블록에서 QuoterV2 견적으로 수수료 티어와 예상 수령량을 고른다", () => {
  beforeEach(() => {
    vi.stubEnv("ETH_MAINNET_RPC_URL", ANVIL_URL);
    proxiedCalls = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("직접 풀이 있는 페어(ETH→USDC)를 견적할 때", () => {
    let directQuotes: DirectQuotes;
    let expected: { fee: FeeTier; amountOut: bigint } | null;

    // 판정과 분리한 anvil 직접 읽기로 기대값을 고른다. 같은 금액의 티어별 호출이 견적 경로 상태를 포크에 올려
    // 판정 대상 요청이 프록시 상류 시간 제한(5초)을 넘어 공개 RPC로 넘어가지 않게 한다.
    beforeAll(async () => {
      await anvilClient.getCode({ address: MULTICALL3 });
      directQuotes = await quoteEachTierDirectly(WETH, USDC, ONE_UNIT_18);
      expected = pickExpectedTier(WETH, USDC, directQuotes);
    }, WARM_UP_TIMEOUT_MS);

    /**
     * @spec DoD-5
     * @given 프록시의 Ethereum 대상이 상수로 고정한 포크 블록의 anvil 포크로 맞춰져 있고, 견적 읽기의 RPC 요청은 같은 사이트 `POST /api/rpc/1` 요청이 되어 프록시 핸들러를 거치며, 기대 티어와 수령량은 판정과 분리해 anvil에 QuoterV2를 티어 100·500·3000·10000별로 직접 호출한 결과에서 후보 제외(풀 없음 revert, 수령량 0, 유동성 소진) 뒤 수령량이 가장 많고 같으면 수수료가 가장 낮은 티어로 골라 둔다
     * @when 보내는 토큰 ETH, 받는 토큰 USDC, 0보다 큰 금액으로 프록시를 거쳐 견적을 읽는다
     * @then 견적 결과가 성공이고 고른 수수료 티어가 직접 호출로 고른 티어와 같다
     * @then 예상 수령량이 직접 호출로 고른 티어의 수령량과 같다
     * @then 견적 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답한다
     * @then 수령량이 고정한 포크 블록에서 직접 호출한 값과 같아 공개 RPC로 넘어간 응답이 아님이 드러난다
     */
    it("[DoD-5] ETH→USDC 견적의 티어와 수령량이 티어별 직접 호출로 고른 값과 같다", async () => {
      // 전제: 직접 호출에서 고를 티어가 있고, 포크의 최신 블록이 고정한 포크 블록이다.
      expect(expected).not.toBeNull();
      expect(await anvilClient.getBlockNumber()).toBe(FORK_BLOCK);

      const plan = planSwapQuote({
        chainId: 1,
        tokenIn: findEthereumToken(NATIVE_ETH_ADDRESS),
        tokenOut: findEthereumToken(USDC),
        amountInRaw: ONE_UNIT_18,
      });
      if (plan.status !== "quote") throw new Error(`견적할 요청이 아닙니다: ${plan.status}`);

      const result = await readSwapQuote(proxiedClient, plan.request);

      // 견적 결과가 성공이고 고른 티어가 직접 호출로 고른 티어와 같다.
      expect(result.status).toBe("success");
      expect(result.quote?.fee).toBe(expected?.fee);

      // 예상 수령량이 직접 호출로 고른 티어의 수령량과 같다.
      expect(result.quote?.amountOut).toBe(expected?.amountOut);

      // RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답했다.
      expect(proxiedCalls.length).toBeGreaterThan(0);
      for (const call of proxiedCalls) {
        expect(call.status, call.methods.join(",")).toBe(200);
        expect(call.hasRpcError, call.methods.join(",")).toBe(false);
      }
      expect(proxiedCalls.flatMap((call) => call.methods)).toContain("eth_call");

      // 고정 포크 블록의 직접 호출 값과 같다. 공개 RPC(메인넷 최신 블록)로 넘어갔다면 수령량이 달라진다.
      const selectedTier = result.quote ? directQuotes[result.quote.fee] : undefined;
      expect(selectedTier?.status).toBe("ok");
      expect(result.quote?.amountOut).toBe(
        selectedTier?.status === "ok" ? selectedTier.amountOut : undefined,
      );
    });
  });

  describe("직접 풀이 없는 페어를 견적할 때", () => {
    let directQuotes: DirectQuotes;

    // 판정과 분리한 anvil 직접 읽기로 표본 전제(네 티어 모두 revert)를 확인할 값을 얻고 견적 경로 상태를 예열한다.
    beforeAll(async () => {
      await anvilClient.getCode({ address: MULTICALL3 });
      directQuotes = await quoteEachTierDirectly(DAI, PENDLE, ONE_UNIT_18);
    }, WARM_UP_TIMEOUT_MS);

    /**
     * @spec EC-4
     * @given 프록시의 Ethereum 대상이 상수로 고정한 포크 블록의 anvil 포크로 맞춰져 있고, 견적할 페어는 사전 확인 T-1에서 확인한 네 티어 모두 풀이 없는 페어이며, 판정과 분리한 anvil 직접 호출에서 이 페어의 QuoterV2 견적이 티어 100·500·3000·10000 모두 revert함을 확인해 둔다
     * @when 그 페어와 0보다 큰 금액으로 프록시를 거쳐 견적을 읽는다
     * @then 남은 후보가 없어 견적 결과가 `no-route`다
     * @then 고른 티어와 수령량이 없다
     * @then 견적 읽기의 RPC 요청이 프록시 핸들러를 거쳐 정상 응답해 RPC 실패(`error`)가 아님이 드러난다
     */
    it("[EC-4] 네 티어 모두 풀이 없는 페어의 견적은 no-route다", async () => {
      // 표본 전제: 직접 호출에서 네 티어 모두 revert한다.
      for (const fee of FEE_TIERS) {
        expect(directQuotes[fee].status, String(fee)).toBe("revert");
      }

      const plan = planSwapQuote({
        chainId: 1,
        tokenIn: findEthereumToken(DAI),
        tokenOut: findEthereumToken(PENDLE),
        amountInRaw: ONE_UNIT_18,
      });
      if (plan.status !== "quote") throw new Error(`견적할 요청이 아닙니다: ${plan.status}`);

      // RPC 실패라면 읽기가 throw해(견적 상태 `error`) 여기서 테스트가 실패한다.
      const result = await readSwapQuote(proxiedClient, plan.request);

      // 남은 후보가 없어 `no-route`다.
      expect(result.status).toBe("no-route");

      // 고른 티어와 수령량이 없다.
      expect(result.quote).toBeNull();

      // RPC 요청이 프록시 핸들러를 거쳐 정상 응답했다.
      expect(proxiedCalls.length).toBeGreaterThan(0);
      for (const call of proxiedCalls) {
        expect(call.status, call.methods.join(",")).toBe(200);
        expect(call.hasRpcError, call.methods.join(",")).toBe(false);
      }
      expect(proxiedCalls.flatMap((call) => call.methods)).toContain("eth_call");
    });
  });
});
