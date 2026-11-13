import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";

import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceRpcStub,
  type QuoteInputFilter,
  type QuoteRule,
  type RequestMatcher,
  bestStubQuote,
  defaultQuoteRule,
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

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 견적 RPC는 전역 fetch 스텁이 응답·집계·붙잡기한다.
// 시간 판정은 가짜 타이머, 포커스는 window `focus` 이벤트, 탭 숨김은 DoD-28에 한해 `document.visibilityState` 스텁과 `visibilitychange` 이벤트로 만든다.
// 입력이 바뀐 뒤 첫 읽기 실패(EC-7)는 quote-display의 error 상태 case가 맡는다.
// 이 파일에서 "견적 요청 1건"은 선택 체인 QuoterV2 `quoteExactInputSingle` 하위 호출을 담은 JSON-RPC 항목 1건이다(배치 배열은 항목마다 센다).
// 스텁은 입력(체인·토큰·금액)마다 다른 수령량을 돌려줘 어느 입력의 응답이 표시됐는지 data-amount-out-raw로 구분한다.
// 15초 주기 판정은 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 두고, 주기 시작 시점(그 입력의 첫 견적 요청 시각)부터
// 시계를 진행한다(F2 balances.test.tsx와 같은 방식). 300ms 반영 대기 판정은 setTimeout·clearTimeout·Date를 가짜로 둔다.
// 기대 주소(WETH, USDC, DAI)는 제품 config를 쓰지 않고 리터럴로 적는다.

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

// Ethereum 공식 주소(리터럴)
const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const ONE_ETH = 10n ** 18n;

// 기본 입력(보내는 ETH, 받는 USDC, 금액 1)의 견적 요청
const BASE_INPUT: QuoteInputFilter = {
  chainId: mainnet.id,
  tokenIn: ETHEREUM_WETH,
  tokenOut: ETHEREUM_USDC,
  amountIn: ONE_ETH,
};

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

function primaryState(): string | null {
  return screen.getByTestId("primary-button").getAttribute("data-state");
}

function quoteDetails(): HTMLElement | null {
  return screen.queryByTestId("quote-details");
}

function quoteRate(): HTMLElement | null {
  return screen.queryByTestId("quote-rate");
}

function detailsRow(testId: "quote-amount-out" | "quote-price-impact" | "quote-fee-tier") {
  const details = quoteDetails();
  if (!details) throw new Error("quote-details가 없다");
  return within(details).getByTestId(testId);
}

function detailsAmountRaw(): string | null {
  return detailsRow("quote-amount-out").getAttribute("data-amount-out-raw");
}

function skeletonCount(element?: HTMLElement): number {
  return (element ? within(element) : screen).queryAllByTestId("quote-skeleton").length;
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

async function openModal(side: Side) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
}

async function chooseToken(side: Side, address: Address) {
  await openModal(side);
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
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

// wagmi mock 커넥터로 Ethereum에 연결된 앱. 기본 잔액 규칙은 보내는 ETH 잔액이 1·2 ETH보다 훨씬 크다.
async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return view;
}

function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

function expectedRaw(rule: QuoteRule, filter: Required<QuoteInputFilter>): string {
  const best = bestStubQuote(rule, filter);
  if (!best) throw new Error("스텁 규칙에 후보 티어가 없다");
  return best.amountOut.toString();
}

const BASE_INPUT_FULL = BASE_INPUT as Required<QuoteInputFilter>;

// 보내는 ETH, 받는 USDC, 금액 1의 견적이 success로 표시될 때까지 기다린다.
async function renderBaseQuote() {
  const view = await renderMockConnectedApp();
  await chooseToken("out", ETHEREUM_USDC);
  await typeAmount("1");
  await waitUntil(() => expect(view.result.current.quote.status).toBe("success"));
  await waitUntil(() =>
    expect(outAmountRaw()).toBe(expectedRaw(defaultQuoteRule, BASE_INPUT_FULL)),
  );
  await settlePendingWork();
  return view;
}

function quoteCount(matcher: RequestMatcher = matchQuote.input()): number {
  return rpc.requests(matcher).length;
}

// 기본 입력의 첫 견적 요청 시각(가짜 시계). 그 입력의 15초 주기 시작 시점이다.
function basePeriodStart(): number {
  const first = rpc.requests(matchQuote.input(BASE_INPUT))[0];
  if (!first) throw new Error("기본 입력의 견적 요청이 없다");
  return first.at;
}

const CHANGED_RULE = shiftQuoteAmounts(defaultQuoteRule, 777n);
const CHANGED_RAW = () => expectedRaw(CHANGED_RULE, BASE_INPUT_FULL);
const BASE_RAW = () => expectedRaw(defaultQuoteRule, BASE_INPUT_FULL);

function expectIdleNow(result: { current: ReturnType<typeof useProbe> }, label: string) {
  expect(result.current.quote.status, label).toBe("idle");
  expect(skeletonCount(), label).toBe(0);
}

function expectIdleQuoteGone(result: { current: ReturnType<typeof useProbe> }, label: string) {
  expect(result.current.quote.status, label).toBe("idle");
  expect(result.current.quote.quote, label).toBeNull();
  expect(quoteDetails(), label).toBeNull();
  expect(quoteRate(), label).toBeNull();
  expect(outAmountInput().value, label).toBe("");
  expect(outAmountInput().hasAttribute("data-amount-out-raw"), label).toBe(false);
  expect(skeletonCount(), label).toBe(0);
}

// 견적 요청이 응답(성공·실패)을 받을 때까지 기다린다.
async function waitForSettledRequest(matcher: RequestMatcher) {
  await waitUntil(() =>
    expect(rpc.requests(matcher).some((request) => request.status !== "pending")).toBe(true),
  );
  await settlePendingWork();
}

describe("견적 갱신 — 사용자가 지금 입력에 맞는 최신 견적을 본다", () => {
  describe("입력이 바뀌는 경우", () => {
    /**
     * @spec DoD-25
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다. 표본 변경: 금액을 `2`로 바꿈(amountInRaw 변경), 보내는 칸 모달에서 DAI를 고름, 받는 칸 모달에서 DAI를 고름을 하나씩 반복한다(체인 변경은 입력이 기본값으로 돌아가므로 EC-13 case가 맡는다)
     * @when 표본 변경을 일으키고 타이머를 진행하지 않은 채 화면을 확인한다
     * @then useSwapQuote()의 status가 `loading`이고 quote가 `null`이다
     * @then 받는 칸 amount-input에 data-amount-out-raw가 없고 token-field[data-side="out"] 안에 quote-skeleton이 있다
     * @then 받는 칸 amount-input의 값이 빈 문자열이다
     * @then quote-amount-out에 data-amount-out-raw가 없다
     * @then quote-rate, quote-price-impact, quote-fee-tier 각각 안에 quote-skeleton이 있다(이전 견적 값이 남지 않는다)
     */
    it(
      "[DoD-25] 토큰이나 금액 값이 바뀌면 즉시 loading이 되고 이전 견적을 표시하지 않는다",
      async () => {
        const samples = ["금액 2", "보내는 칸 DAI", "받는 칸 DAI"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderBaseQuote();

          // 변경 직전까지 대기한 뒤(모달 열기), 변경과 확인 사이에는 기다리지 않는다.
          if (sample === "금액 2") {
            fireEvent.change(amountInput(), { target: { value: "2" } });
          } else {
            await openModal(sample === "보내는 칸 DAI" ? "in" : "out");
            fireEvent.click(optionRow(ETHEREUM_DAI));
          }

          expect(result.current.quote.status, sample).toBe("loading");
          expect(result.current.quote.quote, sample).toBeNull();
          expect(outAmountInput().hasAttribute("data-amount-out-raw"), sample).toBe(false);
          expect(skeletonCount(field("out")), sample).toBeGreaterThan(0);
          expect(outAmountInput().value, sample).toBe("");
          expect(detailsRow("quote-amount-out").hasAttribute("data-amount-out-raw"), sample).toBe(
            false,
          );
          const rate = quoteRate();
          expect(rate, sample).not.toBeNull();
          expect(skeletonCount(rate!), sample).toBeGreaterThan(0);
          expect(skeletonCount(detailsRow("quote-price-impact")), sample).toBeGreaterThan(0);
          expect(skeletonCount(detailsRow("quote-fee-tier")), sample).toBeGreaterThan(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-41
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다. 견적 요청 수를 기록해 둔다
     * @when 금액을 `1.`로, 이어서 `1.0`으로 바꾸고, 각 변경 직후와 입력 반영 대기(300ms)보다 길고 15초보다 짧게 가짜 시계를 진행한 뒤를 확인한다
     * @then useSwapQuote()의 status가 계속 `success`다
     * @then 받는 칸 amount-input의 data-amount-out-raw가 `1`일 때 값 그대로다
     * @then quote-skeleton이 나타나지 않는다
     * @then 견적 요청 수가 늘지 않는다
     */
    it(
      "[DoD-41] 금액 문자열만 바뀌고 amountInRaw가 같으면 loading이 되지 않고 다시 견적하지 않는다",
      async () => {
        const { result } = await renderBaseQuote();
        const raw = outAmountRaw();
        const before = quoteCount();

        // 입력 반영 대기(setTimeout)와 시계를 가짜로 둔다. 15초 주기(실제 setInterval)는 이 case 안에서 오지 않는다.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

        function expectUnchanged(label: string) {
          expect(result.current.quote.status, label).toBe("success");
          expect(outAmountRaw(), label).toBe(raw);
          expect(skeletonCount(), label).toBe(0);
          expect(quoteCount(), label).toBe(before);
        }

        for (const value of ["1.", "1.0"]) {
          fireEvent.change(amountInput(), { target: { value } });
          expect(amountInput().value).toBe(value);
          expectUnchanged(`${value} 직후`);

          await act(async () => {
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 100);
          });
          await settlePendingWork();
          expectUnchanged(`${value} 반영 대기 후`);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-26
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC가 선택돼 있다. 금액을 `1`로 입력하고 가짜 시계를 200ms 진행한 뒤 `12`로 바꿨다
     * @when 마지막 변경 시점부터 가짜 시계를 300ms 직전까지, 이어서 300ms까지 진행한다
     * @then `1` 입력 시점부터 300ms가 된 시각(마지막 변경 후 100ms)에도 견적 요청이 0건이다
     * @then 마지막 변경 후 300ms 직전까지 견적 요청이 0건이다
     * @then 300ms가 지나면 견적 요청이 1건 발생한다
     * @then 그 요청을 디코드한 입력 금액이 `12`의 amountInRaw다(중간 입력 `1`은 요청하지 않는다)
     */
    it(
      "[DoD-26] 입력 변경이 멈춘 뒤 300ms가 지나면 견적을 요청한다",
      async () => {
        await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM_USDC);
        await settlePendingWork();

        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const seq = rpc.requests().length;
        const quotesSince = () => rpc.requests(match.since(seq, matchQuote.input()));

        const firstAt = Date.now();
        fireEvent.change(amountInput(), { target: { value: "1" } });
        await advanceFakeTimeTo(firstAt + 200);
        fireEvent.change(amountInput(), { target: { value: "12" } });
        const lastAt = Date.now();

        // `1` 입력 시점부터 300ms(마지막 변경 후 100ms)
        await advanceFakeTimeTo(firstAt + DEBOUNCE_MS);
        await settlePendingWork();
        expect(quotesSince()).toEqual([]);

        // 마지막 변경 후 300ms 직전
        await advanceFakeTimeTo(lastAt + DEBOUNCE_MS - 1);
        await settlePendingWork();
        expect(quotesSince()).toEqual([]);

        // 마지막 변경 후 300ms
        await advanceFakeTimeTo(lastAt + DEBOUNCE_MS);
        await waitUntil(() => expect(quotesSince()).toHaveLength(1));
        await settlePendingWork();
        expect(quotesSince()).toHaveLength(1);
        expect(
          quotesSince()[0]!.quote!.quotes.every((call) => call.amountIn === 12n * ONE_ETH),
        ).toBe(true);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("같은 입력을 다시 읽는 경우", () => {
    /**
     * @spec DoD-27
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC, 금액 `1`의 첫 견적이 `success`로 표시됐다. 그 뒤 스텁의 같은 입력 수령량을 다른 값으로 바꿨다
     * @when 가짜 시계를 첫 견적 성공 시점부터 15초, 다시 15초 진행한다
     * @then 15초 직전까지 견적 요청 수가 늘지 않는다
     * @then 15초가 지나면 같은 입력(체인·토큰·amountInRaw)의 견적 요청이 1건 늘고 받는 칸 amount-input의 data-amount-out-raw가 바뀐 스텁 값이다
     * @then 다시 15초가 지나면 같은 입력의 견적 요청이 1건 더 는다
     */
    it(
      "[DoD-27] 같은 입력의 견적을 15초마다 다시 읽는다",
      async () => {
        fakePeriodicTimers();
        await renderBaseQuote();
        const start = basePeriodStart();
        rpc.setQuoteRule(CHANGED_RULE);
        const base = quoteCount();

        await advanceFakeTimeTo(start + REFETCH_MS - 1);
        await settlePendingWork();
        expect(quoteCount()).toBe(base);

        await advanceFakeTimeTo(start + REFETCH_MS);
        await waitUntil(() => expect(quoteCount()).toBe(base + 1));
        await waitUntil(() => expect(outAmountRaw()).toBe(CHANGED_RAW()));

        await advanceFakeTimeTo(start + 2 * REFETCH_MS - 1);
        await settlePendingWork();
        expect(quoteCount()).toBe(base + 1);

        await advanceFakeTimeTo(start + 2 * REFETCH_MS);
        await waitUntil(() => expect(quoteCount()).toBe(base + 2));
        await settlePendingWork();
        expect(quoteCount()).toBe(base + 2);
        // 모든 견적 요청이 같은 입력(체인·토큰·amountIn)이다.
        expect(quoteCount(matchQuote.input(BASE_INPUT))).toBe(base + 2);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-29
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다. 그 뒤 스텁의 같은 입력 수령량을 다른 값으로 바꿨고 15초 주기는 아직 오지 않았다
     * @when window `focus` 이벤트를 발생시킨다
     * @then 같은 입력(체인·토큰·amountInRaw)의 견적 요청이 1건 는다
     * @then 받는 칸 amount-input의 data-amount-out-raw가 바뀐 스텁 값이다
     */
    it(
      "[DoD-29] 창에 포커스가 돌아오면 견적을 다시 읽는다",
      async () => {
        await renderBaseQuote();
        rpc.setQuoteRule(CHANGED_RULE);
        const base = quoteCount();

        focusWindow();

        await waitUntil(() => expect(quoteCount()).toBe(base + 1));
        await waitUntil(() => expect(outAmountRaw()).toBe(CHANGED_RAW()));
        await settlePendingWork();
        expect(quoteCount()).toBe(base + 1);
        expect(quoteCount(matchQuote.input(BASE_INPUT))).toBe(base + 1);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-30
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다. 스텁은 다음 견적 응답을 붙잡고, 풀 때는 다른 수령량을 돌려준다. 표본 다시 읽기 계기: 15초 주기, window `focus` 이벤트를 하나씩 반복한다
     * @when 표본 계기로 다시 읽기를 일으키고, 응답이 붙잡힌 동안 확인한 뒤 응답을 푼다
     * @then 붙잡힌 동안 useSwapQuote()의 status가 `success`이고 primary-button의 data-state가 `quote-ready`다
     * @then 붙잡힌 동안 받는 칸 amount-input과 quote-amount-out의 data-amount-out-raw가 기존 값이고 quote-skeleton이 없다
     * @then 응답을 풀면 받는 칸 amount-input과 quote-amount-out의 data-amount-out-raw가 새 스텁 값으로 바뀐다
     */
    it(
      "[DoD-30] 같은 입력을 다시 읽는 동안 success와 기존 값을 유지하고 새 값이 오면 교체한다",
      async () => {
        const triggers = ["15초 주기", "window focus"] as const;
        for (const [index, trigger] of triggers.entries()) {
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const { result } = await renderBaseQuote();
          const start = basePeriodStart();
          const oldRaw = BASE_RAW();
          rpc.setQuoteRule(CHANGED_RULE);
          const gate = rpc.holdQuote();

          if (trigger === "15초 주기") {
            await advanceFakeTimeTo(start + REFETCH_MS);
          } else {
            focusWindow();
          }
          await waitUntil(() => expect(gate.heldCount, trigger).toBeGreaterThanOrEqual(1));
          await settlePendingWork();

          expect(result.current.quote.status, trigger).toBe("success");
          expect(primaryState(), trigger).toBe("quote-ready");
          expect(outAmountRaw(), trigger).toBe(oldRaw);
          expect(detailsAmountRaw(), trigger).toBe(oldRaw);
          expect(skeletonCount(), trigger).toBe(0);

          gate.release();
          await waitUntil(() => {
            expect(outAmountRaw(), trigger).toBe(CHANGED_RAW());
            expect(detailsAmountRaw(), trigger).toBe(CHANGED_RAW());
          });
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-28
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC, 금액 `1`의 첫 견적이 `success`로 표시됐다. `document.visibilityState`를 `hidden`으로 스텁하고 `visibilitychange` 이벤트를 발생시켜 탭을 숨겼다. 견적 요청 수를 기록해 둔다
     * @when 가짜 시계를 15초 이상 진행한다
     * @then 견적 요청 수가 늘지 않는다
     */
    it(
      "[DoD-28] 탭이 숨겨진 동안에는 15초 주기 읽기를 하지 않는다",
      async () => {
        fakePeriodicTimers();
        await renderBaseQuote();
        const start = basePeriodStart();

        // 탭 숨김(DoD-28 한정 visibility 스텁). afterEach의 restoreAllMocks가 되돌린다.
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await settlePendingWork();
        const base = quoteCount();

        await advanceFakeTimeTo(start + REFETCH_MS);
        await settlePendingWork();
        expect(quoteCount()).toBe(base);

        await advanceFakeTimeTo(start + 2 * REFETCH_MS);
        await settlePendingWork();
        expect(quoteCount()).toBe(base);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("자동 갱신이나 같은 입력의 읽기가 실패한 경우", () => {
    /**
     * @spec EC-9
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다. 그 뒤 스텁이 견적 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답하게 바꿨다. 표본 자동 갱신 계기: 15초 주기, window `focus` 이벤트를 하나씩 반복한다
     * @when 표본 계기로 다시 읽기를 일으키고 실패 응답을 받기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then primary-button의 data-state가 `quote-ready`다
     * @then 받는 칸 amount-input과 quote-amount-out의 data-amount-out-raw가 기존 값이다
     * @then quote-details가 렌더링돼 있고 quote-skeleton이 없다
     */
    it(
      "[EC-9] 자동 갱신 읽기가 실패하면 success와 기존 값을 유지한다",
      async () => {
        const triggers = ["15초 주기", "window focus"] as const;
        for (const [index, trigger] of triggers.entries()) {
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const { result } = await renderBaseQuote();
          const start = basePeriodStart();
          const oldRaw = BASE_RAW();
          const seq = rpc.requests().length;
          rpc.failQuoteWhen(matchQuote.input());

          if (trigger === "15초 주기") {
            await advanceFakeTimeTo(start + REFETCH_MS);
          } else {
            focusWindow();
          }
          await waitUntil(() =>
            expect(
              rpc
                .requests(match.since(seq, matchQuote.input()))
                .some((request) => request.status === "failed"),
              trigger,
            ).toBe(true),
          );
          await settlePendingWork();

          expect(result.current.quote.status, trigger).toBe("success");
          expect(primaryState(), trigger).toBe("quote-ready");
          expect(outAmountRaw(), trigger).toBe(oldRaw);
          expect(detailsAmountRaw(), trigger).toBe(oldRaw);
          expect(quoteDetails(), trigger).not.toBeNull();
          expect(skeletonCount(), trigger).toBe(0);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-10 EC-11
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다. 15초 주기 다시 읽기가 transport 재시도 대상이 아닌 JSON-RPC 오류로 실패했고, 그 뒤 스텁이 다른 수령량의 성공 응답을 돌려주게 바꿨다
     * @when 가짜 시계를 실패한 다시 읽기 시점부터 15초 직전까지, 이어서 15초까지 진행한다
     * @then 15초 직전까지 견적 요청 수가 늘지 않는다
     * @then 15초가 지나면 같은 입력의 견적 요청이 1건 늘고 받는 칸 amount-input의 data-amount-out-raw가 새 스텁 값이다
     */
    it(
      "[EC-10][EC-11] 자동 갱신 실패 뒤 즉시 다시 읽지 않고 다음 15초 주기에 다시 읽는다",
      async () => {
        fakePeriodicTimers();
        await renderBaseQuote();
        const start = basePeriodStart();
        const seq = rpc.requests().length;
        rpc.failQuoteWhen(matchQuote.input());

        await advanceFakeTimeTo(start + REFETCH_MS);
        await waitUntil(() =>
          expect(
            rpc
              .requests(match.since(seq, matchQuote.input()))
              .some((request) => request.status === "failed"),
          ).toBe(true),
        );
        const failed = rpc
          .requests(match.since(seq, matchQuote.input()))
          .find((request) => request.status === "failed")!;
        rpc.failQuoteWhen(null);
        rpc.setQuoteRule(CHANGED_RULE);
        await settlePendingWork();
        const base = quoteCount();

        await advanceFakeTimeTo(failed.at + REFETCH_MS - 1);
        await settlePendingWork();
        expect(quoteCount()).toBe(base);

        await advanceFakeTimeTo(failed.at + REFETCH_MS);
        await waitUntil(() => expect(quoteCount()).toBe(base + 1));
        await waitUntil(() => expect(outAmountRaw()).toBe(CHANGED_RAW()));
        expect(quoteCount(matchQuote.input(BASE_INPUT))).toBe(quoteCount());
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-11
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC가 선택돼 있다. 스텁은 견적 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답한다. 금액 `1`을 입력해 첫 견적 읽기가 실패했다(자동 갱신 실패 표본은 EC-10 case가 맡는다)
     * @when 실패 응답을 받은 뒤 가짜 시계를 실패한 요청 시점부터 다음 15초 주기 직전까지 진행한다
     * @then 실패 뒤 같은 입력의 견적 요청이 0건이다
     */
    it(
      "[EC-11] 견적 읽기가 실패해도 같은 입력으로 즉시 다시 읽지 않는다",
      async () => {
        fakePeriodicTimers();
        const { result } = await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM_USDC);
        rpc.failQuoteWhen(matchQuote.input());
        await typeAmount("1");

        await waitUntil(() =>
          expect(
            rpc
              .requests(matchQuote.input(BASE_INPUT))
              .some((request) => request.status === "failed"),
          ).toBe(true),
        );
        await waitUntil(() => expect(result.current.quote.status).toBe("error"));
        await settlePendingWork();
        const failed = rpc
          .requests(matchQuote.input(BASE_INPUT))
          .find((request) => request.status === "failed")!;
        const failedCount = quoteCount(matchQuote.input(BASE_INPUT));

        await advanceFakeTimeTo(failed.at + REFETCH_MS - 1);
        await settlePendingWork();
        // 실패 뒤 같은 입력의 견적 요청 0건
        expect(quoteCount(matchQuote.input(BASE_INPUT))).toBe(failedCount);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("이전 입력의 응답이 늦게 도착한 경우", () => {
    /**
     * @spec EC-12
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`이며 그 견적 요청을 스텁이 붙잡고 있다. 붙잡힌 동안 입력을 바꿨고, 새 입력의 견적 요청도 스텁이 붙잡는다. 표본 변경: 금액을 `2`로 바꿈, 보내는 칸 모달에서 DAI를 고름, 받는 칸 모달에서 DAI를 고름. 표본 붙잡은 이전 응답: 성공 응답, 실패 응답. 두 표본 목록의 조합을 하나씩 반복한다
     * @when 입력 반영 대기가 지나 새 입력의 견적 요청이 나가 붙잡힌 뒤 이전 입력의 응답을 풀고, 이어서 새 입력의 응답을 푼다
     * @then 이전 응답을 푼 뒤 새 요청이 붙잡힌 동안 useSwapQuote()의 status가 `loading`이고 quote가 `null`이다
     * @then 이전 응답을 푼 뒤 새 요청이 붙잡힌 동안 받는 칸 amount-input과 quote-amount-out에 data-amount-out-raw가 없다(이전 입력의 수령량이 표시되지 않는다)
     * @then 이전 응답을 푼 뒤 새 요청이 붙잡힌 동안 받는 칸 amount-input의 값이 빈 문자열이다
     * @then 새 입력의 응답을 받은 뒤 받는 칸 amount-input의 data-amount-out-raw가 새 입력의 스텁 수령량이다
     */
    it(
      "[EC-12] 토큰이나 금액이 바뀐 뒤 도착한 이전 입력의 응답은 표시와 상태에 반영하지 않는다",
      async () => {
        const changes = [
          { label: "금액 2", input: { ...BASE_INPUT_FULL, amountIn: 2n * ONE_ETH } },
          { label: "보내는 칸 DAI", input: { ...BASE_INPUT_FULL, tokenIn: ETHEREUM_DAI } },
          { label: "받는 칸 DAI", input: { ...BASE_INPUT_FULL, tokenOut: ETHEREUM_DAI } },
        ] as const;
        const outcomes = ["success", "failure"] as const;
        const samples = changes.flatMap((change) =>
          outcomes.map((outcome) => ({ change, outcome })),
        );

        for (const [index, { change, outcome }] of samples.entries()) {
          const label = `${change.label} / 이전 응답 ${outcome}`;
          if (index > 0) resetSample();
          const { result } = await renderMockConnectedApp();
          await chooseToken("out", ETHEREUM_USDC);

          const oldGate = rpc.holdQuote(matchQuote.input(BASE_INPUT));
          await typeAmount("1");
          await waitUntil(() => expect(oldGate.heldCount, label).toBeGreaterThanOrEqual(1));

          const newGate = rpc.holdQuote(matchQuote.input(change.input));
          if (change.label === "금액 2") {
            await typeAmount("2");
          } else {
            await chooseToken(change.label === "보내는 칸 DAI" ? "in" : "out", ETHEREUM_DAI);
          }
          // 반영 대기가 지나 새 입력의 요청이 나가 붙잡혔다.
          await waitUntil(() => expect(newGate.heldCount, label).toBeGreaterThanOrEqual(1));

          if (outcome === "failure") rpc.failQuoteWhen(matchQuote.input(BASE_INPUT));
          oldGate.release();
          await waitForSettledRequest(matchQuote.input(BASE_INPUT));

          expect(result.current.quote.status, label).toBe("loading");
          expect(result.current.quote.quote, label).toBeNull();
          expect(outAmountInput().hasAttribute("data-amount-out-raw"), label).toBe(false);
          expect(detailsRow("quote-amount-out").hasAttribute("data-amount-out-raw"), label).toBe(
            false,
          );
          expect(outAmountInput().value, label).toBe("");

          newGate.release();
          await waitUntil(() =>
            expect(outAmountRaw(), label).toBe(expectedRaw(defaultQuoteRule, change.input)),
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-12
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`이며 그 견적 요청을 스텁이 붙잡고 있다. 붙잡힌 동안 선택 체인을 Base로 바꿔 입력이 기본값으로 돌아갔다. 표본 붙잡은 응답: 성공 응답, 실패 응답을 하나씩 반복한다
     * @when 붙잡은 이전 입력의 응답을 푼다
     * @then useSwapQuote()의 status가 `idle`이고 quote가 `null`이다
     * @then quote-details와 quote-rate가 렌더링되지 않는다
     * @then 받는 칸 amount-input에 data-amount-out-raw가 없다
     */
    it(
      "[EC-12] 체인이 바뀐 뒤 도착한 이전 입력의 응답은 표시와 상태에 반영하지 않는다",
      async () => {
        const outcomes = ["success", "failure"] as const;
        for (const [index, outcome] of outcomes.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderMockConnectedApp();
          await chooseToken("out", ETHEREUM_USDC);

          const oldGate = rpc.holdQuote(matchQuote.input(BASE_INPUT));
          await typeAmount("1");
          await waitUntil(() => expect(oldGate.heldCount, outcome).toBeGreaterThanOrEqual(1));

          act(() => result.current.selected.setSelectedChainId(base.id));
          await waitUntil(() => expect(result.current.selected.selectedChainId).toBe(base.id));

          if (outcome === "failure") rpc.failQuoteWhen(matchQuote.input(BASE_INPUT));
          oldGate.release();
          await waitForSettledRequest(matchQuote.input(BASE_INPUT));

          expect(result.current.quote.status, outcome).toBe("idle");
          expect(result.current.quote.quote, outcome).toBeNull();
          expect(quoteDetails(), outcome).toBeNull();
          expect(quoteRate(), outcome).toBeNull();
          expect(outAmountInput().hasAttribute("data-amount-out-raw"), outcome).toBe(false);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("입력이 기본값이나 빈 금액으로 돌아가는 경우", () => {
    /**
     * @spec EC-13
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다
     * @when 선택 체인을 Base로 바꿔 입력이 기본값(보내는 ETH, 받는 미선택, 금액 빈 값)으로 돌아간다
     * @then 변경 직후(타이머 진행 없이) useSwapQuote()의 status가 `idle`이고 quote-skeleton이 없다
     * @then useSwapQuote()의 status가 `idle`이고 quote가 `null`이다
     * @then quote-details와 quote-rate가 렌더링되지 않는다
     * @then 받는 칸 amount-input의 값이 빈 문자열이고 data-amount-out-raw가 없다
     * @then quote-skeleton이 없다
     */
    it(
      "[EC-13] 선택 체인을 바꿔 입력이 기본값으로 돌아가면 견적이 사라지고 idle이 된다",
      async () => {
        const { result } = await renderBaseQuote();

        act(() => result.current.selected.setSelectedChainId(base.id));

        // 변경 직후(타이머 진행 없이)
        expectIdleNow(result, "변경 직후");
        expect(sameAddress(result.current.form.tokenIn?.address, ETH_ADDRESS)).toBe(true);
        expect(result.current.form.tokenOut).toBeNull();
        expect(amountInput().value).toBe("");

        await settlePendingWork();
        expectIdleQuoteGone(result, "변경 뒤");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-14
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`의 견적이 `success`로 표시됐다. 표본 변경: flip-button을 누름, 받는 칸 모달에서 ETH를 고름(맞바꿈), 보내는 칸 모달에서 USDC를 고름(맞바꿈)을 하나씩 반복한다
     * @when 표본 변경으로 금액이 빈 값이 된다
     * @then 변경 직후(타이머 진행 없이) useSwapQuote()의 status가 `idle`이고 quote-skeleton이 없다
     * @then useSwapQuote()의 status가 `idle`이고 quote가 `null`이다
     * @then quote-details와 quote-rate가 렌더링되지 않는다
     * @then 받는 칸 amount-input의 값이 빈 문자열이고 data-amount-out-raw가 없다
     * @then quote-skeleton이 없다
     */
    it(
      "[EC-14] 뒤집기나 토큰 맞바꿈으로 금액이 비면 견적이 사라지고 idle이 된다",
      async () => {
        const samples = ["flip-button", "받는 칸에서 ETH", "보내는 칸에서 USDC"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderBaseQuote();

          if (sample === "flip-button") {
            fireEvent.click(screen.getByTestId("flip-button"));
          } else if (sample === "받는 칸에서 ETH") {
            await openModal("out");
            fireEvent.click(optionRow(ETH_ADDRESS));
          } else {
            await openModal("in");
            fireEvent.click(optionRow(ETHEREUM_USDC));
          }

          // 변경 직후(타이머 진행 없이)
          expect(amountInput().value, sample).toBe("");
          expectIdleNow(result, `${sample} 직후`);

          await waitUntil(() => expect(tokenModal(), sample).toBeNull());
          await settlePendingWork();
          expectIdleQuoteGone(result, `${sample} 뒤`);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });
});
