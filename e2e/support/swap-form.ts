import type { Address } from "viem";

import { type Locator, type Page, expect } from "@playwright/test";

export type SwapSide = "in" | "out";

// 스왑 카드의 칸(`in`: 보내는 칸, `out`: 받는 칸). 스펙 §4.2 식별자.
export function tokenField(page: Page, side: SwapSide): Locator {
  return page.locator(`[data-testid="token-field"][data-side="${side}"]`);
}

export function tokenButton(page: Page, side: SwapSide): Locator {
  return tokenField(page, side).getByTestId("token-button");
}

export function amountInput(page: Page, side: SwapSide): Locator {
  return tokenField(page, side).getByTestId("amount-input");
}

export function cardBalance(page: Page, side: SwapSide): Locator {
  return tokenField(page, side).getByTestId("balance");
}

export function maxButton(page: Page): Locator {
  return tokenField(page, "in").getByTestId("max-button");
}

export function flipButton(page: Page): Locator {
  return page.getByTestId("flip-button");
}

export function tokenModal(page: Page, side: SwapSide): Locator {
  return page.locator(`[data-testid="token-modal"][data-side="${side}"]`);
}

export function tokenOptions(page: Page, side: SwapSide): Locator {
  return tokenModal(page, side).getByTestId("token-option");
}

// 주소는 대소문자(체크섬)와 무관하게 찾는다.
export function tokenOption(page: Page, side: SwapSide, address: Address): Locator {
  return tokenModal(page, side).locator(
    `[data-testid="token-option"][data-token-address="${address}" i]`,
  );
}

// 칸의 토큰 버튼 주소가 기대 주소인지 대소문자와 무관하게 본다. 빈 문자열은 미선택이다.
export function tokenAddressPattern(address: Address | ""): RegExp {
  return address === "" ? /^$/ : new RegExp(`^${address}$`, "i");
}

export async function openTokenModal(page: Page, side: SwapSide): Promise<void> {
  await tokenButton(page, side).click();
  await expect(tokenModal(page, side)).toBeVisible();
}

// 칸의 토큰 모달을 열어 토큰을 고르고, 모달이 닫혀 그 칸에 반영될 때까지 기다린다.
export async function selectToken(page: Page, side: SwapSide, address: Address): Promise<void> {
  await openTokenModal(page, side);
  await tokenOption(page, side, address).click();
  await expect(tokenModal(page, side)).toBeHidden();
  await expect(tokenButton(page, side)).toHaveAttribute(
    "data-token-address",
    tokenAddressPattern(address),
  );
}

export type TokenOptionRow = { address: string; balanceRaw: string | null };

// 모달 목록의 행을 화면 순서대로 읽는다.
export async function readTokenOptionRows(page: Page, side: SwapSide): Promise<TokenOptionRow[]> {
  return tokenOptions(page, side).evaluateAll((elements) =>
    elements.map((element) => ({
      address: element.getAttribute("data-token-address") ?? "",
      balanceRaw: element.getAttribute("data-balance-raw"),
    })),
  );
}
