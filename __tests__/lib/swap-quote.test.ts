import type { Address } from "viem";

import { describe, expect, it } from "vitest";

import type { SupportedChainId } from "@/config/chains";
import type { FeeTier } from "@/config/uniswap-v3";

import { PINNED_TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import {
  buildSwapQuote,
  calculatePriceImpactBps,
  type FeeTierQuoteResult,
  type FeeTierQuoteResults,
  isEthWethPair,
  planSwapQuote,
  type PoolSlot0Results,
  resolveQuoteTokens,
  selectFeeTier,
} from "@/lib/swap-quote";

// 방향 표본 주소 쌍. 수치로는 TOKEN_LOW < TOKEN_HIGH이고, 체크섬 문자열 비교로는 반대다.
const TOKEN_LOW: Address = "0xa000000000000000000000000000000000000000";
const TOKEN_HIGH: Address = "0xB000000000000000000000000000000000000000";

// TickMath 상수에서 온 QuoterV2 방향별 한계값. 제품 config가 아니라 골격 태그의 리터럴이다.
const LIMIT_ZERO_FOR_ONE = 4295128740n;
const LIMIT_ONE_FOR_ZERO = 1461446703485210103287273052203988822378723970341n;

// 한계값이 아닌 견적 후 가격(유동성 소진 아님).
const NORMAL_SQRT_PRICE_AFTER = 1n << 96n;

// 체인별 WETH 주소 리터럴(Uniswap 배포 문서). 제품 config로 기대값을 만들지 않는다.
const SPEC_WETH: Record<SupportedChainId, Address> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

const CHAINS: readonly SupportedChainId[] = [1, 8453, 42161];

const FEES: readonly FeeTier[] = [100, 500, 3000, 10000];

// 표본 표기: bigint는 성공(수령량, 한계값이 아닌 견적 후 가격), "revert"는 revert, "exhausted"는 한계값에 닿은 성공.
type TierSample = bigint | "revert" | "exhausted";

function quotesOf(
  samples: readonly [TierSample, TierSample, TierSample, TierSample],
  exhaustedAfter: bigint = LIMIT_ZERO_FOR_ONE,
  exhaustedAmountOut: bigint = 1n,
): FeeTierQuoteResults {
  const toResult = (sample: TierSample): FeeTierQuoteResult => {
    if (sample === "revert") return { status: "revert" };
    if (sample === "exhausted") {
      return { status: "ok", amountOut: exhaustedAmountOut, sqrtPriceX96After: exhaustedAfter };
    }
    return { status: "ok", amountOut: sample, sqrtPriceX96After: NORMAL_SQRT_PRICE_AFTER };
  };
  return {
    100: toResult(samples[0]),
    500: toResult(samples[1]),
    3000: toResult(samples[2]),
    10000: toResult(samples[3]),
  };
}

function slot0Of(prices: readonly [bigint, bigint, bigint, bigint]): PoolSlot0Results {
  return {
    100: { status: "ok", sqrtPriceX96: prices[0] },
    500: { status: "ok", sqrtPriceX96: prices[1] },
    3000: { status: "ok", sqrtPriceX96: prices[2] },
    10000: { status: "ok", sqrtPriceX96: prices[3] },
  };
}

function pinnedOf(chainId: SupportedChainId, symbol: string): Token {
  const token = PINNED_TOKENS_BY_CHAIN[chainId].find((candidate) => candidate.symbol === symbol);
  if (!token) throw new Error(`체인 ${chainId}의 고정 토큰 ${symbol}가 없다`);
  return token;
}

function wethOf(chainId: SupportedChainId): Token {
  const weth = pinnedOf(chainId, "WETH");
  // 입력 전제: 고정 WETH가 그 체인의 WETH 주소다.
  expect(weth.address.toLowerCase(), `체인 ${chainId}의 WETH 전제`).toBe(
    SPEC_WETH[chainId].toLowerCase(),
  );
  return weth;
}

const sameAddress = (address: Address) => address.toLowerCase();

/**
 * 스펙 DoD-16 식을 zeroForOne 방향(slot0 가격으로 받을 양 = 보내는 양 × 가격)에서 그대로 계산한다.
 * `price`는 `(sqrtPriceX96 / 2^96)^2`로 정수인 표본만 쓴다.
 */
function specPriceImpactZeroForOne(
  price: number,
  fee: FeeTier,
  amountIn: number,
  amountOut: number,
): number {
  const spotOut = amountIn * price;
  return ((spotOut - amountOut) / spotOut) * 10000 - fee / 100;
}

// 정수가 아닌 bps를 0과 1을 구별할 만큼 좁게 비교한다(|차이| < 5e-7).
const BPS_DIGITS = 6;

// 이 파일은 티어 선택·제외, 견적할 토큰 주소(WETH 치환), ETH ↔ WETH 판정, 가격 영향 계산의 순수 규칙만 다룬다.
// RPC 요청 수·입력 반영 대기·상태 전이는 통합 테스트(T-6), 실제 포크 값은 포크 통합 테스트(T-7), 브라우저 흐름은 E2E(T-8)가 다룬다.
// 티어별 결과 표본의 수령량은 받는 토큰의 정수 수령량이며, 별도 표기가 없으면 견적이 성공하고 `sqrtPriceX96After`가 방향별 한계값이 아닌 결과다.
// 두 스왑 방향은 Uniswap V3 규칙대로 보내는 토큰이 token0(주소를 수치로 비교해 더 작음)이면 zeroForOne 참, token1이면 거짓이다.
// 방향 표본은 주소 쌍 `0xa000000000000000000000000000000000000000`(수치로 작음, token0)과 `0xB000000000000000000000000000000000000000`(수치로 큼, token1)으로 준다.
// 두 주소는 체크섬 표기이며, 체크섬 문자열을 그대로 비교하면(`"0xB…" < "0xa…"`) 수치 순서와 반대가 된다.
describe("견적 — 수수료 티어 중 수령량이 가장 많은 직접 풀로 견적한다", () => {
  describe("티어 선택", () => {
    /**
     * @spec DoD-2
     * @given 네 티어가 모두 후보인 (100, 500, 3000, 10000) 수령량 표본 (`10`, `30`, `20`, `5`), (`1`, `2`, `3`, `4`), (`9`, `1`, `1`, `1`), (`2`, `4`, `8`, `6`)처럼 수령량이 가장 많은 티어가 표본마다 다른 경우를 하나씩 반복한다
     * @when 티어별 결과로 견적을 고른다
     * @then 고른 티어는 표본 순서대로 `500`, `10000`, `100`, `3000`이다
     * @then 견적의 수령량과 fee는 고른 티어의 수령량과 티어 값이다
     */
    it("[DoD-2] 후보 티어 중 수령량이 가장 많은 티어를 고른다", () => {
      const samples = [
        [[10n, 30n, 20n, 5n], 500, 30n],
        [[1n, 2n, 3n, 4n], 10000, 4n],
        [[9n, 1n, 1n, 1n], 100, 9n],
        [[2n, 4n, 8n, 6n], 3000, 8n],
      ] as const;

      for (const [amounts, expectedFee, expectedAmountOut] of samples) {
        const label = `수령량 ${amounts.join(", ")}`;
        const selected = selectFeeTier({
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf(amounts),
        });
        expect(selected, label).toEqual({ fee: expectedFee, amountOut: expectedAmountOut });
      }
    });

    /**
     * @spec DoD-3
     * @given 네 티어가 모두 후보인 (100, 500, 3000, 10000) 수령량 표본 (`7`, `7`, `5`, `7`), (`5`, `9`, `9`, `9`), (`1`, `1`, `8`, `8`), (`4`, `4`, `4`, `4`)처럼 가장 많은 수령량이 여러 티어에서 같은 경우를 하나씩 반복한다
     * @when 티어별 결과로 견적을 고른다
     * @then 고른 티어는 표본 순서대로 `100`, `500`, `3000`, `100`이다
     * @then 견적의 수령량은 같은 최대 수령량이다
     */
    it("[DoD-3] 수령량이 같은 후보가 여럿이면 수수료가 가장 낮은 티어를 고른다", () => {
      const samples = [
        [[7n, 7n, 5n, 7n], 100, 7n],
        [[5n, 9n, 9n, 9n], 500, 9n],
        [[1n, 1n, 8n, 8n], 3000, 8n],
        [[4n, 4n, 4n, 4n], 100, 4n],
      ] as const;

      for (const [amounts, expectedFee, expectedAmountOut] of samples) {
        const label = `수령량 ${amounts.join(", ")}`;
        const selected = selectFeeTier({
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf(amounts),
        });
        expect(selected, label).toEqual({ fee: expectedFee, amountOut: expectedAmountOut });
      }
    });
  });

  describe("후보에서 빼는 티어", () => {
    /**
     * @spec EC-1
     * @given (100, 500, 3000, 10000) 결과 표본 (revert, `3`, `7`, revert), (revert, `6`, `6`, `2`), (`5`, revert, revert, revert)처럼 풀이 없어 revert한 티어가 섞인 경우를 하나씩 반복한다
     * @when 티어별 결과로 견적을 고른다
     * @then 고른 티어는 표본 순서대로 `3000`, `500`, `100`이다
     * @then revert한 티어는 고르지 않는다
     */
    it("[EC-1] 풀이 없어 revert한 티어는 후보에서 빼고 남은 후보에서 고른다", () => {
      const samples = [
        [["revert", 3n, 7n, "revert"], 3000],
        [["revert", 6n, 6n, 2n], 500],
        [[5n, "revert", "revert", "revert"], 100],
      ] as const;

      for (const [results, expectedFee] of samples) {
        const label = `결과 ${results.join(", ")}`;
        const selected = selectFeeTier({
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf(results),
        });
        expect(selected?.fee, label).toBe(expectedFee);

        const revertedFees = FEES.filter((_, index) => results[index] === "revert");
        expect(revertedFees, label).not.toContain(selected?.fee);
      }
    });

    /**
     * @spec EC-3
     * @given 두 방향 표본을 하나씩 반복한다. 보내는 토큰 `0xa000000000000000000000000000000000000000` → 받는 토큰 `0xB000000000000000000000000000000000000000`(zeroForOne 참)에서 (100, 500, 3000, 10000) 수령량 (`1`, `5`, `9`, revert)이고 3000 티어의 `sqrtPriceX96After`가 하한 한계값(TickMath `MIN_SQRT_RATIO + 1` = `4295128740`)인 경우, 보내는 토큰 `0xB000000000000000000000000000000000000000` → 받는 토큰 `0xa000000000000000000000000000000000000000`(zeroForOne 거짓)에서 수령량 (`3`, revert, `2`, `9`)이고 10000 티어의 `sqrtPriceX96After`가 상한 한계값(TickMath `MAX_SQRT_RATIO - 1` = `1461446703485210103287273052203988822378723970341`)인 경우
     * @when 티어별 결과로 견적을 고른다
     * @then 고른 티어는 표본 순서대로 `500`, `100`이다
     * @then 수령량이 가장 많아도 유동성을 모두 써서 입력을 소화하지 못한 티어는 고르지 않는다
     */
    it("[EC-3] 유동성을 모두 써도 입력을 소화하지 못한 티어는 두 방향 모두 후보에서 뺀다", () => {
      const samples = [
        {
          label: "0xa… → 0xB…(zeroForOne 참), 3000 티어 하한 한계값",
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: {
            ...quotesOf([1n, 5n, 9n, "revert"]),
            3000: { status: "ok", amountOut: 9n, sqrtPriceX96After: LIMIT_ZERO_FOR_ONE },
          } satisfies FeeTierQuoteResults,
          exhaustedFee: 3000,
          expectedFee: 500,
          expectedAmountOut: 5n,
        },
        {
          label: "0xB… → 0xa…(zeroForOne 거짓), 10000 티어 상한 한계값",
          tokenIn: TOKEN_HIGH,
          tokenOut: TOKEN_LOW,
          quotes: {
            ...quotesOf([3n, "revert", 2n, 9n]),
            10000: { status: "ok", amountOut: 9n, sqrtPriceX96After: LIMIT_ONE_FOR_ZERO },
          } satisfies FeeTierQuoteResults,
          exhaustedFee: 10000,
          expectedFee: 100,
          expectedAmountOut: 3n,
        },
      ] as const;

      for (const sample of samples) {
        const selected = selectFeeTier({
          tokenIn: sample.tokenIn,
          tokenOut: sample.tokenOut,
          quotes: sample.quotes,
        });
        expect(selected, sample.label).toEqual({
          fee: sample.expectedFee,
          amountOut: sample.expectedAmountOut,
        });
        expect(selected?.fee, sample.label).not.toBe(sample.exhaustedFee);
      }
    });

    /**
     * @spec EC-4 EC-1 EC-2 EC-3
     * @given (100, 500, 3000, 10000) 결과 표본 (revert, revert, revert, revert), (`0`, `0`, `0`, `0`), (`0`, revert, revert, revert), (revert, revert, `0`, revert), 네 티어 모두 유동성 소진(`0xa000000000000000000000000000000000000000` → `0xB000000000000000000000000000000000000000` 방향 하한 한계값, 반대 방향 상한 한계값 각각), (revert, `0`, 유동성 소진, `0`)처럼 남은 후보가 없는 경우를 하나씩 반복한다
     * @when 티어별 결과로 견적을 고른다
     * @then 결과는 `no-route`다
     * @then 고른 티어와 견적 값이 없다
     * @then 수령량이 0인 티어만 남은 표본에서도 그 티어를 고르지 않는다
     */
    it("[EC-4][EC-1][EC-2][EC-3] 남은 후보가 없으면 no-route다", () => {
      const samples: readonly {
        label: string;
        tokenIn: Address;
        tokenOut: Address;
        quotes: FeeTierQuoteResults;
      }[] = [
        {
          label: "모두 revert",
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf(["revert", "revert", "revert", "revert"]),
        },
        {
          label: "모두 수령량 0",
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf([0n, 0n, 0n, 0n]),
        },
        {
          label: "100 티어만 수령량 0, 나머지 revert",
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf([0n, "revert", "revert", "revert"]),
        },
        {
          label: "3000 티어만 수령량 0, 나머지 revert",
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf(["revert", "revert", 0n, "revert"]),
        },
        {
          label: "0xa… → 0xB… 모두 하한 한계값",
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf(
            ["exhausted", "exhausted", "exhausted", "exhausted"],
            LIMIT_ZERO_FOR_ONE,
            5n,
          ),
        },
        {
          label: "0xB… → 0xa… 모두 상한 한계값",
          tokenIn: TOKEN_HIGH,
          tokenOut: TOKEN_LOW,
          quotes: quotesOf(
            ["exhausted", "exhausted", "exhausted", "exhausted"],
            LIMIT_ONE_FOR_ZERO,
            5n,
          ),
        },
        {
          label: "revert·0·유동성 소진·0",
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          quotes: quotesOf(["revert", 0n, "exhausted", 0n], LIMIT_ZERO_FOR_ONE, 5n),
        },
      ];

      for (const sample of samples) {
        expect(selectFeeTier(sample), sample.label).toBeNull();

        const result = buildSwapQuote({
          ...sample,
          amountIn: 1000000n,
          slot0: slot0Of([1n << 96n, 1n << 96n, 1n << 96n, 1n << 96n]),
        });
        expect(result.status, sample.label).toBe("no-route");
        expect(result.quote, sample.label).toBeNull();
      }
    });
  });

  describe("견적할 토큰 주소", () => {
    /**
     * @spec DoD-4
     * @given (선택 체인, 보내는 토큰, 받는 토큰) 표본 Ethereum(1)·Base(8453)·Arbitrum(42161) 각각에서 ETH→USDC와 USDC→ETH를 하나씩 반복한다
     * @when 견적할 두 토큰 주소를 정한다
     * @then ETH 쪽 주소는 선택 체인의 WETH 주소다
     * @then ETH가 아닌 쪽 주소는 선택한 토큰 주소 그대로다
     */
    it("[DoD-4] ETH 쪽을 선택 체인의 WETH 주소로 바꿔 견적한다", () => {
      for (const chainId of CHAINS) {
        const eth = pinnedOf(chainId, "ETH");
        const usdc = pinnedOf(chainId, "USDC");

        const ethToUsdc = resolveQuoteTokens({ chainId, tokenIn: eth, tokenOut: usdc });
        expect(sameAddress(ethToUsdc.tokenIn), `체인 ${chainId} ETH→USDC 보내는 쪽`).toBe(
          sameAddress(SPEC_WETH[chainId]),
        );
        expect(ethToUsdc.tokenOut, `체인 ${chainId} ETH→USDC 받는 쪽`).toBe(usdc.address);

        const usdcToEth = resolveQuoteTokens({ chainId, tokenIn: usdc, tokenOut: eth });
        expect(usdcToEth.tokenIn, `체인 ${chainId} USDC→ETH 보내는 쪽`).toBe(usdc.address);
        expect(sameAddress(usdcToEth.tokenOut), `체인 ${chainId} USDC→ETH 받는 쪽`).toBe(
          sameAddress(SPEC_WETH[chainId]),
        );
      }
    });
  });

  describe("ETH ↔ WETH", () => {
    /**
     * @spec EC-6
     * @given (선택 체인, 보내는 토큰, 받는 토큰) 표본 Ethereum(1)·Base(8453)·Arbitrum(42161) 각각에서 ETH→WETH와 WETH→ETH(그 체인의 WETH)를 하나씩 반복한다
     * @when 두 토큰이 ETH와 WETH인지 판정한다
     * @then 판정은 ETH ↔ WETH이며, 티어별 결과 없이 견적 상태가 `no-route`로 정해진다
     */
    it("[EC-6] 두 토큰이 ETH와 WETH이면 두 순서와 세 체인 모두 견적 없이 no-route다", () => {
      for (const chainId of CHAINS) {
        const eth = pinnedOf(chainId, "ETH");
        const weth = wethOf(chainId);

        for (const [tokenIn, tokenOut] of [
          [eth, weth],
          [weth, eth],
        ] as const) {
          const label = `체인 ${chainId} ${tokenIn.symbol}→${tokenOut.symbol}`;
          expect(isEthWethPair({ chainId, tokenIn, tokenOut }), label).toBe(true);
          expect(
            planSwapQuote({ chainId, tokenIn, tokenOut, amountInRaw: 1000000000000000000n }),
            label,
          ).toEqual({ status: "no-route" });
        }
      }
    });

    /**
     * @spec EC-6
     * @given (선택 체인, 보내는 토큰, 받는 토큰) 표본 Ethereum(1)·Base(8453)·Arbitrum(42161) 각각에서 ETH→USDC, USDC→ETH, WETH→USDC, USDC→WETH를 하나씩 반복한다
     * @when 두 토큰이 ETH와 WETH인지 판정한다
     * @then 판정은 ETH ↔ WETH가 아니다
     */
    it("[EC-6] 한쪽만 ETH나 WETH인 페어는 ETH ↔ WETH로 판정하지 않는다", () => {
      for (const chainId of CHAINS) {
        const eth = pinnedOf(chainId, "ETH");
        const weth = wethOf(chainId);
        const usdc = pinnedOf(chainId, "USDC");

        for (const [tokenIn, tokenOut] of [
          [eth, usdc],
          [usdc, eth],
          [weth, usdc],
          [usdc, weth],
        ] as const) {
          const label = `체인 ${chainId} ${tokenIn.symbol}→${tokenOut.symbol}`;
          expect(isEthWethPair({ chainId, tokenIn, tokenOut }), label).toBe(false);
        }
      }
    });
  });

  describe("가격 영향 계산", () => {
    /**
     * @spec DoD-16
     * @given (보내는 토큰, 받는 토큰, `sqrtPriceX96`, fee, 보내는 정수량, 예상 수령량) 표본을 하나씩 반복한다. 보내는 토큰 `0xa000000000000000000000000000000000000000` → 받는 토큰 `0xB000000000000000000000000000000000000000`(zeroForOne 참)이고 `sqrtPriceX96 = 2^97`(slot0 가격으로 받을 양 = 보내는 양 × 4): (3000, `1000000`, `3980000`), (3000, `1000000`, `3987654`), (3000, `1000000`, `3990000`). 보내는 토큰 `0xB000000000000000000000000000000000000000` → 받는 토큰 `0xa000000000000000000000000000000000000000`(zeroForOne 거짓)이고 `sqrtPriceX96 = 2^97`(slot0 가격으로 받을 양 = 보내는 양 ÷ 4): (500, `4000000`, `990000`), (500, `4000000`, `998765`), (500, `4000000`, `999900`)
     * @when 가격 영향을 계산한다
     * @then 결과 bps는 `(slot0 가격으로 받을 양 − 예상 수령량) / slot0 가격으로 받을 양 × 10000 − fee / 100`으로 표본 순서대로 `20`, `0.865`, `-5`, `95`, `7.35`, `-4`이다
     * @then 정수가 아닌 결과를 정수로 반올림하거나 버리지 않는다
     * @then 음수 결과를 0으로 올리지 않고 음수 그대로 둔다
     */
    it("[DoD-16] 가격 영향은 받는 토큰 기준 slot0 수령량 대비 부족분 bps에서 fee를 뺀 값이다", () => {
      const sqrtPriceX96 = 1n << 97n;
      const samples = [
        [TOKEN_LOW, TOKEN_HIGH, 3000, 1000000n, 3980000n, 20],
        [TOKEN_LOW, TOKEN_HIGH, 3000, 1000000n, 3987654n, 0.865],
        [TOKEN_LOW, TOKEN_HIGH, 3000, 1000000n, 3990000n, -5],
        [TOKEN_HIGH, TOKEN_LOW, 500, 4000000n, 990000n, 95],
        [TOKEN_HIGH, TOKEN_LOW, 500, 4000000n, 998765n, 7.35],
        [TOKEN_HIGH, TOKEN_LOW, 500, 4000000n, 999900n, -4],
      ] as const;

      for (const [tokenIn, tokenOut, fee, amountIn, amountOut, expected] of samples) {
        const label = `${tokenIn.slice(0, 3)}→${tokenOut.slice(0, 3)} fee ${fee} 보냄 ${amountIn} 받음 ${amountOut}`;
        const result = calculatePriceImpactBps({
          tokenIn,
          tokenOut,
          sqrtPriceX96,
          fee,
          amountIn,
          amountOut,
        });

        expect(result, label).toBeCloseTo(expected, BPS_DIGITS);
        if (!Number.isInteger(expected)) {
          // 정수로 반올림하거나 버리지 않았다.
          expect(Number.isInteger(result), label).toBe(false);
        }
        if (expected < 0) {
          // 0으로 올리지 않았다.
          expect(result, label).toBeLessThan(0);
        }
      }
    });

    /**
     * @spec DoD-16
     * @given 보내는 토큰 `0xa000000000000000000000000000000000000000` → 받는 토큰 `0xB000000000000000000000000000000000000000`(zeroForOne 참), 보내는 정수량 `1000000`, 네 티어가 모두 후보이고 (100, 500, 3000, 10000) 풀의 `slot0` `sqrtPriceX96`가 (`2^96`, `2^97`, `2^98`, `3 × 2^96`)으로 티어마다 다르다. 수령량 표본 (`900000`, `3990000`, `3000000`, `2000000`)(고른 티어 500), (`900000`, `3000000`, `15900000`, `8000000`)(고른 티어 3000)을 하나씩 반복한다
     * @when 티어별 결과로 견적을 고르고 가격 영향을 계산한다
     * @then 가격 영향은 고른 티어 풀의 `slot0`과 그 티어의 fee·수령량으로 계산한 값으로 표본 순서대로 `20`, `32.5` bps다
     * @then 고르지 않은 티어(첫 티어 100, 마지막 티어 10000 포함) 풀의 `slot0`으로 계산한 값과 다르다
     */
    it("[DoD-16] 가격 영향은 고른 티어 풀의 slot0으로 계산한다", () => {
      const q96 = 1n << 96n;
      const slot0 = slot0Of([q96, 1n << 97n, 1n << 98n, 3n * q96]);
      // 각 티어 slot0의 가격 (sqrtPriceX96 / 2^96)^2.
      const pricesByFee: Record<FeeTier, number> = { 100: 1, 500: 4, 3000: 16, 10000: 9 };
      const amountIn = 1000000n;
      const samples = [
        [[900000n, 3990000n, 3000000n, 2000000n], 500, 3990000n, 20],
        [[900000n, 3000000n, 15900000n, 8000000n], 3000, 15900000n, 32.5],
      ] as const;

      for (const [amounts, expectedFee, expectedAmountOut, expectedBps] of samples) {
        const label = `수령량 ${amounts.join(", ")}`;
        const result = buildSwapQuote({
          tokenIn: TOKEN_LOW,
          tokenOut: TOKEN_HIGH,
          amountIn,
          quotes: quotesOf(amounts),
          slot0,
        });

        expect(result.status, label).toBe("success");
        expect(result.quote?.fee, label).toBe(expectedFee);
        expect(result.quote?.amountOut, label).toBe(expectedAmountOut);
        const priceImpactBps = result.quote?.priceImpactBps ?? Number.NaN;
        expect(priceImpactBps, label).toBeCloseTo(expectedBps, BPS_DIGITS);

        for (const otherFee of FEES.filter((fee) => fee !== expectedFee)) {
          const otherBps = specPriceImpactZeroForOne(
            pricesByFee[otherFee],
            expectedFee,
            Number(amountIn),
            Number(expectedAmountOut),
          );
          expect(
            Math.abs(priceImpactBps - otherBps),
            `${label}: ${otherFee} 티어 slot0으로 계산한 ${otherBps}`,
          ).toBeGreaterThan(1);
        }
      }
    });
  });
});
