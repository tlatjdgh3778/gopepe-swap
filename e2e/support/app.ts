import type { Chain } from "viem";

import {
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  expect,
} from "@playwright/test";

// 스펙의 복원 제한(약 5초)이 지난 뒤에도 상태를 판정할 수 있도록 넉넉하게 기다린다.
export const RESTORE_SETTLE_TIMEOUT_MS = 10_000;

// 지갑 체인 전환·추가 요청 메서드.
export const WALLET_CHAIN_CHANGE_METHODS = [
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
];

export function primaryButton(page: Page): Locator {
  return page.getByTestId("primary-button");
}

export function walletButton(page: Page): Locator {
  return page.getByTestId("wallet-button");
}

export function chainSelect(page: Page): Locator {
  return page.getByTestId("chain-select");
}

export function connectModal(page: Page): Locator {
  return page.getByTestId("connect-modal");
}

export function mockConnectorOption(page: Page): Locator {
  return connectModal(page).locator('[data-testid="connector-option"][data-connector-id="mock"]');
}

export function requireBaseURL(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("[e2e] playwright.config.ts의 baseURL이 필요하다");
  return baseURL;
}

// 테스트 안에서 표본마다 쿠키·저장소를 나누기 위해 새 브라우저 컨텍스트를 연다.
export async function newIsolatedPage(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: requireBaseURL(baseURL) });
  const page = await context.newPage();
  return { context, page };
}

// 복원이 끝날 때까지(주 버튼이 복원 중을 벗어날 때까지) 기다린다. 화면 hydration도 이 시점에 끝나 있다.
export async function waitForRestoreSettled(page: Page): Promise<void> {
  await expect(primaryButton(page)).toHaveAttribute("data-state", /^(disconnected|ready)$/, {
    timeout: RESTORE_SETTLE_TIMEOUT_MS,
  });
}

export async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await waitForRestoreSettled(page);
}

// 복원이 끝난 미연결 상태에서 주 버튼으로 연결 모달을 열고 mock 커넥터로 연결한다.
export async function connectWithMock(page: Page): Promise<void> {
  await expect(primaryButton(page)).toHaveAttribute("data-state", "disconnected");
  await primaryButton(page).click();
  await expect(connectModal(page)).toBeVisible();
  await mockConnectorOption(page).click();
  await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
}

// mock 커넥터의 계정 주소. E2E 제어값이 앱 마운트 뒤에 채운다.
export async function readMockAccount(page: Page): Promise<string> {
  const handle = await page.waitForFunction(() => window.__GOPEPE_E2E__?.mockAccount);
  return (await handle.jsonValue()) as string;
}

// mock 커넥터가 지갑 provider로 받은 요청의 메서드 목록.
export async function readWalletRequestMethods(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window.__GOPEPE_E2E__?.walletRequests ?? []).map((request) => request.method),
  );
}

// 주소는 대소문자(체크섬)와 무관하게 같은 값인지 본다.
export function sameAddressPattern(address: string): RegExp {
  return new RegExp(`^${address}$`, "i");
}

// 체인 드롭다운을 열고 해당 체인 옵션을 고른다.
export async function selectChain(page: Page, chain: Chain): Promise<void> {
  await chainSelect(page).click();
  await page.getByRole("option", { name: chain.name, exact: true }).click();
}
