"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useConfig } from "wagmi";

import type { Token } from "@/config/tokens";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { readTokenBalance } from "@/lib/token-balances";
import { useSelectedChain } from "@/providers/selected-chain-provider";

// 카드 잔액을 다시 읽는 주기.
export const CARD_BALANCE_REFETCH_INTERVAL_MS = 15_000;

export const CARD_BALANCE_QUERY_KEY = "card-token-balance";

/**
 * 카드 한 칸의 선택 토큰 잔액(정수). 연결 상태가 아니거나, 토큰이 없거나,
 * 같은 계정·체인·토큰으로 성공한 읽기가 아직 없으면 `null`이다(다른 키의 값을 대신 쓰지 않는다).
 * 성공한 값이 있으면 다시 읽는 중이거나 다시 읽기가 실패해도 마지막 성공 값을 돌려준다.
 *
 * 읽기마다 주기 타이머와 포커스 리스너가 생기므로 칸마다 한 번만 호출한다(`SwapFormProvider`가 호출한다).
 */
export function useTokenBalance(token: Token | null): bigint | null {
  const config = useConfig();
  const { selectedChainId } = useSelectedChain();
  const { address: account } = useWalletRestore();

  const tokenAddress = token && token.chainId === selectedChainId ? token.address : undefined;
  const enabled = account !== undefined && tokenAddress !== undefined;

  const query = useQuery({
    queryKey: [CARD_BALANCE_QUERY_KEY, selectedChainId, account ?? null, tokenAddress ?? null],
    queryFn: () => {
      if (!account || !tokenAddress) throw new Error("card balance query is disabled");
      return readTokenBalance(config.getClient({ chainId: selectedChainId }), {
        account,
        token: { address: tokenAddress },
      });
    },
    enabled,
    // 실패하면 다시 시도하지 않고 다음 주기에 읽는다.
    retry: false,
    refetchInterval: CARD_BALANCE_REFETCH_INTERVAL_MS,
    // 포커스 복귀는 아래 window `focus` 리스너 하나로만 처리한다.
    refetchOnWindowFocus: false,
  });

  const { refetch } = query;

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      // 이미 읽는 중이면 그 요청을 그대로 쓴다.
      void refetch({ cancelRefetch: false });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refetch]);

  if (!enabled) return null;
  return query.data ?? null;
}
