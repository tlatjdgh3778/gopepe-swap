"use client";

import type { ReactNode } from "react";

import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import {
  type PriceImpactSeverity,
  formatFeeTier,
  formatPriceImpact,
  formatQuoteRate,
  getPriceImpactSeverity,
} from "@/lib/quote-format";
import { type SlippageBps, formatSlippageBps } from "@/lib/slippage";
import { formatTokenAmount } from "@/lib/token-amount";
import { cn } from "@/lib/utils";
import { useSlippage } from "@/providers/slippage-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

// 가격 영향 등급별 색(스펙 §1.1). `text-primary`는 `--accent`다.
const PRICE_IMPACT_SEVERITY_CLASS: Record<PriceImpactSeverity, string> = {
  normal: "text-primary",
  warning: "text-warning",
  error: "text-error",
};

// 견적을 기다리는 동안 값 자리에 표시하는 스켈레톤. 동작 줄이기 환경에서는 깜박이지 않는다.
export function QuoteSkeleton({ className }: { className?: string }) {
  return (
    <span
      data-testid="quote-skeleton"
      aria-hidden
      className={cn(
        "inline-block h-4 w-20 rounded-sm bg-raised motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

function QuoteRow({
  label,
  children,
  ...dataAttributes
}: {
  label: string;
  children: ReactNode;
  "data-testid": string;
  "data-amount-out-raw"?: string;
  "data-amount-out-minimum-raw"?: string;
  "data-fee"?: number;
  "data-severity"?: PriceImpactSeverity;
  "data-slippage-bps"?: SlippageBps;
}) {
  return (
    <div {...dataAttributes} className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * 받는 칸 아래의 환율 행과 `견적 정보`(예상 수령량, 최소 수령량, 가격 영향, 수수료 티어, 슬리피지 허용치).
 * `loading`이면 견적 값 자리에 스켈레톤, `success`이면 견적 값을 표시하고, 그 밖의 상태(`idle`, `no-route`, `error`)에서는 렌더링하지 않는다.
 * 최소 수령량은 `useAmountOutMinimum()`만 읽고, 슬리피지 허용치는 견적과 무관해 `loading`에서도 스켈레톤 없이 현재 값을 표시한다.
 */
export function QuoteDetails() {
  const { tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const { status, quote } = useSwapQuote();
  const amountOutMinimum = useAmountOutMinimum();
  const { slippageBps } = useSlippage();

  if (status !== "loading" && status !== "success") return null;
  if (tokenIn === null || tokenOut === null) return null;

  const ready = quote !== null && amountInRaw !== null;
  const severity = quote ? getPriceImpactSeverity(quote.priceImpactBps) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <p data-testid="quote-rate" className="font-mono text-xs text-muted-foreground tabular-nums">
        {ready ? (
          formatQuoteRate({
            tokenIn,
            tokenOut,
            amountIn: amountInRaw,
            amountOut: quote.amountOut,
          })
        ) : (
          <QuoteSkeleton className="h-3.5 w-40" />
        )}
      </p>

      <section
        data-testid="quote-details"
        aria-labelledby="quote-details-title"
        className="flex flex-col gap-3 border-t border-border pt-4"
      >
        <h2 id="quote-details-title" className="text-sm font-semibold">
          견적 정보
        </h2>
        <dl className="flex flex-col gap-2.5">
          <QuoteRow
            label="예상 수령량"
            data-testid="quote-amount-out"
            data-amount-out-raw={quote ? quote.amountOut.toString() : undefined}
          >
            {quote ? (
              `${formatTokenAmount(quote.amountOut, tokenOut.decimals)} ${tokenOut.symbol}`
            ) : (
              <QuoteSkeleton className="w-28" />
            )}
          </QuoteRow>
          <QuoteRow
            label="최소 수령량"
            data-testid="quote-amount-out-minimum"
            data-amount-out-minimum-raw={
              amountOutMinimum !== null ? amountOutMinimum.toString() : undefined
            }
          >
            {amountOutMinimum !== null ? (
              `${formatTokenAmount(amountOutMinimum, tokenOut.decimals)} ${tokenOut.symbol}`
            ) : (
              <QuoteSkeleton className="w-28" />
            )}
          </QuoteRow>
          <QuoteRow label="가격 영향" data-testid="quote-price-impact" data-severity={severity}>
            {quote && severity ? (
              <span className={PRICE_IMPACT_SEVERITY_CLASS[severity]}>
                {formatPriceImpact(quote.priceImpactBps)}
              </span>
            ) : (
              <QuoteSkeleton className="w-14" />
            )}
          </QuoteRow>
          <QuoteRow label="수수료 티어" data-testid="quote-fee-tier" data-fee={quote?.fee}>
            {quote ? formatFeeTier(quote.fee) : <QuoteSkeleton className="w-14" />}
          </QuoteRow>
          <QuoteRow
            label="슬리피지 허용치"
            data-testid="quote-slippage"
            data-slippage-bps={slippageBps}
          >
            {formatSlippageBps(slippageBps)}
          </QuoteRow>
        </dl>
      </section>
    </div>
  );
}
