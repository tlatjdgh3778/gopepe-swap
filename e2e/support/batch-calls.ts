import type { Address, Hex } from "viem";

import { type Page, expect } from "@playwright/test";

import { readAccountCode, setAccountCode } from "./anvil";
import { primaryButton } from "./app";
import { type TxStatusValue, txStatus } from "./tx-status";

// F11 batch-calls E2E 보조(T-13, A2 방식).

// eth-infinitism Simple7702Account(포크 블록에 배포됨, T-1 (b)). `executeBatch`는 자기 호출만 허용하고 실패하면 전체를 되돌린다.
// 출처: batch-calls 계획 §1(T-1 확정). 기대값은 제품 config를 거치지 않는 리터럴이다.
export const SIMPLE_7702_ACCOUNT: Address = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";

// EIP-7702 위임 표식: `0xef0100` + 위임 대상 주소(20바이트).
export function delegationDesignator(target: Address): Hex {
  return `0xef0100${target.slice(2).toLowerCase()}`;
}

// 준비: snapshot을 잡은 뒤 계정에 Simple7702Account 위임 표식을 두고, 러너가 anvil에서 다시 읽은 코드가 그 표식인지 단정한다.
// 표식이 없으면 포크 블록의 기존 위임(sweeper)이 `executeBatch` 자기 호출을 삼켜 상태는 200인데 잔액이 바뀌지 않는다(T-1 (a)).
export async function setBatchDelegation(account: Address): Promise<void> {
  const designator = delegationDesignator(SIMPLE_7702_ACCOUNT);
  await setAccountCode(account, designator);
  expect(
    (await readAccountCode(account))?.toLowerCase(),
    "mock 계정 코드(Simple7702Account 위임 표식)",
  ).toBe(designator);
}

// 배치 opt-in(`window.__GOPEPE_E2E__.atomicBatch`)을 문서 스크립트보다 먼저 켠다.
// 앱은 연결 직후 capabilities를 한 번만 읽으므로 `openApp`(페이지 로드) 전에 부른다(스펙 §4.4, 제어값 기본 꺼짐).
export async function enableAtomicBatch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__GOPEPE_E2E__ = { ...window.__GOPEPE_E2E__, atomicBatch: true };
  });
}

// 주 버튼이 `batch-ready`이고 활성일 때까지 기다린다(스펙 §4.3 `primary-button[data-state=batch-ready]`).
export async function expectEnabledBatchReady(page: Page, timeout: number): Promise<void> {
  await expect(primaryButton(page)).toHaveAttribute("data-state", "batch-ready", { timeout });
  await expect(primaryButton(page)).toBeEnabled();
}

// 메시지 영역이 `data-kind=batch`(스펙 §4.3)이고 기대 `data-status`가 될 때까지 기다린다. 종류를 먼저 기다린 뒤 상태를 기다린다(pending → 결과).
export async function expectBatchTxStatus(
  page: Page,
  status: TxStatusValue,
  timeout: number,
): Promise<void> {
  await expect(txStatus(page)).toHaveAttribute("data-kind", "batch", { timeout });
  await expect(txStatus(page)).toHaveAttribute("data-status", status, { timeout });
}

// mock 커넥터가 지금까지 받은 지갑 요청 수. 클릭 직전에 읽어 그 뒤 요청만 잘라 보는 기준으로 쓴다.
export async function readWalletRequestCount(page: Page): Promise<number> {
  return page.evaluate(() => (window.__GOPEPE_E2E__?.walletRequests ?? []).length);
}

export type WalletSendRequestCounts = {
  walletSendCalls: number;
  ethSendTransaction: number;
  walletSendTransaction: number;
};

// `from`번째 이후 앱이 보낸 지갑 전송 요청을 메서드별로 센다. `walletRequests`에는 앱이 보낸 요청만 남는다
// (A2 래퍼 내부의 `eth_sendTransaction`·`eth_getTransactionReceipt`는 기록되지 않는다, `config/e2e-mock.ts`).
export async function countWalletSendRequestsSince(
  page: Page,
  from: number,
): Promise<WalletSendRequestCounts> {
  const methods = await page.evaluate(
    (start) =>
      (window.__GOPEPE_E2E__?.walletRequests ?? []).slice(start).map((request) => request.method),
    from,
  );
  const count = (method: string) => methods.filter((value) => value === method).length;
  return {
    walletSendCalls: count("wallet_sendCalls"),
    ethSendTransaction: count("eth_sendTransaction"),
    walletSendTransaction: count("wallet_sendTransaction"),
  };
}
