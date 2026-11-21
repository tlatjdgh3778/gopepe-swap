import type { Address, Hex } from "viem";

import { type Page, expect } from "@playwright/test";

import { clearAccountCode, readAccountCode } from "./anvil";
import { primaryButton } from "./app";

// F7 native-eth E2E 흐름 헬퍼.

// EIP-7702 위임 표식: `0xef0100` + 위임 대상 주소(20바이트).
export const DELEGATION_DESIGNATOR_PATTERN = /^0xef0100[0-9a-f]{40}$/i;

// ETH가 낀 페어에서 견적·allowance 뒤 주 버튼이 멈추는 활성 상태(F7 스펙 §1.1·§3.1·§3.3).
export type NativeEthEnabledPrimaryState =
  | "swap-ready"
  | "approve-required"
  | "wrap-ready"
  | "unwrap-ready";

// 주 버튼이 기대 상태이고 활성일 때까지 기다린다.
export async function expectEnabledNativeEthPrimaryState(
  page: Page,
  state: NativeEthEnabledPrimaryState,
  timeout: number,
): Promise<void> {
  await expect(primaryButton(page)).toHaveAttribute("data-state", state, { timeout });
  await expect(primaryButton(page)).toBeEnabled();
}

// 준비: 러너가 anvil에서 읽은 계정 코드가 EIP-7702 위임 표식인지 확인하고, 확인한 코드를 돌려준다.
export async function readDelegationCode(account: Address): Promise<Hex> {
  const code = await readAccountCode(account);
  expect(code, "지우기 전 mock 계정 코드").toBeDefined();
  expect(code, "지우기 전 mock 계정 코드").toMatch(DELEGATION_DESIGNATOR_PATTERN);
  return code as Hex;
}

// 준비: snapshot을 잡은 뒤 `anvil_setCode`로 계정의 위임 코드를 지우고 지워졌는지 확인한다.
export async function clearDelegationCode(account: Address): Promise<void> {
  await clearAccountCode(account);
  expect(await readAccountCode(account), "지운 뒤 mock 계정 코드").toBeUndefined();
}

// 보조 확인: snapshot revert 뒤 계정 코드가 지우기 전 위임 코드로 복원됐다.
export async function expectDelegationCodeRestored(account: Address, code: Hex): Promise<void> {
  expect(
    (await readAccountCode(account))?.toLowerCase(),
    "revert 뒤 mock 계정 코드(위임 코드 복원)",
  ).toBe(code.toLowerCase());
}
