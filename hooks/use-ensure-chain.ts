"use client";

import { useCallback } from "react";
import { useConfig, useSwitchChain } from "wagmi";
import { getConnection } from "wagmi/actions";

import { useSelectedChain } from "@/providers/selected-chain-provider";

export class WalletNotConnectedError extends Error {
  constructor() {
    super("Wallet is not connected.");
    this.name = "WalletNotConnectedError";
  }
}

export class ChainMismatchAfterSwitchError extends Error {
  constructor(expectedChainId: number, actualChainId: number | undefined) {
    super(`Connected chain ${actualChainId} does not match selected chain ${expectedChainId}.`);
    this.name = "ChainMismatchAfterSwitchError";
  }
}

// 앱에 연결된 체인을 선택 체인으로 맞춘다.
// - 판단 기준은 커넥션의 실제 chainId다(비지원 체인이어도 갱신되는 값). wagmi state의 chainId가 아니다.
// - 호출 시점의 최신 선택 체인과 연결 체인을 읽는다.
// - 같으면 지갑 요청 없이 resolve, 미연결이면 reject, 거부·실패면 reject하고 상태를 바꾸지 않는다.
// - 지갑에 체인이 없으면(4902) wagmi injected 커넥터의 switchChain이 체인 정보로 `wallet_addEthereumChain`까지 시도한다.
export function useEnsureChain(): () => Promise<void> {
  const config = useConfig();
  const { getSelectedChainId } = useSelectedChain();
  const { mutateAsync: switchChainAsync } = useSwitchChain();

  return useCallback(async () => {
    const targetChainId = getSelectedChainId();
    const connection = getConnection(config);
    if (connection.status !== "connected") throw new WalletNotConnectedError();
    if (connection.chainId === targetChainId) return;

    await switchChainAsync({ chainId: targetChainId });

    const after = getConnection(config);
    if (after.status !== "connected") throw new WalletNotConnectedError();
    if (after.chainId !== targetChainId) {
      throw new ChainMismatchAfterSwitchError(targetChainId, after.chainId);
    }
  }, [config, getSelectedChainId, switchChainAsync]);
}
