import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";

import { createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useSlippage } from "@/providers/slippage-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceRpcStub,
  type QuoteInputFilter,
  type QuoteRule,
  type RequestMatcher,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  defaultQuoteRule,
  installBalanceRpcStub,
  matchQuote,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  advanceFakeTimeTo,
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  waitUntil,
  yieldToPendingWork,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 앱 Provider 안의 프로브로 useSwapQuote()·useAmountOutMinimum()을 읽는다.
// 지갑은 mock 커넥터 또는 스텁 EIP-1193을 쓴다. RPC는 전역 fetch URL 라우팅 스텁이 응답하고, 견적은 aggregate3 스텁이 응답한다.
// 시간과 입력은 가짜 타이머와 DOM 이벤트로 다룬다. `vi.mock`은 쓰지 않는다.
// 문구 판정: 표시 문구를 기대 문자열 리터럴과 비교하는 것은 DoD-18·EC-2에만 허용한다(스텁 고정 수령량에 대한 리터럴, 제품 함수로 만들지 않는다). 그 밖의 문구 판정은 하지 않는다(사용자 확정).
// 문구 판정 예외(DoD-19): quote-slippage 값 텍스트를 aria-checked="true"인 slippage-option의 텍스트와 비교하는 것을 허용한다(제품 출력끼리 비교, 리터럴 없음, 사용자 확정).
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.

// 이 파일에서 "견적 JSON-RPC 항목"은 QuoterV2 `quoteExactInputSingle` 하위 호출을 담은 aggregate3 `eth_call` 항목이다(배치 배열은 항목마다 센다).
// 기대 최소 수령량은 제품 `getAmountOutMinimum`을 쓰지 않고 리터럴이나 아래 테스트 쪽 bigint 식으로 만든다.
// 기대 주소(WETH, USDC)와 받는 토큰 심볼은 제품 config를 쓰지 않고 리터럴로 적는다.
// 15초 주기 판정은 F3 quote-refresh와 같이 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 둔다.

const CASE_TIMEOUT_MS = 30_000;
const MULTI_SAMPLE_TIMEOUT_MS = 90_000;

// 스펙 값: 입력 반영 대기 300ms, 주기 15초(F3 DoD-26·DoD-27)
const DEBOUNCE_MS = 300;
const REFETCH_MS = 15_000;

// 스펙 DoD-15의 분모(테스트 쪽 계산)
const BPS_DENOMINATOR = 10_000n;

type PresetBps = 10 | 50 | 100;

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
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_SYMBOL = "USDC";

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

// ─── 기대값(테스트 쪽 계산) ──────────────────────────────────────

// 스펙 DoD-15 식: amountOut * (10000 - bps) / 10000 (bigint 나눗셈, 내림)
function expectedMinimum(amountOut: bigint, bps: PresetBps): bigint {
  return (amountOut * (BPS_DENOMINATOR - BigInt(bps))) / BPS_DENOMINATOR;
}

// 견적 고정 규칙: 500 티어가 `amountOut`으로 가장 많고, 나머지 티어는 그 절반(0이면 후보에서 빠진다)이다.
const BEST_FEE = 500;

function fixedQuoteRule(amountOut: bigint): QuoteRule {
  return {
    quote: (query) => ({
      status: "ok",
      amountOut: query.fee === BEST_FEE ? amountOut : amountOut / 2n,
      sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
    }),
    slot0: defaultQuoteRule.slot0,
  };
}

// 네 티어의 `quoteExactInputSingle` 하위 호출이 모두 revert하는 규칙(no-route)
const NO_ROUTE_RULE: QuoteRule = {
  quote: () => ({ status: "revert" }),
  slot0: defaultQuoteRule.slot0,
};

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

function quoteDetails(): HTMLElement | null {
  return screen.queryByTestId("quote-details");
}

type DetailsRowId = "quote-amount-out" | "quote-amount-out-minimum" | "quote-slippage";

// quote-details 안의 행
function detailsRow(testId: DetailsRowId): HTMLElement {
  const details = quoteDetails();
  if (!details) throw new Error("quote-details가 없다");
  return within(details).getByTestId(testId);
}

function detailsAmountRaw(): string | null {
  return detailsRow("quote-amount-out").getAttribute("data-amount-out-raw");
}

function minimumRaw(): string | null {
  return detailsRow("quote-amount-out-minimum").getAttribute("data-amount-out-minimum-raw");
}

function skeletonCount(element?: HTMLElement): number {
  return (element ? within(element) : screen).queryAllByTestId("quote-skeleton").length;
}

// 행의 값 자리(행 이름 `term` 제외, `definition` 역할) 텍스트
function rowValueText(row: HTMLElement): string {
  return (within(row).getByRole("definition").textContent ?? "").trim();
}

// 값 자리 텍스트를 공백으로 나눈 조각(수량, 심볼)
function rowValueParts(row: HTMLElement): string[] {
  return rowValueText(row)
    .split(/\s+/)
    .filter((part) => part !== "");
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

// ─── 슬리피지 팝오버 ──────────────────────────────────────────────

function slippageButton(): HTMLElement {
  return screen.getByTestId("slippage-button");
}

function slippagePopover(): HTMLElement | null {
  return screen.queryByTestId("slippage-popover");
}

function expectPopoverOpen(label?: string) {
  expect(slippagePopover(), label).not.toBeNull();
  expect(slippageButton().getAttribute("aria-expanded"), label).toBe("true");
}

// 닫혀 있으면 slippage-button을 눌러 연다.
async function openSlippagePopover() {
  if (slippageButton().getAttribute("aria-expanded") !== "true") {
    fireEvent.click(slippageButton());
  }
  await waitUntil(() => expectPopoverOpen());
}

function slippageOptions(): HTMLElement[] {
  const popover = slippagePopover();
  if (!popover) throw new Error("slippage-popover가 없다");
  return within(popover).getAllByTestId("slippage-option");
}

function slippageOption(bps: PresetBps): HTMLElement {
  const option = slippageOptions().find(
    (element) => element.getAttribute("data-slippage-bps") === String(bps),
  );
  if (!option) throw new Error(`slippage-option ${bps}가 없다`);
  return option;
}

// 팝오버를 열고 프리셋을 고른다. 고른 뒤에도 팝오버는 열린 채로 둔다.
async function chooseSlippage(bps: PresetBps) {
  await openSlippagePopover();
  fireEvent.click(slippageOption(bps));
  await waitUntil(() => expect(slippageOption(bps).getAttribute("aria-checked")).toBe("true"));
}

// aria-checked="true"인 slippage-option(하나여야 한다)
function checkedSlippageOption(): HTMLElement {
  const checked = slippageOptions().filter(
    (element) => element.getAttribute("aria-checked") === "true",
  );
  expect(checked).toHaveLength(1);
  return checked[0];
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { quote: useSwapQuote(), minimum: useAmountOutMinimum(), slippage: useSlippage() };
}

function appConfig(connector?: CreateConnectorFn) {
  return createWagmiConfig({
    connectors: connector ? [connector] : [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱(config·QueryClient는 렌더마다 새로 만든다). 기본 잔액 규칙은 보내는 ETH 잔액이 1 ETH보다 훨씬 크다.
async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return view;
}

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다.
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

function quoteCount(matcher: RequestMatcher = matchQuote.input()): number {
  return rpc.requests(matcher).length;
}

// 기본 입력의 첫 견적 요청 시각(가짜 시계). 그 입력의 15초 주기 시작 시점이다.
function basePeriodStart(): number {
  const first = rpc.requests(matchQuote.input(BASE_INPUT))[0];
  if (!first) throw new Error("기본 입력의 견적 요청이 없다");
  return first.at;
}

// 스텁 고정 수령량으로 보내는 ETH, 받는 USDC, 금액 1의 견적이 success로 표시될 때까지 기다린다.
async function renderBaseQuote(amountOut: bigint) {
  rpc.setQuoteRule(fixedQuoteRule(amountOut));
  const view = await renderMockConnectedApp();
  await chooseToken("out", ETHEREUM_USDC);
  await typeAmount("1");
  await waitUntil(() => expect(view.result.current.quote.status).toBe("success"));
  await waitUntil(() => expect(detailsAmountRaw()).toBe(amountOut.toString()));
  await settlePendingWork();
  return view;
}

describe("최소 수령량과 슬리피지 행 — 사용자가 견적 수령량에 슬리피지를 반영한 최소 수령량을 본다", () => {
  describe("견적이 성공한 경우", () => {
    /**
     * @spec DoD-17 DoD-18 DoD-19 DoD-22 DoD-24
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC가 선택돼 있다. 스텁은 견적 수령량을 고정 값 Q로 응답한다. Q는 2^53(9007199254740992)보다 커서 Number로 계산하면 틀리는 크기이고(예: `12_345_678_901_234_567n` raw USDC), 100의 배수가 아니어서 세 프리셋 모두에서 Q × (10000 − bps)가 10000으로 나누어떨어지지 않아 내림이 드러나며, 그 최소 수령량이 USDC decimals(6) 기준으로 천 단위 구분과 소수 4자리를 넘는 자리의 버림이 드러나는 값이다. 테스트는 프리셋마다 기대 최소 수령량을 리터럴이나 테스트 쪽 bigint 식 `Q * (10000n - bps) / 10000n`으로, 기대 표시 문자열을 리터럴로 적어 둔다(제품 함수로 만들지 않는다). 표본 슬리피지: `10`, `50`, `100`을 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링하고 금액을 입력하기 전(견적 전)에 slippage-option으로 표본 프리셋을 고른다(같은 렌더에서 프리셋만 바꿔 반복하지 않는다)
     * @when 새로 렌더링한 앱에서 표본 프리셋을 고른 뒤 금액 `1`을 입력하고, 입력 반영 대기(300ms)가 지나 견적이 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`이고 quote.amountOut이 Q다
     * @then quote-details 안에 quote-amount-out-minimum과 quote-slippage가 있다
     * @then quote-amount-out-minimum의 data-amount-out-minimum-raw가 표본 프리셋의 기대 최소 수령량의 10진 문자열이다
     * @then quote-amount-out-minimum의 표시 값이 표본 프리셋의 기대 문자열 리터럴과 받는 토큰 심볼 `USDC`다
     * @then quote-amount-out-minimum 안에 quote-skeleton이 없다
     * @then quote-slippage의 data-slippage-bps가 표본 프리셋 값이다
     * @then quote-slippage 값 텍스트가 aria-checked="true"인 slippage-option의 텍스트와 같다(제품 출력끼리 비교, 리터럴 없음)
     * @then useAmountOutMinimum()이 표본 프리셋의 기대 최소 수령량(bigint)이다
     */
    it(
      "[DoD-17][DoD-18][DoD-19][DoD-22][DoD-24] 세 프리셋마다 최소 수령량 속성·표시·훅 값과 슬리피지 행이 현재 슬리피지를 따른다",
      async () => {
        // 스텁 고정 수령량: 12,345,678,901.234567 USDC(6 decimals). 2^53보다 크고 100의 배수가 아니다.
        const Q = 12_345_678_901_234_567n;
        // 프리셋별 기대 최소 수령량(리터럴)과 표시 문자열(소수 4자리 버림, 천 단위 쉼표를 손으로 적음)
        const samples: { bps: PresetBps; minimum: bigint; display: string }[] = [
          { bps: 10, minimum: 12_333_333_222_333_332n, display: "12,333,333,222.3333" },
          { bps: 50, minimum: 12_283_950_506_728_394n, display: "12,283,950,506.7283" },
          { bps: 100, minimum: 12_222_222_112_222_221n, display: "12,222,222,112.2222" },
        ];
        // 표본 전제: Number로 계산하면 틀리는 크기이고 세 프리셋 모두 내림이 드러난다.
        expect(Q > 2n ** 53n).toBe(true);
        expect(Q % 100n).not.toBe(0n);

        for (const [index, { bps, minimum, display }] of samples.entries()) {
          const label = `slippage ${bps}`;
          expect(expectedMinimum(Q, bps), label).toBe(minimum);
          expect((Q * (BPS_DENOMINATOR - BigInt(bps))) % BPS_DENOMINATOR, label).not.toBe(0n);

          if (index > 0) resetSample();
          rpc.setQuoteRule(fixedQuoteRule(Q));
          const { result } = await renderMockConnectedApp();
          await chooseToken("out", ETHEREUM_USDC);

          // 견적 전에 프리셋을 고른다.
          await chooseSlippage(bps);
          expect(result.current.slippage.slippageBps, label).toBe(bps);
          expect(result.current.quote.status, label).toBe("idle");
          expect(quoteCount(), label).toBe(0);

          await typeAmount("1");
          await waitUntil(() => expect(result.current.quote.status, label).toBe("success"));
          await waitUntil(() => expect(minimumRaw(), label).toBe(minimum.toString()));
          await settlePendingWork();

          expect(result.current.quote.status, label).toBe("success");
          expect(result.current.quote.quote?.amountOut, label).toBe(Q);

          const details = quoteDetails();
          expect(details, label).not.toBeNull();
          const minimumRow = within(details!).getByTestId("quote-amount-out-minimum");
          const slippageRow = within(details!).getByTestId("quote-slippage");

          expect(minimumRow.getAttribute("data-amount-out-minimum-raw"), label).toBe(
            minimum.toString(),
          );
          expect(rowValueParts(minimumRow), label).toEqual([display, USDC_SYMBOL]);
          expect(skeletonCount(minimumRow), label).toBe(0);

          expect(slippageRow.getAttribute("data-slippage-bps"), label).toBe(String(bps));
          await openSlippagePopover();
          const checked = checkedSlippageOption();
          expect(checked.getAttribute("data-slippage-bps"), label).toBe(String(bps));
          expect(rowValueText(slippageRow), label).toBe((checked.textContent ?? "").trim());

          expect(result.current.minimum, label).toBe(minimum);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("최소 수령량이 0인 경우", () => {
    /**
     * @spec EC-2 DoD-18
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC가 선택돼 있으며 슬리피지는 초기값 `50`이다. 스텁은 견적 수령량을 `1`(raw)로 응답한다. 테스트는 기대 표시 문자열 `0`을 리터럴로 적어 둔다
     * @when 금액 `1`을 입력하고 입력 반영 대기(300ms)가 지나 견적이 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`이고 quote.amountOut이 `1n`이다
     * @then quote-amount-out-minimum의 data-amount-out-minimum-raw가 `0`이다
     * @then quote-amount-out-minimum의 표시 값이 `0`과 받는 토큰 심볼 `USDC`다
     * @then useAmountOutMinimum()이 `0n`이다
     */
    it(
      "[EC-2][DoD-18] 수령량 1이면 최소 수령량은 0으로 표시된다",
      async () => {
        rpc.setQuoteRule(fixedQuoteRule(1n));
        const { result } = await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM_USDC);
        expect(result.current.slippage.slippageBps).toBe(50);

        await typeAmount("1");
        await waitUntil(() => expect(result.current.quote.status).toBe("success"));
        await waitUntil(() => expect(minimumRaw()).toBe("0"));
        await settlePendingWork();

        expect(result.current.quote.status).toBe("success");
        expect(result.current.quote.quote?.amountOut).toBe(1n);
        expect(minimumRaw()).toBe("0");
        expect(rowValueParts(detailsRow("quote-amount-out-minimum"))).toEqual(["0", USDC_SYMBOL]);
        expect(result.current.minimum).toBe(0n);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("견적을 기다리는 경우", () => {
    /**
     * @spec DoD-20 DoD-21 DoD-19 DoD-22 DoD-25
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC가 선택돼 있으며 slippage-option으로 슬리피지 `100`을 골라 두었다. 두 표본 모두 스텁은 고정 수령량 Q의 견적 응답을 붙잡도록 해 둔다. 표본: 금액 `1` 입력 직후 입력 반영 대기(300ms) 중, 금액 `1` 반영 뒤 스텁이 견적 응답을 붙잡고 있는 중을 하나씩 반복한다
     * @when 표본 상태에서 화면과 훅 값을 확인하고 quote-slippage 값 자리 텍스트(행 이름 제외)를 기록한 뒤, 입력 반영 대기 표본은 대기를 마저 지나 견적 요청이 붙잡히게 하고, 두 표본 모두 붙잡은 응답을 풀어 견적이 `success`가 되기를 기다린다
     * @then loading 중 useSwapQuote()의 status가 `loading`이다
     * @then loading 중 quote-details 안에 quote-amount-out-minimum과 quote-slippage가 있다
     * @then loading 중 quote-amount-out-minimum 안에 quote-skeleton이 있고 data-amount-out-minimum-raw 속성이 없다
     * @then loading 중 quote-slippage 안에 quote-skeleton이 없고 data-slippage-bps가 `100`이다
     * @then loading 중 quote-slippage 값 자리 텍스트가 비어 있지 않다
     * @then 응답을 풀어 useSwapQuote()의 status가 `success`가 된 뒤 quote-slippage 값 자리 텍스트가 loading 중 기록한 텍스트와 같다(문구 리터럴과 비교하지 않는다)
     * @then loading 중 useAmountOutMinimum()이 `null`이다
     */
    it(
      "[DoD-20][DoD-21][DoD-19][DoD-22][DoD-25] loading이면 최소 수령량은 스켈레톤이고 슬리피지 행은 값을 표시한다",
      async () => {
        rpc.setQuoteRule(fixedQuoteRule(1_234_567_891_234n));
        const { result } = await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM_USDC);
        await chooseSlippage(100);
        await settlePendingWork();
        // 두 표본 모두 견적 응답을 붙잡는다.
        const gate = rpc.holdQuote();

        // loading 중 판정. quote-slippage 값 자리 텍스트를 돌려준다.
        function expectLoading(label: string): string {
          expect(result.current.quote.status, label).toBe("loading");
          const details = quoteDetails();
          expect(details, label).not.toBeNull();
          const minimumRow = within(details!).getByTestId("quote-amount-out-minimum");
          const slippageRow = within(details!).getByTestId("quote-slippage");
          expect(skeletonCount(minimumRow), label).toBeGreaterThan(0);
          expect(minimumRow.hasAttribute("data-amount-out-minimum-raw"), label).toBe(false);
          expect(skeletonCount(slippageRow), label).toBe(0);
          expect(slippageRow.getAttribute("data-slippage-bps"), label).toBe("100");
          const text = rowValueText(slippageRow);
          expect(text.length, label).toBeGreaterThan(0);
          expect(result.current.minimum, label).toBeNull();
          return text;
        }

        // 표본 1: 금액 1 입력 직후 입력 반영 대기 중
        fireEvent.change(amountInput(), { target: { value: "1" } });
        const debounceText = expectLoading("반영 대기 중");

        // 표본 1은 대기를 마저 지나 요청이 붙잡히게 한다. 표본 2: 반영 뒤 견적 응답을 붙잡고 있는 중
        await waitUntil(() => expect(gate.heldCount).toBeGreaterThanOrEqual(1));
        await settlePendingWork();
        const heldText = expectLoading("응답 붙잡힘");

        gate.release();
        await waitUntil(() => expect(result.current.quote.status).toBe("success"));
        await waitUntil(() => expect(minimumRaw()).not.toBeNull());
        await settlePendingWork();

        const successText = rowValueText(detailsRow("quote-slippage"));
        expect(successText, "반영 대기 중 표본").toBe(debounceText);
        expect(successText, "응답 붙잡힘 표본").toBe(heldText);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("견적 정보 영역이 렌더링되지 않는 경우", () => {
    /**
     * @spec DoD-22 DoD-25
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분)가 선택돼 있다. 표본: `idle` — 받는 토큰 미선택, `idle` — 받는 USDC·금액 빈 값, `idle` — 받는 USDC·금액 `1`의 견적이 `success`로 표시된 뒤 금액을 지움, `no-route` — 받는 USDC·금액 `1`이고 스텁이 네 티어의 `quoteExactInputSingle` 하위 호출을 모두 revert로 응답함, `error` — 받는 USDC·금액 `1`이고 스텁이 견적 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답함을 하나씩 반복한다
     * @when 표본 상태를 만들고 입력 반영 대기(300ms)가 지나 견적 상태가 정해지기를 기다린다
     * @then useSwapQuote()의 status가 표본의 상태(`idle` | `no-route` | `error`)다
     * @then quote-details가 렌더링되지 않는다
     * @then quote-amount-out-minimum과 quote-slippage가 렌더링되지 않는다
     * @then useAmountOutMinimum()이 `null`이다
     */
    it(
      "[DoD-22][DoD-25] idle·no-route·error이면 견적 정보 영역과 두 행이 없고 최소 수령량은 null이다",
      async () => {
        type ResultRef = { current: ReturnType<typeof useProbe> };
        const samples: {
          label: string;
          status: "idle" | "no-route" | "error";
          setup: (result: ResultRef) => Promise<void>;
        }[] = [
          { label: "idle — 받는 토큰 미선택", status: "idle", setup: async () => {} },
          {
            label: "idle — 받는 USDC·금액 빈 값",
            status: "idle",
            setup: async () => {
              await chooseToken("out", ETHEREUM_USDC);
            },
          },
          {
            label: "idle — success 뒤 금액 지움",
            status: "idle",
            setup: async (result) => {
              await chooseToken("out", ETHEREUM_USDC);
              await typeAmount("1");
              await waitUntil(() => expect(result.current.quote.status).toBe("success"));
              // 전제: 최소 수령량이 표시된 상태에서 금액을 지운다.
              await waitUntil(() => expect(minimumRaw()).not.toBeNull());
              await typeAmount("");
            },
          },
          {
            label: "no-route",
            status: "no-route",
            setup: async () => {
              rpc.setQuoteRule(NO_ROUTE_RULE);
              await chooseToken("out", ETHEREUM_USDC);
              await typeAmount("1");
            },
          },
          {
            label: "error",
            status: "error",
            setup: async () => {
              rpc.failQuoteWhen(matchQuote.input());
              await chooseToken("out", ETHEREUM_USDC);
              await typeAmount("1");
            },
          },
        ];

        for (const [index, { label, status, setup }] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderMockConnectedApp();
          await setup(result);

          await yieldToPendingWork(DEBOUNCE_MS + 200);
          await waitUntil(() => expect(result.current.quote.status, label).toBe(status));
          await settlePendingWork();

          // 전제: no-route·error는 견적 요청을 받아 응답한 결과다.
          if (status === "no-route") {
            expect(
              rpc.requests(matchQuote.input()).some((request) => request.status === "ok"),
              label,
            ).toBe(true);
          }
          if (status === "error") {
            expect(
              rpc.requests(matchQuote.input()).some((request) => request.status === "failed"),
              label,
            ).toBe(true);
          }

          expect(result.current.quote.status, label).toBe(status);
          expect(quoteDetails(), label).toBeNull();
          expect(screen.queryByTestId("quote-amount-out-minimum"), label).toBeNull();
          expect(screen.queryByTestId("quote-slippage"), label).toBeNull();
          expect(result.current.minimum, label).toBeNull();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("슬리피지를 바꾸는 경우", () => {
    /**
     * @spec DoD-23 DoD-19 DoD-24
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`의 견적이 슬리피지 초기값 `50`에서 `success`로 표시됐다. 스텁은 견적 수령량을 고정 값 Q로 응답하고, 테스트는 견적 JSON-RPC 항목 수를 기록해 둔다. 기대 최소 수령량은 리터럴이나 테스트 쪽 bigint 식 `Q * (10000n - bps) / 10000n`으로 만든다. 표본 변경: slippage-button으로 팝오버를 열고 `10`을 고름, `100`을 고름을 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링하고 위 전제(견적 `success`, 견적 JSON-RPC 항목 수 기록)를 다시 만든다(같은 렌더에서 이어서 반복하지 않는다)
     * @when 표본 프리셋을 고른 직후 확인하고, 이어서 가짜 시계를 슬리피지를 고른 시각 + 300ms 이후, 그 입력의 첫 견적 요청 시각(15초 주기 시작) + 15초 − 1ms 이하인 시각까지 진행한 뒤 다시 확인한다
     * @then 두 시점 모두 quote-amount-out-minimum의 data-amount-out-minimum-raw가 새 프리셋의 기대 최소 수령량의 10진 문자열이다
     * @then 두 시점 모두 quote-slippage의 data-slippage-bps가 새 프리셋 값이다
     * @then 두 시점 모두 useAmountOutMinimum()이 새 프리셋의 기대 최소 수령량(bigint)이다
     * @then 두 시점 모두 견적 JSON-RPC 항목 수가 기록한 값에서 늘지 않는다
     * @then 두 시점 모두 useSwapQuote()의 status가 `success`이고 quote-amount-out의 data-amount-out-raw가 Q이며 quote-skeleton이 없다
     */
    it(
      "[DoD-23][DoD-19][DoD-24] 슬리피지를 바꾸면 견적 요청 없이 최소 수령량이 새 값이 된다",
      async () => {
        // 스텁 고정 수령량 1,234,567.891234 USDC(6 decimals)
        const Q = 1_234_567_891_234n;
        const samples: { bps: PresetBps; minimum: bigint }[] = [
          { bps: 10, minimum: expectedMinimum(Q, 10) },
          { bps: 100, minimum: expectedMinimum(Q, 100) },
        ];

        for (const [index, { bps, minimum }] of samples.entries()) {
          const label = `50 → ${bps}`;
          // 표본마다 앱을 새로 렌더링하고 전제를 다시 만든다.
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const { result } = await renderBaseQuote(Q);
          expect(result.current.slippage.slippageBps, label).toBe(50);
          await waitUntil(() =>
            expect(minimumRaw(), label).toBe(expectedMinimum(Q, 50).toString()),
          );
          expect(minimum, label).not.toBe(expectedMinimum(Q, 50));
          const start = basePeriodStart();
          await settlePendingWork();
          const recorded = quoteCount();

          await chooseSlippage(bps);
          const chosenAt = Date.now();

          function expectChanged(point: string) {
            const where = `${label} ${point}`;
            expect(minimumRaw(), where).toBe(minimum.toString());
            expect(detailsRow("quote-slippage").getAttribute("data-slippage-bps"), where).toBe(
              String(bps),
            );
            expect(result.current.minimum, where).toBe(minimum);
            expect(quoteCount(), where).toBe(recorded);
            expect(result.current.quote.status, where).toBe("success");
            expect(detailsAmountRaw(), where).toBe(Q.toString());
            expect(skeletonCount(), where).toBe(0);
          }

          // 고른 직후(가짜 시계를 진행하지 않음)
          await waitUntil(() => expect(minimumRaw(), label).toBe(minimum.toString()));
          expectChanged("직후");

          // 고른 시각 + 300ms 이후, 첫 견적 요청 시각 + 15초 − 1ms 이하
          const checkAt = start + REFETCH_MS - 1;
          expect(checkAt, label).toBeGreaterThan(chosenAt + DEBOUNCE_MS);
          // 입력 반영 대기(실제 setTimeout)도 지나게 한다.
          await yieldToPendingWork(DEBOUNCE_MS + 200);
          await advanceFakeTimeTo(checkAt);
          await settlePendingWork();
          expectChanged("대기 후");
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("팝오버가 열린 동안 견적이 바뀌는 경우", () => {
    /**
     * @spec EC-5
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`의 첫 견적이 슬리피지 초기값 `50`에서 수령량 Q1로 `success` 표시됐다. slippage-button으로 팝오버를 열어 두었다. 그 뒤 스텁의 같은 입력 수령량을 Q1과 다른 Q2로 바꿨다. 기대 최소 수령량은 테스트 쪽 bigint 식 `Q2 * (10000n - 50n) / 10000n`이나 리터럴로 만든다
     * @when 가짜 시계를 첫 견적 성공 시점부터 15초 진행하고 다시 읽기 응답을 기다린다
     * @then 같은 입력의 견적 요청이 1건 늘고 quote-amount-out의 data-amount-out-raw가 Q2다
     * @then quote-amount-out-minimum의 data-amount-out-minimum-raw가 Q2 기준 기대 최소 수령량의 10진 문자열이다
     * @then slippage-popover가 렌더링돼 있고 slippage-button의 aria-expanded가 `true`다
     */
    it(
      "[EC-5] 열린 채 15초 갱신으로 수령량이 바뀌면 팝오버는 열려 있고 최소 수령량이 새 수령량 기준이 된다",
      async () => {
        // 스텁 고정 수령량: Q1 = 1,234,567.891234 USDC, Q2는 Q1과 다른 값
        const Q1 = 1_234_567_891_234n;
        const Q2 = Q1 + 777_777n;
        const expectedQ2Minimum = (Q2 * (BPS_DENOMINATOR - 50n)) / BPS_DENOMINATOR;
        expect(expectedQ2Minimum).not.toBe(expectedMinimum(Q1, 50));

        fakePeriodicTimers();
        const { result } = await renderBaseQuote(Q1);
        const successAt = Date.now();
        expect(result.current.slippage.slippageBps).toBe(50);
        await waitUntil(() => expect(minimumRaw()).toBe(expectedMinimum(Q1, 50).toString()));

        await openSlippagePopover();
        rpc.setQuoteRule(fixedQuoteRule(Q2));
        const base = quoteCount();
        const baseSameInput = quoteCount(matchQuote.input(BASE_INPUT));

        await advanceFakeTimeTo(successAt + REFETCH_MS);
        await waitUntil(() => expect(quoteCount()).toBe(base + 1));
        await waitUntil(() => expect(detailsAmountRaw()).toBe(Q2.toString()));
        await waitUntil(() => expect(minimumRaw()).toBe(expectedQ2Minimum.toString()));
        await settlePendingWork();

        expect(quoteCount()).toBe(base + 1);
        expect(quoteCount(matchQuote.input(BASE_INPUT))).toBe(baseSameInput + 1);
        expect(detailsAmountRaw()).toBe(Q2.toString());
        expect(minimumRaw()).toBe(expectedQ2Minimum.toString());
        expectPopoverOpen();
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-6
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC가 선택돼 있다. 금액 `1`을 입력해 입력 반영 대기(300ms)가 지난 뒤 스텁이 견적 응답을 붙잡고 있는 동안 slippage-button으로 팝오버를 열었다. 표본 응답: 네 티어의 `quoteExactInputSingle` 하위 호출이 모두 revert(`no-route`), transport 재시도 대상이 아닌 JSON-RPC 오류(`error`)를 하나씩 반복한다
     * @when 붙잡은 견적 응답을 풀고 견적 상태가 정해지기를 기다린다
     * @then useSwapQuote()의 status가 표본의 상태(`no-route` | `error`)다
     * @then quote-details가 렌더링되지 않는다
     * @then slippage-popover가 렌더링돼 있고 slippage-button의 aria-expanded가 `true`다
     */
    it(
      "[EC-6] 열린 채 견적이 no-route나 error가 되어도 팝오버는 열려 있다",
      async () => {
        const samples: {
          label: string;
          status: "no-route" | "error";
          requestStatus: "ok" | "failed";
          apply: () => void;
        }[] = [
          {
            label: "no-route",
            status: "no-route",
            requestStatus: "ok",
            apply: () => rpc.setQuoteRule(NO_ROUTE_RULE),
          },
          {
            label: "error",
            status: "error",
            requestStatus: "failed",
            apply: () => rpc.failQuoteWhen(matchQuote.input()),
          },
        ];

        for (const [index, { label, status, requestStatus, apply }] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderMockConnectedApp();
          await chooseToken("out", ETHEREUM_USDC);
          await settlePendingWork();
          const gate = rpc.holdQuote();

          await typeAmount("1");
          await waitUntil(() => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1));
          expect(result.current.quote.status, label).toBe("loading");

          // 응답이 붙잡힌 동안 팝오버를 연다.
          await openSlippagePopover();
          // 붙잡은 응답을 표본 응답으로 푼다(스텁은 풀린 뒤의 규칙으로 응답한다).
          apply();
          gate.release();

          await waitUntil(() => expect(result.current.quote.status, label).toBe(status));
          await settlePendingWork();
          // 전제: 붙잡았던 견적 요청이 표본 응답을 받았다.
          expect(
            rpc
              .requests(matchQuote.input(BASE_INPUT))
              .some((request) => request.status === requestStatus),
            label,
          ).toBe(true);

          expect(result.current.quote.status, label).toBe(status);
          expect(quoteDetails(), label).toBeNull();
          expectPopoverOpen(label);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });
});
