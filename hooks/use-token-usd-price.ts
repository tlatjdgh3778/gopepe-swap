"use client";

import { type QueryClient, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { Address } from "viem";
import { useConfig } from "wagmi";

import type { SupportedChainId } from "@/config/chains";
import type { WagmiConfig } from "@/config/wagmi";

import { TOKEN_USD_PRICE_BATCH_SIZE, readTokenUsdPrices } from "@/lib/read-token-usd-price";
import { getQuoteTokenAddress } from "@/lib/swap-quote";
import {
  type TokenUsdPriceState,
  USDC_USD_PRICE,
  type UsdPrice,
  isChainUsdc,
} from "@/lib/token-usd-price";

// 카드·견적 행이 쓰는 단가를 다시 읽는 주기(F9 DoD-26). 같은 시간 안에는 캐시된 단가를 그대로 쓴다.
export const TOKEN_USD_PRICE_REFETCH_INTERVAL_MS = 60_000;
export const TOKEN_USD_PRICE_STALE_TIME_MS = 60_000;

// 단건·일괄 훅이 공유하는 단가 쿼리 키 상수(F9 스펙 §4.2).
export const TOKEN_USD_PRICE_QUERY_KEY = "token-usd-price";
// 모달 일괄 조회의 묶음 쿼리 키 상수.
export const TOKEN_USD_PRICE_BATCH_QUERY_KEY = "token-usd-price-batch";

const IDLE: TokenUsdPriceState = { status: "idle" };
const LOADING: TokenUsdPriceState = { status: "loading" };
const NO_PRICE: TokenUsdPriceState = { status: "no-price" };
const ERROR: TokenUsdPriceState = { status: "error" };
const USDC_SUCCESS: TokenUsdPriceState = { status: "success", price: USDC_USD_PRICE };

function lowercase(address: Address): Address {
  return address.toLowerCase() as Address;
}

/**
 * 단가를 읽을 소문자 주소. `NATIVE_ETH_ADDRESS`는 같은 체인 WETH 주소로 바꿔 ETH와 WETH가 한 캐시 항목을 쓴다(DoD-4).
 */
export function getTokenUsdPriceAddress(chainId: SupportedChainId, token: Address): Address {
  return lowercase(getQuoteTokenAddress(chainId, { address: token }));
}

/**
 * 공유 단가 쿼리 키(키 상수, 체인, 바꾼 소문자 토큰 주소). `token`은 `getTokenUsdPriceAddress` 결과이고, 토큰이 없으면 `null`이다.
 */
export function getTokenUsdPriceQueryKey(chainId: SupportedChainId, token: Address | null) {
  return [TOKEN_USD_PRICE_QUERY_KEY, chainId, token] as const;
}

/**
 * 공유 단가 쿼리의 options 팩터리. 단건 훅과 모달 행 observer가 같은 키·queryFn·staleTime을 쓴다.
 * 데이터는 단가이고 `null`은 가격 없음(`no-price`)이다. 클라이언트는 선택 체인 ID로 얻는다.
 */
export function tokenUsdPriceQueryOptions(
  config: WagmiConfig,
  chainId: SupportedChainId,
  token: Address | null,
) {
  return {
    queryKey: getTokenUsdPriceQueryKey(chainId, token),
    queryFn: async (): Promise<UsdPrice | null> => {
      if (token === null) throw new Error("token usd price query is disabled");
      const prices = await readTokenUsdPrices(config.getClient({ chainId }), {
        chainId,
        tokens: [token],
      });
      return prices.get(token) ?? null;
    },
    staleTime: TOKEN_USD_PRICE_STALE_TIME_MS,
    // 실패하면 다시 시도하지 않고 다음 주기에 읽는다(EC-10).
    retry: false,
  } as const;
}

function toState(price: UsdPrice | null): TokenUsdPriceState {
  return price === null ? NO_PRICE : { status: "success", price };
}

/**
 * 카드·견적 행이 쓰는 토큰 하나의 단가 상태(F9 스펙 §4.1·§4.2).
 * - 토큰이 없으면 `idle`, 체인 네이티브 USDC는 요청 없이 정확히 $1의 `success`다(DoD-3).
 * - 이 체인·토큰으로 읽은 값이 있으면 `success`(가격 없음이면 `no-price`)다. 다시 읽기가 실패해도 그 값을 유지한다(EC-9).
 * - 읽은 값이 없고 실패했으면 `error`, 그 밖에는 `loading`이다. 다른 체인·토큰의 값을 대신 쓰지 않는다(EC-11, EC-12).
 * 60초 주기(탭이 숨겨진 동안 제외)와 창 포커스 복귀에 다시 읽고, 실패해도 다시 시도하지 않는다.
 *
 * 주기 타이머와 포커스 리스너가 호출마다 생기므로 카드 두 칸은 `SwapUsdPriceProvider`가 한 번씩만 호출한다.
 */
export function useTokenUsdPrice(
  chainId: SupportedChainId,
  token: Address | undefined,
): TokenUsdPriceState {
  const config = useConfig();
  const priceAddress = token === undefined ? null : getTokenUsdPriceAddress(chainId, token);
  const isUsdc = priceAddress !== null && isChainUsdc(chainId, priceAddress);
  const enabled = priceAddress !== null && !isUsdc;

  const query = useQuery({
    ...tokenUsdPriceQueryOptions(config, chainId, priceAddress),
    enabled,
    refetchInterval: TOKEN_USD_PRICE_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // 포커스 복귀는 아래 window `focus` 리스너 하나로만 처리한다.
    refetchOnWindowFocus: false,
  });

  const { refetch, data } = query;

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      // 이미 읽는 중이면 그 요청을 그대로 쓴다.
      void refetch({ cancelRefetch: false });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refetch]);

  // 같은 단가 값이면 같은 상태 객체다.
  const dataState = useMemo(() => (data === undefined ? null : toState(data)), [data]);

  if (priceAddress === null) return IDLE;
  if (isUsdc) return USDC_SUCCESS;
  if (dataState !== null) return dataState;
  if (query.isError) return ERROR;
  return LOADING;
}

// ─── 모달 일괄 조회 ─────────────────────────────────────────────────

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function readBatch(
  config: WagmiConfig,
  queryClient: QueryClient,
  chainId: SupportedChainId,
  tokens: readonly Address[],
): Promise<true> {
  const prices = await readTokenUsdPrices(config.getClient({ chainId }), {
    chainId,
    tokens: [...tokens],
  });
  for (const token of tokens) {
    queryClient.setQueryData(getTokenUsdPriceQueryKey(chainId, token), prices.get(token) ?? null);
  }
  return true;
}

/**
 * 토큰 모달 행들의 단가 상태(F9 스펙 §4.2). 맵 키는 넘겨받은 토큰 주소를 소문자로 바꾼 값이다.
 * - `enabled`(이번 열기의 목록 잔액 읽기 성공)가 참이 되면 `tokens`(잔액이 0보다 큰 토큰)의 단가를
 *   `TOKEN_USD_PRICE_BATCH_SIZE`개 이하 묶음으로 나눠 일괄 조회하고(DoD-30, EC-19), 결과를 공유 단가 캐시에 쓴다(DoD-29).
 *   카드에 이미 있는 단가도 다시 조회한다. ETH는 WETH로 바꿔 한 번만 읽고, 체인 네이티브 USDC는 조회하지 않는다.
 * - 묶음은 마운트(모달 열기)마다 한 번 읽고 주기·포커스·재연결·재시도로 다시 읽지 않는다(DoD-32, EC-10, EC-22).
 * - 행 상태는 공유 캐시 값이 있으면 그 값(`success`·`no-price`, 카드 갱신도 반영), 없고 그 토큰의 묶음이 실패했으면 `error`(EC-20),
 *   일괄 조회가 켜져 있으면 `loading`, 꺼져 있으면 `idle`이다.
 * 렌더마다 새 Map을 돌려준다.
 */
export function useTokenUsdPrices(
  chainId: SupportedChainId,
  tokens: Address[],
  enabled: boolean,
): ReadonlyMap<Address, TokenUsdPriceState> {
  const config = useConfig();
  const queryClient = useQueryClient();

  // 넘겨받은 소문자 주소 → 바꾼 소문자 주소.
  const entries = tokens.map(
    (token) => [lowercase(token), getTokenUsdPriceAddress(chainId, token)] as const,
  );
  // 조회할 바꾼 주소(중복 없음, USDC 제외).
  const targets = [...new Set(entries.map(([, priceAddress]) => priceAddress))].filter(
    (priceAddress) => !isChainUsdc(chainId, priceAddress),
  );
  const batches = chunk(targets, TOKEN_USD_PRICE_BATCH_SIZE);

  const batchResults = useQueries({
    queries: batches.map((batch) => ({
      queryKey: [TOKEN_USD_PRICE_BATCH_QUERY_KEY, chainId, ...batch],
      queryFn: () => readBatch(config, queryClient, chainId, batch),
      enabled,
      // 열 때마다 다시 읽고, 그 밖의 시점(재시도·포커스·재연결·주기)에는 읽지 않는다.
      staleTime: 0,
      refetchOnMount: "always" as const,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    })),
  });

  // 행 observer는 공유 단가 캐시를 읽기만 한다.
  const rowResults = useQueries({
    queries: targets.map((priceAddress) => ({
      ...tokenUsdPriceQueryOptions(config, chainId, priceAddress),
      enabled: false,
    })),
  });

  const failedTargets = new Set<Address>();
  batches.forEach((batch, index) => {
    if (batchResults[index]?.isError)
      for (const priceAddress of batch) failedTargets.add(priceAddress);
  });

  const stateByTarget = new Map<Address, TokenUsdPriceState>();
  targets.forEach((priceAddress, index) => {
    const data = rowResults[index]?.data;
    let state: TokenUsdPriceState;
    if (data !== undefined) state = toState(data);
    else if (failedTargets.has(priceAddress)) state = ERROR;
    else if (enabled) state = LOADING;
    else state = IDLE;
    stateByTarget.set(priceAddress, state);
  });

  const states = new Map<Address, TokenUsdPriceState>();
  for (const [inputKey, priceAddress] of entries) {
    states.set(
      inputKey,
      isChainUsdc(chainId, priceAddress) ? USDC_SUCCESS : (stateByTarget.get(priceAddress) ?? IDLE),
    );
  }
  return states;
}
