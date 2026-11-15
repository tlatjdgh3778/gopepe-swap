import { describe, expect, it, vi } from "vitest";

import { getAmountOutMinimum, type SlippageBps } from "@/lib/slippage";

// 스펙 §4.1의 프리셋 값. 제품 상수가 아니라 스펙 값에서 가져온다.
const SPEC_PRESETS_BPS: readonly SlippageBps[] = [10, 50, 100];

type LocaleArgument = string | string[] | undefined;

type LocaleApiCalls = {
  numberFormat: number;
  numberToLocaleString: number;
  bigintToLocaleString: number;
};

const NO_LOCALE_API_CALLS: LocaleApiCalls = {
  numberFormat: 0,
  numberToLocaleString: 0,
  bigintToLocaleString: 0,
};

/**
 * DoD-16 전용 로캘 스텁(T-5 mock 경계 예외). `Intl.NumberFormat`과 Number·BigInt의 `toLocaleString`이
 * 로캘 인자 없이 호출되면 `locale`을 쓰게 바꾸고, 로캘을 명시한 호출까지 포함해 호출 수를 `calls`에 센다.
 * `run`이 끝나면(예외가 나도) 원래대로 되돌린다. `__tests__/lib/quote-format.test.ts` DoD-24 스텁과 같은 방식이다.
 */
async function withCountingDefaultLocale<T>(
  locale: string,
  run: (calls: LocaleApiCalls) => Promise<T>,
): Promise<T> {
  const intlDescriptor = Object.getOwnPropertyDescriptor(Intl, "NumberFormat");
  const OriginalNumberFormat = Intl.NumberFormat;
  const originalNumberToLocaleString = Number.prototype.toLocaleString;
  const originalBigIntToLocaleString = BigInt.prototype.toLocaleString;
  const calls: LocaleApiCalls = { ...NO_LOCALE_API_CALLS };

  function CountingNumberFormat(
    locales?: LocaleArgument,
    options?: Intl.NumberFormatOptions,
  ): Intl.NumberFormat {
    calls.numberFormat += 1;
    return new OriginalNumberFormat(locales ?? locale, options);
  }
  CountingNumberFormat.prototype = OriginalNumberFormat.prototype;
  CountingNumberFormat.supportedLocalesOf = OriginalNumberFormat.supportedLocalesOf;

  Object.defineProperty(Intl, "NumberFormat", {
    ...intlDescriptor,
    value: CountingNumberFormat,
  });
  Number.prototype.toLocaleString = function (
    this: number,
    locales?: LocaleArgument,
    options?: Intl.NumberFormatOptions,
  ) {
    calls.numberToLocaleString += 1;
    return originalNumberToLocaleString.call(this, locales ?? locale, options);
  };
  BigInt.prototype.toLocaleString = function (
    this: bigint,
    locales?: LocaleArgument,
    options?: BigIntToLocaleStringOptions,
  ) {
    calls.bigintToLocaleString += 1;
    return originalBigIntToLocaleString.call(this, locales ?? locale, options);
  } as typeof BigInt.prototype.toLocaleString;

  try {
    return await run(calls);
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

// 이 파일은 최소 수령량 계산과 슬리피지 허용치 표기의 순수 규칙만 다룬다.
// 화면의 `data-amount-out-minimum-raw`·`data-slippage-bps`와 훅 계약은 통합 테스트(T-6·T-7)가 다룬다.
// 기대값은 스펙 DoD-15 식 `amountOut * (10000n - bps) / 10000n`(내림)으로 테스트 작성 시점에 계산한 bigint 리터럴이다.
describe("슬리피지 허용치 — 예상 수령량에서 허용 하락폭만큼 내린 최소 수령량을 계산하고 허용치를 로캘과 무관하게 표기한다", () => {
  describe("최소 수령량 계산", () => {
    /**
     * @spec DoD-15
     * @given 예상 수령량 표본 `10000n`(나누어떨어짐), `12345n`, `199n`(나누어떨어지지 않음) 각각에 대해 슬리피지 프리셋 `10`·`50`·`100` bps를 하나씩 반복한다
     * @when 최소 수령량을 계산한다
     * @then 결과는 bigint이며 `amountOut * (10000n - bps) / 10000n`을 내림한 값이다
     * @then 결과는 표본 순서대로 `9990n`, `9950n`, `9900n`, `12332n`, `12283n`, `12221n`, `198n`, `198n`, `197n`이다
     */
    it("[DoD-15] 최소 수령량은 예상 수령량에 (10000 - bps) / 10000을 곱해 내림한 bigint다", () => {
      const amountOutSamples = [10000n, 12345n, 199n];
      const expected = [9990n, 9950n, 9900n, 12332n, 12283n, 12221n, 198n, 198n, 197n];

      const results: bigint[] = [];
      for (const amountOut of amountOutSamples) {
        for (const bps of SPEC_PRESETS_BPS) {
          const result = getAmountOutMinimum(amountOut, bps);
          const label = `amountOut ${amountOut}, ${bps} bps`;

          expect(typeof result, label).toBe("bigint");
          // 스펙 식을 테스트 쪽 bigint 연산으로 계산한 값(bigint 나눗셈은 내림)과 같다.
          expect(result, label).toBe((amountOut * (10000n - BigInt(bps))) / 10000n);
          results.push(result);
        }
      }

      expect(results).toEqual(expected);
    });
  });

  describe("값 경계", () => {
    /**
     * @spec EC-1
     * @given 예상 수령량 `1n`에 대해 슬리피지 프리셋 `10`·`50`·`100` bps를 하나씩 반복한다
     * @when 최소 수령량을 계산한다
     * @then 세 프리셋 모두 결과는 `0n`이다
     */
    it("[EC-1] 예상 수령량이 1이면 세 프리셋 모두 최소 수령량이 0이다", () => {
      for (const bps of SPEC_PRESETS_BPS) {
        expect(getAmountOutMinimum(1n, bps), `${bps} bps`).toBe(0n);
      }
    });

    /**
     * @spec EC-3
     * @given 예상 수령량 `2n ** 256n - 1n`에 대해 슬리피지 프리셋 `10`·`50`·`100` bps를 하나씩 반복한다
     * @when 최소 수령량을 계산한다
     * @then 결과는 정밀도 손실 없이 내림한 bigint로, 표본 순서대로 `115676297148078879228147414023679219945416714680974923475418126423905216510295n`, `115213128791129614446453130083644468314003634742312361219260296087873563991735n`, `114634168344943033469335275158601028774737284818984158399063008167833998343535n`이다
     */
    it("[EC-3] 예상 수령량이 2^256 - 1이어도 세 프리셋 모두 정밀도 손실 없이 내림한다", () => {
      const amountOut = 2n ** 256n - 1n;
      const expected = [
        115676297148078879228147414023679219945416714680974923475418126423905216510295n,
        115213128791129614446453130083644468314003634742312361219260296087873563991735n,
        114634168344943033469335275158601028774737284818984158399063008167833998343535n,
      ];

      const results = SPEC_PRESETS_BPS.map((bps) => getAmountOutMinimum(amountOut, bps));

      for (const result of results) {
        expect(typeof result).toBe("bigint");
      }
      expect(results).toEqual(expected);
    });
  });

  describe("허용치 표기", () => {
    /**
     * @spec DoD-16
     * @given 기본 로캘이 `en-US`인 환경과 소수점이 쉼표·천 단위 구분이 마침표인 `de-DE`가 기본 로캘인 환경(로캘 API 기본 결과가 그 로캘임을 먼저 확인)에서 각각, 로캘 스텁이 `Intl.NumberFormat` 생성과 `Number`·`BigInt`의 `toLocaleString` 호출을 로캘 명시 여부와 관계없이 세고, 스텁을 설치한 뒤 모듈 캐시를 초기화하고 슬리피지 모듈을 동적 import로 새로 평가한다는 조건으로 슬리피지 프리셋 `10`·`50`·`100` bps를 하나씩 반복한다
     * @when 슬리피지 허용치 표기 문자열을 만든다
     * @then 결과는 표본 순서대로 소수 1자리 고정 퍼센트 `0.1%`, `0.5%`, `1.0%`이다
     * @then 두 로캘 환경의 결과가 표본마다 같다
     * @then 카운팅 스텁을 설치한 뒤 슬리피지 모듈을 새로 평가하는 시점부터 세 프리셋 표기를 끝낼 때까지 `Intl.NumberFormat` 생성과 `Number`·`BigInt`의 `toLocaleString` 호출이 0회다(로캘을 명시해 넘긴 호출도 센다)
     */
    it("[DoD-16] 허용치 표기는 소수 1자리 고정 퍼센트이고 기본 로캘이 de-DE여도 en-US와 같으며 로캘 API를 호출하지 않는다", async () => {
      const expected = ["0.1%", "0.5%", "1.0%"];

      const resultsByLocale = new Map<string, string[]>();
      for (const locale of ["en-US", "de-DE"] as const) {
        const results = await withCountingDefaultLocale(locale, async (calls) => {
          // 전제 확인: 로캘 인자 없는 기본 결과가 그 로캘이다.
          expect(new Intl.NumberFormat().format(1234.5), `${locale} 환경 확인`).toBe(
            LOCALE_PROBES[locale].number,
          );
          expect((1234.5).toLocaleString(), `${locale} 환경 확인`).toBe(
            LOCALE_PROBES[locale].number,
          );
          expect(1234n.toLocaleString(), `${locale} 환경 확인`).toBe(LOCALE_PROBES[locale].bigint);
          // 전제 확인: 로캘을 명시한 호출도 센다.
          new Intl.NumberFormat("en-US").format(1);
          (1).toLocaleString("en-US");
          1n.toLocaleString("en-US");
          expect(calls, `${locale} 환경 카운터 확인`).toEqual({
            numberFormat: 2,
            numberToLocaleString: 2,
            bigintToLocaleString: 2,
          });

          // 집계 구간 시작: 카운터를 비우고 슬리피지 모듈을 스텁 아래에서 새로 평가한다.
          Object.assign(calls, NO_LOCALE_API_CALLS);
          vi.resetModules();
          const { formatSlippageBps } = await import("@/lib/slippage");
          const formatted = SPEC_PRESETS_BPS.map((bps) => formatSlippageBps(bps));
          // 집계 구간 끝.
          expect({ ...calls }, `${locale} 환경 로캘 API 호출 수`).toEqual(NO_LOCALE_API_CALLS);

          return formatted;
        });

        expect(results, `${locale} 환경 결과`).toEqual(expected);
        resultsByLocale.set(locale, results);
      }

      expect(resultsByLocale.get("de-DE")).toEqual(resultsByLocale.get("en-US"));
    });
  });
});
