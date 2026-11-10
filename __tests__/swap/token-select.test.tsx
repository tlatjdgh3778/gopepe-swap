import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedChainId } from "@/config/chains";
import { PINNED_TOKENS_BY_CHAIN, TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";

import { installBalanceRpcStub, sameAddress } from "../support/rpc-balance-stub";
import { createStubEip1193 } from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeTimeTo,
  clearCookies,
  createDeferred,
  createNoopWagmiStorage,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 화면 식별자(스펙 §4.2)로 판정한다.
// 지갑 자리는 없음(미연결) 또는 계정 응답을 붙잡아 둔 스텁 EIP-1193(복원 중)이다. RPC는 전역 fetch 스텁이 받는다.

const CASE_TIMEOUT_MS = 30_000;

beforeEach(() => {
  installBalanceRpcStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
});

type Side = "in" | "out";
type WalletSample = "disconnected" | "restoring";

const WALLET_SAMPLES: readonly WalletSample[] = ["disconnected", "restoring"];

const ETHEREUM_PINNED = PINNED_TOKENS_BY_CHAIN[mainnet.id];
const ETH = ETHEREUM_PINNED[0];
const WETH = ETHEREUM_PINNED[1];
const USDC = ETHEREUM_PINNED[2];
const DAI = ETHEREUM_PINNED[4];

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

function amountInput(side: Side): HTMLInputElement {
  return within(field(side)).getByTestId("amount-input") as HTMLInputElement;
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

function rowAddress(row: HTMLElement): string {
  return row.getAttribute("data-token-address") ?? "";
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

async function chooseToken(side: Side, token: Token) {
  await openModal(side);
  fireEvent.click(optionRow(token.address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
  expect(tokenAddress(side)).toBe(token.address);
}

function typeAmount(value: string) {
  fireEvent.change(amountInput("in"), { target: { value } });
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

// 잔액이 없는 목록 순서: 고정 토큰 5개, 나머지 토큰(DoD-10 순서).
function orderWithoutBalances(chainId: SupportedChainId): Address[] {
  const pinned = PINNED_TOKENS_BY_CHAIN[chainId];
  const rest = TOKENS_BY_CHAIN[chainId]
    .filter((token) => !pinned.some((candidate) => sameAddress(candidate.address, token.address)))
    .sort(compareByDoD10);
  return [...pinned, ...rest].map((token) => token.address);
}

function sortedAddresses(addresses: readonly string[]): string[] {
  return addresses.map((address) => address.toLowerCase()).sort();
}

function useProbe() {
  return { form: useSwapForm(), selected: useSelectedChain() };
}

// 저장된 연결이 없는 앱. 커넥터가 없어 복원 시도가 곧 끝나고 미연결이 된다.
async function renderDisconnectedApp(initialChainId: SupportedChainId = mainnet.id) {
  const config = createWagmiConfig({
    connectors: [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"));
  return view;
}

// 복원 중인 앱. 지갑이 계정 응답을 끝내지 않아 복원이 끝나지 않는다.
// 복원 제한 시간(5초)이 실제 시간으로 지나지 않도록 가짜 타이머를 켜고 시계는 움직이지 않는다.
async function renderRestoringApp(initialChainId: SupportedChainId = mainnet.id) {
  vi.useFakeTimers();
  const stub = createStubEip1193({
    chainId: initialChainId,
    accounts: [TEST_ACCOUNT],
    authorized: true,
  });
  const accounts = createDeferred<readonly Address[]>();
  stub.setHandler("eth_accounts", () => accounts.promise);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId });
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
  clearCookies();
}

// --- 검색 반영 대기(DoD-41·DoD-42·EC-33) 판정 ---
const ETHEREUM_ADDRESSES = sortedAddresses(
  TOKENS_BY_CHAIN[mainnet.id].map((token) => token.address),
);

function listSkeleton(): HTMLElement | null {
  return screen.queryByTestId("token-list-skeleton");
}

function searchInput(): HTMLElement {
  return screen.getByTestId("token-search");
}

function typeSearch(value: string) {
  fireEvent.change(searchInput(), { target: { value } });
}

// 목록이 Ethereum 토큰 목록 전체(주소 집합)다.
function expectFullList(label: string) {
  expect(sortedAddresses(optionRows().map(rowAddress)), label).toEqual(ETHEREUM_ADDRESSES);
}

// 검색 결과가 아직 반영되지 않았다: 입력 전 전체 목록과 같거나 행이 하나도 없다.
function expectSearchNotApplied(label: string) {
  const listed = sortedAddresses(optionRows().map(rowAddress));
  const unchanged =
    listed.length === 0 || JSON.stringify(listed) === JSON.stringify(ETHEREUM_ADDRESSES);
  expect(unchanged, `${label} (행 ${listed.length}개)`).toBe(true);
}

// 행이 모두 검색어(`needle`)를 심볼 또는 이름에 포함하는 토큰이다.
function expectOnlyMatching(needle: string, label: string) {
  const tokensByAddress = new Map(
    TOKENS_BY_CHAIN[mainnet.id].map((token) => [token.address.toLowerCase(), token]),
  );
  for (const row of optionRows()) {
    const token = tokensByAddress.get(rowAddress(row).toLowerCase());
    expect(token, `${label} ${rowAddress(row)}`).toBeDefined();
    const matches =
      token!.symbol.toLowerCase().includes(needle) || token!.name.toLowerCase().includes(needle);
    expect(matches, `${label} ${token!.symbol}`).toBe(true);
  }
}

// 미연결 앱에서 보내는 칸 모달을 검색어 없이 연다(잔액 쿼리 없음). 렌더링과 모달 열기는 실제 타이머로 끝낸다.
// 전제: 화면 목록이 Ethereum 토큰 목록 전체와 같고 스켈레톤이 없다.
async function openSearchModalWithoutQuery() {
  await renderDisconnectedApp();
  await openModal("in");
  expectFullList("입력 전");
  expect(listSkeleton(), "입력 전").toBeNull();
}

describe("토큰 선택 — 사용자가 선택 체인의 토큰을 골라 두 칸을 정한다", () => {
  describe("토큰 모달을 여는 경우", () => {
    /**
     * @spec DoD-3
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸은 ETH, 받는 칸은 미선택이다. 표본: 보내는 칸(`in`), 받는 칸(`out`)의 토큰 버튼을 하나씩 반복한다
     * @when 그 칸의 token-button을 누른다
     * @then token-modal이 열리고 data-side가 누른 칸의 side 값이다
     * @then 보내는 칸에서 열면 ETH 행만 data-selected="true"이고 나머지 행은 "false"다
     * @then 받는 칸(미선택)에서 열면 모든 행이 data-selected="false"다
     */
    it(
      "[DoD-3] 토큰 버튼을 누르면 그 칸의 토큰 모달이 열린다",
      async () => {
        for (const side of ["in", "out"] as const) {
          await renderDisconnectedApp();
          expect(tokenAddress("in")).toBe(ETH.address);
          expect(tokenAddress("out")).toBe("");

          await openModal(side);

          expect(tokenModal()?.getAttribute("data-side"), side).toBe(side);
          const rows = optionRows();
          const selected = rows.filter((row) => row.getAttribute("data-selected") === "true");
          const others = rows.filter((row) => row.getAttribute("data-selected") !== "true");
          if (side === "in") {
            expect(selected.map(rowAddress), side).toEqual([ETH.address]);
          } else {
            expect(selected, side).toEqual([]);
          }
          for (const row of others) {
            expect(row.getAttribute("data-selected"), `${side} ${rowAddress(row)}`).toBe("false");
          }

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-4
     * @given 표본: 선택 체인 Ethereum, Base, Arbitrum을 하나씩 반복한다
     * @when 보내는 칸의 토큰 모달을 연다
     * @then 목록에 token-option이 하나 이상 있다
     * @then 모든 token-option의 data-token-address가 선택 체인 토큰 목록의 주소다
     * @then token-option 주소 집합이 선택 체인 토큰 목록 전체의 주소 집합과 같다
     */
    it(
      "[DoD-4] 모달 목록은 선택 체인의 토큰만 담는다",
      async () => {
        for (const chainId of [mainnet.id, base.id, arbitrum.id] as const) {
          const label = `선택 체인 ${chainId}`;
          await renderDisconnectedApp(chainId);
          await openModal("in");

          const listed = optionRows().map(rowAddress);
          const chainTokens = TOKENS_BY_CHAIN[chainId].map((token) => token.address.toLowerCase());
          expect(listed.length, label).toBeGreaterThan(0);
          for (const address of listed) {
            expect(chainTokens, `${label} ${address}`).toContain(address.toLowerCase());
          }
          expect(sortedAddresses(listed), label).toEqual(sortedAddresses(chainTokens));

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("모달에서 토큰을 고르는 경우", () => {
    /**
     * @spec DoD-5
     * @given 앱이 Ethereum으로 렌더링됐다. 표본: 보내는 칸 모달에서 USDC, 받는 칸 모달에서 DAI를 고르는 경우를 하나씩 반복한다(고르는 토큰은 반대쪽 칸에 선택돼 있지 않다)
     * @when 그 칸의 모달을 열고 표본 토큰의 token-option을 누른다
     * @then 그 칸 token-button의 data-token-address가 고른 토큰 주소다
     * @then 반대쪽 칸 token-button의 data-token-address는 바뀌지 않는다
     * @then token-modal이 닫혀 있다
     */
    it(
      "[DoD-5] 고른 토큰이 그 칸에 반영되고 모달이 닫힌다",
      async () => {
        const samples = [
          { side: "in", opposite: "out", token: USDC },
          { side: "out", opposite: "in", token: DAI },
        ] as const;

        for (const sample of samples) {
          const label = `${sample.side} 칸에서 ${sample.token.symbol}`;
          await renderDisconnectedApp();
          const oppositeBefore = tokenAddress(sample.opposite);
          expect(oppositeBefore, label).not.toBe(sample.token.address);

          await openModal(sample.side);
          fireEvent.click(optionRow(sample.token.address));

          await waitUntil(() =>
            expect(tokenAddress(sample.side), label).toBe(sample.token.address),
          );
          expect(tokenAddress(sample.opposite), label).toBe(oppositeBefore);
          await waitUntil(() => expect(tokenModal(), label).toBeNull());

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-6 DoD-8
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸에 금액 `1`이 입력돼 있다. 표본: (보내는 USDC, 받는 DAI)에서 보내는 칸 모달로 DAI를 고름, (보내는 USDC, 받는 DAI)에서 받는 칸 모달로 USDC를 고름, (보내는 ETH, 받는 미선택)에서 받는 칸 모달로 ETH를 고름을 하나씩 반복한다
     * @when 그 칸의 모달을 열고 반대쪽 칸에 선택된 토큰의 token-option을 누른다
     * @then 보내는 칸 token-button의 data-token-address가 고르기 전 받는 칸 값(미선택이면 빈 문자열)으로 바뀐다
     * @then 받는 칸 token-button의 data-token-address가 고르기 전 보내는 칸 값(미선택이면 빈 문자열)으로 바뀐다
     * @then 보내는 칸 amount-input 값이 빈 값이다
     * @then token-modal이 닫혀 있다
     */
    it(
      "[DoD-6][DoD-8] 반대쪽 칸의 토큰을 고르면 두 칸이 맞바뀌고 금액이 비워진다",
      async () => {
        const samples = [
          { label: "(USDC, DAI)에서 보내는 칸으로 DAI", setup: [USDC, DAI], side: "in", pick: DAI },
          {
            label: "(USDC, DAI)에서 받는 칸으로 USDC",
            setup: [USDC, DAI],
            side: "out",
            pick: USDC,
          },
          {
            label: "(ETH, 미선택)에서 받는 칸으로 ETH",
            setup: [ETH, null],
            side: "out",
            pick: ETH,
          },
        ] as const;

        for (const sample of samples) {
          const { label } = sample;
          await renderDisconnectedApp();
          const [setupIn, setupOut] = sample.setup;
          if (setupIn.address !== ETH.address) await chooseToken("in", setupIn);
          if (setupOut) await chooseToken("out", setupOut);
          typeAmount("1");
          await waitUntil(() => expect(amountInput("in").value, label).toBe("1"));
          const inBefore = tokenAddress("in");
          const outBefore = tokenAddress("out");

          await openModal(sample.side);
          fireEvent.click(optionRow(sample.pick.address));

          await waitUntil(() => expect(tokenModal(), label).toBeNull());
          expect(tokenAddress("in"), label).toBe(outBefore);
          expect(tokenAddress("out"), label).toBe(inBefore);
          expect(amountInput("in").value, label).toBe("");

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("뒤집기 버튼을 누르는 경우", () => {
    /**
     * @spec DoD-7 DoD-8 DoD-39
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸에 금액 `1`이 입력돼 있다. 표본: (보내는 ETH, 받는 미선택), (보내는 USDC, 받는 DAI)를 하나씩 반복한다
     * @when flip-button을 누른다
     * @then 보내는 칸 token-button의 data-token-address가 뒤집기 전 받는 칸 값(미선택이면 빈 문자열)이다
     * @then 받는 칸 token-button의 data-token-address가 뒤집기 전 보내는 칸 값이다
     * @then 보내는 칸 amount-input 값이 빈 값이다
     * @then 첫 표본(보내는 칸이 미선택이 됨)에서 useSwapForm()이 tokenIn null, tokenOut ETH 토큰, amountIn 빈 문자열, amountInRaw null을 돌려준다
     */
    it(
      "[DoD-7][DoD-8][DoD-39] 뒤집기는 미선택을 포함해 두 칸의 토큰을 맞바꾸고 금액을 비운다",
      async () => {
        const samples = [
          { label: "(ETH, 미선택)", setup: [ETH, null] },
          { label: "(USDC, DAI)", setup: [USDC, DAI] },
        ] as const;

        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          const { result } = await renderDisconnectedApp();
          const [setupIn, setupOut] = sample.setup;
          if (setupIn.address !== ETH.address) await chooseToken("in", setupIn);
          if (setupOut) await chooseToken("out", setupOut);
          typeAmount("1");
          await waitUntil(() => expect(amountInput("in").value, label).toBe("1"));
          const inBefore = tokenAddress("in");
          const outBefore = tokenAddress("out");

          fireEvent.click(screen.getByTestId("flip-button"));

          await waitUntil(() => expect(tokenAddress("in"), label).toBe(outBefore));
          expect(tokenAddress("out"), label).toBe(inBefore);
          expect(amountInput("in").value, label).toBe("");

          if (index === 0) {
            const form = result.current.form;
            expect(form.tokenIn, label).toBeNull();
            expect(form.tokenOut, label).toEqual(ETH);
            expect(form.amountIn, label).toBe("");
            expect(form.amountInRaw, label).toBeNull();
          }

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("모달에서 검색하는 경우", () => {
    /**
     * @spec DoD-11
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 모달이 열려 있다. 표본(대표만, 규칙 전체 표본은 단위 테스트가 맡는다): 심볼 일치 `  uSdC  `(앞뒤 공백·대소문자 혼합), 이름 부분 일치 `wrapped eth`를 하나씩 반복한다
     * @when token-search에 표본 검색어를 입력한다
     * @then 남은 모든 token-option의 토큰은 앞뒤 공백을 지운 검색어를 대소문자 무시로 심볼 또는 이름에 포함한다
     * @then 기대 토큰(심볼 표본은 USDC, 이름 표본은 WETH)의 행이 목록에 있다
     * @then 검색어를 심볼과 이름 어디에도 포함하지 않는 토큰(ETH)의 행이 목록에 없다
     */
    it(
      "[DoD-11] 앞뒤 공백을 지운 검색어로 심볼·이름을 대소문자 무시 부분 일치로 거른다",
      async () => {
        expect(WETH.name.toLowerCase()).toContain("wrapped eth");
        const samples = [
          { query: "  uSdC  ", expected: USDC },
          { query: "wrapped eth", expected: WETH },
        ];
        const tokensByAddress = new Map(
          TOKENS_BY_CHAIN[mainnet.id].map((token) => [token.address.toLowerCase(), token]),
        );

        for (const sample of samples) {
          const label = `검색어 ${JSON.stringify(sample.query)}`;
          const needle = sample.query.trim().toLowerCase();
          expect(`${ETH.symbol} ${ETH.name}`.toLowerCase(), label).not.toContain(needle);

          await renderDisconnectedApp();
          await openModal("in");
          fireEvent.change(screen.getByTestId("token-search"), { target: { value: sample.query } });
          // 검색 반영(DoD-41)을 기다린다: 스켈레톤이 사라지고 기대 행이 목록에 있다.
          await waitUntil(() => {
            expect(listSkeleton(), label).toBeNull();
            expect(optionRows().map(rowAddress), label).toContain(sample.expected.address);
          });

          const rows = optionRows();
          for (const row of rows) {
            const token = tokensByAddress.get(rowAddress(row).toLowerCase());
            expect(token, `${label} ${rowAddress(row)}`).toBeDefined();
            const matches =
              token!.symbol.toLowerCase().includes(needle) ||
              token!.name.toLowerCase().includes(needle);
            expect(matches, `${label} ${token!.symbol}`).toBe(true);
          }
          expect(rows.map(rowAddress), label).toContain(sample.expected.address);
          expect(rows.map(rowAddress), label).not.toContain(ETH.address);

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-16
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 모달이 열려 있다
     * @when token-search에 어떤 토큰의 심볼·이름에도 포함되지 않는 검색어를 입력한다
     * @then token-search-empty가 표시된다
     * @then token-option이 하나도 없다
     */
    it(
      "[EC-16] 검색 결과가 없으면 token-search-empty를 표시한다",
      async () => {
        const query = "zqxjzqxj";
        const anyMatch = TOKENS_BY_CHAIN[mainnet.id].some(
          (token) =>
            token.symbol.toLowerCase().includes(query) || token.name.toLowerCase().includes(query),
        );
        expect(anyMatch).toBe(false);

        await renderDisconnectedApp();
        await openModal("in");
        fireEvent.change(screen.getByTestId("token-search"), { target: { value: query } });

        // 검색 반영(DoD-41)을 기다린 뒤 판정한다.
        await waitUntil(() => {
          expect(listSkeleton()).toBeNull();
          expect(screen.queryByTestId("token-search-empty")).not.toBeNull();
        });
        expect(optionRows()).toEqual([]);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-41 DoD-42
     * @given 가짜 타이머를 쓰고 앱이 Ethereum으로 렌더링됐으며 보내는 칸 모달이 검색어 없이 열려 있다(전체 목록 표시, token-list-skeleton 없음)
     * @when token-search에 `usdc`를 입력한 뒤 더 입력하지 않고 가짜 타이머로 250ms를 진행한다
     * @then 입력 직후부터 249ms 시점까지 token-list-skeleton이 표시된다
     * @then 입력 직후부터 249ms 시점까지 token-option 주소 집합이 입력 전 전체 목록의 주소 집합과 같거나 token-option이 하나도 없다
     * @then 250ms 시점에 token-option이 `usdc`를 심볼 또는 이름에 포함하는 토큰만으로 이뤄진다
     * @then 250ms 시점에 USDC 행이 목록에 있다
     * @then 250ms 시점에 token-list-skeleton이 없다
     */
    it(
      "[DoD-41][DoD-42] 검색어 입력이 멈추고 250ms가 지나면 목록에 반영하고, 그 전까지 스켈레톤을 표시한다",
      async () => {
        await openSearchModalWithoutQuery();
        // 검색 반영 대기는 setTimeout이므로 모달을 연 뒤 가짜 타이머를 건다. 미연결이라 잔액 쿼리 알림이 없다.
        vi.useFakeTimers();
        const typedAt = Date.now();

        typeSearch("usdc");

        for (const offset of [0, 249]) {
          const label = `입력 후 ${offset}ms`;
          if (offset > 0) await advanceFakeTimeTo(typedAt + offset);
          await settlePendingWork();
          expect(listSkeleton(), label).not.toBeNull();
          expectSearchNotApplied(label);
        }

        await advanceFakeTimeTo(typedAt + 250);
        await settlePendingWork();
        expect(optionRows().length, "250ms").toBeGreaterThan(0);
        expectOnlyMatching("usdc", "250ms");
        expect(optionRows().map(rowAddress), "250ms").toContain(USDC.address);
        expect(listSkeleton(), "250ms").toBeNull();
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-41 DoD-42
     * @given 가짜 타이머를 쓰고 앱이 Ethereum으로 렌더링됐으며 보내는 칸 모달이 검색어 없이 열려 있다
     * @when token-search에 `us`를 입력하고 가짜 타이머로 200ms 뒤 `usdc`로 이어 입력한 다음 더 입력하지 않는다
     * @then 첫 입력부터 두 번째 입력 뒤 249ms 시점까지(첫 입력부터 250ms가 지난 시점 포함) token-option 주소 집합이 입력 전 전체 목록의 주소 집합과 같거나 token-option이 하나도 없다
     * @then 두 번째 입력부터 249ms 시점까지 token-list-skeleton이 표시된다
     * @then 두 번째 입력부터 250ms 시점에 token-option이 `usdc`를 심볼 또는 이름에 포함하는 토큰만으로 이뤄진다
     * @then 두 번째 입력부터 250ms 시점에 USDC 행이 목록에 있다
     * @then 두 번째 입력부터 250ms 시점에 token-list-skeleton이 없다
     */
    it(
      "[DoD-41][DoD-42] 입력이 이어지면 마지막 입력이 멈춘 뒤 250ms가 지나야 반영한다",
      async () => {
        await openSearchModalWithoutQuery();
        // 검색 반영 대기는 setTimeout이므로 모달을 연 뒤 가짜 타이머를 건다. 미연결이라 잔액 쿼리 알림이 없다.
        vi.useFakeTimers();
        const firstAt = Date.now();

        typeSearch("us");
        await settlePendingWork();
        expectSearchNotApplied("첫 입력 직후");

        await advanceFakeTimeTo(firstAt + 200);
        await settlePendingWork();
        expectSearchNotApplied("첫 입력 후 200ms");

        const secondAt = Date.now();
        expect(secondAt).toBe(firstAt + 200);
        typeSearch("usdc");

        // 두 번째 입력 직후, 첫 입력부터 250ms(두 번째 입력부터 50ms), 두 번째 입력부터 249ms
        for (const time of [secondAt, firstAt + 250, secondAt + 249]) {
          const label = `두 번째 입력 후 ${time - secondAt}ms`;
          if (time > Date.now()) await advanceFakeTimeTo(time);
          await settlePendingWork();
          expectSearchNotApplied(label);
          expect(listSkeleton(), label).not.toBeNull();
        }

        await advanceFakeTimeTo(secondAt + 250);
        await settlePendingWork();
        expect(optionRows().length, "두 번째 입력 후 250ms").toBeGreaterThan(0);
        expectOnlyMatching("usdc", "두 번째 입력 후 250ms");
        expect(optionRows().map(rowAddress), "두 번째 입력 후 250ms").toContain(USDC.address);
        expect(listSkeleton(), "두 번째 입력 후 250ms").toBeNull();
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-33
     * @given 가짜 타이머를 쓰고 앱이 Ethereum으로 렌더링됐으며 보내는 칸 모달이 열려 있다. 표본(전제 2개 × 값 2개): 전제는 검색어 `usdc`가 목록에 반영된 상태, `usdc`를 입력하고 250ms가 지나기 전인 반영 대기 중 상태이고, 값은 빈 값, 공백만(`   `)이다. 네 조합을 하나씩 반복한다
     * @when token-search 값을 표본 값으로 바꾼다
     * @then 바꾼 직후(가짜 타이머를 진행하지 않은 시점) token-option 주소 집합이 Ethereum 토큰 목록 전체의 주소 집합과 같다
     * @then 바꾼 직후 token-list-skeleton이 없다
     * @then 이어서 가짜 타이머를 250ms 이상 진행해도 token-option 주소 집합이 Ethereum 토큰 목록 전체의 주소 집합과 같고 token-list-skeleton이 없다
     */
    it(
      "[EC-33] 검색어를 비우거나 공백만 남기면 대기 없이 전체 목록을 표시하고 스켈레톤을 표시하지 않는다",
      async () => {
        const premises = ["usdc 반영됨", "usdc 반영 대기 중"] as const;
        const values = ["", "   "];

        for (const premise of premises) {
          for (const value of values) {
            const label = `${premise} → ${JSON.stringify(value)}`;
            await openSearchModalWithoutQuery();
            // 검색 반영 대기는 setTimeout이므로 모달을 연 뒤 가짜 타이머를 건다. 미연결이라 잔액 쿼리 알림이 없다.
            vi.useFakeTimers();
            const typedAt = Date.now();
            typeSearch("usdc");

            if (premise === "usdc 반영됨") {
              await advanceFakeTimeTo(typedAt + 250);
              await settlePendingWork();
              expect(listSkeleton(), `${label} 전제`).toBeNull();
              expectOnlyMatching("usdc", `${label} 전제`);
              expect(optionRows().map(rowAddress), `${label} 전제`).toContain(USDC.address);
            } else {
              await advanceFakeTimeTo(typedAt + 100);
              await settlePendingWork();
              expect(listSkeleton(), `${label} 전제`).not.toBeNull();
            }

            typeSearch(value);

            // 가짜 시계를 진행하지 않은 시점
            await settlePendingWork();
            expectFullList(`${label} 직후`);
            expect(listSkeleton(), `${label} 직후`).toBeNull();

            // 이어서 250ms 이상 진행(반영 대기 중 전제에서는 처음 입력의 250ms 시점도 지난다)
            await advanceFakeTimeTo(Date.now() + 250);
            await settlePendingWork();
            expectFullList(`${label} 250ms 뒤`);
            expect(listSkeleton(), `${label} 250ms 뒤`).toBeNull();

            resetSample();
          }
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("선택 체인이 바뀌는 경우", () => {
    /**
     * @spec EC-2
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰 모달이 열려 있다
     * @when 모달이 열린 상태에서 선택 체인을 Base로 바꾼다
     * @then token-modal이 닫혀 있다
     */
    it(
      "[EC-2] 모달이 열린 상태에서 선택 체인이 바뀌면 모달이 닫힌다",
      async () => {
        const { result } = await renderDisconnectedApp();
        await openModal("in");
        expect(tokenModal()).not.toBeNull();

        act(() => result.current.selected.setSelectedChainId(base.id));

        await waitUntil(() => expect(result.current.selected.selectedChainId).toBe(base.id));
        await waitUntil(() => expect(tokenModal()).toBeNull());
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("지갑이 연결되지 않았거나 복원 중인 경우", () => {
    /**
     * @spec EC-3
     * @given 앱이 Ethereum으로 렌더링됐다. 표본: 미연결(저장된 연결 없음), 복원 중(저장된 연결이 있고 복원이 끝나지 않음)을 하나씩 반복하며, 각 표본에서 주 버튼 data-state가 표본 상태(disconnected·restoring)인지 먼저 확인한다
     * @when 받는 칸 모달에서 USDC를 고르고, 보내는 칸에 `1`을 입력하고, flip-button을 누른다
     * @then 고른 뒤 받는 칸 token-button의 data-token-address가 USDC이고 모달이 닫힌다
     * @then 입력 뒤 보내는 칸 amount-input 값이 `1`이다
     * @then 뒤집은 뒤 보내는 칸이 USDC, 받는 칸이 ETH이고 금액이 빈 값이다
     */
    it(
      "[EC-3] 미연결·복원 중에도 토큰 선택, 금액 입력, 뒤집기가 연결 상태와 같이 동작한다",
      async () => {
        for (const sample of WALLET_SAMPLES) {
          await renderWalletSample(sample);
          expect(primaryState(), sample).toBe(sample);

          await openModal("out");
          fireEvent.click(optionRow(USDC.address));
          await waitUntil(() => expect(tokenAddress("out"), sample).toBe(USDC.address));
          await waitUntil(() => expect(tokenModal(), sample).toBeNull());

          typeAmount("1");
          await waitUntil(() => expect(amountInput("in").value, sample).toBe("1"));

          fireEvent.click(screen.getByTestId("flip-button"));
          await waitUntil(() => expect(tokenAddress("in"), sample).toBe(USDC.address));
          expect(tokenAddress("out"), sample).toBe(ETH.address);
          expect(amountInput("in").value, sample).toBe("");

          // 표본 상태가 끝까지 유지됐는지 확인한다.
          expect(primaryState(), sample).toBe(sample);
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-5
     * @given 앱이 Ethereum으로 렌더링됐다. 표본: 미연결, 복원 중을 하나씩 반복한다
     * @when 보내는 칸 모달을 연다
     * @then 어떤 token-option에도 data-balance-raw가 없다
     * @then token-option 주소 집합이 Ethereum 토큰 목록 전체의 주소 집합과 같다
     * @then 첫 5개 행이 ETH, WETH, USDC, USDT, DAI 순서다
     * @then 6번째 이후 행은 대소문자를 무시한 심볼순, 심볼이 같으면 소문자 주소 문자열순이다
     */
    it(
      "[EC-5] 미연결·복원 중의 모달 목록은 잔액 없이 고정 토큰, 나머지 토큰 순이다",
      async () => {
        const expectedOrder = orderWithoutBalances(mainnet.id);
        expect(expectedOrder.slice(0, 5)).toEqual(ETHEREUM_PINNED.map((token) => token.address));

        for (const sample of WALLET_SAMPLES) {
          await renderWalletSample(sample);
          expect(primaryState(), sample).toBe(sample);
          await openModal("in");

          const rows = optionRows();
          for (const row of rows) {
            expect(row.hasAttribute("data-balance-raw"), `${sample} ${rowAddress(row)}`).toBe(
              false,
            );
          }
          const listed = rows.map(rowAddress);
          expect(sortedAddresses(listed), sample).toEqual(
            sortedAddresses(TOKENS_BY_CHAIN[mainnet.id].map((token) => token.address)),
          );
          expect(listed.slice(0, 5), sample).toEqual(ETHEREUM_PINNED.map((token) => token.address));
          expect(listed, sample).toEqual(expectedOrder);

          expect(primaryState(), sample).toBe(sample);
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("토큰 로고를 표시할 수 없는 경우", () => {
    /**
     * @spec EC-18
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰을 logoURI가 없는 CT로 고른 상태다
     * @when 보내는 칸 모달을 연다
     * @then 보내는 칸 token-button 안의 token-logo가 data-fallback="true"다
     * @then CT 행의 token-logo가 data-fallback="true"다
     * @then 두 token-logo의 텍스트가 심볼 첫 글자 `C`다
     */
    it(
      "[EC-18] logoURI가 없는 토큰은 카드 토큰 버튼과 모달 행에 심볼 첫 글자를 표시한다",
      async () => {
        // Ethereum 스냅샷에서 logoURI가 없는 토큰 CT(전제 확인)
        const ctTokens = TOKENS_BY_CHAIN[mainnet.id].filter((token) => token.symbol === "CT");
        expect(ctTokens).toHaveLength(1);
        const ct = ctTokens[0]!;
        expect(ct.logoURI).toBeFalsy();

        await renderDisconnectedApp();
        await chooseToken("in", ct);
        expect(tokenAddress("in")).toBe(ct.address);

        await openModal("in");

        const cardLogo = within(tokenButton("in")).getByTestId("token-logo");
        const rowLogo = within(optionRow(ct.address)).getByTestId("token-logo");
        expect(cardLogo.getAttribute("data-fallback")).toBe("true");
        expect(rowLogo.getAttribute("data-fallback")).toBe("true");
        expect(cardLogo.textContent).toBe("C");
        expect(rowLogo.textContent).toBe("C");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-18
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰이 logoURI가 있는 USDC이며 보내는 칸 모달이 열려 있다. 표본: 로고 img `load` 이벤트, 로고 img `error` 이벤트를 하나씩 반복한다
     * @when 카드 token-button 안과 USDC 행 안의 로고 img에 표본 이벤트를 발생시킨다
     * @then `load` 표본에서는 두 token-logo가 data-fallback="false"다
     * @then `error` 표본에서는 두 token-logo가 data-fallback="true"다
     * @then `error` 표본에서는 두 token-logo의 텍스트가 심볼 첫 글자 `U`다
     */
    it(
      "[EC-18] 이미지 로드에 실패하면 카드 토큰 버튼과 모달 행에 심볼 첫 글자를 표시한다",
      async () => {
        expect(USDC.logoURI).toBeTruthy();

        for (const event of ["load", "error"] as const) {
          await renderDisconnectedApp();
          await chooseToken("in", USDC);
          await openModal("in");

          const logos = () => [
            within(tokenButton("in")).getByTestId("token-logo"),
            within(optionRow(USDC.address)).getByTestId("token-logo"),
          ];
          // jsdom은 이미지를 불러오지 않으므로 load·error를 직접 발생시킨다.
          for (const logo of logos()) {
            const image = logo.querySelector("img");
            expect(image, event).not.toBeNull();
            if (event === "load") fireEvent.load(image!);
            else fireEvent.error(image!);
          }

          await waitUntil(() => {
            for (const logo of logos()) {
              expect(logo.getAttribute("data-fallback"), event).toBe(
                event === "load" ? "false" : "true",
              );
            }
          });
          if (event === "error") {
            for (const logo of logos()) expect(logo.textContent, event).toBe("U");
          }

          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
