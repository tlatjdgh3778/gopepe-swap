"use client";

import { type NetworkFeeKind, formatEthFee } from "@/lib/network-fee";
import { formatUsd } from "@/lib/token-usd-price";
import { cn } from "@/lib/utils";
import { useNetworkFee } from "@/providers/network-fee-provider";

// 수수료 행 라벨 뒤 kind 문구(F10 스펙 §1.1). wrap·unwrap은 `전환`이다.
const KIND_LABELS: Record<NetworkFeeKind, string> = {
  approve: "승인",
  swap: "스왑",
  wrap: "전환",
  unwrap: "전환",
};

// 추정 불가를 표시하는 기호와 그 접근성 이름(F10 EC-1).
const FEE_UNAVAILABLE_SYMBOL = "—";
const FEE_UNAVAILABLE_LABEL = "수수료를 추정할 수 없음";

const SWAP_PENDING_TEXT = "스왑 수수료는 승인 후에 계산돼요";
const ETH_SHORTAGE_TEXT =
  "수수료를 낼 ETH가 부족해요. 지갑이 다른 토큰으로 수수료를 내면 그 토큰 잔액이 줄 수 있어요.";
const FEE_EXCEEDS_AMOUNT_TEXT = "수수료가 보내는 금액보다 커요";

// 이 값 이상이면 비율 대신 `수수료가 보내는 금액보다 커요`를 보인다.
const FEE_EXCEEDS_AMOUNT_PERCENT = 100;

/**
 * 경고 줄 문구. 100% 미만이면 `수수료가 보내는 금액의 N%예요`(N은 버림 정수),
 * 100% 이상이거나 비율을 정할 수 없으면 `수수료가 보내는 금액보다 커요`다.
 */
function getWarningText(ratioPercent: number | null): string {
  if (ratioPercent === null || ratioPercent >= FEE_EXCEEDS_AMOUNT_PERCENT) {
    return FEE_EXCEEDS_AMOUNT_TEXT;
  }
  return `수수료가 보내는 금액의 ${ratioPercent}%예요`;
}

// 수수료 값 자리의 로딩 스켈레톤(F10 §4.4). F9 `usd-skeleton`과 같은 모양이지만 따로 둔다.
// 동작 줄이기 환경에서는 깜박이지 않는다.
function NetworkFeeSkeleton() {
  return (
    <span
      data-testid="network-fee-skeleton"
      aria-hidden
      className="inline-block h-3.5 w-24 rounded-sm bg-raised align-middle motion-safe:animate-pulse"
    />
  );
}

/**
 * 견적 정보 아래·주 버튼 위의 네트워크 수수료 행(`network-fee`, F10 스펙 §1.1·§4.4). `idle`이면 렌더하지 않는다.
 * - 값: `success`이면 `0.00042 ETH ($1.23)`(ETH 단가가 없으면 `0.00042 ETH`), `loading`이면 `network-fee-skeleton`,
 *   `error`이면 접근성 이름 `수수료를 추정할 수 없음`인 `—`다.
 * - 경고(`severity=warning`)이면 값과 경고 줄(`network-fee-warning`)이 `--warning` 색이다.
 * - approve 단계면 `network-fee-swap-pending`, ETH 부족이면 상태와 관계없이 `network-fee-eth-shortage`를 보인다.
 */
export function NetworkFee() {
  const fee = useNetworkFee();
  if (fee.status === "idle") return null;

  const success = fee.status === "success" ? fee : null;
  const isWarning = success?.severity === "warning";

  return (
    <div
      data-testid="network-fee"
      data-state={fee.status}
      data-kind={fee.kind}
      data-severity={success?.severity}
      data-fee-wei={success?.feeWei.toString()}
      data-usd-micros={
        success && success.usdMicros !== null ? success.usdMicros.toString() : undefined
      }
      className="flex flex-col gap-2 border-t border-border pt-4 text-sm"
    >
      <dl>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">{`네트워크 수수료(${KIND_LABELS[fee.kind]})`}</dt>
          <dd className={cn("text-right font-mono tabular-nums", isWarning && "text-warning")}>
            {success && (
              <>
                {`${formatEthFee(success.feeWei)} ETH`}
                {success.usdMicros !== null && (
                  <span className={cn(!isWarning && "text-muted-foreground")}>
                    {` (${formatUsd(success.usdMicros)})`}
                  </span>
                )}
              </>
            )}
            {fee.status === "loading" && <NetworkFeeSkeleton />}
            {fee.status === "error" && (
              <span role="img" aria-label={FEE_UNAVAILABLE_LABEL}>
                {FEE_UNAVAILABLE_SYMBOL}
              </span>
            )}
          </dd>
        </div>
      </dl>
      {success && isWarning && (
        <p data-testid="network-fee-warning" className="text-warning">
          {getWarningText(success.ratioPercent)}
        </p>
      )}
      {fee.kind === "approve" && (
        <p data-testid="network-fee-swap-pending" className="text-muted-foreground">
          {SWAP_PENDING_TEXT}
        </p>
      )}
      {fee.ethShortage && (
        <p data-testid="network-fee-eth-shortage" className="text-warning">
          {ETH_SHORTAGE_TEXT}
        </p>
      )}
    </div>
  );
}
