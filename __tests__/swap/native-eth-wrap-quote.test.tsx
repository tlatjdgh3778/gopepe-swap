import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSlippage } from "@/providers/slippage-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

import {
  type BalanceRpcStub,
  installBalanceRpcStub,
  match,
  matchAllowance,
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
} from "../support/wagmi-harness";

// 골격(T-6). ETH ↔ WETH의 즉시 1:1 견적, 받는 칸, 견적 정보 영역, 최소 수령량, 주 버튼, allowance 무요청,
// 페어 전환, 슬리피지 무영향을 앱 화면과 훅 값으로 확인한다.
// mock 경계(D-3 사용자 확정, 2026-11-20): F3·F4 경계만 쓴다. wagmi mock 커넥터, 전역 fetch의 URL 라우팅 스텁,
// 가짜 타이머. vi.mock은 쓰지 않는다. 그 밖의 provider·훅·컴포넌트는 실제 코드를 쓴다.
// 데이터 격리: 표본마다 config·RPC 스텁·QueryClient를 새로 만들고 쿠키를 지운다(clearCookies).
// 기대 주소(ETH, 체인별 WETH·USDC)는 제품 config를 쓰지 않고 아래 리터럴로 적는다. 토큰 선택도 이 리터럴 주소의 목록 행을 누른다.

const CASE_TIMEOUT_MS = 30_000;
const MULTI_SAMPLE_TIMEOUT_MS = 90_000;
const MANY_SAMPLE_TIMEOUT_MS = 180_000;

// 스펙 값: 입력 반영 대기 300ms(F3 DoD-26), 견적 주기 15초(F3 DoD-27)
const DEBOUNCE_MS = 300;
const REFETCH_MS = 15_000;

// 공식 주소(리터럴)
const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const LITERALS: Record<SupportedChainId, { weth: Address; usdc: Address }> = {
  [mainnet.id]: {
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  [base.id]: {
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  [arbitrum.id]: {
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
};
const ETHEREUM = LITERALS[mainnet.id];

// 금액 `1`(ETH·WETH decimals 18)의 amountInRaw
const ONE_ETH_RAW = 1_000_000_000_000_000_000n;

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
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 입력 반영 대기(setTimeout)와 주기(setInterval), 시계를 가짜로 둔다(F3 EC-6과 같다).
function fakeAllTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

function nextSeq(): number {
  return rpc.requests().length;
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

function outAmountRaw(): string | null {
  return within(field("out")).getByTestId("amount-input").getAttribute("data-amount-out-raw");
}

function primaryButton(): HTMLButtonElement {
  return screen.getByTestId("primary-button") as HTMLButtonElement;
}

function primaryState(): string | null {
  return primaryButton().getAttribute("data-state");
}

// 칸에 선택된 토큰 주소. 토큰을 고르지 않은 칸은 token-button의 data-token-address가 빈 값("")이므로
// 빈 값과 속성 없음을 모두 "선택된 토큰 없음"(undefined)으로 돌려준다.
function tokenAddressOf(side: Side): string | undefined {
  const address = within(field(side))
    .getByTestId("token-button")
    .getAttribute("data-token-address");
  return address === null || address === "" ? undefined : address;
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

async function openTokenModal(side: Side) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
}

async function waitTokenModalClosed() {
  await waitUntil(() => expect(tokenModal()).toBeNull());
}

// 모달에서 토큰을 고른다. `beforePick`은 목록 행을 누르기 직전에 호출된다(기준 시점 기록용).
async function chooseToken(side: Side, address: Address, beforePick?: () => void) {
  await openTokenModal(side);
  beforePick?.();
  fireEvent.click(optionRow(address));
  await waitTokenModalClosed();
  expect(sameAddress(tokenAddressOf(side), address)).toBe(true);
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

async function waitForBalanceIn() {
  await waitUntil(() =>
    expect(
      within(field("in")).queryByTestId("balance")?.getAttribute("data-balance-raw"),
    ).toBeTruthy(),
  );
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"));
  });
}

function slippageButton(): HTMLElement {
  return screen.getByTestId("slippage-button");
}

function slippageOption(bps: number): HTMLElement {
  const popover = screen.getByTestId("slippage-popover");
  const option = within(popover)
    .getAllByTestId("slippage-option")
    .find((element) => element.getAttribute("data-slippage-bps") === String(bps));
  if (!option) throw new Error(`slippage-option ${bps}가 없다`);
  return option;
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return {
    selected: useSelectedChain(),
    quote: useSwapQuote(),
    minimum: useAmountOutMinimum(),
    allowance: useTokenAllowance(),
    slippage: useSlippage(),
  };
}

type Probe = ReturnType<typeof useProbe>;

function wrapAmountOut(probe: Probe): bigint | null {
  return probe.quote.status === "wrap" ? probe.quote.amountOut : null;
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱(선택 체인 Ethereum, 기본 입력: 보내는 ETH·받는 칸 미선택).
// 기본 잔액 규칙은 모든 토큰 잔액이 표본 금액보다 훨씬 크다.
async function renderMockConnectedApp(): Promise<() => Probe> {
  const config = createWagmiConfig({
    connectors: [mockConnector({ defaultConnected: true, reconnect: true })],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(primaryState()).toBe("select-token"));
  return () => view.result.current;
}

// 앱의 선택 체인만 바꾼다(mock 커넥터는 Ethereum에 연결된 채로 둔다). 입력은 그 체인의 기본값으로 돌아간다.
async function selectChain(probe: () => Probe, chainId: SupportedChainId) {
  if (probe().selected.selectedChainId === chainId) return;
  act(() => probe().selected.setSelectedChainId(chainId));
  await waitUntil(() => {
    expect(probe().selected.selectedChainId).toBe(chainId);
    expect(sameAddress(tokenAddressOf("in"), ETH_ADDRESS)).toBe(true);
    expect(tokenAddressOf("out")).toBeUndefined();
  });
}

type Direction = "eth-to-weth" | "weth-to-eth";

// 기본 입력(보내는 ETH, 받는 칸 미선택)에서 받는 칸 모달로 WETH를 골라 ETH → WETH를 만들고,
// WETH → ETH는 이어서 보내는 칸 모달로 WETH를 골라 두 칸을 맞바꾼다.
// `atPairFormed`는 받는 칸에서 WETH를 고르기 직전(두 토큰이 처음 ETH·WETH가 되는 시점)에 호출된다.
async function makeWrapPair(
  chainId: SupportedChainId,
  direction: Direction,
  atPairFormed?: () => void,
) {
  const weth = LITERALS[chainId].weth;
  await chooseToken("out", weth, atPairFormed);
  if (direction === "weth-to-eth") await chooseToken("in", weth);
  const [expectedIn, expectedOut] =
    direction === "eth-to-weth" ? [ETH_ADDRESS, weth] : [weth, ETH_ADDRESS];
  expect(sameAddress(tokenAddressOf("in"), expectedIn), direction).toBe(true);
  expect(sameAddress(tokenAddressOf("out"), expectedOut), direction).toBe(true);
}

describe("ETH ↔ WETH — 사용자가 ETH와 WETH를 고르면 견적 요청 없이 1:1 수령량과 전환 버튼을 바로 본다", () => {
  describe("두 토큰이 ETH와 WETH이고 금액이 0보다 큰 경우", () => {
    /**
     * @spec DoD-14 DoD-15 DoD-16 DoD-17
     * @given 가짜 타이머를 쓰고 mock 커넥터는 Ethereum에 연결된 채로 두며 앱의 선택 체인만 바꾼다(Base·Arbitrum 표본은 연결 체인과 선택 체인이 다르다). 보내는 토큰 잔액은 금액보다 크게 읽힌다. 페어는 선택 체인의 기본 입력(보내는 ETH, 받는 칸 미선택)에서 받는 칸 모달로 WETH를 골라 ETH → WETH를 만들고, WETH → ETH 표본은 이어서 보내는 칸 모달로 WETH를 골라 두 칸을 맞바꾼다. 받는 칸에서 WETH를 고른 시점(두 토큰이 처음 ETH·WETH가 된 시점)에 카드 잔액 읽기로 분류되지 않는 JSON-RPC 항목 수를 기록한다. 표본: 선택 체인(Ethereum, Base, Arbitrum) × 방향(보내는 ETH·받는 WETH, 보내는 WETH·받는 ETH) × 금액(`1` → amountInRaw `1000000000000000000`, `0.000000000000000001` → amountInRaw `1`)을 하나씩 반복한다
     * @when 페어를 만든 뒤 금액을 입력하고 가짜 타이머를 진행하지 않은 채 확인한 뒤, 이어서 가짜 시계를 입력 반영 대기 300ms와 견적 주기 15초를 넘게 진행한다
     * @then 타이머를 진행하지 않은 상태에서 useSwapQuote()의 status가 `wrap`이고 amountOut이 표본 금액의 amountInRaw 리터럴(`1000000000000000000n`, `1n`)이다
     * @then 타이머를 진행하지 않은 상태에서 받는 칸 amount-input의 data-amount-out-raw가 표본 금액의 amountInRaw 10진 문자열 리터럴(`"1000000000000000000"`, `"1"`)이다
     * @then 타이머를 진행하지 않은 상태에서 환율 행(quote-rate)과 견적 정보 영역(quote-details)이 렌더링되지 않는다
     * @then 타이머를 진행하지 않은 상태에서 useAmountOutMinimum()이 `null`이다
     * @then 300ms와 15초를 넘게 진행한 뒤, 카드 잔액 읽기(eth_getBalance·balanceOf·잔액 aggregate3)로 분류되지 않는 모든 JSON-RPC 항목(메서드 무관, 견적 aggregate3 포함) 수가 두 토큰이 ETH·WETH가 된 시점에 기록한 값에서 늘지 않는다
     */
    it(
      "[DoD-14][DoD-15][DoD-16][DoD-17] RPC와 입력 반영 대기 없이 즉시 wrap이고 받는 칸은 amountInRaw, 견적 정보 영역과 최소 수령량은 없다",
      async () => {
        const chains: SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        const directions: Direction[] = ["eth-to-weth", "weth-to-eth"];
        const amounts = [
          { input: "1", raw: 1_000_000_000_000_000_000n, rawText: "1000000000000000000" },
          { input: "0.000000000000000001", raw: 1n, rawText: "1" },
        ] as const;
        const samples = chains.flatMap((chainId) =>
          directions.flatMap((direction) =>
            amounts.map((amount) => ({ chainId, direction, amount })),
          ),
        );
        expect(samples).toHaveLength(12);

        for (const [index, { chainId, direction, amount }] of samples.entries()) {
          const label = `${chainId} ${direction} ${amount.input}`;
          if (index > 0) resetSample();

          const probe = await renderMockConnectedApp();
          await selectChain(probe, chainId);
          let seq = -1;
          await makeWrapPair(chainId, direction, () => {
            seq = nextSeq();
          });
          await waitForBalanceIn();
          await settlePendingWork();

          fakeAllTimers();
          fireEvent.change(amountInput(), { target: { value: amount.input } });

          // 타이머를 진행하지 않은 상태
          expect(amountInput().value, label).toBe(amount.input);
          expect(probe().quote.status, label).toBe("wrap");
          expect(wrapAmountOut(probe()), label).toBe(amount.raw);
          expect(outAmountRaw(), label).toBe(amount.rawText);
          expect(screen.queryByTestId("quote-rate"), label).toBeNull();
          expect(screen.queryByTestId("quote-details"), label).toBeNull();
          expect(probe().minimum, label).toBeNull();

          // 300ms와 15초를 넘게 진행
          await act(async () => {
            await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
          });
          await act(async () => {
            await vi.advanceTimersByTimeAsync(REFETCH_MS + 1);
          });
          await settlePendingWork();
          expect(seq, label).toBeGreaterThanOrEqual(0);
          expect(rpc.requests(match.since(seq, matchQuote.notBalance)), label).toEqual([]);
          vi.useRealTimers();
        }
      },
      MANY_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-18
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 금액보다 크게 읽혔다. 보내는 ETH, 받는 WETH를 고르고 금액 `1`을 입력한다
     * @when useSwapQuote()의 status가 `wrap`이 된 뒤 주 버튼을 읽는다
     * @then primary-button의 data-state가 `wrap-ready`다
     * @then primary-button이 활성(disabled가 아님)이다
     */
    it(
      "[DoD-18] ETH → WETH 견적이 wrap이면 주 버튼이 wrap-ready이고 활성이다",
      async () => {
        const probe = await renderMockConnectedApp();
        await makeWrapPair(mainnet.id, "eth-to-weth");
        await waitForBalanceIn();
        await typeAmount("1");
        await waitUntil(() => expect(probe().quote.status).toBe("wrap"));
        await settlePendingWork();

        expect(primaryState()).toBe("wrap-ready");
        expect(primaryButton().disabled).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-19
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 WETH 잔액이 금액보다 크게 읽혔다. 보내는 WETH, 받는 ETH를 고르고 금액 `1`을 입력한다
     * @when useSwapQuote()의 status가 `wrap`이 된 뒤 주 버튼을 읽는다
     * @then primary-button의 data-state가 `unwrap-ready`다
     * @then primary-button이 활성(disabled가 아님)이다
     */
    it(
      "[DoD-19] WETH → ETH 견적이 wrap이면 주 버튼이 unwrap-ready이고 활성이다",
      async () => {
        const probe = await renderMockConnectedApp();
        await makeWrapPair(mainnet.id, "weth-to-eth");
        await waitForBalanceIn();
        await typeAmount("1");
        await waitUntil(() => expect(probe().quote.status).toBe("wrap"));
        await settlePendingWork();

        expect(primaryState()).toBe("unwrap-ready");
        expect(primaryButton().disabled).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("두 토큰이 ETH와 WETH일 때의 allowance", () => {
    /**
     * @spec DoD-20
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 토큰 잔액이 금액보다 크게 읽힌다. 페어는 기본 입력(보내는 ETH, 받는 칸 미선택)에서 받는 칸 모달로 WETH를 골라 ETH → WETH를 만들고, WETH → ETH 표본은 이어서 보내는 칸 모달로 WETH를 골라 두 칸을 맞바꾼다. 받는 칸에서 WETH를 고른 시점(두 토큰이 처음 ETH·WETH가 된 시점)에 allowance 읽기 요청 수를 기록한다. 표본: 보내는 WETH·받는 ETH, 보내는 ETH·받는 WETH를 하나씩 반복하며 페어를 만든 뒤 금액 `1`을 입력한다
     * @when useSwapQuote()의 status가 `wrap`이 된 뒤 window `focus` 이벤트를 발생시키고 대기 중인 작업이 끝나기를 기다린다
     * @then useTokenAllowance()의 status가 `idle`이고 allowance가 `null`이다
     * @then 포커스 이후 판정 시점의 allowance 읽기 요청 수가 두 토큰이 ETH·WETH가 된 시점에 기록한 값에서 늘지 않는다
     */
    it(
      "[DoD-20] 보내는 토큰이 WETH여도 allowance는 idle이고 포커스 뒤에도 읽기 요청이 없다",
      async () => {
        const directions: Direction[] = ["weth-to-eth", "eth-to-weth"];
        for (const [index, direction] of directions.entries()) {
          if (index > 0) resetSample();
          const probe = await renderMockConnectedApp();
          let seq = -1;
          await makeWrapPair(mainnet.id, direction, () => {
            seq = nextSeq();
          });
          await waitForBalanceIn();
          await typeAmount("1");
          await waitUntil(() => expect(probe().quote.status, direction).toBe("wrap"));

          focusWindow();
          await settlePendingWork();

          expect(probe().allowance, direction).toEqual({ status: "idle", allowance: null });
          expect(seq, direction).toBeGreaterThanOrEqual(0);
          expect(rpc.requests(match.since(seq, matchAllowance.any)), direction).toEqual([]);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("토큰을 바꿔 페어가 바뀌는 경우", () => {
    /**
     * @spec EC-9
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 금액 `1`로 useSwapQuote()의 status가 `wrap`이다. 표본: 보내는 ETH·받는 WETH에서 받는 칸 모달로 USDC를 고름(ETH → USDC), 보내는 WETH·받는 ETH에서 보내는 칸 모달로 USDC를 고름(USDC → ETH)을 하나씩 반복한다
     * @when 표본의 토큰을 고르고 가짜 타이머를 진행하지 않은 채 확인한다
     * @then useSwapQuote()의 status가 `wrap`이 아니다
     */
    it(
      "[EC-9] ETH ↔ WETH에서 다른 페어로 가면 즉시 wrap이 아니다",
      async () => {
        // 표본: [처음 페어, 모달을 여는 칸] — ETH → WETH의 받는 칸에서 USDC(ETH → USDC), WETH → ETH의 보내는 칸에서 USDC(USDC → ETH)
        const samples = [
          { direction: "eth-to-weth", side: "out" },
          { direction: "weth-to-eth", side: "in" },
        ] as const;
        for (const [index, { direction, side }] of samples.entries()) {
          const label = `${direction} → ${side} USDC`;
          if (index > 0) resetSample();
          const probe = await renderMockConnectedApp();
          await makeWrapPair(mainnet.id, direction);
          await waitForBalanceIn();
          await typeAmount("1");
          await waitUntil(() => expect(probe().quote.status, label).toBe("wrap"));
          await settlePendingWork();

          await openTokenModal(side);
          fakeAllTimers();
          fireEvent.click(optionRow(ETHEREUM.usdc));

          // 타이머를 진행하지 않은 상태
          expect(sameAddress(tokenAddressOf(side), ETHEREUM.usdc), label).toBe(true);
          expect(probe().quote.status, label).not.toBe("wrap");

          // 판정 뒤에는 모달 닫힘을 기다리지 않는다(가짜 시계에 예약된 닫힘 타이머가 실제 시계로 넘어오지 않는다).
          vi.useRealTimers();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-9
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 스텁은 견적에 기본 성공 응답을 준다. 금액 `1`로 다른 페어의 견적이 `success`가 됐다. 표본: 보내는 ETH·받는 USDC에서 받는 칸 모달로 WETH를 고름(ETH → WETH), 보내는 USDC·받는 ETH에서 보내는 칸 모달로 WETH를 고름(WETH → ETH)을 하나씩 반복한다
     * @when 표본의 토큰을 고르고 가짜 타이머를 진행하지 않은 채 확인한다
     * @then useSwapQuote()의 status가 `wrap`이고 amountOut이 `1000000000000000000n`(금액 `1`의 amountInRaw)이다
     */
    it(
      "[EC-9] 다른 페어에서 ETH ↔ WETH로 오면 즉시 wrap이다",
      async () => {
        // 표본: ETH → USDC의 받는 칸에서 WETH(ETH → WETH), USDC → ETH의 보내는 칸에서 WETH(WETH → ETH)
        const samples = ["eth-to-usdc", "usdc-to-eth"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const probe = await renderMockConnectedApp();
          if (sample === "eth-to-usdc") {
            await chooseToken("out", ETHEREUM.usdc);
          } else {
            await chooseToken("in", ETHEREUM.usdc);
            await chooseToken("out", ETH_ADDRESS);
          }
          await waitForBalanceIn();
          await typeAmount("1");
          await waitUntil(() => expect(probe().quote.status, sample).toBe("success"));
          await settlePendingWork();

          const side: Side = sample === "eth-to-usdc" ? "out" : "in";
          await openTokenModal(side);
          fakeAllTimers();
          fireEvent.click(optionRow(ETHEREUM.weth));

          // 타이머를 진행하지 않은 상태
          expect(sameAddress(tokenAddressOf(side), ETHEREUM.weth), sample).toBe(true);
          expect(amountInput().value, sample).toBe("1");
          expect(probe().quote.status, sample).toBe("wrap");
          expect(wrapAmountOut(probe()), sample).toBe(ONE_ETH_RAW);

          // 판정 뒤에는 모달 닫힘을 기다리지 않는다(가짜 시계에 예약된 닫힘 타이머가 실제 시계로 넘어오지 않는다).
          vi.useRealTimers();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("견적 상태가 wrap일 때 슬리피지를 바꾸는 경우", () => {
    /**
     * @spec EC-10
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 토큰 잔액이 금액보다 크게 읽힌다. 금액 `1`로 useSwapQuote()의 status가 `wrap`이며, 그때의 status·amountOut·primary-button의 data-state를 기록해 둔다. 표본: 방향(보내는 ETH·받는 WETH, 보내는 WETH·받는 ETH) × 고를 슬리피지 프리셋(현재 값 50과 다른 10, 100)을 하나씩 반복한다
     * @when slippage-button으로 팝오버를 열고 표본 프리셋 slippage-option을 눌러 useSlippage()의 slippageBps가 표본 값이 되기를 기다린다
     * @then useSwapQuote()의 status가 기록한 값(`wrap`)과 같다
     * @then useSwapQuote()의 amountOut이 기록한 값(`1000000000000000000n`)과 같다
     * @then primary-button의 data-state가 기록한 값(ETH → WETH는 `wrap-ready`, WETH → ETH는 `unwrap-ready`)과 같다
     */
    it(
      "[EC-10] 슬리피지를 바꿔도 견적 상태·amountOut·주 버튼이 바뀌지 않는다",
      async () => {
        const directions: Direction[] = ["eth-to-weth", "weth-to-eth"];
        const presets = [10, 100] as const;
        const samples = directions.flatMap((direction) =>
          presets.map((preset) => ({ direction, preset })),
        );
        for (const [index, { direction, preset }] of samples.entries()) {
          const label = `${direction} ${preset}`;
          if (index > 0) resetSample();
          const probe = await renderMockConnectedApp();
          await makeWrapPair(mainnet.id, direction);
          await waitForBalanceIn();
          await typeAmount("1");
          await waitUntil(() => expect(probe().quote.status, label).toBe("wrap"));
          await settlePendingWork();

          // 바꾸기 전 기록(전제: 슬리피지 기본값 50, 금액 `1`의 wrap, 방향별 주 버튼)
          expect(probe().slippage.slippageBps, label).toBe(50);
          const before = {
            status: probe().quote.status,
            amountOut: wrapAmountOut(probe()),
            primary: primaryState(),
          };
          expect(before, label).toEqual({
            status: "wrap",
            amountOut: ONE_ETH_RAW,
            primary: direction === "eth-to-weth" ? "wrap-ready" : "unwrap-ready",
          });

          fireEvent.click(slippageButton());
          await waitUntil(() => expect(screen.queryByTestId("slippage-popover")).not.toBeNull());
          fireEvent.click(slippageOption(preset));
          await waitUntil(() => expect(probe().slippage.slippageBps, label).toBe(preset));
          await settlePendingWork();

          expect(probe().quote.status, label).toBe(before.status);
          expect(wrapAmountOut(probe()), label).toBe(before.amountOut);
          expect(primaryState(), label).toBe(before.primary);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });
});
