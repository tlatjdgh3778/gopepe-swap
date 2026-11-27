import type { Token } from "@/config/tokens";
import type { PriceImpactSeverity } from "@/lib/quote-format";
import type { SwapQuoteState, SwapQuoteStatus } from "@/lib/swap-quote";

import { getPriceImpactSeverity } from "@/lib/quote-format";
import { type SwapInputState, getSwapInputState } from "@/lib/swap-input-state";
import { isNativeToken } from "@/lib/token-amount";

// 주 버튼 상태(F7 스펙 §4.3 `primary-button[data-state]`, 21개에 batch-calls 스펙 §4.1의 2개를 더한 23개).
// 판정 순서(F7 DoD-6)와 같은 순서다. `batching`은 진행 상태 묶음 끝에, `batch-ready`는 `approve-required` 바로 앞에 둔다.
export const PRIMARY_BUTTON_STATES = [
  "restoring",
  "disconnected",
  "awaiting-signature",
  "approving",
  "swapping",
  "wrapping",
  "unwrapping",
  "batching",
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "wrap-ready",
  "unwrap-ready",
  "price-impact-too-high",
  "amount-too-small",
  "allowance-error",
  "checking-allowance",
  "batch-ready",
  "approve-required",
  "swap-ready",
] as const;

export type PrimaryButtonState = (typeof PRIMARY_BUTTON_STATES)[number];

// 주 버튼이 읽는 지갑 상태(`useWalletRestore().status`와 같은 값).
export type PrimaryButtonWalletStatus = "restoring" | "disconnected" | "connected";

// `useSwapExecution().phase`(F7 스펙 §4.2, batch-calls 스펙 §4.1의 `batching`).
export type SwapExecutionPhase =
  | "idle"
  | "awaiting-signature"
  | "approving"
  | "swapping"
  | "wrapping"
  | "unwrapping"
  | "batching";

// `useTokenAllowance().status`(스펙 §4.2).
export type TokenAllowanceStatus = "idle" | "loading" | "success" | "error";

export type PrimaryButtonStateParams = {
  walletStatus: PrimaryButtonWalletStatus;
  phase: SwapExecutionPhase;
  // `getSwapInputState` 결과.
  inputState: SwapInputState;
  quoteStatus: SwapQuoteStatus;
  // 보내는 토큰이 ETH이면 참.
  isEthIn: boolean;
  // 견적 `success`일 때의 가격 영향 등급. 그 밖에는 `null`.
  priceImpactSeverity: PriceImpactSeverity | null;
  // `useAmountOutMinimum()`.
  amountOutMinimum: bigint | null;
  allowanceStatus: TokenAllowanceStatus;
  // `useTokenAllowance().allowance`. `allowanceStatus`가 `success`일 때만 `null`이 아니다.
  allowance: bigint | null;
  // 스펙 §4.3(F2) `amountInRaw`. 빈 값·`.`이면 `null`.
  amountInRaw: bigint | null;
  // 연결 계정·선택 체인에서 원자 배치를 쓸 수 있으면 참(batch-calls 스펙 DoD-1~3). 없으면 `false`로 보고,
  // 이때 판정은 batch-calls 이전과 같다.
  batchAvailable?: boolean;
};

/**
 * 주 버튼 상태. F7 DoD-6의 순서에서 먼저 해당하는 상태다.
 * 복원 중 → 미연결 → 실행 phase(`awaiting-signature`·`approving`·`swapping`·`wrapping`·`unwrapping`·`batching`) →
 * 입력 상태(`select-token`·`enter-amount`·`insufficient-balance`) →
 * 견적 상태(`loading`·`idle` → `quoting`, `no-route`, `error` → `quote-error`,
 * `wrap` → 보내는 토큰이 ETH이면 `wrap-ready`(F7 DoD-18), 아니면 `unwrap-ready`(F7 DoD-19)) →
 * 견적 `success`에서 가격 영향 `error` 등급(F7 DoD-2) → 최소 수령량 `0n`(F7 DoD-3) →
 * 보내는 토큰이 ETH이면 allowance와 무관하게 `swap-ready`(F7 DoD-1) →
 * 그 밖(보내는 토큰이 ERC-20, F7 DoD-4)은 allowance 읽기 실패(F5 EC-14) → 읽는 중(F5 DoD-9) →
 * `amountInRaw`와 비교(F5 DoD-10·11)다. allowance가 부족할 때 `batchAvailable`이 참이면 `batch-ready`,
 * 아니면 `approve-required`다(batch-calls 스펙 DoD-1~3).
 * 잔액 부족은 금액 정수가 잔액 정수보다 클 때만이라, 보내는 ETH 금액이 잔액과 같아도 막지 않는다(F7 EC-4).
 * 스펙상 오지 않는 조합: 입력이 유효한데 견적 `idle`이면 `quoting`, 견적 `wrap`은 ETH ↔ WETH에서만 오므로
 * 보내는 토큰이 ETH가 아니면 `unwrap-ready`, 보내는 토큰이 ERC-20인 견적 `success`에서
 * allowance `idle`이거나 `success`인데 값·`amountInRaw`가 `null`이면 `checking-allowance`다.
 */
export function getPrimaryButtonState({
  walletStatus,
  phase,
  inputState,
  quoteStatus,
  isEthIn,
  priceImpactSeverity,
  amountOutMinimum,
  allowanceStatus,
  allowance,
  amountInRaw,
  batchAvailable = false,
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
    case "wrap":
      return isEthIn ? "wrap-ready" : "unwrap-ready";
    case "success":
      break;
  }

  if (priceImpactSeverity === "error") return "price-impact-too-high";
  if (amountOutMinimum === 0n) return "amount-too-small";
  // 보내는 토큰이 ETH이면 approve가 필요 없다(F7 DoD-1).
  if (isEthIn) return "swap-ready";
  if (allowanceStatus === "error") return "allowance-error";
  if (allowanceStatus !== "success" || allowance === null || amountInRaw === null) {
    return "checking-allowance";
  }
  if (allowance >= amountInRaw) return "swap-ready";
  return batchAvailable ? "batch-ready" : "approve-required";
}

// 활성 상태(F7 스펙 §4.3, batch-calls 스펙 DoD-5). 미연결(지갑 연결 모달, F1)과
// `wrap-ready`·`unwrap-ready`·`batch-ready`·`approve-required`·`swap-ready`만 누를 수 있다.
const ENABLED_PRIMARY_BUTTON_STATES: ReadonlySet<PrimaryButtonState> = new Set([
  "disconnected",
  "wrap-ready",
  "unwrap-ready",
  "batch-ready",
  "approve-required",
  "swap-ready",
]);

/**
 * 주 버튼을 누를 수 있으면 참이다. `disconnected`, `wrap-ready`, `unwrap-ready`, `batch-ready`, `approve-required`,
 * `swap-ready`만 활성이다. `batching`은 비활성이다(batch-calls 스펙 DoD-13).
 */
export function isPrimaryButtonEnabled(state: PrimaryButtonState): boolean {
  return ENABLED_PRIMARY_BUTTON_STATES.has(state);
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
  // `PrimaryButtonStateParams.batchAvailable`과 같다. 없으면 `false`다.
  batchAvailable?: boolean;
};

/**
 * 화면의 원래 값(토큰·금액·잔액, 견적, 최소 수령량, allowance)으로 `getPrimaryButtonState`의 입력을 만든다.
 * 입력 상태는 `getSwapInputState`, 보내는 토큰이 ETH인지는 `isNativeToken`, 등급은 `getPriceImpactSeverity`로 정한다.
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
  batchAvailable = false,
}: PrimaryButtonSourceParams): PrimaryButtonStateParams {
  return {
    walletStatus,
    phase,
    inputState: getSwapInputState({ tokenIn, tokenOut, amountInRaw, balanceInRaw }),
    quoteStatus: quote.status,
    isEthIn: tokenIn !== null && isNativeToken(tokenIn),
    priceImpactSeverity:
      quote.status === "success" ? getPriceImpactSeverity(quote.quote.priceImpactBps) : null,
    amountOutMinimum,
    allowanceStatus: allowance.status,
    allowance: allowance.allowance,
    amountInRaw,
    batchAvailable,
  };
}
