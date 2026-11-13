"use client";

import { ArrowDownIcon, ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { QuoteSkeleton } from "@/components/quote-details";
import { TokenLogo } from "@/components/token-logo";
import { TokenModal } from "@/components/token-modal";
import type { SupportedChainId } from "@/config/chains";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { formatTokenAmount } from "@/lib/token-amount";
import { cn } from "@/lib/utils";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import {
  type SwapSide,
  useSwapForm,
  useSwapFormActions,
  useSwapFormBalances,
} from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

const FIELD_LABELS: Record<SwapSide, string> = {
  in: "보내는 토큰",
  out: "받는 토큰",
};

// 잔액을 모를 때(읽는 중·실패) 잔액 자리에 표시하는 기호.
const UNKNOWN_BALANCE = "—";

// 보내는 칸(`in`)과 받는 칸(`out`). 받는 칸 금액은 견적의 예상 수령량이라 읽기 전용이다.
export function TokenField({ side }: { side: SwapSide }) {
  const { selectedChainId } = useSelectedChain();
  const wallet = useWalletRestore();
  const { tokenIn, tokenOut, amountIn } = useSwapForm();
  const { setAmountInput, setMaxAmount } = useSwapFormActions();
  const balances = useSwapFormBalances();
  const { status: quoteStatus, quote } = useSwapQuote();

  // 모달을 연 체인을 기억한다. 선택 체인이 바뀌면 닫힌 것으로 보고 상태도 비운다(EC-2).
  const [modalChainId, setModalChainId] = useState<SupportedChainId | null>(null);
  if (modalChainId !== null && modalChainId !== selectedChainId) setModalChainId(null);
  const modalOpen = modalChainId === selectedChainId;

  const token = side === "in" ? tokenIn : tokenOut;
  const balanceRaw = side === "in" ? balances.in : balances.out;
  const connected = wallet.status === "connected";
  const inputId = useId();

  // 받는 칸 값. 견적이 있으면 예상 수령량, 없으면(`idle`·`loading`·`no-route`·`error`) 빈 값이다.
  const outQuote = side === "out" && tokenOut !== null ? quote : null;

  return (
    <div
      data-testid="token-field"
      data-side={side}
      className="flex flex-col gap-3 rounded-md border border-border bg-field p-4"
    >
      <div className="flex min-h-6 items-center justify-between gap-2 text-sm">
        <label htmlFor={inputId} className="text-muted-foreground">
          {FIELD_LABELS[side]}
        </label>
        {connected && token !== null && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              잔액{" "}
              <span
                data-testid="balance"
                data-balance-raw={balanceRaw === null ? undefined : balanceRaw.toString()}
                className="font-mono text-foreground tabular-nums"
              >
                {balanceRaw === null
                  ? UNKNOWN_BALANCE
                  : formatTokenAmount(balanceRaw, token.decimals)}
              </span>
            </span>
            {side === "in" && (
              <button
                type="button"
                data-testid="max-button"
                disabled={balanceRaw === null}
                onClick={() => setMaxAmount()}
                className="rounded-sm bg-raised px-2 py-0.5 text-xs font-semibold text-primary transition-colors outline-none hover:bg-border focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:text-muted-foreground"
              >
                최대
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        {side === "in" ? (
          <input
            id={inputId}
            data-testid="amount-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="0"
            value={amountIn}
            disabled={tokenIn === null}
            onChange={(event) => setAmountInput(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-[28px] tabular-nums outline-none placeholder:text-faint disabled:cursor-not-allowed"
          />
        ) : (
          <div className="relative flex min-w-0 flex-1 items-center">
            <input
              id={inputId}
              data-testid="amount-input"
              data-amount-out-raw={outQuote ? outQuote.amountOut.toString() : undefined}
              type="text"
              readOnly
              tabIndex={-1}
              placeholder={quoteStatus === "loading" ? "" : "0"}
              value={
                outQuote && tokenOut ? formatTokenAmount(outQuote.amountOut, tokenOut.decimals) : ""
              }
              className="w-full min-w-0 bg-transparent font-mono text-[28px] text-primary tabular-nums outline-none placeholder:text-faint"
            />
            {quoteStatus === "loading" && (
              <QuoteSkeleton className="pointer-events-none absolute inset-y-0 left-0 my-auto h-8 w-36" />
            )}
          </div>
        )}

        <button
          type="button"
          data-testid="token-button"
          data-token-address={token?.address ?? ""}
          aria-haspopup="dialog"
          onClick={() => setModalChainId(selectedChainId)}
          className={cn(
            "flex h-11 shrink-0 items-center gap-2 rounded-full border px-2 font-semibold transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            token
              ? "border-border bg-raised hover:bg-border"
              : "border-transparent bg-primary pl-4 text-primary-foreground hover:bg-primary/80",
          )}
        >
          {token ? (
            <>
              <TokenLogo token={token} />
              <span>{token.symbol}</span>
            </>
          ) : (
            <span>토큰 선택</span>
          )}
          <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
        </button>
      </div>

      <TokenModal
        side={side}
        open={modalOpen}
        onOpenChange={(open) => setModalChainId(open ? selectedChainId : null)}
      />
    </div>
  );
}

// 두 칸의 토큰을 미선택을 포함해 맞바꾼다. 금액은 비워진다.
export function FlipButton() {
  const { flipTokens } = useSwapFormActions();
  return (
    <div className="relative z-10 -my-5 flex justify-center">
      <button
        type="button"
        data-testid="flip-button"
        aria-label="보내는 토큰과 받는 토큰 바꾸기"
        onClick={flipTokens}
        className="flex size-9 items-center justify-center rounded-sm border-4 border-surface bg-raised text-primary transition-colors outline-none hover:bg-border focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowDownIcon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
