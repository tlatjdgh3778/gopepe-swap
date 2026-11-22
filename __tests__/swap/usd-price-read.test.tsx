import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { type Address, getAddress } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";

import type { SupportedChainId } from "@/config/chains";
import { type WagmiConfig, createWagmiConfig } from "@/config/wagmi";
import { useTokenUsdPrice } from "@/hooks/use-token-usd-price";
import { readTokenUsdPrices } from "@/lib/read-token-usd-price";
import type { TokenUsdPriceState } from "@/lib/token-usd-price";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceRpcStub,
  type QuoteQuery,
  type QuoteTierResponse,
  type RequestMatcher,
  type StubFeeTier,
  type StubPrice,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  STUB_FEE_TIERS,
  STUB_Q96,
  bestStubQuote,
  defaultSlot0SqrtPriceX96,
  defaultUsdPriceRule,
  expectedStubUsdPrice,
  installBalanceRpcStub,
  match,
  matchQuote,
  matchUsdPrice,
  sameAddress,
  stubExhaustedSqrtPriceX96After,
  stubMultiplyPrices,
  stubPairPrice,
  stubPricesEqual,
  stubRevertQuote,
  stubSelectFeeTier,
  stubSpotPrice,
  usdPriceRuleWith,
} from "../support/rpc-balance-stub";
import {
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  waitUntil,
} from "../support/wagmi-harness";

// 골격(T-8). 체인·토큰별 USD 단가가 USDC 직접 경로 또는 WETH 경유 경로의 Uniswap V3 현물가로 정해지는지,
// USDC·ETH·브리지 USDC·목록 밖 주소의 단가, 경로 없음·조회 실패 상태, 단가 요청과 견적 요청의 구분을 확인한다.
// 판정은 스펙 §4.1(TokenUsdPriceState), §4.2(useTokenUsdPrice 반환값, readTokenUsdPrices 결과 맵)와 스텁이 받은 요청(JSON-RPC 항목 단위 집계·디코드)으로 한다.
// mock 경계(사용자 확정 2026-11-22): F3 통합 경계(실제 wagmi·Provider·화면, wagmi mock 커넥터,
// 전역 fetch의 URL 라우팅 스텁, vi.mock 금지)에 단가 aggregate3 스텁 분류·응답과 HTTP 429 응답을 더한 것. 그 밖의 provider·훅·컴포넌트는 실제 코드를 쓴다.
// 이 경계는 실제 풀 가격과 실제 RPC 오류 형태를 증명하지 못한다(실제 풀 가격은 T-12 포크 테스트가 본다).
// 데이터 격리: 테스트(표본)마다 config·RPC 스텁·QueryClient를 새로 만들고 쿠키를 지운다(clearCookies).
// 기대 주소(ETH, 체인별 WETH·네이티브 USDC·브리지 USDC, QuoterV2, 풀 주소)는 제품 config를 쓰지 않고 테스트 리터럴과 테스트 쪽 CREATE2 계산으로 적는다.
// 기대 단가는 스텁이 돌려준 slot0 sqrtPriceX96로 테스트가 따로 계산한 유리수다(제품 함수로 만들지 않는다).
// DoD-36의 판정은 T-13·T-14·T-17 명령 결과로 하고, 이 파일의 DoD-36 case는 스텁 분류 보조다.

const CASE_TIMEOUT_MS = 30_000;
const MULTI_SAMPLE_TIMEOUT_MS = 120_000;

let rpc: BalanceRpcStub;

beforeEach(() => {
  rpc = installBalanceRpcStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
});

// 같은 case 안에서 표본마다 앱(config·QueryClient)과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  rpc = installBalanceRpcStub();
}

type Side = "in" | "out";

// ─── 공식 주소·토큰(리터럴) ──────────────────────────────────────────

const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const LITERALS: Record<SupportedChainId, { quoterV2: Address; weth: Address; usdc: Address }> = {
  [mainnet.id]: {
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  [base.id]: {
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  [arbitrum.id]: {
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
};
const ETHEREUM = LITERALS[mainnet.id];

type TokenLiteral = { address: Address; decimals: number };

// 선택 체인 앱 토큰 목록에 있는 토큰(주소·decimals 리터럴, 목록 스냅샷에서 확인)
const ETH_WBTC: TokenLiteral = {
  address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  decimals: 8,
};
const ETH_KNC: TokenLiteral = {
  address: "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
  decimals: 18,
};
const ETH_LINK: TokenLiteral = {
  address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
  decimals: 18,
};
const BASE_CBBTC: TokenLiteral = {
  address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  decimals: 8,
};
const ARB_USDT0: TokenLiteral = {
  address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  decimals: 6,
};
// 브리지 USDC(EC-14)
const BASE_USDBC: TokenLiteral = {
  address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  decimals: 6,
};
const ARB_USDCE: TokenLiteral = {
  address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  decimals: 6,
};
// Ethereum 토큰 목록에 없는 주소(EC-27). 체크섬 표기라 대소문자가 섞인다.
const OUTSIDE_LIST_ADDRESS: Address = getAddress("0x1234567890abcdef1234567890abcdef12345678");

const ONE_ETH = 10n ** 18n;
const TWO_ETH = 2n * ONE_ETH;

const CONNECTED_STATES = [
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "wrapping",
  "unwrapping",
  "wrap-ready",
  "unwrap-ready",
  "swap-ready",
  "approve-required",
  "price-impact-too-high",
];

// ─── 화면 ─────────────────────────────────────────────────────────

function field(side: Side): HTMLElement {
  const found = screen
    .getAllByTestId("token-field")
    .find((element) => element.getAttribute("data-side") === side);
  if (!found) throw new Error(`token-field[data-side="${side}"]가 없다`);
  return found;
}

function amountInput(): HTMLInputElement {
  return within(field("in")).getByTestId("amount-input") as HTMLInputElement;
}

function primaryState(): string | null {
  return screen.getByTestId("primary-button").getAttribute("data-state");
}

function tokenModal(): HTMLElement | null {
  return screen.queryByTestId("token-modal");
}

function optionRow(address: Address): HTMLElement {
  const modal = tokenModal();
  const row = modal
    ? within(modal)
        .queryAllByTestId("token-option")
        .find((element) =>
          sameAddress(element.getAttribute("data-token-address") ?? undefined, address),
        )
    : undefined;
  if (!row) throw new Error(`token-option ${address}가 없다`);
  return row;
}

async function chooseToken(side: Side, address: Address) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function appConfig(connector?: CreateConnectorFn): WagmiConfig {
  return createWagmiConfig({
    connectors: connector ? [connector] : [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

function mockConnectedConfig(): WagmiConfig {
  return appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
}

// 단가를 읽을 체인·토큰. 토큰이 없으면 단가 훅은 `idle`이다.
type PriceTarget = { chainId: SupportedChainId; token: Address | undefined };
const NO_TARGET: PriceTarget = { chainId: mainnet.id, token: undefined };

// wagmi mock 커넥터로 Ethereum에 연결된 앱(처음 선택 체인 Ethereum)과 함께 단가 훅 두 개를 렌더링한다.
async function renderPriceApp(
  a: PriceTarget,
  b: PriceTarget = NO_TARGET,
  config: WagmiConfig = mockConnectedConfig(),
) {
  const view = renderAppHook(
    () => ({
      selected: useSelectedChain(),
      quote: useSwapQuote(),
      a: useTokenUsdPrice(a.chainId, a.token),
      b: useTokenUsdPrice(b.chainId, b.token),
    }),
    { config, initialChainId: mainnet.id },
  );
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return { ...view, config };
}

type PriceView = Awaited<ReturnType<typeof renderPriceApp>>;

// 연결 체인(Ethereum)은 그대로 두고 앱의 선택 체인만 바꾼다.
async function selectChain(view: PriceView, chainId: SupportedChainId) {
  if (view.result.current.selected.selectedChainId === chainId) return;
  act(() => view.result.current.selected.setSelectedChainId(chainId));
  await waitUntil(() => expect(view.result.current.selected.selectedChainId).toBe(chainId));
}

async function waitPriceSettled(read: () => TokenUsdPriceState, label?: string) {
  await waitUntil(() => expect(read().status, label).not.toBe("loading"));
  await settlePendingWork();
}

function priceOf(state: TokenUsdPriceState, label?: string): StubPrice {
  expect(state.status, label).toBe("success");
  if (state.status !== "success") throw new Error("unreachable");
  return state.price;
}

function hasPrice(state: TokenUsdPriceState): boolean {
  return "price" in state;
}

// ─── 단가 규칙(테스트 쪽) ────────────────────────────────────────────

// 티어별 수령량을 정한 견적 응답(견적 후 가격은 한계값이 아닌 기본값)
function tierAmounts(amounts: Record<StubFeeTier, bigint>) {
  return (query: QuoteQuery): QuoteTierResponse => ({
    status: "ok",
    amountOut: amounts[query.fee],
    sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
  });
}

// DoD-2 토큰→WETH 풀의 티어별 slot0 배수. 기본 slot0 배수(2·3·5·7)와 겹치지 않는 소수다.
const TO_WETH_SLOT0_MULTIPLIER: Record<StubFeeTier, bigint> = {
  100: 11n,
  500: 13n,
  3000: 17n,
  10000: 19n,
};

function both(...matchers: RequestMatcher[]): RequestMatcher {
  return (request) => matchers.every((matcher) => matcher(request));
}

describe("단가 조회 — 체인·토큰별 USD 단가를 Uniswap V3 온체인 현물가로 구한다", () => {
  describe("USDC 직접 경로가 있는 토큰", () => {
    /**
     * @spec DoD-1
     * @given mock 커넥터는 Ethereum에 연결된 채로 두고 앱의 선택 체인만 바꾼다. 스텁은 대상 토큰→체인 네이티브 USDC 단가 견적 네 티어 중 한 티어를 revert로, 나머지 세 티어 중 한 티어의 수령량이 가장 많게 응답하고, 티어 풀마다 서로 다른 slot0 sqrtPriceX96(2^96이 아닌 값)을 돌려준다. 표본 선택 체인: Ethereum, Base, Arbitrum. 표본 대상 토큰: 체인마다 USDC 대비 token0인 토큰과 token1인 토큰 하나씩(주소 리터럴, 주소 순서는 체인마다 테스트가 확인한다)이며, 표본 중 하나 이상은 decimals가 18이 아닌 토큰(예: Ethereum WBTC 8자리)이다. 체인 3 × 순서 2의 조합을 하나씩 반복한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(선택 체인, 대상 토큰)의 조회가 끝나기를 기다린다
     * @then 단가 요청을 디코드하면 하위 `quoteExactInputSingle` 호출의 대상이 선택 체인 QuoterV2 주소 리터럴이고, tokenIn이 대상 토큰, tokenOut이 선택 체인 네이티브 USDC 주소 리터럴이다
     * @then 디코드한 하위 `quoteExactInputSingle` 호출의 수수료 티어가 100, 500, 3000, 10000 네 개이고 입력 금액이 모두 토큰 1개(10^decimals)다
     * @then useTokenUsdPrice의 status가 `success`다
     * @then price(numerator/denominator)가 revert 티어를 빼고 수령량이 가장 많은 티어 풀의 slot0 sqrtPriceX96로 대상 토큰·USDC 주소 순서에 맞춰 테스트가 따로 계산한 현물가(USDC raw / 토큰 raw)와 같은 유리수다
     * @then price가 고르지 않은 티어 풀의 slot0로 같은 방법으로 계산한 유리수와 다르다
     */
    it(
      "[DoD-1] 네 티어 견적으로 고른 USDC 풀의 slot0 현물가가 단가다",
      async () => {
        // 체인마다 USDC 대비 token0·token1 토큰. Ethereum WBTC·Base cbBTC(8자리), Arbitrum USDT0(6자리)는 decimals가 18이 아니다.
        const samples: {
          chainId: SupportedChainId;
          token: TokenLiteral;
          order: "token0" | "token1";
        }[] = [
          { chainId: mainnet.id, token: ETH_WBTC, order: "token0" },
          { chainId: mainnet.id, token: { address: ETHEREUM.weth, decimals: 18 }, order: "token1" },
          {
            chainId: base.id,
            token: { address: LITERALS[base.id].weth, decimals: 18 },
            order: "token0",
          },
          { chainId: base.id, token: BASE_CBBTC, order: "token1" },
          {
            chainId: arbitrum.id,
            token: { address: LITERALS[arbitrum.id].weth, decimals: 18 },
            order: "token0",
          },
          { chainId: arbitrum.id, token: ARB_USDT0, order: "token1" },
        ];
        expect(samples.some(({ token }) => token.decimals !== 18)).toBe(true);

        for (const [index, { chainId, token, order }] of samples.entries()) {
          const label = `${chainId} ${token.address}`;
          if (index > 0) resetSample();
          const { quoterV2, usdc } = LITERALS[chainId];
          // 전제: 표본 토큰의 USDC 대비 주소 순서
          expect(BigInt(token.address) < BigInt(usdc) ? "token0" : "token1", label).toBe(order);

          const amountIn = 10n ** BigInt(token.decimals);
          // 기본 규칙에서 수령량이 가장 많은 500 티어를 revert로 바꾼다. 남은 세 티어 중 한 티어가 가장 많다.
          const rule = usdPriceRuleWith([
            {
              chainId,
              tokenIn: token.address,
              tokenOut: usdc,
              quote: (query) =>
                query.fee === 500 ? stubRevertQuote() : defaultUsdPriceRule.quote(query),
            },
          ]);
          rpc.setUsdPriceRule(rule);
          const selected = stubSelectFeeTier(rule, {
            chainId,
            tokenIn: token.address,
            tokenOut: usdc,
            amountIn,
          });
          expect(selected, label).not.toBeNull();
          expect(selected!.fee, label).not.toBe(500);
          const slot0 = defaultSlot0SqrtPriceX96(selected!.fee);
          expect(slot0, label).not.toBe(STUB_Q96);

          const view = await renderPriceApp({ chainId, token: token.address });
          await selectChain(view, chainId);
          await waitPriceSettled(() => view.result.current.a, label);

          const requests = rpc.requests(
            match.chain(chainId, matchUsdPrice.pair(token.address, usdc)),
          );
          expect(requests.length, label).toBeGreaterThan(0);
          for (const request of requests) {
            const pair = request.usdPrice!.pairs.find(
              (candidate) =>
                sameAddress(candidate.tokenIn, token.address) &&
                sameAddress(candidate.tokenOut, usdc),
            )!;
            expect(
              pair.quotes.map((call) => call.fee).sort((x, y) => x - y),
              label,
            ).toEqual([100, 500, 3000, 10000]);
            for (const call of pair.quotes) {
              expect(sameAddress(call.target, quoterV2), `${label} target`).toBe(true);
              expect(sameAddress(call.tokenIn, token.address), `${label} tokenIn`).toBe(true);
              expect(sameAddress(call.tokenOut, usdc), `${label} tokenOut`).toBe(true);
              expect(call.amountIn, `${label} amountIn`).toBe(amountIn);
            }
          }

          const price = priceOf(view.result.current.a, label);
          expect(
            stubPricesEqual(price, stubSpotPrice(token.address, usdc, slot0)),
            `${label} 고른 티어 현물가`,
          ).toBe(true);
          for (const fee of STUB_FEE_TIERS.filter((candidate) => candidate !== selected!.fee)) {
            expect(
              stubPricesEqual(
                price,
                stubSpotPrice(token.address, usdc, defaultSlot0SqrtPriceX96(fee)),
              ),
              `${label} 고르지 않은 티어 ${fee}`,
            ).toBe(false);
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("USDC 직접 경로가 없고 WETH 경유 경로가 있는 토큰", () => {
    /**
     * @spec DoD-2
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 스텁은 대상 토큰→USDC 단가 견적 네 티어를 모두 revert로 응답한다. 토큰→WETH 구간과 WETH→USDC 구간은 각각 네 티어 중 서로 다른 한 티어의 수령량이 가장 많게 응답하고, 티어 풀마다 서로 다른 slot0 sqrtPriceX96(2^96이 아닌 값)을 돌려준다. 표본 대상 토큰: WETH 대비 token0인 토큰과 token1인 토큰 하나씩(주소 리터럴)이며, 표본 중 하나 이상은 decimals가 18이 아닌 토큰이다. 표본을 하나씩 반복한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(Ethereum, 대상 토큰)의 조회가 끝나기를 기다린다
     * @then 단가 요청을 디코드하면 토큰→WETH 구간의 하위 `quoteExactInputSingle` 호출이 네 티어이고 입력 금액이 토큰 1개(10^토큰 decimals)다
     * @then 단가 요청을 디코드하면 WETH→USDC 구간의 하위 `quoteExactInputSingle` 호출이 네 티어이고 입력 금액이 WETH 1개(10^18)다
     * @then useTokenUsdPrice의 status가 `success`다
     * @then price가 두 구간 각각에서 수령량이 가장 많은 티어 풀의 slot0로 테스트가 따로 계산한 토큰→WETH 현물가 × WETH→USDC 현물가와 같은 유리수다
     * @then price가 어느 한 구간이라도 고르지 않은 티어 풀의 slot0로 계산한 곱과 다르다
     */
    it(
      "[DoD-2] 토큰→WETH 현물가 × WETH→USDC 현물가가 단가다",
      async () => {
        const { weth, usdc } = ETHEREUM;
        // WETH 대비 token0인 WBTC(8자리, decimals ≠ 18)와 token1인 KNC
        const samples: { token: TokenLiteral; order: "token0" | "token1" }[] = [
          { token: ETH_WBTC, order: "token0" },
          { token: ETH_KNC, order: "token1" },
        ];
        expect(samples.some(({ token }) => token.decimals !== 18)).toBe(true);

        for (const [index, { token, order }] of samples.entries()) {
          const label = token.address;
          if (index > 0) resetSample();
          expect(BigInt(token.address) < BigInt(weth) ? "token0" : "token1", label).toBe(order);

          const amountIn = 10n ** BigInt(token.decimals);
          // 토큰→WETH는 3000 티어, WETH→USDC는 10000 티어의 수령량이 가장 많다.
          // 토큰→WETH 풀의 slot0은 WETH→USDC 풀(기본 2·3·5·7 × Q96)과 겹치지 않는 소수 배수(11·13·17·19 × Q96)라
          // 두 구간 티어 조합 16개의 곱이 모두 서로 다르다(같은 배수 집합이면 방향에 따라 곱이 대칭으로 겹친다).
          const toWethSlot0Of = (fee: StubFeeTier) => STUB_Q96 * TO_WETH_SLOT0_MULTIPLIER[fee];
          const rule = usdPriceRuleWith([
            { chainId: mainnet.id, tokenIn: token.address, tokenOut: usdc, quote: stubRevertQuote },
            {
              chainId: mainnet.id,
              tokenIn: token.address,
              tokenOut: weth,
              quote: tierAmounts({ 100: 10n, 500: 20n, 3000: 50n, 10000: 30n }),
              slot0: (query) => ({ status: "ok", sqrtPriceX96: toWethSlot0Of(query.fee) }),
            },
            {
              chainId: mainnet.id,
              tokenIn: weth,
              tokenOut: usdc,
              quote: tierAmounts({ 100: 10n, 500: 20n, 3000: 30n, 10000: 50n }),
            },
          ]);
          rpc.setUsdPriceRule(rule);
          const toWethSlot0 = toWethSlot0Of(3000);
          const wethToUsdcSlot0 = defaultSlot0SqrtPriceX96(10000);
          expect(toWethSlot0, label).not.toBe(STUB_Q96);
          expect(wethToUsdcSlot0, label).not.toBe(STUB_Q96);

          const view = await renderPriceApp({ chainId: mainnet.id, token: token.address });
          await waitPriceSettled(() => view.result.current.a, label);

          const toWethRequests = rpc.requests(
            match.chain(mainnet.id, matchUsdPrice.pair(token.address, weth)),
          );
          expect(toWethRequests.length, label).toBeGreaterThan(0);
          for (const request of toWethRequests) {
            const pair = request.usdPrice!.pairs.find(
              (candidate) =>
                sameAddress(candidate.tokenIn, token.address) &&
                sameAddress(candidate.tokenOut, weth),
            )!;
            expect(
              pair.quotes.map((call) => call.fee).sort((x, y) => x - y),
              label,
            ).toEqual([100, 500, 3000, 10000]);
            for (const call of pair.quotes) expect(call.amountIn, label).toBe(amountIn);
          }

          const routedWethToUsdc = rpc.requests(
            match.chain(
              mainnet.id,
              both(matchUsdPrice.stage("routed"), matchUsdPrice.pair(token.address, weth)),
            ),
          );
          expect(routedWethToUsdc.length, label).toBeGreaterThan(0);
          for (const request of routedWethToUsdc) {
            const pair = request.usdPrice!.pairs.find(
              (candidate) =>
                sameAddress(candidate.tokenIn, weth) && sameAddress(candidate.tokenOut, usdc),
            );
            expect(pair, `${label} (WETH, USDC) 구간`).toBeDefined();
            expect(
              pair!.quotes.map((call) => call.fee).sort((x, y) => x - y),
              label,
            ).toEqual([100, 500, 3000, 10000]);
            for (const call of pair!.quotes) expect(call.amountIn, label).toBe(ONE_ETH);
          }

          const price = priceOf(view.result.current.a, label);
          const expected = stubMultiplyPrices(
            stubSpotPrice(token.address, weth, toWethSlot0),
            stubSpotPrice(weth, usdc, wethToUsdcSlot0),
          );
          expect(stubPricesEqual(price, expected), `${label} 경유 곱`).toBe(true);
          for (const toWethFee of STUB_FEE_TIERS) {
            for (const wethFee of STUB_FEE_TIERS) {
              if (toWethFee === 3000 && wethFee === 10000) continue;
              const other = stubMultiplyPrices(
                stubSpotPrice(token.address, weth, toWethSlot0Of(toWethFee)),
                stubSpotPrice(weth, usdc, defaultSlot0SqrtPriceX96(wethFee)),
              );
              expect(stubPricesEqual(price, other), `${label} ${toWethFee}×${wethFee}`).toBe(false);
            }
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("체인 네이티브 USDC", () => {
    /**
     * @spec DoD-3
     * @given mock 커넥터는 Ethereum에 연결된 채로 두고 앱의 선택 체인만 바꾼다. 스텁은 모든 단가 요청에 기본 성공 응답을 주고 단가 요청을 JSON-RPC 항목 단위(배치 배열은 항목마다)로 기록한다. 표본 선택 체인: Ethereum, Base, Arbitrum(체인 네이티브 USDC 주소 리터럴)을 하나씩 반복한다
     * @when 선택 체인 클라이언트로 readTokenUsdPrices(client, { chainId: 선택 체인, tokens: [체인 네이티브 USDC] })를 직접 호출하고, 이어서 앱을 렌더링해 useTokenUsdPrice(선택 체인, 체인 네이티브 USDC)를 읽어 결과가 나오기를 기다린다
     * @then readTokenUsdPrices 호출 동안 스텁에 기록된 JSON-RPC 항목이 0건이다
     * @then readTokenUsdPrices 결과 맵에서 USDC 주소를 소문자로 바꾼 키의 값이 numerator = denominator인 단가다(USDC raw 1단위당 1 micro, USDC 1개 = 정확히 $1)
     * @then useTokenUsdPrice의 status가 `success`이고 price의 numerator와 denominator가 같다
     * @then 앱 렌더 동안 기록된 단가 요청을 디코드했을 때 tokenIn이 체인 네이티브 USDC인 하위 `quoteExactInputSingle` 호출이 0건이다
     */
    it(
      "[DoD-3] USDC 단가는 요청 없이 정확히 $1이다",
      async () => {
        const chains: SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        for (const [index, chainId] of chains.entries()) {
          const label = String(chainId);
          if (index > 0) resetSample();
          const { usdc } = LITERALS[chainId];
          const config = mockConnectedConfig();

          // 직접 호출: 앱을 렌더링하기 전이라 다른 요청이 섞이지 않는다.
          const requestsBefore = rpc.requests().length;
          const prices = await readTokenUsdPrices(config.getClient({ chainId }), {
            chainId,
            tokens: [usdc],
          });
          expect(rpc.requests().length - requestsBefore, `${label} 직접 호출 JSON-RPC 항목`).toBe(
            0,
          );
          const direct = prices.get(usdc.toLowerCase() as Address);
          expect(direct, label).toBeTruthy();
          expect(direct!.numerator, label).toBe(direct!.denominator);

          const view = await renderPriceApp({ chainId, token: usdc }, NO_TARGET, config);
          await selectChain(view, chainId);
          await waitPriceSettled(() => view.result.current.a, label);
          const price = priceOf(view.result.current.a, label);
          expect(price.numerator, label).toBe(price.denominator);

          const usdcQuotes = rpc
            .requests(match.chain(chainId, matchUsdPrice.any))
            .flatMap((request) => request.usdPrice!.pairs.flatMap((pair) => pair.quotes))
            .filter((call) => sameAddress(call.tokenIn, usdc));
          expect(usdcQuotes.length, label).toBe(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("네이티브 ETH", () => {
    /**
     * @spec DoD-4
     * @given mock 커넥터는 Ethereum에 연결된 채로 두고 앱의 선택 체인만 바꾼다. 스텁은 WETH→USDC 단가 견적에 기본 성공 응답을 주고, 고른 티어 풀의 slot0을 2^96이 아닌 sqrtPriceX96로 돌려준다. 표본 선택 체인: Ethereum, Base, Arbitrum(ETH `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`, 체인별 WETH 주소 리터럴)을 하나씩 반복한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(선택 체인, NATIVE_ETH_ADDRESS)와 useTokenUsdPrice(선택 체인, 같은 체인 WETH)를 함께 읽어 조회가 끝나기를 기다린다
     * @then 두 반환값의 status가 모두 `success`이고 price가 같은 유리수다
     * @then 그 price가 선택 체인 WETH→USDC 고른 티어 풀의 slot0로 테스트가 따로 계산한 현물가와 같은 유리수다
     * @then 단가 요청을 디코드하면 tokenIn이 선택 체인 WETH 주소 리터럴이고, 어떤 하위 호출에도 ETH 주소 `0xEeee…EEeE`가 들어 있지 않다
     * @then ETH와 WETH 대상의 단가 요청이 따로 나가지 않는다(스펙 §4.2: ETH와 WETH가 한 캐시 항목을 쓴다)
     */
    it(
      "[DoD-4] ETH 단가는 세 체인에서 같은 체인 WETH 단가와 같다",
      async () => {
        const chains: SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        for (const [index, chainId] of chains.entries()) {
          const label = String(chainId);
          if (index > 0) resetSample();
          const { weth, usdc } = LITERALS[chainId];
          const expected = expectedStubUsdPrice(rpc.usdPriceRule(), {
            chainId,
            token: weth,
            decimals: 18,
          });
          expect(expected.status, label).toBe("success");
          const wethToUsdc = stubPairPrice(rpc.usdPriceRule(), {
            chainId,
            token: weth,
            quoteToken: usdc,
            amountIn: ONE_ETH,
          });
          expect(wethToUsdc.status, label).toBe("ok");
          if (wethToUsdc.status === "ok") {
            expect(defaultSlot0SqrtPriceX96(wethToUsdc.fee), label).not.toBe(STUB_Q96);
          }

          const view = await renderPriceApp(
            { chainId, token: ETH_ADDRESS },
            { chainId, token: weth },
          );
          await selectChain(view, chainId);
          await waitPriceSettled(() => view.result.current.a, `${label} ETH`);
          await waitPriceSettled(() => view.result.current.b, `${label} WETH`);

          const ethPrice = priceOf(view.result.current.a, `${label} ETH`);
          const wethPrice = priceOf(view.result.current.b, `${label} WETH`);
          expect(stubPricesEqual(ethPrice, wethPrice), label).toBe(true);
          if (expected.status === "success") {
            expect(stubPricesEqual(ethPrice, expected.price), label).toBe(true);
          }

          const requests = rpc.requests(match.chain(chainId, matchUsdPrice.any));
          expect(requests.length, label).toBeGreaterThan(0);
          for (const request of requests) {
            for (const pair of request.usdPrice!.pairs) {
              expect(sameAddress(pair.tokenIn, weth), `${label} tokenIn`).toBe(true);
              expect(sameAddress(pair.tokenIn, ETH_ADDRESS), label).toBe(false);
              expect(sameAddress(pair.tokenOut, ETH_ADDRESS), label).toBe(false);
              for (const call of pair.quotes) {
                expect(sameAddress(call.tokenIn, ETH_ADDRESS), label).toBe(false);
                expect(sameAddress(call.tokenOut, ETH_ADDRESS), label).toBe(false);
              }
            }
          }
          // ETH와 WETH는 한 캐시 항목을 쓴다: WETH 대상 단가 요청이 한 번만 나간다.
          expect(rpc.requests(match.chain(chainId, matchUsdPrice.target(weth))).length, label).toBe(
            1,
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("브리지 USDC", () => {
    /**
     * @spec EC-14
     * @given mock 커넥터는 Ethereum에 연결된 채로 두고 앱의 선택 체인만 바꾼다. 스텁은 브리지 USDC→체인 네이티브 USDC 단가 견적에 한 티어의 수령량이 가장 많게 응답하고, 그 티어 풀의 slot0을 현물가가 1이 아닌 sqrtPriceX96로 돌려준다. 표본: Base 선택 체인의 USDbC `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`, Arbitrum 선택 체인의 USDC.e `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8`를 하나씩 반복한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(선택 체인, 브리지 USDC)의 조회가 끝나기를 기다린다
     * @then 단가 요청이 나가고, 디코드한 하위 `quoteExactInputSingle` 호출의 tokenIn이 브리지 USDC 주소 리터럴, tokenOut이 체인 네이티브 USDC 주소 리터럴이다
     * @then useTokenUsdPrice의 status가 `success`이고 price가 스텁 slot0로 테스트가 따로 계산한 현물가와 같은 유리수다
     * @then price의 numerator와 denominator가 다르다($1로 고정하지 않는다)
     */
    it(
      "[EC-14] 브리지 USDC는 $1로 고정하지 않고 현물가로 단가를 구한다",
      async () => {
        const samples: { chainId: SupportedChainId; token: TokenLiteral }[] = [
          { chainId: base.id, token: BASE_USDBC },
          { chainId: arbitrum.id, token: ARB_USDCE },
        ];
        for (const [index, { chainId, token }] of samples.entries()) {
          const label = `${chainId} ${token.address}`;
          if (index > 0) resetSample();
          const { usdc } = LITERALS[chainId];
          const expected = expectedStubUsdPrice(rpc.usdPriceRule(), {
            chainId,
            token: token.address,
            decimals: token.decimals,
          });
          expect(expected.status, label).toBe("success");

          const view = await renderPriceApp({ chainId, token: token.address });
          await selectChain(view, chainId);
          await waitPriceSettled(() => view.result.current.a, label);

          const requests = rpc.requests(match.chain(chainId, matchUsdPrice.pair(token.address)));
          expect(requests.length, label).toBeGreaterThan(0);
          for (const request of requests) {
            const pairs = request.usdPrice!.pairs.filter((pair) =>
              sameAddress(pair.tokenIn, token.address),
            );
            for (const pair of pairs) {
              for (const call of pair.quotes) {
                expect(sameAddress(call.tokenIn, token.address), label).toBe(true);
                expect(sameAddress(call.tokenOut, usdc), label).toBe(true);
              }
            }
          }

          const price = priceOf(view.result.current.a, label);
          if (expected.status === "success") {
            expect(stubPricesEqual(price, expected.price), label).toBe(true);
          }
          expect(price.numerator, label).not.toBe(price.denominator);
          expect(stubPricesEqual(price, { numerator: 1n, denominator: 1n }), label).toBe(false);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("가격 경로가 없는 경우", () => {
    /**
     * @spec EC-16
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 대상 토큰은 선택 체인(Ethereum) 앱 토큰 목록에 있는 토큰(주소 리터럴)이다. 스텁은 대상 토큰의 USDC 직접 구간과 토큰→WETH 구간 네 티어를 모두 고를 수 없는 형태로 응답한다. 표본 응답 형태: 모든 티어 revert, 모든 티어 1개 견적 수령량 0, 모든 티어 유동성 소진(견적 후 sqrtPriceX96After가 가격 한계에 닿음), 티어마다 revert·수령량 0·유동성 소진이 섞임을 하나씩 반복한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(Ethereum, 대상 토큰)의 결과가 나오기를 기다린 뒤, 선택 체인 클라이언트로 readTokenUsdPrices(client, { chainId: Ethereum, tokens: [대상 토큰] })를 호출한다
     * @then useTokenUsdPrice의 status가 `no-price`다
     * @then price가 없다
     * @then readTokenUsdPrices 결과 맵에서 대상 토큰 주소를 소문자로 바꾼 키의 값이 `null`이다
     * @then 디코드한 단가 요청에 대상 토큰의 (토큰, USDC) 쌍과 (토큰, WETH) 쌍이 나갔다
     */
    it(
      "[EC-16] 직접·WETH 경유 모두 티어를 고를 수 없으면 no-price다",
      async () => {
        const { weth, usdc } = ETHEREUM;
        const token = ETH_LINK.address;
        const shapes: { name: string; quote: (query: QuoteQuery) => QuoteTierResponse }[] = [
          { name: "모든 티어 revert", quote: stubRevertQuote },
          {
            name: "모든 티어 수령량 0",
            quote: () => ({
              status: "ok",
              amountOut: 0n,
              sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
            }),
          },
          {
            name: "모든 티어 유동성 소진",
            quote: (query) => ({
              status: "ok",
              amountOut: 1_000n,
              sqrtPriceX96After: stubExhaustedSqrtPriceX96After(query.tokenIn, query.tokenOut),
            }),
          },
          {
            name: "revert·수령량 0·유동성 소진 섞임",
            quote: (query) => {
              if (query.fee === 100) return stubRevertQuote();
              if (query.fee === 3000) {
                return {
                  status: "ok",
                  amountOut: 1_000n,
                  sqrtPriceX96After: stubExhaustedSqrtPriceX96After(query.tokenIn, query.tokenOut),
                };
              }
              return {
                status: "ok",
                amountOut: 0n,
                sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
              };
            },
          },
        ];

        for (const [index, shape] of shapes.entries()) {
          const label = shape.name;
          if (index > 0) resetSample();
          const rule = usdPriceRuleWith([
            { chainId: mainnet.id, tokenIn: token, tokenOut: usdc, quote: shape.quote },
            { chainId: mainnet.id, tokenIn: token, tokenOut: weth, quote: shape.quote },
          ]);
          rpc.setUsdPriceRule(rule);
          const input = { chainId: mainnet.id, tokenIn: token, amountIn: ONE_ETH } as const;
          expect(stubSelectFeeTier(rule, { ...input, tokenOut: usdc }), label).toBeNull();
          expect(stubSelectFeeTier(rule, { ...input, tokenOut: weth }), label).toBeNull();

          const view = await renderPriceApp({ chainId: mainnet.id, token });
          await waitPriceSettled(() => view.result.current.a, label);
          expect(view.result.current.a.status, label).toBe("no-price");
          expect(hasPrice(view.result.current.a), label).toBe(false);

          const prices = await readTokenUsdPrices(view.config.getClient({ chainId: mainnet.id }), {
            chainId: mainnet.id,
            tokens: [token],
          });
          const key = token.toLowerCase() as Address;
          expect(prices.has(key), label).toBe(true);
          expect(prices.get(key), label).toBeNull();

          expect(
            rpc.requests(match.chain(mainnet.id, matchUsdPrice.pair(token, usdc))).length,
            label,
          ).toBeGreaterThan(0);
          expect(
            rpc.requests(match.chain(mainnet.id, matchUsdPrice.pair(token, weth))).length,
            label,
          ).toBeGreaterThan(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-26
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 대상 토큰은 선택 체인(Ethereum) 앱 토큰 목록에 있는 토큰(주소 리터럴)이다. 스텁은 대상 토큰의 USDC 직접 구간 네 티어를 모두 revert로, 토큰→WETH 구간은 한 티어의 수령량이 가장 많게(slot0 성공), WETH→USDC 구간 네 티어는 모두 revert(조회 실패가 아닌 경로 없음)로 응답한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(Ethereum, 대상 토큰)의 결과가 나오기를 기다린 뒤, 선택 체인 클라이언트로 readTokenUsdPrices(client, { chainId: Ethereum, tokens: [대상 토큰] })를 호출한다
     * @then useTokenUsdPrice의 status가 `no-price`다
     * @then price가 없다
     * @then readTokenUsdPrices 결과 맵에서 대상 토큰 주소를 소문자로 바꾼 키의 값이 `null`이다
     * @then 디코드한 단가 요청에 대상 토큰의 (토큰, USDC) 쌍과 (토큰, WETH) 쌍, 그리고 (WETH, USDC) 쌍이 나갔다
     */
    it(
      "[EC-26] 토큰→WETH는 있고 WETH→USDC 경로가 없으면 no-price다",
      async () => {
        const { weth, usdc } = ETHEREUM;
        const token = ETH_LINK.address;
        const rule = usdPriceRuleWith([
          { chainId: mainnet.id, tokenIn: token, tokenOut: usdc, quote: stubRevertQuote },
          {
            chainId: mainnet.id,
            tokenIn: token,
            tokenOut: weth,
            quote: tierAmounts({ 100: 10n, 500: 50n, 3000: 20n, 10000: 30n }),
          },
          { chainId: mainnet.id, tokenIn: weth, tokenOut: usdc, quote: stubRevertQuote },
        ]);
        rpc.setUsdPriceRule(rule);
        expect(
          stubPairPrice(rule, { chainId: mainnet.id, token, quoteToken: weth, amountIn: ONE_ETH })
            .status,
        ).toBe("ok");
        expect(
          stubPairPrice(rule, {
            chainId: mainnet.id,
            token: weth,
            quoteToken: usdc,
            amountIn: ONE_ETH,
          }).status,
        ).toBe("none");

        const view = await renderPriceApp({ chainId: mainnet.id, token });
        await waitPriceSettled(() => view.result.current.a);
        expect(view.result.current.a.status).toBe("no-price");
        expect(hasPrice(view.result.current.a)).toBe(false);

        const prices = await readTokenUsdPrices(view.config.getClient({ chainId: mainnet.id }), {
          chainId: mainnet.id,
          tokens: [token],
        });
        const key = token.toLowerCase() as Address;
        expect(prices.has(key)).toBe(true);
        expect(prices.get(key)).toBeNull();

        expect(
          rpc.requests(match.chain(mainnet.id, matchUsdPrice.pair(token, usdc))).length,
        ).toBeGreaterThan(0);
        expect(
          rpc.requests(match.chain(mainnet.id, matchUsdPrice.pair(token, weth))).length,
        ).toBeGreaterThan(0);
        // (WETH, USDC) 구간 쌍은 토큰의 WETH 경유 요청에 함께 담긴다.
        const routed = rpc.requests(
          match.chain(
            mainnet.id,
            both(matchUsdPrice.stage("routed"), matchUsdPrice.pair(token, weth)),
          ),
        );
        expect(routed.some((request) => matchUsdPrice.pair(weth, usdc)(request))).toBe(true);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-27
     * @given mock 커넥터로 Ethereum에 연결돼 있고 선택 체인이 Ethereum이다. 스텁은 단가 요청에 기본 성공 응답을 준다. 입력 토큰: Ethereum 토큰 목록에 없는 주소 리터럴(대소문자가 섞인 체크섬 표기)과 Ethereum WETH 주소 리터럴
     * @when 선택 체인 클라이언트로 readTokenUsdPrices(client, { chainId: Ethereum, tokens: 입력 토큰 })를 호출하고, 같은 앱에서 useTokenUsdPrice(Ethereum, 목록 밖 주소)를 읽어 결과가 나오기를 기다린다
     * @then readTokenUsdPrices 결과 맵에서 목록 밖 주소를 소문자로 바꾼 키의 값이 `null`이다
     * @then readTokenUsdPrices 결과 맵에서 WETH 주소를 소문자로 바꾼 키의 값이 `null`이 아닌 단가다
     * @then useTokenUsdPrice(Ethereum, 목록 밖 주소)의 status가 `no-price`다
     */
    it(
      "[EC-27] 선택 체인 토큰 목록 밖 주소의 단가 결과는 null(no-price)이다",
      async () => {
        const { weth } = ETHEREUM;
        // 전제: 목록 밖 주소 리터럴이 대소문자가 섞인 체크섬 표기다.
        expect(OUTSIDE_LIST_ADDRESS).not.toBe(OUTSIDE_LIST_ADDRESS.toLowerCase());

        const view = await renderPriceApp({ chainId: mainnet.id, token: OUTSIDE_LIST_ADDRESS });
        expect(view.result.current.selected.selectedChainId).toBe(mainnet.id);

        const prices = await readTokenUsdPrices(view.config.getClient({ chainId: mainnet.id }), {
          chainId: mainnet.id,
          tokens: [OUTSIDE_LIST_ADDRESS, weth],
        });
        const outsideKey = OUTSIDE_LIST_ADDRESS.toLowerCase() as Address;
        expect(prices.has(outsideKey)).toBe(true);
        expect(prices.get(outsideKey)).toBeNull();
        const wethPrice = prices.get(weth.toLowerCase() as Address);
        expect(wethPrice).toBeTruthy();
        expect(wethPrice!.denominator).toBeGreaterThan(0n);

        await waitPriceSettled(() => view.result.current.a);
        expect(view.result.current.a.status).toBe("no-price");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("단가 조회가 실패한 경우", () => {
    /**
     * @spec EC-15
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 스텁은 대상 토큰(주소 리터럴)의 USDC 직접 구간 네 티어를 모두 revert로, 토큰→WETH 구간은 한 티어의 수령량이 가장 많게(slot0 성공) 응답한다. 표본 WETH→USDC 조회 실패 형태: WETH→USDC 구간에서 고른 티어 풀의 slot0 하위 호출 실패, WETH 경유 단가 요청 전체를 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답을 하나씩 반복한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(Ethereum, 대상 토큰)의 결과가 나오기를 기다린다
     * @then useTokenUsdPrice의 status가 `error`다
     * @then price가 없다
     */
    it(
      "[EC-15] 토큰→WETH는 있고 WETH→USDC 조회가 실패하면 error다",
      async () => {
        const { weth, usdc } = ETHEREUM;
        const token = ETH_LINK.address;
        const routedPairs = [
          { chainId: mainnet.id, tokenIn: token, tokenOut: usdc, quote: stubRevertQuote },
          {
            chainId: mainnet.id,
            tokenIn: token,
            tokenOut: weth,
            quote: tierAmounts({ 100: 10n, 500: 20n, 3000: 50n, 10000: 30n }),
          },
        ];
        const samples = ["WETH→USDC 고른 티어 slot0 실패", "WETH 경유 요청 JSON-RPC 오류"] as const;

        for (const [index, sample] of samples.entries()) {
          const label = sample;
          if (index > 0) resetSample();
          const plain = usdPriceRuleWith(routedPairs);
          const wethToUsdc = stubPairPrice(plain, {
            chainId: mainnet.id,
            token: weth,
            quoteToken: usdc,
            amountIn: ONE_ETH,
          });
          expect(wethToUsdc.status, label).toBe("ok");
          const wethFee = wethToUsdc.status === "ok" ? wethToUsdc.fee : 500;

          if (sample === "WETH→USDC 고른 티어 slot0 실패") {
            const rule = usdPriceRuleWith([
              ...routedPairs,
              {
                chainId: mainnet.id,
                tokenIn: weth,
                tokenOut: usdc,
                slot0: (query) =>
                  query.fee === wethFee ? { status: "revert" } : defaultUsdPriceRule.slot0(query),
              },
            ]);
            rpc.setUsdPriceRule(rule);
            expect(
              stubPairPrice(rule, {
                chainId: mainnet.id,
                token,
                quoteToken: weth,
                amountIn: ONE_ETH,
              }).status,
              label,
            ).toBe("ok");
            expect(
              stubPairPrice(rule, {
                chainId: mainnet.id,
                token: weth,
                quoteToken: usdc,
                amountIn: ONE_ETH,
              }).status,
              label,
            ).toBe("error");
          } else {
            rpc.setUsdPriceRule(plain);
            rpc.failUsdPriceWhen(both(matchUsdPrice.stage("routed"), matchUsdPrice.target(token)));
          }

          const view = await renderPriceApp({ chainId: mainnet.id, token });
          await waitPriceSettled(() => view.result.current.a, label);
          expect(view.result.current.a.status, label).toBe("error");
          expect(hasPrice(view.result.current.a), label).toBe(false);
          if (sample === "WETH 경유 요청 JSON-RPC 오류") {
            // 전제: 실패시킨 요청이 실제로 WETH 경유 요청이었다.
            const failed = rpc.requests(
              both(matchUsdPrice.stage("routed"), matchUsdPrice.target(token)),
            );
            expect(failed.length, label).toBeGreaterThan(0);
            expect(
              failed.every((request) => request.status === "failed"),
              label,
            ).toBe(true);
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-17
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 스텁은 단가 견적 하위 호출은 성공으로 응답하고, 선택될 티어(수령량이 가장 많은 티어) 풀의 slot0 하위 호출만 실패로 응답한다. 표본: USDC 직접 경로 토큰의 USDC 구간 slot0 실패, WETH 경유 토큰(USDC 직접 구간 네 티어 모두 revert)의 토큰→WETH 구간 slot0 실패를 하나씩 반복한다
     * @when 앱을 렌더링하고 useTokenUsdPrice(Ethereum, 대상 토큰)의 결과가 나오기를 기다린다
     * @then useTokenUsdPrice의 status가 `error`다
     * @then price가 없다
     */
    it(
      "[EC-17] 선택된 티어의 slot0 읽기가 실패하면 error다",
      async () => {
        const { weth, usdc } = ETHEREUM;
        const token = ETH_LINK.address;
        const samples = ["USDC 직접 구간 slot0 실패", "토큰→WETH 구간 slot0 실패"] as const;

        for (const [index, sample] of samples.entries()) {
          const label = sample;
          if (index > 0) resetSample();
          const quoteToken = sample === "USDC 직접 구간 slot0 실패" ? usdc : weth;
          const quoteRule = usdPriceRuleWith(
            sample === "USDC 직접 구간 slot0 실패"
              ? []
              : [{ chainId: mainnet.id, tokenIn: token, tokenOut: usdc, quote: stubRevertQuote }],
          );
          const selected = stubSelectFeeTier(quoteRule, {
            chainId: mainnet.id,
            tokenIn: token,
            tokenOut: quoteToken,
            amountIn: ONE_ETH,
          });
          expect(selected, label).not.toBeNull();
          const rule = usdPriceRuleWith(
            [
              {
                chainId: mainnet.id,
                tokenIn: token,
                tokenOut: quoteToken,
                slot0: (query) =>
                  query.fee === selected!.fee
                    ? { status: "revert" }
                    : defaultUsdPriceRule.slot0(query),
              },
            ],
            quoteRule,
          );
          rpc.setUsdPriceRule(rule);
          expect(
            stubPairPrice(rule, { chainId: mainnet.id, token, quoteToken, amountIn: ONE_ETH })
              .status,
            label,
          ).toBe("error");

          const view = await renderPriceApp({ chainId: mainnet.id, token });
          await waitPriceSettled(() => view.result.current.a, label);
          expect(view.result.current.a.status, label).toBe("error");
          expect(hasPrice(view.result.current.a), label).toBe(false);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("단가 요청과 견적 요청의 구분", () => {
    /**
     * @spec DoD-36
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 금액보다 크게 읽혔다. 받는 USDC를 고르고 금액 `2`(amountInRaw ≠ 10^18, 단가 견적의 토큰 1개 입력과 구별되는 값)를 입력한다. 스텁은 견적에 기본 성공 응답을, 단가에 기본 성공 응답을 주고 모든 aggregate3 요청을 분류해 기록한다. 기존 견적 테스트 파일과 기존 스텁 분류·규칙은 수정하지 않은 상태다
     * @when 입력 반영 대기(300ms)가 지나고 견적과 보내는 ETH 단가 조회가 모두 끝나기를 기다린다
     * @then ETH 단가 요청(tokenIn WETH, 입력 금액 10^18, tokenOut USDC)이 스텁에서 단가(`usd-price`) 분류로 기록되고 견적(`quote`) 분류에 들어가지 않는다
     * @then 같은 시점의 견적 요청(입력 금액 amountInRaw)이 견적(`quote`) 분류로 기록되고 단가 분류에 들어가지 않는다
     * @then 기존 견적 요청 판정(견적 분류 요청의 디코드)으로 얻은 입력 금액이 amountInRaw이고 단가 요청의 입력 금액이 섞이지 않는다
     * @then useSwapQuote()의 status가 `success`이고 quote.amountOut이 스텁 견적 규칙의 수령량이다
     */
    it(
      "[DoD-36] 단가 요청은 단가로, 같은 시점 견적 요청은 견적으로 분류된다",
      async () => {
        const { weth, usdc } = ETHEREUM;
        const view = await renderPriceApp({ chainId: mainnet.id, token: ETH_ADDRESS });
        await chooseToken("out", usdc);
        await typeAmount("2");
        await waitUntil(() => expect(view.result.current.quote.status).toBe("success"));
        await waitPriceSettled(() => view.result.current.a);
        expect(view.result.current.a.status).toBe("success");

        // ETH 단가 요청은 단가 분류다(양성 대조).
        const ethPriceRequests = rpc
          .requests(match.chain(mainnet.id, matchUsdPrice.pair(weth, usdc)))
          .filter((request) =>
            request.usdPrice!.pairs.some(
              (pair) =>
                sameAddress(pair.tokenIn, weth) &&
                sameAddress(pair.tokenOut, usdc) &&
                pair.amountIn === ONE_ETH,
            ),
          );
        expect(ethPriceRequests.length).toBeGreaterThan(0);
        for (const request of ethPriceRequests) expect(request.kind).toBe("usd-price");

        // 견적 분류에는 단가 견적(WETH 1개)이 없다.
        const quoteKind = rpc.requests(match.kind("quote"));
        expect(quoteKind.length).toBeGreaterThan(0);
        for (const request of quoteKind) {
          for (const call of request.quote!.quotes) {
            expect(call.amountIn === ONE_ETH && sameAddress(call.tokenIn, weth)).toBe(false);
          }
        }

        // 견적 요청(amountInRaw = 2 × 10^18)은 견적 분류이고 단가 분류에 없다.
        const quoteRequests = rpc.requests(
          matchQuote.input({
            chainId: mainnet.id,
            tokenIn: weth,
            tokenOut: usdc,
            amountIn: TWO_ETH,
          }),
        );
        expect(quoteRequests.length).toBeGreaterThan(0);
        for (const request of quoteRequests) expect(request.kind).toBe("quote");
        const usdPriceKind = rpc.requests(matchUsdPrice.any);
        for (const request of usdPriceKind) {
          for (const pair of request.usdPrice!.pairs) expect(pair.amountIn).not.toBe(TWO_ETH);
        }

        // 기존 견적 판정(견적 분류 요청의 디코드)의 입력 금액은 모두 amountInRaw다.
        expect(rpc.requests(matchQuote.input()).length).toBe(quoteRequests.length);
        expect(rpc.requests(matchQuote.input({ amountIn: TWO_ETH })).length).toBe(
          quoteRequests.length,
        );

        const best = bestStubQuote(rpc.quoteRule(), {
          chainId: mainnet.id,
          tokenIn: weth,
          tokenOut: usdc,
          amountIn: TWO_ETH,
        });
        expect(best).not.toBeNull();
        expect(view.result.current.quote.quote?.amountOut).toBe(best!.amountOut);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-36
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 금액보다 크게 읽혔다. 받는 USDC를 고르고 금액 `2`를 입력한다. 스텁은 단가에 기본 성공 응답을 준다. 표본 기존 견적 규칙: 견적 응답 붙잡기, 견적 실패 규칙(transport 재시도 대상이 아닌 JSON-RPC 오류)을 하나씩 반복한다. 기존 견적 테스트 파일과 기존 스텁 분류·규칙은 수정하지 않은 상태다
     * @when 입력 반영 대기(300ms)가 지나고 보내는 ETH 단가 조회가 끝나기를 기다린다
     * @then useTokenUsdPrice(Ethereum, NATIVE_ETH_ADDRESS)의 status가 `success`다(기존 견적 붙잡기·실패 규칙이 단가 요청에 적용되지 않는다)
     * @then 붙잡기 표본에서 useSwapQuote()의 status가 `loading`, 실패 표본에서 `error`다
     */
    it(
      "[DoD-36] 기존 견적 붙잡기·실패 규칙은 단가 요청에 적용되지 않는다",
      async () => {
        const { usdc } = ETHEREUM;
        const samples = ["견적 응답 붙잡기", "견적 실패 규칙"] as const;
        for (const [index, sample] of samples.entries()) {
          const label = sample;
          if (index > 0) resetSample();
          const gate = sample === "견적 응답 붙잡기" ? rpc.holdQuote() : undefined;
          if (sample === "견적 실패 규칙") rpc.failQuoteWhen(matchQuote.input());

          const view = await renderPriceApp({ chainId: mainnet.id, token: ETH_ADDRESS });
          await chooseToken("out", usdc);
          await typeAmount("2");
          if (gate) {
            await waitUntil(() => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1));
          }
          await waitPriceSettled(() => view.result.current.a, label);
          expect(view.result.current.a.status, label).toBe("success");
          expect(rpc.requests(matchUsdPrice.any).length, label).toBeGreaterThan(0);

          if (gate) {
            expect(view.result.current.quote.status, label).toBe("loading");
            gate.release();
          } else {
            await waitUntil(() => expect(view.result.current.quote.status, label).toBe("error"));
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });
});
