import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { type Address, type Hash, keccak256, toHex } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";
import { type TxResult, useSwapExecution } from "@/providers/swap-execution-provider";
import { useSwapFormBalances } from "@/providers/swap-form-provider";

import {
  type BalanceFn,
  type BalanceQuery,
  type BalanceRpcRequest,
  type BalanceRpcStub,
  STUB_MAX_UINT256,
  allowanceWhen,
  defaultAllowance,
  defaultBalance,
  installBalanceRpcStub,
  matchAllowance,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  RPC_INTERNAL_ERROR_CODE,
  type StubCallsReceipt,
  type StubEip1193,
  type WalletCallsControl,
  type WalletCallsStatusReply,
  type WalletHoldGate,
  atomicCapabilities,
  callsStatus,
  createStubEip1193,
  installWalletCalls,
  throwCallsStatusThen,
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

// 골격: 계획 T-8. Vitest jsdom 통합 테스트(앱 전체 렌더).
// mock 허용 경계: T-6과 같은 것(실제 wagmi·Provider·화면, 스텁 EIP-1193(injected) 커넥터 지갑(wagmi mock 커넥터 아님), 전역 fetch URL 라우팅 스텁,
// 지갑 `wallet_*` 세 메서드의 스텁 응답·오류·붙잡기, `vi.mock` 금지)에 가짜 타이머(setTimeout·setInterval만)를 더한다.
// `__tests__/support/*`는 고치지 않는다.
// 데이터 격리: 테스트마다 config·스텁·QueryClient를 새로 만들고 `clearCookies`. 가짜 타이머는 테스트마다 원복한다.
// 공통 전제: 스텁 EIP-1193 지갑으로 선택 체인에 연결돼 있고 선택 체인의 capabilities가 `atomic.status = "supported"`이며,
// 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 primary-button[data-state]가 `batch-ready`다. wallet_sendCalls는 배치 id로 응답한다(DoD-12 제외).
// 판정: 요소는 data-testid·접근성 role로 찾고 data 속성·href·`useSwapExecution()` 값·요청 기록으로 판정한다(문구 판정 없음).
// 미검증: 실제 지갑의 상태 코드와 폴링 간격은 스텁·가짜 타이머로 증명하지 못한다.
// 참고(계획 T-1): 상태 대기 폴링은 4000ms 간격이고 wallet_getCallsStatus throw 재시도는 약 3초면 소진된다. 가짜 시간 진행량은 살 단계에서 이를 근거로 정한다.

// 이 파일에서 "상태 조회"는 스텁 EIP-1193 지갑이 받은 `wallet_getCallsStatus` 요청 기록(`installWalletCalls`)이다.
// "allowance 읽기"는 연결 계정·SwapRouter02·보내는 USDC의 ERC-20 `allowance` `eth_call`(RPC fetch 스텁)이다.
// 기대값(주소·체인 ID·탐색기 URL·receipt 해시)은 제품 config가 아니라 리터럴로 적는다. 견적은 모든 티어가 수령량 = 입력 금액이다(`parityQuoteRule`).
// 가짜 타이머 표본은 클릭 직전에 setTimeout·setInterval(과 짝인 clear*)만 가짜로 바꾼다(viem 상태 폴링·재시도 대기가 가짜 시계를 따른다).

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;
// 가짜 타이머에서 대기할 때 확인 사이마다 진행하는 가짜 시간(시각 경계를 판정하지 않는 대기에만 쓴다)
const FAKE_WAIT_STEP_MS = 50;
// 계획 T-1 (e): wallet_getCallsStatus throw는 viem 기본 retryCount 4(지수 대기 200·400·800·1600ms, 합 3초)로 재시도한다.
const STATUS_RETRY_COUNT = 4;
// 재시도 대기 합(3초)을 넘기는 가짜 시간과 그 단계
const RETRY_EXHAUST_FAKE_MS = 5_000;
const RETRY_EXHAUST_STEP_MS = 100;
// EC-18: 60초를 넘기는 가짜 시간(10분). 단계는 viem http 요청 제한 시간(10초)과 상태 폴링 간격(4초)보다 짧다.
const LONG_BATCHING_MS = 10 * 60_000;
const LONG_BATCHING_STEP_MS = 3_000;
// EC-18 양성 대조 시점: 60초를 넘긴 시점 뒤에도 상태 조회가 이어졌는지 본다.
const PAST_DEFAULT_TIMEOUT_MS = 61_000;
// 정리 단계에서 다음 상태 폴링(4초 간격)이 오도록 진행하는 가짜 시간
const NEXT_POLL_FAKE_MS = 5_000;
const NEXT_POLL_STEP_MS = 1_000;

// 스펙 §4.1(F5) SwapRouter02 주소(리터럴)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
// 공식 토큰 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ARBITRUM_USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARBITRUM_DAI: Address = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1";
// 스텁 EIP-1193 계정 변경 표본의 두 번째 계정(계정 B)
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

type BatchChainId = typeof mainnet.id | typeof arbitrum.id;

// 체인별 표본 페어(보내는 USDC → 받는 DAI)와 스펙 F6 DoD-6의 탐색기 tx URL 접두(리터럴)
const FIXTURES: Record<BatchChainId, { tokenIn: Address; tokenOut: Address; explorer: string }> = {
  [mainnet.id]: {
    tokenIn: ETHEREUM_USDC,
    tokenOut: ETHEREUM_DAI,
    explorer: "https://etherscan.io/tx/",
  },
  [arbitrum.id]: {
    tokenIn: ARBITRUM_USDC,
    tokenOut: ARBITRUM_DAI,
    explorer: "https://arbiscan.io/tx/",
  },
};

// 보내는 USDC(decimals 6) 금액 1
const AMOUNT = "1";
// DoD-20 잔액 표본: 클릭 시점 100 USDC, 최종 상태 응답 뒤 80 USDC
const UNIT = 10n ** 6n;
const CLICK_BALANCE = 100n * UNIT;
const AFTER_BALANCE = 80n * UNIT;

type BatchOutcomeStatus = "success" | "reverted" | "receipt-failed" | "send-failed";
type ReceiptStatus = StubCallsReceipt["status"];

let rpc: BalanceRpcStub;
// 프로브가 커밋마다 부르는 기록 함수. 없으면 기록하지 않는다.
let onProbeCommit: ((probe: Probe) => void) | null = null;

beforeEach(() => {
  rpc = installBalanceRpcStub();
  onProbeCommit = null;
});

afterEach(() => {
  onProbeCommit = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
});

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다(config·스텁·QueryClient 새로 생성, 가짜 타이머 원복).
function resetSample() {
  cleanup();
  onProbeCommit = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// setTimeout·setInterval(과 짝인 clear*)만 가짜로 둔다.
function fakeTimeouts() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

// n번째 표본 receipt 트랜잭션 해시(리터럴 문자열의 keccak, 표본마다 서로 다르다)
function receiptHash(n: number): Hash {
  return keccak256(toHex(`gopepe-batch-progress-receipt-${n}`));
}

// 상태 표본의 receipt 목록. `first`부터 차례로 서로 다른 transactionHash를 단다.
function receiptsOf(statuses: readonly ReceiptStatus[], first: number): StubCallsReceipt[] {
  return statuses.map((status, index) => ({ status, transactionHash: receiptHash(first + index) }));
}

// ─── 대기 ─────────────────────────────────────────────────────────

type Waiter = (assertion: () => void) => Promise<void>;

const realWait: Waiter = (assertion) => waitUntil(assertion, READY_TIMEOUT_MS);
// 가짜 타이머(setTimeout 포함)를 켠 표본에서 쓴다. 확인 사이마다 가짜 시계를 조금씩 진행한다.
const fakeWait: Waiter = (assertion) =>
  waitUntilAdvancingFakeClock(assertion, FAKE_WAIT_STEP_MS, READY_TIMEOUT_MS);

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
  await realWait(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  fireEvent.click(optionRow(address));
  await realWait(() => expect(tokenModal()).toBeNull());
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await realWait(() => expect(amountInput().value).toBe(value));
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

function txStatusKind(): string | null {
  return txStatus().getAttribute("data-kind");
}

function txLink(): HTMLElement | null {
  return screen.queryByTestId("tx-link");
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  const value = { execution: useSwapExecution(), balances: useSwapFormBalances() };
  // 커밋마다(프로브가 다시 렌더링된 커밋) 기록한다.
  useLayoutEffect(() => {
    onProbeCommit?.(value);
  });
  return value;
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletCallsControl;
  config: ReturnType<typeof createWagmiConfig>;
  probe: () => Probe;
};

type ReadyOptions = {
  // 지갑 체인 = 선택 체인(기본 Ethereum)
  chainId?: BatchChainId;
  // 잔액 규칙(기본 `defaultBalance`)
  balances?: BalanceFn;
  // 주면 클릭 전에 보내는 토큰 카드 잔액이 이 값으로 읽히기를 기다린다.
  clickBalance?: bigint;
};

function allowanceReadDone(chainId: BatchChainId, token: Address): boolean {
  return rpc
    .requests(matchAllowance.query({ chainId, owner: TEST_ACCOUNT, token }))
    .some((request) => request.status === "ok");
}

// 공통 전제: 스텁 EIP-1193 지갑으로 표본 체인에 연결되어(지갑 체인 = 선택 체인) capabilities가 `atomic.status = "supported"`이고,
// 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 주 버튼이 활성 `batch-ready`가 될 때까지 기다린다.
async function renderBatchReady(options: ReadyOptions = {}): Promise<Scenario> {
  const chainId = options.chainId ?? mainnet.id;
  const fixture = FIXTURES[chainId];
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setAllowances(defaultAllowance);
  if (options.balances) rpc.setBalances(options.balances);
  const stub = createStubEip1193({
    chainId,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletCalls(stub);
  wallet.capabilities.reply(
    atomicCapabilities({ [mainnet.id]: "supported", [arbitrum.id]: "supported" }),
  );
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId: chainId });
  const probe = () => view.result.current;
  await realWait(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(chainId);
    expect(sameAddress(connection.address, TEST_ACCOUNT)).toBe(true);
  });
  await chooseToken("in", fixture.tokenIn);
  await chooseToken("out", fixture.tokenOut);
  await typeAmount(AMOUNT);
  await realWait(() => {
    expect(allowanceReadDone(chainId, fixture.tokenIn)).toBe(true);
    expect(
      wallet.capabilities.requestsFor(TEST_ACCOUNT, chainId).some((r) => r.status === "ok"),
    ).toBe(true);
    expect(primaryState()).toBe("batch-ready");
  });
  if (options.clickBalance !== undefined) {
    const expected = options.clickBalance;
    await realWait(() => expect(probe().balances.in).toBe(expected));
  }
  await settlePendingWork();
  expect(primaryState()).toBe("batch-ready");
  expect(primaryButton().disabled).toBe(false);
  expect(probe().execution.phase).toBe("idle");
  expect(probe().execution.result).toBeNull();
  return { stub, wallet, config, probe };
}

// ─── 실행과 결과 ──────────────────────────────────────────────────

// 결과가 기록되고 `idle`로 돌아오기를 기다린다.
async function awaitResult(s: Scenario, wait: Waiter = realWait) {
  await wait(() => {
    expect(s.probe().execution.result).not.toBeNull();
    expect(s.probe().execution.phase).toBe("idle");
  });
  await settlePendingWork();
}

async function clickAndAwaitResult(s: Scenario, wait: Waiter = realWait) {
  clickPrimary();
  await awaitResult(s, wait);
}

// 상태 조회 응답을 붙잡고 주 버튼을 눌러, 배치 id를 받은 `batching`에서 상태 조회가 붙잡힐 때까지 기다린다.
async function clickAndHoldStatus(s: Scenario): Promise<WalletHoldGate> {
  const gate = s.wallet.callsStatus.hold();
  clickPrimary();
  await realWait(() => {
    expect(s.wallet.sendCalls.ids()).toHaveLength(1);
    expect(s.probe().execution.phase).toBe("batching");
    expect(gate.heldCount).toBeGreaterThanOrEqual(1);
  });
  await settlePendingWork();
  expect(s.probe().execution.result).toBeNull();
  return gate;
}

// 붙잡은 상태 조회를 `reply`로 푼다. 반환값은 풀기 직전의 RPC 요청 순번(이후 요청이 "최종 상태 응답 뒤"의 요청)이다.
function releaseStatus(s: Scenario, gate: WalletHoldGate, reply: WalletCallsStatusReply): number {
  s.wallet.callsStatus.reply(reply);
  const seq = rpc.requests().length;
  gate.release();
  return seq;
}

// 상태 조회가 모두 응답했고 대기 중인 RPC 읽기가 없어질 때까지 기다린다.
async function waitReadsSettled(s: Scenario) {
  await realWait(() => {
    expect(s.wallet.callsStatus.requests.every((r) => r.status !== "pending")).toBe(true);
    expect(rpc.requests().every((r) => r.status !== "pending")).toBe(true);
  });
  await settlePendingWork();
}

// 1xx로 남겨 둔 배치를 끝낸다(다음 테스트로 폴링이 이어지지 않게 한다. 판정하지 않는다).
async function endPendingBatch(s: Scenario, fake: boolean) {
  s.wallet.callsStatus.reply(callsStatus(200, receiptsOf(["success"], 9_000)));
  if (fake) {
    await advanceFakeClockInSteps(NEXT_POLL_FAKE_MS, NEXT_POLL_STEP_MS);
    await awaitResult(s, fakeWait);
  } else {
    await awaitResult(s);
  }
}

function resultHash(result: TxResult | null): Hash | undefined {
  return result !== null && "hash" in result ? result.hash : undefined;
}

function resultChainId(result: TxResult | null): number | undefined {
  return result !== null && "chainId" in result ? result.chainId : undefined;
}

function hasBalanceDropped(result: TxResult | null): boolean {
  return result !== null && "balanceDropped" in result;
}

// 결과 status·kind와 tx-status data-status·data-kind를 함께 판정한다.
function expectBatchOutcome(s: Scenario, status: BatchOutcomeStatus, label: string) {
  const { result } = s.probe().execution;
  expect(result?.status, label).toBe(status);
  expect(result?.kind, label).toBe("batch");
  expect(txStatusValue(), `${label} data-status`).toBe(status);
  expect(txStatusKind(), `${label} data-kind`).toBe("batch");
}

// 표본 상태 응답마다 앱을 새로 만들어 클릭하고 결과를 판정한다.
async function expectFinalStatusOutcomes(
  samples: readonly { label: string; reply: WalletCallsStatusReply }[],
  expected: BatchOutcomeStatus,
) {
  for (const [index, sample] of samples.entries()) {
    if (index > 0) resetSample();
    const s = await renderBatchReady();
    s.wallet.callsStatus.reply(sample.reply);
    await clickAndAwaitResult(s);
    // 전제: 마지막 상태 조회가 표본 응답으로 응답했다.
    expect(s.wallet.callsStatus.requests.at(-1)?.reply, sample.label).toBe(sample.reply);
    expectBatchOutcome(s, expected, sample.label);
  }
}

// 최종 상태 응답 뒤(`seq` 이후) 연결 계정·Ethereum SwapRouter02·보내는 USDC의 allowance 읽기
function usdcAllowanceReadsSince(seq: number): BalanceRpcRequest[] {
  return rpc
    .requests(
      matchAllowance.query({
        chainId: mainnet.id,
        owner: TEST_ACCOUNT,
        spender: ETHEREUM_ROUTER,
        token: ETHEREUM_USDC,
      }),
    )
    .filter((request) => request.seq >= seq);
}

function isUsdcBalanceKey(query: BalanceQuery): boolean {
  return (
    query.chainId === mainnet.id &&
    sameAddress(query.account, TEST_ACCOUNT) &&
    sameAddress(query.token, ETHEREUM_USDC)
  );
}

// 연결 계정·Ethereum의 보내는 USDC 잔액 읽기(`balanceOf` 또는 그것을 묶은 aggregate3)
function isUsdcBalanceRequest(request: BalanceRpcRequest): boolean {
  return (
    request.chainId === mainnet.id &&
    (request.kind === "balanceOf" || request.kind === "aggregate3") &&
    sameAddress(request.account, TEST_ACCOUNT) &&
    request.tokens.some((token) => sameAddress(token, ETHEREUM_USDC))
  );
}

describe("배치 진행과 결과 — 사용자가 배치의 진행 상태와 최종 결과를 보고 다음 스왑을 이어 간다", () => {
  describe("진행 중", () => {
    /**
     * @spec DoD-12
     * @given 공통 전제에서 스텁은 wallet_sendCalls 응답을 붙잡아 둔다
     * @when 주 버튼을 누르고 wallet_sendCalls 요청이 기록되기를 기다린다(응답은 붙잡은 채)
     * @then useSwapExecution().phase가 `awaiting-signature`다
     */
    it(
      "[DoD-12] 배치 id를 받기 전에는 phase가 awaiting-signature다",
      async () => {
        const s = await renderBatchReady();
        const sendGate = s.wallet.sendCalls.hold();

        clickPrimary();
        await realWait(() => {
          expect(s.wallet.sendCalls.sent).toHaveLength(1);
          expect(sendGate.heldCount).toBe(1);
        });
        await settlePendingWork();

        // 전제: 응답은 붙잡혀 있어 배치 id가 아직 없다.
        expect(s.wallet.sendCalls.sent[0]!.id).toBeNull();
        expect(s.wallet.sendCalls.ids()).toHaveLength(0);
        expect(s.probe().execution.phase).toBe("awaiting-signature");

        // 정리: 붙잡은 응답을 풀어 결과까지 진행한다(판정하지 않는다).
        sendGate.release();
        await awaitResult(s);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-13 DoD-14 DoD-15
     * @given 공통 전제에서 wallet_sendCalls가 배치 id로 응답한다. 표본 상태 대기: wallet_getCallsStatus 응답을 붙잡아 둠, wallet_getCallsStatus가 상태 코드 100(receipt 없음)을 계속 응답함을 하나씩 반복한다
     * @when 주 버튼을 누르고 배치 id 응답 뒤 wallet_getCallsStatus 요청이 1건 이상 기록되기를 기다린다
     * @then useSwapExecution().phase가 `batching`이다
     * @then primary-button[data-state]가 `batching`이고 비활성(disabled)이다
     * @then tx-status[data-status]가 `pending`이고 data-kind가 `batch`다
     * @then tx-link가 없다
     */
    it(
      "[DoD-13][DoD-14][DoD-15] 배치 id를 받은 뒤 최종 상태 전까지 batching이고 pending·batch 상태에 링크가 없다",
      async () => {
        const samples = [
          { label: "상태 조회 응답 붙잡기", hold: true },
          { label: "상태 코드 100 계속 응답", hold: false },
        ] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderBatchReady();
          const gate = sample.hold ? s.wallet.callsStatus.hold() : undefined;
          if (!sample.hold) s.wallet.callsStatus.reply(callsStatus(100, null));

          clickPrimary();
          await realWait(() => {
            expect(s.wallet.sendCalls.ids(), sample.label).toHaveLength(1);
            const requests = s.wallet.callsStatus.requests;
            expect(requests.length, sample.label).toBeGreaterThanOrEqual(1);
            if (gate) expect(gate.heldCount, sample.label).toBeGreaterThanOrEqual(1);
            else
              expect(
                requests.some((r) => r.status === "ok"),
                sample.label,
              ).toBe(true);
          });
          await settlePendingWork();

          // 전제: 상태 조회는 지갑이 돌려준 배치 id로 했고 결과는 아직 없다.
          expect(s.wallet.callsStatus.requests[0]!.id, sample.label).toBe(
            s.wallet.sendCalls.ids()[0],
          );
          expect(s.probe().execution.result, sample.label).toBeNull();

          expect(s.probe().execution.phase, sample.label).toBe("batching");
          expect(primaryState(), sample.label).toBe("batching");
          expect(primaryButton().disabled, sample.label).toBe(true);
          expect(txStatusValue(), sample.label).toBe("pending");
          expect(txStatusKind(), sample.label).toBe("batch");
          expect(txLink(), sample.label).toBeNull();

          // 정리: 배치를 끝낸다(판정하지 않는다).
          if (gate) {
            s.wallet.callsStatus.reply(callsStatus(200, receiptsOf(["success"], 9_000)));
            gate.release();
            await awaitResult(s);
          } else {
            await endPendingBatch(s, false);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-18
     * @given 공통 전제에서 가짜 타이머(setTimeout·setInterval)를 켜고, wallet_getCallsStatus는 상태 코드 100과 1xx 대역 안 다른 값(199)을 receipt 없이 번갈아 계속 응답한다
     * @when 주 버튼을 눌러 phase가 `batching`이 된 뒤 가짜 시간을 60초를 넘겨(10분) 나눠 진행한다
     * @then 진행한 시간 내내와 끝에 useSwapExecution().phase가 `batching`이다
     * @then primary-button[data-state]가 `batching`이고 tx-status[data-status]가 `pending`·data-kind가 `batch`다
     * @then useSwapExecution().result가 null이다
     */
    it(
      "[EC-18] 상태 코드가 1xx인 동안에는 60초가 넘어도 batching을 유지한다",
      async () => {
        const s = await renderBatchReady();
        // 10분 동안의 폴링(4초 간격, 약 150회)보다 충분히 긴 100·199 교대 순서열
        const alternating = Array.from({ length: 1_000 }, (_, i) =>
          callsStatus(i % 2 === 0 ? 100 : 199, null),
        );
        s.wallet.callsStatus.reply(alternating);
        fakeTimeouts();

        clickPrimary();
        await fakeWait(() => {
          expect(s.probe().execution.phase).toBe("batching");
          expect(s.wallet.callsStatus.requests.some((r) => r.status === "ok")).toBe(true);
        });

        const answered = () => s.wallet.callsStatus.requests.filter((r) => r.status === "ok");
        const violations: string[] = [];
        const observe = (at: string) => {
          const { phase, result } = s.probe().execution;
          const view = {
            phase,
            primary: primaryState(),
            status: txStatusValue(),
            kind: txStatusKind(),
            result: result === null ? null : result.status,
          };
          if (
            view.phase !== "batching" ||
            view.primary !== "batching" ||
            view.status !== "pending" ||
            view.kind !== "batch" ||
            view.result !== null
          ) {
            violations.push(`${at}: ${JSON.stringify(view)}`);
          }
        };
        observe("0ms");
        let answeredPastDefaultTimeout: number | null = null;
        await advanceFakeClockInSteps(LONG_BATCHING_MS, LONG_BATCHING_STEP_MS, (elapsedMs) => {
          observe(`${elapsedMs}ms`);
          if (answeredPastDefaultTimeout === null && elapsedMs >= PAST_DEFAULT_TIMEOUT_MS) {
            answeredPastDefaultTimeout = answered().length;
          }
        });
        await settlePendingWork();

        // 전제(양성 대조): 60초를 넘긴 뒤에도 상태 조회가 이어졌고 100·199가 모두 응답됐다.
        expect(answeredPastDefaultTimeout).not.toBeNull();
        expect(answered().length).toBeGreaterThan(answeredPastDefaultTimeout ?? Infinity);
        const codes = new Set(
          answered().map((r) => (r.reply?.type === "status" ? r.reply.statusCode : undefined)),
        );
        expect(codes.has(100)).toBe(true);
        expect(codes.has(199)).toBe(true);

        expect(violations).toEqual([]);
        expect(s.probe().execution.phase).toBe("batching");
        expect(primaryState()).toBe("batching");
        expect(txStatusValue()).toBe("pending");
        expect(txStatusKind()).toBe("batch");
        expect(s.probe().execution.result).toBeNull();

        // 정리: 배치를 끝낸다(판정하지 않는다).
        await endPendingBatch(s, true);
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("배치가 성공한 경우", () => {
    /**
     * @spec DoD-16 DoD-18
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 receipt를 모두 `success`로 담아 최종 상태 코드를 응답한다. 표본 상태 코드: 200, 2xx 대역 안 다른 값(299)을 하나씩 반복하고, receipt는 2개다. 클릭 뒤 결과가 나올 때까지 선택 체인과 연결 계정을 바꾸지 않아 둘 다 클릭 시점과 같다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result가 kind `batch`, status `success`, chainId 1이고 balanceDropped 필드가 없다
     * @then tx-status[data-status]가 `success`이고 data-kind가 `batch`다
     * @then 보내는 금액 입력값이 빈 값이다
     */
    it(
      "[DoD-16][DoD-18] 2xx이고 receipt가 모두 success이면 결과는 success·batch이고 체인·계정이 같으면 금액을 비운다",
      async () => {
        const codes = [200, 299];
        for (const [index, code] of codes.entries()) {
          if (index > 0) resetSample();
          const label = `상태 코드 ${code}`;
          const s = await renderBatchReady();
          s.wallet.callsStatus.reply(callsStatus(code, receiptsOf(["success", "success"], 100)));

          await clickAndAwaitResult(s);

          // 전제: 클릭 시점과 같은 선택 체인·연결 계정이다.
          expect(screen.getByTestId("chain-select").getAttribute("data-selected-chain-id")).toBe(
            "1",
          );
          expect(sameAddress(getConnection(s.config).address, TEST_ACCOUNT), label).toBe(true);

          const { result } = s.probe().execution;
          expect(result?.kind, label).toBe("batch");
          expect(result?.status, label).toBe("success");
          expect(resultChainId(result), label).toBe(1);
          expect(hasBalanceDropped(result), label).toBe(false);
          expect(txStatusValue(), label).toBe("success");
          expect(txStatusKind(), label).toBe("batch");
          expect(amountInput().value, label).toBe("");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-22
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 상태 코드 200을 receipt 0개로 응답한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `success`이고 result.kind가 `batch`, result.chainId가 1이다
     * @then useSwapExecution().result에 hash가 없다
     * @then tx-status[data-status]가 `success`이고 data-kind가 `batch`다
     */
    it(
      "[EC-22] 2xx이고 receipt가 0개이면 결과는 success·batch다",
      async () => {
        const s = await renderBatchReady();
        s.wallet.callsStatus.reply(callsStatus(200, []));

        await clickAndAwaitResult(s);

        const { result } = s.probe().execution;
        expect(result?.status).toBe("success");
        expect(result?.kind).toBe("batch");
        expect(resultChainId(result)).toBe(1);
        expect(resultHash(result)).toBeUndefined();
        expect(txStatusValue()).toBe("success");
        expect(txStatusKind()).toBe("batch");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-17
     * @given 공통 전제에서 wallet_getCallsStatus가 receipt 2개 이상(서로 다른 transactionHash)을 담아 최종 상태를 응답한다. 표본: Ethereum(1)에서 200·receipt 2개 모두 success, Arbitrum(42161)에서 200·receipt 3개 모두 success, Ethereum에서 200·receipt 2개 중 마지막이 reverted, Ethereum에서 500·receipt 2개, Ethereum에서 300·receipt 2개(receipt-failed)를 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then tx-link의 href가 선택 체인 탐색기의 /tx/{마지막 receipt의 transactionHash} 리터럴이다(Ethereum https://etherscan.io/tx/{hash}, Arbitrum https://arbiscan.io/tx/{hash})
     * @then useSwapExecution().result.hash가 마지막 receipt의 transactionHash다
     */
    it(
      "[DoD-17] 배치 결과의 tx-link는 마지막 receipt 해시의 탐색기 주소다",
      async () => {
        const samples: {
          label: string;
          chainId: BatchChainId;
          code: number;
          statuses: ReceiptStatus[];
          first: number;
        }[] = [
          {
            label: "Ethereum 200 [success, success]",
            chainId: mainnet.id,
            code: 200,
            statuses: ["success", "success"],
            first: 200,
          },
          {
            label: "Arbitrum 200 [success, success, success]",
            chainId: arbitrum.id,
            code: 200,
            statuses: ["success", "success", "success"],
            first: 210,
          },
          {
            label: "Ethereum 200 [success, reverted]",
            chainId: mainnet.id,
            code: 200,
            statuses: ["success", "reverted"],
            first: 220,
          },
          {
            label: "Ethereum 500 [reverted, reverted]",
            chainId: mainnet.id,
            code: 500,
            statuses: ["reverted", "reverted"],
            first: 230,
          },
          {
            label: "Ethereum 300 [success, success]",
            chainId: mainnet.id,
            code: 300,
            statuses: ["success", "success"],
            first: 240,
          },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const lastHash = receiptHash(sample.first + sample.statuses.length - 1);
          const s = await renderBatchReady({ chainId: sample.chainId });
          s.wallet.callsStatus.reply(
            callsStatus(sample.code, receiptsOf(sample.statuses, sample.first)),
          );

          await clickAndAwaitResult(s);

          const { result } = s.probe().execution;
          // 전제: 결과는 배치 결과다.
          expect(result?.kind, sample.label).toBe("batch");
          expect(txLink()?.getAttribute("href"), sample.label).toBe(
            `${FIXTURES[sample.chainId].explorer}${lastHash}`,
          );
          expect(resultHash(result), sample.label).toBe(lastHash);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-18
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus 응답을 붙잡아 phase가 `batching`이고, 그동안 체인 드롭다운으로 선택 체인을 Arbitrum으로 바꾼 뒤 그 체인에서 보내는 금액을 다시 입력했다. 연결 계정은 바꾸지 않는다
     * @when 붙잡은 응답을 200·receipt 모두 success로 풀고 그로 생긴 읽기가 끝나기를 기다린다
     * @then 보내는 금액 입력값이 다시 입력한 값 그대로이고 빈 값이 되지 않는다
     */
    it(
      "[DoD-18] 배치 중 선택 체인이 바뀐 뒤 성공하면 보내는 금액을 유지한다",
      async () => {
        const s = await renderBatchReady();
        const gate = await clickAndHoldStatus(s);

        await chooseChainFromDropdown(arbitrum);
        await typeAmount(AMOUNT);
        await settlePendingWork();
        // 전제: 아직 batching이고 연결 계정은 그대로다.
        expect(s.probe().execution.phase).toBe("batching");
        expect(sameAddress(getConnection(s.config).address, TEST_ACCOUNT)).toBe(true);
        expect(amountInput().value).toBe(AMOUNT);

        releaseStatus(s, gate, callsStatus(200, receiptsOf(["success", "success"], 300)));
        await realWait(() => expect(s.probe().execution.phase).toBe("idle"));
        await waitReadsSettled(s);

        expect(amountInput().value).toBe(AMOUNT);
        expect(amountInput().value).not.toBe("");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-19
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus가 200·receipt 모두 success로 응답하고, allowance 스텁은 최종 상태 응답 뒤의 allowance 읽기에 maxUint256을 응답한다. capabilities는 계속 `atomic.status = "supported"`다
     * @when 주 버튼을 눌러 결과가 기록된 뒤 같은 페어(USDC→DAI)에 금액 `1`을 다시 입력하고 읽기가 끝나기를 기다린다
     * @then 최종 상태 응답 뒤 연결 계정·USDC·SwapRouter02의 allowance 읽기 요청이 기록된다
     * @then primary-button[data-state]가 `swap-ready`다
     */
    it(
      "[DoD-19] 배치 성공 뒤 allowance를 다시 읽어 같은 페어·금액을 다시 입력하면 swap-ready다",
      async () => {
        const s = await renderBatchReady();
        const gate = await clickAndHoldStatus(s);
        // 최종 상태 응답 뒤의 allowance 읽기는 maxUint256을 응답한다.
        rpc.setAllowances(
          allowanceWhen(
            {
              chainId: mainnet.id,
              owner: TEST_ACCOUNT,
              spender: ETHEREUM_ROUTER,
              token: ETHEREUM_USDC,
            },
            STUB_MAX_UINT256,
          ),
        );
        const seq = releaseStatus(
          s,
          gate,
          callsStatus(200, receiptsOf(["success", "success"], 400)),
        );
        await awaitResult(s);
        // 전제: 배치가 성공했고 페어는 USDC→DAI 그대로다.
        expect(s.probe().execution.result?.status).toBe("success");
        expect(sameAddress(tokenAddress("in") ?? undefined, ETHEREUM_USDC)).toBe(true);
        expect(sameAddress(tokenAddress("out") ?? undefined, ETHEREUM_DAI)).toBe(true);

        await realWait(() =>
          expect(usdcAllowanceReadsSince(seq).some((r) => r.status === "ok")).toBe(true),
        );
        expect(usdcAllowanceReadsSince(seq).length).toBeGreaterThan(0);

        await typeAmount(AMOUNT);
        await realWait(() => expect(primaryState()).toBe("swap-ready"));
        await settlePendingWork();
        expect(primaryState()).toBe("swap-ready");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("배치가 실패하거나 결과를 확인하지 못한 경우", () => {
    /**
     * @spec EC-12
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 2xx 상태 코드와 receipt 2개를 응답한다. 표본: 200·[success, reverted], 200·[reverted, success], 299·[success, reverted]를 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `reverted`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `reverted`이고 data-kind가 `batch`다
     */
    it(
      "[EC-12] 2xx여도 receipt 중 하나라도 reverted이면 결과는 reverted다",
      async () => {
        await expectFinalStatusOutcomes(
          [
            {
              label: "200 [success, reverted]",
              reply: callsStatus(200, receiptsOf(["success", "reverted"], 500)),
            },
            {
              label: "200 [reverted, success]",
              reply: callsStatus(200, receiptsOf(["reverted", "success"], 510)),
            },
            {
              label: "299 [success, reverted]",
              reply: callsStatus(299, receiptsOf(["success", "reverted"], 520)),
            },
          ],
          "reverted",
        );
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-13
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 5xx 상태 코드로 최종 상태를 응답한다. 표본 상태 코드: 500, 599를 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `reverted`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `reverted`이고 data-kind가 `batch`다
     */
    it(
      "[EC-13] 최종 상태 코드가 5xx이면 결과는 reverted다",
      async () => {
        await expectFinalStatusOutcomes(
          [500, 599].map((code) => ({ label: `상태 코드 ${code}`, reply: callsStatus(code) })),
          "reverted",
        );
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-14
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 6xx 상태 코드로 최종 상태를 응답한다. 표본 상태 코드: 600, 699를 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `reverted`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `reverted`이고 data-kind가 `batch`다
     */
    it(
      "[EC-14] 최종 상태 코드가 6xx이면 결과는 reverted다",
      async () => {
        await expectFinalStatusOutcomes(
          [600, 699].map((code) => ({ label: `상태 코드 ${code}`, reply: callsStatus(code) })),
          "reverted",
        );
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-15
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 4xx 상태 코드로 최종 상태를 응답한다. 표본 상태 코드: 400, 404를 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `send-failed`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `send-failed`이고 data-kind가 `batch`다
     */
    it(
      "[EC-15] 최종 상태 코드가 4xx이면 결과는 send-failed다",
      async () => {
        await expectFinalStatusOutcomes(
          [400, 404].map((code) => ({ label: `상태 코드 ${code}`, reply: callsStatus(code) })),
          "send-failed",
        );
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-16
     * @given 공통 전제(선택 체인 Ethereum)에서 가짜 타이머를 켜고 wallet_getCallsStatus는 상태 대기의 재시도가 소진될 때까지 매 요청을 계속 오류로 응답(throw)한다
     * @when 주 버튼을 누르고 상태 대기의 재시도가 모두 소진될 때까지 가짜 시간을 진행한 뒤 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `receipt-failed`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `receipt-failed`이고 data-kind가 `batch`다
     */
    it(
      "[EC-16] 상태 조회가 재시도(viem 기본) 뒤에도 throw하면 결과는 receipt-failed다",
      async () => {
        const s = await renderBatchReady();
        s.wallet.callsStatus.reply({ type: "error", code: RPC_INTERNAL_ERROR_CODE });
        fakeTimeouts();

        clickPrimary();
        await fakeWait(() => expect(s.wallet.callsStatus.requests.length).toBeGreaterThan(0));
        await advanceFakeClockInSteps(RETRY_EXHAUST_FAKE_MS, RETRY_EXHAUST_STEP_MS);
        await awaitResult(s, fakeWait);

        // 전제: 첫 요청과 viem 기본 재시도(4회)가 모두 오류로 끝났다.
        const requests = s.wallet.callsStatus.requests;
        expect(requests.length).toBeGreaterThanOrEqual(1 + STATUS_RETRY_COUNT);
        expect(requests.every((r) => r.status === "error")).toBe(true);

        expectBatchOutcome(s, "receipt-failed", "재시도 소진");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-16 DoD-16
     * @given 공통 전제(선택 체인 Ethereum)에서 가짜 타이머를 켜고, wallet_getCallsStatus가 viem 기본 재시도 횟수 안에서 throw한 뒤 200·receipt 모두 success로 응답한다. 표본 throw 횟수: 1회, 4회를 하나씩 반복한다
     * @when 주 버튼을 누르고 가짜 시간을 진행하며 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `success`이고 result.kind가 `batch`다
     * @then receipt-failed 결과가 기록되지 않는다
     */
    it(
      "[EC-16][DoD-16] 상태 조회가 재시도 횟수 안에서 throw한 뒤 성공하면 결과는 success·batch다",
      async () => {
        const throwCounts = [1, STATUS_RETRY_COUNT];
        for (const [index, times] of throwCounts.entries()) {
          if (index > 0) resetSample();
          const label = `throw ${times}회`;
          const s = await renderBatchReady();
          s.wallet.callsStatus.reply(
            throwCallsStatusThen(times, callsStatus(200, receiptsOf(["success", "success"], 600))),
          );
          const recorded: (string | null)[] = [];
          onProbeCommit = (probe) => {
            recorded.push(probe.execution.result?.status ?? null);
          };
          fakeTimeouts();

          clickPrimary();
          await advanceFakeClockInSteps(RETRY_EXHAUST_FAKE_MS, RETRY_EXHAUST_STEP_MS);
          await awaitResult(s, fakeWait);

          // 전제: 표본 횟수만큼 오류로 끝난 뒤 성공 응답을 받았다.
          const requests = s.wallet.callsStatus.requests;
          expect(
            requests.filter((r) => r.status === "error"),
            label,
          ).toHaveLength(times);
          expect(requests.at(-1)?.status, label).toBe("ok");

          const { result } = s.probe().execution;
          expect(result?.status, label).toBe("success");
          expect(result?.kind, label).toBe("batch");
          expect(recorded.length, `${label} 커밋 기록`).toBeGreaterThan(0);
          expect(recorded, label).not.toContain("receipt-failed");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-23
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 3xx 또는 700 이상의 상태 코드로 응답한다. 표본 상태 코드: 300, 399, 700, 999를 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `receipt-failed`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `receipt-failed`이고 data-kind가 `batch`다
     */
    it(
      "[EC-23] 최종 상태 코드가 3xx이거나 700 이상이면 결과는 receipt-failed다",
      async () => {
        await expectFinalStatusOutcomes(
          [300, 399, 700, 999].map((code) => ({
            label: `상태 코드 ${code}`,
            reply: callsStatus(code),
          })),
          "receipt-failed",
        );
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-24
     * @given 공통 전제(선택 체인 Ethereum)에서 wallet_getCallsStatus는 100 미만이거나 숫자가 아닌 상태 코드로 응답한다. 표본 상태 코드: 0, 99, 숫자가 아닌 문자열(`"abc"`), null을 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `receipt-failed`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `receipt-failed`이고 data-kind가 `batch`다
     */
    it(
      "[EC-24] 상태 코드가 100 미만이거나 숫자가 아니면 결과는 receipt-failed다",
      async () => {
        const codes: unknown[] = [0, 99, "abc", null];
        await expectFinalStatusOutcomes(
          codes.map((code) => ({
            label: `상태 코드 ${JSON.stringify(code)}`,
            reply: callsStatus(code),
          })),
          "receipt-failed",
        );
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-17
     * @given 공통 전제(선택 체인 Ethereum)에서 배치가 receipt 없이 끝난다. 표본(괄호는 전제로 두는 결과 종류이며 이 case에서 판정하지 않는다): wallet_getCallsStatus가 재시도 소진까지 throw(가짜 타이머, receipt-failed), 200·receipt 0개(success), 404·receipt 없음(send-failed), 500·receipt 없음(reverted), 300·receipt 없음(receipt-failed)을 하나씩 반복한다
     * @when 주 버튼을 누르고 useSwapExecution().result가 null이 아니게 기록되기를 기다린다
     * @then tx-link가 없다
     */
    it(
      "[EC-17] receipt 없이 끝난 배치 결과에는 tx-link가 없다",
      async () => {
        const samples: { label: string; reply: WalletCallsStatusReply; fake: boolean }[] = [
          {
            label: "재시도 소진까지 throw",
            reply: { type: "error", code: RPC_INTERNAL_ERROR_CODE },
            fake: true,
          },
          { label: "200·receipt 0개", reply: callsStatus(200, []), fake: false },
          { label: "404·receipt 없음", reply: callsStatus(404, null), fake: false },
          { label: "500·receipt 없음", reply: callsStatus(500, null), fake: false },
          { label: "300·receipt 없음", reply: callsStatus(300, null), fake: false },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderBatchReady();
          s.wallet.callsStatus.reply(sample.reply);
          if (sample.fake) {
            fakeTimeouts();
            clickPrimary();
            await advanceFakeClockInSteps(RETRY_EXHAUST_FAKE_MS, RETRY_EXHAUST_STEP_MS);
            await awaitResult(s, fakeWait);
          } else {
            await clickAndAwaitResult(s);
          }

          expect(s.probe().execution.result, sample.label).not.toBeNull();
          expect(txLink(), sample.label).toBeNull();
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-21
     * @given 공통 전제(선택 체인 Ethereum)에서 allowance 스텁은 최종 상태 응답 뒤의 allowance 읽기에도 보내는 금액보다 작은 값(0)을 응답하고 capabilities는 계속 `atomic.status = "supported"`다. 표본 최종 상태: 200·receipt [success, reverted], 500·receipt 없음을 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록된 뒤 allowance 다시 읽기가 끝나기를 기다린다
     * @then useSwapExecution().result.status가 `reverted`다
     * @then 최종 상태 응답 뒤 연결 계정·USDC·SwapRouter02의 allowance 읽기 요청이 기록된다
     * @then primary-button[data-state]가 `batch-ready`다
     */
    it(
      "[EC-21] 배치가 reverted이면 다시 읽은 allowance로 주 버튼은 batch-ready다",
      async () => {
        const samples: { label: string; reply: WalletCallsStatusReply }[] = [
          {
            label: "200·[success, reverted]",
            reply: callsStatus(200, receiptsOf(["success", "reverted"], 700)),
          },
          { label: "500·receipt 없음", reply: callsStatus(500, null) },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          // allowance 규칙은 공통 전제의 0(`defaultAllowance`)을 최종 상태 응답 뒤에도 유지한다.
          const s = await renderBatchReady();
          const gate = await clickAndHoldStatus(s);
          const seq = releaseStatus(s, gate, sample.reply);
          await awaitResult(s);

          expect(s.probe().execution.result?.status, sample.label).toBe("reverted");

          await realWait(() =>
            expect(usdcAllowanceReadsSince(seq).some((r) => r.status === "ok")).toBe(true),
          );
          await waitReadsSettled(s);
          expect(usdcAllowanceReadsSince(seq).length, sample.label).toBeGreaterThan(0);
          await realWait(() => expect(primaryState()).toBe("batch-ready"));
          expect(primaryState(), sample.label).toBe("batch-ready");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("결과의 부가 표시와 결과 반영 조건", () => {
    /**
     * @spec DoD-20
     * @given 공통 전제(선택 체인 Ethereum)에서 클릭 시점 보내는 USDC 잔액을 알고, 잔액 스텁은 최종 상태 응답 뒤의 잔액 읽기에 클릭 시점 잔액보다 작은 값을 응답한다. 표본(괄호는 전제로 두는 결과 종류이며 이 case에서 판정하지 않는다): 200·receipt 모두 success(success), 200·[success, reverted](reverted)를 하나씩 반복한다
     * @when 주 버튼을 누르고 useSwapExecution().result가 null이 아니게 기록된 뒤 결과로 생긴 잔액 읽기가 끝나기를 기다린다
     * @then tx-balance-notice가 없다
     * @then useSwapExecution().result에 balanceDropped 필드가 없다
     */
    it(
      "[DoD-20] 배치 결과에는 tx-balance-notice가 없다",
      async () => {
        const samples: { label: string; reply: WalletCallsStatusReply }[] = [
          {
            label: "200·[success, success]",
            reply: callsStatus(200, receiptsOf(["success", "success"], 800)),
          },
          {
            label: "200·[success, reverted]",
            reply: callsStatus(200, receiptsOf(["success", "reverted"], 810)),
          },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const control = { afterFinal: false };
          const balances: BalanceFn = (query) =>
            isUsdcBalanceKey(query)
              ? control.afterFinal
                ? AFTER_BALANCE
                : CLICK_BALANCE
              : defaultBalance(query);
          const s = await renderBatchReady({ balances, clickBalance: CLICK_BALANCE });
          const gate = await clickAndHoldStatus(s);
          // 최종 상태 응답 뒤의 잔액 읽기는 클릭 시점보다 작은 값을 응답한다.
          control.afterFinal = true;
          const seq = releaseStatus(s, gate, sample.reply);
          await awaitResult(s);

          await realWait(() => {
            expect(
              rpc
                .requests()
                .some((r) => r.seq >= seq && isUsdcBalanceRequest(r) && r.status === "ok"),
            ).toBe(true);
            expect(s.probe().balances.in).toBe(AFTER_BALANCE);
          });
          await waitReadsSettled(s);

          // 전제: 결과가 남아 있다.
          expect(s.probe().execution.result, sample.label).not.toBeNull();
          expect(screen.queryByTestId("tx-balance-notice"), sample.label).toBeNull();
          expect(hasBalanceDropped(s.probe().execution.result), sample.label).toBe(false);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-20 DoD-18
     * @given 공통 전제(선택 체인 Ethereum, 계정 A)에서 wallet_getCallsStatus 응답을 붙잡아 phase가 `batching`이다. 표본: 계정 B로 바꾼 뒤 붙잡은 응답을 200·receipt 모두 success로 풂, 계정 B로 바꾼 뒤 500으로 풂, 계정 B로 바꾸고 붙잡은 응답을 200·receipt 모두 success로 푼 뒤 계정 A로 되돌림을 하나씩 반복한다
     * @when 표본의 계정 변경과 응답 풀기를 하고 그로 생긴 읽기가 끝나기를 기다린다
     * @then 응답을 푼 뒤와 계정을 되돌린 뒤 useSwapExecution().result가 null이다
     * @then 응답을 푼 뒤와 계정을 되돌린 뒤 tx-status[data-status]가 `none`이다
     * @then 계정 B로 바꾼 뒤 200·success로 푼 표본에서 보내는 금액 입력값이 클릭 시점 값(`1`) 그대로다
     */
    it(
      "[EC-20][DoD-18] batching 중 연결 계정이 바뀌면 그 배치의 결과를 반영하지 않고 금액을 비우지 않는다",
      async () => {
        const samples: {
          label: string;
          reply: WalletCallsStatusReply;
          restore: boolean;
          success: boolean;
        }[] = [
          {
            label: "계정 B → 200·success",
            reply: callsStatus(200, receiptsOf(["success", "success"], 900)),
            restore: false,
            success: true,
          },
          { label: "계정 B → 500", reply: callsStatus(500, null), restore: false, success: false },
          {
            label: "계정 B → 200·success → 계정 A",
            reply: callsStatus(200, receiptsOf(["success", "success"], 910)),
            restore: true,
            success: true,
          },
        ];
        const switchAccount = async (s: Scenario, account: Address) => {
          act(() => {
            s.stub.changeAccounts([account]);
          });
          await realWait(() =>
            expect(sameAddress(getConnection(s.config).address, account)).toBe(true),
          );
          await settlePendingWork();
        };
        const expectNotReflected = (s: Scenario, label: string) => {
          expect(s.probe().execution.result, label).toBeNull();
          expect(txStatusValue(), label).toBe("none");
        };
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderBatchReady();
          const gate = await clickAndHoldStatus(s);

          await switchAccount(s, SECOND_ACCOUNT);
          releaseStatus(s, gate, sample.reply);
          await waitReadsSettled(s);

          expectNotReflected(s, `${sample.label} 응답을 푼 뒤`);
          if (sample.success) {
            expect(amountInput().value, `${sample.label} 응답을 푼 뒤 금액`).toBe(AMOUNT);
          }

          if (sample.restore) {
            await switchAccount(s, TEST_ACCOUNT);
            await waitReadsSettled(s);
            expectNotReflected(s, `${sample.label} 되돌린 뒤`);
            expect(amountInput().value, `${sample.label} 되돌린 뒤 금액`).toBe(AMOUNT);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
