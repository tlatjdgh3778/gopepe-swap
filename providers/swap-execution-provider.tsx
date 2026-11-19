"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Address, type Hash, type ReplacementReason, erc20Abi } from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import { useConfig } from "wagmi";
import { writeContract } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { swapRouter02Abi } from "@/config/uniswap-v3";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useEnsureChain } from "@/hooks/use-ensure-chain";
import { CARD_BALANCE_QUERY_KEY, getCardBalanceQueryKey } from "@/hooks/use-token-balance";
import { invalidateTokenAllowance } from "@/hooks/use-token-allowance-read";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import {
  type PrimaryButtonState,
  type SwapExecutionPhase,
  getPrimaryButtonState,
  getPrimaryButtonStateParams,
} from "@/lib/primary-button-state";
import {
  buildApproveRequest,
  buildExactInputSingleParams,
  buildSwapMulticallArgs,
  getSwapDeadline,
} from "@/lib/swap-transaction";
import { readTokenBalance } from "@/lib/token-balances";
import {
  type ReceiptOutcome,
  type TxResult,
  classifyChainSwitchError,
  classifySendError,
  getReceiptFailedOutcome,
  getReceiptOutcome,
  isBalanceDropped,
} from "@/lib/tx-result";

import { useSelectedChain } from "./selected-chain-provider";
import {
  useSwapForm,
  useSwapFormAppActions,
  useSwapFormBalances,
  useSwapFormUserChangeCount,
} from "./swap-form-provider";
import { useSwapQuote } from "./swap-quote-provider";
import { useTokenAllowance } from "./token-allowance-provider";

export type SwapExecutionTxKind = "approve" | "swap";

export type PendingTx = {
  kind: SwapExecutionTxKind;
  chainId: SupportedChainId;
  hash: Hash;
};

export type { TxResult } from "@/lib/tx-result";

// F5 스펙 §4.2 `useSwapExecution()`에 F6 스펙 §4.1의 `result`·`dismissResult`를 더했다.
// `pendingTx`는 `phase`가 `approving`·`swapping`일 때만 `null`이 아니고, 결과가 나올 때까지 지갑이 돌려준 원 해시다.
// `approve`·`swap`은 reject하지 않고 `void`로 resolve한다. 실행 결과는 `result`로 드러난다.
export type SwapExecutionValue = {
  phase: SwapExecutionPhase;
  pendingTx: PendingTx | null;
  result: TxResult | null;
  approve: () => Promise<void>;
  swap: () => Promise<void>;
  dismissResult: () => void;
};

type ExecutionState = {
  phase: SwapExecutionPhase;
  pendingTx: PendingTx | null;
  // 실행을 시작한 연결 계정. 진행 중이거나 결과가 있을 때 연결 계정이 이와 다르면 `idle`·결과 없음으로 본다(F5 EC-10, F6 EC-24·25).
  account: Address | null;
  // 마지막 실행의 결과. 진행 중에는 `null`이다.
  result: TxResult | null;
};

const IDLE_EXECUTION: ExecutionState = {
  phase: "idle",
  pendingTx: null,
  account: null,
  result: null,
};

const SwapExecutionContext = createContext<SwapExecutionValue | null>(null);

/**
 * approve·swap 전송, 진행 상태, 영수증 후처리를 맡는다.
 * - 클릭 시점의 주 버튼 상태가 `approve-required`(approve)·`swap-ready`(swap)일 때만 실행하고, 진행 중이면 지갑 요청 없이 끝낸다(EC-19).
 *   리렌더 전 두 번째 호출은 ref 잠금으로 막는다(EC-6).
 * - 전송 인자는 클릭 시점 값이다(EC-11). deadline만 전송 직전 시각으로 정한다(DoD-17).
 * - 전송 전에 `useEnsureChain()`을 기다리고, 그 뒤 선택 체인이 클릭 시점 체인과 다르면 보내지 않는다(DoD-21, EC-21).
 *   전송은 클릭 시점 체인 `chainId`로 하며 simulate하지 않는다.
 * - 영수증은 트랜잭션 체인 클라이언트로 시간 제한 없이 기다린다(EC-8, EC-18). 교체는 `onReplaced` 사유로만 판단하고
 *   전송 전 nonce 조회나 `replacement` 인자는 쓰지 않는다(F6 EC-29).
 * - 영수증 성공(가속 포함): swap이면 선택 체인·계정이 트랜잭션과 같을 때 금액을 비우고(DoD-19, EC-9) 잔액을 무효화한다(DoD-20).
 *   금액 비우기는 앱 전용 동작이라 결과를 지우지 않는다(F6 EC-18).
 *   approve는 allowance 무효화와 클릭 시점 보내는 토큰 잔액 키(tx 체인·계정) 새 읽기를 함께 기다리고,
 *   클릭 시점 잔액과 비교해 `balanceDropped`를 정한다(F6 DoD-10·11·12, EC-15·16·17).
 *   approve·swap 모두 allowance 다시 읽기가 끝난 뒤 결과 기록과 `idle` 전환을 한 번에 한다(DoD-14, DoD-30). approve 뒤 swap을 자동으로 보내지 않는다.
 * - revert·영수증 대기 reject·교체: allowance와 잔액을 무효화하고 기다리지 않은 채 결과를 기록하고 `idle`로 돌아간다(EC-4, EC-5, F6 EC-7·8·9·11).
 * - 트랜잭션을 보내지 못한 종료는 다시 읽지 않고 `idle`로 돌아간다. 체인 확인 단계 오류는 `rejected`·`chain-switch-failed`,
 *   전송 단계 오류는 `rejected`·`send-failed`로 기록하고(F6 EC-1~4), 체인 불일치(EC-21)는 결과 없이 끝난다(F6 EC-6).
 * - 진행 중 연결 계정이 바뀌거나 연결이 해제되면 실행 세대를 올려 `idle`로 돌아가고 그 실행의 늦은 결과는 버린다(EC-10, F6 EC-24).
 * - 결과는 `dismissResult`, 실행 시작, 계정 변경·해제, 금액·토큰 값을 실제로 바꾼 사용자 동작, 선택 체인 값 변경으로만 지운다
 *   (F6 DoD-13·14·15, EC-25). 슬리피지와 시간으로는 지우지 않는다(F6 EC-19·20).
 */
export function SwapExecutionProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { selectedChainId, getSelectedChainId } = useSelectedChain();
  const { status: walletStatus, address: account } = useWalletRestore();
  const { chainId, tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const { clearAmountInput } = useSwapFormAppActions();
  const userChangeCount = useSwapFormUserChangeCount();
  const { in: balanceInRaw } = useSwapFormBalances();
  const quote = useSwapQuote();
  const amountOutMinimum = useAmountOutMinimum();
  const allowance = useTokenAllowance();
  const ensureChain = useEnsureChain();

  const [execution, setExecution] = useState<ExecutionState>(IDLE_EXECUTION);

  // 진행 중이거나 결과가 있을 때 연결 계정이 바뀌었으면 effect가 정리하기 전에도 `idle`·결과 없음으로 본다.
  const current =
    execution.account !== null && execution.account !== (account ?? null)
      ? IDLE_EXECUTION
      : execution;
  const { phase, pendingTx, result } = current;

  const primaryState: PrimaryButtonState = getPrimaryButtonState(
    getPrimaryButtonStateParams({
      walletStatus,
      phase,
      tokenIn,
      tokenOut,
      amountInRaw,
      balanceInRaw,
      quote,
      amountOutMinimum,
      allowance,
    }),
  );

  // 호출 시점의 최신 값. approve·swap은 렌더 시점이 아니라 이 값을 읽는다.
  const latest = {
    primaryState,
    chainId,
    account,
    tokenIn,
    tokenOut,
    amountInRaw,
    balanceInRaw,
    quote,
    amountOutMinimum,
    allowance,
    clearAmountInput,
    ensureChain,
  };
  const latestRef = useRef(latest);
  useLayoutEffect(() => {
    latestRef.current = latest;
  });

  // 중복 실행 방지 잠금(리렌더 전 두 번째 호출).
  const lockRef = useRef(false);
  // 실행 세대. 새 실행 시작과 계정 변경·연결 해제 때 올라가며, 세대가 바뀐 실행의 늦은 결과는 버린다.
  const generationRef = useRef(0);

  // 연결 계정이 바뀌거나 연결이 해제되면 진행 중인 실행을 버리고 `idle`로 돌아가며 결과도 지운다(EC-10, F6 EC-24·25).
  // 결과를 state에서 지우므로 원래 계정으로 되돌려도 되살아나지 않는다.
  useEffect(() => {
    generationRef.current += 1;
    lockRef.current = false;
    setExecution(IDLE_EXECUTION);
  }, [account]);

  const dismissResult = useCallback(() => {
    setExecution((previous) =>
      previous.result === null ? previous : { ...previous, result: null },
    );
  }, []);

  // 금액·토큰 값을 실제로 바꾼 사용자 동작이나 선택 체인 값 변경이 있으면 결과를 지운다(F6 DoD-14).
  // 진행 중에는 지울 결과가 없고, 진행 중 변경 뒤 나온 결과는 그대로 남는다(F6 EC-22·23).
  useEffect(() => {
    dismissResult();
  }, [userChangeCount, selectedChainId, dismissResult]);

  const invalidateCardBalances = useCallback(
    (txChainId: SupportedChainId, txAccount: Address) =>
      queryClient.invalidateQueries({
        queryKey: [CARD_BALANCE_QUERY_KEY, txChainId, txAccount],
      }),
    [queryClient],
  );

  // approve 성공 뒤 클릭 시점 보내는 토큰의 카드 잔액(tx 체인·계정 키)을 영수증 뒤 새 요청으로 읽는다.
  // 진행 중이던 주기 읽기는 취소하고 재사용하지 않는다. 쿼리가 비활성이어도 tx 체인 클라이언트로 읽는다.
  // 읽기가 실패하면 `null`이다(이전 캐시 값으로 대신하지 않는다).
  const refetchCardBalance = useCallback(
    async (txChainId: SupportedChainId, txAccount: Address, token: Address) => {
      const queryKey = getCardBalanceQueryKey(txChainId, txAccount, token);
      try {
        await queryClient.cancelQueries({ queryKey, exact: true });
        return await queryClient.fetchQuery({
          queryKey,
          queryFn: () =>
            readTokenBalance(config.getClient({ chainId: txChainId }), {
              account: txAccount,
              token: { address: token },
            }),
          staleTime: 0,
          retry: false,
        });
      } catch {
        return null;
      }
    },
    [config, queryClient],
  );

  const execute = useCallback(
    async (
      kind: SwapExecutionTxKind,
      txChainId: SupportedChainId,
      txAccount: Address,
      send: () => Promise<Hash>,
      // approve의 클릭 시점 보내는 토큰과 그 카드 잔액. swap이면 `null`이다.
      approveSnapshot: { token: Address; balance: bigint | null } | null,
    ): Promise<void> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      lockRef.current = true;
      // 실행 시작은 이전 결과를 지운다(F6 DoD-15).
      setExecution({
        phase: "awaiting-signature",
        pendingTx: null,
        account: txAccount,
        result: null,
      });

      const isCurrent = () => generationRef.current === generation;
      // 결과 기록과 `idle` 전환을 한 번에 한다. 세대가 바뀐 실행은 기록하지 않는다.
      const finish = (txResult: TxResult | null) => {
        if (!isCurrent()) return;
        lockRef.current = false;
        setExecution(
          txResult === null
            ? IDLE_EXECUTION
            : { phase: "idle", pendingTx: null, account: txAccount, result: txResult },
        );
      };

      // 체인 확인 단계. 실패하면 다시 읽지 않고 `rejected`·`chain-switch-failed`로 끝낸다(EC-1, F6 EC-2·3).
      try {
        await latestRef.current.ensureChain();
      } catch (error) {
        finish({ kind, status: classifyChainSwitchError(error) });
        return;
      }
      if (!isCurrent()) return;
      // 선택 체인이 클릭 시점 체인과 다르면 보내지 않고 결과 없이 끝낸다(EC-21, F6 EC-6).
      if (getSelectedChainId() !== txChainId) {
        finish(null);
        return;
      }

      // 전송 단계. 실패하면 다시 읽지 않고 `rejected`·`send-failed`로 끝낸다(EC-2, EC-3, F6 EC-1·4).
      let hash: Hash;
      try {
        hash = await send();
      } catch (error) {
        finish({ kind, status: classifySendError(error) });
        return;
      }
      if (!isCurrent()) return;

      setExecution({
        phase: kind === "approve" ? "approving" : "swapping",
        pendingTx: { kind, chainId: txChainId, hash },
        account: txAccount,
        result: null,
      });

      // 영수증 대기. 트랜잭션 체인 클라이언트로 시간 제한 없이 기다린다.
      // 교체·취소·가속은 `onReplaced` 사유로 구분하고, 대기가 reject되면 원 해시로 `receipt-failed`다.
      let outcome: ReceiptOutcome;
      try {
        let replacementReason: ReplacementReason | undefined;
        const receipt = await waitForTransactionReceipt(config.getClient({ chainId: txChainId }), {
          hash,
          timeout: 0,
          onReplaced: (replacement) => {
            replacementReason = replacement.reason;
          },
        });
        outcome = getReceiptOutcome(receipt, replacementReason);
      } catch {
        outcome = getReceiptFailedOutcome(hash);
      }
      if (!isCurrent()) return;

      if (outcome.status !== "success") {
        // revert·확인 실패·교체: 다시 읽기를 기다리지 않는다. swap 교체여도 금액은 비우지 않는다(F6 EC-11).
        void invalidateCardBalances(txChainId, txAccount).catch(() => undefined);
        void invalidateTokenAllowance(queryClient, txChainId, txAccount).catch(() => undefined);
        finish({ kind, status: outcome.status, chainId: txChainId, hash: outcome.hash });
        return;
      }

      if (kind === "swap") {
        const now = latestRef.current;
        if (getSelectedChainId() === txChainId && now.account === txAccount) {
          now.clearAmountInput();
        }
        void invalidateCardBalances(txChainId, txAccount).catch(() => undefined);
        try {
          await invalidateTokenAllowance(queryClient, txChainId, txAccount);
        } catch {
          // 다시 읽기 실패는 결과에 드러내지 않는다.
        }
        finish({ kind: "swap", status: "success", chainId: txChainId, hash: outcome.hash });
        return;
      }

      // approve 성공: allowance와 보내는 토큰 잔액을 모두 다시 읽은 뒤 기록한다(F6 DoD-10).
      const [, balanceAfterApprove] = await Promise.all([
        invalidateTokenAllowance(queryClient, txChainId, txAccount).catch(() => undefined),
        approveSnapshot
          ? refetchCardBalance(txChainId, txAccount, approveSnapshot.token)
          : Promise.resolve(null),
      ]);
      finish({
        kind: "approve",
        status: "success",
        chainId: txChainId,
        hash: outcome.hash,
        balanceDropped: isBalanceDropped(approveSnapshot?.balance, balanceAfterApprove),
      });
    },
    [config, queryClient, getSelectedChainId, invalidateCardBalances, refetchCardBalance],
  );

  const approve = useCallback(async (): Promise<void> => {
    if (lockRef.current) return;
    const snapshot = latestRef.current;
    if (snapshot.primaryState !== "approve-required") return;
    const {
      chainId: txChainId,
      account: txAccount,
      tokenIn: token,
      amountInRaw: amount,
      balanceInRaw: balanceAtClick,
    } = snapshot;
    const currentAllowance = snapshot.allowance.allowance;
    if (!txAccount || !token || amount === null || currentAllowance === null) return;

    const request = buildApproveRequest({
      chainId: txChainId,
      token: token.address,
      allowance: currentAllowance,
      amountInRaw: amount,
    });

    await execute(
      "approve",
      txChainId,
      txAccount,
      () =>
        writeContract(config, {
          address: request.to,
          abi: erc20Abi,
          functionName: "approve",
          args: [request.spender, request.amount],
          chainId: txChainId,
          account: txAccount,
        }),
      { token: token.address, balance: balanceAtClick },
    );
  }, [config, execute]);

  const swap = useCallback(async (): Promise<void> => {
    if (lockRef.current) return;
    const snapshot = latestRef.current;
    if (snapshot.primaryState !== "swap-ready") return;
    const {
      chainId: txChainId,
      account: txAccount,
      tokenIn: inToken,
      tokenOut: outToken,
      amountInRaw: amount,
      quote: quoteState,
      amountOutMinimum: minimum,
    } = snapshot;
    if (
      !txAccount ||
      !inToken ||
      !outToken ||
      amount === null ||
      quoteState.status !== "success" ||
      minimum === null
    ) {
      return;
    }

    const params = buildExactInputSingleParams({
      chainId: txChainId,
      tokenIn: inToken,
      tokenOut: outToken,
      fee: quoteState.quote.fee,
      recipient: txAccount,
      amountInRaw: amount,
      amountOutMinimum: minimum,
    });

    await execute(
      "swap",
      txChainId,
      txAccount,
      () =>
        writeContract(config, {
          address: CONTRACTS_BY_CHAIN[txChainId].swapRouter02,
          abi: swapRouter02Abi,
          functionName: "multicall",
          // deadline은 전송 직전 시각으로 정한다(DoD-17).
          args: buildSwapMulticallArgs({ deadline: getSwapDeadline(Date.now()), params }),
          chainId: txChainId,
          account: txAccount,
        }),
      null,
    );
  }, [config, execute]);

  const value = useMemo<SwapExecutionValue>(
    () => ({ phase, pendingTx, result, approve, swap, dismissResult }),
    [phase, pendingTx, result, approve, swap, dismissResult],
  );

  return <SwapExecutionContext.Provider value={value}>{children}</SwapExecutionContext.Provider>;
}

// F5 스펙 §4.2 실행 상태와 F6 스펙 §4.1 결과.
export function useSwapExecution(): SwapExecutionValue {
  const value = useContext(SwapExecutionContext);
  if (!value) throw new Error("useSwapExecution must be used within SwapExecutionProvider");
  return value;
}
