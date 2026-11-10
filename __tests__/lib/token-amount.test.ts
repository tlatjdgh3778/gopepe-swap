import { parseUnits, type Address } from "viem";
import { describe, expect, it } from "vitest";

import type { SupportedChainId } from "@/config/chains";

import { NATIVE_ETH_ADDRESS, PINNED_TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import {
  formatMaxAmount,
  formatTokenAmount,
  sanitizeAmountInput,
  truncateAmountDecimals,
} from "@/lib/token-amount";

// 스펙 §1.1: ETH `최대`의 체인별 가스 예약량(wei). 제품 config가 아니라 스펙 값에서 가져온다.
const SPEC_GAS_RESERVE: Record<SupportedChainId, bigint> = {
  1: 5_000_000_000_000_000n,
  8453: 500_000_000_000_000n,
  42161: 500_000_000_000_000n,
};

// 고정 토큰이 아닌 ERC-20. decimals는 표본마다 다르다.
const ERC20_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const erc20 = (decimals: number): Pick<Token, "address" | "decimals"> => ({
  address: ERC20_ADDRESS,
  decimals,
});

function ethOf(chainId: SupportedChainId): Token {
  const eth = PINNED_TOKENS_BY_CHAIN[chainId].find((token) => token.symbol === "ETH");
  if (!eth) throw new Error(`체인 ${chainId}의 고정 ETH가 없다`);
  expect(eth.address).toBe(NATIVE_ETH_ADDRESS);
  return eth;
}

type LocaleArgument = string | string[] | undefined;

/**
 * DoD-15 전용 로캘 스텁(T-5 mock 경계 예외). `Intl.NumberFormat`과 Number·BigInt의 `toLocaleString`이
 * 로캘 인자 없이 호출되면 `locale`을 쓰게 바꾸고, `run`이 끝나면(예외가 나도) 원래대로 되돌린다.
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

// 이 파일은 표시·입력 정리·decimals 자르기·`최대` 문자열의 순수 규칙만 다룬다.
// 이전 값 유지·모달에서 토큰을 바꿀 때 금액 유지는 통합 테스트(T-6), `최대` 버튼 흐름은 E2E(T-8)가 다룬다.
describe("금액과 잔액 — 잔액을 로캘과 무관하게 보이고, 형식에 맞는 금액만 받는다", () => {
  describe("잔액 표시", () => {
    /**
     * @spec DoD-15
     * @given (정수 잔액, decimals) 표본 `1234567891234567890000`(18), `999999999`(6), `1500000`(6), `1000000`(6), `1234567`(0), `1000000000000000000000000`(18), `100000000000000`(18), `190000000000000`(18), `123456789012345678901234567890`(18), `12345`(2), `123456789`(2)을 기본 로캘이 `en-US`인 환경과 소수점이 쉼표·천 단위 구분이 마침표인 `de-DE`가 기본 로캘인 환경에서 각각 하나씩 반복한다
     * @when 잔액 표시 문자열을 만든다
     * @then 표본 순서대로 `1,234.5678`, `999.9999`, `1.5`, `1`, `1,234,567`, `1,000,000`, `0.0001`, `0.0001`, `123,456,789,012.3456`, `123.45`, `1,234,567.89`이다
     * @then 소수는 최대 4자리까지 반올림 없이 버리고, 끝의 0을 지우며, 천 단위 구분은 쉼표, 소수점은 마침표다
     * @then 두 로캘 환경의 결과가 표본마다 같다
     */
    it("[DoD-15] 잔액은 소수 4자리 버림·끝의 0 제거·천 단위 쉼표·소수점 마침표로 로캘과 무관하게 표시한다", () => {
      const samples = [
        [1234567891234567890000n, 18, "1,234.5678"],
        [999999999n, 6, "999.9999"],
        [1500000n, 6, "1.5"],
        [1000000n, 6, "1"],
        [1234567n, 0, "1,234,567"],
        [1000000000000000000000000n, 18, "1,000,000"],
        [100000000000000n, 18, "0.0001"],
        [190000000000000n, 18, "0.0001"],
        [123456789012345678901234567890n, 18, "123,456,789,012.3456"],
        [12345n, 2, "123.45"],
        [123456789n, 2, "1,234,567.89"],
      ] as const;
      // 천 단위 쉼표, 소수점 마침표, 소수 1~4자리이며 끝이 0이 아니다.
      const displayPattern = /^\d{1,3}(,\d{3})*(\.\d{0,3}[1-9])?$/;

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
          return samples.map(([raw, decimals]) => formatTokenAmount(raw, decimals));
        });

        samples.forEach(([raw, decimals, expected], index) => {
          const label = `${locale} 환경의 ${raw}(${decimals})`;
          expect(results[index], label).toBe(expected);
          expect(results[index], label).toMatch(displayPattern);
        });
        resultsByLocale.set(locale, results);
      }

      expect(resultsByLocale.get("de-DE")).toEqual(resultsByLocale.get("en-US"));
    });

    /**
     * @spec DoD-16
     * @given (정수 잔액, decimals) 표본 `1`(18), `99999999999999`(18), `1`(6), `99`(6)처럼 값이 0보다 크고 0.0001보다 작은 경우를 하나씩 반복한다
     * @when 잔액 표시 문자열을 만든다
     * @then 표시는 `<0.0001`이다
     */
    it("[DoD-16] 0보다 크고 0.0001보다 작은 잔액은 <0.0001로 표시한다", () => {
      const samples = [
        [1n, 18],
        [99999999999999n, 18],
        [1n, 6],
        [99n, 6],
      ] as const;

      for (const [raw, decimals] of samples) {
        expect(formatTokenAmount(raw, decimals), `${raw}(${decimals})`).toBe("<0.0001");
      }
    });

    /**
     * @spec DoD-16
     * @given 정수 잔액이 `0`이고 decimals가 18, 6, 0인 경우를 하나씩 반복한다
     * @when 잔액 표시 문자열을 만든다
     * @then 표시는 `0`이다
     */
    it("[DoD-16] 0인 잔액은 0으로 표시한다", () => {
      for (const decimals of [18, 6, 0]) {
        expect(formatTokenAmount(0n, decimals), `0(${decimals})`).toBe("0");
      }
    });
  });

  describe("금액 입력 — 형식에 맞는 입력", () => {
    /**
     * @spec DoD-27
     * @given (입력, decimals) 표본 ``(18, 입력을 모두 지운 빈 문자열), `0`(18), `123`(18), `007`(18), `1.5`(18), `.5`(18), `1.`(18), `.`(18), `0.00`(18), `1.123456`(6), `12`(0), `12.`(0)을 하나씩 반복한다
     * @when 금액 입력을 정리한다
     * @then 입력은 거부되지 않는다
     * @then 반영할 문자열은 입력 문자열과 같다
     */
    it("[DoD-27] 숫자와 소수점 하나로 된 입력을 그대로 금액에 반영한다", () => {
      const samples = [
        ["", 18],
        ["0", 18],
        ["123", 18],
        ["007", 18],
        ["1.5", 18],
        [".5", 18],
        ["1.", 18],
        [".", 18],
        ["0.00", 18],
        ["1.123456", 6],
        ["12", 0],
        ["12.", 0],
      ] as const;

      for (const [input, decimals] of samples) {
        const label = `${JSON.stringify(input)}(${decimals})`;
        const result = sanitizeAmountInput(input, decimals);
        expect(result, label).not.toBeNull();
        expect(result, label).toBe(input);
      }
    });

    /**
     * @spec DoD-28
     * @given (입력, decimals) 표본 `1,5`(18), `,5`(18), `1,`(18), `,`(18), `1234,56`(18), `1,234`(18), `0,123456`(6)을 하나씩 반복한다
     * @when 금액 입력을 정리한다
     * @then 입력은 거부되지 않는다
     * @then 반영할 문자열은 표본 순서대로 `1.5`, `.5`, `1.`, `.`, `1234.56`, `1.234`, `0.123456`이다
     */
    it("[DoD-28] 입력한 쉼표는 소수점으로 바뀌어 반영된다", () => {
      const samples = [
        ["1,5", 18, "1.5"],
        [",5", 18, ".5"],
        ["1,", 18, "1."],
        [",", 18, "."],
        ["1234,56", 18, "1234.56"],
        ["1,234", 18, "1.234"],
        ["0,123456", 6, "0.123456"],
      ] as const;

      for (const [input, decimals, expected] of samples) {
        const label = `${JSON.stringify(input)}(${decimals})`;
        const result = sanitizeAmountInput(input, decimals);
        expect(result, label).not.toBeNull();
        expect(result, label).toBe(expected);
      }
    });

    /**
     * @spec EC-27
     * @given (입력, decimals) 표본 `9`를 80번 이은 문자열(18), 그 뒤에 `.5`를 붙인 문자열(18), `1` 뒤에 `0`을 99번 이은 문자열(0)을 하나씩 반복한다
     * @when 금액 입력을 정리한다
     * @then 입력은 거부되지 않는다
     * @then 반영할 문자열은 입력 문자열과 같다
     */
    it("[EC-27] 정수부 길이에 상한이 없어 아주 긴 정수부도 금액에 반영한다", () => {
      const samples = [
        ["9".repeat(80), 18],
        [`${"9".repeat(80)}.5`, 18],
        [`1${"0".repeat(99)}`, 0],
      ] as const;

      for (const [input, decimals] of samples) {
        const label = `길이 ${input.length} 입력(${decimals})`;
        const result = sanitizeAmountInput(input, decimals);
        expect(result, label).not.toBeNull();
        expect(result, label).toBe(input);
      }
    });
  });

  describe("금액 입력 — 형식에 맞지 않는 입력", () => {
    /**
     * @spec EC-20
     * @given (입력, decimals) 표본 `1.1234567`(6), `1,1234567`(6), `1.5`(0), `.5`(0), `0,1`(0), `0.0000000000000000001`(18)처럼 소수 자릿수가 토큰 decimals를 넘는 입력을 하나씩 반복한다
     * @when 금액 입력을 정리한다
     * @then 입력은 거부되어 반영할 문자열이 없다(`null`)
     */
    it("[EC-20] 토큰 decimals를 넘는 소수 자릿수 입력은 반영하지 않는다", () => {
      const samples = [
        ["1.1234567", 6],
        ["1,1234567", 6],
        ["1.5", 0],
        [".5", 0],
        ["0,1", 0],
        ["0.0000000000000000001", 18],
      ] as const;

      for (const [input, decimals] of samples) {
        expect(sanitizeAmountInput(input, decimals), `${input}(${decimals})`).toBeNull();
      }
    });

    /**
     * @spec EC-21
     * @given decimals 18에서 입력 표본 `abc`, `1a`, `a1`, `-1`, `+1`, `1e5`, ` 1`, `1 `, `1 000`, `1_000`, `0x1`, `1.2.3`, `1..2`, `..`, `1.2,3`, `1,2,3`, `1,,`처럼 숫자·소수점·쉼표 외의 문자나 두 번째 소수점(쉼표가 바뀐 소수점 포함)이 든 입력을 하나씩 반복한다
     * @when 금액 입력을 정리한다
     * @then 입력은 거부되어 반영할 문자열이 없다(`null`)
     */
    it("[EC-21] 숫자·소수점·쉼표 외의 문자나 두 번째 소수점이 든 입력은 반영하지 않는다", () => {
      const samples = [
        "abc",
        "1a",
        "a1",
        "-1",
        "+1",
        "1e5",
        " 1",
        "1 ",
        "1 000",
        "1_000",
        "0x1",
        "1.2.3",
        "1..2",
        "..",
        "1.2,3",
        "1,2,3",
        "1,,",
      ];

      for (const input of samples) {
        expect(sanitizeAmountInput(input, 18), JSON.stringify(input)).toBeNull();
      }
    });
  });

  describe("보내는 토큰을 바꿀 때 금액의 소수 자릿수", () => {
    /**
     * @spec DoD-29
     * @given (금액, 새 토큰 decimals) 표본 `1.123456789`(6), `0.9999999`(6), `0.000000000000000001`(6), `1.239`(2), `1.123456`(6), `1.5`(6), `1.`(6), `123`(2)을 하나씩 반복한다
     * @when 금액을 새 토큰 decimals에 맞춘다
     * @then 결과는 표본 순서대로 `1.123456`, `0.999999`, `0.000000`, `1.23`, `1.123456`, `1.5`, `1.`, `123`이다
     * @then 새 decimals를 넘는 소수 자릿수만 반올림 없이 잘리고, 넘지 않는 금액은 그대로 유지된다
     */
    it("[DoD-29] 금액을 유지하고 새 토큰 decimals를 넘는 소수 자릿수를 반올림 없이 잘라낸다", () => {
      const samples = [
        ["1.123456789", 6, "1.123456"],
        ["0.9999999", 6, "0.999999"],
        ["0.000000000000000001", 6, "0.000000"],
        ["1.239", 2, "1.23"],
        ["1.123456", 6, "1.123456"],
        ["1.5", 6, "1.5"],
        ["1.", 6, "1."],
        ["123", 2, "123"],
      ] as const;

      for (const [amount, decimals, expected] of samples) {
        const label = `${amount}(${decimals})`;
        const result = truncateAmountDecimals(amount, decimals);
        expect(result, label).toBe(expected);

        const dotIndex = amount.indexOf(".");
        const fractionLength = dotIndex === -1 ? 0 : amount.length - dotIndex - 1;
        if (fractionLength <= decimals) {
          // 넘지 않는 금액은 그대로다.
          expect(result, label).toBe(amount);
        } else {
          // 넘는 자릿수만 잘린 원문 앞부분이다(반올림하면 앞부분이 아니게 된다).
          expect(result, label).toBe(amount.slice(0, dotIndex + 1 + decimals));
        }
      }
    });

    /**
     * @spec EC-29
     * @given 새 토큰 decimals가 0이고 금액 표본 `1.5`, `1.999`, `12.0`, `0.5`를 하나씩 반복한다
     * @when 금액을 새 토큰 decimals에 맞춘다
     * @then 결과는 표본 순서대로 `1`, `1`, `12`, `0`이다
     * @then 결과에 소수점이 남지 않는다
     */
    it("[EC-29] 소수부가 모두 잘리면 소수점도 지운다", () => {
      const samples = [
        ["1.5", "1"],
        ["1.999", "1"],
        ["12.0", "12"],
        ["0.5", "0"],
      ] as const;

      for (const [amount, expected] of samples) {
        const result = truncateAmountDecimals(amount, 0);
        expect(result, amount).toBe(expected);
        expect(result, amount).not.toContain(".");
      }
    });
  });

  describe("`최대`로 넣는 금액", () => {
    /**
     * @spec DoD-30
     * @given ERC-20의 (정수 잔액, decimals) 표본 `1234567`(6), `123456789012345678`(6), `1234567890123456789`(18), `123456789012345678901234567890`(18), `42`(0), `1`(18)을 하나씩 반복한다
     * @when `최대` 금액 문자열을 만든다
     * @then 결과는 표본 순서대로 `1.234567`, `123456789012.345678`, `1.234567890123456789`, `123456789012.34567890123456789`, `42`, `0.000000000000000001`이다
     * @then 결과를 같은 decimals로 정수로 바꾸면 잔액 정수와 같다
     */
    it("[DoD-30] ERC-20의 최대는 잔액 전체를 정밀도 손실 없이 넣는다", () => {
      const samples = [
        [1234567n, 6, "1.234567"],
        [123456789012345678n, 6, "123456789012.345678"],
        [1234567890123456789n, 18, "1.234567890123456789"],
        [123456789012345678901234567890n, 18, "123456789012.34567890123456789"],
        [42n, 0, "42"],
        [1n, 18, "0.000000000000000001"],
      ] as const;

      for (const [balance, decimals, expected] of samples) {
        const label = `${balance}(${decimals})`;
        const result = formatMaxAmount(balance, erc20(decimals), 1);
        expect(result, label).toBe(expected);
        expect(parseUnits(result, decimals), label).toBe(balance);
      }
    });

    /**
     * @spec DoD-31
     * @given ETH의 (선택 체인, 정수 잔액) 표본 Ethereum(1) `1000000000000000000`, Base(8453) `1000000000000000000`, Arbitrum(42161) `1000000000000000000`, Ethereum(1) `5000000000000000001`, Base(8453) `5000000000000000001`을 하나씩 반복한다
     * @when `최대` 금액 문자열을 만든다
     * @then 결과는 표본 순서대로 `0.995`, `0.9995`, `0.9995`, `4.995000000000000001`, `4.999500000000000001`이다
     * @then 결과를 decimals 18로 정수로 바꾸면 잔액에서 선택 체인의 가스 예약량(Ethereum 0.005 ETH, Base 0.0005 ETH, Arbitrum 0.0005 ETH)을 뺀 값과 같다
     */
    it("[DoD-31] ETH의 최대는 잔액에서 선택 체인의 가스 예약량을 뺀 값을 넣는다", () => {
      const samples = [
        [1, 1000000000000000000n, "0.995"],
        [8453, 1000000000000000000n, "0.9995"],
        [42161, 1000000000000000000n, "0.9995"],
        [1, 5000000000000000001n, "4.995000000000000001"],
        [8453, 5000000000000000001n, "4.999500000000000001"],
      ] as const;

      for (const [chainId, balance, expected] of samples) {
        const label = `체인 ${chainId} 잔액 ${balance}`;
        const result = formatMaxAmount(balance, ethOf(chainId), chainId);
        expect(result, label).toBe(expected);
        expect(parseUnits(result, 18), label).toBe(balance - SPEC_GAS_RESERVE[chainId]);
      }
    });

    /**
     * @spec DoD-32
     * @given 표본 ERC-20 `1234567000000`(decimals 6), ERC-20 `1234567500000`(decimals 6), ETH Ethereum(1) `1000005000000000000000`, ETH Base(8453) `1234500500000000000000`을 하나씩 반복한다
     * @when `최대` 금액 문자열을 만든다
     * @then 결과는 표본 순서대로 `1234567`, `1234567.5`, `1000`, `1234.5`이다
     * @then 결과에 천 단위 쉼표가 없고 소수부 끝에 0이 없다
     */
    it("[DoD-32] 최대가 넣는 문자열은 천 단위 쉼표가 없고 끝의 0을 지운 값이다", () => {
      const samples = [
        [erc20(6), 1, 1234567000000n, "1234567"],
        [erc20(6), 1, 1234567500000n, "1234567.5"],
        [ethOf(1), 1, 1000005000000000000000n, "1000"],
        [ethOf(8453), 8453, 1234500500000000000000n, "1234.5"],
      ] as const;

      for (const [token, chainId, balance, expected] of samples) {
        const label = `체인 ${chainId} 잔액 ${balance}(${token.decimals})`;
        const result = formatMaxAmount(balance, token, chainId);
        expect(result, label).toBe(expected);
        expect(result, label).not.toContain(",");
        // 소수부 끝의 0이 없고, 소수부가 모두 0이어서 소수점만 남는 경우도 없다.
        expect(result, label).not.toMatch(/\.\d*0$/);
        expect(result, label).not.toMatch(/\.$/);
      }
    });

    /**
     * @spec EC-24
     * @given 표본 ETH Ethereum(1) 잔액 `0`, `1`, `4000000000000000`, `5000000000000000`, ETH Base(8453) 잔액 `0`, `100000000000000`, `500000000000000`, ETH Arbitrum(42161) 잔액 `500000000000000`, ERC-20 잔액 `0`(decimals 6), `0`(decimals 18)처럼 잔액이 가스 예약량 이하이거나 0인 경우를 하나씩 반복한다
     * @when `최대` 금액 문자열을 만든다
     * @then 결과는 `0`이다
     */
    it("[EC-24] 잔액이 가스 예약량 이하이거나 0이면 최대는 0을 넣는다", () => {
      const samples = [
        [ethOf(1), 1, 0n],
        [ethOf(1), 1, 1n],
        [ethOf(1), 1, 4000000000000000n],
        [ethOf(1), 1, 5000000000000000n],
        [ethOf(8453), 8453, 0n],
        [ethOf(8453), 8453, 100000000000000n],
        [ethOf(8453), 8453, 500000000000000n],
        [ethOf(42161), 42161, 500000000000000n],
        [erc20(6), 1, 0n],
        [erc20(18), 1, 0n],
      ] as const;

      for (const [token, chainId, balance] of samples) {
        const label = `체인 ${chainId} 잔액 ${balance}(${token.decimals})`;
        expect(formatMaxAmount(balance, token, chainId), label).toBe("0");
      }
    });
  });
});
