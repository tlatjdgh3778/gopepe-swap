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
import { sendCalls, waitForCallsStatus, writeContract } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";

import { swapRouter02Abi } from "@/config/uniswap-v3";
import { wethAbi } from "@/config/weth";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useEnsureChain } from "@/hooks/use-ensure-chain";
import { CARD_BALANCE_QUERY_KEY, getCardBalanceQueryKey } from "@/hooks/use-token-balance";
import { invalidateTokenAllowance } from "@/hooks/use-token-allowance-read";
import { useWalletRestore } from "@/hooks/use-wallet-restore";
import { buildBatchCalls } from "@/lib/batch-calls";
import {
  type PrimaryButtonState,
  type SwapExecutionPhase,
  getPrimaryButtonState,
  getPrimaryButtonStateParams,
} from "@/lib/primary-button-state";
import {
  buildApproveRequest,
  buildSwapTransactionRequest,
  buildUnwrapRequest,
  buildWrapRequest,
  getSwapDeadline,
} from "@/lib/swap-transaction";
import { readTokenBalance } from "@/lib/token-balances";
import {
  type BatchStatusOutcome,
  type ReceiptOutcome,
  type SingleTxKind,
  type TxKind,
  type TxResult,
  classifyBatchSendError,
  classifyChainSwitchError,
  classifySendError,
  getBatchStatusOutcome,
  getReceiptFailedOutcome,
  getReceiptOutcome,
  isBalanceDropped,
  isBatchStatusFinal,
} from "@/lib/tx-result";

import { useBatchCapability } from "./batch-capability-provider";
import { useSelectedChain } from "./selected-chain-provider";
import {
  useSwapForm,
  useSwapFormAppActions,
  useSwapFormBalances,
  useSwapFormUserChangeCount,
} from "./swap-form-provider";
import { useSwapQuote } from "./swap-quote-provider";
import { useTokenAllowance } from "./token-allowance-provider";

// batch-calls 스펙 §4.2. batch 분기의 `hash?: undefined`는 기존 `pendingTx.hash` 접근이 그대로 컴파일되게 한다(§4.5).
export type PendingTx =
  | { kind: SingleTxKind; chainId: SupportedChainId; hash: Hash }
  | { kind: "batch"; chainId: SupportedChainId; batchId: string; hash?: undefined };

export type { TxKind, TxResult } from "@/lib/tx-result";

// 트랜잭션 해시(배치는 배치 id)를 받은 뒤 결과가 나올 때까지의 phase(F5 DoD-18, F7 DoD-27·28, batch-calls DoD-13).
const PENDING_PHASE_BY_KIND: Record<
  TxKind,
  Exclude<SwapExecutionPhase, "idle" | "awaiting-signature">
> = {
  approve: "approving",
  swap: "swapping",
  wrap: "wrapping",
  unwrap: "unwrapping",
  batch: "batching",
};

// F7 스펙 §4.2 `useSwapExecution()`(F5 스펙 §4.2에 F6 스펙 §4.1의 `result`·`dismissResult`, F7의 `wrap`·`unwrap`,
// batch-calls 스펙 §4.2의 `batch`를 더했다).
// `pendingTx`는 `phase`가 `approving`·`swapping`·`wrapping`·`unwrapping`·`batching`일 때만 `null`이 아니고,
// 결과가 나올 때까지 지갑이 돌려준 원 해시(배치는 배치 id)다.
// `approve`·`swap`·`wrap`·`unwrap`·`batch`는 reject하지 않고 `void`로 resolve한다. 실행 결과는 `result`로 드러난다.
export type SwapExecutionValue = {
  phase: SwapExecutionPhase;
  pendingTx: PendingTx | null;
  result: TxResult | null;
  approve: () => Promise<void>;
  swap: () => Promise<void>;
  wrap: () => Promise<void>;
  unwrap: () => Promise<void>;
  batch: () => Promise<void>;
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
 * approve·swap·wrap·unwrap 전송, 진행 상태, 영수증 후처리를 맡는다.
 * - 클릭 시점의 주 버튼 상태가 `approve-required`(approve)·`swap-ready`(swap)·`wrap-ready`(wrap)·`unwrap-ready`(unwrap)일 때만
 *   실행하고, 진행 중이면 어떤 kind든 지갑 요청 없이 끝낸다(EC-19, F7 EC-7). 리렌더 전 두 번째 호출은 ref 잠금으로 막는다(EC-6).
 * - 전송 인자는 클릭 시점 값이다(EC-11, F7 EC-8). swap의 deadline만 전송 직전 시각으로 정한다(DoD-17).
 *   보내는 토큰이 ETH인 swap은 `value`로 `amountInRaw`를 싣고, 받는 토큰이 ETH인 swap은 `unwrapWETH9`로 ETH를 받는다
 *   (F7 DoD-7~9). 그 밖의 swap과 unwrap은 `value`를 싣지 않는다(F7 DoD-10·22). wrap·unwrap에는 deadline이 없다.
 * - 전송 전에 `useEnsureChain()`을 기다리고, 그 뒤 선택 체인이 클릭 시점 체인과 다르면 보내지 않는다(DoD-21, EC-21).
 *   전송은 클릭 시점 체인 `chainId`로 하며 simulate하지 않는다.
 * - 영수증은 트랜잭션 체인 클라이언트로 시간 제한 없이 기다린다(EC-8, EC-18). 교체는 `onReplaced` 사유로만 판단하고
 *   전송 전 nonce 조회나 `replacement` 인자는 쓰지 않는다(F6 EC-29).
 * - 영수증 성공(가속 포함): swap·wrap·unwrap이면 선택 체인·계정이 트랜잭션과 같을 때 금액을 비우고
 *   (DoD-19, EC-9, F7 DoD-32, EC-11) 잔액을 무효화한다(DoD-20, F7 DoD-33). 성공 결과에 `balanceDropped`가 없다.
 *   금액 비우기는 앱 전용 동작이라 결과를 지우지 않는다(F6 EC-18).
 *   approve는 allowance 무효화와 클릭 시점 보내는 토큰 잔액 키(tx 체인·계정) 새 읽기를 함께 기다리고,
 *   클릭 시점 잔액과 비교해 `balanceDropped`를 정한다(F6 DoD-10·11·12, EC-15·16·17).
 *   모든 kind가 allowance 다시 읽기가 끝난 뒤 결과 기록과 `idle` 전환을 한 번에 한다(DoD-14, DoD-30). approve 뒤 swap을 자동으로 보내지 않는다.
 * - revert·영수증 대기 reject·교체: allowance와 잔액을 무효화하고 기다리지 않은 채 결과를 기록하고 `idle`로 돌아간다(EC-4, EC-5, F6 EC-7·8·9·11).
 * - 트랜잭션을 보내지 못한 종료는 다시 읽지 않고 `idle`로 돌아간다. 체인 확인 단계 오류는 `rejected`·`chain-switch-failed`,
 *   전송 단계 오류는 `rejected`·`send-failed`로 기록하고(F6 EC-1~4), 체인 불일치(EC-21)는 결과 없이 끝난다(F6 EC-6).
 * - batch(batch-calls 스펙): 클릭 시점 주 버튼이 `batch-ready`일 때만 approve와 swap을 `wallet_sendCalls` 한 번으로
 *   보낸다(`forceAtomic: true`, `experimental_fallback` 없음). 체인 확인·체인 비교 단계는 다른 kind와 같다(DoD-11, EC-11).
 *   배치 미지원 code로 실패하면 그 계정·체인을 강등한다(EC-7·8). 배치 id를 받으면 `batching`이고, 상태 코드가 1xx가 아닐 때까지
 *   시간 제한 없이 기다린다(EC-18). 성공 후처리는 swap 성공과 같고 `balanceDropped`가 없다(DoD-18·19·20).
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
  const { available: batchAvailable, markUnsupported } = useBatchCapability();

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
      batchAvailable,
    }),
  );

  // 호출 시점의 최신 값. approve·swap·wrap·unwrap·batch는 렌더 시점이 아니라 이 값을 읽는다.
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
      kind: SingleTxKind,
      txChainId: SupportedChainId,
      txAccount: Address,
      send: () => Promise<Hash>,
      // approve의 클릭 시점 보내는 토큰과 그 카드 잔액. approve가 아니면 `null`이다.
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
        phase: PENDING_PHASE_BY_KIND[kind],
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
        // revert·확인 실패·교체: 다시 읽기를 기다리지 않는다. swap·wrap·unwrap 교체여도 금액은 비우지 않는다(F6 EC-11, F7 EC-6).
        void invalidateCardBalances(txChainId, txAccount).catch(() => undefined);
        void invalidateTokenAllowance(queryClient, txChainId, txAccount).catch(() => undefined);
        finish({ kind, status: outcome.status, chainId: txChainId, hash: outcome.hash });
        return;
      }

      // swap·wrap·unwrap 성공(F5 DoD-19·20, F7 DoD-31~33).
      if (kind !== "approve") {
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
        finish({ kind, status: "success", chainId: txChainId, hash: outcome.hash });
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

    const fee = quoteState.quote.fee;

    await execute(
      "swap",
      txChainId,
      txAccount,
      () => {
        // deadline은 전송 직전 시각으로 정한다(DoD-17). 나머지 인자는 클릭 시점 값이다.
        const request = buildSwapTransactionRequest({
          chainId: txChainId,
          tokenIn: inToken,
          tokenOut: outToken,
          fee,
          account: txAccount,
          amountInRaw: amount,
          amountOutMinimum: minimum,
          deadline: getSwapDeadline(Date.now()),
        });
        return writeContract(config, {
          address: request.to,
          abi: swapRouter02Abi,
          functionName: "multicall",
          args: request.args,
          // 보내는 토큰이 ETH가 아니면 `undefined`라 지갑 요청에 `value`가 없다(F7 DoD-10).
          value: request.value,
          chainId: txChainId,
          account: txAccount,
        });
      },
      null,
    );
  }, [config, execute]);

  // ETH → WETH. 선택 체인 WETH에 `deposit()`, `value`는 클릭 시점 `amountInRaw`다(F7 DoD-21).
  const wrap = useCallback(async (): Promise<void> => {
    if (lockRef.current) return;
    const snapshot = latestRef.current;
    if (snapshot.primaryState !== "wrap-ready") return;
    const { chainId: txChainId, account: txAccount, amountInRaw: amount } = snapshot;
    if (!txAccount || amount === null) return;

    const request = buildWrapRequest({ chainId: txChainId, amountInRaw: amount });

    await execute(
      "wrap",
      txChainId,
      txAccount,
      () =>
        writeContract(config, {
          address: request.to,
          abi: wethAbi,
          functionName: request.functionName,
          args: request.args,
          value: request.value,
          chainId: txChainId,
          account: txAccount,
        }),
      null,
    );
  }, [config, execute]);

  // WETH → ETH. 선택 체인 WETH에 `withdraw(클릭 시점 amountInRaw)`, `value` 없음이다(F7 DoD-22).
  const unwrap = useCallback(async (): Promise<void> => {
    if (lockRef.current) return;
    const snapshot = latestRef.current;
    if (snapshot.primaryState !== "unwrap-ready") return;
    const { chainId: txChainId, account: txAccount, amountInRaw: amount } = snapshot;
    if (!txAccount || amount === null) return;

    const request = buildUnwrapRequest({ chainId: txChainId, amountInRaw: amount });

    await execute(
      "unwrap",
      txChainId,
      txAccount,
      () =>
        writeContract(config, {
          address: request.to,
          abi: wethAbi,
          functionName: request.functionName,
          args: request.args,
          chainId: txChainId,
          account: txAccount,
        }),
      null,
    );
  }, [config, execute]);

  // approve + swap 배치(batch-calls 스펙 §3.2·§3.3). 잠금·세대·체인 확인 단계는 `execute`와 같고,
  // 전송은 `wallet_sendCalls`, 결과는 `wallet_getCallsStatus` 상태 코드로 정한다.
  const executeBatch = useCallback(
    async (
      txChainId: SupportedChainId,
      txAccount: Address,
      send: () => Promise<string>,
    ): Promise<void> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      lockRef.current = true;
      // 실행 시작은 이전 결과를 지운다. 배치 id를 받기 전에는 `awaiting-signature`다(DoD-12).
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

      // 체인 확인 단계. 실패하면 `rejected`·`chain-switch-failed`이고 `wallet_sendCalls`를 보내지 않는다(DoD-11, EC-11).
      try {
        await latestRef.current.ensureChain();
      } catch (error) {
        finish({ kind: "batch", status: classifyChainSwitchError(error) });
        return;
      }
      if (!isCurrent()) return;
      // 선택 체인이 클릭 시점 체인과 다르면 보내지 않고 결과 없이 끝낸다(F5 EC-21과 같다).
      if (getSelectedChainId() !== txChainId) {
        finish(null);
        return;
      }

      // 전송 단계. 4001은 `rejected`(EC-5·6), 배치 미지원 code는 `send-failed`와 강등(EC-7·8·9),
      // 그 밖은 `send-failed`(EC-10)다. approve를 대신 보내지 않는다.
      let batchId: string;
      try {
        batchId = await send();
      } catch (error) {
        if (!isCurrent()) return;
        const { status, unsupported } = classifyBatchSendError(error);
        if (unsupported) markUnsupported(txChainId, txAccount);
        finish({ kind: "batch", status });
        return;
      }
      if (!isCurrent()) return;

      setExecution({
        phase: PENDING_PHASE_BY_KIND.batch,
        pendingTx: { kind: "batch", chainId: txChainId, batchId },
        account: txAccount,
        result: null,
      });

      // 상태 대기. 1xx가 아닐 때 끝내고(viem 기본 종료 조건은 201~299를 끝내지 않는다) 시간 제한은 없다(EC-18).
      // `wallet_getCallsStatus` throw는 viem 기본 재시도 뒤 `receipt-failed`다(EC-16).
      let outcome: BatchStatusOutcome;
      try {
        const callsStatus = await waitForCallsStatus(config, {
          id: batchId,
          timeout: 0,
          status: ({ statusCode }) => isBatchStatusFinal(statusCode),
        });
        // `status` 함수가 1xx에서 끝내지 않으므로 `null`(1xx)은 오지 않는다. 오면 확인 실패로 본다.
        outcome = getBatchStatusOutcome(callsStatus.statusCode, callsStatus.receipts) ?? {
          status: "receipt-failed",
        };
      } catch {
        outcome = { status: "receipt-failed" };
      }
      if (!isCurrent()) return;

      if (outcome.status === "send-failed") {
        // 4xx(EC-15): 체인에 실행되지 않았다. 다시 읽기를 기다리지 않는다.
        void invalidateCardBalances(txChainId, txAccount).catch(() => undefined);
        void invalidateTokenAllowance(queryClient, txChainId, txAccount).catch(() => undefined);
        finish({ kind: "batch", status: "send-failed" });
        return;
      }

      const hashField = outcome.hash === undefined ? {} : { hash: outcome.hash };

      if (outcome.status !== "success") {
        // revert·확인 실패(EC-12~14, EC-16, EC-23·24): 다시 읽기를 기다리지 않고 금액도 비우지 않는다.
        void invalidateCardBalances(txChainId, txAccount).catch(() => undefined);
        void invalidateTokenAllowance(queryClient, txChainId, txAccount).catch(() => undefined);
        finish({ kind: "batch", status: outcome.status, chainId: txChainId, ...hashField });
        return;
      }

      // 성공(DoD-16·18·19, EC-22): swap 성공과 같다. `balanceDropped`가 없다(DoD-20).
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
      finish({ kind: "batch", status: "success", chainId: txChainId, ...hashField });
    },
    [config, queryClient, getSelectedChainId, invalidateCardBalances, markUnsupported],
  );

  // ERC-20 입력 스왑의 approve + swap을 `wallet_sendCalls` 한 번으로 보낸다(batch-calls DoD-7~11).
  // calls는 클릭 시점 값으로 만들고 deadline만 전송 직전 시각으로 정한다. capability를 다시 읽지 않는다(EC-4).
  const batch = useCallback(async (): Promise<void> => {
    if (lockRef.current) return;
    const snapshot = latestRef.current;
    if (snapshot.primaryState !== "batch-ready") return;
    const {
      chainId: txChainId,
      account: txAccount,
      tokenIn: inToken,
      tokenOut: outToken,
      amountInRaw: amount,
      quote: quoteState,
      amountOutMinimum: minimum,
    } = snapshot;
    const currentAllowance = snapshot.allowance.allowance;
    if (
      !txAccount ||
      !inToken ||
      !outToken ||
      amount === null ||
      quoteState.status !== "success" ||
      minimum === null ||
      currentAllowance === null
    ) {
      return;
    }

    const fee = quoteState.quote.fee;

    await executeBatch(txChainId, txAccount, async () => {
      const calls = buildBatchCalls({
        chainId: txChainId,
        token: inToken.address,
        allowance: currentAllowance,
        swap: {
          tokenOut: outToken,
          fee,
          account: txAccount,
          amountInRaw: amount,
          amountOutMinimum: minimum,
          deadline: getSwapDeadline(Date.now()),
        },
      });
      const { id } = await sendCalls(config, {
        account: txAccount,
        chainId: txChainId,
        calls,
        // 원자 실행을 요구한다(`atomicRequired: true`, DoD-9). 비원자 fallback은 쓰지 않는다.
        forceAtomic: true,
      });
      return id;
    });
  }, [config, executeBatch]);

  const value = useMemo<SwapExecutionValue>(
    () => ({ phase, pendingTx, result, approve, swap, wrap, unwrap, batch, dismissResult }),
    [phase, pendingTx, result, approve, swap, wrap, unwrap, batch, dismissResult],
  );

  return <SwapExecutionContext.Provider value={value}>{children}</SwapExecutionContext.Provider>;
}

// F7 스펙 §4.2 실행 상태와 결과(F5 스펙 §4.2, F6 스펙 §4.1을 넓혔다).
export function useSwapExecution(): SwapExecutionValue {
  const value = useContext(SwapExecutionContext);
  if (!value) throw new Error("useSwapExecution must be used within SwapExecutionProvider");
  return value;
}
