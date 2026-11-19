import type { Hash, ReplacementReason } from "viem";

import type { SupportedChainId } from "@/config/chains";

// ─── 결과 타입 ─────────────────────────────────────────────────────

export type TxKind = "approve" | "swap";

// `useSwapExecution().result`(스펙 §4.1). `balanceDropped`는 approve 성공 결과에만 있다.
export type TxResult = { kind: TxKind } & (
  | { status: "success"; chainId: SupportedChainId; hash: Hash; balanceDropped: boolean } // kind "approve"
  | { status: "success"; chainId: SupportedChainId; hash: Hash } // kind "swap"
  | { status: "reverted" | "receipt-failed" | "replaced"; chainId: SupportedChainId; hash: Hash }
  | { status: "rejected" | "chain-switch-failed" | "send-failed" }
);

export type TxResultStatus = TxResult["status"];

// ─── 전송 전 오류 분류 ─────────────────────────────────────────────

// EIP-1193 사용자 거부 code. viem은 4001·5000을 `UserRejectedRequestError`(code 4001)로 정규화한다.
const USER_REJECTED_CODE = 4001;

/**
 * 오류와 그 원인 체인(`cause`)의 어느 단계에든 code 4001이 있으면 참이다.
 * viem `BaseError.walk`처럼 `cause`를 따라가되 일반 객체 cause(예: `{ code: 4001 }`)도 따라가고,
 * 순환 참조는 한 번만 본다. 오류 메시지 문구는 보지 않는다.
 */
export function hasUserRejectedCode(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: unknown }).code === USER_REJECTED_CODE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 체인 확인(전환) 단계 오류의 결과 status. 원인 체인에 4001이 있으면 `rejected`(EC-2),
 * 그 밖에는 `chain-switch-failed`(EC-3)다.
 */
export function classifyChainSwitchError(error: unknown): "rejected" | "chain-switch-failed" {
  return hasUserRejectedCode(error) ? "rejected" : "chain-switch-failed";
}

/**
 * 서명·전송 단계 오류의 결과 status. 원인 체인에 4001이 있으면 `rejected`(EC-1),
 * 그 밖(-32000, -32603 포함)에는 `send-failed`(EC-4)다.
 */
export function classifySendError(error: unknown): "rejected" | "send-failed" {
  return hasUserRejectedCode(error) ? "rejected" : "send-failed";
}

// ─── 영수증 대기 결과 변환 ─────────────────────────────────────────

// 영수증 대기 결과. `hash`는 결과에 기록할 트랜잭션 해시다.
export type ReceiptOutcome = {
  status: "success" | "reverted" | "receipt-failed" | "replaced";
  hash: Hash;
};

// 변환에 필요한 영수증 필드(viem `TransactionReceipt`의 일부).
export type ReceiptLike = {
  status: "success" | "reverted";
  transactionHash: Hash;
};

/**
 * `waitForTransactionReceipt`가 resolve한 영수증과 `onReplaced`로 받은 사유를 결과로 바꾼다.
 * viem은 교체를 감지하면 `onReplaced`를 부른 뒤 대체 트랜잭션의 영수증으로 resolve한다.
 * - 사유 `cancelled`·`replaced` → `replaced`, 대체 트랜잭션 해시(EC-9). 영수증이 reverted여도 같다(EC-10).
 * - 사유 없음·`repriced` → 영수증 status(`success`·`reverted`), 영수증의 트랜잭션 해시(DoD-9, EC-7, EC-12).
 */
export function getReceiptOutcome(
  receipt: ReceiptLike,
  replacementReason?: ReplacementReason,
): ReceiptOutcome {
  if (replacementReason === "cancelled" || replacementReason === "replaced") {
    return { status: "replaced", hash: receipt.transactionHash };
  }
  return { status: receipt.status, hash: receipt.transactionHash };
}

/**
 * 영수증 대기가 reject됐을 때의 결과. 보낸 원 트랜잭션 해시로 `receipt-failed`다(EC-8).
 */
export function getReceiptFailedOutcome(originalHash: Hash): ReceiptOutcome {
  return { status: "receipt-failed", hash: originalHash };
}

// ─── 잔액 감소 판정 ────────────────────────────────────────────────

/**
 * approve 성공 결과의 `balanceDropped`. 클릭 시점 잔액과 approve 성공 뒤 다시 읽은 잔액(tx 체인·계정)이
 * 모두 있을 때 다시 읽은 값이 더 작으면 참이다(DoD-11·12). 둘 중 하나라도 없으면 거짓이다(EC-15·16).
 */
export function isBalanceDropped(
  balanceAtClick: bigint | null | undefined,
  balanceAfterApprove: bigint | null | undefined,
): boolean {
  if (balanceAtClick == null || balanceAfterApprove == null) return false;
  return balanceAfterApprove < balanceAtClick;
}
