import type { Token } from "@/config/tokens";
import type { PriceImpactSeverity } from "@/lib/quote-format";
import type { SwapQuoteState, SwapQuoteStatus } from "@/lib/swap-quote";

import { getPriceImpactSeverity } from "@/lib/quote-format";
import { type SwapInputState, getSwapInputState } from "@/lib/swap-input-state";
import { isNativeToken } from "@/lib/token-amount";

// 주 버튼 상태(스펙 §4.3 `primary-button[data-state]`). 판정 순서(DoD-5)와 같은 순서다.
export const PRIMARY_BUTTON_STATES = [
  "restoring",
  "disconnected",
  "awaiting-signature",
  "approving",
  "swapping",
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "quote-ready",
  "price-impact-too-high",
  "amount-too-small",
  "allowance-error",
  "checking-allowance",
  "approve-required",
  "swap-ready",
] as const;

export type PrimaryButtonState = (typeof PRIMARY_BUTTON_STATES)[number];

// 주 버튼이 읽는 지갑 상태(`useWalletRestore().status`와 같은 값).
export type PrimaryButtonWalletStatus = "restoring" | "disconnected" | "connected";

// `useSwapExecution().phase`(스펙 §4.2).
export type SwapExecutionPhase = "idle" | "awaiting-signature" | "approving" | "swapping";

// `useTokenAllowance().status`(스펙 §4.2).
export type TokenAllowanceStatus = "idle" | "loading" | "success" | "error";

export type PrimaryButtonStateParams = {
  walletStatus: PrimaryButtonWalletStatus;
  phase: SwapExecutionPhase;
  // `getSwapInputState` 결과.
  inputState: SwapInputState;
  quoteStatus: SwapQuoteStatus;
  // 보내는 토큰이나 받는 토큰이 ETH이면 참.
  isEthPair: boolean;
  // 견적 `success`일 때의 가격 영향 등급. 그 밖에는 `null`.
  priceImpactSeverity: PriceImpactSeverity | null;
  // `useAmountOutMinimum()`.
  amountOutMinimum: bigint | null;
  allowanceStatus: TokenAllowanceStatus;
  // `useTokenAllowance().allowance`. `allowanceStatus`가 `success`일 때만 `null`이 아니다.
  allowance: bigint | null;
  // 스펙 §4.3(F2) `amountInRaw`. 빈 값·`.`이면 `null`.
  amountInRaw: bigint | null;
};

/**
 * 주 버튼 상태. DoD-5의 순서에서 먼저 해당하는 상태다.
 * 복원 중 → 미연결 → 실행 phase → 입력 상태(`select-token`·`enter-amount`·`insufficient-balance`) →
 * 견적 상태(`loading`·`idle` → `quoting`, `no-route`, `error` → `quote-error`) → 견적 `success`에서
 * ETH가 낀 페어는 `quote-ready`(DoD-6), ERC-20↔ERC-20 페어는 가격 영향 `error` 등급(DoD-7) →
 * 최소 수령량 `0n`(DoD-8) → allowance 읽기 실패(EC-14) → 읽는 중(DoD-9) → `amountInRaw`와 비교(DoD-10·11)다.
 * 스펙상 오지 않는 조합: 입력이 유효한데 견적 `idle`이면 `quoting`, ERC-20↔ERC-20 페어 견적 `success`에서
 * allowance `idle`이거나 `success`인데 값·`amountInRaw`가 `null`이면 `checking-allowance`다.
 */
export function getPrimaryButtonState({
  walletStatus,
  phase,
  inputState,
  quoteStatus,
  isEthPair,
  priceImpactSeverity,
  amountOutMinimum,
  allowanceStatus,
  allowance,
  amountInRaw,
}: PrimaryButtonStateParams): PrimaryButtonState {
  if (walletStatus === "restoring") return "restoring";
  if (walletStatus === "disconnected") return "disconnected";
  if (phase !== "idle") return phase;
  if (inputState !== "input-valid") return inputState;

  switch (quoteStatus) {
    case "idle":
    case "loading":
      return "quoting";
    case "no-route":
      return "no-route";
    case "error":
      return "quote-error";
    case "success":
      break;
  }

  if (isEthPair) return "quote-ready";
  if (priceImpactSeverity === "error") return "price-impact-too-high";
  if (amountOutMinimum === 0n) return "amount-too-small";
  if (allowanceStatus === "error") return "allowance-error";
  if (allowanceStatus !== "success" || allowance === null || amountInRaw === null) {
    return "checking-allowance";
  }
  return allowance < amountInRaw ? "approve-required" : "swap-ready";
}

// 활성 상태. 미연결(지갑 연결 모달, F1)과 `approve-required`·`swap-ready`만 누를 수 있다.
const ENABLED_PRIMARY_BUTTON_STATES: ReadonlySet<PrimaryButtonState> = new Set([
  "disconnected",
  "approve-required",
  "swap-ready",
]);

/**
 * 주 버튼을 누를 수 있으면 참이다. `disconnected`, `approve-required`, `swap-ready`만 활성이다.
 */
export function isPrimaryButtonEnabled(state: PrimaryButtonState): boolean {
  return ENABLED_PRIMARY_BUTTON_STATES.has(state);
}

/**
 * 보내는 토큰이나 받는 토큰이 ETH이면 참이다. 토큰이 하나라도 없으면 거짓이다.
 */
export function isEthPair(tokenIn: Token | null, tokenOut: Token | null): boolean {
  if (tokenIn === null || tokenOut === null) return false;
  return isNativeToken(tokenIn) || isNativeToken(tokenOut);
}

export type PrimaryButtonSourceParams = {
  walletStatus: PrimaryButtonWalletStatus;
  phase: SwapExecutionPhase;
  tokenIn: Token | null;
  tokenOut: Token | null;
  amountInRaw: bigint | null;
  // 보내는 토큰의 정수 잔액. 성공한 잔액이 없으면 `null`이고 잔액 부족을 판정하지 않는다.
  balanceInRaw: bigint | null;
  quote: SwapQuoteState;
  amountOutMinimum: bigint | null;
  allowance: { status: TokenAllowanceStatus; allowance: bigint | null };
};

/**
 * 화면의 원래 값(토큰·금액·잔액, 견적, 최소 수령량, allowance)으로 `getPrimaryButtonState`의 입력을 만든다.
 * 입력 상태는 `getSwapInputState`, ETH 페어는 `isNativeToken`, 등급은 `getPriceImpactSeverity`로 정한다.
 */
export function getPrimaryButtonStateParams({
  walletStatus,
  phase,
  tokenIn,
  tokenOut,
  amountInRaw,
  balanceInRaw,
  quote,
  amountOutMinimum,
  allowance,
}: PrimaryButtonSourceParams): PrimaryButtonStateParams {
  return {
    walletStatus,
    phase,
    inputState: getSwapInputState({ tokenIn, tokenOut, amountInRaw, balanceInRaw }),
    quoteStatus: quote.status,
    isEthPair: isEthPair(tokenIn, tokenOut),
    priceImpactSeverity:
      quote.status === "success" ? getPriceImpactSeverity(quote.quote.priceImpactBps) : null,
    amountOutMinimum,
    allowanceStatus: allowance.status,
    allowance: allowance.allowance,
    amountInRaw,
  };
}
