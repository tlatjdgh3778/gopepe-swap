import { Address } from "viem";
import { useSingleQuote } from "./useSingleQuote";

// quoterV2 quoteExactInput (useSimulateContract)
export const useMultipleQuote = ({
    tokenIn,
    tokenOut,
    amountIn,
    chainId,
}: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    chainId: number;
}) => {
    // quoterV2 abi 를 실행해보는 훅
    const quote500 = useSingleQuote({
        tokenIn,
        tokenOut,
        amountIn,
        // 0.05 x 1,000,000
        fee: 500,
        chainId,
    });
    const quote3000 = useSingleQuote({
        tokenIn,
        tokenOut,
        amountIn,
        // 0.3 x 1,000,000
        fee: 3000,
        chainId,
    });
    const quote10000 = useSingleQuote({
        tokenIn,
        tokenOut,
        amountIn,
        // 1.0 x 1,000,000
        fee: 10000,
        chainId,
    });

    const isPending =
        quote500.status === "pending" ||
        quote3000.status === "pending" ||
        quote10000.status === "pending";
    const isAllError =
        quote500.status === "error" &&
        quote3000.status === "error" &&
        quote10000.status === "error";
    const quotes = [
        {
            fee: 500,
            amount:
                quote500.status === "success" ? quote500.data.result[0] : 0n,
        },
        {
            fee: 3000,
            amount:
                quote3000.status === "success" ? quote3000.data.result[0] : 0n,
        },
        {
            fee: 10000,
            amount:
                quote10000.status === "success"
                    ? quote10000.data.result[0]
                    : 0n,
        },
    ];
    const selectedQuote = quotes.sort((a, b) => {
        if (a.amount > b.amount) {
            return 1;
        }
        if (a.amount < b.amount) {
            return -1;
        }
        return 0;
    })[quotes.length - 1];

    return {
        status: isPending ? "pending" : isAllError ? "error" : "success",
        fee: isPending ? 0 : isAllError ? 0 : selectedQuote.fee,
        amountOut: isPending ? 0n : isAllError ? 0n : selectedQuote.amount,
    };
};
