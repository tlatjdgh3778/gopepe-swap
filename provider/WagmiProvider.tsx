"use client";
// WagmiProvider.tsx
import { config } from "@/config/wagmi";
import { ReactNode } from "react";
import { State, WagmiProvider as WagmiProviderImpl } from "wagmi";

/**
 * Wraps the application with the WagmiProvider.
 */
export function WagmiProvider({
    initialState,
    children,
}: {
    initialState: State | undefined;
    children: ReactNode;
}) {
    return (
        <WagmiProviderImpl config={config} initialState={initialState}>
            {children}
        </WagmiProviderImpl>
    );
}
