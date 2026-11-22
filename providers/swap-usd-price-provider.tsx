"use client";

import { type ReactNode, createContext, useContext, useMemo } from "react";

import { getTokenUsdPriceAddress, useTokenUsdPrice } from "@/hooks/use-token-usd-price";
import type { TokenUsdPriceState } from "@/lib/token-usd-price";

import { useSwapForm } from "./swap-form-provider";

export type SwapUsdPrices = {
  // 보내는 칸 토큰의 단가 상태.
  in: TokenUsdPriceState;
  // 받는 칸 토큰의 단가 상태.
  out: TokenUsdPriceState;
};

const SwapUsdPriceContext = createContext<SwapUsdPrices | null>(null);

/**
 * `useSwapForm()`의 선택 체인과 두 칸 토큰으로 칸별 단가 상태를 정한다(F9 스펙 §4.2).
 * 단가 읽기(주기 타이머·포커스 리스너)가 칸마다 한 번만 생기도록 여기서만 `useTokenUsdPrice`를 부른다.
 * 두 칸 토큰의 단가 주소(ETH는 WETH로 바꾼 주소)가 같으면(ETH ↔ WETH) 받는 칸은 보내는 칸 상태를 쓴다(DoD-18).
 * 선택 체인과 다른 체인의 토큰은 단가를 읽지 않는다(`idle`).
 */
export function SwapUsdPriceProvider({ children }: { children: ReactNode }) {
  const { chainId, tokenIn, tokenOut } = useSwapForm();

  const tokenInAddress = tokenIn && tokenIn.chainId === chainId ? tokenIn.address : undefined;
  const tokenOutAddress = tokenOut && tokenOut.chainId === chainId ? tokenOut.address : undefined;

  const samePriceAddress =
    tokenInAddress !== undefined &&
    tokenOutAddress !== undefined &&
    getTokenUsdPriceAddress(chainId, tokenInAddress) ===
      getTokenUsdPriceAddress(chainId, tokenOutAddress);

  const inState = useTokenUsdPrice(chainId, tokenInAddress);
  const outOwnState = useTokenUsdPrice(chainId, samePriceAddress ? undefined : tokenOutAddress);
  const outState = samePriceAddress ? inState : outOwnState;

  const value = useMemo<SwapUsdPrices>(() => ({ in: inState, out: outState }), [inState, outState]);

  return <SwapUsdPriceContext.Provider value={value}>{children}</SwapUsdPriceContext.Provider>;
}

// 보내는·받는 칸의 단가 상태.
export function useSwapUsdPrices(): SwapUsdPrices {
  const value = useContext(SwapUsdPriceContext);
  if (!value) throw new Error("useSwapUsdPrices must be used within SwapUsdPriceProvider");
  return value;
}
