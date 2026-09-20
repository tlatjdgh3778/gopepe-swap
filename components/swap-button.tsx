// 승인 필요 판정
// approve 실행

import { useAllowance } from "@/hooks/useAllowance";
import { Address } from "viem";

// swap 실행
export const SwapButton = ({
    tokenAddress,
    ownerAddress,
    spenderAddress,
    amountIn,
}: {
    tokenAddress: Address;
    ownerAddress: Address;
    spenderAddress: Address;
    amountIn: bigint;
}) => {
    const allowance = useAllowance({
        tokenAddress,
        ownerAddress,
        spenderAddress,
    });

    // const needApprove = allowance < amountIn;
    switch (allowance.status) {
        case "success":
            // BigInt
            const needApprove = allowance.data < amountIn;
            if (needApprove) {
                return (
                    <button className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10">
                        승인
                    </button>
                );
            }
            return (
                <button className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10">
                    스왑
                </button>
            );
        case "pending":
            return (
                <button
                    className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
                    disabled
                >
                    승인
                </button>
            );
        default:
            return (
                <button
                    className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
                    disabled
                >
                    승인
                </button>
            );
    }
};
