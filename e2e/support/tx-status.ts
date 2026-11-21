import type { Hash } from "viem";

import { type Locator, type Page, expect } from "@playwright/test";

// 트랜잭션 상태 메시지 영역(tx-status 스펙 §4.3 식별자).
export function txStatus(page: Page): Locator {
  return page.getByTestId("tx-status");
}

// 메시지 영역 안의 탐색기 링크.
export function txLink(page: Page): Locator {
  return txStatus(page).getByTestId("tx-link");
}

// `tx-status[data-status]` 값(스펙 §4.3).
export type TxStatusValue =
  | "none"
  | "pending"
  | "success"
  | "rejected"
  | "chain-switch-failed"
  | "send-failed"
  | "reverted"
  | "receipt-failed"
  | "replaced";

// 메시지 영역이 기대 종류(`data-kind`)와 상태(`data-status`)가 될 때까지 기다린다.
// 같은 노드가 상태만 바꾸므로 종류를 먼저 기다린 뒤 상태를 기다린다(pending → 결과).
export async function expectTxStatus(
  page: Page,
  expected: { status: TxStatusValue; kind?: "approve" | "swap" | "wrap" | "unwrap" },
  timeout: number,
): Promise<void> {
  if (expected.kind !== undefined) {
    await expect(txStatus(page)).toHaveAttribute("data-kind", expected.kind, { timeout });
  }
  await expect(txStatus(page)).toHaveAttribute("data-status", expected.status, { timeout });
}

// Ethereum 탐색기 tx URL(리터럴). 기대값은 제품 config(`CHAINS_BY_ID`)를 거치지 않는다.
// 출처: tx-status 스펙 DoD-6.
export function etherscanTxUrl(hash: Hash): string {
  return `https://etherscan.io/tx/${hash}`;
}

// 기존 E2E 제어값 `sendTransactionError`에 code를 가진 Error 객체를 넣어
// mock 지갑의 트랜잭션 전송이 그 오류로 실패하게 한다(anvil로는 보내지 않는다). 앱이 마운트된 뒤에 부른다.
export async function failWalletTransactionsWith(
  page: Page,
  error: { code: number; message: string },
): Promise<void> {
  await page.evaluate(({ code, message }) => {
    const control = window.__GOPEPE_E2E__ ?? {};
    control.sendTransactionError = Object.assign(new Error(message), { code });
    window.__GOPEPE_E2E__ = control;
  }, error);
}
