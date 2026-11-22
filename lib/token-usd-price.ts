import type { Address } from "viem";

import type { SupportedChainId } from "@/config/chains";

import { USDC_BY_CHAIN } from "@/config/tokens";
import {
  type FeeTierQuoteResults,
  type PoolSlot0Results,
  isZeroForOne,
  selectFeeTier,
} from "@/lib/swap-quote";

// 단가 계산과 USD 표기는 로캘 API와 number 변환 없이 bigint와 문자열 연산으로만 한다(DoD-15).

// ─── 타입(F9 스펙 §4.1) ─────────────────────────────────────────────

/** 토큰 raw 1단위당 USD. usdMicros = amountRaw × numerator / denominator (USDC raw 6자리 단위) */
export type UsdPrice = { numerator: bigint; denominator: bigint };

export type TokenUsdPriceState =
  | { status: "idle" } // 토큰 미선택
  | { status: "loading" } // 첫 조회 중
  | { status: "success"; price: UsdPrice } // 갱신 실패여도 이전 값이 있으면 success
  | { status: "no-price" } // 직접·WETH 경유 모두 경로 없음
  | { status: "error" }; // 조회 실패, 이전 값 없음

// ─── 환산과 표기 ───────────────────────────────────────────────────

/**
 * 금액 raw의 USD micros(USDC raw 6자리 단위). `amountRaw × numerator / denominator`를 버림한다(DoD-10).
 * 곱한 뒤 나누므로 큰 금액에서도 정밀도 손실이 없다(EC-25). `amountRaw`는 0 이상이다.
 */
export function toUsdMicros(amountRaw: bigint, price: UsdPrice): bigint {
  return (amountRaw * price.numerator) / price.denominator;
}

const USD_MICROS_PER_CENT = 10_000n;
const CENTS_PER_DOLLAR = 100n;
const USD_ZERO_LABEL = "$0.00";
const USD_MIN_LABEL = "<$0.01";

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * USD 표시 문자열. 소수 2자리까지 버리고 천 단위는 쉼표, 축약 없이 모든 자리를 적는다(DoD-11, DoD-14).
 * 0이면 `$0.00`(DoD-13), 0보다 크고 $0.01보다 작으면 `<$0.01`(DoD-12)이다. `usdMicros`는 0 이상이다.
 */
export function formatUsd(usdMicros: bigint): string {
  if (usdMicros < 0n) {
    throw new RangeError("USD 표기는 0 이상의 값만 받습니다.");
  }
  if (usdMicros === 0n) return USD_ZERO_LABEL;

  const cents = usdMicros / USD_MICROS_PER_CENT;
  if (cents === 0n) return USD_MIN_LABEL;

  const dollars = groupThousands((cents / CENTS_PER_DOLLAR).toString());
  const fraction = (cents % CENTS_PER_DOLLAR).toString().padStart(2, "0");
  return `$${dollars}.${fraction}`;
}

// ─── 단가 ─────────────────────────────────────────────────────────

/** 체인 네이티브 USDC의 단가. USDC raw 1단위 = USD micros 1이므로 정확히 $1이다(DoD-3). */
export const USDC_USD_PRICE: UsdPrice = { numerator: 1n, denominator: 1n };

/**
 * 토큰이 선택 체인의 네이티브 USDC이면 참이다(주소 대소문자 무관). 브리지 USDC는 거짓이다(EC-14).
 */
export function isChainUsdc(chainId: SupportedChainId, token: Address): boolean {
  return token.toLowerCase() === USDC_BY_CHAIN[chainId].toLowerCase();
}

const Q192 = 1n << 192n;

export type SpotPriceParams = {
  // 단가를 구할 토큰(B). WETH 치환 후 주소.
  token: Address;
  // 기준 토큰(Q). USDC 또는 WETH.
  quoteToken: Address;
  // 두 토큰 풀의 `slot0.sqrtPriceX96`. 0보다 크다.
  sqrtPriceX96: bigint;
};

/**
 * 풀 `slot0` 현물가를 `Q raw / B raw` 유리수로 만든다.
 * 토큰 B가 token0이면 `{ sqrtPriceX96², 2^192 }`, token1이면 `{ 2^192, sqrtPriceX96² }`다.
 * token0·token1은 주소를 수치로 비교해 정한다(`sortTokens`와 같은 규칙).
 */
export function spotPriceFromSqrtPriceX96({
  token,
  quoteToken,
  sqrtPriceX96,
}: SpotPriceParams): UsdPrice {
  if (sqrtPriceX96 <= 0n) {
    throw new RangeError("현물가는 sqrtPriceX96가 0보다 커야 계산할 수 있습니다.");
  }
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  return isZeroForOne(token, quoteToken)
    ? { numerator: priceX192, denominator: Q192 }
    : { numerator: Q192, denominator: priceX192 };
}

/**
 * 두 유리수 가격의 곱(분자끼리·분모끼리). 약분하지 않는다.
 * WETH 경유 단가는 `토큰→WETH 현물가 × WETH→USDC 현물가`다(DoD-2).
 */
export function multiplyPrices(a: UsdPrice, b: UsdPrice): UsdPrice {
  return { numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator };
}

// ─── 견적·slot0 결합 ───────────────────────────────────────────────

export type PairPriceInput = {
  // 단가를 구할 토큰(B). WETH 치환 후 주소. 견적의 tokenIn이다.
  token: Address;
  // 기준 토큰(Q). USDC 또는 WETH. 견적의 tokenOut이다.
  quoteToken: Address;
  // 토큰 1개(10^decimals)를 기준 토큰으로 견적한 네 티어 결과.
  quotes: FeeTierQuoteResults;
  // 네 티어 풀의 `slot0` 결과.
  slot0: PoolSlot0Results;
};

/**
 * 쌍 하나(토큰 → 기준 토큰)의 현물가. 기존 티어 선택 규칙(`selectFeeTier`)으로 고른 티어 풀의 `slot0` 현물가다(DoD-1).
 * 고를 티어가 없으면(모든 티어 revert·수령량 0·유동성 소진) `null`이다(EC-16).
 * 고른 티어의 `slot0` 읽기가 실패했으면 throw한다(EC-17).
 */
export function selectPairSpotPrice({
  token,
  quoteToken,
  quotes,
  slot0,
}: PairPriceInput): UsdPrice | null {
  const selected = selectFeeTier({ tokenIn: token, tokenOut: quoteToken, quotes });
  if (selected === null) return null;

  const selectedSlot0 = slot0[selected.fee];
  if (selectedSlot0.status !== "ok") {
    throw new Error(`고른 수수료 티어 ${selected.fee} 풀의 slot0을 읽지 못했습니다.`);
  }

  return spotPriceFromSqrtPriceX96({
    token,
    quoteToken,
    sqrtPriceX96: selectedSlot0.sqrtPriceX96,
  });
}

export type WethRoutedPriceInput = {
  // 토큰 → WETH 구간.
  tokenToWeth: PairPriceInput;
  // WETH → USDC 구간.
  wethToUsdc: PairPriceInput;
};

/**
 * WETH 경유 단가. 각 구간의 티어를 따로 골라 `토큰→WETH 현물가 × WETH→USDC 현물가`를 낸다(DoD-2).
 * 어느 한 구간이라도 고를 티어가 없으면 `null`이다(EC-16, EC-26).
 * 고른 티어의 `slot0` 읽기가 실패했으면 throw한다.
 */
export function selectWethRoutedPrice({
  tokenToWeth,
  wethToUsdc,
}: WethRoutedPriceInput): UsdPrice | null {
  const tokenToWethPrice = selectPairSpotPrice(tokenToWeth);
  if (tokenToWethPrice === null) return null;

  const wethToUsdcPrice = selectPairSpotPrice(wethToUsdc);
  if (wethToUsdcPrice === null) return null;

  return multiplyPrices(tokenToWethPrice, wethToUsdcPrice);
}

export type TokenUsdPriceInput = {
  // 토큰 → USDC 직접 구간.
  direct: PairPriceInput;
  // WETH 경유 두 구간. 읽지 않았으면 `null`이다.
  viaWeth: WethRoutedPriceInput | null;
};

/**
 * 토큰 단가. USDC 직접 경로에서 티어를 고를 수 있으면 그 현물가(DoD-1), 없으면 WETH 경유 단가(DoD-2)다.
 * 직접 경로와 WETH 경유 모두 티어를 고를 수 없거나 WETH 경유를 읽지 않았으면 `null`(`no-price`)이다(EC-16).
 */
export function selectTokenUsdPrice({ direct, viaWeth }: TokenUsdPriceInput): UsdPrice | null {
  const directPrice = selectPairSpotPrice(direct);
  if (directPrice !== null) return directPrice;
  if (viaWeth === null) return null;
  return selectWethRoutedPrice(viaWeth);
}
