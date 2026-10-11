import { Address, formatUnits } from "viem";
import { TokenInfo } from "@/config/tokens";
import { useMultipleQuote } from "@/hooks/useMultipleQuote";
import { getSlippagedQuote } from "@/lib/slippage";

export const QuoteOutput = ({
  tokenIn,
  tokenOut,
  amountIn,
  chainId,
  slippageBps,
}: {
  tokenIn: Address;
  tokenOut: TokenInfo;
  amountIn: bigint;
  chainId: number;
  slippageBps: number;
}) => {
  const tokenOutDecimals = tokenOut.decimals;
  const tokenOutAddress = tokenOut.address;

  const contract = useMultipleQuote({
    tokenIn,
    tokenOut: tokenOutAddress,
    amountIn,
    chainId,
  });

  switch (contract.status) {
    case "success":
      const amountOut = contract.amountOut;
      const fee = contract.fee;
      const quote = formatUnits(amountOut, tokenOutDecimals);

      const slippagedQuote = getSlippagedQuote({
        quotedOut: amountOut,
        slippageBps,
      });

      return (
        <div>
          <p>
            quote: {quote} {tokenOut.symbol}
          </p>
          <p>fee: {fee / 10000}%</p>
          <p>
            슬리피지 적용 {slippageBps / 100}%: {formatUnits(slippagedQuote, tokenOutDecimals)}{" "}
            {tokenOut.symbol}
          </p>
        </div>
      );
    case "pending":
      return <span>quote 계산 중 ...</span>;
    default:
      return <span>quote 계산 오류</span>;
  }
};
