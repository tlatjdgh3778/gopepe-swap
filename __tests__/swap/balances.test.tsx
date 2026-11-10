import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";
import { disconnect, getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import {
  NATIVE_ETH_ADDRESS,
  PINNED_TOKENS_BY_CHAIN,
  TOKENS_BY_CHAIN,
  type Token,
} from "@/config/tokens";
import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";

import {
  type BalanceFn,
  type BalanceRpcRequest,
  type BalanceRpcStub,
  type RequestMatcher,
  defaultBalance,
  installBalanceRpcStub,
  match,
  sameAddress,
} from "../support/rpc-balance-stub";
import { createStubEip1193 } from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeTimeTo,
  clearCookies,
  createDeferred,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 잔액 식별자(`balance`, `token-option`의 `data-balance-raw`)와
// 전역 fetch 스텁이 센 JSON-RPC 요청으로 판정한다. 지갑은 wagmi mock 커넥터 또는 스텁 EIP-1193이다.
// 15초 주기 판정은 가짜 타이머를 쓰고, 주기 시작 시점(카드 읽기 요청 시각)부터 시계를 진행한다.
// 대기 헬퍼(`waitUntil`, `settlePendingWork`)는 가짜 시계를 움직이지 않는다.

const CASE_TIMEOUT_MS = 30_000;
const CARD_REFETCH_MS = 15_000;

let rpc: BalanceRpcStub;

beforeEach(() => {
  rpc = installBalanceRpcStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
});

type Side = "in" | "out";
type WalletSample = "disconnected" | "restoring";

const CONNECTED_STATES = ["select-token", "enter-amount", "insufficient-balance", "input-valid"];
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const ETHEREUM_PINNED = PINNED_TOKENS_BY_CHAIN[mainnet.id];
const ETH = ETHEREUM_PINNED[0];
const USDC = ETHEREUM_PINNED[2];
const DAI = ETHEREUM_PINNED[4];
const BASE_ETH = PINNED_TOKENS_BY_CHAIN[base.id][0];
const ETHEREUM_TOKENS = TOKENS_BY_CHAIN[mainnet.id];

const ONE_ETH = 1_000_000_000_000_000_000n;

// 목록 토큰 잔액 일괄 읽기 요청 종류
const LIST_READ = match.kind("eth_getBalance", "aggregate3");

function field(side: Side): HTMLElement {
  const found = screen
    .getAllByTestId("token-field")
    .find((element) => element.getAttribute("data-side") === side);
  if (!found) throw new Error(`token-field[data-side="${side}"]가 없다`);
  return found;
}

function tokenButton(side: Side): HTMLElement {
  return within(field(side)).getByTestId("token-button");
}

function tokenAddress(side: Side): string | null {
  return tokenButton(side).getAttribute("data-token-address");
}

function amountInput(): HTMLInputElement {
  return within(field("in")).getByTestId("amount-input") as HTMLInputElement;
}

function balanceElement(side: Side): HTMLElement | null {
  return within(field(side)).queryByTestId("balance");
}

function balanceRaw(side: Side): string | null | undefined {
  const element = balanceElement(side);
  return element ? element.getAttribute("data-balance-raw") : undefined;
}

function maxButton(): HTMLButtonElement | null {
  return within(field("in")).queryByTestId("max-button") as HTMLButtonElement | null;
}

function primaryState(): string | null {
  return screen.getByTestId("primary-button").getAttribute("data-state");
}

function tokenModal(): HTMLElement | null {
  return screen.queryByTestId("token-modal");
}

function optionRows(): HTMLElement[] {
  const modal = tokenModal();
  return modal ? within(modal).queryAllByTestId("token-option") : [];
}

function rowAddress(row: HTMLElement): Address {
  return (row.getAttribute("data-token-address") ?? "") as Address;
}

function optionRow(address: string): HTMLElement {
  const row = optionRows().find((element) => sameAddress(rowAddress(element), address));
  if (!row) throw new Error(`token-option ${address}가 없다`);
  return row;
}

async function openModal(side: Side) {
  fireEvent.click(tokenButton(side));
  await waitUntil(() => {
    expect(tokenModal()?.getAttribute("data-side")).toBe(side);
    expect(optionRows().length).toBeGreaterThan(0);
  });
}

// 모달 행을 누르고 모달이 닫힐 때까지 기다린다.
async function clickRowAndWaitClosed(address: string) {
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
}

async function chooseToken(side: Side, token: Token) {
  await openModal(side);
  await clickRowAndWaitClosed(token.address);
  expect(tokenAddress(side)).toBe(token.address);
}

// 보내는 칸 모달을 열었다가 현재 토큰(ETH) 행을 눌러 토큰을 바꾸지 않고 닫는다.
async function closeModalKeepingTokens() {
  expect(tokenModal()?.getAttribute("data-side")).toBe("in");
  const inBefore = tokenAddress("in");
  const outBefore = tokenAddress("out");
  await clickRowAndWaitClosed(inBefore ?? "");
  expect(tokenAddress("in")).toBe(inBefore);
  expect(tokenAddress("out")).toBe(outBefore);
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

function balanceQuery(
  token: string,
  account: Address = TEST_ACCOUNT,
  chainId: SupportedChainId = mainnet.id,
) {
  return { chainId, account, token: token as Address };
}

function stubBalance(
  token: string,
  account: Address = TEST_ACCOUNT,
  chainId: SupportedChainId = mainnet.id,
): string {
  return rpc.balanceOf(balanceQuery(token, account, chainId)).toString();
}

// 화면에 보이지 않는다: 요소가 없거나, 숨겨져 있고 잔액 속성이 없다.
function isHidden(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || getComputedStyle(node).display === "none") return true;
  }
  return false;
}

function expectNotShown(element: HTMLElement | null, label: string) {
  if (element === null) return;
  expect(element.hasAttribute("data-balance-raw"), label).toBe(false);
  expect(isHidden(element), label).toBe(true);
}

// 모달의 모든 행이 기대한 `data-balance-raw`(없으면 null)를 가진다.
function expectRows(
  chainId: SupportedChainId,
  expected: (address: Address) => string | null,
  label = "",
) {
  const rows = optionRows();
  expect(rows.length, label).toBe(TOKENS_BY_CHAIN[chainId].length);
  for (const row of rows) {
    const address = rowAddress(row);
    expect(row.getAttribute("data-balance-raw"), `${label} ${address}`).toBe(expected(address));
  }
}

function count(matcher: RequestMatcher): number {
  return rpc.requests(matcher).length;
}

function nextSeq(): number {
  return rpc.requests().length;
}

function settledRequests(matcher: RequestMatcher): BalanceRpcRequest[] {
  return rpc.requests(matcher).filter((request) => request.status !== "pending");
}

// DoD-10 순서: 대소문자를 무시한 심볼순, 심볼이 같으면 소문자 주소 문자열순(코드 단위 비교).
function compareByDoD10(a: Token, b: Token): number {
  const symbolA = a.symbol.toLowerCase();
  const symbolB = b.symbol.toLowerCase();
  if (symbolA !== symbolB) return symbolA < symbolB ? -1 : 1;
  const addressA = a.address.toLowerCase();
  const addressB = b.address.toLowerCase();
  if (addressA === addressB) return 0;
  return addressA < addressB ? -1 : 1;
}

function isPinned(token: Token): boolean {
  return ETHEREUM_PINNED.some((candidate) => sameAddress(candidate.address, token.address));
}

// DoD-9 순서: 고정 토큰 5개, 잔액이 0보다 큰 토큰, 나머지 토큰(각 그룹 안은 DoD-10 순서).
function expectedOrder(hasPositiveBalance: (token: Token) => boolean): Address[] {
  const others = ETHEREUM_TOKENS.filter((token) => !isPinned(token));
  const withBalance = others.filter(hasPositiveBalance).sort(compareByDoD10);
  const rest = others.filter((token) => !hasPositiveBalance(token)).sort(compareByDoD10);
  return [...ETHEREUM_PINNED, ...withBalance, ...rest].map((token) => token.address);
}

function useProbe() {
  return { form: useSwapForm(), selected: useSelectedChain() };
}

function appConfig(connector?: CreateConnectorFn) {
  return createWagmiConfig({
    connectors: connector ? [connector] : [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱. 연결 상태의 주 버튼이 될 때까지 기다린다.
async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return { ...view, config };
}

// 스텁 EIP-1193 지갑으로 연결된 앱. 선택 체인은 Ethereum이고 지갑 체인은 `walletChainId`다.
async function renderStubConnectedApp(walletChainId: SupportedChainId = mainnet.id) {
  const stub = createStubEip1193({
    chainId: walletChainId,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const config = appConfig(stubConnector(stub));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(walletChainId);
  });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return { ...view, config, stub };
}

async function renderDisconnectedApp() {
  const view = renderAppHook(useProbe, { config: appConfig(), initialChainId: mainnet.id });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"));
  return view;
}

// 복원 중인 앱. 지갑이 계정 응답을 끝내지 않아 복원이 끝나지 않는다.
// 복원 제한 시간(5초)이 실제 시간으로 지나지 않도록 가짜 타이머를 켜고 시계는 움직이지 않는다.
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

async function renderWalletSample(sample: WalletSample) {
  return sample === "disconnected" ? await renderDisconnectedApp() : await renderRestoringApp();
}

function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 15초 주기 판정용 가짜 타이머. 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 두고 setTimeout은 실제로 둔다.
// react-query는 `refetchInterval`을 전역 setInterval로 예약하고(`timeoutManager.setInterval`),
// 관찰자 알림은 setTimeout(0)으로 미룬다(`notifyManager` 기본 스케줄러). setTimeout까지 가짜로 두면
// 시계를 진행하는 도중 처리된 응답의 0ms 알림이 현재+1ms로 밀려, 시계를 더 움직이기 전까지 화면에 반영되지 않는다.
// 주기 경계 판정은 가짜 시계로 정확히 하고, 응답 반영(알림)은 실제 타이머로 진행되게 한다.
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

// 카드 잔액 요청 조건: 보내는 칸 ETH는 `eth_getBalance`, ERC-20 칸은 그 토큰 주소로 가는 `balanceOf`.
const CARD_ETH = match.chain(mainnet.id, match.kind("eth_getBalance"));
const CARD_USDC = match.chain(mainnet.id, match.balanceOfToken(USDC.address));

// 주기 타이머·시계만 가짜로 두고 앱을 연결한 뒤, 받는 칸 USDC를 고르고 두 칸의 카드 잔액이 표시될 때까지 기다린다.
// 가짜 시계를 움직이지 않으므로 두 칸 카드 읽기의 주기 시작 시점은 각 칸 첫 카드 요청 시각이다.
async function setupTwoCardsWithFakeTimers() {
  fakePeriodicTimers();
  await renderMockConnectedApp();
  await chooseToken("out", USDC);
  await waitUntil(() => {
    expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS));
    expect(balanceRaw("out")).toBe(stubBalance(USDC.address));
  });
  await settlePendingWork();
  const firstIn = rpc.requests(CARD_ETH)[0];
  const firstOut = rpc.requests(CARD_USDC)[0];
  expect(firstIn).toBeDefined();
  expect(firstOut).toBeDefined();
  return { inStart: firstIn!.at, outStart: firstOut!.at };
}

const CHANGED: BalanceFn = (query) => defaultBalance(query) + 777n;

describe("잔액 — 사용자가 선택 체인 기준의 최신 잔액을 보고 토큰과 금액을 정한다", () => {
  describe("카드 잔액을 다시 읽는 경우", () => {
    /**
     * @spec DoD-17
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC(ERC-20)이고 두 칸의 카드 잔액 첫 읽기가 성공해 표시됐다. 그 뒤 스텁의 ETH·USDC 잔액 응답을 다른 값으로 바꿨다
     * @when 가짜 타이머로 첫 읽기 성공 시점부터 15초를 진행한다
     * @then 15초가 되기 직전까지는 `eth_getBalance` 요청 수와 받는 칸 USDC 잔액 읽기 요청 수가 늘지 않는다
     * @then 15초가 지나면 `eth_getBalance` 요청이 1회 늘고 받는 칸 USDC 잔액 읽기 요청이 다시 발생한다
     * @then 다시 15초가 지나면 `eth_getBalance` 요청이 1회 더 늘고 받는 칸 USDC 잔액 읽기 요청이 한 번 더 발생한다
     * @then 보내는 칸 balance의 data-balance-raw가 바뀐 ETH 스텁 값이다
     * @then 받는 칸 balance의 data-balance-raw가 바뀐 USDC 스텁 값이다
     */
    it(
      "[DoD-17] 카드 잔액을 15초마다 다시 읽는다",
      async () => {
        const { inStart, outStart } = await setupTwoCardsWithFakeTimers();
        rpc.setBalances(CHANGED);

        const tracks = [
          {
            label: "보내는 칸 ETH",
            start: inStart,
            matcher: CARD_ETH,
            side: "in" as const,
            token: NATIVE_ETH_ADDRESS,
          },
          {
            label: "받는 칸 USDC",
            start: outStart,
            matcher: CARD_USDC,
            side: "out" as const,
            token: USDC.address,
          },
        ].map((track) => ({ ...track, base: count(track.matcher) }));

        // 각 칸: 15초 직전(+0), 15초(+1), 30초 직전(+1), 30초(+2)
        const checkpoints = tracks
          .flatMap((track) => [
            { time: track.start + CARD_REFETCH_MS - 1, track, increase: 0, boundary: false },
            { time: track.start + CARD_REFETCH_MS, track, increase: 1, boundary: true },
            { time: track.start + 2 * CARD_REFETCH_MS - 1, track, increase: 1, boundary: false },
            { time: track.start + 2 * CARD_REFETCH_MS, track, increase: 2, boundary: true },
          ])
          .sort((a, b) => a.time - b.time);

        for (const { time, track, increase, boundary } of checkpoints) {
          const label = `${track.label} ${time - track.start}ms`;
          if (time > Date.now()) await advanceFakeTimeTo(time);
          if (boundary) {
            await waitUntil(() => expect(count(track.matcher), label).toBe(track.base + increase));
          }
          await settlePendingWork();
          expect(count(track.matcher), label).toBe(track.base + increase);
          if (boundary && increase === 1) {
            await waitUntil(() =>
              expect(balanceRaw(track.side), label).toBe(stubBalance(track.token)),
            );
          }
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-18
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC(ERC-20)이고 두 칸의 카드 잔액 첫 읽기가 성공해 표시됐다. 그 뒤 스텁의 ETH·USDC 잔액 응답을 다른 값으로 바꿨고 타이머는 진행하지 않는다
     * @when window `focus` 이벤트를 발생시킨다
     * @then `eth_getBalance` 요청이 1회 늘고 받는 칸 USDC 잔액 읽기 요청이 다시 발생한다
     * @then 보내는 칸 balance의 data-balance-raw가 바뀐 ETH 스텁 값이다
     * @then 받는 칸 balance의 data-balance-raw가 바뀐 USDC 스텁 값이다
     */
    it(
      "[DoD-18] 창에 포커스가 돌아오면 카드 잔액을 다시 읽는다",
      async () => {
        await setupTwoCardsWithFakeTimers();
        rpc.setBalances(CHANGED);
        const ethBefore = count(CARD_ETH);
        const usdcBefore = count(CARD_USDC);

        focusWindow();

        await waitUntil(() => {
          expect(count(CARD_ETH)).toBe(ethBefore + 1);
          expect(count(CARD_USDC)).toBe(usdcBefore + 1);
        });
        await waitUntil(() => {
          expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS));
          expect(balanceRaw("out")).toBe(stubBalance(USDC.address));
        });
        await settlePendingWork();
        expect(count(CARD_ETH)).toBe(ethBefore + 1);
        expect(count(CARD_USDC)).toBe(usdcBefore + 1);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-19
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC(ERC-20)가 선택돼 두 칸의 카드 잔액 읽기가 성공했다. 스텁은 체인·토큰마다 다른 잔액을 돌려준다. 표본: 선택 체인을 Base로 바꿈, 보내는 칸 모달에서 DAI를 고름, 받는 칸 모달에서 DAI를 고름을 하나씩 반복한다(계정 변경은 EC-6 case가 맡는다)
     * @when 표본 변경을 일으킨다(타이머·포커스 이벤트 없이)
     * @then 변경이 닿는 칸(체인 표본은 EC-1로 받는 칸이 미선택이 되므로 보내는 칸, 토큰 표본은 고른 칸)마다 변경 뒤의 체인·토큰 기준으로 카드 잔액 읽기 요청이 발생한다
     * @then 그 칸 balance의 data-balance-raw가 변경 뒤 기준의 스텁 값이다
     */
    it(
      "[DoD-19] 계정, 선택 체인, 선택 토큰이 바뀌면 카드 잔액을 다시 읽는다",
      async () => {
        const samples = ["선택 체인 Base", "보내는 칸 DAI", "받는 칸 DAI"] as const;

        for (const sample of samples) {
          const { result } = await renderStubConnectedApp();
          await chooseToken("out", USDC);
          await waitUntil(() => {
            expect(balanceRaw("in"), sample).toBe(stubBalance(NATIVE_ETH_ADDRESS));
            expect(balanceRaw("out"), sample).toBe(stubBalance(USDC.address));
          });
          const seq = nextSeq();

          if (sample === "선택 체인 Base") {
            act(() => result.current.selected.setSelectedChainId(base.id));
            await waitUntil(() => expect(tokenAddress("in"), sample).toBe(BASE_ETH.address));
            expect(tokenAddress("out"), sample).toBe("");
            await waitUntil(() =>
              expect(
                count(
                  match.since(
                    seq,
                    match.chain(base.id, match.account(TEST_ACCOUNT, match.kind("eth_getBalance"))),
                  ),
                ),
                sample,
              ).toBeGreaterThan(0),
            );
            await waitUntil(() =>
              expect(balanceRaw("in"), sample).toBe(
                stubBalance(NATIVE_ETH_ADDRESS, TEST_ACCOUNT, base.id),
              ),
            );
          } else {
            const side = sample === "보내는 칸 DAI" ? "in" : "out";
            await chooseToken(side, DAI);
            await waitUntil(() =>
              expect(
                count(
                  match.since(
                    seq,
                    match.chain(
                      mainnet.id,
                      match.account(TEST_ACCOUNT, match.balanceOfToken(DAI.address)),
                    ),
                  ),
                ),
                sample,
              ).toBeGreaterThan(0),
            );
            await waitUntil(() => expect(balanceRaw(side), sample).toBe(stubBalance(DAI.address)));
          }

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("카드 잔액이 아직 없거나 읽기에 실패한 경우", () => {
    /**
     * @spec EC-9 EC-10
     * @given Ethereum에 연결돼 있다(계정 변경 표본은 스텁 EIP-1193, 나머지 표본은 mock 커넥터). 표본: 보내는 ETH의 첫 읽기 응답이 지연 중, 보내는 ETH의 첫 읽기가 실패, 보내는 ETH 잔액을 읽은 뒤 USDC로 바꾸고 USDC 읽기 응답이 지연 중, 보내는 ETH 잔액 읽기가 성공한 상태에서 연결 계정을 바꾸고(accountsChanged) 새 계정 읽기 응답이 지연 중, 보내는 ETH 잔액 읽기가 성공한 상태에서 선택 체인을 Base로 바꾸고(보내는 칸은 Base ETH가 되며 네이티브 ETH 주소는 모든 체인에서 같다) 새 읽기 응답이 지연 중을 하나씩 반복한다
     * @when 보내는 칸의 잔액과 max-button을 확인한다
     * @then 보내는 칸 balance 요소가 표시돼 있고 data-balance-raw가 없다(이전 토큰·계정·체인의 잔액을 쓰지 않는다)
     * @then 보내는 칸 balance 요소의 텍스트가 `—`다
     * @then max-button이 비활성이다
     */
    it(
      "[EC-9][EC-10] 성공한 카드 잔액이 없으면 —를 표시하고 최대를 비활성화한다",
      async () => {
        const samples = [
          "첫 읽기 응답 지연",
          "첫 읽기 실패",
          "USDC로 바꾼 뒤 응답 지연",
          "계정 변경 뒤 응답 지연",
          "Base로 바꾼 뒤 응답 지연",
        ] as const;

        for (const sample of samples) {
          let release = () => {};

          if (sample === "첫 읽기 응답 지연") {
            const gate = rpc.hold(match.kind("eth_getBalance"));
            release = gate.release;
            await renderMockConnectedApp();
            await waitUntil(() => expect(gate.heldCount, sample).toBeGreaterThan(0));
          } else if (sample === "첫 읽기 실패") {
            rpc.failWhen(match.kind("eth_getBalance"));
            await renderMockConnectedApp();
            await waitUntil(() =>
              expect(settledRequests(CARD_ETH).length, sample).toBeGreaterThan(0),
            );
          } else if (sample === "USDC로 바꾼 뒤 응답 지연") {
            await renderMockConnectedApp();
            await waitUntil(() =>
              expect(balanceRaw("in"), sample).toBe(stubBalance(NATIVE_ETH_ADDRESS)),
            );
            const gate = rpc.hold(match.balanceOfToken(USDC.address));
            release = gate.release;
            await chooseToken("in", USDC);
            await waitUntil(() => expect(gate.heldCount, sample).toBeGreaterThan(0));
          } else if (sample === "계정 변경 뒤 응답 지연") {
            const { stub } = await renderStubConnectedApp();
            await waitUntil(() =>
              expect(balanceRaw("in"), sample).toBe(stubBalance(NATIVE_ETH_ADDRESS)),
            );
            const gate = rpc.hold(match.account(SECOND_ACCOUNT, match.kind("eth_getBalance")));
            release = gate.release;
            act(() => stub.changeAccounts([SECOND_ACCOUNT]));
            await waitUntil(() => expect(gate.heldCount, sample).toBeGreaterThan(0));
          } else {
            const { result } = await renderMockConnectedApp();
            await waitUntil(() =>
              expect(balanceRaw("in"), sample).toBe(stubBalance(NATIVE_ETH_ADDRESS)),
            );
            const gate = rpc.hold(match.chain(base.id, match.kind("eth_getBalance")));
            release = gate.release;
            act(() => result.current.selected.setSelectedChainId(base.id));
            await waitUntil(() => expect(tokenAddress("in"), sample).toBe(BASE_ETH.address));
            await waitUntil(() => expect(gate.heldCount, sample).toBeGreaterThan(0));
          }

          // 지연을 풀기 전에 판정한다.
          await settlePendingWork();
          const balance = balanceElement("in");
          expect(balance, sample).not.toBeNull();
          expect(isHidden(balance!), sample).toBe(false);
          expect(balance!.hasAttribute("data-balance-raw"), sample).toBe(false);
          expect(balance!.textContent, sample).toBe("—");
          expect(maxButton(), sample).not.toBeNull();
          expect(maxButton()!.disabled, sample).toBe(true);

          release();
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-12
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH의 카드 잔액 첫 읽기가 실패했다. 실패 뒤 스텁이 성공 응답을 돌려주도록 바꿨다
     * @when 가짜 타이머로 실패한 첫 읽기의 주기 시작 시점부터 15초를 진행한다
     * @then 화면에 alert role 요소가 없다
     * @then 15초가 되기 직전까지는 `eth_getBalance` 요청 수가 늘지 않는다
     * @then 15초가 지나면 `eth_getBalance` 요청이 1회 늘고 보내는 칸 balance의 data-balance-raw가 스텁 값이다
     */
    it(
      "[EC-12] 카드 잔액 읽기가 실패하면 오류 표시 없이 다음 15초 주기에 다시 읽는다",
      async () => {
        fakePeriodicTimers();
        rpc.failWhen(match.kind("eth_getBalance"));
        await renderMockConnectedApp();
        expect(tokenAddress("in")).toBe(ETH.address);
        expect(tokenAddress("out")).toBe("");
        await waitUntil(() => expect(settledRequests(CARD_ETH).length).toBe(1));
        await settlePendingWork();
        const failed = rpc.requests(CARD_ETH)[0]!;
        expect(failed.status).toBe("failed");
        expect(screen.queryAllByRole("alert")).toEqual([]);

        rpc.failWhen(null);
        const before = count(CARD_ETH);

        await advanceFakeTimeTo(failed.at + CARD_REFETCH_MS - 1);
        await settlePendingWork();
        expect(screen.queryAllByRole("alert")).toEqual([]);
        expect(count(CARD_ETH)).toBe(before);

        await advanceFakeTimeTo(failed.at + CARD_REFETCH_MS);
        await waitUntil(() => expect(count(CARD_ETH)).toBe(before + 1));
        await waitUntil(() => expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS)));
        await settlePendingWork();
        expect(count(CARD_ETH)).toBe(before + 1);
        expect(screen.queryAllByRole("alert")).toEqual([]);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-30
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH(잔액 1 ETH 읽기 성공), 받는 USDC가 선택되고 금액 `1.5`가 입력돼 주 버튼이 `insufficient-balance`다. 표본: 15초 뒤 다시 읽기 응답이 지연 중, 15초 뒤 다시 읽기가 실패한 상태를 하나씩 반복한다
     * @when 가짜 타이머로 15초를 진행해 다시 읽기를 일으킨다
     * @then 보내는 칸 balance의 data-balance-raw가 1 ETH의 정수 문자열 그대로다
     * @then primary-button의 data-state가 `insufficient-balance` 그대로다
     */
    it(
      "[EC-30] 다시 읽는 중이거나 실패해도 마지막 성공 값을 표시와 판정에 쓴다",
      async () => {
        for (const sample of ["다시 읽기 응답 지연", "다시 읽기 실패"] as const) {
          fakePeriodicTimers();
          rpc.setBalances((query) =>
            sameAddress(query.token, NATIVE_ETH_ADDRESS) ? ONE_ETH : defaultBalance(query),
          );
          await renderMockConnectedApp();
          await chooseToken("out", USDC);
          await typeAmount("1.5");
          await waitUntil(() => {
            expect(balanceRaw("in"), sample).toBe(ONE_ETH.toString());
            expect(primaryState(), sample).toBe("insufficient-balance");
          });
          await settlePendingWork();
          const start = rpc.requests(CARD_ETH)[0]!.at;
          const before = count(CARD_ETH);

          let release = () => {};
          if (sample === "다시 읽기 응답 지연") {
            release = rpc.hold(CARD_ETH).release;
          } else {
            rpc.failWhen(CARD_ETH);
          }

          await advanceFakeTimeTo(start + CARD_REFETCH_MS);
          await waitUntil(() => expect(count(CARD_ETH), sample).toBe(before + 1));
          if (sample === "다시 읽기 실패") {
            await waitUntil(() =>
              expect(rpc.requests(CARD_ETH).at(-1)?.status, sample).toBe("failed"),
            );
          } else {
            expect(rpc.requests(CARD_ETH).at(-1)?.status, sample).toBe("pending");
          }
          await settlePendingWork();

          expect(balanceRaw("in"), sample).toBe(ONE_ETH.toString());
          expect(primaryState(), sample).toBe("insufficient-balance");

          release();
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("지갑이 연결되지 않았거나 연결이 바뀌는 경우", () => {
    /**
     * @spec EC-4
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 ETH, 받는 USDC가 선택돼 있다. 표본: 미연결, 복원 중을 하나씩 반복한다
     * @when 카드를 확인한다
     * @then 두 칸 모두 잔액(balance)이 표시되지 않는다
     * @then max-button이 표시되지 않는다
     */
    it(
      "[EC-4] 미연결·복원 중에는 카드 잔액과 최대를 표시하지 않는다",
      async () => {
        for (const sample of ["disconnected", "restoring"] as const) {
          await renderWalletSample(sample);
          await chooseToken("out", USDC);
          expect(tokenAddress("in"), sample).toBe(ETH.address);
          await settlePendingWork();
          expect(primaryState(), sample).toBe(sample);

          expectNotShown(balanceElement("in"), `${sample} 보내는 칸`);
          expectNotShown(balanceElement("out"), `${sample} 받는 칸`);
          const max = maxButton();
          if (max) expect(isHidden(max), `${sample} 최대`).toBe(true);

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-6 DoD-19
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `0.5`이며 두 칸 잔액이 첫 계정 기준으로 표시됐다. 스텁은 두 번째 계정에 다른 잔액을 돌려준다
     * @when 지갑이 두 번째 계정으로 바뀌었다고 알린다(accountsChanged)
     * @then 두 칸 token-button의 data-token-address와 보내는 칸 amount-input 값이 바뀌지 않는다
     * @then 두 번째 계정 기준으로 두 칸의 카드 잔액 읽기 요청이 발생한다
     * @then 두 칸 balance의 data-balance-raw가 두 번째 계정의 스텁 값이다
     */
    it(
      "[EC-6][DoD-19] 연결 계정이 바뀌면 토큰과 금액을 유지하고 새 계정의 잔액을 다시 읽어 표시한다",
      async () => {
        const { stub } = await renderStubConnectedApp();
        await chooseToken("out", USDC);
        await typeAmount("0.5");
        await waitUntil(() => {
          expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS));
          expect(balanceRaw("out")).toBe(stubBalance(USDC.address));
        });
        expect(stubBalance(NATIVE_ETH_ADDRESS, SECOND_ACCOUNT)).not.toBe(
          stubBalance(NATIVE_ETH_ADDRESS),
        );
        const seq = nextSeq();

        act(() => stub.changeAccounts([SECOND_ACCOUNT]));

        await waitUntil(() => {
          expect(count(match.since(seq, match.account(SECOND_ACCOUNT, CARD_ETH)))).toBeGreaterThan(
            0,
          );
          expect(count(match.since(seq, match.account(SECOND_ACCOUNT, CARD_USDC)))).toBeGreaterThan(
            0,
          );
        });
        await waitUntil(() => {
          expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS, SECOND_ACCOUNT));
          expect(balanceRaw("out")).toBe(stubBalance(USDC.address, SECOND_ACCOUNT));
        });
        expect(tokenAddress("in")).toBe(ETH.address);
        expect(tokenAddress("out")).toBe(USDC.address);
        expect(amountInput().value).toBe("0.5");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-7
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC, 금액 `0.5`이며 두 칸 잔액이 표시됐다
     * @when 연결을 해제한다
     * @then 두 칸 token-button의 data-token-address와 보내는 칸 amount-input 값이 바뀌지 않는다
     * @then 두 칸 모두 잔액(balance)이 표시되지 않는다
     */
    it(
      "[EC-7] 연결을 해제하면 토큰과 금액을 유지하고 잔액을 숨긴다",
      async () => {
        const { config } = await renderMockConnectedApp();
        await chooseToken("out", USDC);
        await typeAmount("0.5");
        await waitUntil(() => {
          expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS));
          expect(balanceRaw("out")).toBe(stubBalance(USDC.address));
        });

        await act(async () => {
          await disconnect(config);
        });

        await waitUntil(() => expect(primaryState()).toBe("disconnected"));
        expect(tokenAddress("in")).toBe(ETH.address);
        expect(tokenAddress("out")).toBe(USDC.address);
        expect(amountInput().value).toBe("0.5");
        expectNotShown(balanceElement("in"), "보내는 칸");
        expectNotShown(balanceElement("out"), "받는 칸");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-8
     * @given 선택 체인은 Ethereum이고 스텁 EIP-1193 지갑의 체인은 Base다. 보내는 ETH, 받는 USDC가 선택돼 있고 RPC 스텁은 체인마다 다른 잔액을 돌려준다
     * @when 연결 뒤 카드 잔액 읽기가 끝날 때까지 기다린다
     * @then 카드 잔액 읽기 요청이 Ethereum RPC로만 가고 Base RPC로는 가지 않는다
     * @then 두 칸 balance의 data-balance-raw가 Ethereum 스텁 값이다
     */
    it(
      "[EC-8] 지갑 체인이 달라도 카드 잔액은 선택 체인 기준으로 읽는다",
      async () => {
        await renderStubConnectedApp(base.id);
        await chooseToken("out", USDC);
        expect(stubBalance(NATIVE_ETH_ADDRESS, TEST_ACCOUNT, base.id)).not.toBe(
          stubBalance(NATIVE_ETH_ADDRESS),
        );

        await waitUntil(() => {
          expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS));
          expect(balanceRaw("out")).toBe(stubBalance(USDC.address));
        });
        await settlePendingWork();

        expect(count(CARD_ETH)).toBeGreaterThan(0);
        expect(count(CARD_USDC)).toBeGreaterThan(0);
        expect(
          count(
            match.chain(base.id, match.kind("eth_getBalance", "balanceOf", "aggregate3", "other")),
          ),
        ).toBe(0);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-8
     * @given 선택 체인은 Ethereum이고 스텁 EIP-1193 지갑의 체인은 Base다. RPC 스텁은 체인마다 다른 잔액을 돌려준다
     * @when 보내는 칸 모달을 열고 잔액 일괄 읽기가 끝날 때까지 기다린다
     * @then 모달 잔액 읽기 요청이 Ethereum RPC로만 가고 Base RPC로는 가지 않는다
     * @then 행의 data-balance-raw가 Ethereum 스텁 값이다
     */
    it(
      "[EC-8] 지갑 체인이 달라도 모달 잔액은 선택 체인 기준으로 읽는다",
      async () => {
        await renderStubConnectedApp(base.id);
        const seq = nextSeq();

        await openModal("in");

        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
        await settlePendingWork();
        expect(count(match.since(seq, match.chain(mainnet.id, LIST_READ)))).toBeGreaterThan(0);
        expect(
          count(
            match.chain(base.id, match.kind("eth_getBalance", "balanceOf", "aggregate3", "other")),
          ),
        ).toBe(0);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("모달을 열어 목록 잔액을 읽는 경우", () => {
    /**
     * @spec DoD-14 DoD-22 DoD-23
     * @given mock 커넥터로 Ethereum에 연결돼 있고 카드 잔액 읽기가 끝났다. RPC 스텁은 모든 요청에 성공 응답을 돌려주고 메서드별 요청 수를 센다
     * @when 보내는 칸 모달을 한 번 열고 잔액 일괄 읽기가 끝날 때까지 기다린다
     * @then 모든 token-option의 data-balance-raw가 스텁이 그 토큰에 돌려준 정수 잔액의 10진 문자열이다
     * @then 모달을 열기 전후의 `eth_call` 요청 수 차이가 2 이하다
     * @then 모달을 열기 전후의 `eth_getBalance` 요청 수 차이가 1이다
     */
    it(
      "[DoD-14][DoD-22][DoD-23] 모달 행마다 잔액을 표시하고 일괄 읽기 요청 수가 상한 안이다",
      async () => {
        await renderMockConnectedApp();
        await waitUntil(() => expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS)));
        await settlePendingWork();
        const ethCalls = match.kind("balanceOf", "aggregate3");
        const getBalances = match.kind("eth_getBalance");
        const ethCallBefore = count(ethCalls);
        const getBalanceBefore = count(getBalances);

        await openModal("in");

        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
        await settlePendingWork();
        expectRows(mainnet.id, (address) => stubBalance(address));
        expect(count(ethCalls) - ethCallBefore).toBeLessThanOrEqual(2);
        expect(count(getBalances) - getBalanceBefore).toBe(1);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-20
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 칸 모달을 한 번 열어 잔액 일괄 읽기가 성공한 뒤 닫았다. 그 뒤 스텁의 잔액 응답을 다른 값으로 바꿨다
     * @when 보내는 칸 모달을 다시 연다
     * @then 다시 열 때 모달 잔액 일괄 읽기 요청(`eth_getBalance`, aggregate3 `eth_call`)이 새로 발생한다
     * @then 읽기가 끝나면 행의 data-balance-raw가 바뀐 스텁 값이다
     */
    it(
      "[DoD-20] 모달을 열 때마다 목록 전체 잔액을 다시 읽는다",
      async () => {
        await renderMockConnectedApp();
        await openModal("in");
        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
        await closeModalKeepingTokens();
        rpc.setBalances(CHANGED);
        const seq = nextSeq();

        await openModal("in");

        await waitUntil(() => {
          expect(count(match.since(seq, match.kind("eth_getBalance")))).toBeGreaterThan(0);
          expect(count(match.since(seq, match.kind("aggregate3")))).toBeGreaterThan(0);
        });
        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-21
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 칸 모달을 한 번 열어 잔액 일괄 읽기가 성공한 뒤 닫았다. 두 번째 일괄 읽기 응답은 지연되며 다른 값을 돌려준다
     * @when 같은 계정·체인에서 모달을 다시 연다
     * @then 두 번째 응답이 오기 전에 행의 data-balance-raw가 첫 번째 읽기 값이다
     * @then 두 번째 응답이 오면 행의 data-balance-raw가 두 번째 읽기 값이다
     */
    it(
      "[DoD-21] 같은 계정·체인에서 이전 모달 잔액이 있으면 새 읽기가 끝나기 전에 그 값을 표시한다",
      async () => {
        await renderMockConnectedApp();
        await openModal("in");
        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
        const firstValues = new Map(
          optionRows().map((row) => [rowAddress(row), row.getAttribute("data-balance-raw")]),
        );
        await closeModalKeepingTokens();
        rpc.setBalances(CHANGED);
        const gate = rpc.hold(LIST_READ);
        const seq = nextSeq();

        await openModal("in");

        await waitUntil(() => {
          expect(count(match.since(seq, match.kind("eth_getBalance")))).toBeGreaterThan(0);
          expect(count(match.since(seq, match.kind("aggregate3")))).toBeGreaterThan(0);
        });
        await settlePendingWork();
        expect(
          rpc
            .requests(match.since(seq, LIST_READ))
            .every((request) => request.status === "pending"),
        ).toBe(true);
        expectRows(mainnet.id, (address) => firstValues.get(address) ?? null, "응답 전");

        gate.release();

        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address), "응답 후"));
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-21
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 보내는 칸 모달을 한 번 열어 잔액 일괄 읽기가 성공한 뒤 닫았다. 이후 일괄 읽기 응답은 지연된다. 표본: 지갑이 다른 계정으로 바뀜, 선택 체인을 Base로 바꿈을 하나씩 반복한다
     * @when 표본 변경 뒤 보내는 칸 모달을 연다
     * @then 응답이 오기 전에 어떤 token-option에도 data-balance-raw가 없다(이전 계정·체인의 값을 쓰지 않는다)
     */
    it(
      "[DoD-21] 계정이나 체인이 다르면 이전 모달 잔액을 표시하지 않는다",
      async () => {
        for (const sample of ["다른 계정", "선택 체인 Base"] as const) {
          const { result, stub } = await renderStubConnectedApp();
          await openModal("in");
          await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
          await closeModalKeepingTokens();
          const gate = rpc.hold(LIST_READ);

          let chainId: SupportedChainId = mainnet.id;
          let account: Address = TEST_ACCOUNT;
          if (sample === "다른 계정") {
            account = SECOND_ACCOUNT;
            act(() => stub.changeAccounts([SECOND_ACCOUNT]));
            await waitUntil(() =>
              expect(count(match.account(SECOND_ACCOUNT)), sample).toBeGreaterThan(0),
            );
          } else {
            chainId = base.id;
            act(() => result.current.selected.setSelectedChainId(base.id));
            await waitUntil(() => expect(tokenAddress("in"), sample).toBe(BASE_ETH.address));
          }
          const seq = nextSeq();

          await openModal("in");

          await waitUntil(() =>
            expect(
              count(
                match.since(
                  seq,
                  match.chain(chainId, match.account(account, match.kind("aggregate3"))),
                ),
              ),
              sample,
            ).toBeGreaterThan(0),
          );
          await settlePendingWork();
          expect(
            rpc
              .requests(match.since(seq, LIST_READ))
              .every((request) => request.status === "pending"),
            sample,
          ).toBe(true);
          expectRows(chainId, () => null, `${sample} 응답 전`);

          gate.release();
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-15
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 일괄 읽기 응답은 지연되며, 고정 토큰이 아니고 심볼순으로 뒤쪽인 토큰 하나에만 0보다 큰 잔액을 돌려준다
     * @when 보내는 칸 모달을 열고 응답이 오기 전후의 행 순서를 확인한다
     * @then 응답 전에는 그 토큰 행이 고정 토큰 5개 뒤 나머지 토큰의 심볼순 자리에 있다
     * @then 응답 후에는 그 토큰 행이 고정 토큰 5개 바로 다음(6번째)에 있다
     */
    it(
      "[EC-15] 모달이 열린 뒤 잔액이 도착하면 다시 정렬한다",
      async () => {
        const ordered = expectedOrder(() => false);
        const target = ordered.at(-1)!;
        const targetToken = ETHEREUM_TOKENS.find((token) => token.address === target)!;
        expect(isPinned(targetToken)).toBe(false);
        rpc.setBalances((query) => (sameAddress(query.token, target) ? 5n * ONE_ETH : 0n));

        await renderMockConnectedApp();
        await waitUntil(() => expect(balanceRaw("in")).toBe("0"));
        const gate = rpc.hold(LIST_READ);

        await openModal("in");
        await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0));
        await settlePendingWork();

        const indexOfTarget = () => optionRows().findIndex((row) => rowAddress(row) === target);
        expect(indexOfTarget()).toBe(ordered.indexOf(target));
        expect(indexOfTarget()).toBeGreaterThan(5);

        gate.release();

        await waitUntil(() => expect(indexOfTarget()).toBe(5));
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("모달 잔액 읽기가 실패하는 경우", () => {
    /**
     * @spec EC-13
     * @given mock 커넥터로 Ethereum에 연결돼 있고 이 계정·체인으로 모달 잔액을 읽은 적이 없다. RPC 스텁은 모달 잔액 일괄 읽기 요청(`eth_getBalance`, aggregate3 `eth_call`)에 실패 응답을 돌려주고, 토큰별 개별 `balanceOf` `eth_call`에는 성공 응답을 돌려준다(계약별 fallback이 있으면 행 잔액으로 드러난다)
     * @when 받는 칸 모달을 열고 읽기가 실패한 뒤 USDC를 고른다
     * @then 고르기 전 어떤 token-option에도 data-balance-raw가 없다
     * @then 고르기 전 첫 5개 행이 ETH, WETH, USDC, USDT, DAI 순서이고 6번째 이후 행은 대소문자를 무시한 심볼순, 심볼이 같으면 소문자 주소 문자열순이다
     * @then 고른 뒤 받는 칸 token-button의 data-token-address가 USDC이고 모달이 닫힌다
     */
    it(
      "[EC-13] 이전 모달 잔액 없이 일괄 읽기가 실패하면 잔액 없는 목록을 표시하고 선택은 동작한다",
      async () => {
        await renderMockConnectedApp();
        await waitUntil(() => expect(balanceRaw("in")).toBe(stubBalance(NATIVE_ETH_ADDRESS)));
        await settlePendingWork();
        // 카드 읽기가 끝난 뒤, 모달 직전에 일괄 읽기 요청만 실패로 바꾼다. 개별 `balanceOf`는 성공 응답한다.
        rpc.failWhen(LIST_READ);
        const seq = nextSeq();

        await openModal("out");

        await waitUntil(() => {
          expect(
            settledRequests(match.since(seq, match.kind("eth_getBalance"))).length,
          ).toBeGreaterThan(0);
          expect(
            settledRequests(match.since(seq, match.kind("aggregate3"))).length,
          ).toBeGreaterThan(0);
          expect(
            rpc
              .requests(match.since(seq, LIST_READ))
              .some((request) => request.status === "pending"),
          ).toBe(false);
        });
        await settlePendingWork();

        expectRows(mainnet.id, () => null, "실패 후");
        expect(optionRows().map(rowAddress)).toEqual(expectedOrder(() => false));

        await clickRowAndWaitClosed(USDC.address);
        expect(tokenAddress("out")).toBe(USDC.address);
        expect(tokenModal()).toBeNull();
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-14
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 일괄 읽기는 성공하지만 aggregate3 결과에서 고정 토큰이 아닌 토큰 하나의 `balanceOf`만 실패이고, 나머지 토큰 중 일부는 0보다 큰 잔액이다
     * @when 보내는 칸 모달을 열고 읽기가 끝날 때까지 기다린다
     * @then 실패한 토큰 행에만 data-balance-raw가 없다
     * @then 실패한 토큰 행은 잔액이 0보다 큰 토큰 그룹이 아니라 나머지 토큰 그룹 안의 심볼순 자리에 있다
     * @then 다른 행은 스텁이 돌려준 잔액을 data-balance-raw로 가진다
     */
    it(
      "[EC-14] 개별 토큰 잔액 읽기가 실패하면 그 행만 잔액 없이 나머지 그룹에 놓인다",
      async () => {
        // 고정 토큰이 아닌 토큰 중 주소 끝자리가 0~7이면 잔액 0, 그 밖은 0보다 큰 기본값이다.
        const isZero = (token: string) => /[0-7]$/.test(token.toLowerCase());
        const balances: BalanceFn = (query) =>
          !ETHEREUM_PINNED.some((pinned) => sameAddress(pinned.address, query.token)) &&
          isZero(query.token)
            ? 0n
            : defaultBalance(query);
        const failed = ETHEREUM_TOKENS.filter(
          (token) => !isPinned(token) && !isZero(token.address),
        ).sort(compareByDoD10)[0]!;
        rpc.setBalances(balances);
        rpc.failTokenWhen((query) => sameAddress(query.token, failed.address));

        const hasPositive = (token: Token) =>
          !sameAddress(token.address, failed.address) && !isZero(token.address);
        const order = expectedOrder(hasPositive);
        const withBalanceEnd =
          5 + ETHEREUM_TOKENS.filter((token) => !isPinned(token) && hasPositive(token)).length;
        expect(order.indexOf(failed.address)).toBeGreaterThanOrEqual(withBalanceEnd);

        await renderMockConnectedApp();
        await openModal("in");

        await waitUntil(() =>
          expectRows(mainnet.id, (address) =>
            sameAddress(address, failed.address) ? null : stubBalance(address),
          ),
        );
        await settlePendingWork();
        const rows = optionRows();
        expect(rows.filter((row) => !row.hasAttribute("data-balance-raw")).map(rowAddress)).toEqual(
          [failed.address],
        );
        const failedIndex = rows.findIndex((row) => rowAddress(row) === failed.address);
        expect(failedIndex).toBeGreaterThanOrEqual(withBalanceEnd);
        expect(failedIndex).toBe(order.indexOf(failed.address));
        expectRows(mainnet.id, (address) =>
          sameAddress(address, failed.address) ? null : stubBalance(address),
        );
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-31
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 칸 모달을 한 번 열어 잔액 일괄 읽기가 성공한 뒤 닫았다. 이후 일괄 읽기 요청은 실패한다
     * @when 같은 계정·체인에서 모달을 다시 열고 읽기가 실패할 때까지 기다린다
     * @then 행의 data-balance-raw가 첫 번째 읽기 값 그대로다
     */
    it(
      "[EC-31] 이전 모달 잔액이 있으면 새 일괄 읽기가 실패해도 이전 값을 유지한다",
      async () => {
        await renderMockConnectedApp();
        await openModal("in");
        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
        const firstValues = new Map(
          optionRows().map((row) => [rowAddress(row), row.getAttribute("data-balance-raw")]),
        );
        await closeModalKeepingTokens();
        rpc.setBalances(CHANGED);
        rpc.failWhen(LIST_READ);
        const seq = nextSeq();

        await openModal("in");

        await waitUntil(() => {
          expect(
            settledRequests(match.since(seq, match.kind("eth_getBalance"))).length,
          ).toBeGreaterThan(0);
          expect(
            settledRequests(match.since(seq, match.kind("aggregate3"))).length,
          ).toBeGreaterThan(0);
          expect(
            rpc
              .requests(match.since(seq, LIST_READ))
              .some((request) => request.status === "pending"),
          ).toBe(false);
        });
        expect(
          rpc.requests(match.since(seq, LIST_READ)).some((request) => request.status === "failed"),
        ).toBe(true);
        await settlePendingWork();
        expectRows(mainnet.id, (address) => firstValues.get(address) ?? null, "실패 후");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-32
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있다. 준비 단계에서 보내는 칸 모달로 USDC를 골라 보내는 칸 토큰은 USDC, 받는 칸은 미선택이다(카드 잔액 읽기가 `eth_getBalance`를 쓰지 않는다). 준비 단계의 모달 읽기가 끝난 뒤 RPC 스텁이 모달 잔액 일괄 읽기 요청(`eth_getBalance`, aggregate3 `eth_call`)을 실패 응답으로 바꾸고, 목록 토큰 잔액을 읽는 모든 요청(`eth_getBalance`, aggregate3 `eth_call`, 토큰별 `balanceOf` `eth_call`)을 센다. 카드 토큰(USDC) 읽기 요청은 세지 않는다
     * @when 보내는 칸 모달을 열어 읽기가 실패한 뒤, 모달을 연 채로 가짜 타이머로 15초 넘게 진행하고 window `focus` 이벤트를 발생시킨다
     * @then 검증 단계(when)에서 다시 연 모달의 일괄 읽기가 실패한 뒤 계약별 개별 `balanceOf` fallback 요청이 0회다
     * @then 목록 토큰 잔액을 읽는 모든 요청(`eth_getBalance`, aggregate3 `eth_call`, 토큰별 `balanceOf` `eth_call`) 수가 검증 단계(when)에서 다시 연 모달의 일괄 읽기가 실패한 뒤로 늘지 않는다
     * @then token-modal이 열려 있다
     */
    it(
      "[EC-32] 모달 잔액 읽기가 실패하면 모달이 열린 동안 다시 시도하지 않는다",
      async () => {
        fakePeriodicTimers();
        await renderMockConnectedApp();
        // 준비 단계: 보내는 칸 모달에서 USDC를 고른다. 준비 단계의 모달 읽기가 끝난 뒤에 고른다.
        await openModal("in");
        await waitUntil(() => expectRows(mainnet.id, (address) => stubBalance(address)));
        await clickRowAndWaitClosed(USDC.address);
        expect(tokenAddress("in")).toBe(USDC.address);
        expect(tokenAddress("out")).toBe("");
        await waitUntil(() => expect(balanceRaw("in")).toBe(stubBalance(USDC.address)));
        await settlePendingWork();
        rpc.failWhen(LIST_READ);
        const seq = nextSeq();

        // 목록 토큰 잔액을 읽는 모든 요청. 카드 토큰(USDC) 읽기는 세지 않는다.
        const notCardToken: RequestMatcher = (request) =>
          request.kind !== "balanceOf" || !sameAddress(request.tokens[0], USDC.address);
        const listTokenReads: RequestMatcher = (request) =>
          request.seq >= seq &&
          ["eth_getBalance", "aggregate3", "balanceOf"].includes(request.kind) &&
          notCardToken(request);
        const fallbackReads: RequestMatcher = (request) =>
          request.seq >= seq && request.kind === "balanceOf" && notCardToken(request);

        await openModal("in");
        await waitUntil(() => {
          expect(
            settledRequests(match.since(seq, match.kind("eth_getBalance"))).length,
          ).toBeGreaterThan(0);
          expect(
            settledRequests(match.since(seq, match.kind("aggregate3"))).length,
          ).toBeGreaterThan(0);
          expect(
            rpc
              .requests(match.since(seq, LIST_READ))
              .some((request) => request.status === "pending"),
          ).toBe(false);
        });
        expect(
          rpc.requests(match.since(seq, LIST_READ)).some((request) => request.status === "failed"),
        ).toBe(true);
        await settlePendingWork();
        const afterFailure = count(listTokenReads);

        await advanceFakeTimeTo(Date.now() + CARD_REFETCH_MS + 1);
        await settlePendingWork();
        focusWindow();
        await settlePendingWork();

        expect(count(fallbackReads)).toBe(0);
        expect(count(listTokenReads)).toBe(afterFailure);
        expect(tokenModal()).not.toBeNull();
      },
      CASE_TIMEOUT_MS,
    );
  });
});
