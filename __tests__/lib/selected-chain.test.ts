import { describe, expect, it } from "vitest";

import { parseSelectedChainId } from "@/lib/selected-chain";

// EC-7의 서버 렌더링 1건은 E2E(T-12)가 다루고, 이 파일은 쿠키 값 표본을 맡는다.
describe("선택 체인 쿠키 — 저장된 값에서 선택 체인을 정한다", () => {
  describe("쿠키가 없거나 값이 잘못된 경우", () => {
    /**
     * @spec EC-7
     * @given `gopepe-chain` 쿠키가 없거나 값이 빈 문자열, `abc`, `8453abc`, `8453.5`, `0x2105`, `0`, `-1`, `137`인 경우를 하나씩 반복한다
     * @when 쿠키 값에서 선택 체인을 정한다
     * @then 선택 체인은 Ethereum(1)이다
     */
    it("[EC-7] 체인 쿠키가 없거나 값이 잘못되면 Ethereum으로 처리한다", () => {
      const samples = [undefined, "", "abc", "8453abc", "8453.5", "0x2105", "0", "-1", "137"];

      for (const value of samples) {
        expect(parseSelectedChainId(value), `쿠키 값 ${JSON.stringify(value)}`).toBe(1);
      }
    });
  });

  describe("값이 지원 체인인 경우", () => {
    /**
     * @spec EC-7
     * @given `gopepe-chain` 쿠키 값이 `1`, `8453`, `42161`인 경우를 하나씩 반복한다
     * @when 쿠키 값에서 선택 체인을 정한다
     * @then 선택 체인은 쿠키 값의 chainId와 같은 체인이다
     */
    it("[EC-7] 체인 쿠키 값이 지원 chainId면 Ethereum으로 바꾸지 않고 그 체인으로 처리한다", () => {
      const samples = [
        ["1", 1],
        ["8453", 8453],
        ["42161", 42161],
      ] as const;

      for (const [value, expected] of samples) {
        expect(parseSelectedChainId(value), `쿠키 값 ${value}`).toBe(expected);
      }
    });
  });
});
