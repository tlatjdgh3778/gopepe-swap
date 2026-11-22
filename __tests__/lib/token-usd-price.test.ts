import type { Address } from "viem";

import { describe, expect, it } from "vitest";

import type { FeeTier } from "@/config/uniswap-v3";
import type { FeeTierQuoteResult, FeeTierQuoteResults, PoolSlot0Results } from "@/lib/swap-quote";

import {
  type UsdPrice,
  formatUsd,
  multiplyPrices,
  selectPairSpotPrice,
  selectTokenUsdPrice,
  spotPriceFromSqrtPriceX96,
  toUsdMicros,
} from "@/lib/token-usd-price";

// 골격(T-7). 단가 산출(slot0 현물가, WETH 경유 곱, 티어 선택 결합)과 USD 환산·표기의 순수 규칙만 다룬다.
// 판정 방법: 정적 표본을 순수 함수에 넣고 결과를 스펙 리터럴이나 테스트 쪽 계산과 비교한다. 기대값은 구현 출력에서 베끼지 않는다.
// 티어 선택 규칙은 기존 견적 규칙(revert·수령량 0·유동성 소진 제외, 수령량 최대, 같으면 수수료 최저)을 테스트 쪽 표본으로 적는다.
// mock 경계(사용자 확정 2026-11-22): 없음. 순수 함수와 정적 표본만 쓰고 vi.mock·스텁·타이머를 쓰지 않는다.
// 데이터 격리: 정적 데이터만 쓰며 표본 사이에 공유 상태가 없다.
// DoD-15(bigint 문자열 연산만, `Intl`·`toLocaleString` 미사용)는 코드 대조(T-17)로만 판정한다(사용자 확정 2026-11-22).
// 요청 구성(토큰 1개 10^decimals 견적 요청, USDC 직접 → WETH 경유 순서, 요청 수)은 통합 테스트(T-8), 포크 값 대조는 포크 통합 테스트(T-12)가 다룬다.

// ─── 표본 상수(리터럴) ───────────────────────────────────────────────
// 주소·한계값은 리터럴로 적고 제품 config에서 가져오지 않는다.

// Ethereum·Base 체인 네이티브 USDC와 WETH(Uniswap·Circle 배포 주소).
const ETH_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_WETH: Address = "0x4200000000000000000000000000000000000006";
const ETH_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// USDC(0xA0b8…)보다 수치로 작아 token0이지만, 체크섬 문자열로는 소문자 `a`가 대문자 `A`보다 커서 반대로 보이는 주소.
const BELOW_USDC_STRING_ABOVE: Address = "0xa000000000000000000000000000000000000000";
// USDC(0xA0b8…)보다 수치로 커서 token1이지만(셋째 자리 C=12 > b=11), 문자열로는 대문자 `C`가 소문자 `b`보다 작아 반대로 보이는 주소.
const ABOVE_USDC_STRING_BELOW: Address = "0xA0C0000000000000000000000000000000000000";

// 어느 체인의 USDC·WETH보다도 수치로 작은(token0) 토큰과 큰(token1) 토큰.
const LOW_TOKEN: Address = "0x1111111111111111111111111111111111111111";
const HIGH_TOKEN: Address = "0xD000000000000000000000000000000000000000";

const Q192 = 2n ** 192n;
const Q96 = 2n ** 96n;

// QuoterV2가 `sqrtPriceLimitX96 = 0`일 때 쓰는 방향별 한계값(TickMath MIN_SQRT_RATIO + 1, MAX_SQRT_RATIO - 1).
const LIMIT_ZERO_FOR_ONE = 4295128740n;
const LIMIT_ONE_FOR_ZERO = 1461446703485210103287273052203988822378723970341n;

// 한계값이 아닌 견적 후 가격(유동성 소진 아님).
const NORMAL_SQRT_PRICE_AFTER = Q96;

const FEES: readonly FeeTier[] = [100, 500, 3000, 10000];

// 티어 표본: bigint는 수령량(한계값이 아닌 견적 후 가격), "revert"는 revert, "exhausted"는 견적 후 가격이 방향별 한계값.
type TierSample = bigint | "revert" | "exhausted";
type FourTiers<T> = readonly [T, T, T, T];

// 토큰 주소를 수치로 비교해 tokenIn이 token0이면 참이다(Uniswap V3 규칙).
function isToken0(token: Address, other: Address): boolean {
  return BigInt(token) < BigInt(other);
}

function quotesOf(
  tokenIn: Address,
  tokenOut: Address,
  samples: FourTiers<TierSample>,
): FeeTierQuoteResults {
  const exhaustedAfter = isToken0(tokenIn, tokenOut) ? LIMIT_ZERO_FOR_ONE : LIMIT_ONE_FOR_ZERO;
  const toResult = (sample: TierSample): FeeTierQuoteResult => {
    if (sample === "revert") return { status: "revert" };
    // 유동성 소진 티어는 다른 티어보다 수령량이 많아도 빠져야 한다.
    if (sample === "exhausted") {
      return { status: "ok", amountOut: 10n ** 30n, sqrtPriceX96After: exhaustedAfter };
    }
    return { status: "ok", amountOut: sample, sqrtPriceX96After: NORMAL_SQRT_PRICE_AFTER };
  };
  return {
    100: toResult(samples[0]),
    500: toResult(samples[1]),
    3000: toResult(samples[2]),
    10000: toResult(samples[3]),
  };
}

function slot0Of(prices: FourTiers<bigint>): PoolSlot0Results {
  return {
    100: { status: "ok", sqrtPriceX96: prices[0] },
    500: { status: "ok", sqrtPriceX96: prices[1] },
    3000: { status: "ok", sqrtPriceX96: prices[2] },
    10000: { status: "ok", sqrtPriceX96: prices[3] },
  };
}

function sqrtPriceOf(prices: FourTiers<bigint>, fee: FeeTier): bigint {
  return prices[FEES.indexOf(fee)];
}

// 티어마다 서로 다른 sqrtPriceX96(모두 2^96 근처, 서로 다른 현물가).
const DISTINCT_SQRT_PRICES: FourTiers<bigint> = [Q96 * 2n, Q96 * 3n, Q96 * 5n, Q96 * 7n];

// 스펙 계약의 현물가(기준 토큰 raw / 대상 토큰 raw). 대상 토큰이 token0이면 sqrtP² / 2^192, token1이면 2^192 / sqrtP².
function specSpotPrice(token: Address, quoteToken: Address, sqrtPriceX96: bigint): UsdPrice {
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  return isToken0(token, quoteToken)
    ? { numerator: priceX192, denominator: Q192 }
    : { numerator: Q192, denominator: priceX192 };
}

// 유리수 곱(테스트 쪽 계산).
function specProduct(a: UsdPrice, b: UsdPrice): UsdPrice {
  return { numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator };
}

// 두 유리수의 값이 같은지 교차 곱으로 본다(제품 결과는 약분하지 않을 수 있다).
function sameValue(a: UsdPrice, b: UsdPrice): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

function expectSameValue(actual: UsdPrice | null, expected: UsdPrice, label: string): void {
  expect(actual, label).not.toBeNull();
  if (actual === null) return;
  expect(actual.denominator > 0n, `${label}: 분모가 0보다 크다`).toBe(true);
  expect(actual.numerator * expected.denominator, `${label}: 유리수 값이 기대값과 같다`).toBe(
    expected.numerator * actual.denominator,
  );
}

describe("달러 환산 — 토큰 단가를 Uniswap V3 현물가로 구하고 금액 × 단가를 USD로 표기한다", () => {
  describe("USDC 직접 경로 단가", () => {
    /**
     * @spec DoD-1
     * @given 대상 토큰과 체인 네이티브 USDC 쌍의 고른 티어 풀 `slot0.sqrtPriceX96`가 있다. 표본: 대상 토큰 주소가 USDC 주소보다 수치로 작아 token0인 쌍, 커서 token1인 쌍(주소 수치 대소와 체크섬 문자열 대소가 반대인 쌍 포함) × `sqrtPriceX96`(2^96과 2^96이 아닌 값)
     * @when slot0 현물가로 단가를 구한다
     * @then 대상 토큰이 token0이면 단가의 유리수 값(USDC raw / 대상 토큰 raw)이 sqrtPriceX96² / 2^192와 같다
     * @then 대상 토큰이 token1이면 단가의 유리수 값이 2^192 / sqrtPriceX96²와 같다
     */
    it("[DoD-1] slot0 현물가 단가는 token0·token1 두 순서 모두 기준 토큰 raw / 대상 토큰 raw다", () => {
      // 순서 표본: DAI(수치·문자열 모두 USDC보다 작음), 0xa000…(수치로 작고 문자열로 큼),
      // WETH(수치·문자열 모두 큼), 0xA0C0…(수치로 크고 문자열로 작음).
      const tokens: readonly { token: Address; token0: boolean; stringOrderOpposite: boolean }[] = [
        { token: ETH_DAI, token0: true, stringOrderOpposite: false },
        { token: BELOW_USDC_STRING_ABOVE, token0: true, stringOrderOpposite: true },
        { token: ETH_WETH, token0: false, stringOrderOpposite: false },
        { token: ABOVE_USDC_STRING_BELOW, token0: false, stringOrderOpposite: true },
      ];
      // 2^96(현물가 1)과 2^96이 아닌 값.
      const sqrtPrices: readonly bigint[] = [Q96, 123456789012345678901234567890n];

      for (const { token, token0, stringOrderOpposite } of tokens) {
        // 입력 전제: 표본의 token0 여부가 주소 수치 비교와 맞고, 문자열 비교와의 관계도 표본 설명과 맞다.
        expect(isToken0(token, ETH_USDC), `${token}의 token0 전제`).toBe(token0);
        expect(token < ETH_USDC !== token0, `${token}의 문자열 순서 전제`).toBe(
          stringOrderOpposite,
        );

        for (const sqrtPriceX96 of sqrtPrices) {
          const actual = spotPriceFromSqrtPriceX96({ token, quoteToken: ETH_USDC, sqrtPriceX96 });
          const priceX192 = sqrtPriceX96 * sqrtPriceX96;
          const expected: UsdPrice = token0
            ? { numerator: priceX192, denominator: Q192 }
            : { numerator: Q192, denominator: priceX192 };
          expectSameValue(actual, expected, `${token} sqrtPriceX96=${sqrtPriceX96}`);
        }
      }
    });

    /**
     * @spec DoD-1
     * @given 대상 토큰 1개(10^decimals)를 USDC로 견적한 네 티어(100·500·3000·10000) 결과와 티어마다 서로 다른 `slot0.sqrtPriceX96`가 있다. 표본: 수령량이 가장 많은 티어가 가장 낮은 수수료 티어가 아님, 수령량이 같은 티어가 둘 이상(수수료가 낮은 쪽이 골라짐), 수령량이 더 많은 티어가 revert·수령량 0·유동성 소진(견적 후 가격이 방향별 한계값)이라 빠짐
     * @when 견적 결과와 slot0 결과로 단가를 구한다
     * @then 단가가 기존 티어 선택 규칙으로 고른 티어 풀의 slot0 현물가와 같고 다른 티어의 slot0 값은 쓰이지 않는다
     */
    it("[DoD-1] 단가는 기존 티어 선택 규칙으로 고른 티어 풀의 slot0 현물가다", () => {
      // 견적 표본과 기존 규칙으로 고를 티어(리터럴).
      const samples: readonly { name: string; quotes: FourTiers<TierSample>; fee: FeeTier }[] = [
        {
          name: "최대 수령량이 가장 낮은 수수료 티어가 아님",
          quotes: [100n, 300n, 200n, 50n],
          fee: 500,
        },
        { name: "500·3000 동률", quotes: [100n, 300n, 300n, 50n], fee: 500 },
        { name: "3000·10000 동률", quotes: [200n, 100n, 300n, 300n], fee: 3000 },
        { name: "더 많은 티어가 유동성 소진", quotes: ["revert", 0n, "exhausted", 7n], fee: 10000 },
        {
          name: "더 많은 티어가 유동성 소진·revert",
          quotes: [5n, "exhausted", "revert", 0n],
          fee: 100,
        },
      ];

      // 두 방향(대상 토큰이 USDC 대비 token0, token1).
      for (const token of [LOW_TOKEN, HIGH_TOKEN]) {
        for (const { name, quotes, fee } of samples) {
          const label = `${token} ${name}`;
          const actual = selectPairSpotPrice({
            token,
            quoteToken: ETH_USDC,
            quotes: quotesOf(token, ETH_USDC, quotes),
            slot0: slot0Of(DISTINCT_SQRT_PRICES),
          });

          expectSameValue(
            actual,
            specSpotPrice(token, ETH_USDC, sqrtPriceOf(DISTINCT_SQRT_PRICES, fee)),
            label,
          );
          // 다른 티어의 slot0 현물가와는 값이 다르다(티어마다 sqrtPriceX96가 달라 현물가도 다르다).
          for (const otherFee of FEES.filter((candidate) => candidate !== fee)) {
            const other = specSpotPrice(
              token,
              ETH_USDC,
              sqrtPriceOf(DISTINCT_SQRT_PRICES, otherFee),
            );
            expect(
              actual !== null && sameValue(actual, other),
              `${label}: 티어 ${otherFee}의 slot0`,
            ).toBe(false);
          }
        }
      }
    });
  });

  describe("WETH 경유 단가", () => {
    /**
     * @spec DoD-2
     * @given USDC 직접 경로가 없는 토큰의 토큰→WETH 구간 현물가와 WETH→USDC 구간 현물가가 있다. 표본: 토큰이 WETH 대비 token0·token1 × WETH가 USDC 대비 token0·token1
     * @when 두 구간 현물가로 WETH 경유 단가를 구한다
     * @then 단가의 유리수 값이 토큰→WETH 현물가 × WETH→USDC 현물가와 같다
     */
    it("[DoD-2] WETH 경유 단가는 토큰→WETH 현물가 × WETH→USDC 현물가다", () => {
      // 순서 표본: 토큰이 WETH 대비 token0·token1 × WETH가 USDC 대비 token1(Ethereum)·token0(Base).
      const samples: readonly {
        token: Address;
        weth: Address;
        usdc: Address;
        tokenIsToken0: boolean;
        wethIsToken0: boolean;
      }[] = [
        {
          token: LOW_TOKEN,
          weth: ETH_WETH,
          usdc: ETH_USDC,
          tokenIsToken0: true,
          wethIsToken0: false,
        },
        {
          token: HIGH_TOKEN,
          weth: ETH_WETH,
          usdc: ETH_USDC,
          tokenIsToken0: false,
          wethIsToken0: false,
        },
        {
          token: LOW_TOKEN,
          weth: BASE_WETH,
          usdc: BASE_USDC,
          tokenIsToken0: true,
          wethIsToken0: true,
        },
        {
          token: HIGH_TOKEN,
          weth: BASE_WETH,
          usdc: BASE_USDC,
          tokenIsToken0: false,
          wethIsToken0: true,
        },
      ];
      const tokenToWethSqrtPrice = 98765432109876543210987654321n;
      const wethToUsdcSqrtPrice = 4339505179874779662909440n;

      for (const { token, weth, usdc, tokenIsToken0, wethIsToken0 } of samples) {
        const label = `${token} → ${weth} → ${usdc}`;
        // 입력 전제: 표본의 순서가 주소 수치 비교와 맞다.
        expect(isToken0(token, weth), `${label}: 토큰 순서 전제`).toBe(tokenIsToken0);
        expect(isToken0(weth, usdc), `${label}: WETH 순서 전제`).toBe(wethIsToken0);

        const actual = multiplyPrices(
          spotPriceFromSqrtPriceX96({
            token,
            quoteToken: weth,
            sqrtPriceX96: tokenToWethSqrtPrice,
          }),
          spotPriceFromSqrtPriceX96({
            token: weth,
            quoteToken: usdc,
            sqrtPriceX96: wethToUsdcSqrtPrice,
          }),
        );
        const expected = specProduct(
          specSpotPrice(token, weth, tokenToWethSqrtPrice),
          specSpotPrice(weth, usdc, wethToUsdcSqrtPrice),
        );
        expectSameValue(actual, expected, label);
      }
    });

    /**
     * @spec DoD-2
     * @given USDC 직접 경로의 네 티어가 모두 후보에서 빠지고, 토큰→WETH 구간과 WETH→USDC 구간 각각에 네 티어 견적 결과와 티어마다 서로 다른 `slot0.sqrtPriceX96`가 있으며, 두 구간에서 기존 티어 선택 규칙으로 고르는 티어가 서로 다르다
     * @when 견적 결과와 slot0 결과로 단가를 구한다
     * @then 단가가 토큰→WETH 구간에서 고른 티어의 slot0 현물가 × WETH→USDC 구간에서 고른 티어의 slot0 현물가와 같다
     */
    it("[DoD-2] WETH 경유의 각 구간 티어는 구간마다 기존 티어 선택 규칙으로 고른다", () => {
      // 토큰→WETH는 3000, WETH→USDC는 500을 고르는 견적(리터럴). 두 구간의 고른 티어가 다르다.
      const tokenToWethQuotes: FourTiers<TierSample> = [100n, 200n, 400n, 300n];
      const tokenToWethFee: FeeTier = 3000;
      const wethToUsdcQuotes: FourTiers<TierSample> = [10n, 40n, 30n, 40n];
      const wethToUsdcFee: FeeTier = 500;
      // 구간마다 티어별로 다른 sqrtPriceX96. 어떤 티어 조합의 곱도 서로 값이 다르다(서로 다른 소수의 제곱).
      const tokenToWethSqrtPrices: FourTiers<bigint> = [Q96 * 2n, Q96 * 3n, Q96 * 5n, Q96 * 7n];
      const wethToUsdcSqrtPrices: FourTiers<bigint> = [Q96 * 11n, Q96 * 13n, Q96 * 17n, Q96 * 19n];

      for (const token of [LOW_TOKEN, HIGH_TOKEN]) {
        const actual = selectTokenUsdPrice({
          // USDC 직접 경로는 네 티어 모두 후보에서 빠진다(revert, 수령량 0, 유동성 소진).
          direct: {
            token,
            quoteToken: ETH_USDC,
            quotes: quotesOf(token, ETH_USDC, ["revert", 0n, "exhausted", "revert"]),
            slot0: slot0Of(DISTINCT_SQRT_PRICES),
          },
          viaWeth: {
            tokenToWeth: {
              token,
              quoteToken: ETH_WETH,
              quotes: quotesOf(token, ETH_WETH, tokenToWethQuotes),
              slot0: slot0Of(tokenToWethSqrtPrices),
            },
            wethToUsdc: {
              token: ETH_WETH,
              quoteToken: ETH_USDC,
              quotes: quotesOf(ETH_WETH, ETH_USDC, wethToUsdcQuotes),
              slot0: slot0Of(wethToUsdcSqrtPrices),
            },
          },
        });

        const priceOf = (firstFee: FeeTier, secondFee: FeeTier): UsdPrice =>
          specProduct(
            specSpotPrice(token, ETH_WETH, sqrtPriceOf(tokenToWethSqrtPrices, firstFee)),
            specSpotPrice(ETH_WETH, ETH_USDC, sqrtPriceOf(wethToUsdcSqrtPrices, secondFee)),
          );

        expectSameValue(actual, priceOf(tokenToWethFee, wethToUsdcFee), `${token}`);
        // 다른 티어 조합(같은 티어를 두 구간에 쓰는 경우 포함)의 곱과는 값이 다르다.
        for (const firstFee of FEES) {
          for (const secondFee of FEES) {
            if (firstFee === tokenToWethFee && secondFee === wethToUsdcFee) continue;
            expect(
              actual !== null && sameValue(actual, priceOf(firstFee, secondFee)),
              `${token}: 티어 조합 ${firstFee}·${secondFee}`,
            ).toBe(false);
          }
        }
      }
    });
  });

  describe("가격 경로가 없을 때", () => {
    /**
     * @spec EC-16
     * @given USDC 직접 경로와 토큰→WETH 경로 모두 네 티어가 후보에서 빠진다. 표본: 모든 티어 revert, 모든 티어 1개 견적 수령량 0, 모든 티어 유동성 소진(견적 후 가격이 방향별 한계값), revert·수령량 0·유동성 소진이 섞임
     * @when 견적 결과로 단가를 구한다
     * @then 결과가 가격 없음(`null`, `no-price`)이다
     */
    it("[EC-16] USDC 직접·WETH 경유 모두 티어를 고를 수 없으면 가격 없음이다", () => {
      const excludedSamples: readonly { name: string; quotes: FourTiers<TierSample> }[] = [
        { name: "모든 티어 revert", quotes: ["revert", "revert", "revert", "revert"] },
        { name: "모든 티어 수령량 0", quotes: [0n, 0n, 0n, 0n] },
        {
          name: "모든 티어 유동성 소진",
          quotes: ["exhausted", "exhausted", "exhausted", "exhausted"],
        },
        { name: "revert·수령량 0·유동성 소진 섞임", quotes: [0n, "revert", "exhausted", 0n] },
      ];
      // WETH→USDC 구간은 고를 티어가 있다(가격 없음이 토큰 쪽 경로 때문임을 드러낸다).
      const wethToUsdc = {
        token: ETH_WETH,
        quoteToken: ETH_USDC,
        quotes: quotesOf(ETH_WETH, ETH_USDC, [10n, 20n, 30n, 40n]),
        slot0: slot0Of(DISTINCT_SQRT_PRICES),
      };
      expect(selectPairSpotPrice(wethToUsdc), "WETH→USDC 구간 전제").not.toBeNull();

      // 두 방향(대상 토큰이 USDC·WETH 대비 token0, token1). 유동성 소진 한계값이 방향마다 다르다.
      for (const token of [LOW_TOKEN, HIGH_TOKEN]) {
        for (const { name, quotes } of excludedSamples) {
          const actual = selectTokenUsdPrice({
            direct: {
              token,
              quoteToken: ETH_USDC,
              quotes: quotesOf(token, ETH_USDC, quotes),
              slot0: slot0Of(DISTINCT_SQRT_PRICES),
            },
            viaWeth: {
              tokenToWeth: {
                token,
                quoteToken: ETH_WETH,
                quotes: quotesOf(token, ETH_WETH, quotes),
                slot0: slot0Of(DISTINCT_SQRT_PRICES),
              },
              wethToUsdc,
            },
          });
          expect(actual, `${token} ${name}`).toBeNull();
        }
      }
    });
  });

  describe("금액의 USD 환산", () => {
    /**
     * @spec DoD-10
     * @given 금액 raw와 단가 표본: 나누어떨어짐(500000000000000000n, {2375900000n, 1000000000000000000n} → 1187950000n), 나머지가 있음(5n, {2n, 3n} → 3n), 1보다 작은 결과(1n, {2n, 3n} → 0n), 금액 0(0n, {2375900000n, 1000000000000000000n} → 0n), 단가 {1n, 1n}(1234567n → 1234567n)
     * @when `toUsdMicros(amountRaw, price)`를 계산한다
     * @then 결과가 각 표본의 `amountRaw × numerator / denominator` 버림 리터럴과 같다
     */
    it("[DoD-10] toUsdMicros는 amountRaw × numerator / denominator를 버림한다", () => {
      const samples: readonly { amountRaw: bigint; price: UsdPrice; expected: bigint }[] = [
        {
          amountRaw: 500000000000000000n,
          price: { numerator: 2375900000n, denominator: 1000000000000000000n },
          expected: 1187950000n,
        },
        { amountRaw: 5n, price: { numerator: 2n, denominator: 3n }, expected: 3n },
        { amountRaw: 1n, price: { numerator: 2n, denominator: 3n }, expected: 0n },
        {
          amountRaw: 0n,
          price: { numerator: 2375900000n, denominator: 1000000000000000000n },
          expected: 0n,
        },
        { amountRaw: 1234567n, price: { numerator: 1n, denominator: 1n }, expected: 1234567n },
      ];

      for (const { amountRaw, price, expected } of samples) {
        expect(
          toUsdMicros(amountRaw, price),
          `${amountRaw} × ${price.numerator} / ${price.denominator}`,
        ).toBe(expected);
      }
    });

    /**
     * @spec EC-25
     * @given uint256 상한 근처 금액 raw 표본(2^256 - 1, 2^256 - 2)과 단가 표본({1n, 1n}, 나누어떨어지지 않는 {3n, 7n}, sqrtPriceX96가 큰 slot0 현물가처럼 분자·분모가 2^192 이상인 단가)이 있고 기대값은 독립 계산한 리터럴로 적는다
     * @when `toUsdMicros(amountRaw, price)`를 계산한다
     * @then 결과가 기대 리터럴과 정확히 같다(정밀도 손실 없음)
     */
    it("[EC-25] uint256 상한 근처 금액도 toUsdMicros가 정확한 bigint 결과를 낸다", () => {
      const uint256Max = 2n ** 256n - 1n;
      // 분자·분모가 모두 2^192 이상인 slot0 현물가 모양 단가(sqrtPriceX96 = MAX_SQRT_RATIO - 1).
      const largeSqrtPrice = 1461446703485210103287273052203988822378723970341n;
      const largeSpot: UsdPrice = { numerator: largeSqrtPrice * largeSqrtPrice, denominator: Q192 };
      const largeSpotInverse: UsdPrice = {
        numerator: Q192,
        denominator: largeSqrtPrice * largeSqrtPrice,
      };
      expect(largeSpot.numerator >= Q192 && largeSpot.denominator >= Q192, "큰 단가 전제").toBe(
        true,
      );

      // 기대값은 독립 계산(임의 정밀도 정수)한 리터럴이다.
      const samples: readonly { amountRaw: bigint; price: UsdPrice; expected: bigint }[] = [
        {
          amountRaw: uint256Max,
          price: { numerator: 1n, denominator: 1n },
          expected: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
        },
        {
          amountRaw: uint256Max - 1n,
          price: { numerator: 1n, denominator: 1n },
          expected: 115792089237316195423570985008687907853269984665640564039457584007913129639934n,
        },
        {
          amountRaw: uint256Max,
          price: { numerator: 3n, denominator: 7n },
          expected: 49625181101706940895816136432294817651401421999560241731196107431962769845686n,
        },
        {
          amountRaw: uint256Max - 1n,
          price: { numerator: 3n, denominator: 7n },
          expected: 49625181101706940895816136432294817651401421999560241731196107431962769845686n,
        },
        {
          amountRaw: uint256Max,
          price: largeSpot,
          expected:
            39399044224961524746228802493159093197251202281763941921952932449473184107396000743974096917199050653475774114927333n,
        },
        {
          amountRaw: uint256Max - 1n,
          price: largeSpot,
          expected:
            39399044224961524746228802493159093197251202281763941921952932449473184107395660487187260529104980011135874433754571n,
        },
        {
          amountRaw: uint256Max,
          price: largeSpotInverse,
          expected: 340307948928567962850611698341930330625n,
        },
      ];

      for (const { amountRaw, price, expected } of samples) {
        expect(
          toUsdMicros(amountRaw, price),
          `${amountRaw} × ${price.numerator} / ${price.denominator}`,
        ).toBe(expected);
      }
    });
  });

  describe("USD 표기", () => {
    /**
     * @spec DoD-11
     * @given USD micros 표본: 1187950000n → "$1,187.95", 1187959999n → "$1,187.95"(셋째 자리 이하 버림), 999990000n → "$999.99", 1000000000n → "$1,000.00", 1000000n → "$1.00", 1050000n → "$1.05", 10000n → "$0.01"(정확히 $0.01), 19999n → "$0.01"($0.01과 $0.02 사이)
     * @when `formatUsd(usdMicros)`로 표기한다
     * @then 각 표본의 표기가 소수 2자리 버림과 천 단위 쉼표를 적용한 리터럴과 같다
     */
    it("[DoD-11] formatUsd는 소수 2자리 버림과 천 단위 쉼표로 $1,187.95 형식을 만든다", () => {
      const samples: readonly [bigint, string][] = [
        [1187950000n, "$1,187.95"],
        [1187959999n, "$1,187.95"],
        [999990000n, "$999.99"],
        [1000000000n, "$1,000.00"],
        [1000000n, "$1.00"],
        [1050000n, "$1.05"],
        [10000n, "$0.01"],
        [19999n, "$0.01"],
      ];

      for (const [usdMicros, expected] of samples) {
        expect(formatUsd(usdMicros), `${usdMicros}`).toBe(expected);
      }
    });

    /**
     * @spec DoD-12
     * @given 0보다 크고 $0.01보다 작은 USD micros 표본: 1n, 9999n
     * @when `formatUsd(usdMicros)`로 표기한다
     * @then 모든 표본의 표기가 "<$0.01"이다
     */
    it("[DoD-12] 0보다 크고 $0.01보다 작은 값은 <$0.01이다", () => {
      for (const usdMicros of [1n, 9999n]) {
        expect(formatUsd(usdMicros), `${usdMicros}`).toBe("<$0.01");
      }
    });

    /**
     * @spec DoD-13
     * @given USD micros 0n
     * @when `formatUsd(usdMicros)`로 표기한다
     * @then 표기가 "$0.00"이다
     */
    it("[DoD-13] 0은 $0.00이다", () => {
      expect(formatUsd(0n)).toBe("$0.00");
    });

    /**
     * @spec DoD-14
     * @given 큰 USD micros 표본: 1234567890000n → "$1,234,567.89", 1000000000000000000n → "$1,000,000,000,000.00"
     * @when `formatUsd(usdMicros)`로 표기한다
     * @then 각 표본의 표기가 축약(K·M·B 등) 없이 천 단위 쉼표로 모든 자리를 적은 리터럴과 같다
     */
    it("[DoD-14] 큰 값을 축약하지 않는다", () => {
      const samples: readonly [bigint, string][] = [
        [1234567890000n, "$1,234,567.89"],
        [1000000000000000000n, "$1,000,000,000,000.00"],
      ];

      for (const [usdMicros, expected] of samples) {
        expect(formatUsd(usdMicros), `${usdMicros}`).toBe(expected);
      }
    });
  });
});
