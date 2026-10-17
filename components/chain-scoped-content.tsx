"use client";

import { useState } from "react";
import { Address } from "viem";
import { getContractAddresses } from "@/config/contracts";
import { getTokenList, TokenInfo as TokenInfoType } from "@/config/tokens";
import { useDebounce } from "@/hooks/useDebounce";
import { TokenInfo } from "./token-info";
import { QuoteOutput } from "./quote-output";
import { SwapButton } from "./swap-button";
import { TokenRadioGroup } from "./token-radio-group";
import { NativeTokenInfo } from "./native-token-info";
import { Erc20AmountInput } from "./erc-20-amount-input";
import { NativeAmountInput } from "./native-amount-input";

type SwapResult = {
  hash: string;
  received: string | null;
};

export const ChainScopedContent = ({
  address,
  chainId,
}: {
  address: Address;
  chainId: number;
}) => {
  /// 100 = 1%, 50 = 0.5%
  const [slippageBps, setSlippageBps] = useState(100);
  const [bigIntValue, setBigIntValue] = useState<bigint | "">("");
  const [swapResult, setSwapResult] = useState<SwapResult | null>(null);
  const [resetAmountInputKey, setResetAmountInputKey] = useState(0);
  const tokenList = getTokenList(chainId);
  const contractAddress = getContractAddresses(chainId);
  const [selectedTokenSymbol, setSelectedTokenSymbol] = useState<
    null | TokenInfoType["symbol"]
  >(null);
  // 기본값은 USDC — 기존 WETH → USDC 흐름이 그대로 유지되도록
  const [selectedTokenOutSymbol, setSelectedTokenOutSymbol] = useState<
    null | TokenInfoType["symbol"]
  >(() => tokenList.find((token) => token.symbol === "USDC")?.symbol ?? null);
  const token = tokenList.find((token) => token.symbol === selectedTokenSymbol);
  const tokenOut = tokenList.find(
    (token) => token.symbol === selectedTokenOutSymbol,
  );
  const debouncedBigIntValue = useDebounce(bigIntValue);

  const onSwapSuccess = (result: SwapResult) => {
    setBigIntValue("");
    const key = Math.random();
    setResetAmountInputKey(key);
    setSwapResult(result);
  };
  return (
    <>
      <p>보낼 토큰</p>
      <TokenRadioGroup
        name="token-in"
        tokenList={tokenList}
        selectedSymbol={selectedTokenSymbol}
        onSelect={setSelectedTokenSymbol}
      />
      <p>받을 토큰</p>
      <TokenRadioGroup
        name="token-out"
        tokenList={tokenList}
        selectedSymbol={selectedTokenOutSymbol}
        onSelect={setSelectedTokenOutSymbol}
      />
      {token &&
        (!token.isNative ? (
          <>
            <p>선택한 토큰: {token.symbol}</p>
            <TokenInfo
              ownerAddress={address}
              spenderAddress={contractAddress.swap_router_02}
              tokenAddress={token.address}
              decimals={token.decimals}
            />
            <Erc20AmountInput
              key={resetAmountInputKey}
              decimals={token.decimals}
              ownerAddress={address}
              tokenAddress={token.address}
              bigIntValue={bigIntValue}
              setBigIntValue={setBigIntValue}
              slippageBps={slippageBps}
              setSlippageBps={setSlippageBps}
            />
            {tokenOut &&
              !tokenOut.isNative &&
              token.address !== tokenOut.address && (
                <>
                  <QuoteOutput
                    tokenIn={token.address}
                    tokenOut={tokenOut}
                    amountIn={
                      debouncedBigIntValue === "" ? 0n : debouncedBigIntValue
                    }
                    chainId={chainId}
                    slippageBps={slippageBps}
                  />
                  <SwapButton
                    ownerAddress={address}
                    tokenAddress={token.address}
                    spenderAddress={contractAddress.swap_router_02}
                    amountIn={
                      debouncedBigIntValue === "" ? 0n : debouncedBigIntValue
                    }
                    swapRouterAddress={contractAddress.swap_router_02}
                    tokenIn={token.address}
                    tokenOut={tokenOut}
                    recipient={address}
                    chainId={chainId}
                    slippageBps={slippageBps}
                    onSwapSuccess={onSwapSuccess}
                  />
                  {swapResult && (
                    <div>
                      <p>{swapResult.hash}</p>
                      <p>
                        {swapResult.received} {tokenOut.symbol}
                      </p>
                    </div>
                  )}
                </>
              )}
          </>
        ) : (
          <>
            <p>선택한 토큰: {token.symbol}</p>
            <NativeTokenInfo address={address} />
            <NativeAmountInput
              key={resetAmountInputKey}
              decimals={token.decimals}
              ownerAddress={address}
              bigIntValue={bigIntValue}
              setBigIntValue={setBigIntValue}
              slippageBps={slippageBps}
              setSlippageBps={setSlippageBps}
            />
          </>
        ))}
    </>
  );
};
