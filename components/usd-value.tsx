"use client";

import { type TokenUsdPriceState, formatUsd, toUsdMicros } from "@/lib/token-usd-price";
import { cn } from "@/lib/utils";
import type { SwapSide } from "@/providers/swap-form-provider";

// 가격 없음·조회 실패를 표시하는 기호와 그 접근성 이름(F9 스펙 §1.1).
const NO_USD_PRICE_SYMBOL = "—";
const NO_USD_PRICE_LABEL = "USD 가격 없음";

// USD 자리의 로딩 스켈레톤(F9 스펙 §4.4). 견적 스켈레톤(`quote-skeleton`)과 따로 둔다.
// 동작 줄이기 환경에서는 깜박이지 않는다.
export function UsdSkeleton({ className }: { className?: string }) {
  return (
    <span
      data-testid="usd-skeleton"
      aria-hidden
      className={cn(
        "inline-block h-3.5 w-14 rounded-sm bg-raised align-middle motion-safe:animate-pulse",
        className,
      )}
    />
  );
}

export type UsdValueState = "empty" | "loading" | "success" | "no-price" | "error";

/**
 * 금액 아래 USD 행의 상태와 USD micros. 금액이 없거나 0이면 단가 상태와 무관하게 `empty`다(F9 EC-1, EC-3).
 * 금액이 있으면 단가 상태를 따른다. 단가가 `idle`(토큰 없음)이면 `empty`다.
 */
function getUsdValue(
  amountRaw: bigint | null,
  price: TokenUsdPriceState,
): { state: UsdValueState; usdMicros: bigint | null } {
  if (amountRaw === null || amountRaw <= 0n) return { state: "empty", usdMicros: null };
  switch (price.status) {
    case "success":
      return { state: "success", usdMicros: toUsdMicros(amountRaw, price.price) };
    case "loading":
      return { state: "loading", usdMicros: null };
    case "no-price":
      return { state: "no-price", usdMicros: null };
    case "error":
      return { state: "error", usdMicros: null };
    case "idle":
      return { state: "empty", usdMicros: null };
  }
}

/**
 * 보내는·받는 칸 금액 아래의 USD 행(`usd-value`, F9 스펙 §4.4). 상태와 관계없이 늘 렌더해 행 자리를 유지한다.
 * `success`이면 `$1,187.95` 형식과 `data-usd-micros`, `loading`이면 `usd-skeleton`,
 * `no-price`·`error`이면 접근성 이름 `USD 가격 없음`인 `—`, `empty`이면 빈 행이다.
 */
export function UsdValue({
  side,
  amountRaw,
  price,
}: {
  side: SwapSide;
  // 보내는 칸은 `amountInRaw`, 받는 칸은 견적 `success`·`wrap`의 `amountOut`. 그 밖에는 `null`.
  amountRaw: bigint | null;
  price: TokenUsdPriceState;
}) {
  const { state, usdMicros } = getUsdValue(amountRaw, price);

  return (
    <div
      data-testid="usd-value"
      data-side={side}
      data-state={state}
      data-usd-micros={usdMicros === null ? undefined : usdMicros.toString()}
      className="flex min-h-5 items-center font-mono text-sm text-muted-foreground tabular-nums"
    >
      {state === "success" && usdMicros !== null && formatUsd(usdMicros)}
      {state === "loading" && <UsdSkeleton />}
      {(state === "no-price" || state === "error") && (
        <span role="img" aria-label={NO_USD_PRICE_LABEL}>
          {NO_USD_PRICE_SYMBOL}
        </span>
      )}
    </div>
  );
}

/**
 * 잔액·수령량 뒤에 `· $2,969.88`처럼 덧붙이는 USD(F9 스펙 §1.1).
 * 금액이 0보다 크고 단가가 `success`일 때만 `testId` 요소와 `data-usd-micros`가 있다.
 * 단가 첫 조회 중이면 그 자리에 `usd-skeleton`을 보이고, 그 밖(금액 없음·0, 단가 없음·실패·`idle`)에는 렌더하지 않는다(EC-6, EC-7, EC-8).
 */
export function InlineUsd({
  testId,
  amountRaw,
  price,
  className,
}: {
  testId:
    | "balance-usd"
    | "token-option-usd"
    | "quote-amount-out-usd"
    | "quote-amount-out-minimum-usd";
  amountRaw: bigint | null | undefined;
  price: TokenUsdPriceState;
  className?: string;
}) {
  if (amountRaw === null || amountRaw === undefined || amountRaw <= 0n) return null;

  if (price.status === "loading") {
    return (
      <span className={cn("font-mono text-muted-foreground tabular-nums", className)}>
        {" · "}
        <UsdSkeleton />
      </span>
    );
  }
  if (price.status !== "success") return null;

  const usdMicros = toUsdMicros(amountRaw, price.price);
  return (
    <span className={cn("font-mono text-muted-foreground tabular-nums", className)}>
      {" · "}
      <span data-testid={testId} data-usd-micros={usdMicros.toString()}>
        {formatUsd(usdMicros)}
      </span>
    </span>
  );
}
