import { Dispatch, SetStateAction } from "react";
import { AmountInput } from "./amount-input";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { Address } from "viem";

export const Erc20AmountInput = ({
  decimals,
  bigIntValue,
  setBigIntValue,
  slippageBps,
  setSlippageBps,
  ownerAddress,
  tokenAddress,
}: {
  decimals: number;
  bigIntValue: bigint | "";
  setBigIntValue: Dispatch<SetStateAction<bigint | "">>;
  slippageBps: number;
  setSlippageBps: Dispatch<SetStateAction<number>>;
  ownerAddress: Address;
  tokenAddress: Address;
}) => {
  const tokenBalance = useTokenBalance({
    tokenAddress,
    ownerAddress,
  });
  const balance =
    tokenBalance.status === "success" ? tokenBalance.data : undefined;

  return (
    <AmountInput
      decimals={decimals}
      bigIntValue={bigIntValue}
      setBigIntValue={setBigIntValue}
      slippageBps={slippageBps}
      setSlippageBps={setSlippageBps}
      balance={balance}
    />
  );
};
