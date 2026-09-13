import { cookieStorage, createConfig, createStorage } from "wagmi";
import { supportedChains, transports } from "./chains";

export const config = createConfig({
    chains: supportedChains,
    transports: transports,
    ssr: true,
    storage: createStorage({ storage: cookieStorage }),
});
