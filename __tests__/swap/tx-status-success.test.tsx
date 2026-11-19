import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { useLayoutEffect } from "react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { type TxResult, useSwapExecution } from "@/providers/swap-execution-provider";
import { useSwapFormBalances } from "@/providers/swap-form-provider";

import {
  type AllowanceFn,
  type BalanceQuery,
  type BalanceRpcStub,
  type HoldGate,
  type RequestMatcher,
  STUB_MAX_UINT256,
  allowanceAlways,
  allowanceWhen,
  defaultAllowance,
  installBalanceRpcStub,
  match,
  matchAllowance,
  matchReceipt,
  parityQuoteRule,
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
  advanceFakeTimeTo,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  decodeApproveCalldata,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 tx-status의 data-status·data-kind, tx-link의 href, tx-balance-notice의 유무로 판정한다.
// useSwapExecution()의 phase·pendingTx·result는 앱 Provider 안의 프로브로 읽고, phase·result 변화는 커밋마다 기록한다.
// mock 경계(F5 T-9 경계 + 잔액 값 바꾸기·붙잡기·실패): 스텁 EIP-1193 지갑(eth_sendTransaction 해시 응답·붙잡기, 체인 전환),
// 전역 fetch URL 라우팅 RPC 스텁(견적 aggregate3, 잔액 값 바꾸기·붙잡기·실패, allowance 응답·붙잡기, 영수증 성공·붙잡기), 가짜 타이머. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다.
// 기대 result·href·해시·체인 ID·주소는 제품 config를 쓰지 않고 리터럴로 적는다.
// 잔액 판정은 카드 잔액 주기 타이머(setInterval)와 시계만 가짜로 두어, 테스트가 진행시키지 않으면 주기 다시 읽기가 일어나지 않게 한다.
// "보내는 토큰 키"는 트랜잭션 체인·연결 계정·클릭 시점 보내는 토큰의 카드 잔액(`balanceOf`) 요청이다.
// 영수증 응답을 붙잡아 두고, 풀기 직전에 보내는 토큰 키의 응답을 "영수증 뒤" 값으로 바꾼다. 그 뒤 생긴 요청이 "영수증 뒤 새로 생긴 요청"이다.

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;

// 카드 잔액 주기(F2 15초)
const CARD_BALANCE_INTERVAL_MS = 15_000;

// 공식 주소(리터럴)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ARBITRUM_USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARBITRUM_DAI: Address = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1";

// 스펙 DoD-6의 탐색기 tx URL 접두(리터럴)
const TX_EXPLORER: Partial<Record<SupportedChainId, string>> = {
  [mainnet.id]: "https://etherscan.io/tx/",
  [arbitrum.id]: "https://arbiscan.io/tx/",
};

// 보내는 토큰(USDC·USDT, decimals 6) 잔액 표본. 스펙 표본의 100·80·90·120·150을 토큰 단위로 쓴다.
const UNIT = 10n ** 6n;
const CLICK_BALANCE = 100n * UNIT;
const BALANCE_80 = 80n * UNIT;
const BALANCE_90 = 90n * UNIT;
const BALANCE_120 = 120n * UNIT;
const BALANCE_150 = 150n * UNIT;

type TxKind = "approve" | "swap";
const TX_KINDS: readonly TxKind[] = ["approve", "swap"];
const READY_STATE = { approve: "approve-required", swap: "swap-ready" } as const;
const PROGRESS = { approve: "approving", swap: "swapping" } as const;

type PairSample = {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amount: string;
  allowance: AllowanceFn;
};

// Ethereum USDC → DAI, 금액 1, allowance 0(approve-required)
const ETHEREUM_APPROVE: PairSample = {
  chainId: mainnet.id,
  tokenIn: ETHEREUM_USDC,
  tokenOut: ETHEREUM_DAI,
  amount: "1",
  allowance: defaultAllowance,
};

// Ethereum USDT(allowance 초기화 대상) → DAI, 금액 10(amountInRaw 10_000_000), allowance 1_000_000(0 < allowance < amountInRaw)
const USDT_PARTIAL: PairSample = {
  chainId: mainnet.id,
  tokenIn: ETHEREUM_USDT,
  tokenOut: ETHEREUM_DAI,
  amount: "10",
  allowance: allowanceWhen(
    { chainId: mainnet.id, owner: TEST_ACCOUNT, spender: ETHEREUM_ROUTER, token: ETHEREUM_USDT },
    1_000_000n,
  ),
};

// 성공 결과 표본: 체인별 USDC → DAI, 금액 1. approve는 allowance 0, swap은 maxUint256이다.
function successSample(kind: TxKind, chainId: SupportedChainId): PairSample {
  const pair =
    chainId === arbitrum.id
      ? { tokenIn: ARBITRUM_USDC, tokenOut: ARBITRUM_DAI }
      : { tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_DAI };
  return {
    chainId,
    ...pair,
    amount: "1",
    allowance: kind === "approve" ? defaultAllowance : allowanceAlways(STUB_MAX_UINT256),
  };
}

let rpc: BalanceRpcStub;

// 프로브가 커밋마다 부르는 기록 함수(DoD-10). 없으면 기록하지 않는다.
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

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  onProbeCommit = null;
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

function txLinkHref(): string | null {
  return screen.queryByTestId("tx-link")?.getAttribute("href") ?? null;
}

function balanceNotice(): HTMLElement | null {
  return screen.queryByTestId("tx-balance-notice");
}

// ─── 잔액 응답 제어 ───────────────────────────────────────────────

// 보내는 토큰 키(트랜잭션 체인·연결 계정·클릭 시점 보내는 토큰)의 카드 잔액 요청
function sendTokenKey(chainId: SupportedChainId, token: Address): RequestMatcher {
  return match.chain(chainId, match.account(TEST_ACCOUNT, match.balanceOfToken(token)));
}

type SendBalanceControl = {
  key: RequestMatcher;
  // "pre"는 영수증 응답 전, "after"는 영수증 뒤(풀기 직전에 바꾼다)
  phase: "pre" | "after";
  // 영수증 전 보내는 토큰 키 응답
  pre: bigint;
  // 영수증 전 보내는 토큰 키 요청을 실패시킨다
  preFail: boolean;
  // 영수증 뒤 보내는 토큰 키 응답. "fail"이면 실패시킨다
  after: bigint | "fail";
  // 그 밖의 키(다른 체인·계정·토큰) 응답
  others: bigint;
};

// 보내는 토큰 키와 그 밖의 키의 잔액 응답을 테스트가 바꿀 수 있게 설치한다. 기본은 모두 클릭 시점 잔액이다.
function installSendBalance(sample: PairSample): SendBalanceControl {
  const control: SendBalanceControl = {
    key: sendTokenKey(sample.chainId, sample.tokenIn),
    phase: "pre",
    pre: CLICK_BALANCE,
    preFail: false,
    after: CLICK_BALANCE,
    others: CLICK_BALANCE,
  };
  const isKey = (query: BalanceQuery) =>
    query.chainId === sample.chainId &&
    sameAddress(query.account, TEST_ACCOUNT) &&
    sameAddress(query.token, sample.tokenIn);
  rpc.setBalances((query) => {
    if (!isKey(query)) return control.others;
    if (control.phase === "pre" || control.after === "fail") return control.pre;
    return control.after;
  });
  rpc.failWhen(
    (request) =>
      control.key(request) &&
      (control.phase === "pre" ? control.preFail : control.after === "fail"),
  );
  return control;
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
  wallet: WalletTransactionControl;
  balance: SendBalanceControl;
  probe: () => Probe;
};

// 주기 타이머·시계를 가짜로 두고, 스텁 EIP-1193 지갑으로 표본 체인에 연결되어(지갑 체인 = 선택 체인) 표본 페어와 금액을 입력해
// 주 버튼이 표본의 준비 상태이고 활성이 될 때까지 기다린다. `balanceKnown`이면 클릭 시점 보내는 토큰 잔액(100)이 읽혀 있다.
async function renderReady(
  kind: TxKind,
  sample: PairSample,
  {
    balanceKnown = true,
    prepare,
  }: { balanceKnown?: boolean; prepare?: (balance: SendBalanceControl) => void } = {},
): Promise<Scenario> {
  fakePeriodicTimers();
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setAllowances(sample.allowance);
  const balance = installSendBalance(sample);
  prepare?.(balance);
  const stub = createStubEip1193({
    chainId: sample.chainId,
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
  const view = renderAppHook(useProbe, { config, initialChainId: sample.chainId });
  const probe = () => view.result.current;
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(sample.chainId);
  }, READY_TIMEOUT_MS);
  await chooseToken("in", sample.tokenIn);
  await chooseToken("out", sample.tokenOut);
  await typeAmount(sample.amount);
  await waitUntil(() => expect(primaryState()).toBe(READY_STATE[kind]), READY_TIMEOUT_MS);
  if (balanceKnown) {
    // 전제: 클릭 시점의 보내는 토큰 잔액을 읽어 두었다.
    await waitUntil(() => expect(probe().balances.in).toBe(CLICK_BALANCE), READY_TIMEOUT_MS);
  }
  await settlePendingWork();
  expect(primaryState()).toBe(READY_STATE[kind]);
  expect(primaryButton().disabled).toBe(false);
  return { stub, wallet, balance, probe };
}

// 영수증 응답을 붙잡고 주 버튼을 눌러, 해시를 받은 진행 phase에서 영수증 조회가 붙잡힐 때까지 기다린다.
async function clickAndHoldReceipt(s: Scenario, kind: TxKind): Promise<HoldGate> {
  const receiptGate = rpc.holdReceipt();
  clickPrimary();
  await waitUntil(() => expect(s.probe().execution.phase).toBe(PROGRESS[kind]), READY_TIMEOUT_MS);
  await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
  await settlePendingWork();
  // 전제: 지갑이 해시를 돌려줬고 영수증 전에는 결과가 없다.
  expect(s.wallet.hashes()).toEqual([stubTransactionHash(1)]);
  expect(s.probe().execution.result).toBeNull();
  return receiptGate;
}

// 보내는 토큰 키 응답을 영수증 뒤 값으로 바꾸고 붙잡은 영수증을 성공으로 푼다. 반환값은 풀기 직전의 요청 순번이다.
function releaseReceipt(s: Scenario, receiptGate: HoldGate): number {
  s.balance.phase = "after";
  const seq = rpc.requests().length;
  receiptGate.release();
  return seq;
}

async function awaitResult(s: Scenario) {
  await waitUntil(() => {
    expect(s.probe().execution.result).not.toBeNull();
    expect(s.probe().execution.phase).toBe("idle");
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
}

// approving 중 보내는 토큰 키의 주기 다시 읽기(15초)가 `value`를 돌려주게 하고, 카드 잔액이 그 값이 될 때까지 기다린다.
async function periodicReadDuringApproving(s: Scenario, value: bigint) {
  s.balance.pre = value;
  const seq = rpc.requests().length;
  await advanceFakeTimeTo(Date.now() + CARD_BALANCE_INTERVAL_MS);
  await waitUntil(() => expect(s.probe().balances.in).toBe(value), READY_TIMEOUT_MS);
  // 전제: 클릭 뒤 영수증 전에 보내는 토큰 키를 다시 읽었고 approving이다.
  expect(
    rpc.requests(match.since(seq, s.balance.key)).some((request) => request.status === "ok"),
  ).toBe(true);
  expect(s.probe().execution.phase).toBe("approving");
}

function newKeyRequests(s: Scenario, seq: number) {
  return rpc.requests(match.since(seq, s.balance.key));
}

function approveSuccess(chainId: SupportedChainId, balanceDropped: boolean): TxResult {
  return {
    kind: "approve",
    status: "success",
    chainId,
    hash: stubTransactionHash(1),
    balanceDropped,
  };
}

describe("트랜잭션 성공 — approve·swap이 성공하면 결과와 탐색기 링크를 보고, approve 뒤 보내는 토큰 잔액이 줄었으면 안내를 받는다", () => {
  describe("성공 결과", () => {
    /**
     * @spec DoD-7 DoD-8 DoD-9
     * @given 스텁 지갑이 트랜잭션 체인에 연결돼 있고 선택 체인도 그 체인이며, eth_sendTransaction에 해시로 응답하고 영수증은 성공이다. approve 표본은 영수증 뒤 다시 읽은 보내는 토큰 잔액이 클릭 시점 잔액과 같다. 표본: 종류(approve-required에서 approve, swap-ready에서 swap) × 트랜잭션 체인(Ethereum 1, Arbitrum 42161)을 하나씩 반복한다
     * @when 주 버튼을 눌러 영수증 성공을 받고, approve 표본은 allowance·잔액 다시 읽기가 끝나기를, swap 표본은 phase가 idle로 돌아가기를 기다린다
     * @then approve 표본의 useSwapExecution().result는 리터럴 { kind: "approve", status: "success", chainId: 표본 체인 ID, hash: 지갑이 돌려준 해시, balanceDropped: false }와 같다(다른 필드가 없다)
     * @then swap 표본의 useSwapExecution().result는 리터럴 { kind: "swap", status: "success", chainId: 표본 체인 ID, hash: 지갑이 돌려준 해시 }와 같다(balanceDropped를 포함한 다른 필드가 없다)
     * @then tx-status[data-status]는 success이고 data-kind는 표본의 종류(approve 표본은 approve, swap 표본은 swap)다
     * @then tx-link의 href는 표본 체인 탐색기의 /tx/{체결된 트랜잭션 해시} 리터럴이다(Ethereum https://etherscan.io/tx/{hash}, Arbitrum https://arbiscan.io/tx/{hash}, hash는 지갑이 돌려주고 영수증이 성공한 해시)
     */
    it(
      "[DoD-7][DoD-8][DoD-9] approve·swap 영수증이 성공이면 종류별 성공 결과를 기록해 success로 표시하고 tx 체인 탐색기의 체결 해시를 링크한다",
      async () => {
        const chains: readonly SupportedChainId[] = [mainnet.id, arbitrum.id];
        let sampleCount = 0;
        for (const kind of TX_KINDS) {
          for (const chainId of chains) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${kind} — ${chainId}`;
            const s = await renderReady(kind, successSample(kind, chainId));
            const hash = stubTransactionHash(1);

            clickPrimary();
            await awaitResult(s);

            // 전제: 지갑이 돌려준 해시의 영수증을 트랜잭션 체인에서 성공으로 받았다.
            expect(s.wallet.hashes(), label).toEqual([hash]);
            expect(
              rpc
                .requests(
                  match.chain(
                    chainId,
                    matchReceipt.hash(hash, matchReceipt.method("eth_getTransactionReceipt")),
                  ),
                )
                .some((request) => request.status === "ok"),
              label,
            ).toBe(true);

            const expected =
              kind === "approve"
                ? { kind: "approve", status: "success", chainId, hash, balanceDropped: false }
                : { kind: "swap", status: "success", chainId, hash };
            expect(s.probe().execution.result, label).toStrictEqual(expected);
            expect(txStatus().getAttribute("data-status"), label).toBe("success");
            expect(txStatus().getAttribute("data-kind"), label).toBe(kind);
            expect(txLinkHref(), label).toBe(`${TX_EXPLORER[chainId]}${hash}`);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("approve 성공 뒤 다시 읽기", () => {
    /**
     * @spec DoD-10
     * @given approve-required에서 approve 영수증이 성공으로 나온다. 표본: allowance 다시 읽기 응답만 붙잡고 잔액 다시 읽기는 응답함, 보내는 토큰 잔액 다시 읽기 응답만 붙잡고 allowance 다시 읽기는 응답함을 하나씩 반복한다
     * @when 주 버튼을 눌러 approve 영수증 성공을 받고, 붙잡지 않은 쪽 다시 읽기가 끝나기를 기다린다
     * @then 붙잡은 응답이 남아 있는 동안 phase는 approving을 유지한다
     * @then 붙잡은 응답이 남아 있는 동안 useSwapExecution().result는 null이다
     */
    it(
      "[DoD-10] allowance와 잔액 중 하나라도 다시 읽는 중이면 approving을 유지하고 결과를 기록하지 않는다",
      async () => {
        const samples = ["allowance 다시 읽기만 붙잡음", "잔액 다시 읽기만 붙잡음"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderReady("approve", ETHEREUM_APPROVE);
          const receiptGate = await clickAndHoldReceipt(s, "approve");
          const seq = rpc.requests().length;
          const holdingAllowance = sample === "allowance 다시 읽기만 붙잡음";
          const gate = holdingAllowance
            ? rpc.holdAllowance()
            : rpc.hold(match.since(seq, s.balance.key));

          releaseReceipt(s, receiptGate);
          await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
          // 붙잡지 않은 쪽 다시 읽기가 끝나기를 기다린다.
          const other = holdingAllowance ? s.balance.key : matchAllowance.any;
          await waitUntil(
            () =>
              expect(
                rpc.requests(match.since(seq, other)).some((request) => request.status === "ok"),
              ).toBe(true),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork(10);

          // 전제: 영수증은 성공으로 받았고 붙잡은 다시 읽기는 아직 응답하지 않았다.
          // 붙잡혔던 영수증 조회는 `seq` 이전에 생긴 요청이므로 범위를 나누지 않고 지갑이 돌려준 해시의 조회 전체에서 본다.
          expect(
            rpc
              .requests(
                matchReceipt.hash(
                  stubTransactionHash(1),
                  matchReceipt.method("eth_getTransactionReceipt"),
                ),
              )
              .some((request) => request.status === "ok"),
            sample,
          ).toBe(true);
          const held = holdingAllowance ? matchAllowance.any : s.balance.key;
          expect(
            rpc.requests(match.since(seq, held)).map((request) => request.status),
            sample,
          ).not.toContain("ok");

          expect(s.probe().execution.phase, sample).toBe("approving");
          expect(s.probe().execution.result, sample).toBeNull();

          gate.release();
          await awaitResult(s);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-10
     * @given approve-required에서 approve 영수증이 성공으로 나오고, allowance 다시 읽기와 보내는 토큰 잔액 다시 읽기 응답을 모두 붙잡았다. phase·result를 커밋마다 기록한다
     * @when 붙잡은 두 응답을 모두 풀어 다시 읽기가 끝나게 한다
     * @then phase가 approving에서 idle로 바뀌는 커밋과 result가 null에서 approve 성공 결과로 바뀌는 커밋이 같다
     * @then 기록 중 phase가 idle이고 result가 null인 커밋, phase가 approving이고 result가 null이 아닌 커밋이 없다
     */
    it(
      "[DoD-10] allowance와 잔액을 모두 다시 읽은 뒤 idle 전환과 결과 기록이 같은 커밋에서 일어난다",
      async () => {
        const s = await renderReady("approve", ETHEREUM_APPROVE);
        const receiptGate = await clickAndHoldReceipt(s, "approve");
        const seq = rpc.requests().length;
        const allowanceGate = rpc.holdAllowance();
        const balanceGate = rpc.hold(match.since(seq, s.balance.key));

        releaseReceipt(s, receiptGate);
        await waitUntil(() => {
          expect(allowanceGate.heldCount).toBeGreaterThan(0);
          expect(balanceGate.heldCount).toBeGreaterThan(0);
        }, READY_TIMEOUT_MS);
        await settlePendingWork();
        expect(s.probe().execution.phase).toBe("approving");
        expect(s.probe().execution.result).toBeNull();

        const commits: { phase: string; result: TxResult | null }[] = [];
        onProbeCommit = (probe) => {
          commits.push({ phase: probe.execution.phase, result: probe.execution.result });
        };

        // 두 응답을 차례로 푼다.
        allowanceGate.release();
        await settlePendingWork(10);
        balanceGate.release();
        await awaitResult(s);
        onProbeCommit = null;

        const idleAt = commits.findIndex((commit) => commit.phase === "idle");
        const resultAt = commits.findIndex((commit) => commit.result !== null);
        expect(idleAt).toBeGreaterThanOrEqual(0);
        expect(resultAt).toBe(idleAt);
        expect(commits[resultAt]!.result).toStrictEqual(approveSuccess(mainnet.id, false));
        expect(
          commits.filter((commit) => commit.phase === "idle" && commit.result === null),
        ).toEqual([]);
        expect(
          commits.filter((commit) => commit.phase === "approving" && commit.result !== null),
        ).toEqual([]);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("잔액 감소 안내", () => {
    /**
     * @spec DoD-11 EC-17
     * @given 스텁 지갑이 연결돼 있고 approve-required이며 클릭 시점 보내는 토큰 잔액을 안다. 잔액 스텁은 영수증 응답 전까지의 잔액 요청에는 클릭 시점 잔액을, 영수증 뒤 새로 생긴 트랜잭션 체인·계정·클릭 시점 보내는 토큰 키의 잔액 요청에는 클릭 시점 잔액보다 작은 값을, 그 밖의 키(다른 체인·계정·토큰)의 잔액 요청에는 클릭 시점 잔액 이상의 값을 응답한다. 표본: Ethereum ERC-20 approve, Ethereum ERC-20 approve에서 클릭과 영수증 사이(approving 중)의 잔액 읽기(15초 주기 등)가 클릭 시점과 다른 값을 돌려주는 표본(클릭 시점 100, approving 중 읽기 80, 영수증 뒤 다시 읽기 90. 이 표본만 영수증 전 읽기가 클릭 시점과 다르다), approving 중 체인 선택 드롭다운으로 선택 체인을 트랜잭션 체인과 다른 체인으로 바꾼 뒤 영수증이 나오는 approve, approving 중 보내는 칸 토큰을 다른 토큰으로 바꾼 뒤 영수증이 나오는 approve(클릭 시점 토큰 키는 작은 값, 바꾼 토큰 키는 클릭 시점 잔액 이상), Ethereum USDT(0xdAC17F958D2ee523a2206206994597C13D831ec7)를 보내고 0 < allowance < amountInRaw라 approve-required 클릭이 approve(swapRouter02, 0)을 보내는 표본을 하나씩 반복한다
     * @when 주 버튼을 눌러 approve 영수증 성공을 받고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.balanceDropped는 true다
     * @then tx-balance-notice가 보인다
     */
    it(
      "[DoD-11][EC-17] approve 성공 뒤 다시 읽은 잔액이 클릭 시점보다 작으면 잔액 감소 안내를 보인다",
      async () => {
        const samples = [
          "Ethereum ERC-20 approve",
          "approving 중 읽기 80",
          "approving 중 선택 체인 변경",
          "approving 중 보내는 토큰 변경",
          "Ethereum USDT approve(0)",
        ] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const pair = sample === "Ethereum USDT approve(0)" ? USDT_PARTIAL : ETHEREUM_APPROVE;
          const s = await renderReady("approve", pair);
          const receiptGate = await clickAndHoldReceipt(s, "approve");
          if (sample === "Ethereum USDT approve(0)") {
            // 전제: 보낸 것은 USDT 컨트랙트로 보낸 approve(swapRouter02, 0)이다.
            expect(sameAddress(s.wallet.sent[0]!.to, ETHEREUM_USDT), sample).toBe(true);
            const decoded = decodeApproveCalldata(s.wallet.sent[0]!.data!);
            expect(sameAddress(decoded.spender, ETHEREUM_ROUTER), sample).toBe(true);
            expect(decoded.amount, sample).toBe(0n);
          }

          if (sample === "approving 중 읽기 80") {
            await periodicReadDuringApproving(s, BALANCE_80);
          } else if (sample === "approving 중 선택 체인 변경") {
            await chooseChainFromDropdown(base);
            await settlePendingWork();
            expect(s.probe().execution.phase, sample).toBe("approving");
          } else if (sample === "approving 중 보내는 토큰 변경") {
            await chooseToken("in", ETHEREUM_WETH);
            expect(sameAddress(tokenAddress("in") ?? undefined, ETHEREUM_WETH), sample).toBe(true);
            await settlePendingWork();
            expect(s.probe().execution.phase, sample).toBe("approving");
          }

          s.balance.after = BALANCE_90;
          const seq = releaseReceipt(s, receiptGate);
          await awaitResult(s);

          // 전제: 영수증 뒤 새로 생긴 보내는 토큰 키(트랜잭션 체인·계정·클릭 시점 토큰) 요청이 작은 값으로 응답했다.
          expect(
            newKeyRequests(s, seq).some((request) => request.status === "ok"),
            sample,
          ).toBe(true);

          expect(s.probe().execution.result, sample).toStrictEqual(
            approveSuccess(mainnet.id, true),
          );
          await waitUntil(() => expect(balanceNotice()).not.toBeNull(), READY_TIMEOUT_MS);
          expect(txStatus().getAttribute("data-status"), sample).toBe("success");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-12 EC-17
     * @given 스텁 지갑이 연결돼 있고 approve-required이며 클릭 시점 보내는 토큰 잔액을 안다. 표본: approve 종류(Ethereum ERC-20 approve, Ethereum USDT(0xdAC17F958D2ee523a2206206994597C13D831ec7)를 보내고 0 < allowance < amountInRaw라 approve-required 클릭이 approve(swapRouter02, 0)을 보내는 표본) × 영수증 뒤 새로 생긴 잔액 요청의 응답(클릭 시점 잔액과 같은 값, 클릭 시점 잔액보다 큰 값)을 하나씩 반복하고, Ethereum ERC-20 approve에서 클릭과 영수증 사이(approving 중)의 잔액 읽기(15초 주기 등)가 클릭 시점과 다른 값을 돌려주는 표본(클릭 시점 100, approving 중 읽기 150, 영수증 뒤 다시 읽기 120)을 더한다
     * @when 주 버튼을 눌러 approve 영수증 성공을 받고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.balanceDropped는 false다
     * @then tx-balance-notice가 없다
     */
    it(
      "[DoD-12][EC-17] approve 성공 뒤 다시 읽은 잔액이 클릭 시점 이상이면 잔액 감소 안내가 없다",
      async () => {
        const samples: { label: string; pair: PairSample; after: bigint; during?: bigint }[] = [
          { label: "Ethereum ERC-20 — 같은 값", pair: ETHEREUM_APPROVE, after: CLICK_BALANCE },
          { label: "Ethereum ERC-20 — 큰 값", pair: ETHEREUM_APPROVE, after: BALANCE_150 },
          { label: "USDT approve(0) — 같은 값", pair: USDT_PARTIAL, after: CLICK_BALANCE },
          { label: "USDT approve(0) — 큰 값", pair: USDT_PARTIAL, after: BALANCE_150 },
          {
            label: "Ethereum ERC-20 — approving 중 읽기 150, 다시 읽기 120",
            pair: ETHEREUM_APPROVE,
            after: BALANCE_120,
            during: BALANCE_150,
          },
        ];
        for (const [index, { label, pair, after, during }] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderReady("approve", pair);
          const receiptGate = await clickAndHoldReceipt(s, "approve");
          if (pair === USDT_PARTIAL) {
            // 전제: 보낸 것은 USDT 컨트랙트로 보낸 approve(swapRouter02, 0)이다.
            expect(sameAddress(s.wallet.sent[0]!.to, ETHEREUM_USDT), label).toBe(true);
            expect(decodeApproveCalldata(s.wallet.sent[0]!.data!).amount, label).toBe(0n);
          }
          if (during !== undefined) await periodicReadDuringApproving(s, during);

          s.balance.after = after;
          const seq = releaseReceipt(s, receiptGate);
          await awaitResult(s);

          // 전제: 영수증 뒤 새로 생긴 보내는 토큰 키 요청이 표본 값으로 응답했다.
          expect(
            newKeyRequests(s, seq).some((request) => request.status === "ok"),
            label,
          ).toBe(true);
          expect(s.probe().balances.in, label).toBe(after);

          expect(s.probe().execution.result, label).toStrictEqual(
            approveSuccess(mainnet.id, false),
          );
          expect(balanceNotice(), label).toBeNull();
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-15
     * @given 스텁 지갑이 연결돼 있고 approve-required이며 클릭 시점 보내는 토큰 잔액을 모른다. 표본: 클릭 전 잔액 읽기가 실패해 값이 없음, 클릭 전 잔액 읽기 응답을 붙잡아 값이 아직 없음, 붙잡은 클릭 전 잔액 읽기 응답이 approving 중(영수증 전)에 영수증 뒤 다시 읽기 값보다 큰 값으로 풀림을 하나씩 반복한다. 영수증 뒤 새로 생긴 잔액 요청에는 값을 응답한다(감소로 오판할 수 있도록 작은 값)
     * @when 주 버튼을 눌러 approve 영수증 성공을 받고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result는 approve 성공 결과이고 balanceDropped는 false다
     */
    it(
      "[EC-15] 클릭 시점 잔액을 몰랐으면 balanceDropped는 false다",
      async () => {
        const samples = [
          "클릭 전 읽기 실패",
          "클릭 전 읽기 붙잡음",
          "붙잡은 클릭 전 읽기가 approving 중 150으로 풀림",
        ] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          // 첫 읽기는 실패시켜 클릭 시점 잔액을 모르게 한다.
          const s = await renderReady("approve", ETHEREUM_APPROVE, {
            balanceKnown: false,
            prepare: (balance) => {
              balance.preFail = true;
            },
          });
          await waitUntil(
            () =>
              expect(
                rpc.requests(s.balance.key).some((request) => request.status === "failed"),
              ).toBe(true),
            READY_TIMEOUT_MS,
          );

          let preGate: HoldGate | null = null;
          let holdingPre = false;
          if (sample !== "클릭 전 읽기 실패") {
            // 클릭 직전에 보내는 토큰 키의 주기 다시 읽기를 일으켜 그 응답을 붙잡는다(클릭 시점에 읽는 중이고 값이 없다).
            s.balance.preFail = false;
            holdingPre = true;
            preGate = rpc.hold((request) => holdingPre && s.balance.key(request));
            await advanceFakeTimeTo(Date.now() + CARD_BALANCE_INTERVAL_MS);
            await waitUntil(() => expect(preGate!.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
          }
          await settlePendingWork();
          // 전제: 클릭 시점 보내는 토큰 잔액을 모르고 주 버튼은 approve-required다.
          expect(s.probe().balances.in, sample).toBeNull();
          expect(primaryState(), sample).toBe("approve-required");

          const receiptGate = await clickAndHoldReceipt(s, "approve");
          if (sample === "붙잡은 클릭 전 읽기가 approving 중 150으로 풀림") {
            s.balance.pre = BALANCE_150;
            preGate!.release();
            await waitUntil(
              () => expect(s.probe().balances.in).toBe(BALANCE_150),
              READY_TIMEOUT_MS,
            );
            expect(s.probe().execution.phase, sample).toBe("approving");
          }

          // 영수증 뒤 새로 생긴 요청에는 감소로 오판할 수 있도록 작은 값(120 < 150)을 응답한다.
          holdingPre = false;
          s.balance.preFail = false;
          s.balance.after = BALANCE_120;
          const seq = releaseReceipt(s, receiptGate);
          await awaitResult(s);

          // 전제: 영수증 뒤 새로 생긴 보내는 토큰 키 요청이 값으로 응답했다.
          expect(
            newKeyRequests(s, seq).some((request) => request.status === "ok"),
            sample,
          ).toBe(true);
          expect(s.probe().execution.result, sample).toStrictEqual(
            approveSuccess(mainnet.id, false),
          );
          preGate?.release();
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-16
     * @given 스텁 지갑이 연결돼 있고 approve-required이며 클릭 시점 보내는 토큰 잔액을 안다. 영수증 뒤 보내는 토큰 잔액 다시 읽기 요청은 실패로 응답한다. 표본: 영수증 전 잔액 읽기가 모두 클릭 시점 잔액을 돌려줌, 클릭 시점 100이고 approving 중 잔액 읽기(15초 주기 등)가 그보다 작은 80을 돌려줌을 하나씩 반복한다
     * @when 주 버튼을 눌러 approve 영수증 성공을 받고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result는 approve 성공 결과이고 balanceDropped는 false다
     */
    it(
      "[EC-16] approve 성공 뒤 잔액 다시 읽기가 실패하면 balanceDropped는 false다",
      async () => {
        const samples = ["영수증 전 읽기가 모두 클릭 시점 값", "approving 중 읽기 80"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderReady("approve", ETHEREUM_APPROVE);
          const receiptGate = await clickAndHoldReceipt(s, "approve");
          if (sample === "approving 중 읽기 80") {
            await periodicReadDuringApproving(s, BALANCE_80);
          }

          s.balance.after = "fail";
          const seq = releaseReceipt(s, receiptGate);
          await awaitResult(s);

          // 전제: 영수증 뒤 보내는 토큰 키 다시 읽기 요청이 실패했다.
          const reads = newKeyRequests(s, seq);
          expect(reads.length, sample).toBeGreaterThan(0);
          expect(
            reads.every((request) => request.status === "failed"),
            sample,
          ).toBe(true);
          expect(s.probe().execution.result, sample).toStrictEqual(
            approveSuccess(mainnet.id, false),
          );
        }
      },
      CASE_TIMEOUT_MS,
    );
  });
});
