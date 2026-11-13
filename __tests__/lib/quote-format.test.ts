import { describe, expect, it } from "vitest";

import type { FeeTier } from "@/config/uniswap-v3";

import {
  formatFeeTier,
  formatPriceImpact,
  formatQuoteRate,
  getPriceImpactSeverity,
  getQuoteRateRaw,
  type QuoteRateParams,
} from "@/lib/quote-format";
// `formatTokenAmount` 표시 형식(F2 스펙): 천 단위 쉼표·소수점 마침표·소수 최대 4자리(끝의 0 없음) 또는 `<0.0001`.
const FORMAT_TOKEN_AMOUNT_PATTERN = /^(<0\.0001|\d{1,3}(,\d{3})*(\.\d{0,3}[1-9])?)$/;

type LocaleArgument = string | string[] | undefined;

/**
 * DoD-24 전용 로캘 스텁(T-5 mock 경계 예외). `Intl.NumberFormat`과 Number·BigInt의 `toLocaleString`이
 * 로캘 인자 없이 호출되면 `locale`을 쓰게 바꾸고, `run`이 끝나면(예외가 나도) 원래대로 되돌린다.
 * F2 `__tests__/lib/token-amount.test.ts`와 같은 방식이다.
 */
function withDefaultLocale<T>(locale: string, run: () => T): T {
  const intlDescriptor = Object.getOwnPropertyDescriptor(Intl, "NumberFormat");
  const OriginalNumberFormat = Intl.NumberFormat;
  const originalNumberToLocaleString = Number.prototype.toLocaleString;
  const originalBigIntToLocaleString = BigInt.prototype.toLocaleString;

  function DefaultLocaleNumberFormat(
    locales?: LocaleArgument,
    options?: Intl.NumberFormatOptions,
  ): Intl.NumberFormat {
    return new OriginalNumberFormat(locales ?? locale, options);
  }
  DefaultLocaleNumberFormat.prototype = OriginalNumberFormat.prototype;
  DefaultLocaleNumberFormat.supportedLocalesOf = OriginalNumberFormat.supportedLocalesOf;

  Object.defineProperty(Intl, "NumberFormat", {
    ...intlDescriptor,
    value: DefaultLocaleNumberFormat,
  });
  Number.prototype.toLocaleString = function (
    this: number,
    locales?: LocaleArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    return originalNumberToLocaleString.call(this, locales ?? locale, options);
  };
  BigInt.prototype.toLocaleString = function (
    this: bigint,
    locales?: LocaleArgument,
    options?: BigIntToLocaleStringOptions,
  ) {
    return originalBigIntToLocaleString.call(this, locales ?? locale, options);
  } as typeof BigInt.prototype.toLocaleString;

  try {
    return run();
  } finally {
    if (intlDescriptor) Object.defineProperty(Intl, "NumberFormat", intlDescriptor);
    Number.prototype.toLocaleString = originalNumberToLocaleString;
    BigInt.prototype.toLocaleString = originalBigIntToLocaleString;
  }
}

// 각 환경에서 로캘 API의 기본 결과가 실제로 그 로캘인지 확인한다(전제 확인).
const LOCALE_PROBES = {
  "en-US": { number: "1,234.5", bigint: "1,234" },
  "de-DE": { number: "1.234,5", bigint: "1.234" },
} as const;

function rateParams(
  tokenIn: readonly [string, number],
  amountIn: bigint,
  tokenOut: readonly [string, number],
  amountOut: bigint,
): QuoteRateParams {
  return {
    tokenIn: { symbol: tokenIn[0], decimals: tokenIn[1] },
    tokenOut: { symbol: tokenOut[0], decimals: tokenOut[1] },
    amountIn,
    amountOut,
  };
}

// 이 파일은 가격 영향 등급과 가격 영향·수수료 티어·환율 행의 표시 문자열 순수 규칙만 다룬다.
// 화면의 `data-severity`·행 배치는 통합 테스트(T-6), 등급별 색(DoD-18)은 코드 대조와 수동 확인(T-10)이 다룬다.
// 가격 영향 표본은 bps 값이며, 1 bps = 0.01%라 표시값(퍼센트 소수 2자리 버림)은 양수 bps의 정수부에 해당한다.
describe("견적 표시 — 가격 영향·수수료 티어·환율을 로캘과 무관하게 보인다", () => {
  describe("가격 영향 등급", () => {
    /**
     * @spec DoD-17
     * @given 가격 영향 bps 표본 `-1234.5`, `-0.5`, `0`, `0.5`(표시 `<0.01%`), `299.99`(표시 `2.99%`), `300`(표시 `3.00%`), `300.01`·`300.99`(표시 `3.00%`이지만 원값이 300 bps를 넘음)을 하나씩 반복한다
     * @when 가격 영향 등급을 정한다
     * @then 등급은 `normal`이다
     */
    it("[DoD-17] 표시값이 3% 이하이거나 음수이면 normal이다", () => {
      for (const bps of [-1234.5, -0.5, 0, 0.5, 299.99, 300, 300.01, 300.99]) {
        expect(getPriceImpactSeverity(bps), `${bps} bps`).toBe("normal");
      }
    });

    /**
     * @spec DoD-17
     * @given 가격 영향 bps 표본 `301`(표시 `3.01%`), `301.5`, `1499.99`(표시 `14.99%`), `1500`(표시 `15.00%`), `1500.99`(표시 `15.00%`이지만 원값이 1500 bps를 넘음)을 하나씩 반복한다
     * @when 가격 영향 등급을 정한다
     * @then 등급은 `warning`이다
     */
    it("[DoD-17] 표시값이 3% 초과 15% 이하이면 warning이다", () => {
      for (const bps of [301, 301.5, 1499.99, 1500, 1500.99]) {
        expect(getPriceImpactSeverity(bps), `${bps} bps`).toBe("warning");
      }
    });

    /**
     * @spec DoD-17
     * @given 가격 영향 bps 표본 `1501`(표시 `15.01%`), `1501.5`, `9970`을 하나씩 반복한다
     * @when 가격 영향 등급을 정한다
     * @then 등급은 `error`다
     */
    it("[DoD-17] 표시값이 15% 초과이면 error다", () => {
      for (const bps of [1501, 1501.5, 9970]) {
        expect(getPriceImpactSeverity(bps), `${bps} bps`).toBe("error");
      }
    });
  });

  describe("가격 영향 표시", () => {
    /**
     * @spec DoD-19
     * @given 가격 영향 bps 표본 `0`, `1`, `1.999`, `12.345`, `99.99`, `100`, `299.99`, `300.99`, `1234.567`, `1500.99`, `9970`을 하나씩 반복한다
     * @when 가격 영향 표시 문자열을 만든다
     * @then 표시는 표본 순서대로 `0.00%`, `0.01%`, `0.01%`, `0.12%`, `0.99%`, `1.00%`, `2.99%`, `3.00%`, `12.34%`, `15.00%`, `99.70%`이다
     * @then 퍼센트 소수 2자리 아래는 반올림 없이 버린다
     */
    it("[DoD-19] 가격 영향은 퍼센트 소수 2자리에서 버려 표시한다", () => {
      // 반올림했다면 1.999 → 0.02%, 99.99 → 1.00%, 299.99 → 3.00%, 300.99 → 3.01%, 1234.567 → 12.35%, 1500.99 → 15.01%가 된다.
      const samples = [
        [0, "0.00%"],
        [1, "0.01%"],
        [1.999, "0.01%"],
        [12.345, "0.12%"],
        [99.99, "0.99%"],
        [100, "1.00%"],
        [299.99, "2.99%"],
        [300.99, "3.00%"],
        [1234.567, "12.34%"],
        [1500.99, "15.00%"],
        [9970, "99.70%"],
      ] as const;

      for (const [bps, expected] of samples) {
        expect(formatPriceImpact(bps), `${bps} bps`).toBe(expected);
      }
    });

    /**
     * @spec DoD-20
     * @given 가격 영향 bps 표본 `0.0001`, `0.5`, `0.99`, `0.999999`처럼 0보다 크고 0.01%(1 bps) 미만인 값을 하나씩 반복한다
     * @when 가격 영향 표시 문자열을 만든다
     * @then 표시는 `<0.01%`다
     */
    it("[DoD-20] 0보다 크고 0.01% 미만인 가격 영향은 <0.01%로 표시한다", () => {
      for (const bps of [0.0001, 0.5, 0.99, 0.999999]) {
        expect(formatPriceImpact(bps), `${bps} bps`).toBe("<0.01%");
      }
    });

    /**
     * @spec DoD-21
     * @given 가격 영향 bps 표본 `-0.0001`, `-0.5`, `-1`, `-30`, `-1234.5`처럼 계산값이 음수인 값을 하나씩 반복한다
     * @when 가격 영향 표시 문자열을 만든다
     * @then 표시는 `0.00%`다
     */
    it("[DoD-21] 음수 가격 영향은 0.00%로 표시한다", () => {
      for (const bps of [-0.0001, -0.5, -1, -30, -1234.5]) {
        expect(formatPriceImpact(bps), `${bps} bps`).toBe("0.00%");
      }
    });
  });

  describe("수수료 티어 표시", () => {
    /**
     * @spec DoD-22
     * @given 수수료 티어 표본 `100`, `500`, `3000`, `10000`을 하나씩 반복한다
     * @when 수수료 티어 표시 문자열을 만든다
     * @then 표시는 표본 순서대로 `0.01%`, `0.05%`, `0.3%`, `1%`이다
     */
    it("[DoD-22] 수수료 티어를 퍼센트로 표시한다", () => {
      const samples: readonly (readonly [FeeTier, string])[] = [
        [100, "0.01%"],
        [500, "0.05%"],
        [3000, "0.3%"],
        [10000, "1%"],
      ];

      for (const [fee, expected] of samples) {
        expect(formatFeeTier(fee), `fee ${fee}`).toBe(expected);
      }
    });
  });

  describe("환율 행", () => {
    /**
     * @spec DoD-23
     * @given (보내는 토큰 심볼·decimals, 보내는 정수량, 받는 토큰 심볼·decimals, 예상 수령량) 표본 (ETH·18, `2000000000000000000`, USDC·6, `6000123456`), (USDC·6, `3000000000`, ETH·18, `1000000000000000000`), (WBTC·8, `50000000`, USDC·6, `50000123456`), (USDC·6, `3000000`, DAI·18, `2000000000000000000`), (USDC·6, `1000000`, WBTC·8, `1500`), (USDC·6, `2000000`, USDT·6, `2469999`)(정수 버림이면 `1234999`, 반올림이면 `1235000`)을 하나씩 반복한다
     * @when 환율 행 문자열을 만든다
     * @then 체결 평균가(예상 수령량 ÷ 보내는 양)를 받는 토큰 decimals의 정수로 버린 값은 표본 순서대로 `3000061728`, `333333333333333`, `100000246912`, `666666666666666666`, `1500`, `1234999`이다
     * @then 행은 표본 순서대로 `1 ETH = 3,000.0617 USDC`, `1 USDC = 0.0003 ETH`, `1 WBTC = 100,000.2469 USDC`, `1 USDC = 0.6666 DAI`, `1 USDC = <0.0001 WBTC`, `1 USDC = 1.2349 USDT`이다
     * @then 값 자리는 그 정수를 받는 토큰 decimals로 `formatTokenAmount` 형식(소수 4자리 버림·끝의 0 제거·천 단위 쉼표·`<0.0001`)으로 표시한 것이다
     */
    it("[DoD-23] 환율 행은 체결 평균가를 받는 토큰 decimals 정수로 버려 1 보내는 토큰 기준으로 표시한다", () => {
      const samples = [
        [
          rateParams(["ETH", 18], 2000000000000000000n, ["USDC", 6], 6000123456n),
          3000061728n,
          "1 ETH = 3,000.0617 USDC",
        ],
        [
          rateParams(["USDC", 6], 3000000000n, ["ETH", 18], 1000000000000000000n),
          333333333333333n,
          "1 USDC = 0.0003 ETH",
        ],
        [
          rateParams(["WBTC", 8], 50000000n, ["USDC", 6], 50000123456n),
          100000246912n,
          "1 WBTC = 100,000.2469 USDC",
        ],
        [
          rateParams(["USDC", 6], 3000000n, ["DAI", 18], 2000000000000000000n),
          666666666666666666n,
          "1 USDC = 0.6666 DAI",
        ],
        [rateParams(["USDC", 6], 1000000n, ["WBTC", 8], 1500n), 1500n, "1 USDC = <0.0001 WBTC"],
        [
          rateParams(["USDC", 6], 2000000n, ["USDT", 6], 2469999n),
          1234999n,
          "1 USDC = 1.2349 USDT",
        ],
      ] as const;

      for (const [params, expectedRaw, expectedRow] of samples) {
        const label = `${params.tokenIn.symbol} ${params.amountIn} → ${params.tokenOut.symbol} ${params.amountOut}`;
        expect(getQuoteRateRaw(params), label).toBe(expectedRaw);

        const row = formatQuoteRate(params);
        expect(row, label).toBe(expectedRow);
        // 값 자리는 `formatTokenAmount` 형식이다: 천 단위 쉼표, 소수점 마침표, 소수 1~4자리이며 끝이 0이 아니거나 `<0.0001`.
        const valuePart = row
          .slice(`1 ${params.tokenIn.symbol} = `.length)
          .slice(0, -` ${params.tokenOut.symbol}`.length);
        expect(valuePart, label).toMatch(FORMAT_TOKEN_AMOUNT_PATTERN);
      }
    });
  });

  describe("로캘과 무관한 표시", () => {
    /**
     * @spec DoD-24
     * @given 기본 로캘이 `en-US`인 환경과 소수점이 쉼표·천 단위 구분이 마침표인 `de-DE`가 기본 로캘인 환경(로캘 API 기본 결과가 그 로캘임을 먼저 확인)에서 각각, 가격 영향 bps `1234.567`·`0.5`·`-0.5`, 수수료 티어 `100`·`500`·`3000`·`10000`, 환율 표본 (WBTC·8, `50000000`, USDC·6, `50000123456`)·(USDC·6, `3000000`, DAI·18, `2000000000000000000`)을 하나씩 반복한다
     * @when 가격 영향·수수료 티어·환율 행 표시 문자열을 만든다
     * @then 결과는 표본 순서대로 `12.34%`, `<0.01%`, `0.00%`, `0.01%`, `0.05%`, `0.3%`, `1%`, `1 WBTC = 100,000.2469 USDC`, `1 USDC = 0.6666 DAI`이다
     * @then 두 로캘 환경의 결과가 표본마다 같다
     */
    it("[DoD-24] 표시 문자열은 기본 로캘이 de-DE여도 en-US와 같다", () => {
      const priceImpactSamples = [1234.567, 0.5, -0.5];
      const feeSamples: readonly FeeTier[] = [100, 500, 3000, 10000];
      const rateSamples = [
        rateParams(["WBTC", 8], 50000000n, ["USDC", 6], 50000123456n),
        rateParams(["USDC", 6], 3000000n, ["DAI", 18], 2000000000000000000n),
      ];
      const expected = [
        "12.34%",
        "<0.01%",
        "0.00%",
        "0.01%",
        "0.05%",
        "0.3%",
        "1%",
        "1 WBTC = 100,000.2469 USDC",
        "1 USDC = 0.6666 DAI",
      ];

      const resultsByLocale = new Map<string, string[]>();
      for (const locale of ["en-US", "de-DE"] as const) {
        const results = withDefaultLocale(locale, () => {
          expect(new Intl.NumberFormat().format(1234.5), `${locale} 환경 확인`).toBe(
            LOCALE_PROBES[locale].number,
          );
          expect((1234.5).toLocaleString(), `${locale} 환경 확인`).toBe(
            LOCALE_PROBES[locale].number,
          );
          expect(1234n.toLocaleString(), `${locale} 환경 확인`).toBe(LOCALE_PROBES[locale].bigint);
          return [
            ...priceImpactSamples.map((bps) => formatPriceImpact(bps)),
            ...feeSamples.map((fee) => formatFeeTier(fee)),
            ...rateSamples.map((params) => formatQuoteRate(params)),
          ];
        });

        expect(results, `${locale} 환경 결과`).toEqual(expected);
        resultsByLocale.set(locale, results);
      }

      expect(resultsByLocale.get("de-DE")).toEqual(resultsByLocale.get("en-US"));
    });
  });
});
