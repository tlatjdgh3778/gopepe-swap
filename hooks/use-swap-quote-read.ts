"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { type Address } from "viem";
import { useConfig } from "wagmi";

import { readSwapQuote } from "@/lib/read-swap-quote";
import type { SwapQuoteRequest, SwapQuoteResult } from "@/lib/swap-quote";

// 같은 입력의 견적을 다시 읽는 주기.
export const SWAP_QUOTE_REFETCH_INTERVAL_MS = 15_000;

export const SWAP_QUOTE_QUERY_KEY = "swap-quote";

export type SwapQuoteReadInput = {
  // 입력이 바뀔 때마다 올라가는 값. 이전 입력의 늦은 응답이 다른 키에만 쌓이게 한다.
  revision: number;
  // 치환 전 선택 토큰 주소(ETH는 ETH 주소 그대로).
  tokenIn: Address;
  tokenOut: Address;
  // WETH로 치환한 견적 요청. `chainId`는 선택 체인이다.
  request: SwapQuoteRequest;
};

export type SwapQuoteReadResult = {
  // 이 입력(키)으로 성공한 마지막 결과. 다시 읽는 중이거나 다시 읽기가 실패해도 남는다.
  data: SwapQuoteResult | undefined;
  isError: boolean;
};

/**
 * 견적 조회. `input`이 없거나 `enabled`가 거짓이면 읽지 않는다.
 * 실패해도 다시 시도하지 않고 15초 주기(탭이 숨겨진 동안 제외)와 창 포커스 복귀에 다시 읽는다.
 * 클라이언트는 지갑 연결 체인이 아니라 선택 체인 ID로 얻으므로 지갑 상태와 무관하게 읽는다.
 *
 * 주기 타이머와 포커스 리스너가 호출마다 생기므로 한 번만 호출한다(`SwapQuoteProvider`가 호출한다).
 */
export function useSwapQuoteRead(
  input: SwapQuoteReadInput | null,
  enabled: boolean,
): SwapQuoteReadResult {
  const config = useConfig();
  const active = input !== null && enabled;

  // queryKey에는 bigint를 넣지 않는다(기본 해시가 JSON 직렬화다).
  const queryKey = input
    ? [
        SWAP_QUOTE_QUERY_KEY,
        input.revision,
        input.request.chainId,
        input.tokenIn.toLowerCase(),
        input.tokenOut.toLowerCase(),
        input.request.amountIn.toString(),
      ]
    : [SWAP_QUOTE_QUERY_KEY, null];

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!input) throw new Error("swap quote query is disabled");
      return readSwapQuote(config.getClient({ chainId: input.request.chainId }), input.request);
    },
    enabled: active,
    // 지난 입력의 결과는 다시 쓰지 않는다(키에 revision이 있다).
    gcTime: 0,
    // 실패하면 다시 시도하지 않고 다음 주기에 읽는다.
    retry: false,
    refetchInterval: SWAP_QUOTE_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
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
