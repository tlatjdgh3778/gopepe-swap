"use client";

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { NATIVE_ETH_ADDRESS } from "@/config/tokens";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import {
  type NetworkFeeEstimateInput,
  useCachedTokenAllowance,
  useNetworkFeeEstimate,
  useNetworkFeeEthBalance,
  useNetworkFeeGasPrice,
} from "@/hooks/use-network-fee-reads";
import { useTokenUsdPrice } from "@/hooks/use-token-usd-price";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import {
  type NetworkFeeNote,
  type NetworkFeeState,
  type NetworkFeeTxRequest,
  buildNetworkFeeTxRequest,
  getNetworkFeeKind,
  getNetworkFeeNote,
  getNetworkFeeSeverity,
  getNetworkFeeValueWei,
  isEthLikeToken,
  isEthShortage,
} from "@/lib/network-fee";
import { getPrimaryButtonState, getPrimaryButtonStateParams } from "@/lib/primary-button-state";
import { getApproveAmount, getSwapDeadline } from "@/lib/swap-transaction";
import { isNativeToken } from "@/lib/token-amount";
import { toUsdMicros } from "@/lib/token-usd-price";

import { useBatchCapability } from "./batch-capability-provider";
import { useSelectedChain } from "./selected-chain-provider";
import { useSwapExecution } from "./swap-execution-provider";
import { useSwapForm, useSwapFormBalances } from "./swap-form-provider";
import { useSwapQuote } from "./swap-quote-provider";
import { useSwapUsdPrices } from "./swap-usd-price-provider";
import { type TokenAllowanceState, useTokenAllowance } from "./token-allowance-provider";

const IDLE: NetworkFeeState = { status: "idle" };

const NetworkFeeContext = createContext<NetworkFeeState | null>(null);
// 수수료 행 안내 줄. `NetworkFeeState`(F10 §4.1)를 바꾸지 않으려고 따로 둔다. `undefined`는 provider 밖이다.
const NetworkFeeNoteContext = createContext<NetworkFeeNote | null | undefined>(undefined);

/**
 * 주 버튼이 다음에 보낼 트랜잭션의 네트워크 수수료 상태(F10 스펙 §4.1)를 정한다.
 * - 주 버튼 상태는 `PrimaryButton`과 같은 입력(배치 가능 여부 포함)으로 다시 계산하고, `batch-ready`·`approve-required`·
 *   `swap-ready`·`wrap-ready`·`unwrap-ready`만 kind로 바꾼다(`batch-ready`는 approve, batch-calls §4.5). 그 밖(미연결,
 *   실행 phase 진행 중 포함)은 `idle`이고 F10 요청을 보내지 않는다(DoD-12, DoD-53, EC-7·8·9).
 * - 안내 줄(`useNetworkFeeNote()`)은 수수료 행이 있을 때 같은 주 버튼 상태로 정한다(batch-calls DoD-22·23).
 * - 추정 요청은 주 버튼이 보낼 트랜잭션과 같은 함수로 추정 시점에 한 번 조립한다(DoD-1~3, EC-14).
 * - 상태는 값 우선이다. 현재 키의 추정 값과 가스 가격 값이 있으면 `success`(다시 읽는 중·다시 읽기 실패 포함, EC-6),
 *   없고 어느 쪽이든 실패했으면 `error`, 그 밖에는 `loading`이다(EC-1·2·3).
 * - ETH 단가: 보내는·받는 칸이 ETH·WETH이면 그 칸 단가 상태를 쓰고, 아니면 여기서만 ETH 단가를 읽는다(DoD-14, DoD-41).
 * - ETH 잔액: 한쪽이 ETH면 그 칸 카드 잔액을 쓰고, 아니면 카드 잔액 키로 60초마다 읽는다(DoD-34, DoD-39).
 * 체인은 모두 선택 체인이다(EC-15).
 */
export function NetworkFeeProvider({ children }: { children: ReactNode }) {
  const { status: walletStatus, address: account } = useWalletRestore();
  const { phase } = useSwapExecution();
  const { available: batchAvailable } = useBatchCapability();
  const { chainId, tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const balances = useSwapFormBalances();
  const quote = useSwapQuote();
  const amountOutMinimum = useAmountOutMinimum();
  const allowanceContext = useTokenAllowance();
  const usdPrices = useSwapUsdPrices();
  const { selectedChainId } = useSelectedChain();

  // allowance는 쿼리 캐시의 렌더 시점 값을 우선한다. approve 영수증 뒤 캐시는 이미 새 값인데
  // context 알림이 다음 tick에 오면, 그 사이 렌더가 이전 allowance로 이전 kind·approve 금액의 키로 돌아가
  // 다시 추정하고 그 캐시 값을 보이게 된다(EC-13, EC-14). 키는 `TokenAllowanceProvider`와 같다.
  const cachedAllowance = useCachedTokenAllowance(
    allowanceContext.status === "success" && account !== undefined && tokenIn !== null
      ? { chainId: selectedChainId, owner: account, token: tokenIn.address }
      : null,
  );
  const allowance = useMemo<TokenAllowanceState>(
    () =>
      cachedAllowance === undefined || cachedAllowance === allowanceContext.allowance
        ? allowanceContext
        : { status: "success", allowance: cachedAllowance },
    [allowanceContext, cachedAllowance],
  );

  const primaryState = getPrimaryButtonState(
    getPrimaryButtonStateParams({
      walletStatus,
      phase,
      tokenIn,
      tokenOut,
      amountInRaw,
      balanceInRaw: balances.in,
      quote,
      amountOutMinimum,
      allowance,
      batchAvailable,
    }),
  );

  const stateKind = getNetworkFeeKind(primaryState);
  const kind =
    stateKind !== null && account !== undefined && tokenIn && tokenOut && amountInRaw !== null
      ? stateKind
      : null;
  const note = kind !== null ? getNetworkFeeNote(primaryState) : null;

  // 추정 시점의 최신 최소 수령량·allowance. 키에 넣지 않는다(DoD-35).
  const latestRef = useRef({ amountOutMinimum, allowance: allowance.allowance });
  useLayoutEffect(() => {
    latestRef.current = { amountOutMinimum, allowance: allowance.allowance };
  });

  let estimateInput: NetworkFeeEstimateInput | null = null;
  if (kind !== null && account !== undefined && tokenIn && tokenOut && amountInRaw !== null) {
    const approveAmount =
      kind === "approve" && allowance.allowance !== null
        ? getApproveAmount({
            chainId,
            token: tokenIn.address,
            allowance: allowance.allowance,
            amountInRaw,
          })
        : null;
    estimateInput = {
      chainId,
      account,
      kind,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      feeTier: kind === "swap" && quote.status === "success" ? quote.quote.fee : null,
      amountInRaw,
      approveAmount,
    };
  }

  const buildRequest = useCallback((input: NetworkFeeEstimateInput): NetworkFeeTxRequest => {
    const latest = latestRef.current;
    switch (input.kind) {
      case "approve":
        if (latest.allowance === null) throw new Error("allowance is not loaded");
        return buildNetworkFeeTxRequest({
          kind: "approve",
          chainId: input.chainId,
          token: input.tokenIn,
          allowance: latest.allowance,
          amountInRaw: input.amountInRaw,
        });
      case "swap":
        if (input.feeTier === null || latest.amountOutMinimum === null) {
          throw new Error("swap quote is not ready");
        }
        return buildNetworkFeeTxRequest({
          kind: "swap",
          chainId: input.chainId,
          tokenIn: { address: input.tokenIn },
          tokenOut: { address: input.tokenOut },
          fee: input.feeTier,
          account: input.account,
          amountInRaw: input.amountInRaw,
          amountOutMinimum: latest.amountOutMinimum,
          deadline: getSwapDeadline(Date.now()),
        });
      case "wrap":
      case "unwrap":
        return buildNetworkFeeTxRequest({
          kind: input.kind,
          chainId: input.chainId,
          amountInRaw: input.amountInRaw,
        });
    }
  }, []);

  const estimate = useNetworkFeeEstimate(estimateInput, buildRequest);
  const gasPrice = useNetworkFeeGasPrice(chainId, kind !== null);

  // ETH 단가 출처. ETH·WETH 칸이 있으면 그 칸의 단가(같은 WETH 단가 키)를 쓴다.
  const isEthLikeIn = tokenIn !== null && isEthLikeToken(chainId, tokenIn);
  const isEthLikeOut = tokenOut !== null && isEthLikeToken(chainId, tokenOut);
  const ownEthPrice = useTokenUsdPrice(
    chainId,
    kind !== null && !isEthLikeIn && !isEthLikeOut ? NATIVE_ETH_ADDRESS : undefined,
  );
  const ethPrice = isEthLikeIn ? usdPrices.in : isEthLikeOut ? usdPrices.out : ownEthPrice;

  // ETH 잔액 출처. ETH 칸이 있으면 그 칸의 카드 잔액을 쓰고 따로 읽지 않는다(DoD-34).
  const isEthIn = tokenIn !== null && isNativeToken(tokenIn);
  const isEthOut = tokenOut !== null && isNativeToken(tokenOut);
  const ownEthBalance = useNetworkFeeEthBalance(
    chainId,
    kind !== null && account !== undefined && !isEthIn && !isEthOut ? account : null,
  );
  const ethBalance = isEthIn ? balances.in : isEthOut ? balances.out : ownEthBalance;

  const inPrice = usdPrices.in;

  const value = useMemo<NetworkFeeState>(() => {
    if (kind === null || amountInRaw === null) return IDLE;

    const valueWei = getNetworkFeeValueWei({ kind, isEthIn, amountInRaw });

    if (estimate.data !== undefined && gasPrice.data !== undefined) {
      const feeWei = estimate.data.gas * gasPrice.data + (estimate.data.l1Fee ?? 0n);
      const usdMicros = ethPrice.status === "success" ? toUsdMicros(feeWei, ethPrice.price) : null;
      const amountInUsdMicros =
        inPrice.status === "success" ? toUsdMicros(amountInRaw, inPrice.price) : null;
      const { severity, ratioPercent } = getNetworkFeeSeverity({
        feeWei,
        feeUsdMicros: usdMicros,
        amountInRaw,
        amountInUsdMicros,
        isEthLikeIn,
      });
      return {
        status: "success",
        kind,
        feeWei,
        usdMicros,
        severity,
        ratioPercent,
        ethShortage: isEthShortage({ ethBalance, feeWei, valueWei }),
      };
    }

    const ethShortage = isEthShortage({ ethBalance, feeWei: null, valueWei });
    if (estimate.isError || gasPrice.isError) return { status: "error", kind, ethShortage };
    return { status: "loading", kind, ethShortage };
  }, [
    kind,
    amountInRaw,
    isEthIn,
    isEthLikeIn,
    estimate.data,
    estimate.isError,
    gasPrice.data,
    gasPrice.isError,
    ethPrice,
    inPrice,
    ethBalance,
  ]);

  return (
    <NetworkFeeContext.Provider value={value}>
      <NetworkFeeNoteContext.Provider value={note}>{children}</NetworkFeeNoteContext.Provider>
    </NetworkFeeContext.Provider>
  );
}

// F10 스펙 §4.1 네트워크 수수료 상태.
export function useNetworkFee(): NetworkFeeState {
  const value = useContext(NetworkFeeContext);
  if (!value) throw new Error("useNetworkFee must be used within NetworkFeeProvider");
  return value;
}

// 수수료 행 안내 줄 종류(batch-calls 스펙 §4.3). 주 버튼이 `approve-required`면 `swap-pending`,
// `batch-ready`면 `batch`, 그 밖이나 수수료가 `idle`이면 `null`이다.
export function useNetworkFeeNote(): NetworkFeeNote | null {
  const value = useContext(NetworkFeeNoteContext);
  if (value === undefined)
    throw new Error("useNetworkFeeNote must be used within NetworkFeeProvider");
  return value;
}
