import type { Locator, Page } from "@playwright/test";

// 견적 정보 영역과 행(F3 스펙 §4.3 식별자). 받는 칸 금액 칸은 `swap-form.ts`의 `amountInput(page, "out")`이다.
export function quoteDetails(page: Page): Locator {
  return page.getByTestId("quote-details");
}

export function quoteAmountOutRow(page: Page): Locator {
  return quoteDetails(page).getByTestId("quote-amount-out");
}

export function quotePriceImpactRow(page: Page): Locator {
  return quoteDetails(page).getByTestId("quote-price-impact");
}

export function quoteFeeTierRow(page: Page): Locator {
  return quoteDetails(page).getByTestId("quote-fee-tier");
}

// 가격 영향 등급 값(F3 스펙 §4.3).
export const PRICE_IMPACT_SEVERITY = /^(normal|warning|error)$/;
