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
  balancesWith,
  defaultQuoteRule,
  installBalanceRpcStub,
  matchQuote,
  sameAddress,
} from "../support/rpc-balance-stub";
import { createStubEip1193 } from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  clearCookies,
  createDeferred,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 `primary-button`의 `data-state`(스펙 §4.2)로 판정한다.
// 지갑은 wagmi mock 커넥터 또는 스텁 EIP-1193, RPC는 전역 fetch 스텁(카드 잔액과 견적 응답)이다.
// 표본 견적 상태는 스텁으로 만든다: loading(응답 붙잡기), success(기본 성공), no-route(네 티어 하위 호출 모두 revert), error(transport 재시도 대상이 아닌 JSON-RPC 오류).
// 견적 상태별 주 버튼(quoting·no-route·quote-error·quote-ready)은 quote-display의 상태별 case가, 미연결·잔액 부족의 success 표본은 quote-read의 DoD-6·DoD-7 case가 맡는다.

const CASE_TIMEOUT_MS = 30_000;
const MULTI_SAMPLE_TIMEOUT_MS = 90_000;

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
type QuoteSample = "loading" | "success" | "no-route" | "error";

// Ethereum 공식 주소(리터럴)
const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
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

async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return view;
}

async function renderDisconnectedApp() {
  const view = renderAppHook(useProbe, { config: appConfig(), initialChainId: mainnet.id });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"));
  return view;
}

// 복원 중인 앱. 지갑이 계정 응답을 끝내지 않아 복원이 끝나지 않는다.
// 복원 제한 시간(5초)이 실제 시간으로 지나지 않도록 가짜 타이머를 켠다(F2 primary-button.test.tsx와 같은 방식).
// 이 case에서 진행하는 가짜 시간은 반영 대기(300ms)와 응답 반영에 필요한 몇 ms뿐이라 5초에 닿지 않는다.
async function renderRestoringApp() {
  vi.useFakeTimers();
  const stub = createStubEip1193({
    chainId: mainnet.id,
    accounts: [TEST_ACCOUNT],
    authorized: true,
  });
  const accounts = createDeferred<readonly Address[]>();
  stub.setHandler("eth_accounts", () => accounts.promise);
  const view = renderAppHook(useProbe, {
    config: appConfig(stubConnector(stub)),
    initialChainId: mainnet.id,
  });
  await settlePendingWork();
  expect(primaryState()).toBe("restoring");
  return view;
}

function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 표본 견적 상태를 만드는 스텁 설정. loading은 견적 응답을 붙잡는다(반환한 게이트).
function arrangeQuoteSample(sample: QuoteSample) {
  if (sample === "no-route") {
    rpc.setQuoteRule({ quote: () => ({ status: "revert" }), slot0: defaultQuoteRule.slot0 });
  }
  if (sample === "error") rpc.failQuoteWhen(matchQuote.input());
  return sample === "loading" ? rpc.holdQuote() : null;
}

// 표본 견적 상태가 될 때까지 기다린다. loading은 반영 대기가 지나 견적 요청이 붙잡힌 상태까지 기다린다.
async function waitForQuoteSample(
  result: { current: ReturnType<typeof useProbe> },
  sample: QuoteSample,
  gate: { heldCount: number } | null,
) {
  if (gate) {
    await waitUntil(() => expect(gate.heldCount, sample).toBeGreaterThanOrEqual(1));
    await settlePendingWork();
  }
  await waitUntil(() => expect(result.current.quote.status, sample).toBe(sample));
}

const QUOTE_SAMPLES: readonly QuoteSample[] = ["loading", "no-route", "error"];

describe("주 버튼 — 사용자가 F2 입력 상태를 견적 상태보다 먼저 안내받는다", () => {
  describe("지갑이 복원 중이거나 미연결인 경우", () => {
    /**
     * @spec DoD-31
     * @given 저장된 연결이 있고 복원이 끝나지 않아 복원 중이다. 보내는 ETH, 받는 USDC, 금액 `1`을 입력했다. 표본 견적 상태: loading, success, no-route, error를 하나씩 반복한다
     * @when 표본 견적 상태가 될 때까지 기다린다
     * @then useSwapQuote()의 status가 표본 견적 상태다
     * @then primary-button의 data-state가 `restoring`이다
     */
    it(
      "[DoD-31] 복원 중이면 견적 상태와 관계없이 restoring이다",
      async () => {
        const samples: readonly QuoteSample[] = ["loading", "success", "no-route", "error"];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderRestoringApp();
          await chooseToken("out", ETHEREUM_USDC);
          const gate = arrangeQuoteSample(sample);
          await typeAmount("1");

          // 가짜 setTimeout: 반영 대기를 지나게 하고, 응답 반영(0ms 알림)이 실행되도록 시계를 조금씩 진행한다.
          await act(async () => {
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
          });
          if (gate) {
            await waitUntilAdvancingFakeClock(() =>
              expect(gate.heldCount, sample).toBeGreaterThanOrEqual(1),
            );
          }
          await waitUntilAdvancingFakeClock(() =>
            expect(result.current.quote.status, sample).toBe(sample),
          );

          expect(result.current.quote.status, sample).toBe(sample);
          expect(primaryState(), sample).toBe("restoring");
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-31
     * @given 저장된 연결이 없고 복원이 끝나 미연결이다. 보내는 ETH, 받는 USDC, 금액 `1`을 입력했다. 표본 견적 상태: loading, no-route, error를 하나씩 반복한다(success 표본은 DoD-6 case가 맡는다)
     * @when 표본 견적 상태가 될 때까지 기다린다
     * @then useSwapQuote()의 status가 표본 견적 상태다
     * @then primary-button의 data-state가 `disconnected`다
     */
    it(
      "[DoD-31] 미연결이면 견적 상태와 관계없이 disconnected다",
      async () => {
        for (const [index, sample] of QUOTE_SAMPLES.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderDisconnectedApp();
          await chooseToken("out", ETHEREUM_USDC);
          const gate = arrangeQuoteSample(sample);
          await typeAmount("1");
          await waitForQuoteSample(result, sample, gate);

          expect(result.current.quote.status, sample).toBe(sample);
          expect(primaryState(), sample).toBe("disconnected");
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("연결 상태에서 F2 입력 상태가 앞서는 경우", () => {
    /**
     * @spec DoD-31
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 1 ETH로 읽혔다. 받는 USDC를 고르고 잔액보다 큰 금액 `2`를 입력했다. 표본 견적 상태: loading, no-route, error를 하나씩 반복한다(success 표본은 DoD-7 case가 맡는다)
     * @when 표본 견적 상태가 될 때까지 기다린다
     * @then useSwapQuote()의 status가 표본 견적 상태다
     * @then primary-button의 data-state가 `insufficient-balance`다
     */
    it(
      "[DoD-31] 잔액 부족이면 견적 상태와 관계없이 insufficient-balance다",
      async () => {
        for (const [index, sample] of QUOTE_SAMPLES.entries()) {
          if (index > 0) resetSample();
          rpc.setBalances(balancesWith({ [ETH_ADDRESS]: ONE_ETH }));
          const { result } = await renderMockConnectedApp();
          await waitUntil(() =>
            expect(
              within(field("in")).queryByTestId("balance")?.getAttribute("data-balance-raw"),
              sample,
            ).toBe(ONE_ETH.toString()),
          );
          await chooseToken("out", ETHEREUM_USDC);
          const gate = arrangeQuoteSample(sample);
          await typeAmount("2");
          await waitForQuoteSample(result, sample, gate);

          expect(result.current.quote.status, sample).toBe(sample);
          expect(primaryState(), sample).toBe("insufficient-balance");
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-31
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`의 견적이 `success`로 표시돼 primary-button이 `quote-ready`다. 표본 변경과 기대 상태: 금액을 지움 → `enter-amount`, 금액 `0`을 입력함 → `enter-amount`, 선택 체인을 Base로 바꿔 받는 칸이 미선택이 됨 → `select-token`을 하나씩 반복한다
     * @when 표본 변경을 일으킨다
     * @then primary-button의 data-state가 표본의 기대 상태다(견적 상태 `quote-ready`가 남지 않는다)
     */
    it(
      "[DoD-31] 토큰 미선택이나 금액이 비었거나 0이면 select-token·enter-amount다",
      async () => {
        const { result } = await renderMockConnectedApp();
        await chooseToken("out", ETHEREUM_USDC);

        async function reachQuoteReady(label: string) {
          await typeAmount("1");
          await waitUntil(() => expect(result.current.quote.status, label).toBe("success"));
          await waitUntil(() => expect(primaryState(), label).toBe("quote-ready"));
        }

        // 금액을 지움 → enter-amount
        await reachQuoteReady("금액 지움 전");
        fireEvent.change(amountInput(), { target: { value: "" } });
        expect(primaryState(), "금액 지움 직후").toBe("enter-amount");
        await settlePendingWork();
        expect(primaryState(), "금액 지움").toBe("enter-amount");

        // 금액 0 → enter-amount
        await reachQuoteReady("금액 0 전");
        fireEvent.change(amountInput(), { target: { value: "0" } });
        expect(primaryState(), "금액 0 직후").toBe("enter-amount");
        await settlePendingWork();
        expect(primaryState(), "금액 0").toBe("enter-amount");

        // 선택 체인을 Base로 바꿔 받는 칸이 미선택 → select-token
        await reachQuoteReady("체인 변경 전");
        act(() => result.current.selected.setSelectedChainId(base.id));
        expect(result.current.form.tokenOut).toBeNull();
        expect(primaryState(), "체인 변경 직후").toBe("select-token");
        await settlePendingWork();
        expect(primaryState(), "체인 변경").toBe("select-token");
      },
      CASE_TIMEOUT_MS,
    );
  });
});
