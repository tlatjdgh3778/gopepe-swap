// export const tokens
import { Address } from "viem";
import { isSupportedChain, SupportedChainsType } from "./chains";

type TokenInfo = {
    symbol: "WETH" | "USDC" | "USDT" | "DAI";
    address: Address;
    decimals: number;
};

export const tokens: Record<SupportedChainsType, TokenInfo[]> = {
    1: [
        {
            symbol: "WETH",
            address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            decimals: 18,
        },
        {
            symbol: "USDC",
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            decimals: 6,
        },
        {
            symbol: "USDT",
            address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            decimals: 6,
        },
        {
            symbol: "DAI",
            address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            decimals: 18,
        },
    ],
    31337: [
        {
            symbol: "WETH",
            address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            decimals: 18,
        },
        {
            symbol: "USDC",
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            decimals: 6,
        },
        {
            symbol: "USDT",
            address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
            decimals: 6,
        },
        {
            symbol: "DAI",
            address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
            decimals: 18,
        },
    ],
};

export const getTokenList = (chainId: number) => {
    if (!isSupportedChain(chainId)) {
        const tokensObj = Object.keys(tokens);
        const supportedChainIds = tokensObj.join(", ");
        throw Error(
            `지원되는 chainId 목록, ${supportedChainIds}, 전달 받은 chainId: ${chainId}, `,
        );
    } else {
        return tokens[chainId];
    }
};
