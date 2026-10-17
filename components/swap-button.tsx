// 승인 필요 판정
// approve 실행

import { getContractAddresses } from "@/config/contracts";
import { TokenInfo } from "@/config/tokens";
import { useAllowance } from "@/hooks/useAllowance";
import { useApprove } from "@/hooks/useApprove";
import { useMultipleQuote } from "@/hooks/useMultipleQuote";
import { useSwap } from "@/hooks/useSwap";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { isUserRejected, parseRevertReason } from "@/lib/error";
import { getSlippagedQuote } from "@/lib/slippage";
import { useEffect } from "react";
import { Address, decodeEventLog, erc20Abi, formatUnits } from "viem";

type SwapResult = {
  hash: string;
  received: string | null;
};

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
  onSwapSuccess,
}: {
  tokenAddress: Address;
  ownerAddress: Address;
  spenderAddress: Address;
  amountIn: bigint;
  swapRouterAddress: Address;
  tokenIn: Address;
  tokenOut: TokenInfo;
  recipient: Address;
  chainId: number;
  slippageBps: number;
  onSwapSuccess: (result: SwapResult) => void;
}) => {
  const contractAddress = getContractAddresses(chainId);
  const tokenOutAddress = tokenOut.isNative
    ? contractAddress.weth_9 // ETH → WETH 주소로 치환
    : tokenOut.address;

  const allowance = useAllowance({
    tokenAddress,
    ownerAddress,
    spenderAddress,
  });
  const contract = useMultipleQuote({
    tokenIn,
    tokenOut: tokenOutAddress,
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
            tokenOutAddress={tokenOutAddress}
            fee={contract.fee}
            recipient={recipient}
            amountIn={amountIn}
            amountOutMinimum={slippagedQuote}
            onSwapped={(result: SwapResult) => {
              allowance.refetch();
              onSwapSuccess(result);
            }}
          />
        );
      } else {
        if (amountIn === 0n)
          return (
            <button
              className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
              disabled
            >
              금액을 입력하세요.
            </button>
          );
        if (contract.status === "error")
          return (
            <button
              className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
              disabled
            >
              quote를 가져올 수 없어요
            </button>
          );
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
  const {
    onApprove,
    isPending,
    isError,
    error,
    isSuccess,
    hash,
    receipt,
    reset,
    simulate,
  } = useApprove({
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
        지갑에서 확인해주세요.
      </button>
    );
  }
  if (isError) {
    const userRejected = isUserRejected(error);
    const revertRejected = parseRevertReason(error);
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        onClick={reset}
      >
        {userRejected ? "사용자 거부" : (revertRejected ?? "승인에러")}
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
        {receipt.status === "success" &&
          (receipt.data.status === "success" ? (
            <p>생성된 네트워크 블록 {receipt.data.blockHash}</p>
          ) : receipt.data.status === "reverted" ? (
            <p>revert 됨</p>
          ) : null)}
        {receipt.status === "error" && <p>{receipt.error.message}</p>}
        {receipt.status === "pending" && <p>블록 생성 중...</p>}
      </div>
    );
  }
  if (simulate.isPending) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled={disabled}
      >
        확인 중...
      </button>
    );
  }
  if (simulate.isError) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled
      >
        {"승인 불가 (시뮬레이션 실패)"}
      </button>
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
  tokenOutAddress,
  fee,
  recipient,
  amountIn,
  amountOutMinimum,
  disabled,
  onSwapped,
}: {
  spenderAddress: Address;
  tokenIn: Address;
  tokenOut: TokenInfo;
  tokenOutAddress: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  disabled?: boolean;
  onSwapped: (result: SwapResult) => void;
}) => {
  const {
    onSwap,
    isPending,
    isSuccess,
    isError,
    error,
    receipt,
    hash,
    reset,
    simulate,
  } = useSwap({
    swapRouterAddress: spenderAddress,
    tokenIn,
    tokenOut: tokenOutAddress,
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
    if (receipt.isSuccess && receipt.data.status === "success") {
      // TokenInfo 의 잔액
      // allowance
      // QuoteOutput의 quote\
      const tokenOutLog = receipt.data?.logs.find(
        (log) => log.address.toLowerCase() === tokenOutAddress.toLowerCase(),
      );

      const realquote = tokenOutLog
        ? formatUnits(
            decodeEventLog({ abi: erc20Abi, ...tokenOutLog }).args.value,
            tokenOut.decimals,
          )
        : null;
      onSwapped({
        hash: receipt.data.transactionHash,
        received: realquote,
      });
      tokenBalance.refetch();
    }
  }, [receipt.isSuccess, receipt.data?.status]);

  if (isPending) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled
      >
        지갑에서 확인해주세요.
      </button>
    );
  }
  if (isSuccess) {
    const tokenOutLog = receipt.data?.logs.find(
      (log) => log.address.toLowerCase() === tokenOutAddress.toLowerCase(),
    );

    const realquote = tokenOutLog
      ? formatUnits(
          decodeEventLog({ abi: erc20Abi, ...tokenOutLog }).args.value,
          tokenOut.decimals,
        )
      : null;

    return (
      <div>
        <button
          className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
          disabled
        >
          스왑완료
        </button>
        <p>생성된 트랜잭션 {hash}</p>
        {receipt.status === "success" &&
          (receipt.data.status === "success" ? (
            <div>
              <p>생성된 네트워크 블록 {receipt.data.blockHash}</p>
              <p>
                실제 받은 금액 {realquote}
                {tokenOut.symbol}
              </p>
            </div>
          ) : receipt.data.status === "reverted" ? (
            <p>revert 됨</p>
          ) : null)}
        {receipt.status === "error" && <p>{receipt.error.message}</p>}
        {receipt.status === "pending" && <p>블록 생성 중...</p>}
      </div>
    );
  }
  if (isError) {
    const userRejected = isUserRejected(error);
    const revertRejected = parseRevertReason(error);
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        onClick={reset}
      >
        {userRejected ? "사용자 거부" : (revertRejected ?? "스왑실패")}
      </button>
    );
  }
  if (simulate.isPending) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled={disabled}
      >
        확인 중...
      </button>
    );
  }
  if (simulate.isError) {
    return (
      <button
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        disabled
      >
        {"스왑 불가 (시뮬레이션 실패)"}
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
