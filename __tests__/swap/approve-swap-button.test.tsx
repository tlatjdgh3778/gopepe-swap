import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useSwapQuote } from "@/providers/swap-quote-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

import {
  type BalanceRpcStub,
  type HoldGate,
  type QuoteInputFilter,
  type QuoteRule,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  STUB_MAX_UINT256,
  STUB_Q96,
  allowanceAlways,
  allowanceWhen,
  defaultSlot0SqrtPriceX96,
  installBalanceRpcStub,
  matchAllowance,
  matchQuote,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import { createStubEip1193 } from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  chooseChainFromDropdown,
  clearCookies,
  createButtonStateRecorder,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 앱 Provider 안의 프로브로 useSwapQuote()·useAmountOutMinimum()·useTokenAllowance()를 읽는다.
// 지갑은 mock 커넥터 또는 스텁 EIP-1193(계정 변경 표본)을 쓴다. RPC는 전역 fetch URL 라우팅 스텁이 응답하고, 견적은 aggregate3 스텁, allowance는 allowance 응답·실패·붙잡기 스텁이 응답한다.
// 시간과 입력은 가짜 타이머와 DOM 이벤트로 다룬다. `vi.mock`은 쓰지 않는다.
// 주 버튼은 primary-button의 data-state와 disabled 속성으로 판정하고 문구는 판정하지 않는다.
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.

// 이 파일에서 "allowance 요청"은 ERC-20 `allowance(owner, spender)` `eth_call` JSON-RPC 항목이다(RPC 프록시 경로의 체인으로 체인을 구분한다).
// 스텁의 기본 allowance 응답은 0이다(사용자 확정). 표본마다 다른 값이 필요하면 스텁 리터럴로 정한다.
// 기대값(allowance, amountInRaw, 라우터·토큰 주소)은 제품 config나 제품 함수로 만들지 않고 스텁 리터럴과 스펙 §4.1 리터럴로 적는다.
// 라우터 주소 리터럴(스펙 §4.1): Ethereum `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, Base `0x2626664c2603336E57B271c5C0b26F421741e481`.
// 기본 ERC-20 페어는 Ethereum 보내는 USDC(decimals 6), 받는 DAI, 금액 `1`(amountInRaw `1000000`)이고 보내는 토큰 잔액은 금액보다 크게 읽힌다.

const CASE_TIMEOUT_MS = 60_000;
const MULTI_SAMPLE_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 10_000;

// 공식 주소(리터럴, 제품 config를 쓰지 않는다)
const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_DAI: Address = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
// 스펙 §4.1 SwapRouter02 주소(리터럴)
const ETHEREUM_SWAP_ROUTER02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
// 스텁 EIP-1193 계정 변경 표본의 두 번째 계정
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// 보내는 USDC(decimals 6) 금액 1 → amountInRaw 1_000_000
const AMOUNT = "1";
const AMOUNT_IN_RAW = 1_000_000n;

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

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// ─── 화면 ─────────────────────────────────────────────────────────

type Side = "in" | "out";

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

function primaryButton(): HTMLButtonElement {
  return screen.getByTestId("primary-button") as HTMLButtonElement;
}

function primaryState(): string | null {
  return primaryButton().getAttribute("data-state");
}

function priceImpactSeverity(): string | null {
  const details = screen.getByTestId("quote-details");
  return within(details).getByTestId("quote-price-impact").getAttribute("data-severity");
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
  return {
    quote: useSwapQuote(),
    minimum: useAmountOutMinimum(),
    allowance: useTokenAllowance(),
  };
}

type Probe = ReturnType<typeof useProbe>;

type App = {
  probe: () => Probe;
  recorder: ReturnType<typeof createButtonStateRecorder>;
  stub?: ReturnType<typeof createStubEip1193>;
};

type Wallet = "mock" | "stub";

// Ethereum에 연결된 앱. `mock`은 wagmi mock 커넥터, `stub`은 스텁 EIP-1193(계정 변경 표본)이다.
// 기본 잔액 규칙은 모든 토큰 잔액이 표본 금액보다 훨씬 크다.
async function renderConnectedApp(wallet: Wallet = "mock"): Promise<App> {
  const stub =
    wallet === "stub"
      ? createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT], authorized: true })
      : undefined;
  const config = createWagmiConfig({
    connectors: [
      stub ? stubConnector(stub) : mockConnector({ defaultConnected: true, reconnect: true }),
    ],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const recorder = createButtonStateRecorder();
  const view = renderAppHook(useProbe, {
    config,
    initialChainId: mainnet.id,
    onCommit: recorder.onCommit,
  });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(mainnet.id);
  }, READY_TIMEOUT_MS);
  return { probe: () => view.result.current, recorder, stub };
}

// 표본 입력의 견적 요청이 응답을 받고 useSwapQuote()가 success가 되기를 기다린다.
async function waitForQuoteOf(app: App, filter: QuoteInputFilter) {
  await waitUntil(() => {
    expect(rpc.requests(matchQuote.input(filter)).some((r) => r.status === "ok")).toBe(true);
    expect(app.probe().quote.status).toBe("success");
  }, READY_TIMEOUT_MS);
}

// 보내는 칸·받는 칸 토큰과 금액을 입력하고 그 입력의 견적이 success가 되기를 기다린다.
// 보내는 칸은 처음에 ETH이므로 보내는 ETH 표본은 보내는 칸을 고르지 않는다.
async function enterPair(app: App, tokenIn: Address, tokenOut: Address, amount = AMOUNT) {
  if (!sameAddress(tokenIn, NATIVE_ETH)) await chooseToken("in", tokenIn);
  await chooseToken("out", tokenOut);
  await typeAmount(amount);
  await waitForQuoteOf(app, { chainId: mainnet.id });
}

// ─── 견적 규칙(테스트 쪽 리터럴) ─────────────────────────────────

// 가격 영향 `error` 표본: 500 티어가 가장 많이 받고 그 풀의 slot0 가격이 1(sqrtPriceX96 = 2^96)이다.
// 가격이 1이면 slot0 가격으로 받을 양 = 보내는 양이므로 가격 영향 = (1 − amountOut / amountIn) × 10000 − 5 bps.
// amountOut = amountIn × 0.4995면 5005 − 5 = 5000 bps(표시값 50.00%, error 등급)다. 세 표본 금액(1e6, 1e18)에서 나누어떨어진다.
const IMPACT_FEE = 500;
const errorImpactRule: QuoteRule = {
  quote: (query) => {
    const amountOut = (query.amountIn * 4_995n) / 10_000n;
    return {
      status: "ok",
      amountOut: query.fee === IMPACT_FEE ? amountOut : amountOut / 2n,
      sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
    };
  },
  slot0: (query) => ({
    status: "ok",
    sqrtPriceX96: query.fee === IMPACT_FEE ? STUB_Q96 : defaultSlot0SqrtPriceX96(query.fee),
  }),
};

// 최소 수령량 0 표본: 모든 티어가 수령량 1(raw)이고 slot0 sqrtPriceX96 = 1000 × 2^96(가격 token1/token0 = 1e6)이다.
// USDC→DAI는 token0 = DAI(0x6B17…), token1 = USDC(0xA0b8…)라 oneForZero이고, slot0 가격으로 받을 양 = 1e6 / 1e6 = 1(raw)이다.
// 수령량이 그 양과 같아 가격 영향은 −(fee/100) bps(error 등급이 아니다), 최소 수령량은 1 × 9950 / 10000 = 0이다.
const DUST_SQRT_PRICE_X96 = 1_000n * STUB_Q96;
const dustOutRule: QuoteRule = {
  quote: () => ({ status: "ok", amountOut: 1n, sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER }),
  slot0: () => ({ status: "ok", sqrtPriceX96: DUST_SQRT_PRICE_X96 }),
};

function expectPrimary(state: string, enabled: boolean, label: string) {
  expect(primaryState(), label).toBe(state);
  expect(primaryButton().disabled, label).toBe(!enabled);
}

describe("주 버튼 — 사용자가 ERC-20 페어에서 승인이 필요한지, 바로 스왑할 수 있는지를 상태로 안내받는다", () => {
  describe("ERC-20 페어의 견적이 스왑할 수 없는 값인 경우", () => {
    /**
     * @spec DoD-7
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 토큰 잔액이 금액보다 크게 읽혔다. 스텁은 고른 티어의 수령량과 그 풀의 slot0을 가격 영향 표시값이 `50.00%`(`error` 등급)가 되게 응답하고, allowance를 amountInRaw 이상(maxUint256)으로 응답한다. 표본 ERC-20 페어(WETH 포함): 보내는 USDC·받는 DAI, 보내는 WETH·받는 USDC, 보내는 USDC·받는 WETH를 하나씩 반복하며 금액은 `1`이다
     * @when 표본 페어와 금액을 입력하고 입력 반영 대기(300ms)가 지나 견적이 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then quote-price-impact의 data-severity가 `error`다
     * @then primary-button의 data-state가 `price-impact-too-high`다
     * @then primary-button이 비활성(disabled)이다
     */
    it(
      "[DoD-7] WETH를 포함한 ERC-20 페어에서 가격 영향이 error 등급이면 price-impact-too-high이고 비활성이다",
      async () => {
        const samples = [
          { label: "보내는 USDC·받는 DAI", tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_DAI },
          { label: "보내는 WETH·받는 USDC", tokenIn: ETHEREUM_WETH, tokenOut: ETHEREUM_USDC },
          { label: "보내는 USDC·받는 WETH", tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_WETH },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setQuoteRule(errorImpactRule);
          rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
          const app = await renderConnectedApp();
          await enterPair(app, sample.tokenIn, sample.tokenOut);
          await waitUntil(
            () => expect(app.probe().allowance.status, sample.label).toBe("success"),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(app.probe().quote.status, sample.label).toBe("success");
          expect(priceImpactSeverity(), sample.label).toBe("error");
          expectPrimary("price-impact-too-high", false, sample.label);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-8
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC(잔액이 금액보다 크게 읽힘), 받는 DAI가 선택돼 있으며 슬리피지는 초기값 `50`이다. 스텁은 견적 수령량을 `1`(raw)로, 그 풀의 slot0을 가격 영향이 `error` 등급이 아니게 응답하고, allowance를 amountInRaw 이상(maxUint256)으로 응답한다
     * @when 금액 `1`을 입력하고 입력 반영 대기(300ms)가 지나 견적이 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then useAmountOutMinimum()이 `0n`이다
     * @then quote-price-impact의 data-severity가 `error`가 아니다
     * @then primary-button의 data-state가 `amount-too-small`이다
     * @then primary-button이 비활성(disabled)이다
     */
    it(
      "[DoD-8] ERC-20 페어에서 최소 수령량이 0n이면 amount-too-small이고 비활성이다",
      async () => {
        rpc.setQuoteRule(dustOutRule);
        rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
        const app = await renderConnectedApp();
        await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
        await waitUntil(
          () => expect(app.probe().allowance.status).toBe("success"),
          READY_TIMEOUT_MS,
        );
        await settlePendingWork();

        // 전제: 스텁 수령량 1(raw)의 견적이다.
        expect(app.probe().quote.quote?.amountOut).toBe(1n);

        expect(app.probe().quote.status).toBe("success");
        expect(app.probe().minimum).toBe(0n);
        expect(priceImpactSeverity()).not.toBe("error");
        expectPrimary("amount-too-small", false, "최소 수령량 0");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("현재 키의 allowance 성공 값이 없는 경우", () => {
    /**
     * @spec DoD-9
     * @given Ethereum에 연결돼 있고(계정 변경 표본은 스텁 EIP-1193, 나머지 표본은 mock 커넥터) 보내는 토큰 잔액이 금액보다 크게 읽힌다. 스텁은 견적을 가격 영향 `error` 등급이 아니고 최소 수령량이 0보다 큰 값으로 응답한다. 표본: 보내는 USDC·받는 DAI·금액 `1`의 첫 allowance 응답을 붙잡음, 보내는 USDC의 allowance가 amountInRaw 이상으로 읽혀 `swap-ready`가 된 뒤 연결 계정을 바꾸고(accountsChanged) 새 계정의 allowance 응답을 붙잡음, 같은 `swap-ready` 뒤 드롭다운으로 선택 체인을 Base로 바꾸고 보내는 Base USDC(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)·받는 Base DAI·금액 `1`을 입력해 Base allowance 응답을 붙잡음, 같은 `swap-ready` 뒤 보내는 칸 모달에서 WETH를 골라 WETH allowance 응답을 붙잡음을 하나씩 반복한다
     * @when 표본 상태를 만들고 입력 반영 대기(300ms)가 지나 견적이 끝나기를 기다린다(allowance 응답은 붙잡힌 채로 둔다)
     * @then useSwapQuote()의 status가 `success`다
     * @then useTokenAllowance()의 status가 `loading`이고 allowance가 `null`이다
     * @then primary-button의 data-state가 `checking-allowance`다(이전 키의 성공 값으로 `swap-ready`가 되지 않는다)
     * @then primary-button이 비활성(disabled)이다
     */
    it(
      "[DoD-9] 현재 키의 성공 값 없이 allowance를 읽는 중이면 checking-allowance이고 비활성이다",
      async () => {
        const samples = ["첫 읽기", "계정 변경", "체인 변경", "보내는 토큰 변경"] as const;
        for (const [index, label] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setQuoteRule(parityQuoteRule);
          let app: App;
          let gate: HoldGate;
          if (label === "첫 읽기") {
            gate = rpc.holdAllowance();
            app = await renderConnectedApp();
            await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
          } else {
            // 이전 키(Ethereum, TEST_ACCOUNT, USDC)의 allowance가 amountInRaw 이상으로 읽혀 swap-ready가 된다.
            rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
            app = await renderConnectedApp(label === "계정 변경" ? "stub" : "mock");
            await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
            await waitUntil(
              () => expect(primaryState(), label).toBe("swap-ready"),
              READY_TIMEOUT_MS,
            );

            if (label === "계정 변경") {
              gate = rpc.holdAllowance(matchAllowance.query({ owner: SECOND_ACCOUNT }));
              app.stub!.changeAccounts([SECOND_ACCOUNT]);
            } else if (label === "체인 변경") {
              gate = rpc.holdAllowance(matchAllowance.query({ chainId: base.id }));
              await chooseChainFromDropdown(base);
              await chooseToken("in", BASE_USDC);
              await chooseToken("out", BASE_DAI);
              await typeAmount(AMOUNT);
              await waitForQuoteOf(app, { chainId: base.id, tokenIn: BASE_USDC });
            } else {
              gate = rpc.holdAllowance(matchAllowance.query({ token: ETHEREUM_WETH }));
              await chooseToken("in", ETHEREUM_WETH);
              await waitForQuoteOf(app, { chainId: mainnet.id, tokenIn: ETHEREUM_WETH });
            }
          }
          // 전제: 현재 키의 allowance 응답이 붙잡혀 있다.
          await waitUntil(
            () => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1),
            READY_TIMEOUT_MS,
          );
          await waitUntil(
            () => expect(app.probe().quote.status, label).toBe("success"),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(app.probe().quote.status, label).toBe("success");
          expect(app.probe().allowance, label).toEqual({ status: "loading", allowance: null });
          expectPrimary("checking-allowance", false, label);

          gate.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-14
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 토큰 잔액이 금액보다 크게 읽힌다. 스텁은 견적을 가격 영향 `error` 등급이 아니고 최소 수령량이 0보다 큰 값으로 응답한다. 표본: 보내는 USDC·받는 DAI·금액 `1`의 첫 allowance 요청을 스텁이 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답함, 보내는 USDC의 allowance가 amountInRaw 이상으로 읽혀 `swap-ready`가 된 뒤 보내는 칸 모달에서 WETH를 고르고 WETH allowance 요청을 스텁이 같은 JSON-RPC 오류로 응답함을 하나씩 반복한다
     * @when 표본 상태를 만들고 견적이 끝나고 allowance 실패 응답을 받기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then useTokenAllowance()의 status가 `error`이고 allowance가 `null`이다
     * @then primary-button의 data-state가 `allowance-error`다(이전 키의 성공 값으로 `swap-ready`가 되지 않는다)
     * @then primary-button이 비활성(disabled)이다
     */
    it(
      "[EC-14] 현재 키의 성공 값 없이 allowance 읽기가 실패하면 allowance-error이고 비활성이다",
      async () => {
        const samples = ["첫 읽기 실패", "보내는 토큰 변경 뒤 실패"] as const;
        for (const [index, label] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setQuoteRule(parityQuoteRule);
          const app = await (async () => {
            if (label === "첫 읽기 실패") {
              rpc.failAllowanceWhen(matchAllowance.any);
              const rendered = await renderConnectedApp();
              await enterPair(rendered, ETHEREUM_USDC, ETHEREUM_DAI);
              return rendered;
            }
            rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
            const rendered = await renderConnectedApp();
            await enterPair(rendered, ETHEREUM_USDC, ETHEREUM_DAI);
            await waitUntil(
              () => expect(primaryState(), label).toBe("swap-ready"),
              READY_TIMEOUT_MS,
            );
            rpc.failAllowanceWhen(matchAllowance.query({ token: ETHEREUM_WETH }));
            await chooseToken("in", ETHEREUM_WETH);
            await waitForQuoteOf(rendered, { chainId: mainnet.id, tokenIn: ETHEREUM_WETH });
            return rendered;
          })();
          const currentToken = label === "첫 읽기 실패" ? ETHEREUM_USDC : ETHEREUM_WETH;

          await waitUntil(() => {
            // 전제: 현재 키의 allowance 요청이 실패 응답을 받았다.
            expect(
              rpc
                .requests(matchAllowance.query({ token: currentToken }))
                .some((request) => request.status === "failed"),
              label,
            ).toBe(true);
            expect(app.probe().allowance.status, label).toBe("error");
          }, READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(app.probe().quote.status, label).toBe("success");
          expect(app.probe().allowance, label).toEqual({ status: "error", allowance: null });
          expectPrimary("allowance-error", false, label);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("allowance를 읽은 경우", () => {
    /**
     * @spec DoD-10
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC(잔액이 금액보다 크게 읽힘), 받는 DAI가 선택돼 있다. 스텁은 견적을 가격 영향 `error` 등급이 아니고 최소 수령량이 0보다 큰 값으로 응답한다. 표본 allowance 응답: 기본 스텁 값 `0`, `999999`(amountInRaw − 1)를 하나씩 반복한다
     * @when 금액 `1`을 입력하고 입력 반영 대기(300ms)가 지나 견적과 allowance 읽기가 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then useTokenAllowance()의 status가 `success`이고 allowance가 표본 스텁 값(bigint)이다
     * @then primary-button의 data-state가 `approve-required`다
     * @then primary-button이 활성이다(disabled가 아니다)
     */
    it(
      "[DoD-10] allowance가 amountInRaw보다 작으면 approve-required이고 활성이다",
      async () => {
        // 표본: 기본 스텁 값 0(규칙을 바꾸지 않는다), amountInRaw − 1
        const samples: readonly { label: string; value: bigint | null; expected: bigint }[] = [
          { label: "기본 스텁 값 0", value: null, expected: 0n },
          { label: "amountInRaw − 1", value: 999_999n, expected: 999_999n },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setQuoteRule(parityQuoteRule);
          if (sample.value !== null) rpc.setAllowances(allowanceAlways(sample.value));
          const app = await renderConnectedApp();
          await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
          await waitUntil(
            () => expect(app.probe().allowance.status, sample.label).toBe("success"),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(app.probe().quote.status, sample.label).toBe("success");
          expect(app.probe().allowance, sample.label).toEqual({
            status: "success",
            allowance: sample.expected,
          });
          expectPrimary("approve-required", true, sample.label);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-11 EC-16
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC(잔액이 금액보다 크게 읽힘), 받는 DAI가 선택돼 있다. 스텁은 견적을 가격 영향 `error` 등급이 아니고 최소 수령량이 0보다 큰 값으로 응답한다. 스텁은 owner가 연결 계정, spender가 Ethereum SwapRouter02 리터럴 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, 토큰이 Ethereum USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`인 allowance 요청에만 표본 값으로 응답하고 그 밖의 allowance 요청에는 기본 값 `0`으로 응답한다(지갑에 이미 있는 SwapRouter02 allowance). 표본 allowance: `1000000`(amountInRaw와 같음), maxUint256을 하나씩 반복한다
     * @when 금액 `1`을 입력하고 입력 반영 대기(300ms)가 지나 견적과 allowance 읽기가 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then useTokenAllowance()의 status가 `success`이고 allowance가 표본 스텁 값(bigint)이다
     * @then primary-button의 data-state가 `swap-ready`다
     * @then primary-button이 활성이다(disabled가 아니다)
     * @then 금액 입력부터 판정 시점까지 primary-button의 data-state가 `approve-required`였던 적이 없다
     */
    it(
      "[DoD-11][EC-16] 기존 SwapRouter02 allowance가 amountInRaw 이상이면 approve 없이 swap-ready이고 활성이다",
      async () => {
        // 표본: amountInRaw와 같음, maxUint256
        const samples: readonly bigint[] = [1_000_000n, STUB_MAX_UINT256];
        for (const [index, value] of samples.entries()) {
          if (index > 0) resetSample();
          const label = `allowance ${value}`;
          rpc.setQuoteRule(parityQuoteRule);
          // 연결 계정·Ethereum SwapRouter02·Ethereum USDC 키에만 표본 값, 그 밖에는 기본 값 0
          rpc.setAllowances(
            allowanceWhen(
              {
                chainId: mainnet.id,
                owner: TEST_ACCOUNT,
                spender: ETHEREUM_SWAP_ROUTER02,
                token: ETHEREUM_USDC,
              },
              value,
            ),
          );
          const app = await renderConnectedApp();
          await chooseToken("in", ETHEREUM_USDC);
          await chooseToken("out", ETHEREUM_DAI);
          const mark = app.recorder.states("primary-button").length;
          await typeAmount(AMOUNT);
          await waitForQuoteOf(app, {
            chainId: mainnet.id,
            tokenIn: ETHEREUM_USDC,
            amountIn: AMOUNT_IN_RAW,
          });
          await waitUntil(() => expect(primaryState(), label).toBe("swap-ready"), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(app.probe().quote.status, label).toBe("success");
          expect(app.probe().allowance, label).toEqual({ status: "success", allowance: value });
          expectPrimary("swap-ready", true, label);
          expect(app.recorder.states("primary-button").slice(mark), label).not.toContain(
            "approve-required",
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-10 EC-15
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC(잔액이 `2`보다 크게 읽힘), 받는 DAI가 선택돼 있다. 스텁은 견적을 가격 영향 `error` 등급이 아니고 최소 수령량이 0보다 큰 값으로 응답하고 allowance를 `1500000`으로 응답한다. 금액 `1`(amountInRaw `1000000`)의 견적과 allowance 읽기가 끝나 `swap-ready`가 됐고, allowance 요청 수를 기록해 둔다
     * @when 금액을 `2`(amountInRaw `2000000`)로 바꾸고 입력 반영 대기(300ms)가 지나 견적이 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then useTokenAllowance()의 status가 `success`이고 allowance가 `1500000n`이다
     * @then primary-button의 data-state가 `approve-required`이고 활성이다
     * @then allowance 요청 수가 기록한 값에서 늘지 않는다
     */
    it(
      "[DoD-10][EC-15] 금액이 바뀌면 allowance를 다시 읽지 않고 새 amountInRaw와 비교해 다시 판정한다",
      async () => {
        rpc.setQuoteRule(parityQuoteRule);
        rpc.setAllowances(allowanceAlways(1_500_000n));
        const app = await renderConnectedApp();
        await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
        await waitUntil(() => expect(primaryState()).toBe("swap-ready"), READY_TIMEOUT_MS);
        await settlePendingWork();
        const allowanceBefore = rpc.requests(matchAllowance.any).length;
        // 전제: allowance를 읽었다(분류 양성 대조).
        expect(allowanceBefore).toBeGreaterThanOrEqual(1);

        await typeAmount("2");
        await waitForQuoteOf(app, {
          chainId: mainnet.id,
          tokenIn: ETHEREUM_USDC,
          amountIn: 2_000_000n,
        });
        await waitUntil(() => expect(primaryState()).toBe("approve-required"), READY_TIMEOUT_MS);
        await settlePendingWork();

        expect(app.probe().quote.status).toBe("success");
        expect(app.probe().allowance).toEqual({ status: "success", allowance: 1_500_000n });
        expectPrimary("approve-required", true, "금액 2");
        expect(rpc.requests(matchAllowance.any)).toHaveLength(allowanceBefore);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
