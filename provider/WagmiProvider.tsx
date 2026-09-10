"use client";
// WagmiProvider.tsx
import { config } from "@/config/wagmi";
import { ReactNode } from "react";
import { WagmiProvider as WagmiProviderImpl } from "wagmi";

/**
 * Wraps the application with the WagmiProvider.
 */
export function WagmiProvider({ children }: { children: ReactNode }) {
    return <WagmiProviderImpl config={config}>{children}</WagmiProviderImpl>;
}
