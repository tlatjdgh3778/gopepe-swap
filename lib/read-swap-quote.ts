import { ContractFunctionExecutionError } from "viem";
import { multicall } from "viem/actions";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { FEE_TIERS, type FeeTier, quoterV2Abi, uniswapV3PoolAbi } from "@/config/uniswap-v3";
import {
  type FeeTierQuoteResult,
  type PoolSlot0Result,
  type SwapQuoteRequest,
  type SwapQuoteResult,
  buildSwapQuote,
  getPoolAddress,
} from "@/lib/swap-quote";
import { type TokenBalanceClient, withoutMulticallBatching } from "@/lib/token-balances";

// 견적 multicall의 묶음 크기. 0이면 viem이 호출을 나누지 않아 aggregate3 1회가 된다.
// 네 티어의 `slot0`(4바이트)과 `quoteExactInputSingle`(164바이트)은 합쳐 672바이트다(T-1 확인: 요청 본문·가스 한도 안).
export const SWAP_QUOTE_MULTICALL_BATCH_SIZE = 0;

// `sqrtPriceLimitX96` 0은 QuoterV2가 방향별 한계값(TickMath MIN+1·MAX−1)을 쓰게 한다.
const NO_SQRT_PRICE_LIMIT = 0n;

// multicall 결과의 실패가 하위 호출 하나의 실패(revert, 코드 없는 주소의 빈 반환값)인지 구분한다.
// 요청 자체(aggregate3 `eth_call`)가 실패하면 viem은 모든 결과에 aggregate3 호출 오류를 넣는다.
function isSubcallFailure(
  error: unknown,
  functionName: "slot0" | "quoteExactInputSingle",
): boolean {
  return error instanceof ContractFunctionExecutionError && error.functionName === functionName;
}

/**
 * 견적 1회를 읽는다. 선택 체인 QuoterV2의 네 티어 `quoteExactInputSingle`과 네 티어 풀(CREATE2 주소)의 `slot0`을
 * `allowFailure: true` aggregate3 `eth_call` 1회로 묶어 보낸다. 클라이언트의 multicall 묶음 설정은 끈 사본을 쓴다.
 * 하위 호출 실패는 그 티어의 revert로 보고 후보에서 뺀다(풀이 없는 티어의 `slot0`은 빈 반환값이라 실패다).
 * 요청 자체가 실패하거나 고른 티어의 `slot0`이 실패하면 throw한다.
 */
export async function readSwapQuote(
  client: TokenBalanceClient,
  request: SwapQuoteRequest,
): Promise<SwapQuoteResult> {
  const { chainId, tokenIn, tokenOut, amountIn } = request;
  const { quoterV2 } = CONTRACTS_BY_CHAIN[chainId];

  const slot0Contracts = FEE_TIERS.map((fee) => ({
    address: getPoolAddress({ chainId, tokenA: tokenIn, tokenB: tokenOut, fee }),
    abi: uniswapV3PoolAbi,
    functionName: "slot0" as const,
  }));
  const quoteContracts = FEE_TIERS.map((fee) => ({
    address: quoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle" as const,
    args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: NO_SQRT_PRICE_LIMIT }] as const,
  }));

  const results = await multicall(withoutMulticallBatching(client), {
    contracts: [...slot0Contracts, ...quoteContracts],
    allowFailure: true,
    batchSize: SWAP_QUOTE_MULTICALL_BATCH_SIZE,
  });

  const slot0 = {} as Record<FeeTier, PoolSlot0Result>;
  const quotes = {} as Record<FeeTier, FeeTierQuoteResult>;

  FEE_TIERS.forEach((fee, index) => {
    const slot0Result = results[index];
    if (slot0Result.status === "success") {
      const [sqrtPriceX96] = slot0Result.result as readonly [bigint, ...unknown[]];
      slot0[fee] = { status: "ok", sqrtPriceX96 };
    } else if (isSubcallFailure(slot0Result.error, "slot0")) {
      slot0[fee] = { status: "revert" };
    } else {
      throw slot0Result.error;
    }

    const quoteResult = results[FEE_TIERS.length + index];
    if (quoteResult.status === "success") {
      const [amountOut, sqrtPriceX96After] = quoteResult.result as readonly [
        bigint,
        bigint,
        ...unknown[],
      ];
      quotes[fee] = { status: "ok", amountOut, sqrtPriceX96After };
    } else if (isSubcallFailure(quoteResult.error, "quoteExactInputSingle")) {
      quotes[fee] = { status: "revert" };
    } else {
      throw quoteResult.error;
    }
  });

  return buildSwapQuote({ tokenIn, tokenOut, amountIn, quotes, slot0 });
}
