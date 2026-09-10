import { QueryClientProvider } from "./QueryClientProvider";
import { RainbowKitProviders } from "./RainbowKitProvider";
import { WagmiProvider } from "./WagmiProvider";

export function Providers({ children }: { children: React.ReactNode }) {
    return (
        <WagmiProvider>
            <QueryClientProvider>
                <RainbowKitProviders>{children}</RainbowKitProviders>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
