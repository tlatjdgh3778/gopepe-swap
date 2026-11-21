"use client";

import { LoaderCircleIcon, WalletIcon } from "lucide-react";

import { useConnectModal } from "@/components/connect-modal";
import { Button } from "@/components/ui/button";
import { RESTORING_LABEL } from "@/components/wallet-button";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import {
  type PrimaryButtonState,
  getPrimaryButtonState,
  getPrimaryButtonStateParams,
  isPrimaryButtonEnabled,
} from "@/lib/primary-button-state";
import { useSwapExecution } from "@/providers/swap-execution-provider";
import { useSwapForm, useSwapFormBalances } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

// F2·F5·F7 스펙 §1.1 문구. `approve-required`는 보내는 토큰 심볼 뒤에 ` 승인`을 붙인다.
// ETH가 낀 스왑도 ERC-20 페어와 같은 문구다(F7 §1.1).
// `restoring`·`disconnected`는 아이콘이 있는 버튼으로 따로 그리므로 여기서는 쓰지 않는다.
const STATE_LABELS: Record<Exclude<PrimaryButtonState, "approve-required">, string> = {
  restoring: RESTORING_LABEL,
  disconnected: "지갑 연결",
  "awaiting-signature": "지갑에서 확인",
  approving: "승인 중…",
  swapping: "스왑 중…",
  wrapping: "전환 중…",
  unwrapping: "전환 중…",
  "select-token": "토큰 선택",
  "enter-amount": "금액 입력",
  "insufficient-balance": "잔액 부족",
  quoting: "견적 계산 중…",
  "no-route": "지원하지 않는 페어",
  "quote-error": "견적을 가져올 수 없음",
  "wrap-ready": "WETH로 전환",
  "unwrap-ready": "ETH로 전환",
  "price-impact-too-high": "가격 영향이 너무 큼",
  "amount-too-small": "금액이 너무 적음",
  "allowance-error": "승인 상태를 확인할 수 없음",
  "checking-allowance": "승인 확인 중…",
  "swap-ready": "스왑",
};

const baseClassName =
  "h-14 w-full gap-2 rounded-md text-base font-semibold disabled:bg-raised disabled:text-muted-foreground disabled:opacity-100";

export function PrimaryButton() {
  const wallet = useWalletRestore();
  const { openConnectModal } = useConnectModal();
  const { tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const balances = useSwapFormBalances();
  const quote = useSwapQuote();
  const amountOutMinimum = useAmountOutMinimum();
  const allowance = useTokenAllowance();
  const { phase, approve, swap, wrap, unwrap } = useSwapExecution();

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

  // `SwapExecutionProvider`가 실행 가능 여부를 판정할 때와 같은 입력으로 판정한다.
  // 잔액을 모르면(`null`) 잔액 부족을 판정하지 않는다.
  const buttonState = getPrimaryButtonState(
    getPrimaryButtonStateParams({
      walletStatus: wallet.status,
      phase,
      tokenIn,
      tokenOut,
      amountInRaw,
      balanceInRaw: balances.in,
      quote,
      amountOutMinimum,
      allowance,
    }),
  );

  const label =
    buttonState === "approve-required"
      ? `${tokenIn?.symbol ?? ""} 승인`
      : STATE_LABELS[buttonState];

  // 연타는 `useSwapExecution()`의 잠금이 한 번으로 막는다(EC-6).
  const onClick = () => {
    if (buttonState === "approve-required") void approve();
    else if (buttonState === "swap-ready") void swap();
    else if (buttonState === "wrap-ready") void wrap();
    else if (buttonState === "unwrap-ready") void unwrap();
  };

  return (
    <Button
      data-testid="primary-button"
      data-state={buttonState}
      disabled={!isPrimaryButtonEnabled(buttonState)}
      onClick={onClick}
      className={baseClassName}
    >
      {label}
    </Button>
  );
}
