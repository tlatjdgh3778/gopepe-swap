"use client";

import { useQuery } from "@tanstack/react-query";
import { useConfig } from "wagmi";

import { TOKENS_BY_CHAIN } from "@/config/tokens";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { readTokenListBalances } from "@/lib/token-balances";
import type { TokenBalances } from "@/lib/token-list";
import { useSelectedChain } from "@/providers/selected-chain-provider";

export const TOKEN_LIST_BALANCES_QUERY_KEY = "token-list-balances";

/**
 * 토큰 모달 목록 전체의 잔액. `open`이 true가 될 때(또는 열린 상태로 마운트될 때)마다 한 번 다시 읽는다.
 * 같은 계정·체인으로 이전에 읽은 값이 있으면 새 읽기가 끝나기 전과 새 읽기가 실패한 뒤에도 그 값을 돌려준다.
 * 연결 상태가 아니거나 같은 계정·체인으로 성공한 읽기가 없으면 `null`이다.
 * 모달이 열린 동안 실패한 읽기를 다시 시도하지 않는다.
 */
export function useTokenListBalances(open: boolean): TokenBalances | null {
  const config = useConfig();
  const { selectedChainId } = useSelectedChain();
  const { address: account } = useWalletRestore();

  const connected = account !== undefined;

  const query = useQuery({
    queryKey: [TOKEN_LIST_BALANCES_QUERY_KEY, selectedChainId, account ?? null],
    queryFn: () => {
      if (!account) throw new Error("token list balances query is disabled");
      return readTokenListBalances(config.getClient({ chainId: selectedChainId }), {
        account,
        tokens: TOKENS_BY_CHAIN[selectedChainId],
      });
    },
    enabled: open && connected,
    // 열 때마다 다시 읽고, 그 밖의 시점(재시도·포커스·재연결·주기)에는 읽지 않는다.
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // 같은 계정·체인의 이전 값은 새로고침 전까지 유지한다.
    gcTime: Number.POSITIVE_INFINITY,
  });

  if (!connected) return null;
  return query.data ?? null;
}
