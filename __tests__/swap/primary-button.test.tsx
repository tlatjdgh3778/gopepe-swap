import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";
import { getConnection } from "wagmi/actions";

import { NATIVE_ETH_ADDRESS, PINNED_TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";

import {
  type BalanceRpcStub,
  balancesWith,
  installBalanceRpcStub,
  match,
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
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 `primary-button`의 `data-state`·비활성(스펙 §4.1)으로 판정한다.
// 지갑은 wagmi mock 커넥터 또는 스텁 EIP-1193, RPC는 전역 fetch 스텁(카드 잔액 응답)이다.

const CASE_TIMEOUT_MS = 30_000;

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

const CONNECTED_STATES = ["select-token", "enter-amount", "insufficient-balance", "input-valid"];
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const ETHEREUM_PINNED = PINNED_TOKENS_BY_CHAIN[mainnet.id];
const ETH = ETHEREUM_PINNED[0];
const USDC = ETHEREUM_PINNED[2];
const DAI = ETHEREUM_PINNED[4];
const BASE_ETH = PINNED_TOKENS_BY_CHAIN[base.id][0];
const BASE_USDC = PINNED_TOKENS_BY_CHAIN[base.id][2];

const ONE_ETH = 1_000_000_000_000_000_000n;

function field(side: Side): HTMLElement {
  const found = screen
    .getAllByTestId("token-field")
    .find((element) => element.getAttribute("data-side") === side);
  if (!found) throw new Error(`token-field[data-side="${side}"]가 없다`);
  return found;
}

function tokenAddress(side: Side): string | null {
  return within(field(side)).getByTestId("token-button").getAttribute("data-token-address");
}

function amountInput(): HTMLInputElement {
  return within(field("in")).getByTestId("amount-input") as HTMLInputElement;
}

function balanceElement(side: Side): HTMLElement | null {
  return within(field(side)).queryByTestId("balance");
}

function primaryButton(): HTMLButtonElement {
  return screen.getByTestId("primary-button") as HTMLButtonElement;
}

function primaryState(): string | null {
  return primaryButton().getAttribute("data-state");
}

function tokenModal(): HTMLElement | null {
  return screen.queryByTestId("token-modal");
}

function optionRow(address: string): HTMLElement {
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

async function chooseToken(side: Side, token: Token) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  fireEvent.click(optionRow(token.address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
  expect(tokenAddress(side)).toBe(token.address);
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

async function waitForInBalance(raw: bigint) {
  await waitUntil(() =>
    expect(balanceElement("in")?.getAttribute("data-balance-raw")).toBe(raw.toString()),
  );
}

function expectPrimary(state: string, label: string) {
  expect(primaryState(), label).toBe(state);
  expect(primaryButton().disabled, label).toBe(true);
}

function useProbe() {
  return { form: useSwapForm(), selected: useSelectedChain() };
}

function appConfig(connector: CreateConnectorFn) {
  return createWagmiConfig({
    connectors: [connector],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱.
async function renderMockConnectedApp() {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return { ...view, config };
}

// 스텁 EIP-1193 지갑으로 Ethereum에 연결된 앱. 계정 변경 이벤트를 보낼 수 있다.
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
    expect(connection.chainId).toBe(mainnet.id);
  });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return { ...view, stub };
}

// 미연결 앱. 커넥터가 없어 복원 시도가 곧 끝난다.
async function renderDisconnectedApp() {
  const config = createWagmiConfig({
    connectors: [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
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

function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 표본 입력 상태: 받는 칸 미선택 → 두 토큰 선택·금액 빈 값 → 두 토큰 선택·금액 `1`
async function walkInputSamples(expectedState: string) {
  expect(tokenAddress("out")).toBe("");
  expectPrimaryState(expectedState, "받는 칸 미선택");
  await chooseToken("out", USDC);
  expect(amountInput().value).toBe("");
  expectPrimaryState(expectedState, "두 토큰 선택·금액 빈 값");
  await typeAmount("1");
  expectPrimaryState(expectedState, "두 토큰 선택·금액 1");
}

function expectPrimaryState(state: string, label: string) {
  expect(primaryState(), label).toBe(state);
}

describe("주 버튼 — 사용자가 지금 입력에서 무엇이 부족한지 상태로 안내받는다", () => {
  describe("복원 중이거나 미연결인 경우", () => {
    /**
     * @spec DoD-34
     * @given 저장된 연결이 있고 복원이 끝나지 않아 복원 중이다. 표본 입력 상태: 받는 칸 미선택, 두 토큰 선택·금액 빈 값, 두 토큰 선택·금액 `1`을 하나씩 반복한다
     * @when 표본 입력 상태를 만든다
     * @then primary-button의 data-state가 `restoring`이다
     */
    it(
      "[DoD-34] 복원 중이면 입력 상태와 관계없이 restoring이다",
      async () => {
        await renderRestoringApp();
        await walkInputSamples("restoring");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-34
     * @given 저장된 연결이 없고 복원이 끝나 미연결이다. 표본 입력 상태: 받는 칸 미선택, 두 토큰 선택·금액 빈 값, 두 토큰 선택·금액 `1`을 하나씩 반복한다
     * @when 표본 입력 상태를 만든다
     * @then primary-button의 data-state가 `disconnected`다
     */
    it(
      "[DoD-34] 미연결이면 입력 상태와 관계없이 disconnected다",
      async () => {
        await renderDisconnectedApp();
        await walkInputSamples("disconnected");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("연결 상태에서 토큰이 정해지지 않은 경우", () => {
    /**
     * @spec DoD-35
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 1 ETH로 읽혔다. 표본: 초기 상태(보내는 ETH, 받는 미선택), 보내는 ETH·받는 미선택·금액 `2`(잔액보다 크다), flip-button으로 보내는 칸이 미선택이 된 상태를 하나씩 반복한다
     * @when 표본 상태를 만든다
     * @then primary-button의 data-state가 `select-token`이다
     * @then primary-button이 비활성이다
     */
    it(
      "[DoD-35] 두 칸 중 하나라도 토큰이 미선택이면 select-token, 비활성이다",
      async () => {
        rpc.setBalances(balancesWith({ [NATIVE_ETH_ADDRESS]: ONE_ETH }));
        await renderMockConnectedApp();
        await waitForInBalance(ONE_ETH);

        // 초기 상태(보내는 ETH, 받는 미선택)
        expect(tokenAddress("in")).toBe(ETH.address);
        expect(tokenAddress("out")).toBe("");
        expectPrimary("select-token", "초기 상태");

        // 보내는 ETH·받는 미선택·금액 2(잔액 1 ETH보다 크다)
        await typeAmount("2");
        expectPrimary("select-token", "받는 칸 미선택·금액이 잔액보다 큼");

        // 뒤집어 보내는 칸이 미선택
        fireEvent.click(screen.getByTestId("flip-button"));
        await waitUntil(() => expect(tokenAddress("in")).toBe(""));
        expectPrimary("select-token", "보내는 칸 미선택");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("연결 상태에서 두 토큰이 선택된 경우", () => {
    /**
     * @spec DoD-36 EC-23 DoD-39
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC가 선택돼 있다. 표본 금액: 빈 값, `.`, `0`, `0.00`을 하나씩 반복한다
     * @when 보내는 칸에 표본 금액을 입력한다(빈 값은 입력하지 않는다)
     * @then primary-button의 data-state가 `enter-amount`다
     * @then primary-button이 비활성이다
     * @then 보내는 칸 amount-input 값이 입력한 표본 문자열 그대로다(정규화하지 않는다)
     * @then useSwapForm()의 amountIn이 입력한 표본 문자열 그대로다
     * @then useSwapForm()의 amountInRaw가 빈 값·`.` 표본에서는 null, `0`·`0.00` 표본에서는 `0n`이다
     */
    it(
      "[DoD-36][EC-23][DoD-39] 금액이 비었거나 값이 0이면 enter-amount, 비활성이고 입력 문자열은 그대로다",
      async () => {
        const { result } = await renderMockConnectedApp();
        await chooseToken("out", USDC);
        expect(tokenAddress("in")).toBe(ETH.address);

        const samples = [
          { amount: "", raw: null },
          { amount: ".", raw: null },
          { amount: "0", raw: 0n },
          { amount: "0.00", raw: 0n },
        ];
        for (const sample of samples) {
          const label = `금액 ${JSON.stringify(sample.amount)}`;
          if (sample.amount !== "") await typeAmount(sample.amount);

          await waitUntil(() => expect(primaryState(), label).toBe("enter-amount"));
          expectPrimary("enter-amount", label);
          expect(amountInput().value, label).toBe(sample.amount);
          expect(result.current.form.amountIn, label).toBe(sample.amount);
          expect(result.current.form.amountInRaw, label).toBe(sample.raw);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-37
     * @given mock 커넥터로 Ethereum에 연결돼 있고 받는 칸에 DAI가 선택돼 있으며 카드 잔액 읽기가 성공했다. 표본: 보내는 ETH 잔액 1 ETH·금액 `1.5`, 보내는 USDC 잔액 100 USDC·금액 `100.5`를 하나씩 반복한다
     * @when 보내는 칸에 표본 금액을 입력한다
     * @then primary-button의 data-state가 `insufficient-balance`다
     * @then primary-button이 비활성이다
     */
    it(
      "[DoD-37] 금액이 보내는 토큰 잔액보다 크면 insufficient-balance, 비활성이다",
      async () => {
        const samples = [
          { tokenIn: ETH, balance: ONE_ETH, amount: "1.5" },
          { tokenIn: USDC, balance: 100_000_000n, amount: "100.5" },
        ];
        expect(USDC.decimals).toBe(6);

        for (const sample of samples) {
          const label = `${sample.tokenIn.symbol} ${sample.amount}`;
          rpc.setBalances(balancesWith({ [sample.tokenIn.address]: sample.balance }));
          await renderMockConnectedApp();
          if (sample.tokenIn.address !== ETH.address) await chooseToken("in", sample.tokenIn);
          await chooseToken("out", DAI);
          await waitForInBalance(sample.balance);

          await typeAmount(sample.amount);

          await waitUntil(() => expect(primaryState(), label).toBe("insufficient-balance"));
          expectPrimary("insufficient-balance", label);
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-38
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH(잔액 1 ETH, 읽기 성공), 받는 USDC가 선택돼 있다. 표본 금액: `0.5`, `1`(잔액과 같음)을 하나씩 반복한다
     * @when 보내는 칸에 표본 금액을 입력한다
     * @then primary-button의 data-state가 `input-valid`다
     * @then primary-button이 비활성이다
     */
    it(
      "[DoD-38] select-token·enter-amount·insufficient-balance에 해당하지 않으면 input-valid, 비활성이다",
      async () => {
        rpc.setBalances(balancesWith({ [NATIVE_ETH_ADDRESS]: ONE_ETH }));
        await renderMockConnectedApp();
        await chooseToken("out", USDC);
        await waitForInBalance(ONE_ETH);

        for (const amount of ["0.5", "1"]) {
          await typeAmount(amount);
          await waitUntil(() => expect(primaryState(), amount).toBe("input-valid"));
          expectPrimary("input-valid", amount);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("잔액 비교가 정수로 이뤄지는 경우", () => {
    /**
     * @spec EC-25
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH 잔액이 1.23456789 ETH(표시값 `1.2345`)로 읽혔으며 받는 USDC가 선택돼 있다
     * @when 보내는 칸에 표시값보다 크고 잔액 이하인 `1.23456`을 입력한다
     * @then primary-button의 data-state가 `insufficient-balance`가 아니고 `input-valid`다
     */
    it(
      "[EC-25] 표시용 버림값이 아니라 정수 잔액과 비교해 판정한다",
      async () => {
        const balance = 1_234_567_890_000_000_000n;
        rpc.setBalances(balancesWith({ [NATIVE_ETH_ADDRESS]: balance }));
        await renderMockConnectedApp();
        await chooseToken("out", USDC);
        await waitForInBalance(balance);

        await typeAmount("1.23456");

        await waitUntil(() => expect(primaryState()).not.toBe("enter-amount"));
        await settlePendingWork();
        expect(primaryState()).not.toBe("insufficient-balance");
        expect(primaryState()).toBe("input-valid");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-25
     * @given mock 커넥터로 Ethereum에 연결돼 있고 카드 잔액 읽기가 성공했다. 표본: 보내는 USDC 잔액 123.456789 USDC·받는 DAI, 보내는 ETH 잔액 1.23456789 ETH(가스 예약량 0.005 ETH보다 크다)·받는 USDC를 하나씩 반복한다
     * @when max-button을 누른다
     * @then primary-button의 data-state가 `insufficient-balance`가 아니고 `input-valid`다
     */
    it(
      "[EC-25] 최대로 넣은 값은 insufficient-balance가 되지 않는다",
      async () => {
        const samples = [
          { tokenIn: USDC, tokenOut: DAI, balance: 123_456_789n },
          { tokenIn: ETH, tokenOut: USDC, balance: 1_234_567_890_000_000_000n },
        ];

        for (const sample of samples) {
          const label = `${sample.tokenIn.symbol} 최대`;
          rpc.setBalances(balancesWith({ [sample.tokenIn.address]: sample.balance }));
          await renderMockConnectedApp();
          if (sample.tokenIn.address !== ETH.address) await chooseToken("in", sample.tokenIn);
          await chooseToken("out", sample.tokenOut);
          await waitForInBalance(sample.balance);
          const maxButton = within(field("in")).getByTestId("max-button") as HTMLButtonElement;
          expect(maxButton.disabled, label).toBe(false);

          fireEvent.click(maxButton);

          await waitUntil(() => expect(amountInput().value, label).not.toBe(""));
          await settlePendingWork();
          expect(primaryState(), label).not.toBe("insufficient-balance");
          expect(primaryState(), label).toBe("input-valid");
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("카드 잔액을 아직 모르는 경우", () => {
    /**
     * @spec EC-11
     * @given Ethereum에 연결돼 있고(계정 변경 표본은 스텁 EIP-1193, 나머지 표본은 mock 커넥터) 보내는 ETH, 받는 USDC가 선택돼 있다. 표본: 카드 잔액 읽기 응답이 지연 중, 카드 잔액 읽기가 실패, 첫 계정의 잔액 1 ETH 읽기가 성공한 뒤 연결 계정을 바꾸고(accountsChanged) 새 계정 읽기 응답이 지연 중인 상태, Ethereum에서 보내는 ETH 잔액 1 ETH 읽기가 성공한 뒤 선택 체인을 Base로 바꾸고 Base 카드 잔액 응답이 지연된 동안 받는 칸 모달에서 Base USDC를 고른 상태(EC-1로 받는 칸이 미선택이 됐다가 다시 선택된다)를 하나씩 반복하며 각 표본에서 보내는 칸 balance에 data-balance-raw가 없는지 먼저 확인한다
     * @when 보내는 칸에 `1000000`을 입력한다
     * @then primary-button의 data-state가 `insufficient-balance`가 아니고 `input-valid`다
     */
    it(
      "[EC-11] 성공한 카드 잔액이 없으면 insufficient-balance를 판정하지 않는다",
      async () => {
        const ethBalance = balancesWith({ [NATIVE_ETH_ADDRESS]: ONE_ETH });
        const samples = [
          "읽기 응답 지연",
          "읽기 실패",
          "계정 변경 뒤 응답 지연",
          "체인 변경 뒤 응답 지연",
        ] as const;

        for (const sample of samples) {
          rpc.setBalances(ethBalance);
          let release = () => {};

          if (sample === "읽기 응답 지연") {
            release = rpc.hold(match.kind("eth_getBalance")).release;
            await renderMockConnectedApp();
            await chooseToken("out", USDC);
          } else if (sample === "읽기 실패") {
            rpc.failWhen(match.kind("eth_getBalance"));
            await renderMockConnectedApp();
            await chooseToken("out", USDC);
            await waitUntil(() =>
              expect(
                rpc
                  .requests(match.kind("eth_getBalance"))
                  .some((request) => request.status === "failed"),
              ).toBe(true),
            );
          } else if (sample === "계정 변경 뒤 응답 지연") {
            const { stub } = await renderStubConnectedApp();
            await chooseToken("out", USDC);
            await waitForInBalance(ONE_ETH);
            const gate = rpc.hold(match.account(SECOND_ACCOUNT, match.kind("eth_getBalance")));
            release = gate.release;
            act(() => stub.changeAccounts([SECOND_ACCOUNT]));
            await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0));
          } else {
            const { result } = await renderMockConnectedApp();
            await chooseToken("out", USDC);
            await waitForInBalance(ONE_ETH);
            const gate = rpc.hold(match.chain(base.id, match.kind("eth_getBalance")));
            release = gate.release;
            act(() => result.current.selected.setSelectedChainId(base.id));
            await waitUntil(() => expect(tokenAddress("in")).toBe(BASE_ETH.address));
            await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0));
            await chooseToken("out", BASE_USDC);
          }

          await settlePendingWork();
          const balance = balanceElement("in");
          expect(balance, sample).not.toBeNull();
          expect(balance!.hasAttribute("data-balance-raw"), sample).toBe(false);

          await typeAmount("1000000");

          await waitUntil(() => expect(primaryState(), sample).not.toBe("enter-amount"));
          await settlePendingWork();
          expect(balanceElement("in")!.hasAttribute("data-balance-raw"), sample).toBe(false);
          expect(primaryState(), sample).not.toBe("insufficient-balance");
          expect(primaryState(), sample).toBe("input-valid");

          release();
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
