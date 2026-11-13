"use client";

import type { ReactNode } from "react";

import {
  type PriceImpactSeverity,
  formatFeeTier,
  formatPriceImpact,
  formatQuoteRate,
  getPriceImpactSeverity,
} from "@/lib/quote-format";
import { formatTokenAmount } from "@/lib/token-amount";
import { cn } from "@/lib/utils";
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
  "data-fee"?: number;
  "data-severity"?: PriceImpactSeverity;
}) {
  return (
    <div {...dataAttributes} className="flex items-center justify-between gap-4 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * 받는 칸 아래의 환율 행과 `견적 정보`(예상 수령량, 가격 영향, 수수료 티어).
 * `loading`이면 값 자리에 스켈레톤, `success`이면 견적 값을 표시하고, 그 밖의 상태(`idle`, `no-route`, `error`)에서는 렌더링하지 않는다.
 */
export function QuoteDetails() {
  const { tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const { status, quote } = useSwapQuote();

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
        </dl>
      </section>
    </div>
  );
}
