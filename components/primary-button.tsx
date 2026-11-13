"use client";

import { LoaderCircleIcon, WalletIcon } from "lucide-react";

import { useConnectModal } from "@/components/connect-modal";
import { Button } from "@/components/ui/button";
import { RESTORING_LABEL } from "@/components/wallet-button";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import {
  type SwapButtonState,
  getSwapButtonState,
  getSwapInputState,
} from "@/lib/swap-input-state";
import { useSwapForm, useSwapFormBalances } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

// 주 버튼 상태(스펙 §4.2). 복원 중·미연결이 먼저이고, 연결 상태에서는 입력 상태, 입력이 유효하면 견적 상태를 표시한다.
export type PrimaryButtonState = "restoring" | "disconnected" | SwapButtonState;

const SWAP_BUTTON_STATE_LABELS: Record<SwapButtonState, string> = {
  "select-token": "토큰 선택",
  "enter-amount": "금액 입력",
  "insufficient-balance": "잔액 부족",
  quoting: "견적 계산 중…",
  "no-route": "지원하지 않는 페어",
  "quote-error": "견적을 가져올 수 없음",
  // 스왑 실행은 F5다. 그때까지 비활성이다.
  "quote-ready": "스왑",
};

const baseClassName =
  "h-14 w-full gap-2 rounded-md text-base font-semibold disabled:bg-raised disabled:text-muted-foreground disabled:opacity-100";

export function PrimaryButton() {
  const wallet = useWalletRestore();
  const { openConnectModal } = useConnectModal();
  const { tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const balances = useSwapFormBalances();
  const quote = useSwapQuote();

  if (wallet.status === "restoring") {
    return (
      <Button
        data-testid="primary-button"
        data-state="restoring"
        aria-busy
        disabled
        className={baseClassName}
      >
        <LoaderCircleIcon aria-hidden className="size-5 animate-spin" />
        <span className="sr-only">{RESTORING_LABEL}</span>
      </Button>
    );
  }

  if (wallet.status === "disconnected") {
    return (
      <Button
        data-testid="primary-button"
        data-state="disconnected"
        onClick={openConnectModal}
        className={baseClassName}
      >
        <WalletIcon aria-hidden className="size-5" />
        지갑 연결
      </Button>
    );
  }

  // 잔액을 모르면(`null`) 잔액 부족을 판정하지 않는다.
  const inputState = getSwapInputState({
    tokenIn,
    tokenOut,
    amountInRaw,
    balanceInRaw: balances.in,
  });

  const buttonState = getSwapButtonState({ inputState, quoteStatus: quote.status });

  return (
    <Button
      data-testid="primary-button"
      data-state={buttonState}
      disabled
      className={baseClassName}
    >
      {SWAP_BUTTON_STATE_LABELS[buttonState]}
    </Button>
  );
}
