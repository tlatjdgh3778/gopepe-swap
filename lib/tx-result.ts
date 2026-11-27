import type { Hash, ReplacementReason } from "viem";

import type { SupportedChainId } from "@/config/chains";

// ─── 결과 타입 ─────────────────────────────────────────────────────

// 단일 트랜잭션 종류(F6 스펙 §4.1, F7 스펙 §4.2).
export type SingleTxKind = "approve" | "swap" | "wrap" | "unwrap";

// 실행 종류(batch-calls 스펙 §4.1). `pendingTx.kind`·`TxResult.kind`·`tx-status[data-kind]`가 같은 값을 쓴다.
// `batch`는 approve와 swap을 `wallet_sendCalls` 한 번으로 보낸 배치다.
export type TxKind = SingleTxKind | "batch";

// 단일 트랜잭션 결과(F6 스펙 §4.1, F7 스펙 §4.2). `balanceDropped`는 approve 성공 결과에만 있고,
// swap·wrap·unwrap 성공 결과에는 없다.
export type SingleTxResult = { kind: SingleTxKind } & (
  | { status: "success"; chainId: SupportedChainId; hash: Hash; balanceDropped: boolean } // kind "approve"
  | { status: "success"; chainId: SupportedChainId; hash: Hash } // kind "swap"·"wrap"·"unwrap"
  | { status: "reverted" | "receipt-failed" | "replaced"; chainId: SupportedChainId; hash: Hash }
  | { status: "rejected" | "chain-switch-failed" | "send-failed" }
);

// 배치 결과(batch-calls 스펙 §4.1). `hash`는 마지막 receipt의 `transactionHash`이고 receipt가 없으면 없다.
// `balanceDropped`와 `replaced`가 없다.
export type BatchTxResult = { kind: "batch" } & (
  | { status: "success" | "reverted" | "receipt-failed"; chainId: SupportedChainId; hash?: Hash }
  | { status: "rejected" | "chain-switch-failed" | "send-failed" }
);

// `useSwapExecution().result`(F6 스펙 §4.1, F7 스펙 §4.2, batch-calls 스펙 §4.1).
export type TxResult = SingleTxResult | BatchTxResult;

export type TxResultStatus = TxResult["status"];

// ─── 전송 전 오류 분류 ─────────────────────────────────────────────

// EIP-1193 사용자 거부 code. viem은 4001·5000을 `UserRejectedRequestError`(code 4001)로 정규화한다.
const USER_REJECTED_CODE = 4001;

/**
 * 오류와 그 원인 체인(`cause`)의 어느 단계에든 `codes` 중 하나가 있으면 참이다.
 * viem `BaseError.walk`처럼 `cause`를 따라가되 일반 객체 cause(예: `{ code: 4001 }`)도 따라가고,
 * 순환 참조는 한 번만 본다. 오류 메시지 문구는 보지 않는다.
 */
function hasCauseCode(error: unknown, codes: ReadonlySet<number>): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "number" && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const USER_REJECTED_CODES: ReadonlySet<number> = new Set([USER_REJECTED_CODE]);

/**
 * 오류와 그 원인 체인(`cause`)의 어느 단계에든 code 4001이 있으면 참이다.
 * viem `BaseError.walk`처럼 `cause`를 따라가되 일반 객체 cause(예: `{ code: 4001 }`)도 따라가고,
 * 순환 참조는 한 번만 본다. 오류 메시지 문구는 보지 않는다.
 */
export function hasUserRejectedCode(error: unknown): boolean {
  return hasCauseCode(error, USER_REJECTED_CODES);
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

// 배치를 지원하지 않는다는 뜻의 `wallet_sendCalls` 오류 code(batch-calls 스펙 EC-7).
// -32601 메서드 없음, 4200 미지원 메서드, 5700 미지원 필수 capability, 5740 배치 너무 큼, 5750 원자 실행 미지원.
const BATCH_UNSUPPORTED_CODES: ReadonlySet<number> = new Set([-32601, 4200, 5700, 5740, 5750]);

export type BatchSendErrorClass = {
  status: "rejected" | "send-failed";
  // 참이면 이 계정·체인에서 배치를 쓰지 않도록 강등한다(batch-calls 스펙 EC-8).
  unsupported: boolean;
};

/**
 * `wallet_sendCalls` 단계 오류의 분류. 원인 체인(`cause`)의 code만 보고 메시지 문구는 보지 않는다.
 * - code 4001(viem이 5000을 4001로 정규화한 경우 포함) → `rejected`(EC-5). 4001이 있으면 다른 code보다 먼저다.
 * - -32601·4200·5700·5740·5750 → `send-failed`, `unsupported` 참(EC-7).
 * - 그 밖 → `send-failed`, `unsupported` 거짓(EC-10).
 */
export function classifyBatchSendError(error: unknown): BatchSendErrorClass {
  if (hasUserRejectedCode(error)) return { status: "rejected", unsupported: false };
  return { status: "send-failed", unsupported: hasCauseCode(error, BATCH_UNSUPPORTED_CODES) };
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

// ─── 배치 상태 결과 변환 ───────────────────────────────────────────

// 배치 상태 대기 결과. `hash`는 마지막 receipt의 `transactionHash`이고 receipt가 없으면 없다.
export type BatchStatusOutcome =
  | { status: "success" | "reverted" | "receipt-failed"; hash?: Hash }
  | { status: "send-failed" };

function isPendingBatchStatusCode(statusCode: unknown): boolean {
  return typeof statusCode === "number" && statusCode >= 100 && statusCode < 200;
}

/**
 * `wallet_getCallsStatus` 상태 코드가 최종이면 참이다. 1xx(100 이상 200 미만)만 최종이 아니다(EC-18).
 * 숫자가 아니거나 100 미만인 값도 최종으로 보고 `getBatchStatusOutcome`이 `receipt-failed`로 바꾼다(EC-24).
 * `waitForCallsStatus`의 `status` 인자로 쓴다(viem 기본 종료 조건은 201~299를 끝내지 않는다).
 */
export function isBatchStatusFinal(statusCode: unknown): boolean {
  return !isPendingBatchStatusCode(statusCode);
}

/**
 * 최종 상태 코드와 receipt를 배치 결과로 바꾼다. 상태 코드 대역으로만 판정한다.
 * - 2xx: receipt 중 하나라도 `reverted`이면 `reverted`(EC-12), 아니면 `success`(DoD-16, receipt 0개 포함 EC-22).
 * - 4xx: `send-failed`, hash 없음(EC-15).
 * - 5xx·6xx: `reverted`(EC-13·14).
 * - 3xx·700 이상·100 미만·숫자 아님: `receipt-failed`(EC-23·24).
 * - 1xx: 아직 최종이 아니라 `null`이다. 호출한 쪽은 `isBatchStatusFinal`로 1xx가 끝난 뒤에만 부른다.
 * `success`·`reverted`·`receipt-failed`의 `hash`는 receipt가 있을 때 마지막 receipt의 `transactionHash`다(DoD-17).
 */
export function getBatchStatusOutcome(
  statusCode: unknown,
  receipts: readonly ReceiptLike[] | null | undefined,
): BatchStatusOutcome | null {
  if (isPendingBatchStatusCode(statusCode)) return null;

  const list = receipts ?? [];
  const lastHash = list.length > 0 ? list[list.length - 1].transactionHash : undefined;
  const withHash = (status: "success" | "reverted" | "receipt-failed"): BatchStatusOutcome =>
    lastHash === undefined ? { status } : { status, hash: lastHash };

  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) {
    return withHash("receipt-failed");
  }
  if (statusCode >= 200 && statusCode < 300) {
    return withHash(list.some((receipt) => receipt.status === "reverted") ? "reverted" : "success");
  }
  if (statusCode >= 400 && statusCode < 500) return { status: "send-failed" };
  if (statusCode >= 500 && statusCode < 700) return withHash("reverted");
  return withHash("receipt-failed");
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
