// 승인 필요 판정
// approve 실행

import { useAllowance } from "@/hooks/useAllowance";
import { useApprove } from "@/hooks/useApprove";
import { useMultipleQuote } from "@/hooks/useMultipleQuote";
import { useSwap } from "@/hooks/useSwap";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { getSlippagedQuote } from "@/lib/slippage";
import { useEffect } from "react";
import { Address } from "viem";

// swap 실행
export const SwapButton = ({
  tokenAddress,
  ownerAddress,
  spenderAddress,
  amountIn,
  swapRouterAddress,
  tokenIn,
  tokenOut,
  recipient,
  chainId,
  slippageBps,
}: {
  tokenAddress: Address;
  ownerAddress: Address;
  spenderAddress: Address;
  amountIn: bigint;
  swapRouterAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  recipient: Address;
  chainId: number;
  slippageBps: number;
}) => {
  const allowance = useAllowance({
    tokenAddress,
    ownerAddress,
    spenderAddress,
  });
  const contract = useMultipleQuote({
    tokenIn,
    tokenOut,
    amountIn,
    chainId,
  });
  const amountOut = contract.amountOut;
  const slippagedQuote = getSlippagedQuote({
    quotedOut: amountOut,
    slippageBps,
  });

  // const needApprove = allowance < amountIn;
  switch (allowance.status) {
    case "success":
      // BigInt
      const needApprove = allowance.data < amountIn;
      if (needApprove) {
        return (
          <ApproveButton
            tokenAddress={tokenAddress}
            spenderAddress={spenderAddress}
            amount={amountIn}
            onApproved={() => allowance.refetch()}
          />
        );
      }
      if (contract.status === "success") {
        return (
          <RealSwapButton
            spenderAddress={swapRouterAddress}
            tokenIn={tokenIn}
            tokenOut={tokenOut}
            fee={contract.fee}
            recipient={recipient}
            amountIn={amountIn}
            amountOutMinimum={slippagedQuote}
            onSwapped={() => allowance.refetch()}
          />
        );
      } else {
        return (
          <button
            className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
            disabled
          >
            quote 계산 중...
          </button>
        );
      }

    case "pending":
      return (
        <ApproveButton
          tokenAddress={tokenAddress}
          spenderAddress={spenderAddress}
          amount={amountIn}
          onApproved={() => allowance.refetch()}
          disabled
        />
      );
    default:
      return (
        <ApproveButton
          tokenAddress={tokenAddress}
          spenderAddress={spenderAddress}
          amount={amountIn}
          onApproved={() => allowance.refetch()}
          disabled
        />
      );
  }
};

const ApproveButton = ({
  tokenAddress,
  spenderAddress,
  amount,
  disabled,
  onApproved,
}: {
  tokenAddress: Address;
  spenderAddress: Address;
  amount: bigint;
  disabled?: boolean;
  onApproved: () => void;
}) => {
  const { onApprove, isPending, isError, isSuccess, hash, receipt } =
    useApprove({
      tokenAddress,
      spenderAddress,
      amount,
    });
  useEffect(() => {
    if (receipt.isSuccess) {
      onApproved();
    }
  }, [receipt.isSuccess]);

  if (isPending) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled={disabled}
      >
        승인 중...
      </button>
    );
  }
  if (isError) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled={disabled}
      >
        승인 에러
      </button>
    );
  }
  if (isSuccess) {
    return (
      <div>
        <button
          className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
          disabled={disabled}
        >
          승인됨 (트랜잭션이 네트워크로 전송됨)
        </button>
        <p>생성된 트랜잭션 {hash}(</p>
        {receipt.isPending && <p>블록 생성 중...</p>}
        {receipt.isError && <p>트랜잭션 취소됨</p>}
        {receipt.isSuccess && (
          <p>생성된 네트워크 블록 {receipt.data.blockHash}</p>
        )}
      </div>
    );
  }
  return (
    <button
      className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
      disabled={disabled}
      onClick={onApprove}
    >
      승인
    </button>
  );
};

const RealSwapButton = ({
  spenderAddress,
  tokenIn,
  tokenOut,
  fee,
  recipient,
  amountIn,
  amountOutMinimum,
  disabled,
  onSwapped,
}: {
  spenderAddress: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  disabled?: boolean;
  onSwapped: () => void;
}) => {
  const { onSwap, isPending, isSuccess, isError, receipt, hash } = useSwap({
    swapRouterAddress: spenderAddress,
    tokenIn,
    tokenOut,
    fee,
    recipient,
    amountIn,
    amountOutMinimum,
  });
  const tokenBalance = useTokenBalance({
    tokenAddress: tokenIn,
    ownerAddress: recipient,
  });

  useEffect(() => {
    if (receipt.isSuccess) {
      // TokenInfo 의 잔액
      // allowance
      // QuoteOutput의 quote
      onSwapped();
      tokenBalance.refetch();
    }
  }, [receipt.isSuccess]);

  if (isPending) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled
      >
        스왑중...
      </button>
    );
  }
  if (isSuccess) {
    return (
      <div>
        <button
          className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
          disabled
        >
          스왑완료
        </button>
        <p>생성된 트랜잭션 {hash}</p>
        {receipt.isPending && <p>블록 생성 중...</p>}
        {receipt.isError && <p>트랜잭션 취소됨</p>}
        {receipt.isSuccess && (
          <p>생성된 네트워크 블록 {receipt.data.blockHash}</p>
        )}
      </div>
    );
  }
  if (isError) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled
      >
        스왑실패
      </button>
    );
  }
  return (
    <button
      onClick={onSwap}
      className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
      disabled={disabled}
    >
      스왑
    </button>
  );
};
