"use client";

import { LoaderCircleIcon, WalletIcon } from "lucide-react";

import { useConnectModal } from "@/components/connect-modal";
import { Button } from "@/components/ui/button";
import { RESTORING_LABEL } from "@/components/wallet-button";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { type SwapInputState, getSwapInputState } from "@/lib/swap-input-state";
import { useSwapForm, useSwapFormBalances } from "@/providers/swap-form-provider";

// 주 버튼 상태. 복원 중·미연결이 먼저이고, 연결 상태에서는 입력 상태를 표시한다.
export type PrimaryButtonState = "restoring" | "disconnected" | SwapInputState;

const INPUT_STATE_LABELS: Record<SwapInputState, string> = {
  "select-token": "토큰 선택",
  "enter-amount": "금액 입력",
  "insufficient-balance": "잔액 부족",
  // F3부터 견적 상태가 이 상태를 대체한다.
  "input-valid": "금액 입력",
};

const baseClassName =
  "h-14 w-full gap-2 rounded-md text-base font-semibold disabled:bg-raised disabled:text-muted-foreground disabled:opacity-100";

export function PrimaryButton() {
  const wallet = useWalletRestore();
  const { openConnectModal } = useConnectModal();
  const { tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const balances = useSwapFormBalances();

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

  return (
    <Button data-testid="primary-button" data-state={inputState} disabled className={baseClassName}>
      {INPUT_STATE_LABELS[inputState]}
    </Button>
  );
}
