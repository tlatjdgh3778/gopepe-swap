import { swapRouter02Abi } from "@/abi/swapRouter02";
import { Address } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";

export const useSwap = ({
  swapRouterAddress,
  tokenIn,
  tokenOut,
  fee,
  recipient,
  amountIn,
  amountOutMinimum,
}: {
  swapRouterAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
}) => {
  const { mutate: swap, data: hash, ...rest } = useWriteContract();

  const receipt = useWaitForTransactionReceipt({ hash });

  const onSwap = () => {
    swap({
      address: swapRouterAddress,
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient,
          amountIn,
          amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  };

  return { onSwap, ...rest, hash, receipt };
};
