import type { Token } from "@/config/tokens";
import type { FeeTier } from "@/config/uniswap-v3";

import { formatTokenAmount } from "@/lib/token-amount";

// 표시 문자열은 로캘 API(Intl, toLocaleString)와 숫자 반올림 표시 없이 bigint와 문자열 연산으로만 만든다.

export type PriceImpactSeverity = "normal" | "warning" | "error";

// 등급 경계(표시 bps 기준). 3% = 300 bps, 15% = 1500 bps.
const PRICE_IMPACT_WARNING_ABOVE_BPS = 300n;
const PRICE_IMPACT_ERROR_ABOVE_BPS = 1500n;

const PRICE_IMPACT_ZERO_LABEL = "0.00%";
const PRICE_IMPACT_MIN_LABEL = "<0.01%";

/**
 * 가격 영향 표시값을 0.01%(1 bps) 단위 정수로 버린 값. 0 이하(음수 포함)이면 `0n`이다.
 */
function getDisplayPriceImpactBps(priceImpactBps: number): bigint {
  if (!(priceImpactBps > 0)) return 0n;
  return BigInt(Math.floor(priceImpactBps));
}

/**
 * 가격 영향 등급. 표시값(퍼센트 소수 2자리 버림) 기준으로 3% 이하 `normal`, 3% 초과 15% 이하 `warning`,
 * 15% 초과 `error`다. 음수는 `normal`이다(DoD-17).
 */
export function getPriceImpactSeverity(priceImpactBps: number): PriceImpactSeverity {
  const displayBps = getDisplayPriceImpactBps(priceImpactBps);
  if (displayBps > PRICE_IMPACT_ERROR_ABOVE_BPS) return "error";
  if (displayBps > PRICE_IMPACT_WARNING_ABOVE_BPS) return "warning";
  return "normal";
}

/**
 * 가격 영향 표시 문자열. 퍼센트 소수 2자리에서 버린다(DoD-19).
 * 0보다 크고 0.01% 미만이면 `<0.01%`(DoD-20), 0이나 음수이면 `0.00%`(DoD-21)다.
 */
export function formatPriceImpact(priceImpactBps: number): string {
  if (!(priceImpactBps > 0)) return PRICE_IMPACT_ZERO_LABEL;

  const displayBps = getDisplayPriceImpactBps(priceImpactBps);
  if (displayBps === 0n) return PRICE_IMPACT_MIN_LABEL;

  const integer = displayBps / 100n;
  const fraction = (displayBps % 100n).toString().padStart(2, "0");
  return `${integer.toString()}.${fraction}%`;
}

// 수수료 티어는 100분의 1 bps 단위라 10000이 1%다.
const FEE_TIER_PER_PERCENT = 10_000n;
const FEE_TIER_FRACTION_DIGITS = 4;

/**
 * 수수료 티어 표시 문자열. 끝의 0을 지운 퍼센트다(100 → `0.01%`, 500 → `0.05%`, 3000 → `0.3%`, 10000 → `1%`, DoD-22).
 */
export function formatFeeTier(fee: FeeTier): string {
  const value = BigInt(fee);
  const integer = (value / FEE_TIER_PER_PERCENT).toString();
  const fraction = (value % FEE_TIER_PER_PERCENT)
    .toString()
    .padStart(FEE_TIER_FRACTION_DIGITS, "0")
    .replace(/0+$/, "");
  return fraction === "" ? `${integer}%` : `${integer}.${fraction}%`;
}

export type QuoteRateToken = Pick<Token, "symbol" | "decimals">;

export type QuoteRateParams = {
  tokenIn: QuoteRateToken;
  tokenOut: QuoteRateToken;
  // 보내는 정수량. 0보다 커야 한다.
  amountIn: bigint;
  // 예상 수령량(받는 토큰 정수량).
  amountOut: bigint;
};

/**
 * 체결 평균가(예상 수령량 ÷ 보내는 양)로 보내는 토큰 1개당 받는 양을 받는 토큰 decimals의 정수로 버린 값이다.
 */
export function getQuoteRateRaw({ tokenIn, amountIn, amountOut }: QuoteRateParams): bigint {
  if (amountIn <= 0n) {
    throw new RangeError("환율은 보내는 양이 0보다 커야 계산할 수 있습니다.");
  }
  return (amountOut * 10n ** BigInt(tokenIn.decimals)) / amountIn;
}

/**
 * 환율 행 `1 {보내는 토큰 심볼} = {값} {받는 토큰 심볼}`. 값은 `getQuoteRateRaw`를
 * 받는 토큰 decimals로 `formatTokenAmount` 형식으로 표시한 것이다(DoD-23).
 */
export function formatQuoteRate(params: QuoteRateParams): string {
  const value = formatTokenAmount(getQuoteRateRaw(params), params.tokenOut.decimals);
  return `1 ${params.tokenIn.symbol} = ${value} ${params.tokenOut.symbol}`;
}
