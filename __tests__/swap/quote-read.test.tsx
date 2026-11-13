import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceRpcStub,
  type QuoteRule,
  type RequestMatcher,
  STUB_Q96,
  balancesWith,
  bestStubQuote,
  defaultQuoteRule,
  defaultSlot0SqrtPriceX96,
  installBalanceRpcStub,
  match,
  matchQuote,
  sameAddress,
  shiftQuoteAmounts,
} from "../support/rpc-balance-stub";
import {
  advanceFakeTimeTo,
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 견적 RPC 요청은 전역 fetch 스텁이 JSON-RPC 항목 단위로 집계·응답한다.
// 판정은 스펙 §4.1(useSwapQuote 반환값), §4.2(primary-button data-state), §4.3(테스트 식별자·속성)과 스텁이 받은 요청으로 한다.
// 기대 주소(QuoterV2, WETH, USDC)는 제품 config를 쓰지 않고 아래 리터럴로 적는다. 토큰 선택도 이 리터럴 주소의 목록 행을 누른다.

const CASE_TIMEOUT_MS = 30_000;
const MULTI_SAMPLE_TIMEOUT_MS = 90_000;

// 스펙 값: 입력 반영 대기 300ms(DoD-26), 주기 15초(DoD-27)
const DEBOUNCE_MS = 300;
const REFETCH_MS = 15_000;

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

type Side = "in" | "out";

// 체인별 공식 주소(리터럴)
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

// QuoterV2 `quoteExactInputSingle((address,address,uint256,uint24,uint160))` 셀렉터
const QUOTE_EXACT_INPUT_SINGLE_SELECTOR = "c6a5026a";

const ONE_ETH = 10n ** 18n;
const ONE_USDC = 10n ** 6n;

const CONNECTED_STATES = [
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "quote-ready",
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

function outAmountInput(): HTMLInputElement {
  return within(field("out")).getByTestId("amount-input") as HTMLInputElement;
}

function outAmountRaw(): string | null {
  return outAmountInput().getAttribute("data-amount-out-raw");
}

function primaryButton(): HTMLButtonElement {
  return screen.getByTestId("primary-button") as HTMLButtonElement;
}

function primaryState(): string | null {
  return primaryButton().getAttribute("data-state");
}

function quoteDetails(): HTMLElement | null {
  return screen.queryByTestId("quote-details");
}

function detailsRow(testId: "quote-amount-out" | "quote-price-impact" | "quote-fee-tier") {
  const details = quoteDetails();
  if (!details) throw new Error("quote-details가 없다");
  return within(details).getByTestId(testId);
}

function skeletonCount(): number {
  return screen.queryAllByTestId("quote-skeleton").length;
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
  expect(
    sameAddress(
      within(field(side)).getByTestId("token-button").getAttribute("data-token-address") ??
        undefined,
      address,
    ),
  ).toBe(true);
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"));
  });
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { form: useSwapForm(), selected: useSelectedChain(), quote: useSwapQuote() };
}

function appConfig(connector?: CreateConnectorFn) {
  return createWagmiConfig({
    connectors: connector ? [connector] : [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱(선택 체인 Ethereum).
async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return view;
}

// 미연결 앱. 커넥터가 없어 복원 시도가 곧 끝난다.
async function renderDisconnectedApp() {
  const view = renderAppHook(useProbe, { config: appConfig(), initialChainId: mainnet.id });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"));
  return view;
}

function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 15초 주기 판정용: 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 두고 setTimeout은 실제로 둔다
// (F2 balances.test.tsx와 같은 방식. react-query 관찰자 알림의 0ms 타이머가 가짜 시계에 묶이지 않게 한다).
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

// ─── 기대값(테스트 쪽 계산) ──────────────────────────────────────

const Q192 = 2n ** 192n;

// 스펙 DoD-16: (slot0 가격으로 받을 양 − 예상 수령량) / slot0 가격으로 받을 양 × 10000 − fee / 100 (bps).
// slot0 가격(token1/token0) = sqrtPriceX96² / 2^192. 방향은 WETH 치환 후 두 주소의 수치 순서로 정한다.
function expectedPriceImpactBps(params: {
  tokenIn: Address;
  tokenOut: Address;
  sqrtPriceX96: bigint;
  fee: number;
  amountIn: bigint;
  amountOut: bigint;
}): number {
  const zeroForOne = BigInt(params.tokenIn) < BigInt(params.tokenOut);
  const priceX192 = params.sqrtPriceX96 * params.sqrtPriceX96;
  // slot0 가격으로 받을 양 = spotNumerator / spotDenominator
  const spotNumerator = zeroForOne ? params.amountIn * priceX192 : params.amountIn * Q192;
  const spotDenominator = zeroForOne ? Q192 : priceX192;
  const scale = 10n ** 18n;
  const ratio =
    Number((params.amountOut * spotDenominator * scale) / spotNumerator) / Number(scale);
  return (1 - ratio) * 10_000 - params.fee / 100;
}

function quoteRequestsSince(seq: number, matcher: RequestMatcher = matchQuote.input()) {
  return rpc.requests(match.since(seq, matcher));
}

function nextSeq(): number {
  return rpc.requests().length;
}

describe("견적 조회 — 사용자가 고른 체인·토큰·금액으로 Uniswap V3 견적을 받는다", () => {
  describe("두 토큰과 0보다 큰 금액이 정해진 경우", () => {
    /**
     * @spec DoD-1 DoD-4 DoD-16 DoD-37
     * @given mock 커넥터는 Ethereum에 연결된 채로 두고 앱의 선택 체인만 바꾼다(Base·Arbitrum 표본은 연결 체인과 선택 체인이 다르다). 스텁은 견적 aggregate3에 기본 성공 응답을 주고, 고른 티어 풀의 slot0을 가격이 1이 아닌 값(sqrtPriceX96 ≠ 2^96)으로 응답한다(가격이 1이면 스왑 방향이 바뀌어도 가격 영향 값이 같다). 기대 QuoterV2 주소는 체인별 공식 배포 주소를 테스트에 리터럴로 적고 제품 config에서 가져오지 않는다(Ethereum·Arbitrum `0x61fFE014bA17989E743c5F6cB21bF9697530B21e`, Base `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`). 기대 tokenIn·tokenOut(선택 체인의 WETH·USDC)도 체인별 주소를 테스트에 리터럴로 적고 제품 config에서 가져오지 않는다. 표본 선택 체인: Ethereum, Base, Arbitrum. 표본 방향: 보내는 ETH·받는 USDC, 보내는 USDC·받는 ETH. 체인 3 × 방향 2의 조합을 하나씩 반복하며 각 조합에서 금액 `1`을 입력한다
     * @when 입력 반영 대기(300ms)가 지나 견적 요청이 나가고 견적이 끝나기를 기다린다
     * @then 견적 요청이 선택 체인의 RPC 프록시 경로(`/api/rpc/<선택 체인 ID>`)로 간다
     * @then 견적 aggregate3 호출 데이터를 디코드하면 하위 `quoteExactInputSingle` 호출의 대상이 선택 체인의 QuoterV2 주소 리터럴이다
     * @then 디코드한 하위 `quoteExactInputSingle` 호출의 수수료 티어가 100, 500, 3000, 10000 네 개다
     * @then 디코드한 하위 `quoteExactInputSingle` 호출의 tokenIn·tokenOut이 표본 방향대로 선택 체인의 WETH·USDC 주소 리터럴이다(ETH 쪽은 WETH, 보내는 ETH이면 tokenIn이 WETH, 받는 ETH이면 tokenOut이 WETH)
     * @then 디코드한 하위 `quoteExactInputSingle` 호출의 입력 금액이 입력한 금액의 정수 값(`amountInRaw`)이다
     * @then 두 표본 방향 모두에서 useSwapQuote().quote.priceImpactBps가 선택 체인 WETH·USDC 주소(리터럴)의 수치 순서와 표본 방향으로 정한 스왑 방향과 스텁 slot0·수령량·fee로 스펙 DoD-16 식을 따라 테스트가 따로 계산한 값이다
     */
    it(
      "[DoD-1][DoD-4][DoD-16][DoD-37] 선택 체인의 QuoterV2로 네 수수료 티어를 견적하고 ETH 쪽을 WETH로 바꿔 두 방향의 가격 영향을 계산한다",
      async () => {
        const chains: SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        const directions = ["eth-to-usdc", "usdc-to-eth"] as const;
        const samples = chains.flatMap((chainId) =>
          directions.map((direction) => ({ chainId, direction })),
        );

        for (const [index, { chainId, direction }] of samples.entries()) {
          const label = `${chainId} ${direction}`;
          if (index > 0) resetSample();
          const literal = LITERALS[chainId];

          const { result } = await renderMockConnectedApp();
          if (chainId !== mainnet.id) {
            act(() => result.current.selected.setSelectedChainId(chainId));
            await waitUntil(() => expect(result.current.selected.selectedChainId).toBe(chainId));
          }
          if (direction === "eth-to-usdc") {
            await chooseToken("out", literal.usdc);
          } else {
            await chooseToken("in", literal.usdc);
            await chooseToken("out", ETH_ADDRESS);
          }

          const expectedIn = direction === "eth-to-usdc" ? literal.weth : literal.usdc;
          const expectedOut = direction === "eth-to-usdc" ? literal.usdc : literal.weth;
          const amountIn = direction === "eth-to-usdc" ? ONE_ETH : ONE_USDC;

          const seq = nextSeq();
          await typeAmount("1");
          await waitUntil(() => expect(result.current.quote.status, label).toBe("success"));
          await settlePendingWork();

          // 견적 요청이 견적 분류로 잡힌다(양성 대조). 잔액 aggregate3로 분류된 요청에는 QuoterV2 대상이 없다.
          const requests = quoteRequestsSince(seq);
          expect(requests.length, label).toBeGreaterThan(0);
          expect(
            rpc
              .requests(match.since(seq, match.kind("aggregate3")))
              .some((request) =>
                request.tokens.some((token) => sameAddress(token, literal.quoterV2)),
              ),
            label,
          ).toBe(false);

          // 선택 체인의 RPC 프록시 경로(리터럴)로만 간다.
          const quoteFetches = rpc.fetchStub
            .calls()
            .filter((call) => call.body.toLowerCase().includes(QUOTE_EXACT_INPUT_SINGLE_SELECTOR));
          expect(quoteFetches.length, label).toBeGreaterThan(0);
          for (const call of quoteFetches) {
            expect(call.url.endsWith(`/api/rpc/${chainId}`), `${label} ${call.url}`).toBe(true);
          }
          for (const request of requests) expect(request.chainId, label).toBe(chainId);

          for (const request of requests) {
            const subcalls = request.quote!.quotes;
            expect(
              subcalls.map((call) => call.fee).sort((a, b) => a - b),
              label,
            ).toEqual([100, 500, 3000, 10000]);
            for (const call of subcalls) {
              expect(sameAddress(call.target, literal.quoterV2), `${label} target`).toBe(true);
              expect(sameAddress(call.tokenIn, expectedIn), `${label} tokenIn`).toBe(true);
              expect(sameAddress(call.tokenOut, expectedOut), `${label} tokenOut`).toBe(true);
              expect(call.amountIn, `${label} amountIn`).toBe(amountIn);
            }
          }

          const best = bestStubQuote(rpc.quoteRule(), {
            chainId,
            tokenIn: expectedIn,
            tokenOut: expectedOut,
            amountIn,
          });
          expect(best, label).not.toBeNull();
          const slot0 = defaultSlot0SqrtPriceX96(best!.fee);
          // 전제: 고른 티어 풀의 slot0 가격이 1이 아니다.
          expect(slot0, label).not.toBe(STUB_Q96);

          const quote = result.current.quote.quote;
          expect(quote, label).not.toBeNull();
          expect(quote!.amountOut, label).toBe(best!.amountOut);
          expect(quote!.fee, label).toBe(best!.fee);
          expect(quote!.priceImpactBps, label).toBeCloseTo(
            expectedPriceImpactBps({
              tokenIn: expectedIn,
              tokenOut: expectedOut,
              sqrtPriceX96: slot0,
              fee: best!.fee,
              amountIn,
              amountOut: best!.amountOut,
            }),
            6,
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-6 DoD-31
     * @given 저장된 연결이 없고 복원이 끝나 지갑이 미연결이다. 스텁은 견적에 기본 성공 응답을 준다. Ethereum에서 보내는 ETH, 받는 USDC, 금액 `1`을 입력한다
     * @when 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다린다
     * @then 견적 요청(선택 체인 QuoterV2 대상 aggregate3)이 스텁에 도착한다
     * @then useSwapQuote()의 status가 `success`다
     * @then 받는 칸 amount-input의 data-amount-out-raw가 스텁이 고른 티어의 수령량 10진 문자열이다
     * @then quote-details가 렌더링돼 있다
     * @then primary-button의 data-state가 `disconnected`다(견적 상태 `quote-ready`보다 앞선다)
     */
    it(
      "[DoD-6][DoD-31] 지갑 미연결 상태에서도 견적하고 주 버튼은 disconnected다",
      async () => {
        const { result } = await renderDisconnectedApp();
        await chooseToken("out", ETHEREUM.usdc);
        const seq = nextSeq();
        await typeAmount("1");

        await waitUntil(() => expect(result.current.quote.status).toBe("success"));
        const expected = bestStubQuote(rpc.quoteRule(), {
          chainId: mainnet.id,
          tokenIn: ETHEREUM.weth,
          tokenOut: ETHEREUM.usdc,
          amountIn: ONE_ETH,
        })!;
        await waitUntil(() => expect(outAmountRaw()).toBe(expected.amountOut.toString()));

        const requests = quoteRequestsSince(seq, matchQuote.input({ chainId: mainnet.id }));
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every((request) =>
            request.quote!.quotes.every((call) => sameAddress(call.target, ETHEREUM.quoterV2)),
          ),
        ).toBe(true);
        expect(result.current.quote.status).toBe("success");
        expect(quoteDetails()).not.toBeNull();
        expect(primaryState()).toBe("disconnected");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-7 DoD-31
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 1 ETH로 읽혔다. 스텁은 견적에 기본 성공 응답을 준다. 받는 USDC를 고르고 잔액보다 큰 금액 `2`를 입력해 primary-button의 data-state가 `insufficient-balance`다
     * @when 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다린다
     * @then 견적 요청이 스텁에 도착한다
     * @then useSwapQuote()의 status가 `success`다
     * @then 받는 칸 amount-input의 data-amount-out-raw가 스텁이 고른 티어의 수령량 10진 문자열이다
     * @then quote-details 안의 quote-amount-out, quote-price-impact, quote-fee-tier가 표시돼 있다
     * @then primary-button의 data-state가 `insufficient-balance` 그대로다(견적 상태 `quote-ready`보다 앞선다)
     */
    it(
      "[DoD-7][DoD-31] 잔액 부족 상태에서도 견적하고 받는 칸과 견적 정보를 표시하며 주 버튼은 insufficient-balance다",
      async () => {
        rpc.setBalances(balancesWith({ [ETH_ADDRESS]: ONE_ETH }));
        const { result } = await renderMockConnectedApp();
        await waitUntil(() =>
          expect(
            within(field("in")).queryByTestId("balance")?.getAttribute("data-balance-raw"),
          ).toBe(ONE_ETH.toString()),
        );
        await chooseToken("out", ETHEREUM.usdc);
        const seq = nextSeq();
        await typeAmount("2");
        await waitUntil(() => expect(primaryState()).toBe("insufficient-balance"));

        await waitUntil(() => expect(result.current.quote.status).toBe("success"));
        const expected = bestStubQuote(rpc.quoteRule(), {
          chainId: mainnet.id,
          tokenIn: ETHEREUM.weth,
          tokenOut: ETHEREUM.usdc,
          amountIn: 2n * ONE_ETH,
        })!;
        await waitUntil(() => expect(outAmountRaw()).toBe(expected.amountOut.toString()));

        expect(
          quoteRequestsSince(seq, matchQuote.input({ amountIn: 2n * ONE_ETH })).length,
        ).toBeGreaterThan(0);
        expect(result.current.quote.status).toBe("success");
        expect(detailsRow("quote-amount-out")).toBeTruthy();
        expect(detailsRow("quote-price-impact")).toBeTruthy();
        expect(detailsRow("quote-fee-tier")).toBeTruthy();
        expect(primaryState()).toBe("insufficient-balance");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("두 토큰이 ETH와 WETH인 경우", () => {
    /**
     * @spec EC-6
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 토큰 잔액이 금액보다 크게 읽혔다. 표본 순서: 보내는 ETH·받는 WETH, 보내는 WETH·받는 ETH를 하나씩 반복하며 금액 `1`을 입력한다
     * @when 타이머를 진행하지 않은 채 확인하고, 이어서 가짜 시계를 300ms와 15초를 넘게 진행한다
     * @then 타이머를 진행하지 않은 상태에서 useSwapQuote()의 status가 `no-route`이고 quote가 `null`이다
     * @then 타이머를 진행하지 않은 상태에서 primary-button의 data-state가 `no-route`이고 quote-skeleton이 없다
     * @then 300ms와 15초를 넘게 진행한 뒤에도 카드 잔액 읽기(eth_getBalance·balanceOf·잔액 aggregate3)로 분류되지 않는 모든 JSON-RPC 항목(메서드 무관)이 0건이다
     */
    it(
      "[EC-6] ETH와 WETH는 두 순서 모두 RPC 요청과 반영 대기 없이 즉시 no-route다",
      async () => {
        const samples = ["eth-to-weth", "weth-to-eth"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          // 기본 잔액 규칙은 보내는 토큰(ETH·WETH) 모두 1 ETH보다 훨씬 크다.
          const { result } = await renderMockConnectedApp();
          if (sample === "eth-to-weth") {
            await chooseToken("out", ETHEREUM.weth);
          } else {
            await chooseToken("in", ETHEREUM.weth);
            await chooseToken("out", ETH_ADDRESS);
          }
          await waitUntil(() =>
            expect(
              within(field("in")).queryByTestId("balance")?.getAttribute("data-balance-raw"),
            ).toBeTruthy(),
          );
          await settlePendingWork();

          // 입력 반영 대기(setTimeout)와 주기(setInterval), 시계를 가짜로 둔다.
          vi.useFakeTimers({
            toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
          });
          const seq = nextSeq();
          fireEvent.change(amountInput(), { target: { value: "1" } });

          // 타이머를 진행하지 않은 상태
          expect(amountInput().value, sample).toBe("1");
          expect(result.current.quote.status, sample).toBe("no-route");
          expect(result.current.quote.quote, sample).toBeNull();
          expect(primaryState(), sample).toBe("no-route");
          expect(skeletonCount(), sample).toBe(0);

          // 300ms와 15초를 넘게 진행
          await act(async () => {
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(REFETCH_MS + 1);
          });
          await settlePendingWork();
          expect(rpc.requests(match.since(seq, matchQuote.notBalance)), sample).toEqual([]);
          expect(result.current.quote.status, sample).toBe("no-route");
          vi.useRealTimers();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("견적 1회가 보내는 RPC 요청 수", () => {
    /**
     * @spec DoD-8
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC가 선택돼 있다. 스텁은 견적에 성공 응답을 주고, 계기 1회 동안 카드 잔액 읽기(eth_getBalance·balanceOf·잔액 aggregate3)로 분류되지 않는 모든 JSON-RPC 항목(메서드 무관, `eth_call` 외의 `eth_blockNumber`·`eth_chainId` 등도 포함)을 항목 단위(배치 배열은 항목마다)로 센다. 표본 견적 계기: 금액 `1` 입력 후 첫 반영, 금액을 `2`로 바꾼 뒤 반영, 15초 주기 다시 읽기(가짜 타이머), window `focus` 다시 읽기를 하나씩 반복한다
     * @when 표본 계기를 일으키고 그 견적이 끝나 data-amount-out-raw가 갱신되기를 기다린다
     * @then 표본 계기 1회당 센 JSON-RPC 항목 수가 2 이하다
     */
    it(
      "[DoD-8] 성공 경로에서 견적 1회의 RPC 요청은 2건 이하다",
      async () => {
        fakePeriodicTimers();
        const { result } = await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM.usdc);
        await settlePendingWork();

        const expectedRaw = (rule: QuoteRule, amountIn: bigint) =>
          bestStubQuote(rule, {
            chainId: mainnet.id,
            tokenIn: ETHEREUM.weth,
            tokenOut: ETHEREUM.usdc,
            amountIn,
          })!.amountOut.toString();

        // 계기 하나의 잔액 읽기가 아닌 JSON-RPC 항목 수를 센다.
        async function countTrigger(label: string, trigger: () => Promise<void>, raw: string) {
          const seq = nextSeq();
          await trigger();
          await waitUntil(() => expect(outAmountRaw(), label).toBe(raw));
          await settlePendingWork();
          const counted = rpc.requests(match.since(seq, matchQuote.notBalance)).length;
          // 양성 대조: 견적 요청이 집계 대상에 잡힌다.
          expect(counted, label).toBeGreaterThanOrEqual(1);
          expect(counted, label).toBeLessThanOrEqual(2);
        }

        await countTrigger(
          "금액 1 첫 반영",
          () => typeAmount("1"),
          expectedRaw(defaultQuoteRule, ONE_ETH),
        );
        await countTrigger(
          "금액 2 반영",
          () => typeAmount("2"),
          expectedRaw(defaultQuoteRule, 2n * ONE_ETH),
        );
        expect(result.current.quote.status).toBe("success");

        // 금액 2 입력의 주기 시작 시점: 그 입력의 첫 견적 요청 시각(가짜 시계)
        const periodStart = rpc.requests(matchQuote.input({ amountIn: 2n * ONE_ETH }))[0]!.at;

        const periodicRule = shiftQuoteAmounts(defaultQuoteRule, 777n);
        rpc.setQuoteRule(periodicRule);
        await countTrigger(
          "15초 주기 다시 읽기",
          () => advanceFakeTimeTo(periodStart + REFETCH_MS),
          expectedRaw(periodicRule, 2n * ONE_ETH),
        );

        const focusRule = shiftQuoteAmounts(defaultQuoteRule, 1_554n);
        rpc.setQuoteRule(focusRule);
        await countTrigger(
          "window focus 다시 읽기",
          async () => focusWindow(),
          expectedRaw(focusRule, 2n * ONE_ETH),
        );
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("티어 풀의 slot0 읽기가 실패한 경우", () => {
    /**
     * @spec EC-16
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`이다. 스텁은 `quoteExactInputSingle` 하위 호출은 성공으로 응답하고, 수령량이 가장 많은 티어 풀의 `slot0` 읽기만 실패로 응답한다
     * @when 입력 반영 대기(300ms)가 지나고 견적 응답을 받기를 기다린다
     * @then useSwapQuote()의 status가 `error`이고 quote가 `null`이다
     * @then primary-button의 data-state가 `quote-error`다
     * @then quote-details가 렌더링되지 않는다
     * @then 받는 칸 amount-input에 data-amount-out-raw가 없다
     */
    it(
      "[EC-16] 견적은 성공해도 고른 티어 풀의 slot0 읽기가 실패하면 error다",
      async () => {
        const chosen = bestStubQuote(defaultQuoteRule, {
          chainId: mainnet.id,
          tokenIn: ETHEREUM.weth,
          tokenOut: ETHEREUM.usdc,
          amountIn: ONE_ETH,
        })!;
        rpc.setQuoteRule({
          quote: defaultQuoteRule.quote,
          slot0: (query) =>
            query.fee === chosen.fee ? { status: "revert" } : defaultQuoteRule.slot0(query),
        });

        const { result } = await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM.usdc);
        const seq = nextSeq();
        await typeAmount("1");

        await waitUntil(() => expect(result.current.quote.status).toBe("error"));
        await settlePendingWork();
        // 전제: 견적 요청 자체는 성공했다(하위 호출 slot0만 실패).
        const requests = quoteRequestsSince(seq);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((request) => request.status === "ok")).toBe(true);

        expect(result.current.quote.status).toBe("error");
        expect(result.current.quote.quote).toBeNull();
        expect(primaryState()).toBe("quote-error");
        expect(quoteDetails()).toBeNull();
        expect(outAmountInput().hasAttribute("data-amount-out-raw")).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-16 DoD-2
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`이다. 스텁은 고르지 않을 한 티어(풀이 없는 티어)의 `quoteExactInputSingle` 하위 호출을 revert로 응답한다. 표본 그 풀의 `slot0` 응답 형태: aggregate3 결과 `success: true`에 빈 반환값 `0x`(풀 주소에 코드가 없을 때의 실제 체인 형태), aggregate3 결과 `success: false`(실패)를 하나씩 반복한다. 나머지 티어는 견적과 `slot0`을 모두 성공으로 응답하며 그중 한 티어의 수령량이 가장 많다
     * @when 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then quote.fee와 quote-fee-tier의 data-fee가 성공한 티어 중 수령량이 가장 많은 티어(DoD-2 규칙)다
     * @then quote.amountOut과 받는 칸 amount-input의 data-amount-out-raw가 그 티어의 스텁 수령량이다
     * @then primary-button의 data-state가 `quote-ready`다
     */
    it(
      "[EC-16][DoD-2] 고르지 않은 티어의 견적과 slot0만 실패하면 success이고 남은 후보에서 티어를 고른다",
      async () => {
        // 풀이 없는 티어: 3000. 견적은 revert, slot0은 표본 형태로 응답한다.
        const missingFee = 3000;
        const slot0Forms = ["empty", "revert"] as const;

        for (const [index, form] of slot0Forms.entries()) {
          if (index > 0) resetSample();
          const rule: QuoteRule = {
            quote: (query) =>
              query.fee === missingFee ? { status: "revert" } : defaultQuoteRule.quote(query),
            slot0: (query) =>
              query.fee === missingFee ? { status: form } : defaultQuoteRule.slot0(query),
          };
          rpc.setQuoteRule(rule);
          const expected = bestStubQuote(rule, {
            chainId: mainnet.id,
            tokenIn: ETHEREUM.weth,
            tokenOut: ETHEREUM.usdc,
            amountIn: ONE_ETH,
          })!;
          expect(expected.fee, form).not.toBe(missingFee);

          const { result } = await renderMockConnectedApp();
          await chooseToken("out", ETHEREUM.usdc);
          await typeAmount("1");

          await waitUntil(() => expect(result.current.quote.status, form).toBe("success"));
          await waitUntil(() => expect(outAmountRaw(), form).toBe(expected.amountOut.toString()));

          const quote = result.current.quote.quote!;
          expect(quote.fee, form).toBe(expected.fee);
          expect(detailsRow("quote-fee-tier").getAttribute("data-fee"), form).toBe(
            String(expected.fee),
          );
          expect(quote.amountOut, form).toBe(expected.amountOut);
          expect(primaryState(), form).toBe("quote-ready");
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
