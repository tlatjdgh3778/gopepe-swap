import type { Token } from "@/config/tokens";

// 연결 상태에서 주 버튼이 표시하는 입력 상태. 복원 중·미연결은 화면이 F1 분기로 먼저 처리한다.
export type SwapInputState =
  | "select-token"
  | "enter-amount"
  | "insufficient-balance"
  | "input-valid";

export type SwapInputStateParams = {
  tokenIn: Token | null;
  tokenOut: Token | null;
  // §4.3 `amountInRaw`. 빈 값·`.`이면 `null`.
  amountInRaw: bigint | null;
  // 보내는 토큰의 정수 잔액. 성공한 잔액이 없으면(읽는 중·실패) `null`이고 잔액 부족을 판정하지 않는다.
  balanceInRaw: bigint | null;
};

/**
 * `select-token`, `enter-amount`, `insufficient-balance`, `input-valid` 순으로 먼저 해당하는 상태를 돌려준다.
 * 잔액 부족은 표시용 버림값이 아니라 입력 정수와 잔액 정수로 판정한다.
 */
export function getSwapInputState({
  tokenIn,
  tokenOut,
  amountInRaw,
  balanceInRaw,
}: SwapInputStateParams): SwapInputState {
  if (tokenIn === null || tokenOut === null) return "select-token";
  if (amountInRaw === null || amountInRaw === 0n) return "enter-amount";
  if (balanceInRaw !== null && amountInRaw > balanceInRaw) return "insufficient-balance";
  return "input-valid";
}
