import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { Address, Hash } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import {
  type PendingTx,
  type SwapExecutionValue,
  useSwapExecution,
} from "@/providers/swap-execution-provider";

import {
  type BalanceRpcStub,
  type HoldGate,
  type RequestMatcher,
  installBalanceRpcStub,
  match,
  matchReceipt,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type StubEip1193,
  type WalletTransactionControl,
  createStubEip1193,
  installWalletTransactions,
  stubTransactionHash,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 앱 Provider 안의 프로브로 읽은 useSwapExecution()의 phase·pendingTx·result(커밋마다 기록),
// primary-button의 data-state·비활성(커밋마다 기록), 상태 메시지 영역(tx-status의 data-status·data-kind, tx-link 유무와 href),
// 보내는 칸 amount-input 값과 두 토큰 선택, RPC 스텁의 잔액 읽기 요청 기록으로 판정한다.
// 기대값은 스펙 §4.2·§4.3과 DoD·EC 항목에서 가져오고, 해시·체인 ID·탐색기 URL은 제품 config를 쓰지 않고 리터럴로 적는다.
// mock 경계(사용자 확정, 2026-11-20): F5 T-10 경계(스텁 EIP-1193 지갑의 전송 해시 응답, RPC 스텁의 영수증 성공·붙잡기,
// 선택 체인 변경은 화면의 체인 선택 드롭다운을 실제로 조작)와 F6 T-8의 잔액 붙잡기(RPC 스텁의 잔액 응답 제어·붙잡기와 요청 기록).
// 공통으로 실제 wagmi·Provider·화면, mock 커넥터·스텁 EIP-1193, 전역 fetch URL 라우팅 RPC 스텁, 가짜 타이머를 쓴다. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다.

// "동안"의 판정은 커밋마다 기록한 화면(주 버튼 data-state·비활성, 메시지 영역)과 프로브의 phase·pendingTx로 한다.
// 프로브는 커밋의 layout effect에서 실행 값을 넘기고, 앱 Profiler의 커밋 콜백이 그 값과 DOM을 함께 기록한다.
// "해시를 받은 뒤 영수증이 나올 때까지"는 phase가 처음 진행 phase가 된 커밋부터 붙잡은 영수증 응답을 풀기 직전까지의 커밋이다.
// 잔액 판정은 카드 잔액 주기 타이머(setInterval)와 시계만 가짜로 두어, 테스트가 시계를 진행하지 않으면 주기 다시 읽기가 일어나지 않게 한다.

const CASE_TIMEOUT_MS = 120_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;

// 카드 잔액 주기(F2 15초)
const CARD_BALANCE_INTERVAL_MS = 15_000;

// 공식 주소(리터럴)
const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WETH: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  [base.id]: "0x4200000000000000000000000000000000000006",
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

// 스펙의 탐색기 tx URL 접두(리터럴)
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

// 보내는 칸 금액(ETH·WETH decimals 18). EC-11에서 바꾼 체인에 다시 입력하는 금액은 다른 값이다.
const AMOUNT = "1";
const REENTERED_AMOUNT = "2";

type WrapKind = "wrap" | "unwrap";
const WRAP_KINDS: readonly WrapKind[] = ["wrap", "unwrap"];
const READY_STATE = { wrap: "wrap-ready", unwrap: "unwrap-ready" } as const;
const PROGRESS = { wrap: "wrapping", unwrap: "unwrapping" } as const;

// 표본 종류의 보내는·받는 토큰: wrap은 ETH → WETH, unwrap은 WETH → ETH
function pairOf(
  kind: WrapKind,
  chainId: SupportedChainId,
): { tokenIn: Address; tokenOut: Address } {
  return kind === "wrap"
    ? { tokenIn: ETH_ADDRESS, tokenOut: WETH[chainId] }
    : { tokenIn: WETH[chainId], tokenOut: ETH_ADDRESS };
}

let rpc: BalanceRpcStub;

// 프로브가 커밋마다 넘기는 최신 실행 값
let latestExecution: SwapExecutionValue | null = null;

beforeEach(() => {
  rpc = installBalanceRpcStub();
  latestExecution = null;
});

afterEach(() => {
  latestExecution = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
});

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  latestExecution = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 잔액 주기 타이머(setInterval)와 시계만 가짜로 둔다. 테스트가 시계를 진행시키지 않으면 주기 다시 읽기가 일어나지 않는다.
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

function tokenAddress(side: Side): string | undefined {
  const address = within(field(side))
    .getByTestId("token-button")
    .getAttribute("data-token-address");
  return address === null || address === "" ? undefined : address;
}

function balanceRaw(side: Side): string | null {
  return within(field(side)).queryByTestId("balance")?.getAttribute("data-balance-raw") ?? null;
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

function txLinkHref(): string | null {
  return screen.queryByTestId("tx-link")?.getAttribute("href") ?? null;
}

// ─── 커밋 기록 ────────────────────────────────────────────────────

type CommitView = {
  phase: string | null;
  pendingTx: PendingTx | null;
  primary: string | null;
  disabled: boolean;
  status: string | null;
  kind: string | null;
  href: string | null;
};

function readCommitView(): CommitView {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="primary-button"]');
  const status = document.querySelector('[data-testid="tx-status"]');
  return {
    phase: latestExecution?.phase ?? null,
    pendingTx: latestExecution?.pendingTx ?? null,
    primary: button?.getAttribute("data-state") ?? null,
    disabled: button?.disabled ?? false,
    status: status?.getAttribute("data-status") ?? null,
    kind: status?.getAttribute("data-kind") ?? null,
    href: document.querySelector('[data-testid="tx-link"]')?.getAttribute("href") ?? null,
  };
}

// 첫 커밋부터 바뀐 기록을 빠짐없이 남긴다(`renderAppHook`의 `onCommit`, 커밋 직후 DOM 반영 뒤 호출).
function createCommitRecorder() {
  const views: CommitView[] = [];
  return {
    onCommit() {
      const next = readCommitView();
      const last = views.at(-1);
      if (!last || JSON.stringify(last) !== JSON.stringify(next)) views.push(next);
    },
    views(): CommitView[] {
      return views;
    },
  };
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  const execution = useSwapExecution();
  // 커밋의 layout effect에서 최신 실행 값을 넘긴다(Profiler 커밋 콜백보다 먼저 실행된다).
  useLayoutEffect(() => {
    latestExecution = execution;
  });
  return { execution };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  recorder: ReturnType<typeof createCommitRecorder>;
  probe: () => Probe;
};

// 스텁 EIP-1193 지갑으로 표본 체인에 연결되고(지갑 체인 = 선택 체인) 표본 종류의 페어와 금액을 입력해
// 주 버튼이 표본의 준비 상태(wrap-ready·unwrap-ready)이고 활성이 될 때까지 기다린다. 두 칸의 카드 잔액 읽기가 끝나 있다.
async function renderReady(kind: WrapKind, chainId: SupportedChainId): Promise<Scenario> {
  const stub = createStubEip1193({
    chainId,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletTransactions(stub);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const recorder = createCommitRecorder();
  const view = renderAppHook(useProbe, {
    config,
    initialChainId: chainId,
    onCommit: recorder.onCommit,
  });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(chainId);
    expect(sameAddress(connection.address, TEST_ACCOUNT)).toBe(true);
  }, READY_TIMEOUT_MS);

  const pair = pairOf(kind, chainId);
  // 보내는 칸의 기본 토큰은 ETH다. unwrap 표본은 보내는 칸에 WETH를 먼저 고른다.
  if (kind === "unwrap") await chooseToken("in", pair.tokenIn);
  await chooseToken("out", pair.tokenOut);
  await typeAmount(AMOUNT);
  await waitUntil(() => expect(primaryState()).toBe(READY_STATE[kind]), READY_TIMEOUT_MS);
  await waitUntil(() => {
    expect(balanceRaw("in")).toBeTruthy();
    expect(balanceRaw("out")).toBeTruthy();
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
  // 전제: 표본 페어가 선택돼 있고 표시할 결과가 없다.
  expect(sameAddress(tokenAddress("in"), pair.tokenIn)).toBe(true);
  expect(sameAddress(tokenAddress("out"), pair.tokenOut)).toBe(true);
  expect(primaryState()).toBe(READY_STATE[kind]);
  expect(primaryButton().disabled).toBe(false);
  expect(view.result.current.execution.result).toBeNull();
  return { stub, wallet, recorder, probe: () => view.result.current };
}

// 영수증 응답을 붙잡고 주 버튼을 눌러, 해시를 받은 진행 phase에서 영수증 조회가 붙잡힐 때까지 기다린다.
async function clickAndHoldReceipt(s: Scenario, kind: WrapKind): Promise<HoldGate> {
  const receiptGate = rpc.holdReceipt();
  clickPrimary();
  await waitUntil(() => expect(s.probe().execution.phase).toBe(PROGRESS[kind]), READY_TIMEOUT_MS);
  await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
  await settlePendingWork();
  // 전제: 지갑이 해시 하나를 돌려줬고 영수증 전에는 결과가 없다.
  expect(s.wallet.hashes()).toEqual([stubTransactionHash(1)]);
  expect(s.probe().execution.result).toBeNull();
  return receiptGate;
}

async function awaitResult(s: Scenario) {
  await waitUntil(() => {
    expect(s.probe().execution.result).not.toBeNull();
    expect(s.probe().execution.phase).toBe("idle");
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
}

// 트랜잭션 체인·연결 계정의 카드 잔액 요청: ETH는 `eth_getBalance`, WETH는 WETH 주소로 가는 `balanceOf`
function ethBalanceKey(chainId: SupportedChainId): RequestMatcher {
  return match.chain(chainId, match.account(TEST_ACCOUNT, match.kind("eth_getBalance")));
}

function wethBalanceKey(chainId: SupportedChainId): RequestMatcher {
  return match.chain(chainId, match.account(TEST_ACCOUNT, match.balanceOfToken(WETH[chainId])));
}

function receiptOk(chainId: SupportedChainId, hash: Hash): boolean {
  return rpc
    .requests(
      match.chain(
        chainId,
        matchReceipt.hash(hash, matchReceipt.method("eth_getTransactionReceipt")),
      ),
    )
    .some((request) => request.status === "ok");
}

describe("ETH ↔ WETH 전환 진행 — 전환 트랜잭션이 끝날 때까지 진행 상태를 보고, 성공하면 결과를 확인하고 잔액이 갱신된다", () => {
  describe("영수증을 기다리는 동안", () => {
    /**
     * @spec DoD-27 DoD-28 DoD-29 DoD-30
     * @given 스텁 지갑이 트랜잭션 체인에 연결돼 있고 선택 체인도 그 체인이며, eth_sendTransaction에 해시로 응답하고 영수증 응답을 붙잡는다. phase·주 버튼 상태를 커밋마다 기록한다. 표본: 종류(보내는 ETH·받는 WETH로 wrap-ready에서 클릭하는 wrap, 보내는 WETH·받는 ETH로 unwrap-ready에서 클릭하는 unwrap) × 트랜잭션 체인(Ethereum 1, Base 8453, Arbitrum 42161)을 하나씩 반복한다
     * @when 주 버튼을 눌러 트랜잭션 해시를 받은 뒤 영수증이 나오기 전까지 기록하고 useSwapExecution()과 tx-status를 읽는다
     * @then 해시를 받은 뒤 영수증이 나올 때까지 기록된 phase는 모두 표본의 진행 phase(wrap은 wrapping, unwrap은 unwrapping)다
     * @then 해시를 받은 뒤 영수증이 나올 때까지 기록된 주 버튼 data-state는 모두 표본의 진행 phase와 같은 값(wrap은 wrapping, unwrap은 unwrapping)이고 비활성이다
     * @then 그동안 useSwapExecution().pendingTx는 리터럴 { kind: 표본 종류("wrap" 또는 "unwrap"), chainId: 표본 체인 ID, hash: 지갑이 돌려준 해시 }와 같다(다른 필드가 없다)
     * @then 그동안 tx-status[data-status]는 pending이고 data-kind는 pendingTx.kind(wrap 표본은 wrap, unwrap 표본은 unwrap)다
     * @then 그동안 tx-link가 있고 href는 표본 체인 탐색기의 /tx/{지갑이 돌려준 해시} 리터럴이다(Ethereum https://etherscan.io/tx/{hash}, Base https://basescan.org/tx/{hash}, Arbitrum https://arbiscan.io/tx/{hash})
     */
    it(
      "[DoD-27][DoD-28][DoD-29][DoD-30] 해시를 받은 뒤 영수증까지 wrapping·unwrapping 진행 상태와 pending 메시지·탐색기 링크를 유지한다",
      async () => {
        const chains: readonly SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];
        let sampleCount = 0;
        for (const kind of WRAP_KINDS) {
          for (const chainId of chains) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${kind} — ${CHAIN_LABEL[chainId]}`;
            const s = await renderReady(kind, chainId);
            const hash = stubTransactionHash(1);
            const expectedPendingTx = { kind, chainId, hash };
            const expectedHref = `${TX_EXPLORER[chainId]}${hash}`;
            const mark = s.recorder.views().length;

            const receiptGate = await clickAndHoldReceipt(s, kind);

            // 영수증 전 지금의 값
            expect(s.probe().execution.phase, label).toBe(PROGRESS[kind]);
            expect(s.probe().execution.pendingTx, label).toStrictEqual(expectedPendingTx);
            expect(primaryState(), label).toBe(PROGRESS[kind]);
            expect(primaryButton().disabled, label).toBe(true);
            expect(txStatus().getAttribute("data-status"), label).toBe("pending");
            expect(txStatus().getAttribute("data-kind"), label).toBe(
              s.probe().execution.pendingTx?.kind,
            );
            expect(txStatus().getAttribute("data-kind"), label).toBe(kind);
            expect(txLinkHref(), label).toBe(expectedHref);

            // 붙잡은 영수증 응답을 풀기 직전까지가 "영수증이 나올 때까지"다.
            const end = s.recorder.views().length;
            receiptGate.release();
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
            await settlePendingWork();
            // 전제: 붙잡았던 영수증이 트랜잭션 체인에서 성공으로 나왔다.
            expect(receiptOk(chainId, hash), label).toBe(true);

            const views = s.recorder.views();
            // 해시를 받은 첫 커밋: phase가 처음 진행 phase가 된 커밋
            const start = views.findIndex(
              (view, index) => index >= mark && view.phase === PROGRESS[kind],
            );
            expect(start, `${label} 진행 시작`).toBeGreaterThanOrEqual(mark);
            expect(start, `${label} 진행 시작`).toBeLessThan(end);
            for (let index = start; index < end; index += 1) {
              const view = views[index]!;
              const at = `${label} #${index - start}`;
              expect(view.phase, `${at} phase`).toBe(PROGRESS[kind]);
              expect(view.primary, `${at} 주 버튼`).toBe(PROGRESS[kind]);
              expect(view.disabled, `${at} 비활성`).toBe(true);
              expect(view.pendingTx, `${at} pendingTx`).toStrictEqual(expectedPendingTx);
              expect(view.status, `${at} data-status`).toBe("pending");
              expect(view.kind, `${at} data-kind`).toBe(view.pendingTx?.kind);
              expect(view.kind, `${at} data-kind`).toBe(kind);
              expect(view.href, `${at} href`).toBe(expectedHref);
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("영수증이 성공한 경우", () => {
    /**
     * @spec DoD-31 DoD-32 DoD-33
     * @given 스텁 지갑이 트랜잭션 체인에 연결돼 있고 선택 체인도 그 체인이며, 보내는 칸 금액을 입력해 두었고 두 칸의 카드 잔액 읽기가 끝났다. eth_sendTransaction에 해시로 응답하고 영수증은 성공이다. 잔액 주기 다시 읽기(15초)는 가짜 타이머로 일어나지 않게 하고, 영수증 응답 직전에 트랜잭션 체인·연결 계정의 ETH 잔액 읽기 요청 수와 WETH 잔액 읽기 요청 수를 기록한다. 표본: 종류(보내는 ETH·받는 WETH로 wrap-ready에서 클릭하는 wrap, 보내는 WETH·받는 ETH로 unwrap-ready에서 클릭하는 unwrap) × 트랜잭션 체인(Ethereum 1, Arbitrum 42161)을 하나씩 반복한다
     * @when 주 버튼을 눌러 영수증 성공을 받고 phase가 idle로 돌아가기를 기다린다
     * @then useSwapExecution().result는 리터럴 { kind: 표본 종류("wrap" 또는 "unwrap"), status: "success", chainId: 표본 체인 ID, hash: 지갑이 돌려준 해시 }와 같다(balanceDropped 키를 포함한 다른 필드가 없다)
     * @then tx-status[data-status]는 success이고 data-kind는 표본 종류(wrap 표본은 wrap, unwrap 표본은 unwrap)다
     * @then tx-link가 있고 href는 표본 체인 탐색기의 /tx/{지갑이 돌려준 해시} 리터럴이다(Ethereum https://etherscan.io/tx/{hash}, Arbitrum https://arbiscan.io/tx/{hash})
     * @then 보내는 칸 amount-input 값이 빈 문자열이다
     * @then 보내는 토큰과 받는 토큰 선택이 클릭 전과 같다(wrap 표본은 보내는 ETH·받는 표본 체인 WETH, unwrap 표본은 보내는 표본 체인 WETH·받는 ETH)
     * @then 영수증 뒤 15초 주기를 기다리지 않고 트랜잭션 체인·연결 계정의 ETH 잔액 읽기 요청과 WETH 잔액 읽기 요청이 각각 기록한 수보다 늘어난다
     */
    it(
      "[DoD-31][DoD-32][DoD-33] 영수증이 성공하면 kind별 성공 결과를 보이고 보내는 칸 금액을 비우며 트랜잭션 체인·계정의 카드 잔액을 다시 읽는다",
      async () => {
        const chains: readonly SupportedChainId[] = [mainnet.id, arbitrum.id];
        let sampleCount = 0;
        for (const kind of WRAP_KINDS) {
          for (const chainId of chains) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${kind} — ${CHAIN_LABEL[chainId]}`;
            fakePeriodicTimers();
            const s = await renderReady(kind, chainId);
            const hash = stubTransactionHash(1);
            const pair = pairOf(kind, chainId);
            // 전제: 보내는 칸 금액을 입력해 두었다.
            expect(amountInput().value, label).toBe(AMOUNT);

            const receiptGate = await clickAndHoldReceipt(s, kind);
            // 영수증 응답 직전의 트랜잭션 체인·연결 계정 ETH·WETH 잔액 읽기 요청 수
            const ethBefore = rpc.requests(ethBalanceKey(chainId)).length;
            const wethBefore = rpc.requests(wethBalanceKey(chainId)).length;
            const releasedAt = Date.now();
            receiptGate.release();
            await awaitResult(s);
            // 전제: 지갑이 돌려준 해시의 영수증을 트랜잭션 체인에서 성공으로 받았다.
            expect(receiptOk(chainId, hash), label).toBe(true);

            const result = s.probe().execution.result;
            expect(result, label).toStrictEqual({ kind, status: "success", chainId, hash });
            expect(result !== null && "balanceDropped" in result, `${label} balanceDropped`).toBe(
              false,
            );
            expect(txStatus().getAttribute("data-status"), label).toBe("success");
            expect(txStatus().getAttribute("data-kind"), label).toBe(kind);
            expect(txLinkHref(), label).toBe(`${TX_EXPLORER[chainId]}${hash}`);

            expect(amountInput().value, `${label} 보내는 칸 금액`).toBe("");
            expect(sameAddress(tokenAddress("in"), pair.tokenIn), `${label} 보내는 토큰`).toBe(
              true,
            );
            expect(sameAddress(tokenAddress("out"), pair.tokenOut), `${label} 받는 토큰`).toBe(
              true,
            );

            // 영수증 뒤 새로 생긴 카드 잔액 요청. 가짜 시계를 진행하지 않아 15초 주기 전이다.
            const beforeNextPeriod = (request: { at: number }) =>
              request.at - releasedAt < CARD_BALANCE_INTERVAL_MS;
            await waitUntil(() => {
              expect(
                rpc.requests(ethBalanceKey(chainId)).filter(beforeNextPeriod).length,
                `${label} ETH 잔액 요청`,
              ).toBeGreaterThan(ethBefore);
              expect(
                rpc.requests(wethBalanceKey(chainId)).filter(beforeNextPeriod).length,
                `${label} WETH 잔액 요청`,
              ).toBeGreaterThan(wethBefore);
            }, READY_TIMEOUT_MS);
            expect(Date.now() - releasedAt, label).toBeLessThan(CARD_BALANCE_INTERVAL_MS);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("진행 중 선택 체인이 바뀐 경우", () => {
    /**
     * @spec EC-11
     * @given 트랜잭션 체인에서 해시를 받은 뒤 영수증 응답을 붙잡아 진행 중이고, 그동안 체인 선택 드롭다운으로 선택 체인을 트랜잭션 체인과 다른 체인으로 바꾼 뒤 그 체인에서 보내는 칸 금액을 다시 입력했다. 표본: wrapping(보내는 ETH·받는 WETH에서 wrap), unwrapping(보내는 WETH·받는 ETH에서 unwrap)을 하나씩 반복한다
     * @when 붙잡은 영수증 응답을 성공으로 풀고 결과가 기록되기를 기다린다
     * @then 보내는 칸 금액이 다시 입력한 값 그대로이고 빈 값이 되지 않는다
     */
    it(
      "[EC-11] wrapping·unwrapping 중 선택 체인이 바뀐 뒤 영수증이 성공하면 보내는 칸 금액을 비우지 않는다",
      async () => {
        for (const [index, kind] of WRAP_KINDS.entries()) {
          if (index > 0) resetSample();
          const label = PROGRESS[kind];
          // 트랜잭션 체인은 Ethereum이고, 진행 중 선택 체인을 Base로 바꾼다.
          const s = await renderReady(kind, mainnet.id);
          const receiptGate = await clickAndHoldReceipt(s, kind);

          await chooseChainFromDropdown(base);
          await typeAmount(REENTERED_AMOUNT);
          await settlePendingWork();
          // 전제: 선택 체인이 트랜잭션 체인과 다르고, 진행 중이며, 그 체인에서 다시 입력한 금액이 있다.
          expect(
            screen.getByTestId("chain-select").getAttribute("data-selected-chain-id"),
            label,
          ).toBe(String(base.id));
          expect(s.probe().execution.phase, label).toBe(PROGRESS[kind]);
          expect(s.probe().execution.pendingTx?.chainId, label).toBe(mainnet.id);
          expect(amountInput().value, label).toBe(REENTERED_AMOUNT);

          receiptGate.release();
          await waitUntil(
            () => expect(s.probe().execution.result?.status).toBe("success"),
            READY_TIMEOUT_MS,
          );
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();
          // 전제: 붙잡았던 영수증이 트랜잭션 체인(Ethereum)에서 성공으로 나왔다.
          expect(receiptOk(mainnet.id, stubTransactionHash(1)), label).toBe(true);

          expect(amountInput().value, label).toBe(REENTERED_AMOUNT);
          expect(amountInput().value, label).not.toBe("");
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
