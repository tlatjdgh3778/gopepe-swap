"use client";

import { useState } from "react";
import { Address } from "viem";
import { getContractAddresses } from "@/config/contracts";
import { getTokenList } from "@/config/tokens";
import { TokenInfo } from "./token-info";

export const ChainScopedContent = ({
    address,
    chainId,
}: {
    address: Address;
    chainId: number;
}) => {
    const tokenList = getTokenList(chainId);
    const contractAddress = getContractAddresses(chainId);
    const [selectedTokenAddress, setSelectedTokenAddress] = useState<
        null | `0x${string}`
    >(null);
    const token = tokenList.find(
        (token) => token.address === selectedTokenAddress,
    );

    return (
        <>
            <form>
                {tokenList.map((token) => {
                    return (
                        <div key={token.address}>
                            <input
                                type="radio"
                                id={token.address}
                                name={"token-select"}
                                value={token.address}
                                onChange={(e) => {
                                    const value = e.target
                                        .value as `0x${string}`;
                                    setSelectedTokenAddress(value);
                                }}
                            />
                            <label htmlFor={token.address}>
                                {token.symbol}
                            </label>
                        </div>
                    );
                })}
            </form>
            {token && (
                <>
                    <p>선택한 토큰: {token.symbol}</p>
                    <TokenInfo
                        ownerAddress={address}
                        spenderAddress={contractAddress.swap_router_02}
                        tokenAddress={token.address}
                        decimals={token.decimals}
                    />
                </>
            )}
        </>
    );
};
