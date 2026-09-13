import type { Address } from "viem";
import { isSupportedChain, type SupportedChainsType } from "./chains";

export type SupportedContractsType = {
    swap_router_02: Address;
    quoter_v2: Address;
    v3_factory: Address;
    weth_9: Address;
};

export const contracts: Record<SupportedChainsType, SupportedContractsType> = {
    1: {
        swap_router_02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        quoter_v2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        v3_factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        weth_9: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    },
    31337: {
        swap_router_02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        quoter_v2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        v3_factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        weth_9: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    },
};

export const getContractAddresses = (chainId: number) => {
    if (!isSupportedChain(chainId)) {
        const contractsObj = Object.keys(contracts);
        const supportedChainIds = contractsObj.join(", ");
        throw Error(
            `지원되는 chainId 목록, ${supportedChainIds}, 전달 받은 chainId: ${chainId}, `,
        );
    } else {
        return contracts[chainId];
    }
};
