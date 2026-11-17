import type { Address } from "viem";

import { type Locator, type Page, expect } from "@playwright/test";
import { formatUnits } from "viem";
import { mainnet } from "viem/chains";

import { chainSelect, connectWithMock, openApp, primaryButton } from "./app";
import { amountInput, selectToken } from "./swap-form";

// 견적(예열 뒤 수 ms)과 첫 allowance 읽기가 끝나 주 버튼이 `approve-required`·`swap-ready`에 멈출 때까지.
// 입력 반영 대기(300ms)와 브라우저·프록시 왕복을 넉넉하게 덮는다.
export const ALLOWANCE_SETTLE_TIMEOUT_MS = 20_000;

// 클릭부터 체결 후처리까지. `--block-time 1` 채굴, viem 영수증 폴링, allowance·잔액 다시 읽기를 덮는다.
export const TX_SETTLE_TIMEOUT_MS = 30_000;

// 지갑 트랜잭션 전송 메서드(`config/e2e-mock.ts`의 `sendTransactionError`가 막는 메서드와 같다).
const SEND_TRANSACTION_METHODS = ["eth_sendTransaction", "wallet_sendTransaction"];

// 사용자에게 알리는 메시지 영역으로 보는 접근성 role.
// Playwright role 질의는 암묵 role(`<output>` → status)과 shadow DOM 안 요소도 센다.
export function roleMessages(page: Page): Locator {
  return page.getByRole("alert").or(page.getByRole("status"));
}

// 앱을 열고 mock 커넥터로 연결한 뒤 ERC-20 페어와 금액을 입력한다. 선택 체인은 Ethereum이다.
export async function enterErc20Swap(
  page: Page,
  params: { tokenIn: Address; tokenOut: Address; amountInRaw: bigint; decimalsIn: number },
): Promise<void> {
  await openApp(page);
  await connectWithMock(page);
  await expect(chainSelect(page)).toHaveAttribute("data-selected-chain-id", String(mainnet.id));

  await selectToken(page, "in", params.tokenIn);
  await selectToken(page, "out", params.tokenOut);

  const amount = formatUnits(params.amountInRaw, params.decimalsIn);
  await amountInput(page, "in").fill(amount);
  await expect(amountInput(page, "in")).toHaveValue(amount);
}

// 주 버튼이 기대 상태이고 활성일 때까지 기다린다.
export async function expectEnabledPrimaryState(
  page: Page,
  state: "approve-required" | "swap-ready",
  timeout: number,
): Promise<void> {
  await expect(primaryButton(page)).toHaveAttribute("data-state", state, { timeout });
  await expect(primaryButton(page)).toBeEnabled();
}

// E2E 제어값으로 mock 지갑의 트랜잭션 전송을 거부(4001)하게 한다. 앱이 마운트된 뒤에 부른다.
export async function rejectWalletTransactions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = window.__GOPEPE_E2E__ ?? {};
    control.sendTransactionError = true;
    window.__GOPEPE_E2E__ = control;
  });
}

// mock 지갑이 받은 트랜잭션 전송 요청 수(거부된 요청 포함).
export async function readSendTransactionRequestCount(page: Page): Promise<number> {
  return page.evaluate(
    (methods) =>
      (window.__GOPEPE_E2E__?.walletRequests ?? []).filter((request) =>
        methods.includes(request.method),
      ).length,
    SEND_TRANSACTION_METHODS,
  );
}

// 지금부터 문서에 role이 alert·status인 요소(명시 role, `<output>`)가 붙거나 role 속성이 그 값으로 바뀌면 기록한다.
// 곧 사라지는 요소도 잡기 위해 쓴다. shadow DOM 안 변화는 보지 않으므로 `roleMessages` 개수 비교와 함께 쓴다.
export async function startRoleMessageObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selector = '[role~="alert"], [role~="status"], output';
    const seen: string[] = [];
    const record = (element: Element) => {
      seen.push(element.outerHTML.slice(0, 200));
    };
    const inspect = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(selector)) record(node);
      node.querySelectorAll(selector).forEach(record);
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") inspect(mutation.target);
        else mutation.addedNodes.forEach(inspect);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["role"],
    });
    (window as unknown as { __approveSwapRoleMessages?: string[] }).__approveSwapRoleMessages =
      seen;
  });
}

// `startRoleMessageObserver` 뒤에 생긴 role alert·status 요소 기록.
export async function readObservedRoleMessages(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __approveSwapRoleMessages?: string[] }).__approveSwapRoleMessages ??
      [],
  );
}
