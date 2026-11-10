import type { Address } from "viem";

import { describe, expect, it } from "vitest";

import type { SupportedChainId } from "@/config/chains";

import { PINNED_TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { getSwapInputState } from "@/lib/swap-input-state";
import { formatMaxAmount, parseAmountRaw } from "@/lib/token-amount";

function pinnedOf(chainId: SupportedChainId, symbol: string): Token {
  const token = PINNED_TOKENS_BY_CHAIN[chainId].find((candidate) => candidate.symbol === symbol);
  if (!token) throw new Error(`체인 ${chainId}의 고정 토큰 ${symbol}가 없다`);
  return token;
}

// 고정 토큰이 아닌 ERC-20. decimals는 표본마다 다르다.
const SYNTHETIC_ERC20_ADDRESS: Address = "0x1111111111111111111111111111111111111111";
function erc20(decimals: number): Token {
  return {
    chainId: 1,
    address: SYNTHETIC_ERC20_ADDRESS,
    name: `Synthetic ${decimals}`,
    symbol: `SYN${decimals}`,
    decimals,
  };
}

/**
 * 파일 전제(두 칸의 토큰 선택, 금액 > 0, 보내는 토큰 잔액 정수를 앎)에서 금액 문자열을 §4.3 `amountInRaw`로 바꿔 판정한다.
 */
function judge(
  tokenIn: Token,
  tokenOut: Token,
  amount: string,
  balanceInRaw: bigint,
  label: string,
) {
  const amountInRaw = parseAmountRaw(amount, tokenIn.decimals);
  expect(amountInRaw, `${label}: 금액 정수`).not.toBeNull();
  expect((amountInRaw ?? 0n) > 0n, `${label}: 금액 > 0 전제`).toBe(true);
  return getSwapInputState({ tokenIn, tokenOut, amountInRaw, balanceInRaw });
}

// 이 파일은 잔액 부족 판정의 순수 규칙만 다룬다.
// 주 버튼의 상태 표시와 `최대` 버튼 흐름은 통합 테스트(T-6)와 E2E(T-8)가 다룬다.
// 아래 case는 모두 연결 상태에서 두 칸의 토큰이 선택되고, 금액이 0보다 크며, 보내는 토큰의 잔액 정수를 아는 상태를 전제로 한다.
describe("잔액 부족 판정 — 보내는 금액이 실제 잔액을 넘을 때만 잔액 부족이다", () => {
  describe("표시값이 아니라 정수로 비교", () => {
    /**
     * @spec EC-25
     * @given (보내는 토큰 decimals, 잔액 정수, 금액) 표본 (6, `1234567`, `1.23456`), (6, `1234567`, `1.234567`), (18, `1`, `0.000000000000000001`)처럼 잔액 표시가 버림값(`1.2345`)이거나 `<0.0001`이라 표시값으로는 금액과 비교할 수 없거나 금액이 더 커 보이지만, 금액을 decimals로 바꾼 정수가 잔액 정수 이하인 경우를 하나씩 반복한다
     * @when 입력 상태를 판정한다
     * @then 판정은 `insufficient-balance`가 아니고 `input-valid`다
     */
    it("[EC-25] 금액이 표시용 버림값보다 커도 입력 정수가 잔액 정수 이하면 잔액 부족이 아니다", () => {
      const samples = [
        [pinnedOf(1, "USDC"), 1234567n, "1.23456"],
        [pinnedOf(1, "USDC"), 1234567n, "1.234567"],
        [pinnedOf(1, "DAI"), 1n, "0.000000000000000001"],
      ] as const;
      const tokenOut = pinnedOf(1, "WETH");

      for (const [tokenIn, balance, amount] of samples) {
        const label = `${tokenIn.symbol}(${tokenIn.decimals}) 잔액 ${balance} 금액 ${amount}`;
        const state = judge(tokenIn, tokenOut, amount, balance, label);
        expect(state, label).not.toBe("insufficient-balance");
        expect(state, label).toBe("input-valid");
      }
    });

    /**
     * @spec EC-25
     * @given (보내는 토큰 decimals, 잔액 정수, 금액) 표본 (6, `1234567`, `1.234568`), (18, `1`, `0.000000000000000002`)처럼 금액의 표시값이 잔액 표시값과 같지만 금액을 decimals로 바꾼 정수가 잔액 정수보다 큰 경우를 하나씩 반복한다
     * @when 입력 상태를 판정한다
     * @then 판정은 `insufficient-balance`다
     */
    it("[EC-25] 표시값이 같아도 입력 정수가 잔액 정수보다 크면 잔액 부족이다", () => {
      const samples = [
        [pinnedOf(1, "USDC"), 1234567n, "1.234568"],
        [pinnedOf(1, "DAI"), 1n, "0.000000000000000002"],
      ] as const;
      const tokenOut = pinnedOf(1, "WETH");

      for (const [tokenIn, balance, amount] of samples) {
        const label = `${tokenIn.symbol}(${tokenIn.decimals}) 잔액 ${balance} 금액 ${amount}`;
        expect(judge(tokenIn, tokenOut, amount, balance, label), label).toBe(
          "insufficient-balance",
        );
      }
    });
  });

  describe("`최대`로 넣은 금액", () => {
    /**
     * @spec EC-25
     * @given ERC-20의 (decimals, 잔액 정수) 표본 (6, `1234567`), (6, `123456789012345678`), (18, `1234567890123456789`), (18, `123456789012345678901234567890`), (0, `42`)과 ETH의 (선택 체인, 잔액 정수) 표본 Ethereum(1) `1000000000000000000`, Base(8453) `5000000000000000001`, Arbitrum(42161) `1000000000000000000`을 하나씩 반복한다
     * @when 그 잔액으로 `최대` 금액 문자열을 만들어 금액으로 넣고 입력 상태를 판정한다
     * @then 판정은 `insufficient-balance`가 아니고 `input-valid`다
     */
    it("[EC-25] 최대로 넣은 값은 잔액 부족이 되지 않는다", () => {
      const samples: (readonly [SupportedChainId, Token, bigint])[] = [
        [1, erc20(6), 1234567n],
        [1, erc20(6), 123456789012345678n],
        [1, erc20(18), 1234567890123456789n],
        [1, erc20(18), 123456789012345678901234567890n],
        [1, erc20(0), 42n],
        [1, pinnedOf(1, "ETH"), 1000000000000000000n],
        [8453, pinnedOf(8453, "ETH"), 5000000000000000001n],
        [42161, pinnedOf(42161, "ETH"), 1000000000000000000n],
      ];

      for (const [chainId, tokenIn, balance] of samples) {
        const label = `체인 ${chainId} ${tokenIn.symbol}(${tokenIn.decimals}) 잔액 ${balance}`;
        const amount = formatMaxAmount(balance, tokenIn, chainId);
        const state = judge(tokenIn, pinnedOf(chainId, "USDC"), amount, balance, label);
        expect(state, label).not.toBe("insufficient-balance");
        expect(state, label).toBe("input-valid");
      }
    });
  });

  describe("ETH 금액과 가스 예약량", () => {
    /**
     * @spec EC-26
     * @given ETH의 (선택 체인, 잔액 정수, 금액) 표본 (Ethereum(1), `1000000000000000000`, `1`), (Ethereum(1), `1000000000000000000`, `0.999`), (Ethereum(1), `1000000000000000000`, `0.996`), (Base(8453), `1000000000000000000`, `0.99999`), (Arbitrum(42161), `400000000000000`, `0.0004`)처럼 금액이 잔액 이하이지만 잔액에서 가스 예약량을 뺀 값보다 큰 경우를 하나씩 반복한다
     * @when 입력 상태를 판정한다
     * @then 판정은 `insufficient-balance`가 아니고 `input-valid`다
     */
    it("[EC-26] ETH 금액이 잔액 이하이면 가스 예약량을 넘어도 잔액 부족이 아니다", () => {
      const samples = [
        [1, 1000000000000000000n, "1"],
        [1, 1000000000000000000n, "0.999"],
        [1, 1000000000000000000n, "0.996"],
        [8453, 1000000000000000000n, "0.99999"],
        [42161, 400000000000000n, "0.0004"],
      ] as const;

      for (const [chainId, balance, amount] of samples) {
        const label = `체인 ${chainId} ETH 잔액 ${balance} 금액 ${amount}`;
        const state = judge(
          pinnedOf(chainId, "ETH"),
          pinnedOf(chainId, "USDC"),
          amount,
          balance,
          label,
        );
        expect(state, label).not.toBe("insufficient-balance");
        expect(state, label).toBe("input-valid");
      }
    });
  });

  describe("정수부가 아주 긴 금액", () => {
    /**
     * @spec EC-27
     * @given (보내는 토큰, decimals, 잔액 정수, 금액) 표본 (ETH, 18, `1000000000000000000`, `9`를 80번 이은 문자열), (ETH, 18, `1000000000000000000`, `9`를 80번 이은 문자열 뒤에 `.5`), (ERC-20, 6, `1000000000000`, `1` 뒤에 `0`을 99번 이은 문자열)을 하나씩 반복한다
     * @when 입력 상태를 판정한다
     * @then 판정은 `insufficient-balance`다
     */
    it("[EC-27] 정수부 길이 상한 없이 잔액보다 큰 값은 잔액 부족이다", () => {
      const samples = [
        [pinnedOf(1, "ETH"), 1000000000000000000n, "9".repeat(80)],
        [pinnedOf(1, "ETH"), 1000000000000000000n, `${"9".repeat(80)}.5`],
        [pinnedOf(1, "USDC"), 1000000000000n, `1${"0".repeat(99)}`],
      ] as const;
      const tokenOut = pinnedOf(1, "WETH");

      for (const [tokenIn, balance, amount] of samples) {
        const label = `${tokenIn.symbol}(${tokenIn.decimals}) 잔액 ${balance} 금액 길이 ${amount.length}`;
        expect(judge(tokenIn, tokenOut, amount, balance, label), label).toBe(
          "insufficient-balance",
        );
      }
    });
  });
});
