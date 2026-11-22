"use client";

import { useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";

import { TOKENS_BY_CHAIN } from "@/config/tokens";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { readTokenListBalances } from "@/lib/token-balances";
import type { TokenBalances } from "@/lib/token-list";
import { useSelectedChain } from "@/providers/selected-chain-provider";

export const TOKEN_LIST_BALANCES_QUERY_KEY = "token-list-balances";

export type TokenListBalancesRead = {
  // `useTokenListBalances`와 같은 값.
  balances: TokenBalances | null;
  // 이번 열기(이 observer의 마운트 뒤)의 목록 잔액 읽기가 성공해 끝났으면 참이다.
  // 이전 열기에서 읽어 둔 값만 있거나, 이번 읽기가 진행 중이거나 실패했으면 거짓이다(F9 DoD-30, EC-21, EC-22).
  readSucceeded: boolean;
};

/**
 * 토큰 모달 목록 전체의 잔액과 이번 열기의 읽기 성공 여부. 잔액 값과 읽기 정책은 `useTokenListBalances`와 같다.
 * `open`이 true가 될 때(또는 열린 상태로 마운트될 때)마다 한 번 다시 읽는다.
 * 같은 계정·체인으로 이전에 읽은 값이 있으면 새 읽기가 끝나기 전과 새 읽기가 실패한 뒤에도 그 값을 돌려준다.
 * 연결 상태가 아니거나 같은 계정·체인으로 성공한 읽기가 없으면 `balances`가 `null`이다.
 * 모달이 열린 동안 실패한 읽기를 다시 시도하지 않는다.
 */
export function useTokenListBalancesRead(open: boolean): TokenListBalancesRead {
  const config = useConfig();
  const { selectedChainId } = useSelectedChain();
  const { address: account } = useWalletRestore();

  const connected = account !== undefined;
  const enabled = open && connected;

  const query = useQuery({
    queryKey: [TOKEN_LIST_BALANCES_QUERY_KEY, selectedChainId, account ?? null],
    queryFn: () => {
      if (!account) throw new Error("token list balances query is disabled");
      return readTokenListBalances(config.getClient({ chainId: selectedChainId }), {
        account,
        tokens: TOKENS_BY_CHAIN[selectedChainId],
      });
    },
    enabled,
    // 열 때마다 다시 읽고, 그 밖의 시점(재시도·포커스·재연결·주기)에는 읽지 않는다.
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // 같은 계정·체인의 이전 값은 새로고침 전까지 유지한다.
    gcTime: Number.POSITIVE_INFINITY,
  });

  if (!connected) return { balances: null, readSucceeded: false };
  return {
    balances: query.data ?? null,
    readSucceeded:
      enabled && query.isFetchedAfterMount && query.status === "success" && !query.isFetching,
  };
}

/**
 * 토큰 모달 목록 전체의 잔액. `open`이 true가 될 때(또는 열린 상태로 마운트될 때)마다 한 번 다시 읽는다.
 * 같은 계정·체인으로 이전에 읽은 값이 있으면 새 읽기가 끝나기 전과 새 읽기가 실패한 뒤에도 그 값을 돌려준다.
 * 연결 상태가 아니거나 같은 계정·체인으로 성공한 읽기가 없으면 `null`이다.
 * 모달이 열린 동안 실패한 읽기를 다시 시도하지 않는다.
 */
export function useTokenListBalances(open: boolean): TokenBalances | null {
  return useTokenListBalancesRead(open).balances;
}
