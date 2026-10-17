import { Dispatch, SetStateAction } from "react";
import { AmountInput } from "./amount-input";
import { Address } from "viem";
import { useBalance } from "wagmi";

export const NativeAmountInput = ({
  decimals,
  bigIntValue,
  setBigIntValue,
  slippageBps,
  setSlippageBps,
  ownerAddress,
}: {
  decimals: number;
  bigIntValue: bigint | "";
  setBigIntValue: Dispatch<SetStateAction<bigint | "">>;
  slippageBps: number;
  setSlippageBps: Dispatch<SetStateAction<number>>;
  ownerAddress: Address;
}) => {
  const tokenBalance = useBalance({
    address: ownerAddress,
  });
  const balance =
    tokenBalance.status === "success" ? tokenBalance.data.value : undefined;

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
