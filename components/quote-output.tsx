import { Address, formatUnits } from "viem";
import { getTokenList } from "@/config/tokens";
import { useMultipleQuote } from "@/hooks/useMultipleQuote";
import { getSlippagedQuote } from "@/lib/slippage";

export const QuoteOutput = ({
    tokenIn,
    // tokenOut,
    amountIn,
    chainId,
    slippageBps,
}: {
    tokenIn: Address;
    // tokenOut: Address;
    amountIn: bigint;
    chainId: number;
    slippageBps: number;
}) => {
    // WETH
    const tokenOut = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

    const contract = useMultipleQuote({
        tokenIn,
        tokenOut,
        amountIn,
        chainId,
    });
    const tokenList = getTokenList(chainId);
    const tokenOutDecimals = tokenList.find(
        (token) => token.address === tokenOut,
    )!.decimals;

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
                    <p>quote: {quote}</p>
                    <p>fee: {fee / 10000}%</p>
                    <p>
                        슬리피지 적용 {slippageBps / 100}%:{" "}
                        {formatUnits(slippagedQuote, tokenOutDecimals)}{" "}
                    </p>
                </div>
            );
        case "pending":
            return <span>quote 계산 중 ...</span>;
        default:
            return <span>quote 계산 오류</span>;
    }
};
