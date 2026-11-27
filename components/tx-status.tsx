"use client";

import {
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  InfoIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import type { Hash } from "viem";

import type { SupportedChainId } from "@/config/chains";

import type { SwapExecutionPhase } from "@/lib/primary-button-state";
import { getTxExplorerUrl } from "@/lib/tx-explorer";
import { type TxKind, type TxResultStatus } from "@/lib/tx-result";
import { cn } from "@/lib/utils";
import { useSwapExecution } from "@/providers/swap-execution-provider";

// 스펙 §4.3 `tx-status[data-status]`.
type TxStatusView = "none" | "pending" | TxResultStatus;

// F6·F7·batch-calls 스펙 §1.1 문구. 금액·토큰 심볼을 넣지 않는다. wrap·unwrap은 같은 문구다.
const PENDING_MESSAGES: Record<TxKind, string> = {
  approve: "승인 트랜잭션을 처리하는 중이에요",
  swap: "스왑 트랜잭션을 처리하는 중이에요",
  wrap: "전환 트랜잭션을 처리하는 중이에요",
  unwrap: "전환 트랜잭션을 처리하는 중이에요",
  batch: "승인과 스왑을 처리하는 중이에요",
};

const SUCCESS_MESSAGES: Record<TxKind, string> = {
  approve: "승인이 완료됐어요",
  swap: "스왑이 완료됐어요",
  wrap: "전환이 완료됐어요",
  unwrap: "전환이 완료됐어요",
  batch: "스왑이 완료됐어요",
};

// 트랜잭션 해시(배치는 배치 id)를 받은 뒤 결과를 기다리는 phase. 이때 pending을 표시한다
// (F6 DoD-1, F7 DoD-30, batch-calls DoD-14).
const PENDING_PHASES: ReadonlySet<SwapExecutionPhase> = new Set([
  "approving",
  "swapping",
  "wrapping",
  "unwrapping",
  "batching",
]);

const FAILURE_MESSAGES: Record<Exclude<TxResultStatus, "success">, string> = {
  rejected: "지갑에서 요청을 거절했어요",
  "chain-switch-failed":
    "네트워크를 전환하지 못했어요. 지갑에서 직접 전환한 뒤 다시 시도해 주세요.",
  "send-failed": "트랜잭션을 보내지 못했어요. 잔액과 네트워크 수수료를 확인해 주세요.",
  reverted: "트랜잭션이 실패했어요",
  "receipt-failed": "결과를 확인하지 못했어요. 탐색기에서 확인해 주세요.",
  replaced: "트랜잭션이 취소되거나 다른 트랜잭션으로 대체됐어요",
};

const LINK_LABEL = "탐색기에서 보기";

const BALANCE_NOTICE =
  "네트워크 수수료가 보내는 토큰으로 지불돼 잔액이 줄었을 수 있어요. 금액을 확인해 주세요.";

type Display = {
  status: TxStatusView;
  kind: TxKind | undefined;
  message: string | null;
  // 탐색기 링크의 체인·해시. 없으면 링크가 없다.
  tx: { chainId: SupportedChainId; hash: Hash } | null;
  dismissible: boolean;
  balanceDropped: boolean;
};

/**
 * 주 버튼 아래 트랜잭션 상태 메시지 영역(스펙 §1.1, §4.3).
 * 루트 요소 하나를 항상 마운트하고 상태가 바뀌어도 같은 노드를 유지한다. role은 `status`이고 `alert`는 쓰지 않는다.
 * 표시 우선순위: `approving`·`swapping`·`wrapping`·`unwrapping`·`batching`의 pending → `result` → `none`.
 * 잔액 감소 안내(`balanceDropped`)는 approve 성공 결과에만 있다(batch 결과에는 없다, batch-calls DoD-20).
 * 링크 체인·해시는 pending이면 `pendingTx`, 결과면 `result`의 값이다(스펙 §4.2).
 * 해시가 없으면 링크가 없다. 배치 pending과 receipt 없이 끝난 배치 결과가 그렇다(batch-calls DoD-15, EC-17).
 */
export function TxStatus() {
  const { phase, pendingTx, result, dismissResult } = useSwapExecution();

  let display: Display = {
    status: "none",
    kind: undefined,
    message: null,
    tx: null,
    dismissible: false,
    balanceDropped: false,
  };

  if (PENDING_PHASES.has(phase) && pendingTx) {
    display = {
      status: "pending",
      kind: pendingTx.kind,
      message: PENDING_MESSAGES[pendingTx.kind],
      tx:
        pendingTx.hash === undefined ? null : { chainId: pendingTx.chainId, hash: pendingTx.hash },
      dismissible: false,
      balanceDropped: false,
    };
  } else if (result) {
    display = {
      status: result.status,
      kind: result.kind,
      message:
        result.status === "success"
          ? SUCCESS_MESSAGES[result.kind]
          : FAILURE_MESSAGES[result.status],
      tx:
        "hash" in result && result.hash !== undefined
          ? { chainId: result.chainId, hash: result.hash }
          : null,
      dismissible: true,
      balanceDropped:
        result.kind === "approve" && "balanceDropped" in result && result.balanceDropped,
    };
  }

  const { status, kind, message, tx, dismissible, balanceDropped } = display;

  return (
    <div
      data-testid="tx-status"
      role="status"
      data-status={status}
      data-kind={kind}
      // 카드의 `gap-6`을 상쇄해 none일 때 빈 영역이 간격을 만들지 않게 하고, 메시지가 있을 때만 위 여백을 둔다.
      className="-mt-6"
    >
      {message !== null && (
        <div className="mt-3 flex items-start gap-3 rounded-md border border-border bg-field px-4 py-3 text-sm">
          <StatusIcon status={status} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="text-text">{message}</p>
            {balanceDropped && (
              <p data-testid="tx-balance-notice" className="text-warning">
                {BALANCE_NOTICE}
              </p>
            )}
            {tx && (
              <a
                data-testid="tx-link"
                href={getTxExplorerUrl(tx.chainId, tx.hash)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-fit items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {LINK_LABEL}
                <ExternalLinkIcon aria-hidden className="size-3.5" />
              </a>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              data-testid="tx-status-dismiss"
              onClick={dismissResult}
              className="-mt-1 -mr-2 flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:bg-border hover:text-text focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <XIcon aria-hidden className="size-4" />
              <span className="sr-only">닫기</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: TxStatusView }) {
  const className = "mt-0.5 size-4 shrink-0";
  switch (status) {
    case "pending":
      return (
        <LoaderCircleIcon
          aria-hidden
          className={cn(className, "animate-spin text-primary motion-reduce:animate-none")}
        />
      );
    case "success":
      return <CircleCheckIcon aria-hidden className={cn(className, "text-primary")} />;
    case "receipt-failed":
    case "replaced":
      return <InfoIcon aria-hidden className={cn(className, "text-warning")} />;
    case "none":
      return null;
    default:
      return <CircleAlertIcon aria-hidden className={cn(className, "text-error")} />;
  }
}
