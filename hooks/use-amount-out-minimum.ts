"use client";

import { getAmountOutMinimum } from "@/lib/slippage";
import { useSlippage } from "@/providers/slippage-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

/**
 * 최소 수령량(스펙 §4.2). 견적 `status`가 `success`일 때만
 * `getAmountOutMinimum(quote.amountOut, slippageBps)`이고, 그 밖에는 `null`이다.
 * `SlippageProvider`와 `SwapQuoteProvider` 안에서만 쓸 수 있다.
 */
export function useAmountOutMinimum(): bigint | null {
  const quoteState = useSwapQuote();
  const { slippageBps } = useSlippage();
  if (quoteState.status !== "success") return null;
  return getAmountOutMinimum(quoteState.quote.amountOut, slippageBps);
}
