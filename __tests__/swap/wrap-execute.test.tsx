import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { type Address, hexToBigInt } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type AllowanceFn,
  type BalanceRpcStub,
  STUB_MAX_UINT256,
  allowanceAlways,
  installBalanceRpcStub,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type ChainSwitchControl,
  SEND_TRANSACTION_METHODS,
  type SentTransaction,
  type StubEip1193,
  USER_REJECTED_CODE,
  type WalletTransactionControl,
  createStubEip1193,
  installChainSwitch,
  installWalletTransactions,
} from "../support/stub-eip1193";
import {
  CHAIN_SWITCH_METHODS,
  TEST_ACCOUNT,
  clearCookies,
  createButtonStateRecorder,
  createNoopWagmiStorage,
  decodeWethCalldata,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 `primary-button`의 `data-state`·비활성(커밋마다 기록), 지갑 요청 기록(체인 전환·전송 요청의 `to`·calldata·`value`·순서)으로 판정한다.
// 실행 함수 직접 호출(EC-7)은 앱 Provider 안의 프로브에서 useSwapExecution()의 `wrap`·`unwrap`을 부르고 phase·result를 읽는다.
// mock 경계(사용자 확정(2026-11-20) — F5 T-9·T-10 경계): 실제 wagmi·Provider·화면, mock 커넥터, 스텁 EIP-1193 지갑(체인 전환 요청 응답·붙잡기, `eth_sendTransaction` 기록·해시 응답·4001 거부·붙잡기),
// 전역 fetch URL 라우팅 RPC 스텁(견적 aggregate3, 잔액, allowance, 영수증 성공·붙잡기), `Date` 가짜 시계와 가짜 타이머, DOM 이벤트. 선택 체인 변경은 화면의 체인 선택 드롭다운을 실제로 조작한다. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다. 같은 case 안의 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링한다.
// "전송 요청"은 스텁 EIP-1193 요청 기록 중 `eth_sendTransaction` 항목이고, "지갑 요청"은 스텁 EIP-1193 요청 기록의 모든 항목이다.
// WETH calldata는 테스트 쪽 ABI 리터럴 `deposit()`, `withdraw(uint256 wad)`로 디코딩한다.
// 선택 체인 WETH 주소는 제품 config를 쓰지 않고 리터럴로 적는다: Ethereum `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`,
// Base `0x4200000000000000000000000000000000000006`, Arbitrum `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`.
// 표본 금액: ETH·WETH `0.5` → amountInRaw `500_000_000_000_000_000n`, 바꾼 금액 `2` → `2_000_000_000_000_000_000n`.

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 10_000;

// 선택 체인 WETH 주소(config 리터럴, 제품 config를 쓰지 않는다)
const WETH_BY_CHAIN: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  [base.id]: "0x4200000000000000000000000000000000000006",
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// 표본 금액 `0.5` → amountInRaw
const HALF_ETH = 500_000_000_000_000_000n;

type WethKind = "wrap" | "unwrap";
const WETH_KINDS: readonly WethKind[] = ["wrap", "unwrap"];
const READY_STATE = { wrap: "wrap-ready", unwrap: "unwrap-ready" } as const;

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

// 주기 타이머(setInterval)와 시계만 가짜로 둔다. 입력 반영 대기(setTimeout)는 실제 시간으로 흐른다.
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
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

function clickPrimary() {
  fireEvent.click(primaryButton());
}

function expectSameAddress(actual: string | undefined, expected: Address, label?: string) {
  expect(actual?.toLowerCase(), label).toBe(expected.toLowerCase());
}

function expectAllState(
  snapshots: readonly { state: string | null; disabled: boolean }[],
  expected: string,
  label: string,
) {
  for (const [index, snapshot] of snapshots.entries()) {
    expect(snapshot.state, `${label} #${index}`).toBe(expected);
    expect(snapshot.disabled, `${label} #${index}`).toBe(true);
  }
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution(), quote: useSwapQuote(), form: useSwapForm() };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  chainSwitch: ChainSwitchControl;
  recorder: ReturnType<typeof createButtonStateRecorder>;
  probe: () => Probe;
};

type AppSetup = {
  // 지갑 체인(기본 Ethereum)
  walletChainId?: SupportedChainId;
  // 선택 체인(기본 Ethereum)
  selectedChainId?: SupportedChainId;
  allowance?: AllowanceFn;
};

// 스텁 EIP-1193 지갑으로 연결된 앱을 렌더링한다. `eth_sendTransaction`은 해시로 응답하고 주 버튼 상태를 커밋마다 기록한다.
// 견적은 가격 영향 normal·최소 수령량 > 0 규칙(`parityQuoteRule`)이다.
async function renderConnectedApp({
  walletChainId = mainnet.id,
  selectedChainId = mainnet.id,
  allowance = allowanceAlways(0n),
}: AppSetup = {}): Promise<Scenario> {
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setAllowances(allowance);
  const stub = createStubEip1193({
    chainId: walletChainId,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletTransactions(stub);
  const chainSwitch = installChainSwitch(stub);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const recorder = createButtonStateRecorder();
  const view = renderAppHook(useProbe, {
    config,
    initialChainId: selectedChainId,
    onCommit: recorder.onCommit,
  });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(walletChainId);
  }, READY_TIMEOUT_MS);
  return { stub, wallet, chainSwitch, recorder, probe: () => view.result.current };
}

// 페어와 금액을 입력하고 주 버튼이 `state`가 될 때까지 기다린다.
async function enterPair(
  tokenIn: Address,
  tokenOut: Address,
  amount: string,
  state: string,
): Promise<void> {
  await chooseToken("in", tokenIn);
  await chooseToken("out", tokenOut);
  if (amount !== "") await typeAmount(amount);
  await waitUntil(() => expect(primaryState()).toBe(state), READY_TIMEOUT_MS);
  await settlePendingWork();
  expect(primaryState()).toBe(state);
}

// wrap은 ETH → WETH, unwrap은 WETH → ETH(선택 체인의 WETH)를 금액 `amount`로 입력해 준비 상태를 기다린다.
async function enterWethPair(
  kind: WethKind,
  chainId: SupportedChainId,
  amount: string,
  state: string = READY_STATE[kind],
) {
  const weth = WETH_BY_CHAIN[chainId];
  if (kind === "wrap") await enterPair(NATIVE_ETH, weth, amount, state);
  else await enterPair(weth, NATIVE_ETH, amount, state);
}

function sendCount(stub: StubEip1193): number {
  return requestsSince(stub, 0, SEND_TRANSACTION_METHODS).length;
}

// 지갑 요청의 `value`(16진)를 bigint로 읽는다. 필드가 없으면 undefined
function sentValue(sent: SentTransaction): bigint | undefined {
  return sent.value === undefined ? undefined : hexToBigInt(sent.value);
}

function decodeSentWeth(sent: SentTransaction) {
  if (!sent.data) throw new Error("전송 요청의 calldata가 없다");
  return decodeWethCalldata(sent.data);
}

// 호출이 돌려준 Promise의 결과를 기록한다.
type CallOutcome = { status: "resolved"; value: unknown } | { status: "rejected"; error: unknown };

function track(promise: Promise<unknown>): { outcome: CallOutcome | null } {
  const tracked: { outcome: CallOutcome | null } = { outcome: null };
  promise.then(
    (value) => {
      tracked.outcome = { status: "resolved", value };
    },
    (error: unknown) => {
      tracked.outcome = { status: "rejected", error };
    },
  );
  return tracked;
}

// 표본 함수를 앱 Provider 안의 프로브에서 인자 없이 직접 부른다.
function callDirect(s: Scenario, calls: readonly WethKind[]) {
  const tracked: { outcome: CallOutcome | null }[] = [];
  act(() => {
    for (const call of calls) tracked.push(track(s.probe().execution[call]()));
  });
  return tracked;
}

describe("ETH ↔ WETH 전환 — 사용자가 WETH 컨트랙트로 클릭 시점 금액만큼 ETH를 감싸거나 푼다", () => {
  describe("wrap-ready·unwrap-ready에서 주 버튼을 누르는 경우", () => {
    /**
     * @spec DoD-21
     * @given 스텁 EIP-1193으로 연결돼 있고 지갑 체인과 선택 체인이 같으며 `eth_sendTransaction` 핸들러는 해시로 응답한다. 보내는 ETH(잔액 충분), 받는 WETH, 금액 `0.5`(amountInRaw `500_000_000_000_000_000n`)이고 주 버튼이 wrap-ready이며 활성이다. 표본(선택 체인 — 그 체인 WETH 주소 리터럴): Ethereum — `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, Base — `0x4200000000000000000000000000000000000006`, Arbitrum — `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`을 하나씩 반복한다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이고 `to`가 표본 선택 체인의 WETH 주소 리터럴이다
     * @then 전송 요청의 calldata를 테스트 쪽 `deposit()` ABI 리터럴로 디코딩하면 함수가 `deposit`이다
     * @then 전송 요청의 `value`가 클릭 시점 amountInRaw `500_000_000_000_000_000n`이다
     */
    it(
      "[DoD-21] wrap-ready 클릭은 선택 체인 WETH에 클릭 시점 amountInRaw value로 deposit()을 보낸다",
      async () => {
        const chains: readonly SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        for (const [index, chainId] of chains.entries()) {
          if (index > 0) resetSample();
          const label = `wrap — 선택 체인 ${chainId}`;
          const s = await renderConnectedApp({ walletChainId: chainId, selectedChainId: chainId });
          await enterWethPair("wrap", chainId, "0.5");
          expect(primaryButton().disabled, label).toBe(false);
          expect(s.probe().form.amountInRaw, label).toBe(HALF_ETH);

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          const sent = s.wallet.sent[0]!;

          expect(sendCount(s.stub), label).toBe(1);
          expectSameAddress(sent.to, WETH_BY_CHAIN[chainId], `${label} to`);
          expect(decodeSentWeth(sent), label).toEqual({ functionName: "deposit" });
          expect(sentValue(sent), `${label} value`).toBe(500_000_000_000_000_000n);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-22
     * @given 스텁 EIP-1193으로 연결돼 있고 지갑 체인과 선택 체인이 같으며 `eth_sendTransaction` 핸들러는 해시로 응답한다. 보내는 WETH(잔액 충분), 받는 ETH, 금액 `0.5`(amountInRaw `500_000_000_000_000_000n`)이고 주 버튼이 unwrap-ready이며 활성이다. 표본(선택 체인 — 그 체인 WETH 주소 리터럴): Ethereum — `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, Base — `0x4200000000000000000000000000000000000006`, Arbitrum — `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`을 하나씩 반복한다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이고 `to`가 표본 선택 체인의 WETH 주소 리터럴이다
     * @then 전송 요청의 calldata를 테스트 쪽 `withdraw(uint256 wad)` ABI 리터럴로 디코딩하면 함수가 `withdraw`이고 wad가 클릭 시점 amountInRaw `500_000_000_000_000_000n`이다
     * @then 전송 요청에 `value` 필드가 없거나 그 값이 0이다
     */
    it(
      "[DoD-22] unwrap-ready 클릭은 선택 체인 WETH에 value 없이 withdraw(클릭 시점 amountInRaw)를 보낸다",
      async () => {
        const chains: readonly SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        for (const [index, chainId] of chains.entries()) {
          if (index > 0) resetSample();
          const label = `unwrap — 선택 체인 ${chainId}`;
          const s = await renderConnectedApp({ walletChainId: chainId, selectedChainId: chainId });
          await enterWethPair("unwrap", chainId, "0.5");
          expect(primaryButton().disabled, label).toBe(false);
          expect(s.probe().form.amountInRaw, label).toBe(HALF_ETH);

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          const sent = s.wallet.sent[0]!;

          expect(sendCount(s.stub), label).toBe(1);
          expectSameAddress(sent.to, WETH_BY_CHAIN[chainId], `${label} to`);
          expect(decodeSentWeth(sent), label).toEqual({
            functionName: "withdraw",
            wad: 500_000_000_000_000_000n,
          });
          const value = sentValue(sent);
          expect(
            value === undefined || value === 0n,
            `${label} value 없음 또는 0 (실제 ${value})`,
          ).toBe(true);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("지갑 체인이 선택 체인과 다른 경우", () => {
    /**
     * @spec DoD-23
     * @given 스텁 EIP-1193으로 연결돼 있고 지갑 체인이 선택 체인과 다르며 스텁 지갑은 체인 전환 요청에 성공으로 응답하고 `eth_sendTransaction`에 해시로 응답한다. 표본(종류 — 지갑 체인 → 선택 체인 — 페어): wrap — Base → Ethereum — ETH → WETH `0.5`(wrap-ready), unwrap — Ethereum → Arbitrum — WETH → ETH `0.5`(unwrap-ready)를 하나씩 반복한다
     * @when 주 버튼을 누르고 전송 요청이 기록되기를 기다린다
     * @then 지갑이 받은 체인 전환 요청이 eth_sendTransaction 요청보다 앞서고 그 대상 체인이 표본 선택 체인이다
     * @then 트랜잭션은 선택 체인으로 보내진다(전송 요청 시점에 지갑 체인이 클릭 시점 선택 체인이다)
     * @then 전송 요청의 `to`가 표본 선택 체인의 WETH 주소 리터럴이다
     */
    it(
      "[DoD-23] wrap·unwrap은 전송 전에 지갑 체인을 선택 체인으로 맞추고 선택 체인으로 보낸다",
      async () => {
        const samples: {
          kind: WethKind;
          walletChainId: SupportedChainId;
          selectedChainId: SupportedChainId;
        }[] = [
          { kind: "wrap", walletChainId: base.id, selectedChainId: mainnet.id },
          { kind: "unwrap", walletChainId: mainnet.id, selectedChainId: arbitrum.id },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { kind, walletChainId, selectedChainId } = sample;
          const label = `${kind} — 지갑 ${walletChainId} → 선택 ${selectedChainId}`;
          const s = await renderConnectedApp({ walletChainId, selectedChainId });
          await enterWethPair(kind, selectedChainId, "0.5");
          const from = s.stub.requests.length;

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          const sent = s.wallet.sent[0]!;

          const requests = s.stub.requests.slice(from);
          const switchIndex = requests.findIndex(
            (request) => request.method === "wallet_switchEthereumChain",
          );
          const sendIndex = requests.findIndex(
            (request) => request.method === "eth_sendTransaction",
          );
          expect(switchIndex, `${label} 체인 전환 요청`).toBeGreaterThanOrEqual(0);
          expect(
            Number((requests[switchIndex]!.params as [{ chainId: string }])[0].chainId),
            `${label} 체인 전환 대상`,
          ).toBe(selectedChainId);
          expect(sendIndex, `${label} 전송이 체인 전환 뒤`).toBeGreaterThan(switchIndex);
          // 전송 요청을 받은 시점의 지갑 체인이 클릭 시점 선택 체인이다.
          expect(sent.walletChainId, label).toBe(selectedChainId);
          expectSameAddress(sent.to, WETH_BY_CHAIN[selectedChainId], `${label} to`);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("지갑 서명을 기다리는 동안", () => {
    /**
     * @spec DoD-26
     * @given 스텁 EIP-1193으로 연결돼 있고 지갑 체인이 선택 체인과 다르며 스텁 지갑은 체인 전환 응답과 eth_sendTransaction 응답을 붙잡는다. 주 버튼 상태(data-state·비활성)를 클릭 직후 첫 커밋부터 커밋마다 기록한다. 표본: wrap(ETH → WETH `0.5`, wrap-ready), unwrap(WETH → ETH `0.5`, unwrap-ready)을 하나씩 반복한다
     * @when 주 버튼을 누르고, 체인 전환 응답을 붙잡은 동안과 그 응답을 풀고 eth_sendTransaction 응답을 붙잡은 동안 주 버튼 상태를 기록한다
     * @then 클릭 직후 첫 커밋부터 주 버튼은 awaiting-signature이고 비활성이다
     * @then 체인 전환 응답을 기다리는 동안 기록된 주 버튼 상태는 모두 awaiting-signature이고 비활성이다
     * @then eth_sendTransaction 응답을 기다리는 동안 기록된 주 버튼 상태는 모두 awaiting-signature이고 비활성이다
     */
    it(
      "[DoD-26] wrap·unwrap 클릭 즉시부터 서명이 끝날 때까지 주 버튼은 awaiting-signature이고 비활성이다",
      async () => {
        for (const [index, kind] of WETH_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderConnectedApp({ walletChainId: base.id });
          await enterWethPair(kind, mainnet.id, "0.5");
          expect(primaryButton().disabled, kind).toBe(false);
          const switchGate = s.chainSwitch.hold();
          const sendGate = s.wallet.hold();
          const recorded = () => s.recorder.snapshots("primary-button");
          const mark = recorded().length;
          expect(recorded().at(-1)?.state, kind).toBe(READY_STATE[kind]);

          clickPrimary();
          // 클릭 이벤트 처리 직후의 첫 커밋
          const first = recorded()[mark];
          expect(first?.state, `${kind} 클릭 직후 첫 커밋`).toBe("awaiting-signature");
          expect(first?.disabled, `${kind} 클릭 직후 첫 커밋`).toBe(true);

          await waitUntil(() => expect(switchGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          await settlePendingWork();
          expectAllState(
            recorded().slice(mark),
            "awaiting-signature",
            `${kind} 체인 전환 응답 대기`,
          );

          switchGate.release();
          await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          await settlePendingWork();
          // 전제: 체인 전환이 끝난 뒤 서명 요청을 받았다.
          expect(s.stub.chainId, kind).toBe(mainnet.id);
          expectAllState(recorded().slice(mark), "awaiting-signature", `${kind} 서명 응답 대기`);

          sendGate.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-8
     * @given 가짜 타이머를 쓰고 스텁 EIP-1193으로 연결돼 있으며 지갑 체인은 Base(지갑 등록 체인 Base·Ethereum), 선택 체인은 Ethereum이라 둘이 다르다. 스텁 지갑은 `wallet_switchEthereumChain` 요청을 붙잡고 `eth_sendTransaction`에는 해시로 바로 응답한다. 금액 `0.5`(amountInRaw `500_000_000_000_000_000n`)이다. 표본: wrap(보내는 ETH, 받는 WETH, wrap-ready), unwrap(보내는 WETH, 받는 ETH, unwrap-ready)을 하나씩 반복한다(보내는 토큰 잔액은 바꾼 금액보다도 충분)
     * @when 주 버튼을 누르고 체인 전환 요청이 붙잡힌 동안 보내는 칸 amount-input을 `2`로 바꿔 반영되기를 기다린 뒤, 붙잡은 체인 전환 요청을 풀어(Ethereum으로 전환해 성공 응답) 전송 요청이 기록되기를 기다린다
     * @then 체인 전환 요청이 붙잡힌 동안 useSwapForm().amountInRaw가 `2_000_000_000_000_000_000n`이 됐고 주 버튼은 awaiting-signature다
     * @then 전송 요청이 1건이고 `to`가 Ethereum WETH 주소 리터럴이다
     * @then wrap 표본은 전송 요청의 `value`가 클릭 시점 amountInRaw `500_000_000_000_000_000n`이다
     * @then unwrap 표본은 전송 요청 calldata의 `withdraw` wad가 클릭 시점 amountInRaw `500_000_000_000_000_000n`이다
     */
    it(
      "[EC-8] wrap·unwrap 서명 대기 중 금액을 바꿔도 클릭 시점 amountInRaw로 보낸다",
      async () => {
        for (const [index, kind] of WETH_KINDS.entries()) {
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const s = await renderConnectedApp({ walletChainId: base.id });
          await enterWethPair(kind, mainnet.id, "0.5");
          // 전제: 클릭 시점 금액
          expect(s.probe().form.amountInRaw, kind).toBe(HALF_ETH);
          const switchGate = s.chainSwitch.hold();

          clickPrimary();
          await waitUntil(() => expect(switchGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          expect(s.wallet.sent, kind).toHaveLength(0);

          await typeAmount("2");
          await waitUntil(
            () => expect(s.probe().form.amountInRaw).toBe(2_000_000_000_000_000_000n),
            READY_TIMEOUT_MS,
          );
          expect(primaryState(), kind).toBe("awaiting-signature");
          expect(switchGate.heldCount, kind).toBe(1);
          expect(s.wallet.sent, kind).toHaveLength(0);

          switchGate.release();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          const sent = s.wallet.sent[0]!;
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(sendCount(s.stub), kind).toBe(1);
          expectSameAddress(sent.to, ETHEREUM_WETH, `${kind} to`);
          if (kind === "wrap") {
            expect(sentValue(sent), `${kind} value`).toBe(500_000_000_000_000_000n);
          } else {
            expect(decodeSentWeth(sent), kind).toEqual({
              functionName: "withdraw",
              wad: 500_000_000_000_000_000n,
            });
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("실행 함수를 허용 상태 밖이나 진행 중에 호출하는 경우", () => {
    /**
     * @spec EC-7
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 프로브로 useSwapExecution()과 주 버튼 상태를 읽는다. 표본(호출 함수 — 주 버튼 상태 — 호출 전 result): `wrap` — unwrap-ready(보내는 WETH, 받는 ETH, 금액 `0.5`) — null, `wrap` — enter-amount(보내는 ETH, 받는 WETH, 금액 빈 값) — null, `wrap` — swap-ready(보내는 ETH, 받는 USDC, 금액 `1`의 견적 success) — null, `unwrap` — wrap-ready(보내는 ETH, 받는 WETH, 금액 `0.5`) — null, `unwrap` — enter-amount(보내는 WETH, 받는 ETH, 금액 빈 값) — null, `unwrap` — approve-required(보내는 WETH, 받는 USDC, 금액 `0.5`, allowance 0) — null, `wrap`과 `unwrap` — wrap 영수증 성공 뒤 금액이 비어 enter-amount — wrap 성공 결과, `wrap` — unwrap 서명을 지갑이 4001로 거부한 뒤 unwrap-ready — unwrap rejected 결과를 하나씩 반복한다. 호출 직전 지갑 요청 수와 result를 기록한다
     * @when 표본 함수를 인자 없이 직접 호출하고 대기 중인 작업을 진행시킨다
     * @then 돌려준 Promise가 reject 없이 `undefined`로 resolve한다
     * @then 지갑 요청 수가 기록한 수에서 늘지 않고 전송 요청이 늘지 않는다
     * @then useSwapExecution().result가 호출 전에 기록한 값 그대로다(null 표본은 null, 결과 표본은 같은 결과이고 null이 되지 않는다)
     */
    it(
      "[EC-7] wrap을 wrap-ready가 아닐 때, unwrap을 unwrap-ready가 아닐 때 호출하면 지갑 요청 없이 resolve하고 result를 바꾸지 않는다",
      async () => {
        type ResultBefore = "null" | "wrap-success" | "unwrap-rejected";
        type OutOfStateSample = {
          label: string;
          calls: readonly WethKind[];
          state: string;
          resultBefore: ResultBefore;
          allowance?: AllowanceFn;
          setup: (s: Scenario) => Promise<void>;
        };
        const samples: OutOfStateSample[] = [
          {
            label: "wrap — unwrap-ready",
            calls: ["wrap"],
            state: "unwrap-ready",
            resultBefore: "null",
            setup: () => enterWethPair("unwrap", mainnet.id, "0.5"),
          },
          {
            label: "wrap — enter-amount",
            calls: ["wrap"],
            state: "enter-amount",
            resultBefore: "null",
            setup: () => enterWethPair("wrap", mainnet.id, "", "enter-amount"),
          },
          {
            label: "wrap — swap-ready",
            calls: ["wrap"],
            state: "swap-ready",
            resultBefore: "null",
            setup: () => enterPair(NATIVE_ETH, ETHEREUM_USDC, "1", "swap-ready"),
          },
          {
            label: "unwrap — wrap-ready",
            calls: ["unwrap"],
            state: "wrap-ready",
            resultBefore: "null",
            setup: () => enterWethPair("wrap", mainnet.id, "0.5"),
          },
          {
            label: "unwrap — enter-amount",
            calls: ["unwrap"],
            state: "enter-amount",
            resultBefore: "null",
            setup: () => enterWethPair("unwrap", mainnet.id, "", "enter-amount"),
          },
          {
            label: "unwrap — approve-required",
            calls: ["unwrap"],
            state: "approve-required",
            resultBefore: "null",
            allowance: allowanceAlways(0n),
            setup: () => enterPair(ETHEREUM_WETH, ETHEREUM_USDC, "0.5", "approve-required"),
          },
          {
            label: "wrap·unwrap — wrap 성공 뒤 enter-amount",
            calls: ["wrap", "unwrap"],
            state: "enter-amount",
            resultBefore: "wrap-success",
            setup: async (s) => {
              await enterWethPair("wrap", mainnet.id, "0.5");
              clickPrimary();
              await waitUntil(() => {
                const { execution } = s.probe();
                expect(execution.phase).toBe("idle");
                expect(execution.result).not.toBeNull();
              }, READY_TIMEOUT_MS);
              await waitUntil(() => {
                expect(amountInput().value).toBe("");
                expect(primaryState()).toBe("enter-amount");
              }, READY_TIMEOUT_MS);
            },
          },
          {
            label: "wrap — unwrap 4001 거부 뒤 unwrap-ready",
            calls: ["wrap"],
            state: "unwrap-ready",
            resultBefore: "unwrap-rejected",
            setup: async (s) => {
              await enterWethPair("unwrap", mainnet.id, "0.5");
              s.wallet.reply({ type: "error", code: USER_REJECTED_CODE });
              clickPrimary();
              await waitUntil(() => {
                const { execution } = s.probe();
                expect(execution.phase).toBe("idle");
                expect(execution.result).not.toBeNull();
              }, READY_TIMEOUT_MS);
              await waitUntil(() => expect(primaryState()).toBe("unwrap-ready"), READY_TIMEOUT_MS);
            },
          },
        ];

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const s = await renderConnectedApp({ allowance: sample.allowance });
          await sample.setup(s);
          await settlePendingWork();
          expect(primaryState(), label).toBe(sample.state);

          const resultBefore = s.probe().execution.result;
          // 전제: 호출 전 result
          if (sample.resultBefore === "null") expect(resultBefore, label).toBeNull();
          else if (sample.resultBefore === "wrap-success")
            expect(resultBefore, label).toMatchObject({ kind: "wrap", status: "success" });
          else expect(resultBefore, label).toEqual({ kind: "unwrap", status: "rejected" });
          const walletRequestsBefore = s.stub.requests.length;
          const sendsBefore = sendCount(s.stub);
          const sentBefore = s.wallet.sent.length;

          const tracked = callDirect(s, sample.calls);
          await waitUntil(() => {
            for (const call of tracked) expect(call.outcome).not.toBeNull();
          }, READY_TIMEOUT_MS);
          await settlePendingWork();

          for (const [callIndex, call] of tracked.entries()) {
            expect(call.outcome, `${label} ${sample.calls[callIndex]}`).toEqual({
              status: "resolved",
              value: undefined,
            });
          }
          expect(s.stub.requests, label).toHaveLength(walletRequestsBefore);
          expect(sendCount(s.stub), label).toBe(sendsBefore);
          expect(s.wallet.sent, label).toHaveLength(sentBefore);
          const resultAfter = s.probe().execution.result;
          expect(resultAfter, label).toEqual(resultBefore);
          if (resultBefore !== null) expect(resultAfter, label).not.toBeNull();
          // 전제: 호출 뒤에도 표본 상태 그대로다.
          expect(primaryState(), label).toBe(sample.state);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-7
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 프로브로 useSwapExecution()과 useSwapQuote()를 읽는다. 표본(진행 중인 실행 — 붙잡는 요청 — 진행 중 변경 — 호출 함수): wrap awaiting-signature — ETH → WETH `0.5`(wrap-ready)에서 주 버튼을 눌러 `eth_sendTransaction` 요청을 붙잡음 — 없음 — `wrap`과 `unwrap`, unwrap awaiting-signature — WETH → ETH `0.5`(unwrap-ready)에서 주 버튼을 눌러 `eth_sendTransaction` 요청을 붙잡음 — 없음 — `wrap`과 `unwrap`, wrapping — wrap-ready에서 주 버튼을 눌러 전송 요청은 해시로 응답하고 영수증 응답을 붙잡음 — 없음 — `wrap`과 `unwrap`, unwrapping — unwrap-ready에서 주 버튼을 눌러 전송 요청은 해시로 응답하고 영수증 응답을 붙잡음 — 없음 — `wrap`과 `unwrap`, swap awaiting-signature — 보내는 ETH·받는 USDC·금액 `1`(swap-ready)에서 주 버튼을 눌러 `eth_sendTransaction` 요청을 붙잡음 — 받는 토큰을 WETH로 바꿔 useSwapQuote().status가 `wrap`이 됨 — `wrap`, swapping — 보내는 ETH·받는 USDC·금액 `1`(swap-ready)에서 주 버튼을 눌러 전송 요청은 해시로 응답하고 swap 영수증 응답을 붙잡음 — 받는 토큰을 WETH로 바꿔 useSwapQuote().status가 `wrap`이 됨 — `wrap`, approving — 보내는 USDC·받는 ETH·금액 `1.5`·allowance 0(approve-required)에서 주 버튼을 눌러 전송 요청은 해시로 응답하고 approve 영수증 응답을 붙잡음 — 보내는 토큰을 WETH로 바꿔 useSwapQuote().status가 `wrap`이 됨 — `unwrap`을 하나씩 반복한다. 진행 중 상태가 되고 표본의 변경이 반영된 뒤(phase가 표본의 진행 phase 그대로이고, 변경 표본은 useSwapQuote().status가 `wrap`이다) 지갑 요청 수와 result를 기록한다
     * @when 진행 중에 표본의 호출 함수를 각각 인자 없이 직접 호출하고 대기 중인 작업을 진행시킨다
     * @then 표본의 호출이 돌려준 Promise가 모두 붙잡은 요청(전송 요청 또는 영수증)을 풀기 전에 reject 없이 `undefined`로 resolve한다
     * @then 지갑 요청 수가 기록한 수에서 늘지 않고, 전송 요청은 진행 중인 트랜잭션을 연 처음 클릭의 1건뿐이다(진행 중인 트랜잭션 외 전송 요청이 늘지 않는다)
     * @then useSwapExecution().result가 호출 전에 기록한 값 그대로다
     */
    it(
      "[EC-7] wrap·unwrap·approve·swap 진행 중에 wrap·unwrap을 호출하면 지갑 요청 없이 resolve하고 result를 바꾸지 않는다",
      async () => {
        type ProgressSample = {
          label: string;
          tokenIn: Address;
          tokenOut: Address;
          amount: string;
          ready: string;
          allowance: AllowanceFn;
          hold: "send" | "receipt";
          phase: "awaiting-signature" | "wrapping" | "unwrapping" | "swapping" | "approving";
          change?: () => Promise<void>;
          calls: readonly WethKind[];
        };
        const both: readonly WethKind[] = ["wrap", "unwrap"];
        const wrapPair = { tokenIn: NATIVE_ETH, tokenOut: ETHEREUM_WETH, amount: "0.5" };
        const unwrapPair = { tokenIn: ETHEREUM_WETH, tokenOut: NATIVE_ETH, amount: "0.5" };
        const ethUsdc = { tokenIn: NATIVE_ETH, tokenOut: ETHEREUM_USDC, amount: "1" };
        const samples: ProgressSample[] = [
          {
            label: "wrap awaiting-signature",
            ...wrapPair,
            ready: "wrap-ready",
            allowance: allowanceAlways(0n),
            hold: "send",
            phase: "awaiting-signature",
            calls: both,
          },
          {
            label: "unwrap awaiting-signature",
            ...unwrapPair,
            ready: "unwrap-ready",
            allowance: allowanceAlways(0n),
            hold: "send",
            phase: "awaiting-signature",
            calls: both,
          },
          {
            label: "wrapping",
            ...wrapPair,
            ready: "wrap-ready",
            allowance: allowanceAlways(0n),
            hold: "receipt",
            phase: "wrapping",
            calls: both,
          },
          {
            label: "unwrapping",
            ...unwrapPair,
            ready: "unwrap-ready",
            allowance: allowanceAlways(0n),
            hold: "receipt",
            phase: "unwrapping",
            calls: both,
          },
          {
            label: "swap awaiting-signature 중 받는 토큰 WETH",
            ...ethUsdc,
            ready: "swap-ready",
            allowance: allowanceAlways(STUB_MAX_UINT256),
            hold: "send",
            phase: "awaiting-signature",
            change: () => chooseToken("out", ETHEREUM_WETH),
            calls: ["wrap"],
          },
          {
            label: "swapping 중 받는 토큰 WETH",
            ...ethUsdc,
            ready: "swap-ready",
            allowance: allowanceAlways(STUB_MAX_UINT256),
            hold: "receipt",
            phase: "swapping",
            change: () => chooseToken("out", ETHEREUM_WETH),
            calls: ["wrap"],
          },
          {
            label: "approving 중 보내는 토큰 WETH",
            tokenIn: ETHEREUM_USDC,
            tokenOut: NATIVE_ETH,
            amount: "1.5",
            ready: "approve-required",
            allowance: allowanceAlways(0n),
            hold: "receipt",
            phase: "approving",
            change: () => chooseToken("in", ETHEREUM_WETH),
            calls: ["unwrap"],
          },
        ];

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const s = await renderConnectedApp({ allowance: sample.allowance });
          await enterPair(sample.tokenIn, sample.tokenOut, sample.amount, sample.ready);
          const sendGate = sample.hold === "send" ? s.wallet.hold() : null;
          const receiptGate = sample.hold === "receipt" ? rpc.holdReceipt() : null;

          clickPrimary();
          if (sendGate) {
            await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          } else {
            await waitUntil(
              () => expect(receiptGate!.heldCount).toBeGreaterThan(0),
              READY_TIMEOUT_MS,
            );
          }
          await waitUntil(
            () => expect(s.probe().execution.phase).toBe(sample.phase),
            READY_TIMEOUT_MS,
          );

          if (sample.change) {
            await sample.change();
            await waitUntil(() => expect(s.probe().quote.status).toBe("wrap"), READY_TIMEOUT_MS);
          }
          await settlePendingWork();
          // 전제: 진행 phase 그대로이고, 변경 표본은 견적 상태가 wrap이다.
          expect(s.probe().execution.phase, label).toBe(sample.phase);
          if (sample.change) expect(s.probe().quote.status, label).toBe("wrap");

          const walletRequestsBefore = s.stub.requests.length;
          const resultBefore = s.probe().execution.result;

          const tracked = callDirect(s, sample.calls);
          // 붙잡은 요청을 풀기 전에 모든 호출이 resolve한다.
          await waitUntil(() => {
            for (const call of tracked) expect(call.outcome).not.toBeNull();
          }, READY_TIMEOUT_MS);
          await settlePendingWork();

          for (const [callIndex, call] of tracked.entries()) {
            expect(call.outcome, `${label} ${sample.calls[callIndex]}`).toEqual({
              status: "resolved",
              value: undefined,
            });
          }
          expect(s.stub.requests, label).toHaveLength(walletRequestsBefore);
          expect(sendCount(s.stub), label).toBe(1);
          expect(s.wallet.sent, label).toHaveLength(1);
          expect(s.probe().execution.result, label).toEqual(resultBefore);
          expect(s.probe().execution.phase, label).toBe(sample.phase);

          sendGate?.release();
          receiptGate?.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-7
     * @given 스텁 EIP-1193으로 연결돼 있고 지갑 체인과 선택 체인이 같으며 `eth_sendTransaction` 응답을 붙잡는다. 클릭 직전 result(null)를 기록한다. 표본: wrap-ready(ETH → WETH `0.5`), unwrap-ready(WETH → ETH `0.5`)를 하나씩 반복한다
     * @when 리렌더가 일어나기 전에 주 버튼을 연달아 누르고 대기 중인 작업을 진행시킨다
     * @then 지갑이 받은 eth_sendTransaction 요청은 첫 클릭의 1건뿐이고, 두 번째 이후 클릭으로 늘어난 지갑 요청은 0건이다
     * @then 전송 응답을 붙잡은 동안 useSwapExecution().result가 클릭 직전에 기록한 값(null) 그대로다
     */
    it(
      "[EC-7] wrap-ready·unwrap-ready에서 리렌더 전에 연타해도 전송 요청은 한 번이고 result는 그대로다",
      async () => {
        for (const [index, kind] of WETH_KINDS.entries()) {
          // 대조: 한 번만 눌렀을 때 전송 요청이 붙잡힐 때까지 지갑이 받은 요청(메서드 순서)
          if (index > 0) resetSample();
          const control = await renderConnectedApp();
          await enterWethPair(kind, mainnet.id, "0.5");
          const controlGate = control.wallet.hold();
          const controlFrom = control.stub.requests.length;
          clickPrimary();
          await waitUntil(() => expect(controlGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          await settlePendingWork();
          const singleClickMethods = control.stub.requests
            .slice(controlFrom)
            .map((request) => request.method);
          controlGate.release();
          await waitUntil(
            () => expect(control.probe().execution.phase).toBe("idle"),
            READY_TIMEOUT_MS,
          );

          resetSample();
          const s = await renderConnectedApp();
          await enterWethPair(kind, mainnet.id, "0.5");
          const sendGate = s.wallet.hold();
          const resultBefore = s.probe().execution.result;
          expect(resultBefore, kind).toBeNull();
          const from = s.stub.requests.length;
          const button = primaryButton();
          let stateBetweenClicks: string | null = null;

          // 두 클릭을 한 act 안에서 보내 첫 클릭의 상태 변경이 화면에 반영(리렌더)되기 전에 두 번째 클릭이 처리되게 한다.
          act(() => {
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            stateBetweenClicks = button.getAttribute("data-state");
            button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          });
          expect(stateBetweenClicks, `${kind} 두 클릭 사이의 화면 상태`).toBe(READY_STATE[kind]);

          await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(requestsSince(s.stub, from, SEND_TRANSACTION_METHODS), kind).toHaveLength(1);
          expect(requestsSince(s.stub, from, CHAIN_SWITCH_METHODS), kind).toHaveLength(0);
          // 두 번째 클릭으로 늘어난 지갑 요청이 없다(한 번 누른 대조와 같은 요청).
          expect(
            s.stub.requests.slice(from).map((request) => request.method),
            `${kind} 연타 뒤 지갑 요청`,
          ).toEqual(singleClickMethods);
          expect(s.probe().execution.result, kind).toBeNull();
          expect(sendGate.heldCount, kind).toBe(1);

          sendGate.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
