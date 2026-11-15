"use client";

import { type ReactNode, createContext, useContext, useMemo, useState } from "react";

import { DEFAULT_SLIPPAGE_BPS, type SlippageBps } from "@/lib/slippage";

export type SlippageContextValue = {
  slippageBps: SlippageBps;
  setSlippageBps: (bps: SlippageBps) => void;
};

const SlippageContext = createContext<SlippageContextValue | null>(null);

/**
 * 슬리피지 허용치(스펙 §4.2). 클라이언트 메모리 상태이며 선택 체인, 지갑 연결, 계정과 무관하다.
 * 초기값은 서버 렌더링과 하이드레이션이 같도록 상수 `DEFAULT_SLIPPAGE_BPS`이고
 * 쿠키·브라우저 저장소·`window`를 읽지 않는다(DoD-2).
 */
export function SlippageProvider({ children }: { children: ReactNode }) {
  const [slippageBps, setSlippageBps] = useState<SlippageBps>(DEFAULT_SLIPPAGE_BPS);

  const value = useMemo<SlippageContextValue>(
    () => ({ slippageBps, setSlippageBps }),
    [slippageBps],
  );

  return <SlippageContext.Provider value={value}>{children}</SlippageContext.Provider>;
}

export function useSlippage(): SlippageContextValue {
  const value = useContext(SlippageContext);
  if (!value) throw new Error("useSlippage must be used within SlippageProvider");
  return value;
}
