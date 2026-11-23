import { type Address, ContractFunctionExecutionError, type EIP1193RequestOptions } from "viem";
import { multicall } from "viem/actions";

import type { SupportedChainId } from "@/config/chains";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { TOKENS_BY_CHAIN, USDC_BY_CHAIN } from "@/config/tokens";
import { FEE_TIERS, type FeeTier, quoterV2Abi, uniswapV3PoolAbi } from "@/config/uniswap-v3";
import {
  type FeeTierQuoteResult,
  type PoolSlot0Result,
  getPoolAddress,
  getQuoteTokenAddress,
} from "@/lib/swap-quote";
import { type TokenBalanceClient, withoutMulticallBatching } from "@/lib/token-balances";
import {
  type PairPriceInput,
  USDC_USD_PRICE,
  type UsdPrice,
  isChainUsdc,
  selectPairSpotPrice,
  selectWethRoutedPrice,
} from "@/lib/token-usd-price";

// 단가 aggregate3 하나에 담는 대상 토큰 수의 상한(F9 EC-19). 2차 요청의 (WETH, USDC) 구간 쌍은 세지 않는다.
// T-1 실측: 최악 묶음 가스가 업체 RPC `eth_call` 상한(Ethereum·Base 550M, Arbitrum 1.1B) 안이고
// 본문·지연·분당 요청 수 한도도 지키는 값이다(사용자 결정 2026-11-22). 가스 상한이 더 낮은 공개 RPC에서
// 묶음이 실패하면 그 묶음의 조회 실패로 처리한다(EC-20).
export const TOKEN_USD_PRICE_BATCH_SIZE = 11;

// multicall의 묶음 크기. 0이면 viem이 호출을 나누지 않아 묶음 하나가 aggregate3 1회가 된다.
const USD_PRICE_MULTICALL_BATCH_SIZE = 0;

// WETH 1개(10^18). WETH→USDC 구간의 견적 금액이다.
const ONE_WETH = 10n ** 18n;

// `sqrtPriceLimitX96` 0은 QuoterV2가 방향별 한계값(TickMath MIN+1·MAX−1)을 쓰게 한다.
const NO_SQRT_PRICE_LIMIT = 0n;

// 단가 요청 1회는 HTTP 요청 1건이다. viem http transport는 기본으로 429·5xx·네트워크 오류를 최대 3회 다시 보내므로
// 요청마다 `retryCount: 0`을 강제한 사본을 쓴다(F9 EC-10, EC-23). multicall 묶음 설정도 끈다.
// 사본의 `request`가 쓰이려면 클라이언트에 `readContract`·`call` 확장이 없어야 한다(wagmi `getClient()` 클라이언트는 없다).
export function withoutRetry(client: TokenBalanceClient): TokenBalanceClient {
  const unbatched = withoutMulticallBatching(client);
  const baseRequest = unbatched.request;
  // `request`는 RPC 스키마별 제네릭 함수라 인자를 그대로 넘기는 래퍼의 타입을 좁히지 못한다.
  const request = ((args: Parameters<typeof baseRequest>[0], options?: EIP1193RequestOptions) =>
    baseRequest(args as never, { ...options, retryCount: 0 })) as typeof baseRequest;
  return { ...unbatched, request };
}

// multicall 결과의 실패가 하위 호출 하나의 실패(revert, 코드 없는 주소의 빈 반환값)인지 구분한다.
// 요청 자체(aggregate3 `eth_call`)가 실패하면 viem은 모든 결과에 aggregate3 호출 오류를 넣는다.
function isSubcallFailure(
  error: unknown,
  functionName: "slot0" | "quoteExactInputSingle",
): boolean {
  return error instanceof ContractFunctionExecutionError && error.functionName === functionName;
}

// 단가를 구할 쌍 하나. `token` 1개(10^decimals)를 `quoteToken`으로 견적한다. 주소는 WETH 치환 후다.
type PricePair = { token: Address; quoteToken: Address; amountIn: bigint };

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * 쌍 여러 개의 네 티어 견적과 네 티어 풀 `slot0`을 `allowFailure: true` aggregate3 `eth_call` 1회로 읽는다.
 * 쌍마다 `quoteExactInputSingle` 4건을 앞에, `slot0` 4건을 뒤에 둔다(첫 하위 호출이 QuoterV2 호출이다).
 * 하위 호출 실패는 그 티어의 revert로 보고, 요청 자체가 실패하면 throw한다.
 */
async function readPricePairs(
  client: TokenBalanceClient,
  chainId: SupportedChainId,
  pairs: readonly PricePair[],
): Promise<PairPriceInput[]> {
  const { quoterV2 } = CONTRACTS_BY_CHAIN[chainId];

  const contracts = pairs.flatMap(({ token, quoteToken, amountIn }) => [
    ...FEE_TIERS.map((fee) => ({
      address: quoterV2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle" as const,
      args: [
        {
          tokenIn: token,
          tokenOut: quoteToken,
          amountIn,
          fee,
          sqrtPriceLimitX96: NO_SQRT_PRICE_LIMIT,
        },
      ] as const,
    })),
    ...FEE_TIERS.map((fee) => ({
      address: getPoolAddress({ chainId, tokenA: token, tokenB: quoteToken, fee }),
      abi: uniswapV3PoolAbi,
      functionName: "slot0" as const,
    })),
  ]);

  const results = await multicall(client, {
    contracts,
    allowFailure: true,
    batchSize: USD_PRICE_MULTICALL_BATCH_SIZE,
  });

  const callsPerPair = FEE_TIERS.length * 2;

  return pairs.map(({ token, quoteToken }, pairIndex) => {
    const offset = pairIndex * callsPerPair;
    const quotes = {} as Record<FeeTier, FeeTierQuoteResult>;
    const slot0 = {} as Record<FeeTier, PoolSlot0Result>;

    FEE_TIERS.forEach((fee, tierIndex) => {
      const quoteResult = results[offset + tierIndex];
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

      const slot0Result = results[offset + FEE_TIERS.length + tierIndex];
      if (slot0Result.status === "success") {
        const [sqrtPriceX96] = slot0Result.result as readonly [bigint, ...unknown[]];
        slot0[fee] = { status: "ok", sqrtPriceX96 };
      } else if (isSubcallFailure(slot0Result.error, "slot0")) {
        slot0[fee] = { status: "revert" };
      } else {
        throw slot0Result.error;
      }
    });

    return { token, quoteToken, quotes, slot0 };
  });
}

export type ReadTokenUsdPricesInput = {
  chainId: SupportedChainId;
  tokens: Address[];
};

// 조회할 토큰 하나. `token`은 WETH 치환 후 주소, `decimals`는 토큰 목록의 값이다.
type PriceTarget = { token: Address; decimals: number };

function lowercase(address: Address): Address {
  return address.toLowerCase() as Address;
}

/**
 * 선택 체인 토큰들의 USD 단가를 읽는다(F9 스펙 §4.2).
 * - 맵 키는 넘겨받은 주소를 소문자로 바꾼 값이다. 값 `null`은 가격 없음(경로 없음·토큰 목록 밖 주소, EC-16·26·27)이다.
 * - `NATIVE_ETH_ADDRESS`는 같은 체인 WETH로 바꿔 읽고(DoD-4), 바꾼 주소가 같은 토큰은 한 번만 읽는다.
 * - 체인 네이티브 USDC는 요청 없이 정확히 $1이다(DoD-3). 브리지 USDC는 일반 경로를 탄다(EC-14).
 * - 1차로 토큰 1개(10^decimals)를 USDC로 견적하는 aggregate3를 보내고(DoD-1), 직접 경로가 없는 토큰만
 *   2차로 "토큰→WETH + WETH→USDC" aggregate3를 보낸다(DoD-2, DoD-31). 요청마다 대상 토큰은
 *   `TOKEN_USD_PRICE_BATCH_SIZE` 이하다(EC-19).
 * - 요청 실패(429 포함, 재시도 없음)와 고른 티어의 `slot0` 실패는 throw한다(EC-10, EC-15, EC-17, EC-23).
 */
export async function readTokenUsdPrices(
  client: TokenBalanceClient,
  { chainId, tokens }: ReadTokenUsdPricesInput,
): Promise<Map<Address, UsdPrice | null>> {
  const usdc = USDC_BY_CHAIN[chainId];
  const weth = CONTRACTS_BY_CHAIN[chainId].weth;
  const decimalsByAddress = new Map(
    TOKENS_BY_CHAIN[chainId].map((token) => [lowercase(token.address), token.decimals]),
  );

  // 넘겨받은 소문자 주소 → 읽을 주소(WETH 치환 후 소문자). 목록 밖 주소는 `null`이다.
  const resolvedByInput = new Map<Address, Address | null>();
  // 읽을 주소(소문자) → 단가. 요청 없이 정해지는 USDC와 목록 밖 결과를 먼저 둔다.
  const priceByResolved = new Map<Address, UsdPrice | null>();
  const targets = new Map<Address, PriceTarget>();

  for (const input of tokens) {
    const inputKey = lowercase(input);
    if (resolvedByInput.has(inputKey)) continue;

    const decimals = decimalsByAddress.get(inputKey);
    if (decimals === undefined) {
      resolvedByInput.set(inputKey, null);
      continue;
    }

    const resolved = getQuoteTokenAddress(chainId, { address: input });
    const resolvedKey = lowercase(resolved);
    resolvedByInput.set(inputKey, resolvedKey);

    if (isChainUsdc(chainId, resolved)) {
      priceByResolved.set(resolvedKey, USDC_USD_PRICE);
    } else if (!targets.has(resolvedKey)) {
      targets.set(resolvedKey, { token: resolved, decimals });
    }
  }

  const priceClient = withoutRetry(client);

  // 1차: 토큰 → USDC 직접 경로.
  const directChunks = chunk([...targets.values()], TOKEN_USD_PRICE_BATCH_SIZE);
  const directResults = await Promise.all(
    directChunks.map((targetChunk) =>
      readPricePairs(
        priceClient,
        chainId,
        targetChunk.map(({ token, decimals }) => ({
          token,
          quoteToken: usdc,
          amountIn: 10n ** BigInt(decimals),
        })),
      ),
    ),
  );

  const routedTargets: PriceTarget[] = [];
  directChunks.forEach((targetChunk, chunkIndex) => {
    targetChunk.forEach((target, index) => {
      const price = selectPairSpotPrice(directResults[chunkIndex][index]);
      if (price !== null) {
        priceByResolved.set(lowercase(target.token), price);
      } else if (lowercase(target.token) === lowercase(weth)) {
        // WETH 자체는 WETH 경유 경로가 없다.
        priceByResolved.set(lowercase(target.token), null);
      } else {
        routedTargets.push(target);
      }
    });
  });

  // 2차: 직접 경로가 없는 토큰만 토큰 → WETH, 그리고 묶음마다 WETH → USDC 구간 쌍 하나.
  const routedChunks = chunk(routedTargets, TOKEN_USD_PRICE_BATCH_SIZE);
  const routedResults = await Promise.all(
    routedChunks.map((targetChunk) =>
      readPricePairs(priceClient, chainId, [
        ...targetChunk.map(({ token, decimals }) => ({
          token,
          quoteToken: weth,
          amountIn: 10n ** BigInt(decimals),
        })),
        { token: weth, quoteToken: usdc, amountIn: ONE_WETH },
      ]),
    ),
  );

  routedChunks.forEach((targetChunk, chunkIndex) => {
    const pairs = routedResults[chunkIndex];
    const wethToUsdc = pairs[targetChunk.length];
    targetChunk.forEach((target, index) => {
      priceByResolved.set(
        lowercase(target.token),
        selectWethRoutedPrice({ tokenToWeth: pairs[index], wethToUsdc }),
      );
    });
  });

  const prices = new Map<Address, UsdPrice | null>();
  for (const [inputKey, resolvedKey] of resolvedByInput) {
    prices.set(inputKey, resolvedKey === null ? null : (priceByResolved.get(resolvedKey) ?? null));
  }
  return prices;
}
