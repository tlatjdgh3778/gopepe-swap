// 어떤 체인을 지원하고, 체인에 접속하는 방법
import { http } from "wagmi";
import { mainnet, anvil } from "wagmi/chains";

export const supportedChains = [mainnet, anvil] as const;

export type SupportedChainsType = (typeof supportedChains)[number]["id"];

export const transports = {
    [mainnet.id]: http(process.env.NEXT_PUBLIC_ETH_MAINNET_RPC_URL),
    [anvil.id]: http(),
};

/**
 * type guard function
 */
export const isSupportedChain = (
    chainId: number,
): chainId is SupportedChainsType => {
    if (supportedChains.some((chain) => chain.id === chainId)) {
        return true;
    } else return false;
};
