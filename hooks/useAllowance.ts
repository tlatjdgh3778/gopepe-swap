import { Address, erc20Abi } from "viem";
import { useReadContract } from "wagmi";

// ERC-20 allowance (useReadContract)
export const useAllowance = ({
    tokenAddress,
    ownerAddress,
    spenderAddress,
}: {
    tokenAddress: Address;
    ownerAddress: Address;
    spenderAddress: Address;
}) => {
    const contract = useReadContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "allowance",
        args: [ownerAddress, spenderAddress],
        query: {
            enabled: !!tokenAddress && !!ownerAddress && !!spenderAddress,
        },
    });

    return contract;
};
