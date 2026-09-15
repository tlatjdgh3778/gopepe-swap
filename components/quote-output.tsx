import { Address, formatUnits } from "viem";
import { getTokenList } from "@/config/tokens";
import { useMultipleQuote } from "@/hooks/useMultipleQuote";

export const QuoteOutput = ({
    tokenIn,
    // tokenOut,
    amountIn,
    chainId,
}: {
    tokenIn: Address;
    // tokenOut: Address;
    amountIn: bigint;
    chainId: number;
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
            return (
                <div>
                    <p>quote: {formatUnits(amountOut, tokenOutDecimals)}</p>
                    <p>fee: {fee / 10000}%</p>
                </div>
            );
        case "pending":
            return <span>quote 계산 중 ...</span>;
        default:
            return <span>quote 계산 오류</span>;
    }
};
