"use client";

import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";

import type { SupportedChainId } from "@/config/chains";

import { TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { useTokenBalance } from "@/hooks/use-token-balance";
import {
  formatMaxAmount,
  isNativeToken,
  parseAmountRaw,
  sanitizeAmountInput,
  truncateAmountDecimals,
} from "@/lib/token-amount";

import { useSelectedChain } from "./selected-chain-provider";

// §4.3 입력 상태 계약. F3 견적이 이 값을 읽는다.
export type SwapFormValue = {
  chainId: SupportedChainId;
  tokenIn: Token | null;
  tokenOut: Token | null;
  amountIn: string;
  amountInRaw: bigint | null;
};

export type SwapSide = "in" | "out";

// 계약 밖의 상태 변경 함수. 화면이 쓴다.
export type SwapFormActions = {
  // 모달에서 토큰을 고른다. 반대쪽 칸의 토큰이면 두 칸을 맞바꾸고 금액을 비운다.
  // 보내는 토큰을 다른 토큰으로 바꾸면 금액을 유지하고 새 decimals를 넘는 소수 자릿수를 잘라낸다.
  selectToken: (side: SwapSide, token: Token) => void;
  // 두 칸의 토큰을 미선택을 포함해 그대로 맞바꾸고 금액을 비운다.
  flipTokens: () => void;
  // 금액 입력. 형식에 맞으면 쉼표를 소수점으로 바꿔 반영하고, 아니면 이전 값을 유지한다.
  // 보내는 토큰이 없으면 반영하지 않는다. 반영했으면 true를 돌려준다.
  setAmountInput: (input: string) => boolean;
  // `최대`. 보내는 칸 카드 잔액을 모르면 아무것도 하지 않는다. 반영했으면 true를 돌려준다.
  setMaxAmount: () => boolean;
};

// 카드 두 칸의 잔액(정수). 연결 상태가 아니거나, 토큰이 없거나, 같은 계정·체인·토큰으로 성공한 읽기가 없으면 null.
export type SwapFormBalances = {
  in: bigint | null;
  out: bigint | null;
};

type SwapFormState = {
  chainId: SupportedChainId;
  tokenIn: Token | null;
  tokenOut: Token | null;
  amountIn: string;
};

function nativeTokenOf(chainId: SupportedChainId): Token {
  const token = TOKENS_BY_CHAIN[chainId].find((candidate) => isNativeToken(candidate));
  if (!token) throw new Error(`체인 ${chainId}의 토큰 목록에 ETH가 없습니다.`);
  return token;
}

// DoD-1: 보내는 토큰은 선택 체인의 ETH, 받는 토큰은 미선택, 금액은 빈 값.
function defaultState(chainId: SupportedChainId): SwapFormState {
  return { chainId, tokenIn: nativeTokenOf(chainId), tokenOut: null, amountIn: "" };
}

function sameToken(a: Token | null, b: Token | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.chainId === b.chainId &&
    a.address.toLowerCase() === b.address.toLowerCase()
  );
}

const SwapFormContext = createContext<SwapFormValue | null>(null);
const SwapFormActionsContext = createContext<SwapFormActions | null>(null);
const SwapFormBalancesContext = createContext<SwapFormBalances | null>(null);

// 선택 체인을 바꾸면 입력 상태를 DoD-1 기본값으로 되돌린다(EC-1).
// 상태에 체인을 함께 저장하고 선택 체인과 다르면 기본값으로 바꾼다. Provider를 다시 마운트하지 않는다.
// 계정 변경·연결 해제는 입력 상태를 바꾸지 않는다(EC-6·EC-7).
export function SwapFormProvider({ children }: { children: ReactNode }) {
  const { selectedChainId } = useSelectedChain();
  const [storedState, setStoredState] = useState<SwapFormState>(() =>
    defaultState(selectedChainId),
  );

  let state = storedState;
  if (storedState.chainId !== selectedChainId) {
    state = defaultState(selectedChainId);
    setStoredState(state);
  }

  const { chainId, tokenIn, tokenOut, amountIn } = state;

  const balanceIn = useTokenBalance(tokenIn);
  const balanceOut = useTokenBalance(tokenOut);

  // 갱신 시점의 상태가 다른 체인 기준이면 기본값에서 시작한다.
  const update = useCallback(
    (next: (current: SwapFormState) => SwapFormState) => {
      setStoredState((previous) =>
        next(previous.chainId === selectedChainId ? previous : defaultState(selectedChainId)),
      );
    },
    [selectedChainId],
  );

  const selectToken = useCallback(
    (side: SwapSide, token: Token) => {
      update((current) => {
        const own = side === "in" ? current.tokenIn : current.tokenOut;
        const opposite = side === "in" ? current.tokenOut : current.tokenIn;

        if (sameToken(opposite, token)) {
          return { ...current, tokenIn: current.tokenOut, tokenOut: current.tokenIn, amountIn: "" };
        }
        if (sameToken(own, token)) return current;
        if (side === "out") return { ...current, tokenOut: token };
        return {
          ...current,
          tokenIn: token,
          amountIn: truncateAmountDecimals(current.amountIn, token.decimals),
        };
      });
    },
    [update],
  );

  const flipTokens = useCallback(() => {
    update((current) => ({
      ...current,
      tokenIn: current.tokenOut,
      tokenOut: current.tokenIn,
      amountIn: "",
    }));
  }, [update]);

  const setAmountInput = useCallback(
    (input: string) => {
      if (!tokenIn) return false;
      const sanitized = sanitizeAmountInput(input, tokenIn.decimals);
      if (sanitized === null) return false;
      update((current) =>
        sameToken(current.tokenIn, tokenIn) ? { ...current, amountIn: sanitized } : current,
      );
      return true;
    },
    [tokenIn, update],
  );

  const setMaxAmount = useCallback(() => {
    if (!tokenIn || balanceIn === null) return false;
    const amount = formatMaxAmount(balanceIn, tokenIn, chainId);
    update((current) =>
      sameToken(current.tokenIn, tokenIn) ? { ...current, amountIn: amount } : current,
    );
    return true;
  }, [tokenIn, balanceIn, chainId, update]);

  const value = useMemo<SwapFormValue>(
    () => ({
      chainId,
      tokenIn,
      tokenOut,
      amountIn,
      amountInRaw: tokenIn ? parseAmountRaw(amountIn, tokenIn.decimals) : null,
    }),
    [chainId, tokenIn, tokenOut, amountIn],
  );

  const actions = useMemo<SwapFormActions>(
    () => ({ selectToken, flipTokens, setAmountInput, setMaxAmount }),
    [selectToken, flipTokens, setAmountInput, setMaxAmount],
  );

  const balances = useMemo<SwapFormBalances>(
    () => ({ in: balanceIn, out: balanceOut }),
    [balanceIn, balanceOut],
  );

  return (
    <SwapFormContext.Provider value={value}>
      <SwapFormActionsContext.Provider value={actions}>
        <SwapFormBalancesContext.Provider value={balances}>
          {children}
        </SwapFormBalancesContext.Provider>
      </SwapFormActionsContext.Provider>
    </SwapFormContext.Provider>
  );
}

// §4.3 입력 상태. 상태를 바꾸는 함수는 담지 않는다.
export function useSwapForm(): SwapFormValue {
  const value = useContext(SwapFormContext);
  if (!value) throw new Error("useSwapForm must be used within SwapFormProvider");
  return value;
}

export function useSwapFormActions(): SwapFormActions {
  const value = useContext(SwapFormActionsContext);
  if (!value) throw new Error("useSwapFormActions must be used within SwapFormProvider");
  return value;
}

// 카드 두 칸의 잔액. 주 버튼의 잔액 부족 판정(`getSwapInputState`의 `balanceInRaw`)은 `in` 값을 쓴다.
export function useSwapFormBalances(): SwapFormBalances {
  const value = useContext(SwapFormBalancesContext);
  if (!value) throw new Error("useSwapFormBalances must be used within SwapFormProvider");
  return value;
}
