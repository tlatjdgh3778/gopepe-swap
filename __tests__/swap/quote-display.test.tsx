import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";

import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceRpcStub,
  type QuoteRule,
  type StubFeeTier,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  STUB_FEE_TIERS,
  STUB_Q96,
  defaultQuoteRule,
  defaultSlot0SqrtPriceX96,
  installBalanceRpcStub,
  matchQuote,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  waitUntil,
  yieldToPendingWork,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 견적 RPC는 전역 fetch 스텁이 응답한다.
// 견적 상태(idle·loading·success·no-route·error)마다 case 하나에서 useSwapQuote() 반환값(§4.1), 화면 식별자·속성(§4.3), 주 버튼(§4.2)을 함께 판정한다.
// 문구 판정은 DoD-11의 받는 칸 값(스텁 고정 수령량에 대한 기대 문자열 리터럴)만 허용한다.
// 기대 주소(WETH, USDC)는 제품 config를 쓰지 않고 리터럴로 적는다.

const CASE_TIMEOUT_MS = 30_000;

// 스펙 값: 입력 반영 대기 300ms(DoD-26)
const DEBOUNCE_MS = 300;

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

const ONE_ETH = 10n ** 18n;

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

function quoteRate(): HTMLElement | null {
  return screen.queryByTestId("quote-rate");
}

function detailsRow(testId: "quote-amount-out" | "quote-price-impact" | "quote-fee-tier") {
  const details = quoteDetails();
  if (!details) throw new Error("quote-details가 없다");
  return within(details).getByTestId(testId);
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
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 보내는 ETH, 받는 USDC, 금액을 입력하고 견적이 끝나기를 기다린다.
async function renderEthUsdcQuote(amount: string, status: string) {
  const view = await renderMockConnectedApp();
  await chooseToken("out", ETHEREUM_USDC);
  await typeAmount(amount);
  await waitUntil(() => expect(view.result.current.quote.status).toBe(status));
  await settlePendingWork();
  return view;
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
  const spotNumerator = zeroForOne ? params.amountIn * priceX192 : params.amountIn * Q192;
  const spotDenominator = zeroForOne ? Q192 : priceX192;
  const scale = 10n ** 18n;
  const ratio =
    Number((params.amountOut * spotDenominator * scale) / spotNumerator) / Number(scale);
  return (1 - ratio) * 10_000 - params.fee / 100;
}

// 가격 영향 표본용 규칙: 500 티어가 `amountOut`으로 가장 많고 그 풀의 slot0 가격이 1(sqrtPriceX96 = 2^96)이다.
// 가격이 1이면 slot0 가격으로 받을 양은 보내는 양과 같아 가격 영향 = (1 − amountOut / amountIn) × 10000 − 5 bps다.
const IMPACT_FEE: StubFeeTier = 500;

function priceImpactRule(amountOut: bigint): QuoteRule {
  return {
    quote: (query) => ({
      status: "ok",
      amountOut: query.fee === IMPACT_FEE ? amountOut : amountOut / 2n,
      sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
    }),
    slot0: (query) => ({
      status: "ok",
      sqrtPriceX96: query.fee === IMPACT_FEE ? STUB_Q96 : defaultSlot0SqrtPriceX96(query.fee),
    }),
  };
}

// 가격 영향 표본: 금액 1 ETH에 대해 표본 bps가 되는 500 티어 수령량(위 식을 거꾸로 푼 값)
// 300.5 bps: 1 − x = 0.03055, 1500.5 bps: 1 − x = 0.15055, 5000 bps(50.00%): 1 − x = 0.5005
const AMOUNT_OUT_FOR_300_5_BPS = 969_450_000_000_000_000n;
const AMOUNT_OUT_FOR_1500_5_BPS = 849_450_000_000_000_000n;
const AMOUNT_OUT_FOR_5000_BPS = 499_500_000_000_000_000n;

describe("견적 표시 — 사용자가 견적 상태에 맞는 수령량·환율·가격 영향·수수료 티어와 주 버튼을 본다", () => {
  describe("견적이 성공한 경우", () => {
    /**
     * @spec DoD-11 DoD-12 DoD-13 DoD-35 DoD-36 DoD-37
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 금액보다 크게 읽혔으며 받는 USDC, 금액 `1`이다. 스텁은 네 티어 중 한 티어의 수령량이 가장 많게 응답하고, 네 티어 풀의 slot0을 티어마다 다른 고정 값으로 돌려준다. 그 고정 수령량은 USDC decimals(6) 기준으로 천 단위 구분과 소수부 버림이 드러나는 값이며, 테스트는 그 값의 `formatTokenAmount` 형식 기대 문자열을 리터럴로 적어 둔다(제품 함수로 만들지 않는다)
     * @when 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then quote.amountOut이 스텁에서 수령량이 가장 많은 티어의 수령량(bigint)이고 quote.fee가 그 티어다
     * @then quote.priceImpactBps가 스텁의 slot0·수령량·fee로 스펙 DoD-16 식을 따라 테스트가 따로 계산한 number 값이다
     * @then quote.priceImpactBps가 고르지 않은 티어 풀의 slot0으로 같은 식을 따라 계산한 값과 다르다
     * @then token-field[data-side="out"] 안 amount-input의 값이 기대 문자열 리터럴과 같다
     * @then 받는 칸 amount-input의 data-amount-out-raw가 스텁 고정 수령량의 10진 문자열이다
     * @then quote-details 안의 quote-amount-out의 data-amount-out-raw가 스텁 고정 수령량의 10진 문자열이다
     * @then quote-details 안의 quote-fee-tier의 data-fee가 스텁에서 수령량이 가장 많은 티어 값이다
     * @then quote-details 안의 quote-price-impact가 표시돼 있고 data-severity가 `normal` | `warning` | `error` 중 하나다
     * @then quote-rate가 렌더링돼 있다
     * @then quote-skeleton이 없다
     * @then useSwapQuote()의 status가 `success`인 같은 시점에 primary-button의 data-state가 `quote-ready`이고 비활성이다
     */
    it(
      "[DoD-11][DoD-12][DoD-13][DoD-35][DoD-36][DoD-37] success이면 받는 칸 수령량, 견적 정보 세 행, 환율 행을 표시하고 quote-ready, 비활성이다",
      async () => {
        // 500 티어의 고정 수령량 1,234,567.891234 USDC(6 decimals)가 가장 많다.
        const FIXED_AMOUNT_OUT = 1_234_567_891_234n;
        // 소수 4자리 버림, 천 단위 쉼표(F2 DoD-15 표시 규칙)를 손으로 적은 기대 문자열
        const EXPECTED_DISPLAY = "1,234,567.8912";
        const amounts: Record<StubFeeTier, bigint> = {
          100: 1_000_000_000_000n,
          500: FIXED_AMOUNT_OUT,
          3000: 1_200_000_000_000n,
          10000: 900_000_000_000n,
        };
        const bestFee: StubFeeTier = 500;
        // 티어마다 다른 slot0(기본 규칙: 2·3·5·7 × 2^96)
        rpc.setQuoteRule({
          quote: (query) => ({
            status: "ok",
            amountOut: amounts[query.fee],
            sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
          }),
          slot0: defaultQuoteRule.slot0,
        });
        const slot0s = STUB_FEE_TIERS.map((fee) => defaultSlot0SqrtPriceX96(fee));
        expect(new Set(slot0s).size).toBe(STUB_FEE_TIERS.length);

        const { result } = await renderEthUsdcQuote("1", "success");
        await waitUntil(() => expect(outAmountRaw()).toBe(FIXED_AMOUNT_OUT.toString()));

        const impactWith = (sqrtPriceX96: bigint) =>
          expectedPriceImpactBps({
            tokenIn: ETHEREUM_WETH,
            tokenOut: ETHEREUM_USDC,
            sqrtPriceX96,
            fee: bestFee,
            amountIn: ONE_ETH,
            amountOut: FIXED_AMOUNT_OUT,
          });

        const { status, quote } = result.current.quote;
        // 같은 시점의 주 버튼
        const buttonState = primaryState();
        const buttonDisabled = primaryButton().disabled;

        expect(status).toBe("success");
        expect(quote!.amountOut).toBe(FIXED_AMOUNT_OUT);
        expect(quote!.fee).toBe(bestFee);
        expect(quote!.priceImpactBps).toBeCloseTo(impactWith(defaultSlot0SqrtPriceX96(bestFee)), 6);
        for (const fee of STUB_FEE_TIERS.filter((candidate) => candidate !== bestFee)) {
          const other = impactWith(defaultSlot0SqrtPriceX96(fee));
          // 기대값 일치 허용 오차(toBeCloseTo 6자리, 5e-7)보다 충분히 큰 차이
          expect(Math.abs(quote!.priceImpactBps - other), `slot0 of ${fee}`).toBeGreaterThan(1e-3);
        }

        expect(outAmountInput().value).toBe(EXPECTED_DISPLAY);
        expect(outAmountRaw()).toBe(FIXED_AMOUNT_OUT.toString());
        expect(detailsRow("quote-amount-out").getAttribute("data-amount-out-raw")).toBe(
          FIXED_AMOUNT_OUT.toString(),
        );
        expect(detailsRow("quote-fee-tier").getAttribute("data-fee")).toBe(String(bestFee));
        expect(["normal", "warning", "error"]).toContain(
          detailsRow("quote-price-impact").getAttribute("data-severity"),
        );
        expect(quoteRate()).not.toBeNull();
        expect(skeletonCount()).toBe(0);
        expect(buttonState).toBe("quote-ready");
        expect(buttonDisabled).toBe(true);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("견적할 입력이 없는 경우", () => {
    /**
     * @spec DoD-14 DoD-40 DoD-37
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 표본: 초기 상태(보내는 ETH, 받는 미선택), 보내는 ETH·받는 미선택·금액 `1`, 보내는 ETH·받는 USDC·금액 빈 값, 금액 `0`, 금액 `0.00`, 금액 `.`(amountInRaw가 null), 보내는 ETH·받는 USDC·금액 `1`의 견적이 `success`로 표시된 뒤 금액을 지움(비idle → idle 전이)을 하나씩 반복한다
     * @when 표본 상태를 만든 직후 타이머를 진행하지 않은 채 확인하고, 이어서 입력 반영 대기(300ms)보다 오래 기다려 다시 확인한다
     * @then 두 시점 모두 useSwapQuote()의 status가 `idle`이고 quote가 `null`이다
     * @then 두 시점 모두 quote-details가 렌더링되지 않는다
     * @then 두 시점 모두 quote-rate가 렌더링되지 않는다
     * @then 두 시점 모두 받는 칸 amount-input의 값이 빈 문자열이고 data-amount-out-raw가 없다
     * @then 두 시점 모두 quote-skeleton이 없다
     */
    it(
      "[DoD-14][DoD-40][DoD-37] idle이면 견적 정보·환율 행이 없고 받는 칸은 빈 값이다",
      async () => {
        const { result } = await renderMockConnectedApp();

        function expectIdle(label: string) {
          expect(result.current.quote.status, label).toBe("idle");
          expect(result.current.quote.quote, label).toBeNull();
          expect(quoteDetails(), label).toBeNull();
          expect(quoteRate(), label).toBeNull();
          expect(outAmountInput().value, label).toBe("");
          expect(outAmountInput().hasAttribute("data-amount-out-raw"), label).toBe(false);
          expect(skeletonCount(), label).toBe(0);
        }

        // 직후(타이머 진행 없이)와 입력 반영 대기(300ms)보다 오래 기다린 뒤
        async function expectIdleAtBothPoints(label: string) {
          expectIdle(`${label} 직후`);
          await yieldToPendingWork(DEBOUNCE_MS + 200);
          await settlePendingWork();
          expectIdle(`${label} 대기 후`);
        }

        function setAmount(value: string) {
          fireEvent.change(amountInput(), { target: { value } });
          expect(amountInput().value).toBe(value);
        }

        // 초기 상태(보내는 ETH, 받는 미선택)
        await expectIdleAtBothPoints("초기 상태");

        // 보내는 ETH·받는 미선택·금액 1
        setAmount("1");
        await expectIdleAtBothPoints("받는 미선택·금액 1");
        setAmount("");

        // 보내는 ETH·받는 USDC·금액 빈 값
        fireEvent.click(within(field("out")).getByTestId("token-button"));
        await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe("out"));
        fireEvent.click(optionRow(ETHEREUM_USDC));
        expect(amountInput().value).toBe("");
        await expectIdleAtBothPoints("두 토큰·금액 빈 값");
        await waitUntil(() => expect(tokenModal()).toBeNull());

        for (const amount of ["0", "0.00", "."]) {
          setAmount(amount);
          await expectIdleAtBothPoints(`금액 ${amount}`);
        }

        // 견적 success 뒤 금액을 지움(비idle → idle)
        setAmount("1");
        await waitUntil(() => expect(result.current.quote.status).toBe("success"));
        await waitUntil(() => expect(outAmountRaw()).not.toBeNull());
        setAmount("");
        await expectIdleAtBothPoints("success 뒤 금액 지움");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("견적을 기다리는 경우", () => {
    /**
     * @spec DoD-15 DoD-32 DoD-36 DoD-37
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC가 선택돼 있다. 표본: 금액 `1` 입력 직후 입력 반영 대기(300ms) 중, 금액 `1` 반영 뒤 스텁이 견적 응답을 붙잡고 있는 중을 하나씩 반복한다
     * @when 표본 상태에서 화면을 확인한다
     * @then useSwapQuote()의 status가 `loading`이고 quote가 `null`이다
     * @then token-field[data-side="out"] 안에 quote-skeleton이 있고 받는 칸 amount-input에 data-amount-out-raw가 없다
     * @then 받는 칸 amount-input의 값이 빈 문자열이다
     * @then quote-rate 안에 quote-skeleton이 있다
     * @then quote-details 안의 quote-amount-out, quote-price-impact, quote-fee-tier 각각 안에 quote-skeleton이 있다
     * @then quote-amount-out에 data-amount-out-raw가 없다
     * @then primary-button의 data-state가 `quoting`이고 비활성이다
     */
    it(
      "[DoD-15][DoD-32][DoD-36][DoD-37] loading이면 값 자리에 스켈레톤을 표시하고 quoting, 비활성이다",
      async () => {
        const { result } = await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM_USDC);
        await settlePendingWork();
        const gate = rpc.holdQuote();

        function expectLoading(label: string) {
          expect(result.current.quote.status, label).toBe("loading");
          expect(result.current.quote.quote, label).toBeNull();
          expect(skeletonCount(field("out")), label).toBeGreaterThan(0);
          expect(outAmountInput().hasAttribute("data-amount-out-raw"), label).toBe(false);
          expect(outAmountInput().value, label).toBe("");
          const rate = quoteRate();
          expect(rate, label).not.toBeNull();
          expect(skeletonCount(rate!), label).toBeGreaterThan(0);
          for (const testId of [
            "quote-amount-out",
            "quote-price-impact",
            "quote-fee-tier",
          ] as const) {
            expect(skeletonCount(detailsRow(testId)), `${label} ${testId}`).toBeGreaterThan(0);
          }
          expect(detailsRow("quote-amount-out").hasAttribute("data-amount-out-raw"), label).toBe(
            false,
          );
          expect(primaryState(), label).toBe("quoting");
          expect(primaryButton().disabled, label).toBe(true);
        }

        // 표본 1: 금액 1 입력 직후 입력 반영 대기 중
        fireEvent.change(amountInput(), { target: { value: "1" } });
        expectLoading("반영 대기 중");

        // 표본 2: 반영 뒤 견적 응답을 붙잡고 있는 중
        await waitUntil(() => expect(gate.heldCount).toBeGreaterThanOrEqual(1));
        await settlePendingWork();
        expectLoading("응답 붙잡힘");
        gate.release();
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("견적 경로가 없거나 견적을 가져오지 못한 경우", () => {
    /**
     * @spec EC-5 DoD-40 DoD-33 DoD-36 DoD-37
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`이다. 스텁은 네 티어의 `quoteExactInputSingle` 하위 호출을 모두 revert로 응답한다
     * @when 입력 반영 대기(300ms)가 지나고 견적 응답을 받기를 기다린다
     * @then useSwapQuote()의 status가 `no-route`이고 quote가 `null`이다
     * @then 받는 칸 amount-input의 값이 빈 문자열이고 data-amount-out-raw가 없다
     * @then quote-details가 렌더링되지 않는다
     * @then quote-rate가 렌더링되지 않는다
     * @then quote-skeleton이 없다
     * @then primary-button의 data-state가 `no-route`이고 비활성이다
     */
    it(
      "[EC-5][DoD-40][DoD-33][DoD-36][DoD-37] no-route이면 받는 칸을 비우고 견적 정보·환율 행이 없으며 no-route, 비활성이다",
      async () => {
        rpc.setQuoteRule({ quote: () => ({ status: "revert" }), slot0: defaultQuoteRule.slot0 });
        const { result } = await renderEthUsdcQuote("1", "no-route");
        // 전제: 견적 요청을 받아 응답했다(RPC 없는 no-route가 아니다).
        expect(rpc.requests(matchQuote.input()).some((request) => request.status === "ok")).toBe(
          true,
        );

        expect(result.current.quote.status).toBe("no-route");
        expect(result.current.quote.quote).toBeNull();
        expect(outAmountInput().value).toBe("");
        expect(outAmountInput().hasAttribute("data-amount-out-raw")).toBe(false);
        expect(quoteDetails()).toBeNull();
        expect(quoteRate()).toBeNull();
        expect(skeletonCount()).toBe(0);
        expect(primaryState()).toBe("no-route");
        expect(primaryButton().disabled).toBe(true);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-7 EC-8 DoD-40 DoD-34 DoD-36 DoD-37
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC가 선택돼 있다. 스텁은 견적 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답한다. 표본: 처음 금액 `1`을 입력함, 금액 `1`의 견적이 `success`로 표시된 뒤 스텁을 실패로 바꾸고 금액을 `2`로 바꿈을 하나씩 반복한다
     * @when 입력 반영 대기(300ms)가 지나고 견적 응답을 받기를 기다린다
     * @then useSwapQuote()의 status가 `error`이고 quote가 `null`이다
     * @then 받는 칸 amount-input의 값이 빈 문자열이고 data-amount-out-raw가 없다(이전 입력의 견적 값을 표시하지 않는다)
     * @then quote-details가 렌더링되지 않는다
     * @then quote-rate가 렌더링되지 않는다
     * @then quote-skeleton이 없다
     * @then primary-button의 data-state가 `quote-error`이고 비활성이다
     */
    it(
      "[EC-7][EC-8][DoD-40][DoD-34][DoD-36][DoD-37] 입력이 바뀐 뒤 첫 읽기가 실패하면 error이고 받는 칸을 비우며 quote-error, 비활성이다",
      async () => {
        const samples = ["처음 금액 1 입력", "success 뒤 금액 2로 바꿈"] as const;

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderMockConnectedApp();
          await chooseToken("out", ETHEREUM_USDC);

          if (sample === "처음 금액 1 입력") {
            rpc.failQuoteWhen(matchQuote.input());
            await typeAmount("1");
          } else {
            await typeAmount("1");
            await waitUntil(() => expect(result.current.quote.status, sample).toBe("success"));
            await waitUntil(() => expect(outAmountRaw(), sample).not.toBeNull());
            rpc.failQuoteWhen(matchQuote.input());
            await typeAmount("2");
          }

          await waitUntil(() => expect(result.current.quote.status, sample).toBe("error"));
          await settlePendingWork();
          // 전제: 바뀐 입력의 견적 요청이 실패 응답을 받았다.
          const amountIn = sample === "처음 금액 1 입력" ? ONE_ETH : 2n * ONE_ETH;
          expect(
            rpc
              .requests(matchQuote.input({ amountIn }))
              .some((request) => request.status === "failed"),
            sample,
          ).toBe(true);

          expect(result.current.quote.status, sample).toBe("error");
          expect(result.current.quote.quote, sample).toBeNull();
          expect(outAmountInput().value, sample).toBe("");
          expect(outAmountInput().hasAttribute("data-amount-out-raw"), sample).toBe(false);
          expect(quoteDetails(), sample).toBeNull();
          expect(quoteRate(), sample).toBeNull();
          expect(skeletonCount(), sample).toBe(0);
          expect(primaryState(), sample).toBe("quote-error");
          expect(primaryButton().disabled, sample).toBe(true);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  // 등급 배선 확인용 표본만 둔다. 음수·0·3.01%·15.01% 같은 등급 경계 표본은 단위 테스트(T-5)가 덮는다.
  describe("가격 영향 등급", () => {
    /**
     * @spec DoD-17
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`이다. 스텁은 고른 티어의 수령량과 그 풀의 slot0을 스펙 DoD-16 식의 가격 영향이 표본 값이 되게 응답한다. 표본: 원값이 300 bps보다 크고 소수 2자리 버림으로 표시값이 `3.00%`인 값 하나
     * @when 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다린다
     * @then quote-price-impact의 data-severity가 `normal`이다
     */
    it(
      "[DoD-17] 원값이 3%를 넘어도 표시값이 3.00%이면 normal 등급이다",
      async () => {
        rpc.setQuoteRule(priceImpactRule(AMOUNT_OUT_FOR_300_5_BPS));
        const { result } = await renderEthUsdcQuote("1", "success");
        await waitUntil(() => expect(outAmountRaw()).toBe(AMOUNT_OUT_FOR_300_5_BPS.toString()));

        // 전제: 원값이 표본 값이다(스펙 DoD-16 식으로 테스트가 계산한 값과 같다).
        const expected = expectedPriceImpactBps({
          tokenIn: ETHEREUM_WETH,
          tokenOut: ETHEREUM_USDC,
          sqrtPriceX96: STUB_Q96,
          fee: IMPACT_FEE,
          amountIn: ONE_ETH,
          amountOut: AMOUNT_OUT_FOR_300_5_BPS,
        });
        expect(expected).toBeCloseTo(300.5, 6);
        expect(result.current.quote.quote!.priceImpactBps).toBeCloseTo(expected, 6);

        expect(detailsRow("quote-price-impact").getAttribute("data-severity")).toBe("normal");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-17
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `1`이다. 스텁은 고른 티어의 수령량과 그 풀의 slot0을 스펙 DoD-16 식의 가격 영향이 표본 값이 되게 응답한다. 표본: 원값이 1500 bps보다 크고 소수 2자리 버림으로 표시값이 `15.00%`인 값 하나
     * @when 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다린다
     * @then quote-price-impact의 data-severity가 `warning`이다
     */
    it(
      "[DoD-17] 원값이 15%를 넘어도 표시값이 15.00%이면 warning 등급이다",
      async () => {
        rpc.setQuoteRule(priceImpactRule(AMOUNT_OUT_FOR_1500_5_BPS));
        const { result } = await renderEthUsdcQuote("1", "success");
        await waitUntil(() => expect(outAmountRaw()).toBe(AMOUNT_OUT_FOR_1500_5_BPS.toString()));

        // 전제: 원값이 표본 값이다(스펙 DoD-16 식으로 테스트가 계산한 값과 같다).
        const expected = expectedPriceImpactBps({
          tokenIn: ETHEREUM_WETH,
          tokenOut: ETHEREUM_USDC,
          sqrtPriceX96: STUB_Q96,
          fee: IMPACT_FEE,
          amountIn: ONE_ETH,
          amountOut: AMOUNT_OUT_FOR_1500_5_BPS,
        });
        expect(expected).toBeCloseTo(1500.5, 6);
        expect(result.current.quote.quote!.priceImpactBps).toBeCloseTo(expected, 6);

        expect(detailsRow("quote-price-impact").getAttribute("data-severity")).toBe("warning");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-17 EC-15
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`이다. 스텁은 고른 티어의 수령량과 그 풀의 slot0을 스펙 DoD-16 식의 가격 영향이 표본 값이 되게 응답한다. 표본: 표시값 `50.00%` 하나
     * @when 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다린다
     * @then quote-price-impact의 data-severity가 `error`다
     * @then quote-details가 렌더링돼 있고 받는 칸 amount-input과 quote-amount-out의 data-amount-out-raw가 스텁 수령량이다
     * @then primary-button의 data-state가 `quote-ready`다
     */
    it(
      "[DoD-17][EC-15] 표시값 15% 초과 가격 영향은 error 등급이고 견적을 표시하며 quote-ready다",
      async () => {
        rpc.setQuoteRule(priceImpactRule(AMOUNT_OUT_FOR_5000_BPS));
        const { result } = await renderEthUsdcQuote("1", "success");
        await waitUntil(() => expect(outAmountRaw()).toBe(AMOUNT_OUT_FOR_5000_BPS.toString()));

        // 전제: 원값이 표본 값이다(스펙 DoD-16 식으로 테스트가 계산한 값과 같다).
        const expected = expectedPriceImpactBps({
          tokenIn: ETHEREUM_WETH,
          tokenOut: ETHEREUM_USDC,
          sqrtPriceX96: STUB_Q96,
          fee: IMPACT_FEE,
          amountIn: ONE_ETH,
          amountOut: AMOUNT_OUT_FOR_5000_BPS,
        });
        expect(expected).toBeCloseTo(5000, 6);
        expect(result.current.quote.quote!.priceImpactBps).toBeCloseTo(expected, 6);

        expect(detailsRow("quote-price-impact").getAttribute("data-severity")).toBe("error");
        expect(quoteDetails()).not.toBeNull();
        expect(outAmountRaw()).toBe(AMOUNT_OUT_FOR_5000_BPS.toString());
        expect(detailsRow("quote-amount-out").getAttribute("data-amount-out-raw")).toBe(
          AMOUNT_OUT_FOR_5000_BPS.toString(),
        );
        expect(primaryState()).toBe("quote-ready");
      },
      CASE_TIMEOUT_MS,
    );
  });
});
