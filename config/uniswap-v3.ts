import type { Hex } from "viem";

// 견적에 쓰는 Uniswap V3 수수료 티어(100분의 1 bps 단위). 낮은 수수료 순이다.
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

export type FeeTier = (typeof FEE_TIERS)[number];

// UniswapV3Pool 생성 코드의 keccak256. 풀 주소는 팩토리 주소와 이 값으로 CREATE2 계산한다.
// 출처: Uniswap v3-periphery `PoolAddress.POOL_INIT_CODE_HASH`
// https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/PoolAddress.sol
export const POOL_INIT_CODE_HASH: Hex =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

// TickMath의 sqrt 가격 범위. 출처: Uniswap v3-core `TickMath.MIN_SQRT_RATIO`·`MAX_SQRT_RATIO`
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// `sqrtPriceLimitX96`를 0으로 견적할 때 QuoterV2가 쓰는 방향별 한계값.
// 견적 결과의 `sqrtPriceX96After`가 이 값과 같으면 풀의 유동성을 모두 쓴 것이다.
export const SQRT_PRICE_LIMIT_ZERO_FOR_ONE = MIN_SQRT_RATIO + 1n;
export const SQRT_PRICE_LIMIT_ONE_FOR_ZERO = MAX_SQRT_RATIO - 1n;

// QuoterV2 `quoteExactInputSingle`. 출처: Uniswap v3-periphery `IQuoterV2`
export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct IQuoterV2.QuoteExactInputSingleParams",
        components: [
          { name: "tokenIn", type: "address", internalType: "address" },
          { name: "tokenOut", type: "address", internalType: "address" },
          { name: "amountIn", type: "uint256", internalType: "uint256" },
          { name: "fee", type: "uint24", internalType: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160", internalType: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256", internalType: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160", internalType: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32", internalType: "uint32" },
      { name: "gasEstimate", type: "uint256", internalType: "uint256" },
    ],
  },
] as const;

// UniswapV3Pool `slot0`. 출처: Uniswap v3-core `IUniswapV3PoolState`
export const uniswapV3PoolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160", internalType: "uint160" },
      { name: "tick", type: "int24", internalType: "int24" },
      { name: "observationIndex", type: "uint16", internalType: "uint16" },
      { name: "observationCardinality", type: "uint16", internalType: "uint16" },
      { name: "observationCardinalityNext", type: "uint16", internalType: "uint16" },
      { name: "feeProtocol", type: "uint8", internalType: "uint8" },
      { name: "unlocked", type: "bool", internalType: "bool" },
    ],
  },
] as const;
