import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";
import { disconnect, getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSlippage } from "@/providers/slippage-provider";

import { installBalanceRpcStub, sameAddress } from "../support/rpc-balance-stub";
import { createStubEip1193 } from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 앱 Provider 안의 프로브로 useSlippage()를 읽는다.
// 견적 RPC는 전역 fetch 스텁이 응답한다. 지갑은 mock 커넥터 또는 스텁 EIP-1193을 쓴다. `vi.mock`은 쓰지 않는다.
// 프리셋은 화면의 slippage-button으로 slippage-popover를 열고 slippage-option을 눌러 고른다.
// 선택 체인 변경은 DoD-4에서만 앱 Provider 안의 프로브(useSelectedChain().setSelectedChainId)로 한다(체인 선택 UI는 F1 테스트가 덮는다).
// 기대 슬리피지 값(10·50·100 bps)은 제품 상수를 쓰지 않고 리터럴로 적는다.
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.

const CASE_TIMEOUT_MS = 30_000;

// 스펙 §4.1 프리셋 값(리터럴)
type PresetBps = 10 | 50 | 100;

const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// 연결된 지갑의 주 버튼 상태(F2·F3)
const CONNECTED_STATES = [
  "wrapping",
  "unwrapping",
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "wrap-ready",
  "unwrap-ready",
];

beforeEach(() => {
  installBalanceRpcStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
});

// ─── 화면 ─────────────────────────────────────────────────────────

function primaryState(): string | null {
  return screen.getByTestId("primary-button").getAttribute("data-state");
}

function slippageButton(): HTMLElement {
  return screen.getByTestId("slippage-button");
}

function popover(): HTMLElement | null {
  return screen.queryByTestId("slippage-popover");
}

function openedPopover(): HTMLElement {
  const element = popover();
  if (!element) throw new Error("slippage-popover가 열려 있지 않다");
  return element;
}

function options(): HTMLElement[] {
  return within(openedPopover()).getAllByTestId("slippage-option");
}

function option(bps: PresetBps): HTMLElement {
  const found = options().find(
    (element) => element.getAttribute("data-slippage-bps") === String(bps),
  );
  if (!found) throw new Error(`slippage-option[data-slippage-bps="${bps}"]가 없다`);
  return found;
}

// aria-checked가 "true"인 slippage-option의 data-slippage-bps 목록
function checkedBps(): (string | null)[] {
  return options()
    .filter((element) => element.getAttribute("aria-checked") === "true")
    .map((element) => element.getAttribute("data-slippage-bps"));
}

// 세 프리셋 중 `bps`만 선택돼 있는지 확인한다.
function expectOnlyChecked(bps: PresetBps, label: string) {
  expect(options(), label).toHaveLength(3);
  expect(checkedBps(), label).toEqual([String(bps)]);
}

async function openPopover() {
  fireEvent.click(slippageButton());
  await waitUntil(() => {
    expect(popover()).not.toBeNull();
    expect(slippageButton().getAttribute("aria-expanded")).toBe("true");
  });
}

// 팝오버 안의 닫기 버튼(✕, role `button`)으로 닫는다.
async function closePopover() {
  fireEvent.click(within(openedPopover()).getByRole("button"));
  await waitUntil(() => expect(popover()).toBeNull());
}

// 화면에서 프리셋을 고르고 팝오버를 닫는다.
async function choosePresetAndClose(bps: PresetBps) {
  await openPopover();
  fireEvent.click(option(bps));
  await waitUntil(() => expect(checkedBps()).toEqual([String(bps)]));
  await closePopover();
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { slippage: useSlippage(), selected: useSelectedChain() };
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
  const config = appConfig();
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"));
  return { ...view, config };
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱
async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return { ...view, config };
}

// 스텁 EIP-1193 지갑으로 Ethereum에 연결된 앱
async function renderStubConnectedApp() {
  const stub = createStubEip1193({
    chainId: mainnet.id,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const config = appConfig(stubConnector(stub));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(sameAddress(connection.address, TEST_ACCOUNT)).toBe(true);
  });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return { ...view, config, stub };
}

// 표본 사이에 렌더·스텁·쿠키를 새로 시작한다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  installBalanceRpcStub();
}

describe("슬리피지 값 — 사용자가 고른 허용치가 체인·지갑 변화와 연속 입력에도 그대로 남는다", () => {
  describe("앱을 처음 여는 경우", () => {
    /**
     * @spec DoD-1
     * @given 선택 체인이 Ethereum이다. 표본: 저장된 연결이 없는 미연결 상태, mock 커넥터로 연결된 상태를 하나씩 반복하며 표본마다 앱을 새로 렌더링한다
     * @when 슬리피지를 바꾸지 않은 채 앱 Provider 안에서 useSlippage()를 읽는다
     * @then useSlippage()의 slippageBps가 50이다
     */
    it(
      "[DoD-1] 처음 연 앱의 슬리피지는 50 bps다",
      async () => {
        const samples = ["미연결", "mock 커넥터 연결"] as const;

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } =
            sample === "미연결" ? await renderDisconnectedApp() : await renderMockConnectedApp();
          await settlePendingWork();

          expect(result.current.slippage.slippageBps, sample).toBe(50);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("프리셋을 고르는 경우", () => {
    /**
     * @spec DoD-3 DoD-8 DoD-9
     * @given 앱을 렌더링하고 slippage-popover를 열었다. 표본: 프리셋 10, 100, 50 bps를 이 순서로 하나씩 반복한다(표본마다 직전 값과 다른 값을 고르며 팝오버는 닫지 않는다)
     * @when data-slippage-bps가 표본 값인 slippage-option을 누른다
     * @then useSlippage()의 slippageBps가 표본 값이다
     * @then data-slippage-bps가 표본 값인 slippage-option만 aria-checked가 `true`이고 나머지 두 개는 aria-checked가 `true`가 아니다
     * @then 선택 뒤 대기 중인 작업을 진행시킨 뒤에도(harness의 settlePendingWork 관례) `slippage-popover`가 렌더링돼 있고 `aria-expanded`가 `true`다
     */
    it(
      "[DoD-3][DoD-8][DoD-9] 프리셋을 고르면 slippageBps가 그 값이 되고 그 프리셋만 선택되며 팝오버는 열린 채로 남는다",
      async () => {
        const { result } = await renderDisconnectedApp();
        await openPopover();

        for (const bps of [10, 100, 50] as const) {
          const label = `프리셋 ${bps}`;
          // 전제: 직전 값과 다른 값을 고른다.
          expect(result.current.slippage.slippageBps, label).not.toBe(bps);

          fireEvent.click(option(bps));

          await waitUntil(() => expect(result.current.slippage.slippageBps, label).toBe(bps));
          expectOnlyChecked(bps, label);

          // 지연된 자동 닫힘이 있으면 드러나도록 대기 중인 작업을 진행시킨 뒤 판정한다.
          await settlePendingWork();
          expect(popover(), label).not.toBeNull();
          expect(slippageButton().getAttribute("aria-expanded"), label).toBe("true");
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-7
     * @given 앱을 렌더링하고 slippage-popover를 열었다. 표본: 누르는 순서 [10, 100], [100, 10, 50], [10, 50, 100, 10]을 하나씩 반복한다
     * @when 표본 순서대로 slippage-option을 사이에 화면 갱신을 기다리지 않고 연달아 누른 뒤 화면이 안정되기를 기다린다
     * @then useSlippage()의 slippageBps가 표본의 마지막 값이다
     * @then 표본의 마지막 값인 slippage-option만 aria-checked가 `true`다
     */
    it(
      "[EC-7] 프리셋을 연달아 누르면 마지막으로 누른 값이 남는다",
      async () => {
        const samples: readonly (readonly PresetBps[])[] = [
          [10, 100],
          [100, 10, 50],
          [10, 50, 100, 10],
        ];

        for (const [index, sequence] of samples.entries()) {
          if (index > 0) resetSample();
          const label = sequence.join("→");
          const { result } = await renderDisconnectedApp();
          await openPopover();

          // 클릭 사이에 대기(await)를 두지 않고 연달아 누른다.
          for (const bps of sequence) fireEvent.click(option(bps));

          const last = sequence[sequence.length - 1]!;
          await waitUntil(() => expect(result.current.slippage.slippageBps, label).toBe(last));
          await settlePendingWork();

          expect(result.current.slippage.slippageBps, label).toBe(last);
          expectOnlyChecked(last, label);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("선택 체인이 바뀌는 경우", () => {
    /**
     * @spec DoD-4
     * @given 선택 체인이 Ethereum이고 지갑은 연결되지 않았다. 화면에서 프리셋 100 bps(기본값이 아닌 값)를 고르고 팝오버를 닫았다. 표본: 바꿀 선택 체인 Base, Arbitrum을 하나씩 반복한다
     * @when 앱 Provider 안의 프로브로 useSelectedChain().setSelectedChainId(표본 체인 ID)를 불러 선택 체인을 바꾸고 바뀐 체인이 화면에 반영되기를 기다린다
     * @then useSlippage()의 slippageBps가 100이다
     * @then slippage-popover를 다시 열면 data-slippage-bps가 `100`인 slippage-option만 aria-checked가 `true`다
     */
    it(
      "[DoD-4] 선택 체인을 바꿔도 슬리피지 값이 유지된다",
      async () => {
        const samples = [
          { label: "Base", chainId: base.id },
          { label: "Arbitrum", chainId: arbitrum.id },
        ] as const;

        for (const [index, { label, chainId }] of samples.entries()) {
          if (index > 0) resetSample();
          const { result } = await renderDisconnectedApp();
          await choosePresetAndClose(100);
          expect(result.current.slippage.slippageBps, label).toBe(100);

          act(() => result.current.selected.setSelectedChainId(chainId));

          await waitUntil(() =>
            expect(
              screen.getByTestId("chain-select").getAttribute("data-selected-chain-id"),
              label,
            ).toBe(String(chainId)),
          );
          await settlePendingWork();

          expect(result.current.slippage.slippageBps, label).toBe(100);
          await openPopover();
          expectOnlyChecked(100, label);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("지갑 연결이 바뀌는 경우", () => {
    /**
     * @spec DoD-5
     * @given 선택 체인이 Ethereum이다. 화면에서 프리셋 100 bps(기본값이 아닌 값)를 고르고 팝오버를 닫았다. 표본: mock 커넥터로 연결된 상태에서 연결 해제, 스텁 EIP-1193 지갑으로 연결된 상태에서 계정을 다른 주소로 변경을 하나씩 반복한다
     * @when 표본의 지갑 변화를 일으키고 그 변화(미연결 또는 새 계정)가 앱에 반영되기를 기다린다
     * @then useSlippage()의 slippageBps가 100이다
     * @then slippage-popover를 다시 열면 data-slippage-bps가 `100`인 slippage-option만 aria-checked가 `true`다
     */
    it(
      "[DoD-5] 지갑 연결 해제와 계정 변경 뒤에도 슬리피지 값이 유지된다",
      async () => {
        const samples = ["mock 커넥터 연결 해제", "스텁 지갑 계정 변경"] as const;

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();

          let read: () => number;
          if (sample === "mock 커넥터 연결 해제") {
            const { result, config } = await renderMockConnectedApp();
            read = () => result.current.slippage.slippageBps;
            await choosePresetAndClose(100);
            expect(read(), sample).toBe(100);

            await act(async () => {
              await disconnect(config);
            });

            await waitUntil(() => {
              expect(getConnection(config).status, sample).toBe("disconnected");
              expect(primaryState(), sample).toBe("disconnected");
            });
          } else {
            const { result, config, stub } = await renderStubConnectedApp();
            read = () => result.current.slippage.slippageBps;
            await choosePresetAndClose(100);
            expect(read(), sample).toBe(100);

            act(() => stub.changeAccounts([SECOND_ACCOUNT]));

            await waitUntil(() => {
              const connection = getConnection(config);
              expect(connection.status, sample).toBe("connected");
              expect(sameAddress(connection.address, SECOND_ACCOUNT), sample).toBe(true);
            });
          }
          await settlePendingWork();

          expect(read(), sample).toBe(100);
          await openPopover();
          expectOnlyChecked(100, sample);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
