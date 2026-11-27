"use client";

import type { Address } from "viem";

import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";

import type { SupportedChainId } from "@/config/chains";

import {
  type WalletCapabilitiesReadInput,
  useWalletCapabilitiesRead,
} from "@/hooks/use-wallet-capabilities-read";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { isAtomicBatchStatus } from "@/lib/batch-calls";

import { useSelectedChain } from "./selected-chain-provider";

export type BatchCapabilityState = {
  // 연결 계정·선택 체인에서 원자 배치를 쓸 수 있으면 참. 읽는 중·실패·항목 없음·강등이면 거짓이다.
  available: boolean;
  // `wallet_sendCalls`가 배치 미지원 code로 실패한 계정·체인을 강등한다(EC-8). 새로고침하면 사라진다.
  markUnsupported: (chainId: SupportedChainId, account: Address) => void;
};

const BatchCapabilityContext = createContext<BatchCapabilityState | null>(null);

function getDowngradeKey(chainId: SupportedChainId, account: Address): string {
  return `${chainId}:${account.toLowerCase()}`;
}

/**
 * 연결 계정·선택 체인의 배치 가능 여부(batch-calls 스펙 DoD-1~4, EC-1·8)를 정한다.
 * `available`은 연결됨 ∧ 선택 체인 `atomic.status`가 `supported`·`ready` ∧ 그 계정·체인이 강등되지 않음이다.
 * 미연결·복원 중에는 읽지 않는다. 강등 집합은 메모리 state라 새로고침하면 사라지고,
 * 강등해도 capability를 다시 읽지 않는다(EC-2·4).
 */
export function BatchCapabilityProvider({ children }: { children: ReactNode }) {
  const { selectedChainId } = useSelectedChain();
  const { status: walletStatus, address: account } = useWalletRestore();
  const [downgraded, setDowngraded] = useState<ReadonlySet<string>>(() => new Set());

  const input: WalletCapabilitiesReadInput | null =
    walletStatus === "connected" && account !== undefined
      ? { chainId: selectedChainId, account }
      : null;

  const read = useWalletCapabilitiesRead(input);

  const available =
    input !== null &&
    isAtomicBatchStatus(read.status) &&
    !downgraded.has(getDowngradeKey(input.chainId, input.account));

  const markUnsupported = useCallback((chainId: SupportedChainId, txAccount: Address) => {
    const key = getDowngradeKey(chainId, txAccount);
    setDowngraded((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  const value = useMemo<BatchCapabilityState>(
    () => ({ available, markUnsupported }),
    [available, markUnsupported],
  );

  return (
    <BatchCapabilityContext.Provider value={value}>{children}</BatchCapabilityContext.Provider>
  );
}

// 배치 가능 여부와 강등.
export function useBatchCapability(): BatchCapabilityState {
  const value = useContext(BatchCapabilityContext);
  if (!value) throw new Error("useBatchCapability must be used within BatchCapabilityProvider");
  return value;
}
