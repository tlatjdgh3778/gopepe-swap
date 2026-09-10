import { createConfig, http } from "wagmi";
import { mainnet, anvil } from "wagmi/chains";

export const config = createConfig({
    chains: [mainnet, anvil],
    transports: {
        [mainnet.id]: http(),
        [anvil.id]: http(),
    },
    ssr: true,
});
