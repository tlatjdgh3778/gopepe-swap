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
import { type Address, type Hash, erc20Abi } from "viem";
import { waitForTransactionReceipt } from "viem/actions";
import { useConfig } from "wagmi";
import { writeContract } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { swapRouter02Abi } from "@/config/uniswap-v3";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useEnsureChain } from "@/hooks/use-ensure-chain";
import { CARD_BALANCE_QUERY_KEY } from "@/hooks/use-token-balance";
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

import { useSelectedChain } from "./selected-chain-provider";
import { useSwapForm, useSwapFormActions, useSwapFormBalances } from "./swap-form-provider";
import { useSwapQuote } from "./swap-quote-provider";
import { useTokenAllowance } from "./token-allowance-provider";

export type SwapExecutionTxKind = "approve" | "swap";

export type PendingTx = {
  kind: SwapExecutionTxKind;
  chainId: SupportedChainId;
  hash: Hash;
};

// 스펙 §4.2 `useSwapExecution()`. `pendingTx`는 `phase`가 `approving`·`swapping`일 때만 `null`이 아니다.
// `approve`·`swap`은 reject하지 않고 결과는 `phase`로만 드러난다.
export type SwapExecutionValue = {
  phase: SwapExecutionPhase;
  pendingTx: PendingTx | null;
  approve: () => Promise<void>;
  swap: () => Promise<void>;
};

type ExecutionState = {
  phase: SwapExecutionPhase;
  pendingTx: PendingTx | null;
  // 실행을 시작한 연결 계정. 진행 중에 연결 계정이 이와 다르면 `idle`로 본다(EC-10).
  account: Address | null;
};

const IDLE_EXECUTION: ExecutionState = { phase: "idle", pendingTx: null, account: null };

const SwapExecutionContext = createContext<SwapExecutionValue | null>(null);

/**
 * approve·swap 전송, 진행 상태, 영수증 후처리를 맡는다.
 * - 클릭 시점의 주 버튼 상태가 `approve-required`(approve)·`swap-ready`(swap)일 때만 실행하고, 진행 중이면 지갑 요청 없이 끝낸다(EC-19).
 *   리렌더 전 두 번째 호출은 ref 잠금으로 막는다(EC-6).
 * - 전송 인자는 클릭 시점 값이다(EC-11). deadline만 전송 직전 시각으로 정한다(DoD-17).
 * - 전송 전에 `useEnsureChain()`을 기다리고, 그 뒤 선택 체인이 클릭 시점 체인과 다르면 보내지 않는다(DoD-21, EC-21).
 *   전송은 클릭 시점 체인 `chainId`로 하며 simulate하지 않는다.
 * - 영수증은 트랜잭션 체인 클라이언트로 시간 제한 없이 기다린다(EC-8, EC-18).
 * - 영수증 성공: swap이면 선택 체인·계정이 트랜잭션과 같을 때 금액을 비우고(DoD-19, EC-9) 잔액을 무효화한다(DoD-20).
 *   approve·swap 모두 allowance를 무효화하고 다시 읽기가 끝난 뒤 `idle`로 돌아간다(DoD-14, DoD-30). approve 뒤 swap을 자동으로 보내지 않는다.
 * - revert·영수증 대기 reject: allowance와 잔액을 무효화하고 `idle`로 돌아간다(EC-4, EC-5).
 * - 트랜잭션을 보내지 못한 종료(체인 전환 실패, 서명 거부, 가스 추정 실패, 체인 불일치)는 다시 읽지 않고 `idle`로 돌아간다.
 * - 진행 중 연결 계정이 바뀌거나 연결이 해제되면 실행 세대를 올려 `idle`로 돌아가고 그 실행의 늦은 결과는 버린다(EC-10).
 */
export function SwapExecutionProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { getSelectedChainId } = useSelectedChain();
  const { status: walletStatus, address: account } = useWalletRestore();
  const { chainId, tokenIn, tokenOut, amountInRaw } = useSwapForm();
  const { setAmountInput } = useSwapFormActions();
  const { in: balanceInRaw } = useSwapFormBalances();
  const quote = useSwapQuote();
  const amountOutMinimum = useAmountOutMinimum();
  const allowance = useTokenAllowance();
  const ensureChain = useEnsureChain();

  const [execution, setExecution] = useState<ExecutionState>(IDLE_EXECUTION);

  // 진행 중에 연결 계정이 바뀌었으면 effect가 정리하기 전에도 `idle`로 본다.
  const current =
    execution.phase !== "idle" && execution.account !== (account ?? null)
      ? IDLE_EXECUTION
      : execution;
  const { phase, pendingTx } = current;

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
    quote,
    amountOutMinimum,
    allowance,
    setAmountInput,
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

  // 연결 계정이 바뀌거나 연결이 해제되면 진행 중인 실행을 버리고 `idle`로 돌아간다(EC-10).
  useEffect(() => {
    generationRef.current += 1;
    lockRef.current = false;
    setExecution(IDLE_EXECUTION);
  }, [account]);

  const invalidateCardBalances = useCallback(
    (txChainId: SupportedChainId, txAccount: Address) =>
      queryClient.invalidateQueries({
        queryKey: [CARD_BALANCE_QUERY_KEY, txChainId, txAccount],
      }),
    [queryClient],
  );

  const execute = useCallback(
    async (
      kind: SwapExecutionTxKind,
      txChainId: SupportedChainId,
      txAccount: Address,
      send: () => Promise<Hash>,
    ): Promise<void> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      lockRef.current = true;
      setExecution({ phase: "awaiting-signature", pendingTx: null, account: txAccount });

      const isCurrent = () => generationRef.current === generation;
      const finish = () => {
        if (!isCurrent()) return;
        lockRef.current = false;
        setExecution(IDLE_EXECUTION);
      };

      // 서명 단계. 트랜잭션을 보내지 못하면 다시 읽지 않고 끝낸다(EC-1, EC-2, EC-3, EC-21).
      let hash: Hash;
      try {
        await latestRef.current.ensureChain();
        if (!isCurrent()) return;
        if (getSelectedChainId() !== txChainId) {
          finish();
          return;
        }
        hash = await send();
      } catch {
        finish();
        return;
      }
      if (!isCurrent()) return;

      setExecution({
        phase: kind === "approve" ? "approving" : "swapping",
        pendingTx: { kind, chainId: txChainId, hash },
        account: txAccount,
      });

      // 영수증 대기. 트랜잭션 체인 클라이언트로 시간 제한 없이 기다린다.
      let succeeded = false;
      try {
        const receipt = await waitForTransactionReceipt(config.getClient({ chainId: txChainId }), {
          hash,
          timeout: 0,
        });
        succeeded = receipt.status === "success";
      } catch {
        succeeded = false;
      }
      if (!isCurrent()) return;

      try {
        if (succeeded) {
          if (kind === "swap") {
            const now = latestRef.current;
            if (getSelectedChainId() === txChainId && now.account === txAccount) {
              now.setAmountInput("");
            }
            void invalidateCardBalances(txChainId, txAccount);
          }
          await invalidateTokenAllowance(queryClient, txChainId, txAccount);
        } else {
          void invalidateCardBalances(txChainId, txAccount);
          void invalidateTokenAllowance(queryClient, txChainId, txAccount);
        }
      } catch {
        // 다시 읽기 실패는 phase에 드러내지 않는다.
      }
      finish();
    },
    [config, queryClient, getSelectedChainId, invalidateCardBalances],
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
    } = snapshot;
    const currentAllowance = snapshot.allowance.allowance;
    if (!txAccount || !token || amount === null || currentAllowance === null) return;

    const request = buildApproveRequest({
      chainId: txChainId,
      token: token.address,
      allowance: currentAllowance,
      amountInRaw: amount,
    });

    await execute("approve", txChainId, txAccount, () =>
      writeContract(config, {
        address: request.to,
        abi: erc20Abi,
        functionName: "approve",
        args: [request.spender, request.amount],
        chainId: txChainId,
        account: txAccount,
      }),
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

    await execute("swap", txChainId, txAccount, () =>
      writeContract(config, {
        address: CONTRACTS_BY_CHAIN[txChainId].swapRouter02,
        abi: swapRouter02Abi,
        functionName: "multicall",
        // deadline은 전송 직전 시각으로 정한다(DoD-17).
        args: buildSwapMulticallArgs({ deadline: getSwapDeadline(Date.now()), params }),
        chainId: txChainId,
        account: txAccount,
      }),
    );
  }, [config, execute]);

  const value = useMemo<SwapExecutionValue>(
    () => ({ phase, pendingTx, approve, swap }),
    [phase, pendingTx, approve, swap],
  );

  return <SwapExecutionContext.Provider value={value}>{children}</SwapExecutionContext.Provider>;
}

// 스펙 §4.2 실행 상태.
export function useSwapExecution(): SwapExecutionValue {
  const value = useContext(SwapExecutionContext);
  if (!value) throw new Error("useSwapExecution must be used within SwapExecutionProvider");
  return value;
}
