"use client";

import { type ReactNode, createContext, useContext, useMemo } from "react";

import type { TokenAllowanceStatus } from "@/lib/primary-button-state";

import {
  type TokenAllowanceReadInput,
  useTokenAllowanceRead,
} from "@/hooks/use-token-allowance-read";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { isNativeToken } from "@/lib/token-amount";

import { useSelectedChain } from "./selected-chain-provider";
import { useSwapForm } from "./swap-form-provider";

// 스펙 §4.2 `useTokenAllowance()`. `allowance`는 `status`가 `success`일 때만 `null`이 아니다.
export type TokenAllowanceState = {
  status: TokenAllowanceStatus;
  allowance: bigint | null;
};

const TokenAllowanceContext = createContext<TokenAllowanceState | null>(null);

/**
 * 연결 계정·선택 체인·보내는 토큰의 SwapRouter02 allowance 상태(스펙 §4.2)를 정한다.
 * 보내는 토큰이 없거나 ETH이거나, 선택 체인의 토큰이 아니거나, 연결 상태가 아니면(미연결·복원 중) `idle`이고 읽지 않는다.
 * 현재 키에 성공 값이 있으면 다시 읽는 중이거나 다시 읽기가 실패해도 `success`와 그 값이다.
 * 성공 값이 없으면 읽기 실패는 `error`, 그 밖에는 `loading`이다. 다른 키의 값을 대신 쓰지 않는다.
 */
export function TokenAllowanceProvider({ children }: { children: ReactNode }) {
  const { selectedChainId } = useSelectedChain();
  const { address: account } = useWalletRestore();
  const { tokenIn } = useSwapForm();

  const token =
    tokenIn && tokenIn.chainId === selectedChainId && !isNativeToken(tokenIn)
      ? tokenIn.address
      : undefined;

  const input: TokenAllowanceReadInput | null =
    account !== undefined && token !== undefined
      ? { chainId: selectedChainId, owner: account, token }
      : null;

  const read = useTokenAllowanceRead(input);

  let status: TokenAllowanceStatus;
  let allowance: bigint | null = null;
  if (input === null) {
    status = "idle";
  } else if (read.data !== undefined) {
    status = "success";
    allowance = read.data;
  } else if (read.isError) {
    status = "error";
  } else {
    status = "loading";
  }

  const value = useMemo<TokenAllowanceState>(() => ({ status, allowance }), [status, allowance]);

  return <TokenAllowanceContext.Provider value={value}>{children}</TokenAllowanceContext.Provider>;
}

// 스펙 §4.2 allowance 상태.
export function useTokenAllowance(): TokenAllowanceState {
  const value = useContext(TokenAllowanceContext);
  if (!value) throw new Error("useTokenAllowance must be used within TokenAllowanceProvider");
  return value;
}
