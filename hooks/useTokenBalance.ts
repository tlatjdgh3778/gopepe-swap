import { Address, erc20Abi } from "viem";
import { useReadContract } from "wagmi";

// ERC-20 balanceOf (useReadContract)
export const useTokenBalance = ({
    tokenAddress,
    ownerAddress,
}: {
    tokenAddress: Address;
    ownerAddress: Address;
}) => {
    const contract = useReadContract({
        // 호출하려는 contract 주소
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        // balanceOf 의 input
        args: [ownerAddress],
        query: {
            enabled: !!ownerAddress && !!tokenAddress,
        },
    });

    return contract;
};
