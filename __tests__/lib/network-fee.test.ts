import { describe, expect, it } from "vitest";

import { formatEthFee, getNetworkFeeSeverity, isEthShortage } from "@/lib/network-fee";

// 골격(T-7). 네트워크 수수료의 ETH 표기, 수수료 경고 판정, ETH 부족 판정의 순수 규칙만 다룬다.
// 판정 방법: 정적 표본을 순수 함수에 넣고 결과를 스펙 리터럴이나 테스트 쪽 계산과 비교한다. 기대값은 구현 출력에서 베끼지 않는다.
// mock 경계: 없음(순수 함수). vi.mock·스텁·타이머를 쓰지 않는다.
// 데이터 격리: 정적 데이터만 쓰며 표본 사이에 공유 상태가 없다.
// DoD-24·EC-20·EC-21·EC-23의 화면·provider 쪽(단가 없음 stub, `network-fee-warning` 부재, 추정 loading·error 중 안내)은 통합 테스트가 다룬다.

// ─── 표본 상수(리터럴) ───────────────────────────────────────────────
// 경고 기준 500 bps와 기대값은 스펙 리터럴로 적고 제품 config에서 가져오지 않는다.

const ONE_ETH = 10n ** 18n;
// 보내는 금액 $100(USD micros). bps 표본은 수수료 USD micros = bps × 10_000으로 만든다.
const HUNDRED_USD_MICROS = 100_000_000n;
// 수수료 표본 0.0004 ETH, 보내는 ETH 표본 0.1 ETH.
const FEE_WEI = 400_000_000_000_000n;
const VALUE_WEI = 100_000_000_000_000_000n;

type FormatSample = { wei: bigint; expected: string };
type ShortageSample = {
  label: string;
  ethBalance: bigint | null;
  feeWei: bigint | null;
  valueWei: bigint;
};

function expectFormats(samples: readonly FormatSample[]): void {
  for (const { wei, expected } of samples) {
    expect(formatEthFee(wei), `${wei} wei`).toBe(expected);
  }
}

function expectShortage(samples: readonly ShortageSample[], expected: boolean): void {
  for (const { label, ethBalance, feeWei, valueWei } of samples) {
    expect(isEthShortage({ ethBalance, feeWei, valueWei }), label).toBe(expected);
  }
}

describe("네트워크 수수료 — 수수료를 ETH로 읽기 쉽게 보이고, 큰 수수료와 ETH 부족을 알린다", () => {
  describe("ETH 수수료 표기", () => {
    /**
     * @spec DoD-16
     * @given 1 ETH 미만 표본 420987000000000 wei(0.000420987 ETH), 123456789012345678 wei, 999999999999999999 wei(1 ETH 경계 바로 아래), 123400000000 wei(0.0000001234 ETH, 유효숫자 4자리가 소수 8자리를 넘음), 10^10 wei(0.00000001 ETH), 19999999999 wei를 하나씩 넣는다
     * @when 수수료 wei를 ETH 표기 문자열로 바꾼다
     * @then 첫 유효숫자부터 4자리까지 버림한 값이 나온다(`0.0004209`, `0.1234`, `0.9999`)
     * @then 소수는 최대 8자리까지만 남긴다(`0.00000012`, `0.00000001`, `0.00000001`)
     * @then 단위 기호(` ETH`)가 붙지 않는다
     */
    it("[DoD-16] 1 ETH 미만은 유효숫자 4자리 버림, 소수 최대 8자리로 표시한다", () => {
      const samples: readonly FormatSample[] = [
        // 유효숫자 4자리 버림
        { wei: 420_987_000_000_000n, expected: "0.0004209" },
        { wei: 123_456_789_012_345_678n, expected: "0.1234" },
        { wei: ONE_ETH - 1n, expected: "0.9999" },
        // 소수 최대 8자리
        { wei: 123_400_000_000n, expected: "0.00000012" },
        { wei: 10n ** 10n, expected: "0.00000001" },
        { wei: 19_999_999_999n, expected: "0.00000001" },
      ];
      expectFormats(samples);
      for (const { wei } of samples) {
        expect(formatEthFee(wei), `${wei} wei: 단위 기호 없음`).not.toMatch(/ETH/);
      }
    });

    /**
     * @spec DoD-50
     * @given 끝자리 0이 생기는 표본 420000000000000 wei(0.00042 ETH), 500000000000000000 wei(0.5 ETH), 100099999999999999 wei(유효숫자 4자리 버림 결과 0.1000)를 하나씩 넣는다
     * @when 수수료 wei를 ETH 표기 문자열로 바꾼다
     * @then 소수 끝자리 0이 지워진 값이 나온다(`0.00042`, `0.5`, `0.1`)
     */
    it("[DoD-50] 소수 끝자리 0을 지운다", () => {
      expectFormats([
        { wei: 420_000_000_000_000n, expected: "0.00042" },
        { wei: 500_000_000_000_000_000n, expected: "0.5" },
        { wei: 100_099_999_999_999_999n, expected: "0.1" },
      ]);
    });

    /**
     * @spec DoD-17
     * @given 0보다 크고 0.00000001 ETH보다 작은 표본 1 wei, 9999999999 wei(10^10 wei 바로 아래)를 하나씩 넣는다
     * @when 수수료 wei를 ETH 표기 문자열로 바꾼다
     * @then `<0.00000001`이 나온다
     */
    it("[DoD-17] 0.00000001 ETH 미만의 양수는 <0.00000001로 표시한다", () => {
      expectFormats([
        { wei: 1n, expected: "<0.00000001" },
        { wei: 9_999_999_999n, expected: "<0.00000001" },
      ]);
    });

    /**
     * @spec DoD-18
     * @given 수수료 0 wei
     * @when 수수료 wei를 ETH 표기 문자열로 바꾼다
     * @then `0`이 나온다
     */
    it("[DoD-18] 0은 0으로 표시한다", () => {
      expect(formatEthFee(0n)).toBe("0");
    });

    /**
     * @spec DoD-51
     * @given 1 ETH 이상 표본 10^18 wei(1 ETH 경계), 1000090000000000000 wei(1.00009 ETH), 1234567890000000000000 wei(1,234.56789 ETH), 1000000500000000000000000 wei(1,000,000.5 ETH)를 하나씩 넣는다
     * @when 수수료 wei를 ETH 표기 문자열로 바꾼다
     * @then F2 금액 규칙대로 소수 4자리 버림, 끝자리 0 제거, 천 단위 쉼표를 적용한 값이 나온다(`1`, `1`, `1,234.5678`, `1,000,000.5`)
     */
    it("[DoD-51] 1 ETH 이상은 소수 4자리 버림과 천 단위 쉼표로 표시한다", () => {
      expectFormats([
        { wei: ONE_ETH, expected: "1" },
        { wei: 1_000_090_000_000_000_000n, expected: "1" },
        { wei: 1_234_567_890_000_000_000_000n, expected: "1,234.5678" },
        { wei: 1_000_000_500_000_000_000_000_000n, expected: "1,000,000.5" },
      ]);
    });
  });

  describe("수수료 경고 — 보내는 토큰이 ETH·WETH이면 wei로 비교한다", () => {
    /**
     * @spec DoD-22 DoD-24 EC-18
     * @given 보내는 토큰이 ETH·WETH이고 수수료 ÷ 보내는 금액(wei)이 정확히 500 bps(feeWei 5×10^16, amountInRaw 10^18)와 501 bps(feeWei 5.01×10^16, amountInRaw 10^18)인 표본을, 수수료·보내는 금액 USD micros가 모두 null(단가 없음)인 경우와 USD micros 비율이 500 bps 미만을 가리키는 경우로 하나씩 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then 모든 표본에서 `severity=warning`이다
     * @then `ratioPercent`는 wei 비율로 정한 값(5)이고 USD micros 값에 따라 달라지지 않는다
     */
    it("[DoD-22][DoD-24][EC-18] ETH·WETH 입력에서 wei 비율 500 bps 이상이면 USD 단가 없이도 warning이다", () => {
      const weiSamples = [
        { label: "500 bps", feeWei: 50_000_000_000_000_000n },
        { label: "501 bps", feeWei: 50_100_000_000_000_000n },
      ];
      // USD 단가 없음, 그리고 USD 비율이 100 bps($1 / $100)로 500 bps 미만을 가리키는 경우.
      const usdSamples = [
        { label: "USD 없음", feeUsdMicros: null, amountInUsdMicros: null },
        { label: "USD 100 bps", feeUsdMicros: 1_000_000n, amountInUsdMicros: HUNDRED_USD_MICROS },
      ];
      for (const { label: weiLabel, feeWei } of weiSamples) {
        for (const { label: usdLabel, feeUsdMicros, amountInUsdMicros } of usdSamples) {
          const result = getNetworkFeeSeverity({
            feeWei,
            feeUsdMicros,
            amountInRaw: ONE_ETH,
            amountInUsdMicros,
            isEthLikeIn: true,
          });
          expect(result, `${weiLabel}, ${usdLabel}`).toEqual({
            severity: "warning",
            ratioPercent: 5,
          });
        }
      }
    });

    /**
     * @spec DoD-23 DoD-24
     * @given 보내는 토큰이 ETH·WETH이고 수수료 ÷ 보내는 금액(wei)이 499 bps(feeWei 4.99×10^16, amountInRaw 10^18)와 1 bps 미만으로 500에 못 미치는 499.9999 bps(feeWei 49999990000000000, amountInRaw 10^18)인 표본을, 수수료·보내는 금액 USD micros가 모두 null(단가 없음)인 경우와 USD micros 비율이 500 bps 이상을 가리키는 경우로 하나씩 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then 모든 표본에서 `severity=normal`이다
     * @then `ratioPercent`는 wei 비율로 정한 값(4, 4)이고 USD micros 값에 따라 달라지지 않는다
     */
    it("[DoD-23][DoD-24] ETH·WETH 입력에서 wei 비율 500 bps 미만이면 USD 단가 없이도 normal이다", () => {
      const weiSamples = [
        { label: "499 bps", feeWei: 49_900_000_000_000_000n },
        { label: "499.9999 bps", feeWei: 49_999_990_000_000_000n },
      ];
      // USD 단가 없음, 그리고 USD 비율이 5000 bps($50 / $100)로 500 bps 이상을 가리키는 경우.
      const usdSamples = [
        { label: "USD 없음", feeUsdMicros: null, amountInUsdMicros: null },
        { label: "USD 5000 bps", feeUsdMicros: 50_000_000n, amountInUsdMicros: HUNDRED_USD_MICROS },
      ];
      for (const { label: weiLabel, feeWei } of weiSamples) {
        for (const { label: usdLabel, feeUsdMicros, amountInUsdMicros } of usdSamples) {
          const result = getNetworkFeeSeverity({
            feeWei,
            feeUsdMicros,
            amountInRaw: ONE_ETH,
            amountInUsdMicros,
            isEthLikeIn: true,
          });
          expect(result, `${weiLabel}, ${usdLabel}`).toEqual({
            severity: "normal",
            ratioPercent: 4,
          });
        }
      }
    });
  });

  describe("수수료 경고 — 그 밖의 토큰은 USD micros로 비교한다", () => {
    /**
     * @spec DoD-22 DoD-25 EC-18
     * @given 보내는 토큰이 ETH·WETH가 아니고 수수료 USD micros ÷ 보내는 금액 USD micros가 정확히 500 bps(5000000 / 100000000)와 501 bps(5010000 / 100000000)인 표본을, feeWei ÷ amountInRaw가 500 bps 미만을 가리키게 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then 모든 표본에서 `severity=warning`이다
     * @then `ratioPercent`는 USD micros 비율로 정한 값(5)이다
     */
    it("[DoD-22][DoD-25][EC-18] 비ETH 입력에서 USD 비율 500 bps 이상이면 warning이다", () => {
      // wei 비율은 1 wei / 1 ETH로 500 bps 미만을 가리킨다.
      for (const { label, feeUsdMicros } of [
        { label: "500 bps", feeUsdMicros: 5_000_000n },
        { label: "501 bps", feeUsdMicros: 5_010_000n },
      ]) {
        const result = getNetworkFeeSeverity({
          feeWei: 1n,
          feeUsdMicros,
          amountInRaw: ONE_ETH,
          amountInUsdMicros: HUNDRED_USD_MICROS,
          isEthLikeIn: false,
        });
        expect(result, label).toEqual({ severity: "warning", ratioPercent: 5 });
      }
    });

    /**
     * @spec DoD-23 DoD-25
     * @given 보내는 토큰이 ETH·WETH가 아니고 수수료 USD micros ÷ 보내는 금액 USD micros가 499 bps(4990000 / 100000000), 1 bps 미만으로 500에 못 미치는 499.9999 bps(4999999 / 100000000), 1 bps(10000 / 100000000)인 표본을, feeWei ÷ amountInRaw가 500 bps 이상을 가리키게 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then 모든 표본에서 `severity=normal`이다
     * @then `ratioPercent`는 USD micros 비율로 정한 값(4, 4, 0)이다
     */
    it("[DoD-23][DoD-25] 비ETH 입력에서 USD 비율 500 bps 미만이면 normal이다", () => {
      // wei 비율은 0.001 ETH(10^15 wei) / 10^8 raw로 500 bps 이상을 가리킨다.
      for (const { label, feeUsdMicros, ratioPercent } of [
        { label: "499 bps", feeUsdMicros: 4_990_000n, ratioPercent: 4 },
        { label: "499.9999 bps", feeUsdMicros: 4_999_999n, ratioPercent: 4 },
        { label: "1 bps", feeUsdMicros: 10_000n, ratioPercent: 0 },
      ]) {
        const result = getNetworkFeeSeverity({
          feeWei: 10n ** 15n,
          feeUsdMicros,
          amountInRaw: 100_000_000n,
          amountInUsdMicros: HUNDRED_USD_MICROS,
          isEthLikeIn: false,
        });
        expect(result, label).toEqual({ severity: "normal", ratioPercent });
      }
    });

    /**
     * @spec DoD-26
     * @given 비율 표본 1999 bps(19.99%), 9999 bps(99.99%), 10000 bps(100%), 10001 bps, 70050 bps(700.5%)를 ETH·WETH 경로(wei)와 비ETH 경로(USD micros)로 하나씩 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then `ratioPercent`는 비율(%)을 버림한 정수(19, 99, 100, 100, 700)다
     * @then 100% 이상이어도 `ratioPercent`는 null이 아니고 버림한 정수다
     */
    it("[DoD-26] ratioPercent는 비율(%)을 버림한 정수이고 100% 이상도 정수다", () => {
      const samples = [
        { bps: 1999n, ratioPercent: 19 },
        { bps: 9999n, ratioPercent: 99 },
        { bps: 10_000n, ratioPercent: 100 },
        { bps: 10_001n, ratioPercent: 100 },
        { bps: 70_050n, ratioPercent: 700 },
      ];
      for (const { bps, ratioPercent } of samples) {
        // ETH·WETH 경로: 보내는 금액 1 ETH, 수수료 = bps × 10^14 wei.
        const ethLike = getNetworkFeeSeverity({
          feeWei: bps * 10n ** 14n,
          feeUsdMicros: null,
          amountInRaw: ONE_ETH,
          amountInUsdMicros: null,
          isEthLikeIn: true,
        });
        // 비ETH 경로: 보내는 금액 $100, 수수료 = bps × 10_000 USD micros.
        const usd = getNetworkFeeSeverity({
          feeWei: 1n,
          feeUsdMicros: bps * 10_000n,
          amountInRaw: ONE_ETH,
          amountInUsdMicros: HUNDRED_USD_MICROS,
          isEthLikeIn: false,
        });
        for (const [path, result] of [
          ["wei", ethLike],
          ["USD", usd],
        ] as const) {
          expect(result.ratioPercent, `${path} ${bps} bps`).not.toBeNull();
          expect(result.ratioPercent, `${path} ${bps} bps`).toBe(ratioPercent);
          expect(Number.isInteger(result.ratioPercent), `${path} ${bps} bps: 정수`).toBe(true);
        }
      }
    });
  });

  describe("수수료 경고 — 비율을 정할 수 없는 경계", () => {
    /**
     * @spec EC-16
     * @given 보내는 토큰이 ETH·WETH가 아니고 보내는 금액 USD micros가 0이며 수수료 USD micros가 1과 5000000인 표본을 하나씩 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then `severity=warning`이다
     * @then `ratioPercent=null`이다
     */
    it("[EC-16] 보내는 금액 USD가 0이고 수수료 USD가 양수면 warning, ratioPercent null이다", () => {
      for (const feeUsdMicros of [1n, 5_000_000n]) {
        const result = getNetworkFeeSeverity({
          feeWei: 10n ** 15n,
          feeUsdMicros,
          amountInRaw: 100_000_000n,
          amountInUsdMicros: 0n,
          isEthLikeIn: false,
        });
        expect(result, `수수료 USD micros ${feeUsdMicros}`).toEqual({
          severity: "warning",
          ratioPercent: null,
        });
      }
    });

    /**
     * @spec EC-17
     * @given 보내는 토큰이 ETH·WETH가 아니고 feeWei가 0보다 크면서(1 wei) 수수료 USD micros가 0이며 보내는 금액 USD micros가 null(모름), 0, 100000000인 표본을 하나씩 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then 모든 표본에서 `severity=normal`이다
     */
    it("[EC-17] 수수료 USD가 0이면 보내는 금액 USD를 몰라도 normal이다", () => {
      // feeWei 1 wei / amountInRaw 1이라 wei로 비교하면 500 bps 이상이 된다.
      for (const amountInUsdMicros of [null, 0n, HUNDRED_USD_MICROS]) {
        const result = getNetworkFeeSeverity({
          feeWei: 1n,
          feeUsdMicros: 0n,
          amountInRaw: 1n,
          amountInUsdMicros,
          isEthLikeIn: false,
        });
        expect(result.severity, `보내는 금액 USD micros ${amountInUsdMicros}`).toBe("normal");
      }
    });

    /**
     * @spec EC-20
     * @given 보내는 토큰이 ETH·WETH가 아니고 (수수료 USD micros null, 보내는 금액 USD micros null), (수수료 USD micros null, 보내는 금액 USD micros 100000000), (수수료 USD micros null, 보내는 금액 USD micros 0), (수수료 USD micros 5000000, 보내는 금액 USD micros null)인 표본을 하나씩 넣는다
     * @when 수수료 경고 수준을 판정한다
     * @then 모든 표본에서 `severity=unknown`이다(warning이 아니다)
     * @then `ratioPercent=null`이다
     */
    it("[EC-20] 비ETH 입력에서 수수료 USD를 모르거나 양수 수수료에 보내는 금액 USD를 모르면 unknown이다", () => {
      const samples: readonly { feeUsdMicros: bigint | null; amountInUsdMicros: bigint | null }[] =
        [
          { feeUsdMicros: null, amountInUsdMicros: null },
          { feeUsdMicros: null, amountInUsdMicros: HUNDRED_USD_MICROS },
          { feeUsdMicros: null, amountInUsdMicros: 0n },
          { feeUsdMicros: 5_000_000n, amountInUsdMicros: null },
        ];
      for (const { feeUsdMicros, amountInUsdMicros } of samples) {
        const result = getNetworkFeeSeverity({
          feeWei: 10n ** 15n,
          feeUsdMicros,
          amountInRaw: 100_000_000n,
          amountInUsdMicros,
          isEthLikeIn: false,
        });
        expect(result, `수수료 USD ${feeUsdMicros}, 보내는 금액 USD ${amountInUsdMicros}`).toEqual({
          severity: "unknown",
          ratioPercent: null,
        });
      }
    });
  });

  describe("ETH 부족 판정", () => {
    /**
     * @spec DoD-30 EC-23
     * @given 잔액 < feeWei + valueWei인 표본을 넣는다: valueWei 0(ERC-20 입력·approve·unwrap)에서 잔액 = feeWei - 1, valueWei > 0(ETH 입력 스왑·wrap)에서 잔액이 feeWei 이상이고 valueWei 이상이지만 잔액 = feeWei + valueWei - 1
     * @when ETH 부족 여부를 판정한다
     * @then 모든 표본에서 `true`다
     */
    it("[DoD-30][EC-23] ETH 잔액이 수수료 + 보내는 ETH보다 작으면 부족이다", () => {
      const balanceBelowSum = FEE_WEI + VALUE_WEI - 1n;
      // EC-23 표본 전제: 잔액이 수수료와 보내는 금액 각각보다는 크거나 같다.
      expect(balanceBelowSum >= FEE_WEI && balanceBelowSum >= VALUE_WEI).toBe(true);
      expectShortage(
        [
          {
            label: "valueWei 0, 잔액 = fee - 1",
            ethBalance: FEE_WEI - 1n,
            feeWei: FEE_WEI,
            valueWei: 0n,
          },
          {
            label: "valueWei > 0, 잔액 = fee + value - 1",
            ethBalance: balanceBelowSum,
            feeWei: FEE_WEI,
            valueWei: VALUE_WEI,
          },
        ],
        true,
      );
    });

    /**
     * @spec DoD-31
     * @given 잔액 ≥ feeWei + valueWei인 표본을 넣는다: valueWei 0과 valueWei > 0 각각에서 잔액 = feeWei + valueWei(경계)와 잔액 = feeWei + valueWei + 1
     * @when ETH 부족 여부를 판정한다
     * @then 모든 표본에서 `false`다
     */
    it("[DoD-31] ETH 잔액이 수수료 + 보내는 ETH 이상이면 부족이 아니다", () => {
      const samples: ShortageSample[] = [];
      for (const valueWei of [0n, VALUE_WEI]) {
        for (const extra of [0n, 1n]) {
          samples.push({
            label: `valueWei ${valueWei}, 잔액 = fee + value + ${extra}`,
            ethBalance: FEE_WEI + valueWei + extra,
            feeWei: FEE_WEI,
            valueWei,
          });
        }
      }
      expectShortage(samples, false);
    });

    /**
     * @spec EC-21
     * @given ETH 잔액 0에 feeWei null(추정 loading·error)인 표본을 valueWei 0과 valueWei > 0으로 하나씩 넣는다
     * @when ETH 부족 여부를 판정한다
     * @then 모든 표본에서 `true`다
     */
    it("[EC-21] ETH 잔액이 0이면 수수료를 몰라도 부족이다", () => {
      expectShortage(
        [
          { label: "valueWei 0", ethBalance: 0n, feeWei: null, valueWei: 0n },
          { label: "valueWei > 0", ethBalance: 0n, feeWei: null, valueWei: VALUE_WEI },
        ],
        true,
      );
    });

    /**
     * @spec EC-22
     * @given ETH 잔액 null(모름)에 feeWei null, feeWei 양수, feeWei 양수 + valueWei > 0인 표본을 하나씩 넣는다
     * @when ETH 부족 여부를 판정한다
     * @then 모든 표본에서 `false`다
     */
    it("[EC-22] ETH 잔액을 모르면 부족이 아니다", () => {
      expectShortage(
        [
          { label: "feeWei null", ethBalance: null, feeWei: null, valueWei: 0n },
          { label: "feeWei 양수", ethBalance: null, feeWei: FEE_WEI, valueWei: 0n },
          {
            label: "feeWei 양수 + valueWei > 0",
            ethBalance: null,
            feeWei: FEE_WEI,
            valueWei: VALUE_WEI,
          },
        ],
        false,
      );
    });

    /**
     * @spec EC-25
     * @given feeWei null(추정 loading·error)에 ETH 잔액이 1 wei인 표본을 valueWei 0과 valueWei가 잔액보다 큰 경우로 하나씩 넣는다
     * @when ETH 부족 여부를 판정한다
     * @then 모든 표본에서 `false`다
     */
    it("[EC-25] 수수료를 모르고 ETH 잔액이 양수면 부족이 아니다", () => {
      expectShortage(
        [
          { label: "valueWei 0", ethBalance: 1n, feeWei: null, valueWei: 0n },
          { label: "valueWei > 잔액", ethBalance: 1n, feeWei: null, valueWei: VALUE_WEI },
        ],
        false,
      );
    });
  });
});
