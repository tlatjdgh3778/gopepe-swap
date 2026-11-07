"use client";

import { LoaderCircleIcon, WalletIcon } from "lucide-react";

import { useConnectModal } from "@/components/connect-modal";
import { Button } from "@/components/ui/button";
import { RESTORING_LABEL } from "@/components/wallet-button";
import { useWalletRestore } from "@/hooks/use-wallet-restore";

// 주 버튼 상태. 위에서부터 먼저 해당하는 상태를 표시한다.
export type PrimaryButtonState = "restoring" | "disconnected" | "ready";

const baseClassName =
  "h-14 w-full gap-2 rounded-md text-base font-semibold disabled:bg-raised disabled:text-muted-foreground disabled:opacity-100";

export function PrimaryButton() {
  const wallet = useWalletRestore();
  const { openConnectModal } = useConnectModal();

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

  return (
    <Button data-testid="primary-button" data-state="ready" disabled className={baseClassName}>
      금액 입력
    </Button>
  );
}
