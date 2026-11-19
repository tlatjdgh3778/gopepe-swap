import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, disconnect, getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";

import {
  type BalanceRpcStub,
  STUB_MAX_UINT256,
  allowanceAlways,
  installBalanceRpcStub,
  makeReceiptRule,
  matchReceipt,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type ChainSwitchControl,
  type StubEip1193,
  USER_REJECTED_CODE,
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
  createNoopWagmiStorage,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 tx-status 요소의 data-status·data-kind와 tx-link·tx-status-dismiss·tx-balance-notice의 유무로 판정한다.
// useSwapExecution()의 phase·pendingTx·result는 앱 Provider 안의 프로브로 읽는다.
// mock 경계(F5 T-10 경계 그대로): 스텁 EIP-1193 지갑(체인 전환·eth_sendTransaction 기록·해시 응답·붙잡기, 계정 변경, 연결 해제),
// 전역 fetch URL 라우팅 RPC 스텁(견적·잔액·allowance·영수증의 성공·미발견·붙잡기), 가짜 타이머. `vi.mock`은 쓰지 않는다.
// 선택 체인 변경은 화면의 체인 선택 드롭다운을 실제로 조작한다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다.
// 기대 href·해시·체인 ID는 제품 config를 쓰지 않고 리터럴로 적는다.
// "동안"의 판정은 커밋마다 기록한 화면(주 버튼 data-state와 메시지 영역)으로 한다. 주 버튼 data-state가 진행 phase와 같은 커밋이 그 phase 동안의 커밋이다.

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;

// 스펙 EC-14: F5 EC-18 표본 길이(영수증 대기 라이브러리의 기본 시간 제한 값과 무관하게 충분히 긴 시간, 30분 이상)
const LONG_WAIT_MS = 31 * 60_000;
// 가짜 시계 단계. viem http 요청 제한 시간(10초)과 영수증 폴링 간격(4초)보다 짧다.
const LONG_WAIT_STEP_MS = 3_000;

const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// 체인별 표본 페어(공식 주소 리터럴): 보내는 USDC(decimals 6), 받는 DAI
const PAIRS: Record<SupportedChainId, { tokenIn: Address; tokenOut: Address }> = {
  [mainnet.id]: {
    tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokenOut: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  [base.id]: {
    tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenOut: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  },
  [arbitrum.id]: {
    tokenIn: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    tokenOut: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  },
};
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// 스펙 DoD-6의 탐색기 tx URL 접두(리터럴)
const TX_EXPLORER: Record<SupportedChainId, string> = {
  [mainnet.id]: "https://etherscan.io/tx/",
  [base.id]: "https://basescan.org/tx/",
  [arbitrum.id]: "https://arbiscan.io/tx/",
};
const CHAIN_LABEL: Record<SupportedChainId, string> = {
  [mainnet.id]: "Ethereum",
  [base.id]: "Base",
  [arbitrum.id]: "Arbitrum",
};

// 보내는 USDC 금액 1
const AMOUNT = "1";

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

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 클릭 직전에 setTimeout까지 가짜로 바꾼다(viem 폴링·재시도 지연이 가짜 시계를 따른다).
function fakeAllTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
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

function txStatus(): HTMLElement {
  return screen.getByTestId("tx-status");
}

function txStatusValue(): string | null {
  return txStatus().getAttribute("data-status");
}

function txLinkHref(): string | null {
  return screen.queryByTestId("tx-link")?.getAttribute("href") ?? null;
}

// DoD-2: 메시지 영역이 none이고 링크·닫기·잔액 안내가 없다.
function expectNoMessage(label: string) {
  expect(txStatusValue(), label).toBe("none");
  expect(screen.queryByTestId("tx-link"), `${label} tx-link`).toBeNull();
  expect(screen.queryByTestId("tx-status-dismiss"), `${label} tx-status-dismiss`).toBeNull();
  expect(screen.queryByTestId("tx-balance-notice"), `${label} tx-balance-notice`).toBeNull();
}

// 커밋마다 기록하는 화면: 주 버튼 data-state와 메시지 영역
type TxStatusView = {
  primary: string | null;
  status: string | null;
  kind: string | null;
  href: string | null;
  dismiss: boolean;
  notice: boolean;
};

function readTxStatusView(): TxStatusView {
  const element = document.querySelector('[data-testid="tx-status"]');
  return {
    primary:
      document.querySelector('[data-testid="primary-button"]')?.getAttribute("data-state") ?? null,
    status: element?.getAttribute("data-status") ?? null,
    kind: element?.getAttribute("data-kind") ?? null,
    href: document.querySelector('[data-testid="tx-link"]')?.getAttribute("href") ?? null,
    dismiss: document.querySelector('[data-testid="tx-status-dismiss"]') !== null,
    notice: document.querySelector('[data-testid="tx-balance-notice"]') !== null,
  };
}

// 첫 커밋부터 바뀐 화면을 빠짐없이 기록한다(`renderAppHook`의 `onCommit`, 커밋 직후 DOM 반영 뒤 호출).
function createTxStatusRecorder() {
  const views: TxStatusView[] = [];
  return {
    onCommit() {
      const next = readTxStatusView();
      const last = views.at(-1);
      if (!last || JSON.stringify(last) !== JSON.stringify(next)) views.push(next);
    },
    views(): TxStatusView[] {
      return views;
    },
  };
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution() };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  chainSwitch: ChainSwitchControl;
  config: ReturnType<typeof createWagmiConfig>;
  recorder: ReturnType<typeof createTxStatusRecorder>;
  probe: () => Probe;
};

// 스텁 EIP-1193 지갑(`walletChainId`)과 선택 체인(`chainId`)으로 앱을 렌더링한다. `authorized`가 false면 연결 전 상태로 시작한다.
// 견적은 가격 영향 normal·최소 수령량 > 0 규칙, allowance는 approve 표본이 기본 규칙(0), swap 표본이 maxUint256이다.
function renderStubApp(
  kind: TxKind,
  {
    chainId = mainnet.id,
    walletChainId = chainId,
    authorized = true,
  }: { chainId?: SupportedChainId; walletChainId?: SupportedChainId; authorized?: boolean } = {},
): Scenario {
  rpc.setQuoteRule(parityQuoteRule);
  if (kind === "swap") rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
  const stub = createStubEip1193({
    chainId: walletChainId,
    accounts: [TEST_ACCOUNT],
    authorized,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletTransactions(stub);
  const chainSwitch = installChainSwitch(stub);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const recorder = createTxStatusRecorder();
  const view = renderAppHook(useProbe, {
    config,
    initialChainId: chainId,
    onCommit: recorder.onCommit,
  });
  return { stub, wallet, chainSwitch, config, recorder, probe: () => view.result.current };
}

async function waitConnected(s: Scenario, chainId: SupportedChainId) {
  await waitUntil(() => {
    const connection = getConnection(s.config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(chainId);
    expect(sameAddress(connection.address, TEST_ACCOUNT)).toBe(true);
  }, READY_TIMEOUT_MS);
}

// 선택 체인의 표본 페어와 금액 1을 입력해 주 버튼이 표본의 준비 상태(approve-required·swap-ready)이고 활성이 될 때까지 기다린다.
async function prepareInputs(kind: TxKind, chainId: SupportedChainId) {
  const pair = PAIRS[chainId];
  await chooseToken("in", pair.tokenIn);
  await chooseToken("out", pair.tokenOut);
  await typeAmount(AMOUNT);
  await waitUntil(() => expect(primaryState()).toBe(READY_STATE[kind]), READY_TIMEOUT_MS);
  await settlePendingWork();
  expect(primaryState()).toBe(READY_STATE[kind]);
  expect(primaryButton().disabled).toBe(false);
}

// 연결된 앱에서 표본의 준비 상태가 될 때까지 기다린다.
async function renderReadyApp(
  kind: TxKind,
  options: { chainId?: SupportedChainId; walletChainId?: SupportedChainId } = {},
): Promise<Scenario> {
  const chainId = options.chainId ?? mainnet.id;
  const s = renderStubApp(kind, { ...options, authorized: true });
  await waitConnected(s, options.walletChainId ?? chainId);
  await prepareInputs(kind, chainId);
  return s;
}

// 연결 전(주 버튼 disconnected) 앱
async function renderDisconnectedApp(kind: TxKind): Promise<Scenario> {
  const s = renderStubApp(kind, { authorized: false });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"), READY_TIMEOUT_MS);
  await settlePendingWork();
  return s;
}

async function connectWallet(s: Scenario) {
  await act(async () => {
    await connect(s.config, { connector: s.config.connectors[0]! });
  });
  await waitConnected(s, mainnet.id);
}

// 영수증 응답을 붙잡고 주 버튼을 눌러, 해시를 받은 진행 phase에서 영수증 조회가 붙잡힐 때까지 기다린다.
async function clickAndHoldReceipt(s: Scenario, kind: TxKind) {
  const receiptGate = rpc.holdReceipt();
  clickPrimary();
  await waitUntil(() => expect(s.probe().execution.phase).toBe(PROGRESS[kind]), READY_TIMEOUT_MS);
  await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
  await settlePendingWork();
  return receiptGate;
}

function receiptCalls() {
  return rpc.requests(matchReceipt.method("eth_getTransactionReceipt"));
}

describe("트랜잭션 상태 메시지 — 진행 중인 approve·swap을 주 버튼 아래에서 확인하고 탐색기에서 볼 수 있다", () => {
  describe("메시지 영역", () => {
    /**
     * @spec DoD-1
     * @given 앱을 렌더링한다. 표본 순서 두 가지를 하나씩 반복한다. approve 표본: 지갑 연결 전 → 스텁 지갑 연결 후 실행 전(idle, approve-required) → 영수증 응답을 붙잡은 approve pending(approving) → 영수증을 성공으로 풀어 approve 성공 결과(data-status success, 영수증 뒤 allowance 다시 읽기는 amountInRaw 이상을 응답해 swap-ready가 된다) → swap 클릭의 서명 요청을 지갑이 4001로 거부한 실패 결과(data-status rejected). swap 표본: 지갑 연결 전 → 스텁 지갑 연결 후 실행 전(idle, swap-ready) → 영수증 응답을 붙잡은 swap pending(swapping) → 영수증을 성공으로 풀어 swap 성공 결과(data-status success)
     * @when 표본 순서대로 연결하고 주 버튼을 누르고 응답을 풀며, 각 관찰 시점에서 tx-status 요소를 찾는다
     * @then 모든 관찰 시점에 tx-status 요소가 하나 마운트되어 있다
     * @then 모든 관찰 시점에 tx-status의 role은 status다(실패 결과 표시 중에도 alert가 아니다)
     * @then 모든 관찰 시점에 tx-status는 문서 순서에서 주 버튼(primary-button) 다음에 있다
     * @then 모든 관찰 시점의 tx-status는 연결 전에 찾은 것과 같은 요소(같은 DOM 노드)다
     */
    it(
      "[DoD-1] 상태 메시지 영역은 연결 전·후·진행 중·결과 표시 중 내내 주 버튼 다음의 같은 status 요소로 마운트되어 있다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderDisconnectedApp(kind);
          const initial = screen.getAllByTestId("tx-status");
          expect(initial, `${kind} 연결 전`).toHaveLength(1);
          const node = initial[0]!;

          const observe = (label: string) => {
            const all = screen.getAllByTestId("tx-status");
            expect(all, label).toHaveLength(1);
            const element = all[0]!;
            expect(element, `${label} 같은 노드`).toBe(node);
            expect(element.getAttribute("role"), `${label} role`).toBe("status");
            expect(screen.queryAllByRole("alert"), `${label} alert`).toHaveLength(0);
            expect(
              primaryButton().compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING,
              `${label} 주 버튼 다음`,
            ).not.toBe(0);
          };

          // 지갑 연결 전
          expect(primaryState(), `${kind} 연결 전`).toBe("disconnected");
          observe(`${kind} 연결 전`);

          // 스텁 지갑 연결 후 실행 전(idle)
          await connectWallet(s);
          await prepareInputs(kind, mainnet.id);
          expect(s.probe().execution.phase).toBe("idle");
          observe(`${kind} 연결 후 idle`);

          // 영수증 응답을 붙잡은 진행 중
          const receiptGate = await clickAndHoldReceipt(s, kind);
          expect(txStatusValue(), `${kind} 진행 중`).toBe("pending");
          observe(`${kind} ${PROGRESS[kind]}`);

          // 영수증을 성공으로 풀어 성공 결과. approve 표본은 영수증 뒤 allowance 다시 읽기가 amountInRaw 이상을 응답한다.
          if (kind === "approve") rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
          receiptGate.release();
          await waitUntil(
            () => expect(s.probe().execution.result?.status).toBe("success"),
            READY_TIMEOUT_MS,
          );
          await waitUntil(() => expect(txStatusValue()).toBe("success"), READY_TIMEOUT_MS);
          observe(`${kind} 성공 결과`);

          if (kind === "approve") {
            // swap 클릭의 서명 요청을 지갑이 4001로 거부한 실패 결과
            await waitUntil(() => expect(primaryState()).toBe("swap-ready"), READY_TIMEOUT_MS);
            s.wallet.reply({ type: "error", code: USER_REJECTED_CODE });
            clickPrimary();
            await waitUntil(
              () =>
                expect(s.probe().execution.result).toEqual({ kind: "swap", status: "rejected" }),
              READY_TIMEOUT_MS,
            );
            await waitUntil(() => expect(txStatusValue()).toBe("rejected"), READY_TIMEOUT_MS);
            observe(`${kind} 표본 실패 결과(rejected)`);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-2
     * @given 표시할 pending이나 결과가 없다. 표본: 지갑 연결 전, 스텁 지갑 연결 후 approve·swap을 실행하지 않은 idle을 하나씩 반복한다
     * @when tx-status 요소를 읽는다
     * @then tx-status[data-status]는 none이다
     * @then tx-link가 없다
     * @then tx-status-dismiss가 없다
     * @then tx-balance-notice가 없다
     */
    it(
      "[DoD-2] 표시할 pending이나 결과가 없으면 none이고 링크·닫기·잔액 안내가 없다",
      async () => {
        // 지갑 연결 전
        {
          const s = await renderDisconnectedApp("approve");
          expect(s.probe().execution.phase).toBe("idle");
          expect(s.probe().execution.result).toBeNull();
          expectNoMessage("연결 전");
        }

        // 스텁 지갑 연결 후 approve·swap을 실행하지 않은 idle
        resetSample();
        {
          const s = await renderReadyApp("approve");
          expect(s.probe().execution.phase).toBe("idle");
          expect(s.probe().execution.result).toBeNull();
          expectNoMessage("연결 후 실행 전 idle");
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("진행 중(pending) 표시", () => {
    /**
     * @spec EC-26 DoD-2
     * @given 스텁 지갑이 연결돼 있다. 표본: 종류(approve-required에서 approve, swap-ready에서 swap) × awaiting-signature 대기 단계(지갑이 선택 체인과 다른 체인이고 체인 전환 응답을 붙잡음, 지갑이 선택 체인이고 eth_sendTransaction 응답을 붙잡음)를 하나씩 반복한다
     * @when 주 버튼을 눌러 phase가 awaiting-signature인 동안 tx-status를 읽는다
     * @then awaiting-signature 동안 tx-status[data-status]는 none이다
     * @then awaiting-signature 동안 tx-link·tx-status-dismiss·tx-balance-notice가 없다
     */
    it(
      "[EC-26] 서명을 기다리는 동안에는 메시지 영역이 none이다",
      async () => {
        const stages = ["체인 전환 응답 붙잡기", "eth_sendTransaction 응답 붙잡기"] as const;
        let sampleCount = 0;
        for (const kind of TX_KINDS) {
          for (const stage of stages) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${kind} — ${stage}`;
            const switching = stage === "체인 전환 응답 붙잡기";
            // 체인 전환 표본은 지갑이 Base, 선택 체인이 Ethereum이다.
            const s = await renderReadyApp(kind, {
              walletChainId: switching ? base.id : mainnet.id,
            });
            const gate = switching ? s.chainSwitch.hold() : s.wallet.hold();
            const mark = s.recorder.views().length;

            clickPrimary();
            await waitUntil(() => expect(gate.heldCount).toBe(1), READY_TIMEOUT_MS);
            await settlePendingWork();
            expect(s.probe().execution.phase, label).toBe("awaiting-signature");
            expectNoMessage(`${label} awaiting-signature`);

            gate.release();
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
            await settlePendingWork();

            // awaiting-signature 동안 기록된 모든 커밋
            const during = s.recorder
              .views()
              .slice(mark)
              .filter((view) => view.primary === "awaiting-signature");
            expect(during.length, label).toBeGreaterThan(0);
            for (const [i, view] of during.entries()) {
              expect(view.status, `${label} #${i}`).toBe("none");
              expect(view.href, `${label} #${i} tx-link`).toBeNull();
              expect(view.dismiss, `${label} #${i} tx-status-dismiss`).toBe(false);
              expect(view.notice, `${label} #${i} tx-balance-notice`).toBe(false);
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-3 DoD-4 DoD-5
     * @given 스텁 지갑이 트랜잭션 체인에 연결돼 있고 선택 체인도 그 체인이며, eth_sendTransaction에 해시로 응답하고 영수증 응답을 붙잡는다. 표본: 트랜잭션 체인(Ethereum, Base, Arbitrum) × 종류(approve-required에서 클릭해 approving, swap-ready에서 클릭해 swapping)를 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받은 뒤 영수증이 나오기 전까지 tx-status를 읽는다
     * @then tx-status[data-status]는 pending이다
     * @then tx-status[data-kind]는 useSwapExecution().pendingTx.kind(approve 표본은 approve, swap 표본은 swap)다
     * @then tx-link의 href는 pendingTx.chainId 체인 탐색기의 /tx/{pendingTx.hash}다(Ethereum https://etherscan.io/tx/{hash}, Base https://basescan.org/tx/{hash}, Arbitrum https://arbiscan.io/tx/{hash}, hash는 지갑이 돌려준 해시)
     * @then tx-status-dismiss가 없다
     */
    it(
      "[DoD-3][DoD-4][DoD-5] approving·swapping 동안 pending과 tx 체인 탐색기 링크를 보이고 닫기 버튼은 없다",
      async () => {
        const chains: readonly SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        let sampleCount = 0;
        for (const chainId of chains) {
          for (const kind of TX_KINDS) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${CHAIN_LABEL[chainId]} — ${PROGRESS[kind]}`;
            const s = await renderReadyApp(kind, { chainId });
            const hash = stubTransactionHash(1);
            const expectedHref = `${TX_EXPLORER[chainId]}${hash}`;
            const mark = s.recorder.views().length;

            const receiptGate = await clickAndHoldReceipt(s, kind);
            const { pendingTx } = s.probe().execution;
            // 전제: pendingTx는 트랜잭션 체인과 지갑이 돌려준 해시다.
            expect(pendingTx, label).toEqual({ kind, chainId, hash });
            expect(s.wallet.hashes(), label).toEqual([hash]);

            expect(txStatusValue(), label).toBe("pending");
            expect(txStatus().getAttribute("data-kind"), label).toBe(pendingTx!.kind);
            expect(txStatus().getAttribute("data-kind"), label).toBe(kind);
            expect(txLinkHref(), label).toBe(expectedHref);
            expect(screen.queryByTestId("tx-status-dismiss"), label).toBeNull();

            receiptGate.release();
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);

            // 진행 phase 동안 기록된 모든 커밋
            const during = s.recorder
              .views()
              .slice(mark)
              .filter((view) => view.primary === PROGRESS[kind]);
            expect(during.length, label).toBeGreaterThan(0);
            for (const [i, view] of during.entries()) {
              expect(view.status, `${label} #${i}`).toBe("pending");
              expect(view.kind, `${label} #${i} data-kind`).toBe(kind);
              expect(view.href, `${label} #${i} href`).toBe(expectedHref);
              expect(view.dismiss, `${label} #${i} tx-status-dismiss`).toBe(false);
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-14
     * @given 스텁 지갑이 eth_sendTransaction에 해시로 응답하고, 영수증 조회는 계속 미발견이며 트랜잭션 조회(eth_getTransactionByHash)는 트랜잭션을 돌려준다. 표본: approve(approving), swap(swapping)을 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받은 뒤 가짜 타이머로 F5 EC-18 표본 길이(30분 이상) 이상 진행한다
     * @then 진행하는 동안 tx-status[data-status]는 pending을 유지한다
     * @then 진행하는 동안 tx-link가 있고 href는 트랜잭션 체인 탐색기의 /tx/{지갑이 돌려준 해시} 그대로다
     */
    it(
      "[EC-14] 영수증이 오래 나오지 않아도 pending과 tx 링크를 유지한다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
          const expectedHref = `${TX_EXPLORER[mainnet.id]}${stubTransactionHash(1)}`;
          // 영수증은 계속 미발견, 트랜잭션 조회는 대기 중인 트랜잭션을 돌려준다.
          rpc.setReceiptRule(makeReceiptRule("not-found", "pending"));
          fakeAllTimers();

          clickPrimary();
          await waitUntilAdvancingFakeClock(() =>
            expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
          );
          await waitUntilAdvancingFakeClock(() => expect(receiptCalls().length).toBeGreaterThan(0));
          // 전제: 지갑이 해시를 돌려줬다.
          expect(s.wallet.hashes(), kind).toEqual([stubTransactionHash(1)]);
          expect(txStatusValue(), kind).toBe("pending");
          expect(txLinkHref(), kind).toBe(expectedHref);

          const startedAt = Date.now();
          const violations: string[] = [];
          await advanceFakeClockInSteps(LONG_WAIT_MS, LONG_WAIT_STEP_MS, (elapsedMs) => {
            const status = txStatusValue();
            const href = txLinkHref();
            if (status !== "pending" || href !== expectedHref) {
              violations.push(`${elapsedMs}ms: data-status=${status} href=${href}`);
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

  describe("진행 중 변경과 지갑 상태 변화", () => {
    /**
     * @spec EC-21 DoD-4
     * @given 해시를 받은 뒤 영수증 응답을 붙잡아 진행 중이다. 표본: 진행 phase(approving, swapping) × 변경(보내는 칸 금액 변경, 보내는 토큰 변경, 체인 선택 드롭다운으로 선택 체인을 트랜잭션 체인과 다른 체인으로 변경)을 하나씩 반복한다
     * @when 진행 중에 표본의 변경을 하고, 그 뒤 영수증이 나오기 전까지 tx-status와 tx-link를 읽는다
     * @then 변경 뒤 영수증이 나오기 전까지 tx-status[data-status]는 pending을 유지한다
     * @then 선택 체인 변경 표본은 선택 체인을 바꾼 뒤에도 tx-link의 href가 트랜잭션 체인(pendingTx.chainId) 탐색기의 /tx/{pendingTx.hash}이고 바꾼 선택 체인의 탐색기가 아니다
     */
    it(
      "[EC-21][DoD-4] approving·swapping 중 금액·토큰·선택 체인을 바꿔도 pending과 tx 체인 탐색기 링크를 유지한다",
      async () => {
        const changes = ["보내는 칸 금액", "보내는 토큰", "선택 체인"] as const;
        let sampleCount = 0;
        for (const kind of TX_KINDS) {
          for (const change of changes) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${PROGRESS[kind]} — ${change}`;
            const s = await renderReadyApp(kind);
            const hash = stubTransactionHash(1);
            const expectedHref = `${TX_EXPLORER[mainnet.id]}${hash}`;

            const receiptGate = await clickAndHoldReceipt(s, kind);
            expect(txStatusValue(), label).toBe("pending");
            // 변경 직전 상태(마지막 기록)부터 본다.
            const mark = s.recorder.views().length - 1;

            if (change === "보내는 칸 금액") {
              await typeAmount("2");
            } else if (change === "보내는 토큰") {
              await chooseToken("in", ETHEREUM_WETH);
              expect(sameAddress(tokenAddress("in") ?? undefined, ETHEREUM_WETH), label).toBe(true);
            } else {
              await chooseChainFromDropdown(base);
            }
            await settlePendingWork();
            expect(s.probe().execution.phase, label).toBe(PROGRESS[kind]);

            expect(txStatusValue(), label).toBe("pending");
            if (change === "선택 체인") {
              // 전제: 선택 체인이 트랜잭션 체인(Ethereum)과 다른 Base로 바뀌었다.
              expect(
                screen.getByTestId("chain-select").getAttribute("data-selected-chain-id"),
                label,
              ).toBe(String(base.id));
              const { pendingTx } = s.probe().execution;
              expect(pendingTx, label).toEqual({ kind, chainId: mainnet.id, hash });
              expect(txLinkHref(), label).toBe(
                `${TX_EXPLORER[pendingTx!.chainId]}${pendingTx!.hash}`,
              );
              expect(txLinkHref(), label).toBe(expectedHref);
              expect(txLinkHref()?.startsWith(TX_EXPLORER[base.id]), label).toBe(false);
            }

            receiptGate.release();
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);

            // 변경 뒤 영수증 후처리가 끝나 진행 phase를 벗어나기 전까지의 커밋
            const after = s.recorder.views().slice(mark);
            const end = after.findIndex((view) => view.primary !== PROGRESS[kind]);
            expect(end, label).toBeGreaterThan(0);
            for (const [i, view] of after.slice(0, end).entries()) {
              expect(view.status, `${label} #${i}`).toBe("pending");
              if (change === "선택 체인") {
                expect(view.href, `${label} #${i} href`).toBe(expectedHref);
              }
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-24 DoD-2
     * @given 해시를 받은 뒤 영수증 응답을 붙잡아 진행 중이다. 표본: 진행 phase(approving, swapping) × 변경(지갑 연결 해제, 계정 변경, 계정 변경 → 영수증 풀기 → 원래 계정으로 되돌림, 연결 해제 → 영수증 풀기 → 같은 계정으로 재연결)을 하나씩 반복한다
     * @when 진행 중에 표본의 변경을 하고, 그 뒤 붙잡은 영수증 응답을 성공으로 풀고, 되돌림·재연결 표본은 그 뒤 원래 계정으로 되돌리거나 같은 계정으로 다시 연결한다
     * @then 변경 뒤 tx-status[data-status]는 none이다
     * @then 변경 뒤 tx-link·tx-status-dismiss·tx-balance-notice가 없다
     * @then 영수증 응답을 푼 뒤에도 useSwapExecution().result는 null이다
     * @then 영수증 응답을 푼 뒤에도 tx-status[data-status]는 none이다
     * @then 되돌림·재연결 표본은 원래 계정으로 되돌리거나 같은 계정으로 다시 연결한 뒤에도 useSwapExecution().result는 null이고 tx-status[data-status]는 none이다
     */
    it(
      "[EC-24] approving·swapping 중 연결 해제나 계정 변경이 있으면 none이 되고 그 트랜잭션의 결과를 기록하지 않는다",
      async () => {
        const changes = [
          "연결 해제",
          "계정 변경",
          "계정 변경 → 원래 계정으로 되돌림",
          "연결 해제 → 같은 계정으로 재연결",
        ] as const;
        let sampleCount = 0;
        for (const kind of TX_KINDS) {
          for (const change of changes) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${PROGRESS[kind]} — ${change}`;
            const accountChange = change.startsWith("계정 변경");
            const s = await renderReadyApp(kind);

            const receiptGate = await clickAndHoldReceipt(s, kind);
            expect(txStatusValue(), label).toBe("pending");

            if (accountChange) {
              act(() => s.stub.changeAccounts([SECOND_ACCOUNT]));
              await waitUntil(
                () =>
                  expect(sameAddress(getConnection(s.config).address, SECOND_ACCOUNT)).toBe(true),
                READY_TIMEOUT_MS,
              );
            } else {
              await act(async () => {
                await disconnect(s.config);
              });
              await waitUntil(() => expect(primaryState()).toBe("disconnected"), READY_TIMEOUT_MS);
            }
            await waitUntil(() => expect(txStatusValue()).toBe("none"), READY_TIMEOUT_MS);
            expectNoMessage(`${label} 변경 뒤`);

            // 붙잡은 영수증 응답을 성공으로 푼다.
            receiptGate.release();
            await waitUntil(
              () => expect(receiptCalls().some((request) => request.status === "ok")).toBe(true),
              READY_TIMEOUT_MS,
            );
            await settlePendingWork(10);
            expect(s.probe().execution.result, `${label} 영수증 뒤`).toBeNull();
            expect(txStatusValue(), `${label} 영수증 뒤`).toBe("none");

            if (change === "계정 변경 → 원래 계정으로 되돌림") {
              act(() => s.stub.changeAccounts([TEST_ACCOUNT]));
              await waitUntil(
                () => expect(sameAddress(getConnection(s.config).address, TEST_ACCOUNT)).toBe(true),
                READY_TIMEOUT_MS,
              );
            } else if (change === "연결 해제 → 같은 계정으로 재연결") {
              await connectWallet(s);
            }
            if (change.includes("→")) {
              await settlePendingWork(10);
              expect(s.probe().execution.result, `${label} 되돌린 뒤`).toBeNull();
              expect(txStatusValue(), `${label} 되돌린 뒤`).toBe("none");
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
