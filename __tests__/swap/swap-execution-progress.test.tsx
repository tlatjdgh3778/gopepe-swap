import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disconnect, getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

import {
  type BalanceRpcStub,
  STUB_MAX_UINT256,
  allowanceAlways,
  defaultReceiptRule,
  installBalanceRpcStub,
  makeReceiptRule,
  match,
  matchAllowance,
  matchReceipt,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type ChainSwitchControl,
  SEND_TRANSACTION_METHODS,
  type StubEip1193,
  type WalletTransactionControl,
  createStubEip1193,
  installChainSwitch,
  installWalletTransactions,
  stubTransactionHash,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeClockInSteps,
  chooseChainFromDropdown,
  clearCookies,
  createButtonStateRecorder,
  createNoopWagmiStorage,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 주 버튼(primary-button)의 data-state·비활성 여부를 커밋마다 기록해 판정한다.
// useSwapExecution()의 phase·pendingTx는 앱 Provider 안의 프로브로 읽는다.
// 지갑은 스텁 EIP-1193을 쓴다(체인 전환 요청과 eth_sendTransaction 기록·해시 응답·응답 붙잡기, 계정 변경, 연결 해제).
// RPC는 전역 fetch URL 라우팅 스텁이 응답한다(견적 aggregate3, 잔액, allowance eth_call, 영수증 계열의 성공·미발견·붙잡기).
// 기본 allowance 규칙의 값은 0이다(approve-required 표본). swap-ready 표본은 allowance를 amountInRaw 이상으로 둔다.
// 선택 체인 변경은 화면의 체인 선택 드롭다운을 실제로 조작한다(프로브로 선택 체인을 바꾸지 않는다). `vi.mock`은 쓰지 않는다.
// 시간은 가짜 타이머로 다룬다(EC-18).
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.
// 표본 페어는 ERC-20↔ERC-20 페어이고, 기대 주소·해시·체인 ID는 제품 config를 쓰지 않고 리터럴로 적는다.

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;
// viem 영수증 폴링 간격(wagmi 기본 4초)을 실제 시간으로 기다리는 대기의 한도
const RECEIPT_POLL_TIMEOUT_MS = 20_000;

// Ethereum 공식 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// 보내는 USDC(decimals 6) 금액 1 → amountInRaw 1_000_000
const AMOUNT = "1";
const ETHEREUM_CHAIN_ID = 1;

// 스펙 EC-18: 영수증 대기 라이브러리의 기본 시간 제한과 무관하게 충분히 긴 시간(30분 이상)
const LONG_WAIT_MS = 31 * 60_000;
// 가짜 시계 단계. viem http 요청 제한 시간(10초)과 영수증 폴링 간격(4초)보다 짧다.
const LONG_WAIT_STEP_MS = 3_000;
// EC-5 reject 유도 대기의 가짜 시계 단계(viem 재시도 지연 200ms부터)
const RETRY_STEP_MS = 250;

type TxKind = "approve" | "swap";
const TX_KINDS: readonly TxKind[] = ["approve", "swap"];
const READY_STATE = { approve: "approve-required", swap: "swap-ready" } as const;
const PROGRESS = { approve: "approving", swap: "swapping" } as const;

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

function tokenAddress(side: Side): string | null {
  return within(field(side)).getByTestId("token-button").getAttribute("data-token-address");
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

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution(), allowance: useTokenAllowance() };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  chainSwitch: ChainSwitchControl;
  config: ReturnType<typeof createWagmiConfig>;
  recorder: ReturnType<typeof createButtonStateRecorder>;
  probe: () => Probe;
};

// 스텁 EIP-1193 지갑(`walletChainId`)으로 연결되고 선택 체인이 Ethereum인 앱에서 보내는 USDC, 받는 DAI, 금액 1을 입력해
// 주 버튼이 표본의 준비 상태(approve-required·swap-ready)가 될 때까지 기다린다.
// 견적은 가격 영향 normal·최소 수령량 > 0 규칙, allowance는 approve 표본이 기본 규칙(0), swap 표본이 maxUint256이다.
async function renderReadyApp(
  kind: TxKind,
  { walletChainId = mainnet.id }: { walletChainId?: SupportedChainId } = {},
): Promise<Scenario> {
  rpc.setQuoteRule(parityQuoteRule);
  if (kind === "swap") rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
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
    initialChainId: mainnet.id,
    onCommit: recorder.onCommit,
  });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(walletChainId);
  }, READY_TIMEOUT_MS);
  await chooseToken("in", ETHEREUM_USDC);
  await chooseToken("out", ETHEREUM_DAI);
  await typeAmount(AMOUNT);
  await waitUntil(() => expect(primaryState()).toBe(READY_STATE[kind]), READY_TIMEOUT_MS);
  await settlePendingWork();
  expect(primaryButton().disabled).toBe(false);
  return { stub, wallet, chainSwitch, config, recorder, probe: () => view.result.current };
}

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 잔액 주기 타이머(setInterval)와 시계만 가짜로 둔다. 주기 다시 읽기가 일어나지 않는다.
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

// 클릭 직전에 setTimeout까지 가짜로 바꾼다(viem 폴링·재시도 지연, 영수증 대기 시간 제한이 가짜 시계를 따른다).
function fakeAllTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

function expectAllProgress(
  snapshots: readonly { state: string | null; disabled: boolean }[],
  expected: string,
  label: string,
) {
  for (const [index, snapshot] of snapshots.entries()) {
    expect(snapshot.state, `${label} #${index}`).toBe(expected);
    expect(snapshot.disabled, `${label} #${index}`).toBe(true);
  }
}

function receiptCalls() {
  return rpc.requests(matchReceipt.method("eth_getTransactionReceipt"));
}

const CARD_READS = match.kind("eth_getBalance", "balanceOf", "aggregate3");

describe("approve·swap 진행 — 선택 체인으로 보내고 영수증이 나올 때까지 진행 상태를 지킨다", () => {
  describe("전송 전 체인 확인", () => {
    /**
     * @spec DoD-21
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 요청에 성공으로 응답한다. 표본: approve-required(allowance 0), swap-ready(allowance가 amountInRaw 이상)를 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then 지갑이 받은 체인 전환 요청이 eth_sendTransaction 요청보다 앞선다
     * @then 트랜잭션은 선택 체인으로 보내진다(전송 요청 시점에 지갑 체인이 클릭 시점 선택 체인이다)
     */
    it(
      "[DoD-21] approve와 swap 모두 체인을 확인한 뒤 선택 체인으로 트랜잭션을 보낸다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          // 지갑은 Base, 선택 체인은 Ethereum이다. 체인 전환 요청은 기본 동작(지갑 체인을 바꾸고 성공)으로 응답한다.
          const s = await renderReadyApp(kind, { walletChainId: base.id });
          const from = s.stub.requests.length;

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);

          const requests = s.stub.requests.slice(from);
          const switchIndex = requests.findIndex(
            (request) => request.method === "wallet_switchEthereumChain",
          );
          const sendIndex = requests.findIndex(
            (request) => request.method === "eth_sendTransaction",
          );
          expect(switchIndex, kind).toBeGreaterThanOrEqual(0);
          expect((requests[switchIndex]!.params as [{ chainId: string }])[0].chainId, kind).toBe(
            "0x1",
          );
          expect(sendIndex, kind).toBeGreaterThan(switchIndex);
          // 전송 요청을 받은 시점의 지갑 체인이 클릭 시점 선택 체인(Ethereum)이다.
          expect(s.wallet.sent[0]!.walletChainId, kind).toBe(ETHEREUM_CHAIN_ID);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-21 EC-15
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 응답을 붙잡는다. 클릭 직전에 allowance 읽기 요청 수를 기록한다. 표본: approve-required, swap-ready를 하나씩 반복한다
     * @when 주 버튼을 누르고, 체인 전환 응답을 기다리는 awaiting-signature 중에 체인 선택 드롭다운으로 선택 체인을 클릭 시점과 다른 체인으로 바꾼 뒤, 붙잡은 체인 전환 응답을 성공으로 푼다
     * @then 지갑이 eth_sendTransaction 요청을 받지 않는다
     * @then phase가 idle로 돌아간다
     * @then allowance 읽기 요청 수가 클릭 직전 기록에서 늘지 않는다
     */
    it(
      "[EC-21][EC-15] 체인 확인 뒤 선택 체인이 클릭 시점 체인과 다르면 트랜잭션을 보내지 않고 idle로 돌아간다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind, { walletChainId: base.id });
          const switchGate = s.chainSwitch.hold();
          const from = s.stub.requests.length;
          const allowanceBefore = rpc.requests(matchAllowance.any).length;

          clickPrimary();
          await waitUntil(() => expect(switchGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          expect(s.probe().execution.phase, kind).toBe("awaiting-signature");

          await chooseChainFromDropdown(arbitrum);
          expect(s.probe().execution.phase, kind).toBe("awaiting-signature");
          switchGate.release();

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();
          // 전제: 붙잡았던 전환 요청은 클릭 시점 체인(Ethereum)으로의 전환 성공으로 끝났다.
          expect(s.stub.chainId, kind).toBe(ETHEREUM_CHAIN_ID);
          expect(requestsSince(s.stub, from, SEND_TRANSACTION_METHODS), kind).toEqual([]);
          expect(s.probe().execution.phase, kind).toBe("idle");
          expect(rpc.requests(matchAllowance.any), kind).toHaveLength(allowanceBefore);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("서명 대기와 영수증 대기", () => {
    /**
     * @spec DoD-22
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 응답과 eth_sendTransaction 응답을 붙잡는다. 표본: approve-required, swap-ready를 하나씩 반복한다
     * @when 주 버튼을 누르고, 체인 전환 응답을 붙잡은 동안과 그 응답을 풀고 eth_sendTransaction 응답을 붙잡은 동안 주 버튼 상태를 커밋마다 기록한다
     * @then 클릭 직후 첫 커밋부터 주 버튼은 awaiting-signature이고 비활성이다
     * @then 체인 전환 응답을 기다리는 동안 기록된 주 버튼 상태는 모두 awaiting-signature이고 비활성이다
     * @then eth_sendTransaction 응답을 기다리는 동안 기록된 주 버튼 상태는 모두 awaiting-signature이고 비활성이다
     */
    it(
      "[DoD-22] 주 버튼을 누른 즉시부터 지갑 서명이 끝날 때까지 awaiting-signature이고 비활성이다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind, { walletChainId: base.id });
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
          expectAllProgress(
            recorded().slice(mark),
            "awaiting-signature",
            `${kind} 체인 전환 응답 대기`,
          );

          switchGate.release();
          await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          await settlePendingWork();
          // 전제: 체인 전환이 끝난 뒤 서명 요청을 받았다.
          expect(s.stub.chainId, kind).toBe(ETHEREUM_CHAIN_ID);
          expectAllProgress(recorded().slice(mark), "awaiting-signature", `${kind} 서명 응답 대기`);

          sendGate.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-23 DoD-24 DoD-25
     * @given 스텁 지갑이 eth_sendTransaction에 해시로 응답하고 영수증 응답을 붙잡는다. 표본: approve(approve-required에서 클릭, 진행 상태 approving), swap(swap-ready에서 클릭, 진행 상태 swapping)을 하나씩 반복한다
     * @when 주 버튼을 눌러 트랜잭션 해시를 받는다
     * @then 해시를 받은 뒤 영수증이 나올 때까지 기록된 주 버튼 상태는 모두 표본의 진행 상태(approve는 approving, swap은 swapping)이고 비활성이다
     * @then 그동안 useSwapExecution().pendingTx는 { kind, chainId, hash }이다
     * @then kind는 표본의 종류(approve는 "approve", swap은 "swap")이다
     * @then chainId는 트랜잭션을 보낸 선택 체인이다
     * @then hash는 지갑이 돌려준 해시다
     */
    it(
      "[DoD-23][DoD-24][DoD-25] 해시를 받은 뒤 영수증이 나올 때까지 approving·swapping이고 비활성이며 pendingTx는 { kind, chainId, hash }이다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
          const receiptGate = rpc.holdReceipt();
          const recorded = () => s.recorder.snapshots("primary-button");
          const mark = recorded().length;
          const expectedPending = {
            kind,
            chainId: ETHEREUM_CHAIN_ID,
            hash: stubTransactionHash(1),
          };

          clickPrimary();
          await waitUntil(
            () => expect(s.wallet.hashes()).toEqual([stubTransactionHash(1)]),
            READY_TIMEOUT_MS,
          );
          await waitUntil(
            () => expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
            READY_TIMEOUT_MS,
          );
          expect(s.probe().execution.pendingTx, `${kind} 해시 직후`).toEqual(expectedPending);

          await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
          await settlePendingWork();
          expect(s.probe().execution.pendingTx, `${kind} 영수증 대기 중`).toEqual(expectedPending);

          const snapshots = recorded().slice(mark);
          const progressStart = snapshots.findIndex(
            (snapshot) => snapshot.state === PROGRESS[kind],
          );
          expect(progressStart, kind).toBeGreaterThanOrEqual(0);
          expectAllProgress(snapshots.slice(progressStart), PROGRESS[kind], `${kind} 영수증 대기`);

          receiptGate.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-30 DoD-25
     * @given 영수증이 성공으로 나오고, 영수증 뒤의 allowance 다시 읽기 응답을 붙잡는다. 표본: approve(approving), swap(swapping)을 하나씩 반복한다
     * @when 주 버튼을 눌러 트랜잭션을 보내고 영수증 성공을 받는다
     * @then allowance 다시 읽기 응답을 붙잡은 동안 phase는 표본의 진행 phase(approve는 approving, swap은 swapping)를 유지한다
     * @then allowance 다시 읽기 응답을 붙잡은 동안 useSwapExecution().pendingTx는 영수증 전과 같은 { kind, chainId, hash } 그대로다
     * @then 붙잡은 allowance 다시 읽기 응답을 풀어 읽기가 끝나면 phase가 idle로 돌아간다
     */
    it(
      "[DoD-30][DoD-25] 영수증이 성공이면 allowance 다시 읽기가 끝날 때까지 approving·swapping을 유지한다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
          const allowanceGate = rpc.holdAllowance();
          const seq = rpc.requests().length;
          const expectedPending = {
            kind,
            chainId: ETHEREUM_CHAIN_ID,
            hash: stubTransactionHash(1),
          };

          clickPrimary();
          await waitUntil(
            () => expect(s.probe().execution.pendingTx).toEqual(expectedPending),
            READY_TIMEOUT_MS,
          );
          // 영수증 성공 응답을 받았고, 그 뒤의 allowance 다시 읽기가 붙잡혔다.
          await waitUntil(
            () =>
              expect(
                rpc
                  .requests(match.since(seq, matchReceipt.method("eth_getTransactionReceipt")))
                  .some((request) => request.status === "ok"),
              ).toBe(true),
            READY_TIMEOUT_MS,
          );
          await waitUntil(
            () => expect(allowanceGate.heldCount).toBeGreaterThan(0),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(
            rpc.requests(match.since(seq, matchAllowance.any)).map((request) => request.status),
            kind,
          ).not.toContain("ok");
          expect(s.probe().execution.phase, kind).toBe(PROGRESS[kind]);
          expect(s.probe().execution.pendingTx, kind).toEqual(expectedPending);

          allowanceGate.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          expect(
            rpc
              .requests(match.since(seq, matchAllowance.any))
              .every((request) => request.status === "ok"),
            kind,
          ).toBe(true);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-18
     * @given 스텁 지갑이 eth_sendTransaction에 해시로 응답하고, 영수증 조회는 계속 미발견이며 트랜잭션 조회(eth_getTransactionByHash)는 트랜잭션을 돌려준다. 표본: approve(approving), swap(swapping)을 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받은 뒤 가짜 타이머로 30분 이상 진행한다(영수증 대기 라이브러리의 기본 시간 제한 값과 무관하게 충분히 긴 시간)
     * @then 진행하는 동안 phase는 표본의 진행 phase(approving·swapping)를 유지하고 idle로 돌아가지 않는다
     * @then 진행하는 동안 주 버튼은 표본의 진행 상태(approving·swapping)이고 비활성이다
     */
    it(
      "[EC-18] 영수증이 오래 나오지 않아도 시간 제한으로 실패 처리하지 않고 approving·swapping을 유지한다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
          // 영수증은 계속 미발견, 트랜잭션 조회는 대기 중인 트랜잭션을 돌려준다.
          rpc.setReceiptRule(makeReceiptRule("not-found", "pending"));
          fakeAllTimers();

          clickPrimary();
          await waitUntilAdvancingFakeClock(() =>
            expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
          );
          await waitUntilAdvancingFakeClock(() => expect(receiptCalls().length).toBeGreaterThan(0));

          const startedAt = Date.now();
          const violations: string[] = [];
          await advanceFakeClockInSteps(LONG_WAIT_MS, LONG_WAIT_STEP_MS, (elapsedMs) => {
            const phase = s.probe().execution.phase;
            const button = primaryButton();
            const state = button.getAttribute("data-state");
            if (phase !== PROGRESS[kind] || state !== PROGRESS[kind] || !button.disabled) {
              violations.push(
                `${elapsedMs}ms: phase=${phase} state=${state} disabled=${button.disabled}`,
              );
            }
          });

          expect(violations, kind).toEqual([]);
          expect(Date.now() - startedAt, kind).toBeGreaterThanOrEqual(LONG_WAIT_MS);
          // 전제: 그동안 영수증 대기가 멈추지 않고 영수증을 계속 조회했고, 모두 미발견 응답이었다.
          expect(receiptCalls().length, kind).toBeGreaterThan(10);
          expect(
            receiptCalls().every((request) => request.status === "ok"),
            kind,
          ).toBe(true);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("진행 중 트랜잭션 정보", () => {
    /**
     * @spec DoD-25
     * @given ERC-20 페어로 approve-required 또는 swap-ready인 상태다. 표본 phase: 클릭 전 idle, eth_sendTransaction 응답을 붙잡은 awaiting-signature, 영수증 성공 뒤 allowance 다시 읽기가 끝나 돌아간 idle, revert 영수증 뒤 돌아간 idle, 영수증 대기 reject(영수증 미발견과 eth_getTransactionByHash 지속 실패로 viem 재시도 소진, 가짜 타이머) 뒤 돌아간 idle을 approve·swap 각각에서 하나씩 반복하고, approving 중 계정 변경 뒤 돌아간 idle을 더한다
     * @when 표본 phase에서 useSwapExecution()을 읽는다
     * @then pendingTx는 null이다
     */
    it(
      "[DoD-25] approving·swapping이 아닌 phase에서 pendingTx는 null이다",
      async () => {
        let sampleCount = 0;
        const nextSample = () => {
          if (sampleCount > 0) resetSample();
          sampleCount += 1;
        };

        for (const kind of TX_KINDS) {
          // 클릭 전 idle → 서명 응답을 붙잡은 awaiting-signature → 영수증 성공 뒤 allowance 다시 읽기가 끝나 돌아간 idle
          nextSample();
          {
            const s = await renderReadyApp(kind);
            expect(s.probe().execution.phase, `${kind} 클릭 전`).toBe("idle");
            expect(s.probe().execution.pendingTx, `${kind} 클릭 전 idle`).toBeNull();

            const sendGate = s.wallet.hold();
            clickPrimary();
            await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
            await settlePendingWork();
            expect(s.probe().execution.phase, kind).toBe("awaiting-signature");
            expect(s.probe().execution.pendingTx, `${kind} awaiting-signature`).toBeNull();

            sendGate.release();
            await waitUntil(
              () => expect(receiptCalls().some((request) => request.status === "ok")).toBe(true),
              READY_TIMEOUT_MS,
            );
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
            expect(
              rpc.requests(matchAllowance.any).some((request) => request.status === "pending"),
              kind,
            ).toBe(false);
            expect(s.probe().execution.pendingTx, `${kind} 영수증 성공 뒤 idle`).toBeNull();
          }

          // revert 영수증 뒤 돌아간 idle
          nextSample();
          {
            const s = await renderReadyApp(kind);
            rpc.setReceiptRule(makeReceiptRule("reverted"));
            clickPrimary();
            await waitUntil(
              () => expect(receiptCalls().some((request) => request.status === "ok")).toBe(true),
              READY_TIMEOUT_MS,
            );
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
            expect(s.probe().execution.pendingTx, `${kind} revert 뒤 idle`).toBeNull();
          }

          // 영수증 대기 reject(영수증 미발견 + eth_getTransactionByHash 지속 실패로 viem 재시도 소진) 뒤 돌아간 idle
          nextSample();
          {
            const s = await renderReadyApp(kind);
            rpc.setReceiptRule(makeReceiptRule("not-found"));
            rpc.failReceiptWhen(matchReceipt.method("eth_getTransactionByHash"));
            fakeAllTimers();
            clickPrimary();
            await waitUntilAdvancingFakeClock(() =>
              expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
            );
            await waitUntilAdvancingFakeClock(
              () => expect(s.probe().execution.phase).toBe("idle"),
              RETRY_STEP_MS,
              30_000,
            );
            // 전제: 트랜잭션 조회가 재시도 끝에 모두 실패했다.
            expect(
              rpc
                .requests(matchReceipt.method("eth_getTransactionByHash"))
                .filter((request) => request.status === "failed").length,
              kind,
            ).toBeGreaterThan(1);
            expect(s.probe().execution.pendingTx, `${kind} 영수증 대기 reject 뒤 idle`).toBeNull();
          }
        }

        // approving 중 계정 변경 뒤 돌아간 idle
        nextSample();
        {
          const s = await renderReadyApp("approve");
          const receiptGate = rpc.holdReceipt();
          clickPrimary();
          await waitUntil(
            () => expect(s.probe().execution.phase).toBe("approving"),
            READY_TIMEOUT_MS,
          );
          await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
          act(() => s.stub.changeAccounts([SECOND_ACCOUNT]));
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          expect(s.probe().execution.pendingTx, "approving 중 계정 변경 뒤 idle").toBeNull();
          receiptGate.release();
          await settlePendingWork();
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("중복 클릭과 진행 중 변경", () => {
    /**
     * @spec EC-6
     * @given 스텁 지갑이 선택 체인에 연결돼 있다. 표본: approve-required, swap-ready를 하나씩 반복한다
     * @when 리렌더가 일어나기 전에 주 버튼을 연달아 누른다
     * @then 지갑이 받은 eth_sendTransaction 요청은 한 번이다
     */
    it(
      "[EC-6] 주 버튼을 연달아 눌러도 트랜잭션 전송 요청은 한 번이다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
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

          await waitUntil(() => expect(s.wallet.sent.length).toBeGreaterThan(0), READY_TIMEOUT_MS);
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();
          expect(requestsSince(s.stub, from, SEND_TRANSACTION_METHODS), kind).toHaveLength(1);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-7
     * @given 해시를 받은 뒤 영수증 응답을 붙잡아 진행 중이다. 표본: 진행 phase(approving, swapping) × 변경(보내는 칸 금액 변경, 보내는 토큰 변경, 받는 토큰 변경)을 하나씩 반복한다
     * @when 진행 중에 표본의 변경을 하고, 그 뒤 붙잡은 영수증 응답을 푼다
     * @then 변경 뒤 영수증이 나올 때까지 기록된 주 버튼 상태는 모두 표본의 진행 상태(approving·swapping)이고 비활성이다
     */
    it(
      "[EC-7] approving·swapping 중에 금액이나 토큰을 바꿔도 영수증이 나올 때까지 주 버튼 상태가 유지된다",
      async () => {
        const changes = ["보내는 칸 금액", "보내는 토큰", "받는 토큰"] as const;
        let sampleCount = 0;
        for (const kind of TX_KINDS) {
          for (const change of changes) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${PROGRESS[kind]} — ${change}`;
            const s = await renderReadyApp(kind);
            const receiptGate = rpc.holdReceipt();
            const recorded = () => s.recorder.snapshots("primary-button");

            clickPrimary();
            await waitUntil(
              () => expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
              READY_TIMEOUT_MS,
            );
            await waitUntil(
              () => expect(receiptGate.heldCount).toBeGreaterThan(0),
              READY_TIMEOUT_MS,
            );
            // 변경 직전 상태(마지막 기록)부터 본다.
            const mark = recorded().length - 1;

            if (change === "보내는 칸 금액") {
              await typeAmount("2");
            } else if (change === "보내는 토큰") {
              await chooseToken("in", ETHEREUM_WETH);
              expect(sameAddress(tokenAddress("in") ?? undefined, ETHEREUM_WETH), label).toBe(true);
            } else {
              await chooseToken("out", ETHEREUM_USDT);
              expect(sameAddress(tokenAddress("out") ?? undefined, ETHEREUM_USDT), label).toBe(
                true,
              );
            }
            await settlePendingWork();

            expectAllProgress(recorded().slice(mark), PROGRESS[kind], label);
            const releaseMark = recorded().length;

            receiptGate.release();
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
            expectAllProgress(recorded().slice(mark, releaseMark), PROGRESS[kind], label);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-8 DoD-25
     * @given 트랜잭션 체인에서 해시를 받은 뒤 영수증 응답을 붙잡아 진행 중이다. 표본: approving, swapping을 하나씩 반복한다
     * @when 진행 중에 체인 선택 드롭다운으로 선택 체인을 트랜잭션 체인과 다른 체인으로 바꾸고, 그 뒤 붙잡은 영수증 응답을 푼다
     * @then 체인을 바꾼 뒤의 영수증 조회 요청은 트랜잭션 체인의 RPC 프록시 경로로만 가고, 바꾼 선택 체인의 경로로는 0건이다
     * @then 체인을 바꾼 뒤 영수증이 나올 때까지 기록된 주 버튼 상태는 모두 표본의 진행 상태(approving·swapping)이고 비활성이다
     * @then 체인을 바꾼 뒤에도 영수증이 나올 때까지 useSwapExecution().pendingTx.chainId는 트랜잭션 체인이고 hash는 지갑이 돌려준 해시 그대로다
     */
    it(
      "[EC-8][DoD-25] approving·swapping 중에 선택 체인을 바꿔도 트랜잭션 체인에서 영수증을 기다리고 주 버튼 상태가 유지된다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
          const hash = stubTransactionHash(1);
          // 체인을 바꾸는 동안 영수증 대기가 계속 폴링하도록 영수증을 미발견으로 둔다.
          rpc.setReceiptRule(makeReceiptRule("not-found"));
          const recorded = () => s.recorder.snapshots("primary-button");

          clickPrimary();
          await waitUntil(
            () => expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
            READY_TIMEOUT_MS,
          );
          await waitUntil(
            () =>
              expect(
                rpc.requests(
                  match.chain(mainnet.id, matchReceipt.method("eth_getTransactionReceipt")),
                ).length,
              ).toBeGreaterThan(0),
            READY_TIMEOUT_MS,
          );
          const mark = recorded().length - 1;

          await chooseChainFromDropdown(base);
          const seq = rpc.requests().length;
          await settlePendingWork();
          expect(s.probe().execution.phase, kind).toBe(PROGRESS[kind]);

          // 영수증을 성공으로 바꾸고, 영수증이 나올 때까지 진행 중 트랜잭션 정보를 확인한다.
          rpc.setReceiptRule(defaultReceiptRule);
          const violations: string[] = [];
          await waitUntil(() => {
            const { phase, pendingTx } = s.probe().execution;
            if (phase === "idle") return;
            if (pendingTx?.chainId !== ETHEREUM_CHAIN_ID || pendingTx.hash !== hash) {
              violations.push(`phase=${phase} pendingTx=${JSON.stringify(pendingTx)}`);
            }
            throw new Error("영수증 대기 중");
          }, RECEIPT_POLL_TIMEOUT_MS);
          expect(violations, kind).toEqual([]);

          expect(
            rpc
              .requests(
                match.since(
                  seq,
                  match.chain(mainnet.id, matchReceipt.method("eth_getTransactionReceipt")),
                ),
              )
              .some((request) => request.status === "ok"),
            kind,
          ).toBe(true);
          expect(
            rpc.requests(match.since(seq, match.chain(base.id, matchReceipt.any))),
            kind,
          ).toEqual([]);
          expect(
            rpc.requests(match.since(seq, match.chain(arbitrum.id, matchReceipt.any))),
            kind,
          ).toEqual([]);

          const snapshots = recorded().slice(mark);
          const end = snapshots.findIndex((snapshot) => snapshot.state !== PROGRESS[kind]);
          expect(end, kind).toBeGreaterThan(0);
          expectAllProgress(snapshots.slice(0, end), PROGRESS[kind], kind);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-9
     * @given 트랜잭션 체인에서 swap 해시를 받은 뒤 영수증 응답을 붙잡아 swapping 중이고, 그동안 체인 선택 드롭다운으로 선택 체인을 트랜잭션 체인과 다른 체인으로 바꾼 뒤 그 체인에서 보내는 칸 금액을 다시 입력했다
     * @when 붙잡은 영수증 응답을 성공으로 푼다
     * @then 보내는 칸 금액이 다시 입력한 값 그대로이고 빈 값이 되지 않는다
     */
    it(
      "[EC-9] 스왑 영수증 성공 시점에 선택 체인이 트랜잭션 체인과 다르면 보내는 칸 금액을 비우지 않는다",
      async () => {
        const s = await renderReadyApp("swap");
        const receiptGate = rpc.holdReceipt();

        clickPrimary();
        await waitUntil(() => expect(s.probe().execution.phase).toBe("swapping"), READY_TIMEOUT_MS);
        await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);

        await chooseChainFromDropdown(base);
        await typeAmount("2");
        await settlePendingWork();
        expect(s.probe().execution.phase).toBe("swapping");

        receiptGate.release();
        await waitUntil(
          () => expect(receiptCalls().some((request) => request.status === "ok")).toBe(true),
          READY_TIMEOUT_MS,
        );
        await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        await settlePendingWork();

        expect(screen.getByTestId("chain-select").getAttribute("data-selected-chain-id")).toBe(
          String(base.id),
        );
        expect(amountInput().value).toBe("2");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-10
     * @given 진행 중이다. 표본: 진행 phase(swap 클릭 뒤 eth_sendTransaction 응답을 붙잡은 awaiting-signature, 영수증 응답을 붙잡은 approving, 영수증 응답을 붙잡은 swapping) × 변경(지갑 연결 해제, 계정 변경)을 하나씩 반복한다
     * @when 진행 중에 표본의 변경을 하고, 변경으로 생긴 새 키의 읽기가 끝나기를 기다린 뒤 모든 키(계정·체인·토큰)의 잔액·allowance 요청 수를 기록하고, 붙잡은 응답을 풀어 해시와 성공 영수증이 나오게 한다
     * @then 변경 뒤 phase가 idle로 돌아가고, 응답을 푼 뒤에도 idle이다
     * @then 그 트랜잭션의 영수증 후처리로 보내는 칸 금액을 비우지 않는다
     * @then 응답을 푼 뒤 다음 잔액 15초 주기가 오기 전까지 어느 키(이전 계정·새 계정 포함)의 잔액·allowance 요청 수도 기록한 값에서 늘지 않는다
     * @then 연결 해제 표본은 응답을 푼 뒤 다음 잔액 15초 주기가 오기 전까지 잔액·allowance 요청이 0건이다
     */
    it(
      "[EC-10] 진행 중에 연결이 해제되거나 계정이 바뀌면 idle로 돌아가고 그 트랜잭션의 영수증 후처리를 하지 않는다",
      async () => {
        const phases = ["awaiting-signature", "approving", "swapping"] as const;
        const changes = ["연결 해제", "계정 변경"] as const;
        const isRead = (request: Parameters<typeof CARD_READS>[0]) =>
          CARD_READS(request) || matchAllowance.any(request);
        let sampleCount = 0;

        for (const phaseSample of phases) {
          for (const change of changes) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${phaseSample} — ${change}`;
            // 잔액 주기 다시 읽기가 일어나지 않게 주기 타이머를 가짜로 둔다.
            fakePeriodicTimers();
            const kind: TxKind = phaseSample === "approving" ? "approve" : "swap";
            const s = await renderReadyApp(kind);
            const sendGate = phaseSample === "awaiting-signature" ? s.wallet.hold() : null;
            const receiptGate = phaseSample === "awaiting-signature" ? null : rpc.holdReceipt();

            clickPrimary();
            await waitUntil(
              () => expect(s.probe().execution.phase).toBe(phaseSample),
              READY_TIMEOUT_MS,
            );
            if (sendGate) {
              await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
            } else {
              await waitUntil(
                () => expect(receiptGate!.heldCount).toBeGreaterThan(0),
                READY_TIMEOUT_MS,
              );
            }

            if (change === "계정 변경") {
              act(() => s.stub.changeAccounts([SECOND_ACCOUNT]));
            } else {
              await act(async () => {
                await disconnect(s.config);
              });
            }
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);

            // 변경으로 생긴 새 키의 읽기가 끝나기를 기다린다.
            if (change === "계정 변경") {
              await waitUntil(() => {
                expect(s.probe().allowance.status).toBe("success");
                expect(
                  rpc
                    .requests(matchAllowance.query({ owner: SECOND_ACCOUNT }))
                    .some((request) => request.status === "ok"),
                ).toBe(true);
                for (const token of [ETHEREUM_USDC, ETHEREUM_DAI]) {
                  expect(
                    rpc
                      .requests(match.account(SECOND_ACCOUNT, match.balanceOfToken(token)))
                      .some((request) => request.status === "ok"),
                  ).toBe(true);
                }
              }, READY_TIMEOUT_MS);
            } else {
              await waitUntil(() => expect(primaryState()).toBe("disconnected"), READY_TIMEOUT_MS);
            }
            await waitUntil(
              () =>
                expect(
                  rpc.requests((request) => isRead(request) && request.status === "pending"),
                ).toEqual([]),
              READY_TIMEOUT_MS,
            );
            await settlePendingWork();

            const readsBefore = rpc.requests(isRead).length;
            const releaseSeq = rpc.requests().length;
            expect(amountInput().value, label).toBe(AMOUNT);

            // 붙잡은 응답을 풀어 해시와 성공 영수증이 나오게 한다.
            if (sendGate) {
              sendGate.release();
              await waitUntil(() => expect(s.wallet.hashes()).toHaveLength(1), READY_TIMEOUT_MS);
            } else {
              receiptGate!.release();
              await waitUntil(
                () => expect(receiptCalls().some((request) => request.status === "ok")).toBe(true),
                READY_TIMEOUT_MS,
              );
            }
            await settlePendingWork(10);

            expect(s.probe().execution.phase, label).toBe("idle");
            expect(amountInput().value, label).toBe(AMOUNT);
            expect(rpc.requests(isRead), label).toHaveLength(readsBefore);
            if (change === "연결 해제") {
              expect(rpc.requests(match.since(releaseSeq, isRead)), label).toEqual([]);
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
