"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { type State, WagmiProvider } from "wagmi";

import type { SupportedChainId } from "@/config/chains";

import { type WagmiConfig, attachE2EControl, createWagmiConfig } from "@/config/wagmi";
import { WalletRestoreSettledContext, useWalletRestoreTracker } from "@/hooks/use-wallet-restore";

import { SelectedChainProvider } from "./selected-chain-provider";
import { SwapFormProvider } from "./swap-form-provider";
import { SwapQuoteProvider } from "./swap-quote-provider";

export type AppProvidersProps = {
  // 서버에서 `gopepe-chain` 쿠키를 `parseSelectedChainId`로 읽은 값.
  initialChainId: SupportedChainId;
  // 서버에서 `getWagmiInitialState(cookie 헤더)`로 만든 값.
  initialState?: State;
  // 테스트가 `createWagmiConfig({ connectors })`로 만든 config를 주입할 때 쓴다. 생략하면 새로 만든다.
  config?: WagmiConfig;
  children: ReactNode;
};

function WalletRestoreBoundary({ children }: { children: ReactNode }) {
  const settled = useWalletRestoreTracker();
  return (
    <WalletRestoreSettledContext.Provider value={settled}>
      <SwapFormProvider>
        <SwapQuoteProvider>{children}</SwapQuoteProvider>
      </SwapFormProvider>
    </WalletRestoreSettledContext.Provider>
  );
}

export function AppProviders({
  initialChainId,
  initialState,
  config,
  children,
}: AppProvidersProps) {
  const [wagmiConfig] = useState(() => config ?? createWagmiConfig());
  const [queryClient] = useState(() => new QueryClient());

  useEffect(() => attachE2EControl(wagmiConfig), [wagmiConfig]);

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <SelectedChainProvider initialChainId={initialChainId}>
          <WalletRestoreBoundary>{children}</WalletRestoreBoundary>
        </SelectedChainProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
