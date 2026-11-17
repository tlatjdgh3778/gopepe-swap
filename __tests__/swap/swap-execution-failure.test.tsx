import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";

import {
  type BalanceRpcStub,
  STUB_MAX_UINT256,
  allowanceAlways,
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
  RPC_INTERNAL_ERROR_CODE,
  RPC_INVALID_INPUT_CODE,
  SEND_TRANSACTION_METHODS,
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
  createNoopWagmiStorage,
  currentButton,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 주 버튼(primary-button)의 data-state·비활성 여부와
// 앱 Provider 안의 프로브로 읽은 useSwapExecution()의 phase·approve·swap으로 판정한다.
// 지갑은 스텁 EIP-1193을 쓴다. 실패 주입(사용자 확정):
// - 체인 전환 거부는 4001, 전환 실패는 4001이 아닌 오류로 응답한다.
// - 서명 거부는 eth_sendTransaction에 4001로 응답한다.
// - 가스 추정 실패(EC-3)는 eth_sendTransaction에 4001이 아닌 JSON-RPC 오류(-32000)로 응답한다.
// RPC는 전역 fetch URL 라우팅 스텁이 응답한다(견적 aggregate3, 잔액, allowance eth_call, 영수증 계열).
// - revert(EC-4)는 영수증 스텁이 status revert로 응답한다.
// - 영수증 대기 reject(EC-5)는 영수증 미발견과 eth_getTransactionByHash 지속 실패로 viem 내부 재시도를 소진시킨다(가짜 타이머).
// 기본 allowance 규칙의 값은 0이다(approve-required 표본). swap-ready 표본은 allowance를 amountInRaw 이상으로 둔다. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.
// 표본 페어는 ERC-20↔ERC-20 페어이고, 기대 주소·해시·체인 ID는 제품 config를 쓰지 않고 리터럴로 적는다.
// "클릭 전 상태"는 같은 테스트에서 클릭 직전에 기록한 주 버튼의 data-state·비활성 여부다.

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;
// EC-5 reject 유도 대기: 가짜 시계 단계(viem 재시도 지연 200ms부터)와 실제 시간 한도
const RETRY_STEP_MS = 250;
const RETRY_TIMEOUT_MS = 30_000;

// Ethereum 공식 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// 보내는 USDC(decimals 6) 금액 1 → amountInRaw 1_000_000
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

// 메시지 요소(접근성 role이 alert·status인 요소)
function messageElements(): HTMLElement[] {
  return [...screen.queryAllByRole("alert"), ...screen.queryAllByRole("status")];
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
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
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
  return { stub, wallet, chainSwitch, probe: () => view.result.current };
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

// 클릭 직전에 setTimeout까지 가짜로 다시 설치한다(viem 폴링·재시도 지연이 가짜 시계를 따른다).
// 다시 설치하면 이전 가짜 주기 타이머는 사라지므로 이후에도 잔액 주기 다시 읽기는 일어나지 않는다.
function fakeAllTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

function receiptCalls() {
  return rpc.requests(matchReceipt.method("eth_getTransactionReceipt"));
}

// 영수증 대기 reject 유도: 영수증 미발견 + 트랜잭션 조회 지속 실패(JSON-RPC 오류 -32000)
function rejectReceiptWait() {
  rpc.setReceiptRule(makeReceiptRule("not-found"));
  rpc.failReceiptWhen(matchReceipt.method("eth_getTransactionByHash"));
}

function failedTransactionLookups(): number {
  return rpc
    .requests(matchReceipt.method("eth_getTransactionByHash"))
    .filter((request) => request.status === "failed").length;
}

describe("approve·swap 실패 — 보내지 못하거나 체결되지 않으면 진행을 끝내고 현재 상태로 돌아온다", () => {
  describe("트랜잭션을 보내기 전에 끝나는 경우", () => {
    /**
     * @spec EC-1 EC-15
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있다. 클릭 직전에 allowance 읽기 요청 수를 기록한다. 표본: 체인 전환 응답(거부 4001, 4001이 아닌 실패) × 클릭 전 상태(approve-required, swap-ready)를 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then 지갑이 eth_sendTransaction 요청을 받지 않는다(0건)
     * @then 주 버튼이 클릭 전 상태(같은 data-state, 활성)로 돌아간다
     * @then allowance 읽기 요청 수가 클릭 직전 기록에서 늘지 않는다
     */
    it(
      "[EC-1][EC-15] 체인 전환을 거부하거나 전환에 실패하면 트랜잭션을 보내지 않고 주 버튼이 클릭 전 상태로 돌아간다",
      async () => {
        const replies = [
          { label: "거부(4001)", code: USER_REJECTED_CODE },
          { label: "4001이 아닌 실패", code: RPC_INTERNAL_ERROR_CODE },
        ] as const;
        let sampleCount = 0;
        for (const reply of replies) {
          for (const kind of TX_KINDS) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${reply.label} — ${READY_STATE[kind]}`;
            // 지갑은 Base, 선택 체인은 Ethereum이다.
            const s = await renderReadyApp(kind, { walletChainId: base.id });
            s.chainSwitch.reply({ type: "error", code: reply.code });
            const before = currentButton("primary-button");
            const allowanceBefore = rpc.requests(matchAllowance.any).length;
            const from = s.stub.requests.length;

            clickPrimary();
            expect(s.probe().execution.phase, label).toBe("awaiting-signature");
            await waitUntil(
              () =>
                expect(requestsSince(s.stub, from, CHAIN_SWITCH_METHODS).length).toBeGreaterThan(0),
              READY_TIMEOUT_MS,
            );
            await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
            await settlePendingWork();

            // 전제: 지갑 체인은 바뀌지 않았다.
            expect(s.stub.chainId, label).toBe(base.id);
            expect(requestsSince(s.stub, from, SEND_TRANSACTION_METHODS), label).toEqual([]);
            expect(currentButton("primary-button").state, label).toBe(before.state);
            expect(currentButton("primary-button").disabled, label).toBe(false);
            expect(rpc.requests(matchAllowance.any), label).toHaveLength(allowanceBefore);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-2 EC-15
     * @given 스텁 지갑이 선택 체인에 연결돼 있고 eth_sendTransaction에 서명 거부(4001)로 응답한다. 클릭 직전에 allowance 읽기 요청 수를 기록한다. 표본: 클릭 전 상태 approve-required, swap-ready를 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then 지갑에서 해시를 받지 않아 영수증 조회 요청이 0건이다
     * @then 주 버튼이 클릭 전 상태(같은 data-state, 활성)로 돌아간다
     * @then 메시지를 표시하지 않는다(클릭 후 role이 alert 또는 status인 요소가 새로 생기지 않는다)
     * @then allowance 읽기 요청 수가 클릭 직전 기록에서 늘지 않는다
     */
    it(
      "[EC-2][EC-15] 지갑 서명을 거부하면 주 버튼이 클릭 전 상태로 돌아가고 메시지를 표시하지 않는다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
          s.wallet.reply({ type: "error", code: USER_REJECTED_CODE });
          const before = currentButton("primary-button");
          const allowanceBefore = rpc.requests(matchAllowance.any).length;
          const seq = rpc.requests().length;
          const messagesBefore = messageElements();

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(s.wallet.sent[0]!.errorCode, kind).toBe(USER_REJECTED_CODE);
          expect(s.wallet.hashes(), kind).toEqual([]);
          expect(rpc.requests(match.since(seq, matchReceipt.any)), kind).toEqual([]);
          expect(currentButton("primary-button").state, kind).toBe(before.state);
          expect(currentButton("primary-button").disabled, kind).toBe(false);
          expect(
            messageElements().filter((element) => !messagesBefore.includes(element)),
            kind,
          ).toEqual([]);
          expect(rpc.requests(matchAllowance.any), kind).toHaveLength(allowanceBefore);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-3 EC-15
     * @given 스텁 지갑이 선택 체인에 연결돼 있고 eth_sendTransaction에 4001이 아닌 JSON-RPC 오류(-32000)로 응답해 가스 추정 실패로 전송되지 않는다. 클릭 직전에 allowance 읽기 요청 수를 기록한다. 표본: 클릭 전 상태 approve-required, swap-ready를 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then 지갑이 eth_sendTransaction 요청은 받았으나 해시를 돌려주지 않고, 영수증 조회 요청이 0건이다
     * @then 주 버튼이 클릭 전 상태(같은 data-state, 활성)로 돌아간다
     * @then allowance 읽기 요청 수가 클릭 직전 기록에서 늘지 않는다
     */
    it(
      "[EC-3][EC-15] 지갑의 가스 추정이 실패해 전송되지 않으면 주 버튼이 클릭 전 상태로 돌아간다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          const s = await renderReadyApp(kind);
          s.wallet.reply({ type: "error", code: RPC_INVALID_INPUT_CODE });
          const before = currentButton("primary-button");
          const allowanceBefore = rpc.requests(matchAllowance.any).length;
          const seq = rpc.requests().length;
          const from = s.stub.requests.length;

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent.length).toBeGreaterThan(0), READY_TIMEOUT_MS);
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(requestsSince(s.stub, from, ["eth_sendTransaction"]).length, kind).toBeGreaterThan(
            0,
          );
          expect(
            s.wallet.sent.map((record) => record.errorCode),
            kind,
          ).toEqual(s.wallet.sent.map(() => RPC_INVALID_INPUT_CODE));
          expect(s.wallet.hashes(), kind).toEqual([]);
          expect(rpc.requests(match.since(seq, matchReceipt.any)), kind).toEqual([]);
          expect(currentButton("primary-button").state, kind).toBe(before.state);
          expect(currentButton("primary-button").disabled, kind).toBe(false);
          expect(rpc.requests(matchAllowance.any), kind).toHaveLength(allowanceBefore);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("영수증이 성공으로 끝나지 않는 경우", () => {
    /**
     * @spec EC-4
     * @given 스텁 지갑이 eth_sendTransaction에 해시로 응답하고 영수증 스텁이 revert로 응답한다. allowance 스텁 값은 실패 전후로 바꾸지 않는다. 표본: approve(allowance 0, approve-required에서 클릭), swap(allowance가 amountInRaw 이상(maxUint256), swap-ready에서 클릭)을 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받고 revert 영수증을 받는다
     * @then phase가 idle로 돌아간다
     * @then 주 버튼이 현재 입력·견적·allowance(스텁 값)로 판정한 상태다(approve 표본은 approve-required, swap 표본은 swap-ready이고 활성)
     * @then revert 영수증 뒤, 잔액 15초 주기가 오기 전에 allowance 읽기 요청이 새로 생긴다
     * @then revert 영수증 뒤, 잔액 15초 주기가 오기 전에 보내는 토큰과 받는 토큰 두 칸의 잔액 읽기 요청이 각각 새로 생긴다
     */
    it(
      "[EC-4] 영수증이 revert이면 idle로 돌아가 주 버튼을 다시 판정하고 allowance와 잔액을 다시 읽는다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          // 잔액 주기 다시 읽기(15초)가 일어나지 않게 주기 타이머를 가짜로 둔다.
          fakePeriodicTimers();
          const s = await renderReadyApp(kind);
          rpc.setReceiptRule(makeReceiptRule("reverted"));

          clickPrimary();
          await waitUntil(
            () => expect(receiptCalls().some((request) => request.status === "ok")).toBe(true),
            READY_TIMEOUT_MS,
          );
          const receiptSeq = receiptCalls().find((request) => request.status === "ok")!.seq;
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);

          await waitUntil(() => {
            expect(
              rpc.requests(match.since(receiptSeq + 1, matchAllowance.any)).length,
            ).toBeGreaterThan(0);
            for (const token of [ETHEREUM_USDC, ETHEREUM_DAI]) {
              expect(
                rpc.requests(match.since(receiptSeq + 1, match.balanceOfToken(token))).length,
                token,
              ).toBeGreaterThan(0);
            }
          }, READY_TIMEOUT_MS);
          await waitUntil(() => expect(primaryState()).toBe(READY_STATE[kind]), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(s.probe().execution.phase, kind).toBe("idle");
          expect(primaryState(), kind).toBe(READY_STATE[kind]);
          expect(primaryButton().disabled, kind).toBe(false);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-5
     * @given 스텁 지갑이 eth_sendTransaction에 해시로 응답하고, 영수증 조회는 계속 미발견이며 eth_getTransactionByHash는 계속 실패해 가짜 타이머로 진행하면 viem 내부 재시도가 소진되어 영수증 대기가 reject된다. allowance 스텁 값은 실패 전후로 바꾸지 않는다. 표본: approve(allowance 0, approve-required에서 클릭), swap(allowance가 amountInRaw 이상(maxUint256), swap-ready에서 클릭)을 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받고 영수증 대기가 reject될 때까지 가짜 타이머로 진행한다
     * @then phase가 idle로 돌아간다
     * @then 주 버튼이 현재 입력·견적·allowance(스텁 값)로 판정한 상태다(approve 표본은 approve-required, swap 표본은 swap-ready이고 활성)
     * @then reject 뒤, 잔액 15초 주기가 오기 전에 allowance 읽기 요청이 새로 생긴다
     * @then reject 뒤, 잔액 15초 주기가 오기 전에 보내는 토큰과 받는 토큰 두 칸의 잔액 읽기 요청이 각각 새로 생긴다
     */
    it(
      "[EC-5] 영수증 대기가 reject되면 idle로 돌아가 주 버튼을 다시 판정하고 allowance와 잔액을 다시 읽는다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const s = await renderReadyApp(kind);
          rejectReceiptWait();
          fakeAllTimers();

          clickPrimary();
          await waitUntilAdvancingFakeClock(() =>
            expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
          );
          await waitUntilAdvancingFakeClock(
            () => expect(s.probe().execution.phase).toBe("idle"),
            RETRY_STEP_MS,
            RETRY_TIMEOUT_MS,
          );
          // 전제: 트랜잭션 조회가 viem 재시도 끝에 모두 실패해 영수증 대기가 reject됐다.
          expect(failedTransactionLookups(), kind).toBeGreaterThan(1);
          const lastFailure = rpc
            .requests(matchReceipt.method("eth_getTransactionByHash"))
            .filter((request) => request.status === "failed")
            .at(-1)!;

          await waitUntilAdvancingFakeClock(() => {
            expect(
              rpc.requests(match.since(lastFailure.seq + 1, matchAllowance.any)).length,
            ).toBeGreaterThan(0);
            for (const token of [ETHEREUM_USDC, ETHEREUM_DAI]) {
              expect(
                rpc.requests(match.since(lastFailure.seq + 1, match.balanceOfToken(token))).length,
                token,
              ).toBeGreaterThan(0);
            }
            expect(primaryState()).toBe(READY_STATE[kind]);
          });
          await settlePendingWork();

          expect(s.probe().execution.phase, kind).toBe("idle");
          expect(primaryState(), kind).toBe(READY_STATE[kind]);
          expect(primaryButton().disabled, kind).toBe(false);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("실행 함수의 Promise", () => {
    /**
     * @spec EC-20
     * @given 앱 Provider 안에서 useSwapExecution()을 읽는다. 표본: 실패(체인 전환 거부, 서명 거부, revert 영수증, 영수증 대기 reject) × 호출(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when approve 또는 swap을 직접 호출하고 표본의 실패가 일어나게 한다
     * @then 호출이 돌려준 Promise가 reject하지 않고 resolve한다
     */
    it(
      "[EC-20] 체인 전환 거부·서명 거부·revert·영수증 대기 reject에서도 approve·swap의 Promise는 resolve한다",
      async () => {
        const failures = [
          "체인 전환 거부",
          "서명 거부",
          "revert 영수증",
          "영수증 대기 reject",
        ] as const;
        let sampleCount = 0;
        for (const failure of failures) {
          for (const kind of TX_KINDS) {
            if (sampleCount > 0) resetSample();
            sampleCount += 1;
            const label = `${failure} — ${kind}`;
            const s = await renderReadyApp(kind, {
              walletChainId: failure === "체인 전환 거부" ? base.id : mainnet.id,
            });
            const from = s.stub.requests.length;
            if (failure === "체인 전환 거부") {
              s.chainSwitch.reply({ type: "error", code: USER_REJECTED_CODE });
            } else if (failure === "서명 거부") {
              s.wallet.reply({ type: "error", code: USER_REJECTED_CODE });
            } else if (failure === "revert 영수증") {
              rpc.setReceiptRule(makeReceiptRule("reverted"));
            } else {
              rejectReceiptWait();
              fakeAllTimers();
            }

            let outcome: "pending" | "resolved" | "rejected" = "pending";
            act(() => {
              const { approve, swap } = s.probe().execution;
              const promise = kind === "approve" ? approve() : swap();
              promise.then(
                () => {
                  outcome = "resolved";
                },
                () => {
                  outcome = "rejected";
                },
              );
            });
            const settled = () => expect(outcome).not.toBe("pending");
            if (failure === "영수증 대기 reject") {
              await waitUntilAdvancingFakeClock(settled, RETRY_STEP_MS, RETRY_TIMEOUT_MS);
            } else {
              await waitUntil(settled, READY_TIMEOUT_MS);
            }

            expect(outcome, label).toBe("resolved");

            // 전제: 표본의 실패가 실제로 일어났다.
            if (failure === "체인 전환 거부") {
              expect(
                requestsSince(s.stub, from, CHAIN_SWITCH_METHODS).length,
                label,
              ).toBeGreaterThan(0);
              expect(requestsSince(s.stub, from, SEND_TRANSACTION_METHODS), label).toEqual([]);
            } else if (failure === "서명 거부") {
              expect(
                s.wallet.sent.map((record) => record.errorCode),
                label,
              ).toEqual([USER_REJECTED_CODE]);
            } else if (failure === "revert 영수증") {
              expect(
                receiptCalls().some((request) => request.status === "ok"),
                label,
              ).toBe(true);
            } else {
              expect(failedTransactionLookups(), label).toBeGreaterThan(1);
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
