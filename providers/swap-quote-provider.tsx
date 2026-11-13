"use client";

import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

import { type SwapQuoteReadInput, useSwapQuoteRead } from "@/hooks/use-swap-quote-read";
import { type SwapQuoteState, planSwapQuote } from "@/lib/swap-quote";

import { useSwapForm } from "./swap-form-provider";

// 입력 변경이 멈춘 뒤 견적을 요청하기까지의 대기 시간. 마지막 변경부터 센다.
export const SWAP_QUOTE_DEBOUNCE_MS = 300;

// 견적할 입력이 바뀐 횟수. 시그니처는 견적할 입력(체인, 치환 전 두 토큰 주소, `amountInRaw`)이며
// 견적하지 않는 입력(`idle`, ETH ↔ WETH)이면 `null`이다.
type InputRevision = {
  signature: string | null;
  revision: number;
};

const SwapQuoteContext = createContext<SwapQuoteState | null>(null);

const IDLE: SwapQuoteState = { status: "idle", quote: null };
const NO_ROUTE: SwapQuoteState = { status: "no-route", quote: null };
const LOADING: SwapQuoteState = { status: "loading", quote: null };
const ERROR: SwapQuoteState = { status: "error", quote: null };

/**
 * `useSwapForm()`의 입력으로 견적 상태(스펙 §4.1)를 정한다. 판정 순서는 다음과 같다.
 * 1. 토큰 미선택 또는 금액이 비었거나 0이면 `idle`(입력으로 즉시 정한다)
 * 2. 두 토큰이 ETH와 WETH이면 RPC 없이 즉시 `no-route`
 * 3. 견적할 입력이 바뀐 뒤 반영 대기(300ms) 중이면 `loading`
 * 4. 그 입력의 쿼리 결과가 있으면 그 결과(다시 읽기가 실패해도 마지막 성공 결과), 없고 실패했으면 `error`, 아니면 `loading`
 *
 * 견적할 입력이 바뀌면 렌더 중에 revision을 올려 같은 렌더에서 `loading`을 돌려준다.
 * revision이 쿼리 키에 있어 이전 입력의 응답은 다른 키에만 쌓이고 표시되지 않는다.
 * `amountIn` 문자열만 바뀌고 `amountInRaw`가 같으면 시그니처가 같아 다시 견적하지 않는다.
 */
export function SwapQuoteProvider({ children }: { children: ReactNode }) {
  const { chainId, tokenIn, tokenOut, amountInRaw } = useSwapForm();

  const plan = planSwapQuote({ chainId, tokenIn, tokenOut, amountInRaw });

  const readInputBase =
    plan.status === "quote" && tokenIn !== null && tokenOut !== null
      ? { tokenIn: tokenIn.address, tokenOut: tokenOut.address, request: plan.request }
      : null;

  const signature = readInputBase
    ? [
        readInputBase.request.chainId,
        readInputBase.tokenIn.toLowerCase(),
        readInputBase.tokenOut.toLowerCase(),
        readInputBase.request.amountIn.toString(),
      ].join(":")
    : null;

  const [storedRevision, setStoredRevision] = useState<InputRevision>({
    signature: null,
    revision: 0,
  });
  // 반영 대기가 끝난 revision.
  const [settledRevision, setSettledRevision] = useState(0);

  let inputRevision = storedRevision;
  if (storedRevision.signature !== signature) {
    inputRevision = { signature, revision: storedRevision.revision + 1 };
    setStoredRevision(inputRevision);
  }

  const { revision } = inputRevision;
  const pending = settledRevision !== revision;

  // 마지막 변경(revision)부터 반영 대기를 센다. revision이 다시 바뀌면 이전 타이머는 취소된다.
  useEffect(() => {
    if (settledRevision === revision) return;
    const timer = setTimeout(() => setSettledRevision(revision), SWAP_QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [revision, settledRevision]);

  const readInput: SwapQuoteReadInput | null = readInputBase
    ? { revision, ...readInputBase }
    : null;
  const read = useSwapQuoteRead(readInput, !pending);

  let state: SwapQuoteState;
  if (plan.status === "idle") {
    state = IDLE;
  } else if (plan.status === "no-route") {
    state = NO_ROUTE;
  } else if (pending) {
    state = LOADING;
  } else if (read.data) {
    state = read.data;
  } else if (read.isError) {
    state = ERROR;
  } else {
    state = LOADING;
  }

  // 상태 값은 상수이거나 쿼리 결과 객체라 입력·결과가 같으면 같은 참조다.
  return <SwapQuoteContext.Provider value={state}>{children}</SwapQuoteContext.Provider>;
}

// 스펙 §4.1 견적 상태. `quote`는 `status`가 `success`일 때만 `null`이 아니다.
export function useSwapQuote(): SwapQuoteState {
  const value = useContext(SwapQuoteContext);
  if (!value) throw new Error("useSwapQuote must be used within SwapQuoteProvider");
  return value;
}
