"use client";

import type { Address } from "viem";

import { ChevronDownIcon, LoaderCircleIcon, WalletIcon } from "lucide-react";
import { useConnection, useDisconnect } from "wagmi";

import { useConnectModal } from "@/components/connect-modal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { cn } from "@/lib/utils";

export const RESTORING_LABEL = "지갑 연결 확인 중";

export function shortenAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const baseClassName = "shrink-0 gap-2 rounded-md px-3 text-sm font-semibold sm:px-4";

// 높이는 `className`으로 받는다(헤더가 체인 선택과 같은 값을 준다). 모든 지갑 상태에 같은 값을 쓴다.
export function WalletButton({ className }: { className?: string }) {
  const wallet = useWalletRestore();
  const connection = useConnection();
  const disconnect = useDisconnect();
  const { openConnectModal } = useConnectModal();

  if (wallet.status === "restoring") {
    return (
      <Button
        data-testid="wallet-button"
        data-state="restoring"
        aria-busy
        disabled
        className={cn(
          baseClassName,
          "w-20 sm:w-28 disabled:bg-raised disabled:text-muted-foreground disabled:opacity-100",
          className,
        )}
      >
        <LoaderCircleIcon aria-hidden className="animate-spin" />
        <span className="sr-only">{RESTORING_LABEL}</span>
      </Button>
    );
  }

  if (wallet.status === "disconnected") {
    return (
      <Button
        data-testid="wallet-button"
        data-state="disconnected"
        onClick={openConnectModal}
        className={cn(baseClassName, className)}
      >
        <WalletIcon aria-hidden className="max-sm:hidden" />
        지갑 연결
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="wallet-button"
        data-state="connected"
        data-connected-address={wallet.address}
        data-connected-chain-id={connection.chainId}
        render={
          <Button
            variant="outline"
            className={cn(
              baseClassName,
              "border-border bg-surface font-mono hover:bg-raised aria-expanded:bg-raised",
              className,
            )}
          />
        }
      >
        {wallet.address && shortenAddress(wallet.address)}
        <ChevronDownIcon aria-hidden className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-auto min-w-40 rounded-md border border-border p-1 ring-0"
      >
        <DropdownMenuItem
          data-testid="disconnect-button"
          onClick={() => disconnect.mutate()}
          className="py-2"
        >
          연결 해제
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
