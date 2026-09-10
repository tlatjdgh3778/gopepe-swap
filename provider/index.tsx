import { State } from "wagmi";
import { QueryClientProvider } from "./QueryClientProvider";
import { RainbowKitProviders } from "./RainbowKitProvider";
import { WagmiProvider } from "./WagmiProvider";

export function Providers({
    initialState,
    children,
}: {
    initialState: State | undefined;
    children: React.ReactNode;
}) {
    return (
        <WagmiProvider initialState={initialState}>
            <QueryClientProvider>
                <RainbowKitProviders>{children}</RainbowKitProviders>
            </QueryClientProvider>
        </WagmiProvider>
    );
}
