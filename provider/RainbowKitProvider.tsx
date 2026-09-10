"use client";
import { RainbowKitProvider as RainbowKitProviderImpl } from "@rainbow-me/rainbowkit";

/**
 * Wraps the application with the RainbowKitProvider to provide wallet connection functionality.
 */
export function RainbowKitProviders({
    children,
}: {
    children: React.ReactNode;
}) {
    return <RainbowKitProviderImpl>{children}</RainbowKitProviderImpl>;
}
