"use client";

import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { type Address } from "viem";
import { useConfig } from "wagmi";

import type { SupportedChainId } from "@/config/chains";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { readTokenAllowance } from "@/lib/token-allowance";

export const TOKEN_ALLOWANCE_QUERY_KEY = "token-allowance";

export type TokenAllowanceQueryKeyParams = {
  chainId: SupportedChainId;
  owner: Address;
  token: Address;
};

/**
 * allowance 쿼리 키 접두어(키 상수, 체인, 계정). 트랜잭션이 끝난 뒤 그 체인·계정의 allowance를 무효화할 때 쓴다.
 * 계정 주소는 소문자로 맞춘다.
 */
export function getTokenAllowanceQueryKeyPrefix(chainId: SupportedChainId, owner: Address) {
  return [TOKEN_ALLOWANCE_QUERY_KEY, chainId, owner.toLowerCase()] as const;
}

/**
 * allowance 쿼리 키. 접두어 뒤에 소문자 토큰 주소와 spender(체인의 SwapRouter02)가 온다.
 * bigint와 금액은 넣지 않는다(금액이 바뀌어도 다시 읽지 않는다).
 */
export function getTokenAllowanceQueryKey({ chainId, owner, token }: TokenAllowanceQueryKeyParams) {
  return [
    ...getTokenAllowanceQueryKeyPrefix(chainId, owner),
    token.toLowerCase(),
    CONTRACTS_BY_CHAIN[chainId].swapRouter02.toLowerCase(),
  ] as const;
}

/**
 * 체인·계정의 allowance 쿼리를 무효화하고, 화면이 쓰는(활성) 쿼리의 다시 읽기가 끝날 때까지 기다린다.
 * 다시 읽기가 실패해도 reject하지 않는다. 활성 쿼리가 없으면(선택 체인·계정이 다르면) 표시만 하고 바로 resolve한다.
 */
export async function invalidateTokenAllowance(
  queryClient: QueryClient,
  chainId: SupportedChainId,
  owner: Address,
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: getTokenAllowanceQueryKeyPrefix(chainId, owner),
  });
}

export type TokenAllowanceReadInput = TokenAllowanceQueryKeyParams;

export type TokenAllowanceReadResult = {
  // 이 키로 성공한 마지막 값. 다시 읽는 중이거나 다시 읽기가 실패해도 남는다.
  data: bigint | undefined;
  isError: boolean;
};

/**
 * allowance 조회. `input`이 없으면 읽지 않는다(보내는 토큰이 ETH이거나 미연결·복원 중).
 * spender는 `input.chainId` 체인의 SwapRouter02다. 클라이언트는 선택 체인 ID로 얻는다.
 * 실패해도 다시 시도하지 않는다. 주기 읽기와 네트워크 재연결 읽기는 없고, 키가 바뀔 때와 창 포커스 복귀에만 읽는다.
 * 트랜잭션 뒤 다시 읽기는 `invalidateTokenAllowance`가 맡는다.
 *
 * 포커스 리스너가 호출마다 생기므로 한 번만 호출한다(`TokenAllowanceProvider`가 호출한다).
 */
export function useTokenAllowanceRead(
  input: TokenAllowanceReadInput | null,
): TokenAllowanceReadResult {
  const config = useConfig();
  const active = input !== null;

  const query = useQuery({
    queryKey: input ? getTokenAllowanceQueryKey(input) : [TOKEN_ALLOWANCE_QUERY_KEY, null],
    queryFn: () => {
      if (!input) throw new Error("token allowance query is disabled");
      return readTokenAllowance(config.getClient({ chainId: input.chainId }), {
        owner: input.owner,
        spender: CONTRACTS_BY_CHAIN[input.chainId].swapRouter02,
        token: input.token,
      });
    },
    enabled: active,
    // 실패하면 다시 시도하지 않는다.
    retry: false,
    // 주기 읽기와 네트워크 재연결 읽기는 하지 않는다.
    refetchInterval: false,
    refetchOnReconnect: false,
    // 포커스 복귀는 아래 window `focus` 리스너 하나로만 처리한다.
    refetchOnWindowFocus: false,
  });

  const { refetch } = query;

  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      // 이미 읽는 중이면 그 요청을 그대로 쓴다.
      void refetch({ cancelRefetch: false });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, refetch]);

  if (!active) return { data: undefined, isError: false };
  return { data: query.data, isError: query.isError };
}
