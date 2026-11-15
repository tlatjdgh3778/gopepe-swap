import type { Locator, Page } from "@playwright/test";

import { quoteDetails } from "./quote";

// 슬리피지 프리셋 값(스펙 §4.1·§4.3 `data-slippage-bps`).
export type SlippagePresetBps = 10 | 50 | 100;

// 스왑 카드 헤더의 팝오버 트리거(스펙 §4.3 `slippage-button`).
export function slippageButton(page: Page): Locator {
  return page.getByTestId("slippage-button");
}

export function slippagePopover(page: Page): Locator {
  return page.getByTestId("slippage-popover");
}

// 팝오버 안의 프리셋 `radio`(스펙 §4.3 `slippage-option[data-slippage-bps]`).
export function slippageOption(page: Page, bps: SlippagePresetBps): Locator {
  return slippagePopover(page).locator(
    `[data-testid="slippage-option"][data-slippage-bps="${bps}"]`,
  );
}

// 견적 정보의 최소 수령량 행과 슬리피지 허용치 행(스펙 §4.3).
export function quoteAmountOutMinimumRow(page: Page): Locator {
  return quoteDetails(page).getByTestId("quote-amount-out-minimum");
}

export function quoteSlippageRow(page: Page): Locator {
  return quoteDetails(page).getByTestId("quote-slippage");
}

export type QuoteRawPair = {
  // `quote-amount-out[data-amount-out-raw]`. 속성이 없으면 null.
  amountOutRaw: string | null;
  // `quote-amount-out-minimum[data-amount-out-minimum-raw]`. 속성이 없으면 null.
  amountOutMinimumRaw: string | null;
};

// 예상 수령량 행과 최소 수령량 행의 정수 속성을 한 번의 DOM 읽기로 함께 읽는다.
// 15초 자동 갱신 사이에 두 값이 서로 다른 견적에서 읽히지 않게 한다.
export async function readQuoteRawPair(page: Page): Promise<QuoteRawPair> {
  return quoteDetails(page).evaluate((details) => ({
    amountOutRaw:
      details
        .querySelector('[data-testid="quote-amount-out"]')
        ?.getAttribute("data-amount-out-raw") ?? null,
    amountOutMinimumRaw:
      details
        .querySelector('[data-testid="quote-amount-out-minimum"]')
        ?.getAttribute("data-amount-out-minimum-raw") ?? null,
  }));
}
