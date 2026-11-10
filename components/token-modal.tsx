"use client";

import { CheckIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { TokenLogo } from "@/components/token-logo";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PINNED_TOKENS_BY_CHAIN, TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { useTokenListBalances } from "@/hooks/use-token-list-balances";
import { formatTokenAmount } from "@/lib/token-amount";
import { filterTokenList, sortTokenList } from "@/lib/token-list";
import { type SwapSide, useSwapForm, useSwapFormActions } from "@/providers/swap-form-provider";

// 검색어 입력이 멈춘 뒤 목록에 반영하기까지의 대기 시간.
export const TOKEN_SEARCH_DEBOUNCE_MS = 250;

// 검색 반영 대기 중 목록 자리에 표시하는 스켈레톤 행 수.
const SKELETON_ROW_COUNT = 6;

type TokenModalProps = {
  side: SwapSide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// 칸의 토큰 모달. 열 때마다 목록 잔액을 다시 읽고, 고르면 그 칸에 반영하고 닫는다.
export function TokenModal({ side, open, onOpenChange }: TokenModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="token-modal"
        data-side={side}
        className="flex max-h-[min(720px,calc(100dvh-2rem))] flex-col gap-4 rounded-lg border border-border bg-surface p-6 break-keep ring-0 sm:max-w-md"
      >
        <DialogTitle className="pr-8 text-xl font-semibold">토큰 선택</DialogTitle>
        <TokenModalBody side={side} open={open} onSelected={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function sameAddress(a: Token, b: Token | null): boolean {
  return (
    b !== null && a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase()
  );
}

// 모달이 닫히면 함께 언마운트되어 검색어가 비워지고, 대기 중인 반영 타이머도 정리된다.
function TokenModalBody({
  side,
  open,
  onSelected,
}: {
  side: SwapSide;
  open: boolean;
  onSelected: () => void;
}) {
  const { chainId, tokenIn, tokenOut } = useSwapForm();
  const { selectToken } = useSwapFormActions();
  const balances = useTokenListBalances(open);
  // 입력값은 바로 보이고, 목록 걸러내기에는 입력이 멈춘 뒤 반영한 검색어를 쓴다.
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const pending = query !== appliedQuery;

  useEffect(() => {
    // 비었거나 공백뿐인 검색어는 입력 시점에 바로 반영한다.
    if (query.trim() === "") return;
    const timer = setTimeout(() => setAppliedQuery(query), TOKEN_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const handleQueryChange = (next: string) => {
    setQuery(next);
    if (next.trim() === "") setAppliedQuery(next);
  };

  const current = side === "in" ? tokenIn : tokenOut;

  const sorted = useMemo(
    () => sortTokenList(TOKENS_BY_CHAIN[chainId], PINNED_TOKENS_BY_CHAIN[chainId], balances),
    [chainId, balances],
  );
  const visible = useMemo(() => filterTokenList(sorted, appliedQuery), [sorted, appliedQuery]);

  return (
    <>
      <label className="flex h-13 items-center gap-3 rounded-(--radius-pill) border border-border bg-field px-4 transition-colors focus-within:border-primary">
        <SearchIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="sr-only">토큰 검색</span>
        <input
          data-testid="token-search"
          type="text"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          placeholder="이름 또는 심볼로 검색"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
        />
      </label>

      <div className="flex items-center justify-between border-b border-border pb-2 text-xs text-muted-foreground">
        <span>토큰 이름</span>
        <span>내 잔액</span>
      </div>

      {/* 목록 영역은 결과 수·대기 여부와 관계없이 같은 높이다. */}
      <div
        aria-busy={pending || undefined}
        className="-mx-2 h-[min(22.5rem,calc(100dvh-18rem))] shrink-0 overflow-y-auto"
      >
        {pending ? (
          <TokenListSkeleton />
        ) : visible.length === 0 ? (
          <p
            data-testid="token-search-empty"
            className="py-10 text-center text-sm text-muted-foreground"
          >
            검색 결과 없음
          </p>
        ) : (
          <ul>
            {visible.map((token) => {
              const selected = sameAddress(token, current);
              const balance = balances?.get(token.address);
              return (
                <li key={token.address}>
                  <button
                    type="button"
                    data-testid="token-option"
                    data-token-address={token.address}
                    data-selected={selected ? "true" : "false"}
                    data-balance-raw={balance === undefined ? undefined : balance.toString()}
                    aria-current={selected || undefined}
                    onClick={() => {
                      selectToken(side, token);
                      onSelected();
                    }}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors outline-none hover:bg-raised focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <TokenLogo token={token} className="size-9" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-semibold">{token.symbol}</span>
                      <span className="truncate text-xs text-muted-foreground">{token.name}</span>
                    </span>
                    {balance !== undefined && (
                      <span className="shrink-0 font-mono text-sm tabular-nums">
                        {formatTokenAmount(balance, token.decimals)}
                      </span>
                    )}
                    {selected && <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function TokenListSkeleton() {
  return (
    <ul data-testid="token-list-skeleton" aria-hidden className="animate-pulse">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <li key={index} className="flex items-center gap-3 px-2 py-2.5">
          <span className="size-9 shrink-0 rounded-full bg-raised" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-3.5 w-16 rounded-sm bg-raised" />
            <span className="h-3 w-28 rounded-sm bg-raised" />
          </span>
          <span className="h-3.5 w-12 shrink-0 rounded-sm bg-raised" />
        </li>
      ))}
    </ul>
  );
}
