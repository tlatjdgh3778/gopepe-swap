import {
  type Address,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  parseAbiParameters,
} from "viem";

import type { SupportedChainId } from "@/config/chains";
import type { Token } from "@/config/tokens";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import {
  FEE_TIERS,
  type FeeTier,
  POOL_INIT_CODE_HASH,
  SQRT_PRICE_LIMIT_ONE_FOR_ZERO,
  SQRT_PRICE_LIMIT_ZERO_FOR_ONE,
} from "@/config/uniswap-v3";
import { isSwapInputIdle } from "@/lib/swap-input-state";
import { isNativeToken } from "@/lib/token-amount";

// 스펙 §4.1 견적 상태.
export type SwapQuoteStatus = "idle" | "loading" | "no-route" | "error" | "success";

export type SwapQuote = {
  amountOut: bigint;
  fee: FeeTier;
  // bps 단위. 정수로 제한하지 않고, 반올림 오차로 음수일 수 있다.
  priceImpactBps: number;
};

// `quote`는 `status`가 `success`일 때만 `null`이 아니다.
export type SwapQuoteState =
  | { status: "success"; quote: SwapQuote }
  | { status: Exclude<SwapQuoteStatus, "success">; quote: null };

// ─── 견적할 토큰 주소 ───────────────────────────────────────────────

export type QuoteTokenPairParams = {
  chainId: SupportedChainId;
  tokenIn: Pick<Token, "address">;
  tokenOut: Pick<Token, "address">;
};

function isSameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isWethToken(chainId: SupportedChainId, token: Pick<Token, "address">): boolean {
  return isSameAddress(token.address, CONTRACTS_BY_CHAIN[chainId].weth);
}

/**
 * 두 토큰이 ETH와 선택 체인의 WETH이면(순서 무관) 참이다. 이 페어는 견적 없이 `no-route`다(EC-6).
 */
export function isEthWethPair({ chainId, tokenIn, tokenOut }: QuoteTokenPairParams): boolean {
  return (
    (isNativeToken(tokenIn) && isWethToken(chainId, tokenOut)) ||
    (isWethToken(chainId, tokenIn) && isNativeToken(tokenOut))
  );
}

/**
 * 견적할 토큰 주소. ETH는 선택 체인의 WETH 주소로 바꾸고, 그 밖의 토큰은 주소 그대로다.
 */
export function getQuoteTokenAddress(
  chainId: SupportedChainId,
  token: Pick<Token, "address">,
): Address {
  return isNativeToken(token) ? CONTRACTS_BY_CHAIN[chainId].weth : token.address;
}

/**
 * 견적할 두 토큰 주소. 보내는 쪽·받는 쪽 중 ETH인 쪽을 선택 체인의 WETH 주소로 바꾼다(DoD-4).
 */
export function resolveQuoteTokens({ chainId, tokenIn, tokenOut }: QuoteTokenPairParams): {
  tokenIn: Address;
  tokenOut: Address;
} {
  return {
    tokenIn: getQuoteTokenAddress(chainId, tokenIn),
    tokenOut: getQuoteTokenAddress(chainId, tokenOut),
  };
}

// ─── 방향과 풀 주소 ─────────────────────────────────────────────────

function addressToBigInt(address: Address): bigint {
  return BigInt(address);
}

/**
 * Uniswap V3 규칙대로 주소를 수치로 비교해 `[token0, token1]`로 정렬한다. 체크섬 문자열 비교를 쓰지 않는다.
 */
export function sortTokens(tokenA: Address, tokenB: Address): readonly [Address, Address] {
  return addressToBigInt(tokenA) < addressToBigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * 견적할(WETH 치환 후) 보내는 토큰이 token0이면 참(zeroForOne)이다.
 */
export function isZeroForOne(tokenIn: Address, tokenOut: Address): boolean {
  return addressToBigInt(tokenIn) < addressToBigInt(tokenOut);
}

export type PoolAddressParams = {
  chainId: SupportedChainId;
  tokenA: Address;
  tokenB: Address;
  fee: FeeTier;
};

/**
 * 선택 체인 팩토리의 풀 주소를 CREATE2로 계산한다. 두 토큰 순서는 무관하다.
 * 풀이 배포되지 않았어도 주소는 나온다.
 */
export function getPoolAddress({ chainId, tokenA, tokenB, fee }: PoolAddressParams): Address {
  const [token0, token1] = sortTokens(tokenA, tokenB);
  const salt = keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24"), [token0, token1, fee]),
  );
  return getContractAddress({
    opcode: "CREATE2",
    from: CONTRACTS_BY_CHAIN[chainId].factory,
    salt,
    bytecodeHash: POOL_INIT_CODE_HASH,
  });
}

// ─── 견적 입력 판정 ─────────────────────────────────────────────────

export type SwapQuoteRequest = {
  chainId: SupportedChainId;
  // WETH 치환 후 주소.
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  zeroForOne: boolean;
};

export type SwapQuotePlan =
  | { status: "idle" }
  | { status: "no-route" }
  | { status: "quote"; request: SwapQuoteRequest };

export type SwapQuotePlanParams = {
  chainId: SupportedChainId;
  tokenIn: Token | null;
  tokenOut: Token | null;
  // §4.3 `amountInRaw`. 빈 값·`.`이면 `null`.
  amountInRaw: bigint | null;
};

/**
 * RPC 없이 정할 수 있는 견적 상태를 먼저 판정한다.
 * 토큰 미선택 또는 금액이 비었거나 0이면 `idle`, ETH ↔ WETH이면 `no-route`,
 * 그 밖에는 WETH로 치환한 주소와 방향으로 견적할 요청(`quote`)이다.
 */
export function planSwapQuote({
  chainId,
  tokenIn,
  tokenOut,
  amountInRaw,
}: SwapQuotePlanParams): SwapQuotePlan {
  if (
    isSwapInputIdle({ tokenIn, tokenOut, amountInRaw }) ||
    tokenIn === null ||
    tokenOut === null ||
    amountInRaw === null
  ) {
    return { status: "idle" };
  }
  if (isEthWethPair({ chainId, tokenIn, tokenOut })) return { status: "no-route" };

  const quoteTokens = resolveQuoteTokens({ chainId, tokenIn, tokenOut });
  return {
    status: "quote",
    request: {
      chainId,
      tokenIn: quoteTokens.tokenIn,
      tokenOut: quoteTokens.tokenOut,
      amountIn: amountInRaw,
      zeroForOne: isZeroForOne(quoteTokens.tokenIn, quoteTokens.tokenOut),
    },
  };
}

// ─── 티어 선택 ─────────────────────────────────────────────────────

// 티어 하나의 QuoterV2 `quoteExactInputSingle` 하위 호출 결과. 풀이 없으면 revert한다.
export type FeeTierQuoteResult =
  | { status: "revert" }
  | { status: "ok"; amountOut: bigint; sqrtPriceX96After: bigint };

export type FeeTierQuoteResults = Readonly<Record<FeeTier, FeeTierQuoteResult>>;

// 티어 하나의 풀 `slot0` 하위 호출 결과.
export type PoolSlot0Result = { status: "revert" } | { status: "ok"; sqrtPriceX96: bigint };

export type PoolSlot0Results = Readonly<Record<FeeTier, PoolSlot0Result>>;

/**
 * 견적 후 가격이 방향별 한계값(zeroForOne이면 `MIN_SQRT_RATIO + 1`, 아니면 `MAX_SQRT_RATIO - 1`)에 닿았으면
 * 풀의 유동성을 모두 써도 입력을 소화하지 못한 것이다(EC-3).
 */
export function isLiquidityExhausted(zeroForOne: boolean, sqrtPriceX96After: bigint): boolean {
  const limit = zeroForOne ? SQRT_PRICE_LIMIT_ZERO_FOR_ONE : SQRT_PRICE_LIMIT_ONE_FOR_ZERO;
  return sqrtPriceX96After === limit;
}

export type SelectFeeTierParams = {
  // WETH 치환 후 주소. 방향(zeroForOne)을 정한다.
  tokenIn: Address;
  tokenOut: Address;
  quotes: FeeTierQuoteResults;
};

export type SelectedFeeTier = { fee: FeeTier; amountOut: bigint };

/**
 * revert(EC-1), 수령량 0(EC-2), 유동성 소진(EC-3) 티어를 빼고 수령량이 가장 많은 티어를 고른다(DoD-2).
 * 수령량이 같으면 수수료가 가장 낮은 티어다(DoD-3). 남은 후보가 없으면 `null`(`no-route`, EC-4)이다.
 */
export function selectFeeTier({
  tokenIn,
  tokenOut,
  quotes,
}: SelectFeeTierParams): SelectedFeeTier | null {
  const zeroForOne = isZeroForOne(tokenIn, tokenOut);
  let selected: SelectedFeeTier | null = null;

  // FEE_TIERS는 낮은 수수료 순이라, 더 많은 수령량일 때만 바꾸면 동률에서 낮은 수수료가 남는다.
  for (const fee of FEE_TIERS) {
    const result = quotes[fee];
    if (result.status !== "ok") continue;
    if (result.amountOut <= 0n) continue;
    if (isLiquidityExhausted(zeroForOne, result.sqrtPriceX96After)) continue;
    if (selected === null || result.amountOut > selected.amountOut) {
      selected = { fee, amountOut: result.amountOut };
    }
  }

  return selected;
}

// ─── 가격 영향 ─────────────────────────────────────────────────────

const Q192 = 1n << 192n;
// 가격 영향을 number로 바꿀 때 남기는 bps 소수 자릿수(10^-9 bps). 정수 결과는 정확히 정수가 된다.
const PRICE_IMPACT_SCALE = 1_000_000_000n;

export type PriceImpactParams = {
  // WETH 치환 후 주소. 방향(zeroForOne)을 정한다.
  tokenIn: Address;
  tokenOut: Address;
  // 견적 직전 고른 티어 풀의 `slot0.sqrtPriceX96`.
  sqrtPriceX96: bigint;
  fee: FeeTier;
  amountIn: bigint;
  amountOut: bigint;
};

/**
 * 받는 토큰 기준 가격 영향(bps).
 * `(slot0 가격으로 받을 양 − 예상 수령량) / slot0 가격으로 받을 양 × 10000 − fee / 100`이다(DoD-16).
 * slot0 가격으로 받을 양은 zeroForOne이면 `amountIn × sqrtPriceX96² / 2^192`, 아니면 `amountIn × 2^192 / sqrtPriceX96²`다.
 * 결과를 정수로 반올림하지 않고 음수도 그대로 둔다. `sqrtPriceX96`와 `amountIn`은 0보다 커야 한다.
 */
export function calculatePriceImpactBps({
  tokenIn,
  tokenOut,
  sqrtPriceX96,
  fee,
  amountIn,
  amountOut,
}: PriceImpactParams): number {
  if (sqrtPriceX96 <= 0n || amountIn <= 0n) {
    throw new RangeError("가격 영향은 sqrtPriceX96와 amountIn이 0보다 커야 계산할 수 있습니다.");
  }

  // slot0 가격으로 받을 양 = spotNumerator / spotDenominator
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const zeroForOne = isZeroForOne(tokenIn, tokenOut);
  const spotNumerator = zeroForOne ? amountIn * priceX192 : amountIn * Q192;
  const spotDenominator = zeroForOne ? Q192 : priceX192;

  // bps = (1_000_000 × (spotNumerator − amountOut × spotDenominator) − fee × spotNumerator) / (100 × spotNumerator)
  const numerator =
    1_000_000n * (spotNumerator - amountOut * spotDenominator) - BigInt(fee) * spotNumerator;
  const denominator = 100n * spotNumerator;

  return Number((numerator * PRICE_IMPACT_SCALE) / denominator) / Number(PRICE_IMPACT_SCALE);
}

// ─── 견적 결과 ─────────────────────────────────────────────────────

export type BuildSwapQuoteParams = {
  // WETH 치환 후 주소.
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  quotes: FeeTierQuoteResults;
  slot0: PoolSlot0Results;
};

export type SwapQuoteResult =
  | { status: "no-route"; quote: null }
  | { status: "success"; quote: SwapQuote };

/**
 * 티어별 견적과 slot0 결과로 견적을 만든다. 후보가 없으면 `no-route`다(EC-4).
 * 가격 영향은 고른 티어 풀의 slot0으로 계산한다(DoD-16).
 * 고른 티어의 slot0 읽기가 실패했으면 throw한다(견적 상태 `error`, EC-16).
 */
export function buildSwapQuote({
  tokenIn,
  tokenOut,
  amountIn,
  quotes,
  slot0,
}: BuildSwapQuoteParams): SwapQuoteResult {
  const selected = selectFeeTier({ tokenIn, tokenOut, quotes });
  if (selected === null) return { status: "no-route", quote: null };

  const selectedSlot0 = slot0[selected.fee];
  if (selectedSlot0.status !== "ok") {
    throw new Error(`고른 수수료 티어 ${selected.fee} 풀의 slot0을 읽지 못했습니다.`);
  }

  return {
    status: "success",
    quote: {
      amountOut: selected.amountOut,
      fee: selected.fee,
      priceImpactBps: calculatePriceImpactBps({
        tokenIn,
        tokenOut,
        sqrtPriceX96: selectedSlot0.sqrtPriceX96,
        fee: selected.fee,
        amountIn,
        amountOut: selected.amountOut,
      }),
    },
  };
}
