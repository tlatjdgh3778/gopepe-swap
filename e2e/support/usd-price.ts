import type { BrowserContext, Locator, Page, Request } from "@playwright/test";

import { type Address, type Hex, decodeFunctionData, parseAbi, toFunctionSelector } from "viem";

import {
  DIRECT_QUOTE_FEE_TIERS,
  type DirectQuoteFeeTier,
  type DirectTierQuotes,
  type DirectTierSlot0s,
  QUOTER_V2_ADDRESS,
} from "./anvil";
import { type SwapSide, tokenOption } from "./swap-form";

// ─── locator (F9 스펙 §4.4 식별자) ─────────────────────────────────

// 보내는·받는 칸 금액 아래의 USD 행.
export function usdValue(page: Page, side: SwapSide): Locator {
  return page.locator(`[data-testid="usd-value"][data-side="${side}"]`);
}

// 칸 카드 잔액의 USD. 표시할 때만 있다.
export function cardBalanceUsd(page: Page, side: SwapSide): Locator {
  return page
    .locator(`[data-testid="token-field"][data-side="${side}"]`)
    .getByTestId("balance-usd");
}

// 토큰 모달 행의 잔액 USD. 표시할 때만 있다.
export function tokenOptionUsd(page: Page, side: SwapSide, address: Address): Locator {
  return tokenOption(page, side, address).getByTestId("token-option-usd");
}

// `data-usd-micros`는 `toUsdMicros` 결과의 10진 문자열이다(F9 스펙 §4.4).
export const USD_MICROS_PATTERN = /^\d+$/;

// ─── 러너 쪽 기대 단가·micros 계산 (제품 함수를 쓰지 않는다) ─────────

// 토큰 raw 1단위당 USD. usdMicros = amountRaw × numerator / denominator (USDC raw 6자리 단위). F9 스펙 §4.1과 같은 뜻.
export type RunnerUsdPrice = { numerator: bigint; denominator: bigint };

// 체인 네이티브 USDC의 단가는 정확히 $1이다(F9 DoD-3).
export const RUNNER_USDC_USD_PRICE: RunnerUsdPrice = { numerator: 1n, denominator: 1n };

// QuoterV2가 `sqrtPriceLimitX96 = 0`일 때 쓰는 방향별 한계값.
// 출처: Uniswap v3-core `TickMath.MIN_SQRT_RATIO`·`MAX_SQRT_RATIO`, v3-periphery `QuoterV2`.
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const Q192 = 1n << 192n;

export type RunnerPickedTier = { fee: DirectQuoteFeeTier; amountOut: bigint };

// F3 스펙 DoD-2·DoD-3·§5.1의 티어 선택 규칙(F9 DoD-1이 그대로 쓴다)을 테스트 쪽에서 따로 적용한다.
// revert, 수령량 0, 유동성 소진(견적 후 가격이 방향별 한계값) 티어를 빼고
// 수령량이 가장 많은 티어, 같으면 수수료가 가장 낮은 티어를 고른다. 후보가 없으면 null이다.
export function pickRunnerFeeTier(
  tokenIn: Address,
  tokenOut: Address,
  quotes: DirectTierQuotes,
): RunnerPickedTier | null {
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  const candidates = DIRECT_QUOTE_FEE_TIERS.flatMap((fee) => {
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

// 고른 티어 풀의 `slot0.sqrtPriceX96`로 만든 현물가(기준 토큰 raw / 대상 토큰 raw).
// 대상 토큰이 token0(주소가 작은 쪽)이면 sqrtP²/2^192, token1이면 2^192/sqrtP²다.
export function runnerSpotPrice(
  token: Address,
  quoteToken: Address,
  sqrtPriceX96: bigint,
): RunnerUsdPrice {
  const squared = sqrtPriceX96 * sqrtPriceX96;
  return BigInt(token) < BigInt(quoteToken)
    ? { numerator: squared, denominator: Q192 }
    : { numerator: Q192, denominator: squared };
}

// USDC 직접 경로 단가(F9 DoD-1). 토큰 1개(10^decimals)를 USDC로 티어별 견적한 결과로 티어를 고르고,
// 그 티어 풀의 `slot0` 현물가를 쓴다. 고를 티어가 없으면 null, 고른 티어에 풀이 없으면 던진다.
export function runnerDirectUsdPrice(
  token: Address,
  usdc: Address,
  oneTokenQuotes: DirectTierQuotes,
  slot0s: DirectTierSlot0s,
): RunnerUsdPrice | null {
  const picked = pickRunnerFeeTier(token, usdc, oneTokenQuotes);
  if (picked === null) return null;
  const slot0 = slot0s[picked.fee];
  if (slot0.status !== "ok") {
    throw new Error(`[e2e] 러너가 고른 티어 ${picked.fee}의 풀을 anvil에서 찾지 못했다`);
  }
  return runnerSpotPrice(token, usdc, slot0.sqrtPriceX96);
}

// amountRaw × numerator / denominator 버림(F9 DoD-10과 같은 뜻의 테스트 쪽 계산).
export function runnerUsdMicros(amountRaw: bigint, price: RunnerUsdPrice): bigint {
  return (amountRaw * price.numerator) / price.denominator;
}

// ─── 단가 요청 감시 (가로채지 않는다) ─────────────────────────────

// 출처: Multicall3 `aggregate3`.
const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

// 출처: Uniswap v3-periphery `IQuoterV2.quoteExactInputSingle`.
const QUOTE_EXACT_INPUT_SINGLE_SELECTOR = toFunctionSelector(
  "quoteExactInputSingle((address,address,uint256,uint24,uint160))",
);

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// F9 단가 aggregate3(F9 스펙 §4.5): Multicall3 `aggregate3`의 첫 하위 호출이 QuoterV2 `quoteExactInputSingle`이다
// (쌍마다 견적 4건 → slot0 4건). 견적 aggregate3는 첫 하위 호출이 풀 `slot0`이라 걸리지 않는다.
function isUsdPriceAggregate3Item(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  if ((item as { method?: unknown }).method !== "eth_call") return false;
  const params = (item as { params?: unknown }).params;
  if (!Array.isArray(params)) return false;
  const call = params[0];
  if (typeof call !== "object" || call === null) return false;
  const { data, input } = call as { data?: unknown; input?: unknown };
  const callData = typeof data === "string" ? data : typeof input === "string" ? input : null;
  if (callData === null) return false;
  try {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: callData as Hex });
    const first = args[0][0];
    return (
      first !== undefined &&
      first.target.toLowerCase() === QUOTER_V2_ADDRESS.toLowerCase() &&
      first.callData.slice(0, 10).toLowerCase() === QUOTE_EXACT_INPUT_SINGLE_SELECTOR
    );
  } catch {
    return false;
  }
}

function containsUsdPriceAggregate3(text: string | null | undefined): boolean {
  const body = parseJson(text);
  const items = Array.isArray(body) ? body : [body];
  return items.some(isUsdPriceAggregate3Item);
}

export type ObservedUsdPriceRequest = {
  channel: "http" | "websocket";
  // HTTP 메서드. websocket 프레임이면 null이다.
  method: string | null;
  // 업체 URL의 경로·쿼리에 키가 있을 수 있어 출처와 경로만 남긴다.
  origin: string;
  pathname: string;
  // HTTP 요청이면 응답 완료를 기다릴 때 쓴다.
  request: Request | null;
};

// 브라우저 컨텍스트가 보낸 단가 aggregate3 요청을 대상 URL과 무관하게 가로채지 않고 기록한다.
// 페이지 이동 전에 시작해야 전체 구간을 본다.
export function watchUsdPriceRequests(context: BrowserContext, page: Page) {
  const requests: ObservedUsdPriceRequest[] = [];

  context.on("request", (request) => {
    if (!containsUsdPriceAggregate3(request.postData())) return;
    const target = new URL(request.url());
    requests.push({
      channel: "http",
      method: request.method(),
      origin: target.origin,
      pathname: target.pathname,
      request,
    });
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string" || !containsUsdPriceAggregate3(payload)) return;
      const target = new URL(socket.url());
      requests.push({
        channel: "websocket",
        method: null,
        origin: target.origin,
        pathname: target.pathname,
        request: null,
      });
    });
  });

  return {
    requests,
    // 기대 경로(앱 출처의 `POST <pathname>`)가 아닌 단가 요청.
    notTo(appOrigin: string, pathname: string): ObservedUsdPriceRequest[] {
      return requests.filter(
        (observed) =>
          observed.channel !== "http" ||
          observed.method !== "POST" ||
          observed.origin !== appOrigin ||
          observed.pathname !== pathname,
      );
    },
  };
}
