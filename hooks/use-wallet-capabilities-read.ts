"use client";

import { useQuery } from "@tanstack/react-query";
import { type Address } from "viem";
import { useConfig } from "wagmi";
import { getCapabilities } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";

import { type AtomicCapabilityStatus, getAtomicCapabilityStatus } from "@/lib/batch-calls";

export const WALLET_ATOMIC_CAPABILITY_QUERY_KEY = "wallet-atomic-capability";

export type WalletCapabilitiesQueryKeyParams = {
  chainId: SupportedChainId;
  account: Address;
};

/**
 * atomic capability 쿼리 키(키 상수, 선택 체인, 계정). 계정 주소는 소문자로 맞추고 bigint는 넣지 않는다.
 */
export function getWalletCapabilitiesQueryKey({
  chainId,
  account,
}: WalletCapabilitiesQueryKeyParams) {
  return [WALLET_ATOMIC_CAPABILITY_QUERY_KEY, chainId, account.toLowerCase()] as const;
}

export type WalletCapabilitiesReadInput = WalletCapabilitiesQueryKeyParams;

export type WalletCapabilitiesReadResult = {
  // 이 키로 읽은 `atomic.status`. 체인 항목·`atomic` 항목이 없으면 `null`, 읽는 중·실패·비활성이면 `undefined`다.
  status: AtomicCapabilityStatus | null | undefined;
};

/**
 * 연결 계정·선택 체인의 EIP-5792 `atomic` capability 조회(batch-calls 스펙 DoD-1~4, EC-1~3).
 * `input`이 없으면(미연결·복원 중) 읽지 않는다. 요청은 커넥터(지갑)의 `wallet_getCapabilities`로 간다.
 * 키(체인·계정)가 바뀔 때만 읽는다. 실패해도 다시 시도하지 않고, 포커스 복귀·네트워크 재연결·주기 읽기도 하지 않는다(EC-2).
 * 클릭 경로에서는 이 쿼리를 다시 읽지 않는다(EC-4).
 *
 * 쿼리 observer는 한 곳에서만 만든다(`BatchCapabilityProvider`가 호출한다).
 */
export function useWalletCapabilitiesRead(
  input: WalletCapabilitiesReadInput | null,
): WalletCapabilitiesReadResult {
  const config = useConfig();
  const active = input !== null;

  const query = useQuery({
    queryKey: input
      ? getWalletCapabilitiesQueryKey(input)
      : [WALLET_ATOMIC_CAPABILITY_QUERY_KEY, null],
    queryFn: async (): Promise<AtomicCapabilityStatus | null> => {
      if (!input) throw new Error("wallet capabilities query is disabled");
      const capabilities = await getCapabilities(config, {
        account: input.account,
        chainId: input.chainId,
      });
      // TanStack Query는 `undefined` data를 오류로 보므로 항목 없음은 `null`로 둔다.
      return getAtomicCapabilityStatus(capabilities);
    },
    enabled: active,
    staleTime: 0,
    // 실패하면 다시 시도하지 않는다(EC-2).
    retry: false,
    // 주기 읽기, 네트워크 재연결 읽기, 포커스 복귀 읽기는 하지 않는다.
    refetchInterval: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  if (!active || query.isError) return { status: undefined };
  return { status: query.data };
}
