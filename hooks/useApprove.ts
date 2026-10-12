import { Address, erc20Abi } from "viem";
import {
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";

export const useApprove = ({
  tokenAddress,
  spenderAddress,
  amount,
}: {
  tokenAddress: Address;
  spenderAddress: Address;
  amount: bigint;
}) => {
  const { data: simulateContract, ...simulateRest } = useSimulateContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [spenderAddress, amount],
    query: {
      enabled: amount !== 0n,
    },
  });

  const { mutate: approve, data: hash, ...rest } = useWriteContract();

  const receipt = useWaitForTransactionReceipt({
    hash,
    query: {
      enabled: !!hash,
    },
  });

  const onApprove = () => {
    approve(simulateContract!.request);
  };

  return { onApprove, hash, ...rest, receipt, simulate: simulateRest };
};
