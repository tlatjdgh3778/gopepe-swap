"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { CHAINS_BY_ID, type SupportedChain, type SupportedChainId } from "@/config/chains";
import { serializeSelectedChainCookie } from "@/lib/selected-chain";

type SelectedChainContextValue = {
  selectedChainId: SupportedChainId;
  selectedChain: SupportedChain;
  // 앱의 선택 체인만 바꾼다. 지갑에는 요청하지 않는다.
  setSelectedChainId: (chainId: SupportedChainId) => void;
  // 렌더 시점이 아닌 호출 시점의 최신 선택 체인을 읽는다.
  getSelectedChainId: () => SupportedChainId;
};

const SelectedChainContext = createContext<SelectedChainContextValue | null>(null);

export type SelectedChainProviderProps = {
  // 서버에서 `gopepe-chain` 쿠키를 `parseSelectedChainId`로 읽은 값.
  initialChainId: SupportedChainId;
  children: ReactNode;
};

// 선택 체인은 앱 상태이며 wagmi의 chainId에서 파생하지 않는다.
export function SelectedChainProvider({ initialChainId, children }: SelectedChainProviderProps) {
  const [selectedChainId, setSelectedChainIdState] = useState<SupportedChainId>(initialChainId);
  const latestChainIdRef = useRef<SupportedChainId>(initialChainId);

  const setSelectedChainId = useCallback((chainId: SupportedChainId) => {
    latestChainIdRef.current = chainId;
    setSelectedChainIdState(chainId);
    document.cookie = serializeSelectedChainCookie(chainId);
  }, []);

  const getSelectedChainId = useCallback(() => latestChainIdRef.current, []);

  const value = useMemo<SelectedChainContextValue>(
    () => ({
      selectedChainId,
      selectedChain: CHAINS_BY_ID[selectedChainId],
      setSelectedChainId,
      getSelectedChainId,
    }),
    [selectedChainId, setSelectedChainId, getSelectedChainId],
  );

  return <SelectedChainContext.Provider value={value}>{children}</SelectedChainContext.Provider>;
}

export function useSelectedChain(): SelectedChainContextValue {
  const value = useContext(SelectedChainContext);
  if (!value) throw new Error("useSelectedChain must be used within SelectedChainProvider");
  return value;
}
