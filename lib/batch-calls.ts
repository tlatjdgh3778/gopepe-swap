import { type Address, type Hex, maxUint256 } from "viem";

import type { SupportedChainId } from "@/config/chains";

import {
  type SwapTransactionParams,
  buildApproveRequest,
  buildSwapTransactionRequest,
  encodeApproveCalldata,
  encodeSwapTransactionCalldata,
} from "@/lib/swap-transaction";

// ─── calls 조립 ────────────────────────────────────────────────────

// `wallet_sendCalls`의 call 하나. `value`는 보낼 ETH가 있을 때만 있다.
export type BatchCall = {
  to: Address;
  data: Hex;
  value?: bigint;
};

export type BatchCallsParams = {
  chainId: SupportedChainId;
  // 보내는 토큰(ERC-20) 주소. swap의 `tokenIn`도 이 주소다.
  token: Address;
  // 현재 SwapRouter02 allowance.
  allowance: bigint;
  // swap 조건. `amountInRaw`가 보내는 금액이다. deadline은 호출한 쪽이 전송 직전에 정한다.
  swap: Omit<SwapTransactionParams, "chainId" | "tokenIn">;
};

/**
 * 배치로 보낼 `calls`(batch-calls 스펙 DoD-7·8). approve는 단일 approve와 같은 규칙(`buildApproveRequest`)으로
 * 대상·spender를 정하고, swap은 `buildSwapTransactionRequest` + `encodeSwapTransactionCalldata` 결과를 그대로 쓴다.
 * - 0 초기화 대상 토큰이고 0 < allowance < 보내는 금액: [`approve(SwapRouter02, 0)`, `approve(SwapRouter02, maxUint256)`, swap]
 * - 그 밖: [`approve(SwapRouter02, maxUint256)`, swap]
 */
export function buildBatchCalls({
  chainId,
  token,
  allowance,
  swap,
}: BatchCallsParams): BatchCall[] {
  const approve = buildApproveRequest({ chainId, token, allowance, amountInRaw: swap.amountInRaw });
  const approveCalls: BatchCall[] = [];
  // `getApproveAmount`가 0을 고르는 경우가 초기화 대상의 부분 allowance다.
  if (approve.amount === 0n) {
    approveCalls.push({ to: approve.to, data: encodeApproveCalldata(approve) });
  }
  approveCalls.push({
    to: approve.to,
    data: encodeApproveCalldata({ spender: approve.spender, amount: maxUint256 }),
  });

  const swapRequest = buildSwapTransactionRequest({
    ...swap,
    chainId,
    tokenIn: { address: token },
  });
  const swapCall: BatchCall = {
    to: swapRequest.to,
    data: encodeSwapTransactionCalldata(swapRequest),
  };
  if (swapRequest.value !== undefined) swapCall.value = swapRequest.value;

  return [...approveCalls, swapCall];
}

// ─── atomic capability 판정 ────────────────────────────────────────

// EIP-5792 `atomic` capability의 status.
export type AtomicCapabilityStatus = "supported" | "ready" | "unsupported";

const ATOMIC_CAPABILITY_STATUSES: ReadonlySet<unknown> = new Set<AtomicCapabilityStatus>([
  "supported",
  "ready",
  "unsupported",
]);

/**
 * 한 체인의 capabilities 객체(`getCapabilities({ account, chainId })` 결과)에서 `atomic.status`를 꺼낸다.
 * 객체·`atomic` 항목이 없거나 status가 `supported`·`ready`·`unsupported`가 아니면 `null`이다(DoD-3).
 */
export function getAtomicCapabilityStatus(capabilities: unknown): AtomicCapabilityStatus | null {
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const atomic: unknown = (capabilities as { atomic?: unknown }).atomic;
  if (typeof atomic !== "object" || atomic === null) return null;
  const status: unknown = (atomic as { status?: unknown }).status;
  return ATOMIC_CAPABILITY_STATUSES.has(status) ? (status as AtomicCapabilityStatus) : null;
}

/**
 * 원자 배치를 쓸 수 있는 status면 참이다. `supported`·`ready`만 참이다(DoD-1·2·3).
 */
export function isAtomicBatchStatus(status: AtomicCapabilityStatus | null | undefined): boolean {
  return status === "supported" || status === "ready";
}
