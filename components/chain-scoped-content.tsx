"use client";

import { useState } from "react";
import { Address } from "viem";
import { getContractAddresses } from "@/config/contracts";
import { getTokenList } from "@/config/tokens";
import { useDebounce } from "@/hooks/useDebounce";
import { TokenInfo } from "./token-info";
import { AmountInput } from "./amount-input";
import { QuoteOutput } from "./quote-output";
import { SwapButton } from "./swap-button";
import { TokenRadioGroup } from "./token-radio-group";

export const ChainScopedContent = ({ address, chainId }: { address: Address; chainId: number }) => {
  /// 100 = 1%, 50 = 0.5%
  const [slippageBps, setSlippageBps] = useState(100);
  const [bigIntValue, setBigIntValue] = useState<bigint | "">("");
  const tokenList = getTokenList(chainId);
  const contractAddress = getContractAddresses(chainId);
  const [selectedTokenAddress, setSelectedTokenAddress] = useState<null | `0x${string}`>(null);
  // 기본값은 USDC — 기존 WETH → USDC 흐름이 그대로 유지되도록
  const [selectedTokenOutAddress, setSelectedTokenOutAddress] = useState<null | `0x${string}`>(
    () => tokenList.find((token) => token.symbol === "USDC")?.address ?? null,
  );
  const token = tokenList.find((token) => token.address === selectedTokenAddress);
  const tokenOut = tokenList.find((token) => token.address === selectedTokenOutAddress);
  const debouncedBigIntValue = useDebounce(bigIntValue);

  return (
    <>
      <p>보낼 토큰</p>
      <TokenRadioGroup
        name="token-in"
        tokenList={tokenList}
        selectedAddress={selectedTokenAddress}
        onSelect={setSelectedTokenAddress}
      />
      <p>받을 토큰</p>
      <TokenRadioGroup
        name="token-out"
        tokenList={tokenList}
        selectedAddress={selectedTokenOutAddress}
        onSelect={setSelectedTokenOutAddress}
      />
      {token && (
        <>
          <p>선택한 토큰: {token.symbol}</p>
          <TokenInfo
            ownerAddress={address}
            spenderAddress={contractAddress.swap_router_02}
            tokenAddress={token.address}
            decimals={token.decimals}
          />
          <AmountInput
            decimals={token.decimals}
            ownerAddress={address}
            tokenAddress={token.address}
            bigIntValue={bigIntValue}
            setBigIntValue={setBigIntValue}
            slippageBps={slippageBps}
            setSlippageBps={setSlippageBps}
          />
          {tokenOut && token.address !== tokenOut.address && (
            <>
              <QuoteOutput
                tokenIn={token.address}
                tokenOut={tokenOut}
                amountIn={debouncedBigIntValue === "" ? 0n : debouncedBigIntValue}
                chainId={chainId}
                slippageBps={slippageBps}
              />
              <SwapButton
                ownerAddress={address}
                tokenAddress={token.address}
                spenderAddress={contractAddress.swap_router_02}
                amountIn={debouncedBigIntValue === "" ? 0n : debouncedBigIntValue}
                swapRouterAddress={contractAddress.swap_router_02}
                tokenIn={token.address}
                tokenOut={tokenOut.address}
                recipient={address}
                chainId={chainId}
                slippageBps={slippageBps}
              />
            </>
          )}
        </>
      )}
    </>
  );
};
