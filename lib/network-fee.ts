import type { Address, Hex } from "viem";

import type { SupportedChainId } from "@/config/chains";
import type { Token } from "@/config/tokens";
import type { PrimaryButtonState } from "@/lib/primary-button-state";

import { NETWORK_FEE_WARNING_BPS } from "@/config/network-fee";
import { isWethToken } from "@/lib/swap-quote";
import {
  type ApproveAmountParams,
  type SwapTransactionParams,
  type WethTransactionParams,
  buildApproveRequest,
  buildSwapTransactionRequest,
  buildUnwrapRequest,
  buildWrapRequest,
  encodeApproveCalldata,
  encodeSwapTransactionCalldata,
  encodeWethCalldata,
} from "@/lib/swap-transaction";
import { formatTokenAmount, isNativeToken } from "@/lib/token-amount";

// 수수료 표기·경고·ETH 부족 판정은 로캘 API 없이 bigint와 문자열 연산으로만 한다.
// 예외: `ratioPercent`는 계약(F10 §4.1)이 `number`라 버림한 bigint를 안전 정수 범위 안에서만 바꾼다.

// ─── 타입(F10 스펙 §4.1) ────────────────────────────────────────────

export type NetworkFeeKind = "approve" | "swap" | "wrap" | "unwrap";
export type NetworkFeeSeverity = "normal" | "warning" | "unknown";

export type NetworkFeeState =
  | { status: "idle" } // 미연결, 주 버튼이 batch-ready·approve-required·swap-ready·wrap-ready·unwrap-ready가 아님
  | { status: "loading"; kind: NetworkFeeKind; ethShortage: boolean }
  | { status: "error"; kind: NetworkFeeKind; ethShortage: boolean }
  | {
      status: "success"; // 같은 키로 다시 읽다 실패해도 마지막 값이면 success
      kind: NetworkFeeKind;
      feeWei: bigint; // gas × gasPrice (+ L1 데이터 수수료)
      usdMicros: bigint | null; // ETH 단가 없으면 null
      severity: NetworkFeeSeverity;
      ratioPercent: number | null; // 버림 정수, 비교 불가·보내는 금액 USD 0이면 null
      ethShortage: boolean;
    };

// ─── 주 버튼 상태 → kind ─────────────────────────────────────────────

// `batch-ready`는 approve 수수료만 추정한다(batch-calls 스펙 §4.5, DoD-21·25).
const KIND_BY_PRIMARY_BUTTON_STATE: Partial<Record<PrimaryButtonState, NetworkFeeKind>> = {
  "batch-ready": "approve",
  "approve-required": "approve",
  "swap-ready": "swap",
  "wrap-ready": "wrap",
  "unwrap-ready": "unwrap",
};

/**
 * 주 버튼 상태의 수수료 kind(F10 DoD-12, batch-calls 스펙 §4.5). `batch-ready`·`approve-required`는 `approve`다.
 * `batch-ready`·`approve-required`·`swap-ready`·`wrap-ready`·`unwrap-ready` 밖
 * (복원 중, 미연결, 서명 대기·pending phase, 입력·견적·allowance 미완료 등)은 `null`(수수료 `idle`)이다.
 */
export function getNetworkFeeKind(state: PrimaryButtonState): NetworkFeeKind | null {
  return KIND_BY_PRIMARY_BUTTON_STATE[state] ?? null;
}

// 수수료 행 안내 줄 종류. `swap-pending`은 `network-fee-swap-pending`, `batch`는 `network-fee-batch-note`다.
export type NetworkFeeNote = "swap-pending" | "batch";

/**
 * 주 버튼 상태의 수수료 행 안내 줄(batch-calls 스펙 §4.3·§4.5, DoD-22·23). `approve-required`는 `swap-pending`,
 * `batch-ready`는 `batch`, 그 밖은 `null`(안내 줄 없음)이다.
 */
export function getNetworkFeeNote(state: PrimaryButtonState): NetworkFeeNote | null {
  if (state === "approve-required") return "swap-pending";
  if (state === "batch-ready") return "batch";
  return null;
}

// ─── 추정 요청 조립 ─────────────────────────────────────────────────

export type NetworkFeeTxRequestParams =
  | ({ kind: "approve" } & ApproveAmountParams)
  | ({ kind: "swap" } & SwapTransactionParams)
  | ({ kind: "wrap" } & WethTransactionParams)
  | ({ kind: "unwrap" } & WethTransactionParams);

export type NetworkFeeTxRequest = {
  to: Address;
  data: Hex;
  // 보내는 ETH(swap의 ETH 입력, wrap). 그 밖에는 `undefined`다.
  value: bigint | undefined;
};

/**
 * `eth_estimateGas`로 보낼 `{ to, data, value }`. 주 버튼이 보낼 트랜잭션과 같은 함수로 조립한다(F10 DoD-1~3).
 * - approve: `buildApproveRequest` + `encodeApproveCalldata`. 금액은 `getApproveAmount`라 USDT 초기화 단계는 `approve(0)`이다(EC-14).
 * - swap: `buildSwapTransactionRequest` + `encodeSwapTransactionCalldata`. deadline은 호출한 쪽이 정한다.
 * - wrap·unwrap: `buildWrapRequest`·`buildUnwrapRequest` + `encodeWethCalldata`.
 */
export function buildNetworkFeeTxRequest(params: NetworkFeeTxRequestParams): NetworkFeeTxRequest {
  switch (params.kind) {
    case "approve": {
      const request = buildApproveRequest(params);
      return { to: request.to, data: encodeApproveCalldata(request), value: undefined };
    }
    case "swap": {
      const request = buildSwapTransactionRequest(params);
      return {
        to: request.to,
        data: encodeSwapTransactionCalldata(request),
        value: request.value,
      };
    }
    case "wrap": {
      const request = buildWrapRequest(params);
      return { to: request.to, data: encodeWethCalldata(request), value: request.value };
    }
    case "unwrap": {
      const request = buildUnwrapRequest(params);
      return { to: request.to, data: encodeWethCalldata(request), value: undefined };
    }
  }
}

// ─── ETH 표기 ──────────────────────────────────────────────────────

const WEI_DECIMALS = 18;
const WEI_PER_ETH = 10n ** 18n;
const ETH_FEE_MAX_FRACTION_DIGITS = 8;
const ETH_FEE_SIGNIFICANT_DIGITS = 4;
// 소수 8자리의 마지막 한 자리(0.00000001 ETH).
const ETH_FEE_MIN_WEI = 10n ** BigInt(WEI_DECIMALS - ETH_FEE_MAX_FRACTION_DIGITS);
const ETH_FEE_ZERO_LABEL = "0";
const ETH_FEE_MIN_LABEL = "<0.00000001";

/**
 * 수수료 ETH 표기(단위 기호 없음, F10 §4.2).
 * - 0이면 `0`(DoD-18), 0보다 크고 0.00000001 ETH보다 작으면 `<0.00000001`(DoD-17).
 * - 1 ETH 미만은 첫 유효숫자부터 4자리까지 버림하되 소수는 최대 8자리, 끝자리 0은 지운다(DoD-16, DoD-50).
 * - 1 ETH 이상은 F2 금액 규칙(소수 4자리 버림, 끝자리 0 제거, 천 단위 쉼표)이다(DoD-51).
 * `wei`는 0 이상이다.
 */
export function formatEthFee(wei: bigint): string {
  if (wei < 0n) {
    throw new RangeError("수수료 표기는 0 이상의 값만 받습니다.");
  }
  if (wei === 0n) return ETH_FEE_ZERO_LABEL;
  if (wei < ETH_FEE_MIN_WEI) return ETH_FEE_MIN_LABEL;
  if (wei >= WEI_PER_ETH) return formatTokenAmount(wei, WEI_DECIMALS);

  const fraction = wei.toString().padStart(WEI_DECIMALS, "0");
  const firstSignificant = fraction.search(/[1-9]/);
  const digits = Math.min(
    firstSignificant + ETH_FEE_SIGNIFICANT_DIGITS,
    ETH_FEE_MAX_FRACTION_DIGITS,
  );
  return `0.${fraction.slice(0, digits).replace(/0+$/, "")}`;
}

// ─── 수수료 경고 ───────────────────────────────────────────────────

const BPS_PER_UNIT = 10_000n;
const PERCENT_PER_UNIT = 100n;
const MAX_SAFE_RATIO_PERCENT = BigInt(Number.MAX_SAFE_INTEGER);

export type NetworkFeeSeverityInput = {
  feeWei: bigint;
  // 수수료 USD micros. ETH 단가가 없으면 `null`.
  feeUsdMicros: bigint | null;
  amountInRaw: bigint;
  // 보내는 금액 USD micros. 보내는 토큰 단가가 없으면 `null`.
  amountInUsdMicros: bigint | null;
  // 보내는 토큰이 ETH 또는 선택 체인의 WETH이면 참.
  isEthLikeIn: boolean;
};

export type NetworkFeeSeverityResult = {
  severity: NetworkFeeSeverity;
  ratioPercent: number | null;
};

// 버림한 비율(%). 계약 타입이 `number`라 안전 정수 범위를 넘으면 `Number.MAX_SAFE_INTEGER`로 둔다(100% 이상이라 표시는 같다).
function toRatioPercent(fee: bigint, amount: bigint): number {
  const percent = (fee * PERCENT_PER_UNIT) / amount;
  return Number(percent > MAX_SAFE_RATIO_PERCENT ? MAX_SAFE_RATIO_PERCENT : percent);
}

// 같은 단위의 수수료와 보내는 금액 비교. 0 이상의 값만 온다.
function compareFeeToAmount(fee: bigint, amount: bigint): NetworkFeeSeverityResult {
  if (fee === 0n) {
    return { severity: "normal", ratioPercent: amount === 0n ? null : 0 };
  }
  // 보내는 금액이 0이고 수수료가 양수면 비율을 정할 수 없지만 수수료가 더 크다(EC-16).
  if (amount === 0n) return { severity: "warning", ratioPercent: null };

  // 반올림 없이 교차곱으로 비교한다: fee / amount ≥ bps / 10000 (EC-18).
  const isWarning = fee * BPS_PER_UNIT >= amount * BigInt(NETWORK_FEE_WARNING_BPS);
  return {
    severity: isWarning ? "warning" : "normal",
    ratioPercent: toRatioPercent(fee, amount),
  };
}

/**
 * 수수료 경고 수준과 버림한 비율(%)(F10 §4.2).
 * - 보내는 토큰이 ETH·WETH: `feeWei` ÷ `amountInRaw`(wei)로 정하고 USD 단가를 쓰지 않는다(DoD-24).
 * - 그 밖: 수수료 USD micros ÷ 보내는 금액 USD micros로 정한다(DoD-25).
 *   수수료 USD micros가 0이면 보내는 금액 USD를 몰라도 `normal`(EC-17), 수수료 USD를 모르거나
 *   수수료 USD가 양수인데 보내는 금액 USD를 모르면 `unknown`, `ratioPercent=null`이다(EC-20).
 * 비율 ≥ `NETWORK_FEE_WARNING_BPS`이면 `warning`(DoD-22, EC-18), 미만이면 `normal`(DoD-23)이다.
 * 보내는 금액이 0이고 수수료가 양수면 `warning`, `ratioPercent=null`이다(EC-16).
 */
export function getNetworkFeeSeverity({
  feeWei,
  feeUsdMicros,
  amountInRaw,
  amountInUsdMicros,
  isEthLikeIn,
}: NetworkFeeSeverityInput): NetworkFeeSeverityResult {
  if (isEthLikeIn) return compareFeeToAmount(feeWei, amountInRaw);

  if (feeUsdMicros === null) return { severity: "unknown", ratioPercent: null };
  if (feeUsdMicros === 0n) {
    return compareFeeToAmount(0n, amountInUsdMicros ?? 0n);
  }
  if (amountInUsdMicros === null) return { severity: "unknown", ratioPercent: null };
  return compareFeeToAmount(feeUsdMicros, amountInUsdMicros);
}

/**
 * 보내는 토큰이 ETH 또는 선택 체인의 WETH이면 참이다. `getNetworkFeeSeverity`의 `isEthLikeIn`이다(DoD-24).
 */
export function isEthLikeToken(chainId: SupportedChainId, token: Pick<Token, "address">): boolean {
  return isNativeToken(token) || isWethToken(chainId, token);
}

// ─── ETH 부족 ──────────────────────────────────────────────────────

export type EthShortageInput = {
  // 연결 계정의 ETH 잔액. 모르면 `null`.
  ethBalance: bigint | null;
  // 추정한 수수료. 추정 `loading`·`error`이면 `null`.
  feeWei: bigint | null;
  // 트랜잭션이 보내는 ETH. ETH 입력 스왑·wrap이면 보내는 금액, 그 밖은 0.
  valueWei: bigint;
};

/**
 * ETH 부족 여부(F10 §4.2). 잔액을 모르면 `false`(EC-22), 잔액이 0이면 수수료를 몰라도 `true`(EC-21),
 * 수수료를 모르면 `false`(EC-25), 그 밖에는 잔액 < `feeWei` + `valueWei`이면 `true`다(DoD-30, DoD-31, EC-23).
 */
export function isEthShortage({ ethBalance, feeWei, valueWei }: EthShortageInput): boolean {
  if (ethBalance === null) return false;
  if (ethBalance === 0n) return true;
  if (feeWei === null) return false;
  return ethBalance < feeWei + valueWei;
}

export type NetworkFeeValueWeiParams = {
  kind: NetworkFeeKind;
  // 보내는 토큰이 ETH이면 참.
  isEthIn: boolean;
  amountInRaw: bigint;
};

/**
 * `isEthShortage`의 `valueWei`. ETH 입력 스왑과 wrap이면 보내는 금액, approve·ERC-20 입력 스왑·unwrap이면 0이다(DoD-30).
 */
export function getNetworkFeeValueWei({
  kind,
  isEthIn,
  amountInRaw,
}: NetworkFeeValueWeiParams): bigint {
  if (kind === "wrap") return amountInRaw;
  if (kind === "swap" && isEthIn) return amountInRaw;
  return 0n;
}
