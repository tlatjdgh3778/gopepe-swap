import { Address } from "viem";
import { useSimulateContract } from "wagmi";
import { quoterV2Abi } from "@/abi/quoterV2";
import { getContractAddresses } from "@/config/contracts";

// quoterV2 quoteExactInputSingle (useSimulateContract)
export const useSingleQuote = ({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96 = 0n,
    chainId,
}: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    fee: number;
    sqrtPriceLimitX96?: bigint;
    chainId: number;
}) => {
    const contractAddress = getContractAddresses(chainId).quoter_v2;
    // quoterV2 abi 를 실행해보는 훅
    const contract = useSimulateContract({
        address: contractAddress,
        abi: quoterV2Abi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96 }],
        query: {
            enabled: amountIn !== 0n && tokenIn !== tokenOut,
        },
    });

    return contract;
};
