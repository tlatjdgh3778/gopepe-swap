import { Address, formatUnits } from "viem";
import { useAllowance } from "@/hooks/useAllowance";
import { useTokenBalance } from "@/hooks/useTokenBalance";

// 토큰 잔액과 allowance 를 보여주는 컴포넌트
export const TokenInfo = ({
    tokenAddress,
    ownerAddress,
    spenderAddress,
    decimals,
}: {
    tokenAddress: Address;
    ownerAddress: Address;
    spenderAddress: Address;
    decimals: number;
}) => {
    return (
        <div>
            <div>
                토큰 잔액 :
                <TokenBalance
                    tokenAddress={tokenAddress}
                    ownerAddress={ownerAddress}
                    decimals={decimals}
                />
            </div>
            <div>
                allowance :
                <Allowance
                    tokenAddress={tokenAddress}
                    ownerAddress={ownerAddress}
                    spenderAddress={spenderAddress}
                    decimals={decimals}
                />
            </div>
        </div>
    );
};

const TokenBalance = ({
    tokenAddress,
    ownerAddress,
    decimals,
}: {
    tokenAddress: Address;
    ownerAddress: Address;
    decimals: number;
}) => {
    const tokenBalance = useTokenBalance({
        tokenAddress,
        ownerAddress,
    });

    switch (tokenBalance.status) {
        case "success":
            // BigInt
            const balance = tokenBalance.data;
            return <span>{formatUnits(balance, decimals)}</span>;
        case "pending":
            return <span>토큰 잔액을 불러오는 중...</span>;
        default:
            return <span>토큰 잔액 불러오기 오류</span>;
    }
};

const Allowance = ({
    tokenAddress,
    ownerAddress,
    spenderAddress,
    decimals,
}: {
    tokenAddress: Address;
    ownerAddress: Address;
    spenderAddress: Address;
    decimals: number;
}) => {
    const allowance = useAllowance({
        tokenAddress,
        ownerAddress,
        spenderAddress,
    });

    switch (allowance.status) {
        case "success":
            // BigInt
            return <span>{formatUnits(allowance.data, decimals)}</span>;
        case "pending":
            return <span>현재 승인된 한도를 불러오는 중...</span>;
        default:
            return <span>현재 승인된 한도 불러오기 오류</span>;
    }
};
