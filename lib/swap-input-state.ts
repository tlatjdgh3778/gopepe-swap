import type { Token } from "@/config/tokens";
import type { SwapQuoteStatus } from "@/lib/swap-quote";

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

// 견적할 수 없는 입력 상태. 견적 상태 `idle`과 같은 조건이다.
export type IncompleteSwapInputState = "select-token" | "enter-amount";

export type IncompleteSwapInputParams = Pick<
  SwapInputStateParams,
  "tokenIn" | "tokenOut" | "amountInRaw"
>;

/**
 * 토큰 미선택이면 `select-token`, 금액이 비었거나 0이면 `enter-amount`, 둘 다 아니면 `null`이다.
 * `getSwapInputState`와 견적 `idle` 판정이 이 함수를 함께 쓴다.
 */
export function getIncompleteSwapInputState({
  tokenIn,
  tokenOut,
  amountInRaw,
}: IncompleteSwapInputParams): IncompleteSwapInputState | null {
  if (tokenIn === null || tokenOut === null) return "select-token";
  if (amountInRaw === null || amountInRaw === 0n) return "enter-amount";
  return null;
}

/**
 * 견적 상태가 `idle`인 입력인지 판정한다(토큰 미선택 또는 금액이 비었거나 0).
 */
export function isSwapInputIdle(params: IncompleteSwapInputParams): boolean {
  return getIncompleteSwapInputState(params) !== null;
}

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
  const incomplete = getIncompleteSwapInputState({ tokenIn, tokenOut, amountInRaw });
  if (incomplete !== null) return incomplete;
  if (amountInRaw !== null && balanceInRaw !== null && amountInRaw > balanceInRaw) {
    return "insufficient-balance";
  }
  return "input-valid";
}

// 입력 상태가 `input-valid`일 때 주 버튼이 표시하는 견적 상태(스펙 §4.2).
export type QuoteButtonState = "quoting" | "no-route" | "quote-error" | "quote-ready";

// 연결 상태의 주 버튼 상태. `input-valid`는 견적 상태로 대체한다.
export type SwapButtonState = Exclude<SwapInputState, "input-valid"> | QuoteButtonState;

const QUOTE_BUTTON_STATES: Record<SwapQuoteStatus, QuoteButtonState> = {
  // `idle`은 입력이 미완성일 때만이라 `input-valid`와 함께 오지 않는다. 오면 견적 전 대기로 본다.
  idle: "quoting",
  loading: "quoting",
  "no-route": "no-route",
  error: "quote-error",
  success: "quote-ready",
};

export type SwapButtonStateParams = {
  inputState: SwapInputState;
  quoteStatus: SwapQuoteStatus;
};

/**
 * 연결 상태의 주 버튼 상태를 합성한다. `select-token`, `enter-amount`, `insufficient-balance`는
 * 견적 상태보다 앞서고, `input-valid`이면 견적 상태 `loading` → `quoting`, `no-route` → `no-route`,
 * `error` → `quote-error`, `success` → `quote-ready`다. 가격 영향 등급은 판정에 쓰지 않는다.
 */
export function getSwapButtonState({
  inputState,
  quoteStatus,
}: SwapButtonStateParams): SwapButtonState {
  if (inputState !== "input-valid") return inputState;
  return QUOTE_BUTTON_STATES[quoteStatus];
}
