// 슬리피지 계산
export const getSlippagedQuote = ({
    quotedOut,
    slippageBps,
}: {
    quotedOut: bigint;
    slippageBps: number;
}) => {
    const amountOutMinimum =
        (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;

    return amountOutMinimum;
};

const DEADLINE = 20;

/**
 *
 * @param deadline 분 단위 설정
 */
export const getDeadline = (deadline = DEADLINE) => {
    return BigInt(Math.floor(Date.now() / 1000) + 60 * deadline);
};
