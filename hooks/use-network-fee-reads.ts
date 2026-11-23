"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useConfig } from "wagmi";

import type { SupportedChainId } from "@/config/chains";
import type { FeeTier } from "@/config/uniswap-v3";

import { GAS_PRICE_REFETCH_MS } from "@/config/network-fee";
import { NATIVE_ETH_ADDRESS } from "@/config/tokens";
import {
  type TokenAllowanceQueryKeyParams,
  getTokenAllowanceQueryKey,
} from "@/hooks/use-token-allowance-read";
import { getCardBalanceQueryKey } from "@/hooks/use-token-balance";
import type { NetworkFeeKind, NetworkFeeTxRequest } from "@/lib/network-fee";
import { type NetworkFeeEstimate, estimateNetworkFee, readGasPrice } from "@/lib/read-network-fee";
import { readTokenBalance } from "@/lib/token-balances";

// F10 쿼리 키 상수. 키에는 bigint를 넣지 않는다(금액은 10진 문자열).
export const NETWORK_FEE_ESTIMATE_QUERY_KEY = "network-fee-estimate";
export const NETWORK_FEE_GAS_PRICE_QUERY_KEY = "network-fee-gas-price";

// 추정 키 요소(F10 DoD-36). 최소 수령량·allowance·deadline은 키에 넣지 않고 추정 시점의 최신 값을 쓴다(DoD-35).
export type NetworkFeeEstimateInput = {
  chainId: SupportedChainId;
  account: Address;
  kind: NetworkFeeKind;
  tokenIn: Address;
  tokenOut: Address;
  // swap의 견적 fee tier. 그 밖의 kind는 `null`이다.
  feeTier: FeeTier | null;
  amountInRaw: bigint;
  // approve의 금액(`getApproveAmount`). 그 밖의 kind는 `null`이다.
  approveAmount: bigint | null;
};

/**
 * 추정 쿼리 키(키 상수, 체인, 계정, kind, 보내는·받는 토큰, fee tier, `amountInRaw`, approve 금액).
 * 추정하지 않으면(`null`) 키 상수 뒤가 모두 `null`이다.
 */
export function getNetworkFeeEstimateQueryKey(input: NetworkFeeEstimateInput | null) {
  return [
    NETWORK_FEE_ESTIMATE_QUERY_KEY,
    input?.chainId ?? null,
    input?.account ?? null,
    input?.kind ?? null,
    input?.tokenIn ?? null,
    input?.tokenOut ?? null,
    input?.feeTier ?? null,
    input === null ? null : input.amountInRaw.toString(),
    input?.approveAmount == null ? null : input.approveAmount.toString(),
  ] as const;
}

/**
 * 가스 가격 쿼리 키(키 상수, 체인). 체인마다 하나다(DoD-37).
 */
export function getNetworkFeeGasPriceQueryKey(chainId: SupportedChainId) {
  return [NETWORK_FEE_GAS_PRICE_QUERY_KEY, chainId] as const;
}

export type NetworkFeeReadResult<T> = {
  // 현재 키로 성공한 마지막 값. 다시 읽는 중이거나 다시 읽기가 실패해도 남는다.
  data: T | undefined;
  isError: boolean;
};

/**
 * 트랜잭션 하나의 가스(+ L1 데이터 수수료) 추정. 키가 바뀔 때마다 한 번 읽는다(DoD-36, DoD-49).
 * `buildRequest`는 추정 시점에 불려 최신 최소 수령량·allowance·deadline으로 요청을 만든다.
 * - `staleTime` 0: 이전에 추정한 키로 돌아와도 다시 추정한다(DoD-52).
 * - 주기·포커스·재연결·재시도로 다시 읽지 않는다(DoD-35, DoD-38, EC-5). 이전 키의 값을 대신 쓰지 않는다(EC-10~13).
 * 클라이언트는 선택 체인 ID로 얻는다(EC-15).
 */
export function useNetworkFeeEstimate(
  input: NetworkFeeEstimateInput | null,
  buildRequest: (input: NetworkFeeEstimateInput) => NetworkFeeTxRequest,
): NetworkFeeReadResult<NetworkFeeEstimate> {
  const config = useConfig();

  const query = useQuery({
    queryKey: getNetworkFeeEstimateQueryKey(input),
    queryFn: () => {
      if (input === null) throw new Error("network fee estimate query is disabled");
      return estimateNetworkFee(config.getClient({ chainId: input.chainId }), {
        chainId: input.chainId,
        account: input.account,
        request: buildRequest(input),
      });
    },
    enabled: input !== null,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    data: input === null ? undefined : query.data,
    isError: input !== null && query.isError,
  };
}

/**
 * 선택 체인의 가스 가격. 체인별 쿼리 하나를 `GAS_PRICE_REFETCH_MS`마다 다시 읽는다(탭이 숨겨진 동안 제외, DoD-37).
 * 포커스·재연결·재시도로 다시 읽지 않는다(DoD-38, EC-5). 다시 읽기가 실패해도 마지막 값을 유지한다(EC-6).
 */
export function useNetworkFeeGasPrice(
  chainId: SupportedChainId,
  enabled: boolean,
): NetworkFeeReadResult<bigint> {
  const config = useConfig();

  const query = useQuery({
    queryKey: getNetworkFeeGasPriceQueryKey(chainId),
    queryFn: () => readGasPrice(config.getClient({ chainId })),
    enabled,
    staleTime: GAS_PRICE_REFETCH_MS,
    refetchInterval: GAS_PRICE_REFETCH_MS,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return { data: enabled ? query.data : undefined, isError: enabled && query.isError };
}

/**
 * 양쪽 토큰이 모두 ETH가 아닐 때 F10이 읽는 연결 계정의 ETH 잔액(DoD-39).
 * 카드 잔액 쿼리 키(선택 체인, 계정, `NATIVE_ETH_ADDRESS`)를 공유하고 `GAS_PRICE_REFETCH_MS`마다 다시 읽는다.
 * 포커스·재연결·재시도로 다시 읽지 않는다. `account`가 `null`이면 읽지 않고 `null`이다(DoD-53).
 * 성공한 값이 없으면 `null`이다.
 */
export function useNetworkFeeEthBalance(
  chainId: SupportedChainId,
  account: Address | null,
): bigint | null {
  const config = useConfig();
  const enabled = account !== null;

  const query = useQuery({
    queryKey: getCardBalanceQueryKey(chainId, account, enabled ? NATIVE_ETH_ADDRESS : null),
    queryFn: () => {
      if (account === null) throw new Error("network fee eth balance query is disabled");
      return readTokenBalance(config.getClient({ chainId }), {
        account,
        token: { address: NATIVE_ETH_ADDRESS },
      });
    },
    enabled,
    refetchInterval: GAS_PRICE_REFETCH_MS,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!enabled) return null;
  return query.data ?? null;
}

/**
 * allowance 쿼리 캐시의 현재 값(렌더 시점). observer를 만들지 않아 요청을 보내지 않는다.
 * 트랜잭션 뒤 `invalidateTokenAllowance`가 캐시를 바꾼 직후에는 구독자 알림(`useTokenAllowance()` context)이
 * 다음 tick에 오므로, 그 사이 렌더에서도 새 allowance로 kind·approve 금액을 정하려고 쓴다(EC-13, EC-14).
 * `input`이 없거나 캐시에 값이 없으면 `undefined`다.
 */
export function useCachedTokenAllowance(
  input: TokenAllowanceQueryKeyParams | null,
): bigint | undefined {
  const queryClient = useQueryClient();
  if (input === null) return undefined;
  return queryClient.getQueryData<bigint>(getTokenAllowanceQueryKey(input));
}
