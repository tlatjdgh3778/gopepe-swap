import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";

import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceRpcStub,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  defaultQuoteRule,
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
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 견적 RPC는 전역 fetch 스텁과 견적 aggregate3 스텁이 응답한다.
// 지갑은 mock 커넥터를 쓴다. 팝오버 조작은 실제 DOM 이벤트(클릭, 키 입력, 포인터·포커스 이동)로 일으킨다. `vi.mock`은 쓰지 않는다.
// 열림 여부는 slippage-popover의 렌더링 여부와 slippage-button의 aria-expanded로, 포커스는 document.activeElement로 판정한다.
// 닫기 버튼(✕)은 slippage-popover 안의 role `button`으로 찾고, 접근성 이름은 비어 있지 않음만 확인하며 문구와 비교하지 않는다(사용자 확정).
// 이 파일에서 선택 체인 프로브(useSelectedChain().setSelectedChainId)는 EC-4에서만 쓴다(체인 선택 클릭은 바깥 클릭이라 팝오버가 닫힌다).
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.

const CASE_TIMEOUT_MS = 30_000;
// DoD-6은 10개 조합을 표본마다 새로 렌더링한다.
const DOD6_TIMEOUT_MS = 120_000;

// Ethereum USDC 공식 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// success 표본의 스텁 고정 수령량(raw USDC)
const FIXED_AMOUNT_OUT = 1_234_567_891_234n;

// 연결된 지갑의 주 버튼 상태(F2·F3)
const CONNECTED_STATES = [
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "quote-ready",
];

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

// ─── 화면 ─────────────────────────────────────────────────────────

function primaryState(): string | null {
  return screen.getByTestId("primary-button").getAttribute("data-state");
}

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

async function chooseOutToken(address: Address) {
  fireEvent.click(within(field("out")).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe("out"));
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

function slippageButton(): HTMLElement {
  return screen.getByTestId("slippage-button");
}

function ariaExpanded(): string | null {
  return slippageButton().getAttribute("aria-expanded");
}

function popover(): HTMLElement | null {
  return screen.queryByTestId("slippage-popover");
}

function openedPopover(): HTMLElement {
  const element = popover();
  if (!element) throw new Error("slippage-popover가 열려 있지 않다");
  return element;
}

async function openPopover() {
  fireEvent.click(slippageButton());
  await waitUntil(() => {
    expect(popover()).not.toBeNull();
    expect(ariaExpanded()).toBe("true");
  });
}

// 팝오버를 열고 포커스를 팝오버 안의 요소(선택된 프리셋)에 둔다.
async function openPopoverWithFocusInside() {
  await openPopover();
  const checked = within(openedPopover())
    .getAllByTestId("slippage-option")
    .find((element) => element.getAttribute("aria-checked") === "true");
  if (!checked) throw new Error("선택된 slippage-option이 없다");
  act(() => checked.focus());
  await settlePendingWork();
  // 전제: 포커스가 팝오버 안에 있고 설정 버튼이 아니다.
  expect(popover()).not.toBeNull();
  expect(openedPopover().contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(slippageButton());
}

// 닫힌 상태(팝오버 없음, aria-expanded false)가 되기를 기다린다.
async function waitUntilClosed() {
  await waitUntil(() => {
    expect(popover()).toBeNull();
    expect(ariaExpanded()).toBe("false");
  });
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { quote: useSwapQuote(), selected: useSelectedChain() };
}

function appConfig(connector?: CreateConnectorFn) {
  return createWagmiConfig({
    connectors: connector ? [connector] : [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// 저장된 연결이 없는 앱. 커넥터가 없어 복원 시도가 곧 끝나고 미연결이 된다.
async function renderDisconnectedApp() {
  const view = renderAppHook(useProbe, { config: appConfig(), initialChainId: mainnet.id });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"));
  return view;
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱. 기본 잔액 규칙은 보내는 ETH 잔액이 1 ETH보다 훨씬 크다.
async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return view;
}

// 표본 사이에 렌더·스텁·쿠키를 새로 시작한다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  rpc = installBalanceRpcStub();
}

describe("슬리피지 팝오버 — 사용자가 설정 버튼으로 팝오버를 열어 프리셋을 고르고 닫는다", () => {
  describe("설정 버튼", () => {
    /**
     * @spec DoD-6
     * @given 선택 체인이 Ethereum이다. 표본: 지갑 상태(저장된 연결이 없는 미연결, mock 커넥터 연결) × 견적 상태(idle: 받는 토큰 미선택, loading: 보내는 ETH·받는 USDC·금액 `1`에서 스텁이 견적 응답을 붙잡고 있음, success: 같은 입력에서 스텁이 고정 수령량을 응답, no-route: 같은 입력에서 스텁이 네 티어 견적 하위 호출을 모두 revert로 응답, error: 같은 입력에서 스텁이 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답) 10개 조합을 하나씩 반복하며 표본마다 앱을 새로 렌더링한다
     * @when 표본의 견적 상태가 되기를 기다린다
     * @then 표본마다 useSwapQuote()의 status가 표본 견적 상태인 시점에 slippage-button이 렌더링돼 있다
     */
    it(
      "[DoD-6] 설정 버튼은 견적 상태와 지갑 연결 상태에 관계없이 렌더링된다",
      async () => {
        const wallets = ["미연결", "mock 커넥터 연결"] as const;
        const statuses = ["idle", "loading", "success", "no-route", "error"] as const;
        let first = true;

        for (const wallet of wallets) {
          for (const status of statuses) {
            if (!first) resetSample();
            first = false;
            const label = `${wallet} × ${status}`;

            if (status === "success") {
              rpc.setQuoteRule({
                quote: () => ({
                  status: "ok",
                  amountOut: FIXED_AMOUNT_OUT,
                  sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
                }),
                slot0: defaultQuoteRule.slot0,
              });
            } else if (status === "no-route") {
              rpc.setQuoteRule({
                quote: () => ({ status: "revert" }),
                slot0: defaultQuoteRule.slot0,
              });
            } else if (status === "error") {
              rpc.failQuoteWhen(matchQuote.input());
            }

            const { result } =
              wallet === "미연결" ? await renderDisconnectedApp() : await renderMockConnectedApp();

            let release: (() => void) | undefined;
            if (status === "idle") {
              // 받는 토큰 미선택
              await settlePendingWork();
            } else {
              await chooseOutToken(ETHEREUM_USDC);
              await settlePendingWork();
              if (status === "loading") {
                const gate = rpc.holdQuote();
                release = () => gate.release();
                await typeAmount("1");
                await waitUntil(() => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1));
              } else {
                await typeAmount("1");
              }
            }
            await waitUntil(() => expect(result.current.quote.status, label).toBe(status));

            // 같은 시점에 판정한다.
            expect(result.current.quote.status, label).toBe(status);
            expect(screen.queryByTestId("slippage-button"), label).not.toBeNull();

            release?.();
          }
        }
      },
      DOD6_TIMEOUT_MS,
    );
  });

  describe("팝오버를 여는 경우", () => {
    /**
     * @spec DoD-7 DoD-8
     * @given mock 커넥터로 Ethereum에 연결된 앱을 렌더링했고 slippage-popover가 렌더링돼 있지 않다
     * @when slippage-button을 누른다
     * @then 누르기 전에는 slippage-button의 aria-expanded가 `false`다
     * @then 누른 뒤 slippage-popover가 렌더링돼 있다
     * @then 누른 뒤 slippage-button의 aria-expanded가 `true`다
     * @then 누른 뒤 slippage-popover 안에 role `radiogroup`이 하나 있고 그 안에 role `radio`가 정확히 세 개다
     * @then 세 radio가 각각 slippage-option이고 data-slippage-bps 값의 집합이 `10`, `50`, `100`이다
     * @then 처음 연 값인 data-slippage-bps `50`의 slippage-option만 aria-checked가 `true`이고 나머지 두 개는 aria-checked가 `true`가 아니다
     */
    it(
      "[DoD-7][DoD-8] 설정 버튼을 누르면 팝오버가 열리고 aria-expanded가 true가 되며 처음 값 50 bps 프리셋만 선택돼 있다",
      async () => {
        await renderMockConnectedApp();
        await settlePendingWork();
        expect(popover()).toBeNull();
        expect(ariaExpanded()).toBe("false");

        fireEvent.click(slippageButton());

        await waitUntil(() => expect(popover()).not.toBeNull());
        expect(ariaExpanded()).toBe("true");

        const opened = openedPopover();
        const groups = within(opened).getAllByRole("radiogroup");
        expect(groups).toHaveLength(1);
        const radios = within(groups[0]!).getAllByRole("radio");
        expect(radios).toHaveLength(3);

        for (const radio of radios) {
          expect(radio.getAttribute("data-testid")).toBe("slippage-option");
        }
        // 팝오버 안의 slippage-option이 곧 이 세 radio다.
        expect(within(opened).getAllByTestId("slippage-option")).toEqual(radios);
        expect(new Set(radios.map((radio) => radio.getAttribute("data-slippage-bps")))).toEqual(
          new Set(["10", "50", "100"]),
        );

        const checked = radios
          .filter((radio) => radio.getAttribute("aria-checked") === "true")
          .map((radio) => radio.getAttribute("data-slippage-bps"));
        expect(checked).toEqual(["50"]);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("팝오버를 닫는 경우", () => {
    /**
     * @spec DoD-10 DoD-13
     * @given mock 커넥터로 Ethereum에 연결된 앱에서 slippage-popover를 열었고 포커스가 팝오버 안의 요소에 있다(slippage-button이 아니다)
     * @when 팝오버 안의 닫기 버튼(✕)을 누른다
     * @then slippage-popover가 렌더링되지 않는다
     * @then slippage-button의 aria-expanded가 `false`다
     * @then document.activeElement가 slippage-button이다
     */
    it(
      "[DoD-10][DoD-13] 닫기 버튼을 누르면 팝오버가 닫히고 포커스가 설정 버튼으로 돌아간다",
      async () => {
        await renderMockConnectedApp();
        await openPopoverWithFocusInside();

        const buttons = within(openedPopover()).getAllByRole("button");
        expect(buttons).toHaveLength(1);
        // 접근성 이름은 비어 있지 않음만 확인한다(문구 비교 없음).
        const closeButton = within(openedPopover()).getByRole("button", { name: /\S/ });
        expect(closeButton).toBe(buttons[0]);

        fireEvent.click(closeButton);

        await waitUntilClosed();
        await waitUntil(() => expect(document.activeElement).toBe(slippageButton()));
        expect(popover()).toBeNull();
        expect(ariaExpanded()).toBe("false");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-11 DoD-13
     * @given mock 커넥터로 Ethereum에 연결된 앱에서 slippage-popover를 열었고 포커스가 팝오버 안의 요소에 있다(slippage-button이 아니다)
     * @when 포커스된 요소에서 Esc 키를 누른다
     * @then slippage-popover가 렌더링되지 않는다
     * @then slippage-button의 aria-expanded가 `false`다
     * @then document.activeElement가 slippage-button이다
     */
    it(
      "[DoD-11][DoD-13] Esc를 누르면 팝오버가 닫히고 포커스가 설정 버튼으로 돌아간다",
      async () => {
        await renderMockConnectedApp();
        await openPopoverWithFocusInside();
        const focused = document.activeElement;
        if (!focused) throw new Error("포커스된 요소가 없다");

        fireEvent.keyDown(focused, { key: "Escape" });

        await waitUntilClosed();
        await waitUntil(() => expect(document.activeElement).toBe(slippageButton()));
        expect(popover()).toBeNull();
        expect(ariaExpanded()).toBe("false");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-12 DoD-29
     * @given mock 커넥터로 Ethereum에 연결된 앱에서 slippage-popover를 열었고 포커스가 팝오버 안의 요소에 있다. 클릭할 대상은 팝오버 바깥에 있으며 포커스를 받지 않는 비대화형 영역이다. 실제 Chrome 마우스 경로는 이 테스트가 아니라 T-9 수동 확인이 맡는다
     * @when 그 바깥 영역을 jsdom에서 Base UI 가상 클릭 경로(`fireEvent` 기본값, `detail` 0)로 클릭한다
     * @then slippage-popover가 렌더링되지 않는다
     * @then slippage-button의 aria-expanded가 `false`다
     * @then document.activeElement가 slippage-button이다
     */
    it(
      "[DoD-12][DoD-29] 포커스를 받지 않는 바깥 영역을 클릭하면 팝오버가 닫히고 포커스가 설정 버튼으로 돌아간다",
      async () => {
        await renderMockConnectedApp();
        await openPopoverWithFocusInside();

        // 받는 칸 영역(div) 자체를 누른다. 안의 버튼·입력칸이 아니다.
        const outside = field("out");
        // 전제: 팝오버 바깥이고 포커스를 받지 않는 비대화형 요소다.
        expect(openedPopover().contains(outside)).toBe(false);
        expect(outside.tagName).toBe("DIV");
        expect(outside.hasAttribute("tabindex")).toBe(false);
        expect(outside.hasAttribute("contenteditable")).toBe(false);

        // Base UI 가상 클릭 경로: fireEvent 기본값(detail 0)
        fireEvent.click(outside);

        await waitUntilClosed();
        await waitUntil(() => expect(document.activeElement).toBe(slippageButton()));
        expect(popover()).toBeNull();
        expect(ariaExpanded()).toBe("false");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-12 EC-8
     * @given mock 커넥터로 Ethereum에 연결된 앱에서 slippage-popover를 열었고 포커스가 팝오버 안의 요소에 있다. 클릭할 대상은 팝오버 바깥의 보내는 칸 amount-input이다
     * @when 보내는 칸 amount-input을 클릭해 포커스가 그 입력칸으로 옮겨 가게 한다(포인터 누름, 포커스 이동, 클릭을 브라우저 순서로 일으킨다)
     * @then slippage-popover가 렌더링되지 않는다
     * @then slippage-button의 aria-expanded가 `false`다
     * @then 닫힌 뒤 화면이 안정된 시점에 document.activeElement가 보내는 칸 amount-input이다
     */
    it(
      "[DoD-12][EC-8] 금액 입력칸을 클릭해 팝오버가 닫히면 포커스가 그 입력칸에 남는다",
      async () => {
        await renderMockConnectedApp();
        await openPopoverWithFocusInside();
        const input = amountInput();
        // 전제: 팝오버 바깥의 입력칸이다.
        expect(openedPopover().contains(input)).toBe(false);

        // 브라우저의 마우스 클릭 순서: 누름 → 포커스 이동 → 뗌 → 클릭
        fireEvent.pointerDown(input, { button: 0, buttons: 1, pointerType: "mouse" });
        fireEvent.mouseDown(input, { button: 0, buttons: 1, detail: 1 });
        act(() => input.focus());
        fireEvent.pointerUp(input, { button: 0, pointerType: "mouse" });
        fireEvent.mouseUp(input, { button: 0, detail: 1 });
        fireEvent.click(input, { button: 0, detail: 1 });

        await waitUntilClosed();
        // 닫힌 뒤 대기 중인 작업(포커스 복귀 등)을 진행시키고 판정한다.
        await settlePendingWork();
        expect(popover()).toBeNull();
        expect(ariaExpanded()).toBe("false");
        expect(document.activeElement).toBe(input);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("팝오버가 열린 동안 선택 체인이 바뀌는 경우", () => {
    /**
     * @spec EC-4
     * @given 선택 체인이 Ethereum이고 지갑은 연결되지 않은 앱에서 slippage-popover를 열었다. 표본: 바꿀 선택 체인 Base, Arbitrum을 하나씩 반복하며 표본마다 앱을 새로 렌더링한다
     * @when 화면을 클릭하지 않고 앱 Provider 안의 프로브로 useSelectedChain().setSelectedChainId(표본 체인 ID)를 부른 뒤 바뀐 체인이 화면에 반영되기를 기다린다
     * @then slippage-popover가 렌더링돼 있다
     * @then slippage-button의 aria-expanded가 `true`다
     */
    it(
      "[EC-4] 팝오버가 열린 채 선택 체인을 바꾸면 팝오버는 열린 채로 남는다",
      async () => {
        const samples = [
          { label: "Base", chainId: base.id },
          { label: "Arbitrum", chainId: arbitrum.id },
        ] as const;

        for (const [index, { label, chainId }] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderDisconnectedApp();
          await openPopover();

          act(() => result.current.selected.setSelectedChainId(chainId));

          await waitUntil(() =>
            expect(
              screen.getByTestId("chain-select").getAttribute("data-selected-chain-id"),
              label,
            ).toBe(String(chainId)),
          );
          await settlePendingWork();

          expect(popover(), label).not.toBeNull();
          expect(ariaExpanded(), label).toBe("true");
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
