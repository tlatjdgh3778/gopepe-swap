import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address, Hash } from "viem";
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
  type WalletReply,
  type WalletTransactionControl,
  createStubEip1193,
  installChainSwitch,
  installWalletTransactions,
  providerRpcError,
  stubTransactionHash,
} from "../support/stub-eip1193";
import {
  CHAIN_SWITCH_METHODS,
  TEST_ACCOUNT,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 기대값은 스펙 §4.1·§4.2·§4.3과 EC 항목에서 가져오고 구현이 내는 값을 베끼지 않는다.
// 기대 URL은 tx 체인과 스텁 해시로 만든 리터럴로 두고 제품 상수나 화면 값에서 가져오지 않는다.
// mock 경계: 실제 wagmi·Provider·화면, 스텁 EIP-1193(지갑 전송·체인 전환 응답 제어, 지갑 오류의 원인(cause) 주입),
// 전역 fetch URL 라우팅 RPC 스텁(영수증 규칙 포함), 가짜 타이머. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 config·스텁·QueryClient를 새로 만들고 쿠키를 지운다.
// 실제 지갑의 오류 형태는 스텁으로만 증명한다(스펙 §2: 실제 지갑 오류 형태는 미검증).
// 판정은 앱 Provider 안의 프로브로 읽은 useSwapExecution()의 phase·result와
// 상태 메시지 영역(tx-status의 data-status·data-kind, tx-link 유무와 href)으로 한다.

const SAMPLE_TIMEOUT_MS = 50_000;
const READY_TIMEOUT_MS = 10_000;
// 영수증 대기 reject 유도 대기: 가짜 시계 단계(viem 재시도 지연 200ms부터)와 실제 시간 한도
const RETRY_STEP_MS = 250;
const RETRY_TIMEOUT_MS = 30_000;

// Ethereum 공식 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
// 트랜잭션을 보낸 체인(표본은 Ethereum)과 그 탐색기 tx URL 접두(스펙 DoD-6 리터럴)
const ETHEREUM_CHAIN_ID = 1;
const ETHERSCAN_TX = "https://etherscan.io/tx/";

// 보내는 USDC(decimals 6) 금액 1
const AMOUNT = "1";

// 표본마다 새 스텁 지갑이 처음 돌려주는 해시(원 해시)
const ORIGINAL_HASH: Hash = stubTransactionHash(1);

// EIP-1193 CAIP-25 사용자 거부 code. viem이 4001(`UserRejectedRequestError`)로 정규화한다.
const CAIP_USER_REJECTED_CODE = 5000;
// viem이 4001을 정규화한 오류의 메시지와 같은 문구(EC-4에서 4001이 아닌 code에 싣는다)
const USER_REJECTED_MESSAGE = "User rejected the request.";

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

function txStatus(): HTMLElement {
  return screen.getByTestId("tx-status");
}

function txLink(): HTMLElement | null {
  return screen.queryByTestId("tx-link");
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
  // 전제: 표시할 결과가 없다.
  expect(view.result.current.execution.result, `${kind} 클릭 전 result`).toBeNull();
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

// 표본 목록 × 실행(approve·swap)을 하나씩 반복한다. 표본마다 앱과 스텁을 새로 만든다.
async function forEachSample<T>(
  samples: readonly T[],
  run: (sample: T, kind: TxKind) => Promise<void>,
): Promise<void> {
  let count = 0;
  for (const sample of samples) {
    for (const kind of TX_KINDS) {
      if (count > 0) resetSample();
      count += 1;
      await run(sample, kind);
    }
  }
}

function caseTimeout(samples: number): number {
  return samples * TX_KINDS.length * SAMPLE_TIMEOUT_MS;
}

// 전송 전 실패 결과(rejected·chain-switch-failed·send-failed)의 판정: result, 메시지 영역, 링크 없음(EC-5)
function expectPreSendFailure(
  s: Scenario,
  kind: TxKind,
  status: "rejected" | "chain-switch-failed" | "send-failed",
  label: string,
) {
  const result = s.probe().execution.result;
  expect(result?.status, `${label} result.status`).toBe(status);
  expect(result?.kind, `${label} result.kind`).toBe(kind);
  expect(txStatus().getAttribute("data-status"), `${label} data-status`).toBe(status);
  expect(txStatus().getAttribute("data-kind"), `${label} data-kind`).toBe(kind);
  expect(txLink(), `${label} tx-link`).toBeNull();
}

// ─── 표본 ─────────────────────────────────────────────────────────

type SendErrorSample = { label: string; reply: () => WalletReply };

// EC-1: 원인 체인에 code 4001이 있는 서명 단계 오류
const REJECTED_SEND_SAMPLES: readonly SendErrorSample[] = [
  { label: "4001", reply: () => ({ type: "error", code: USER_REJECTED_CODE }) },
  { label: "5000", reply: () => ({ type: "error", code: CAIP_USER_REJECTED_CODE }) },
  {
    label: "-32603 + 원인 4001",
    reply: () => ({
      type: "error",
      code: RPC_INTERNAL_ERROR_CODE,
      cause: providerRpcError(USER_REJECTED_CODE, USER_REJECTED_MESSAGE),
    }),
  },
];

// EC-4: 원인 체인에 4001이 없는 그 밖의 전송 오류. 4001 정규화 오류와 같은 문구를 실은 표본을 포함한다.
const FAILED_SEND_SAMPLES: readonly SendErrorSample[] = [
  { label: "-32000", reply: () => ({ type: "error", code: RPC_INVALID_INPUT_CODE }) },
  { label: "-32603", reply: () => ({ type: "error", code: RPC_INTERNAL_ERROR_CODE }) },
  {
    label: `-32000 + "${USER_REJECTED_MESSAGE}"`,
    reply: () => ({ type: "error", code: RPC_INVALID_INPUT_CODE, message: USER_REJECTED_MESSAGE }),
  },
  {
    label: `-32603 + "${USER_REJECTED_MESSAGE}"`,
    reply: () => ({ type: "error", code: RPC_INTERNAL_ERROR_CODE, message: USER_REJECTED_MESSAGE }),
  },
];

// 지갑이 eth_sendTransaction에 표본 오류로 응답하는 동안 주 버튼을 누르고 실행이 끝나기를 기다린다.
async function runSendFailure(sample: SendErrorSample, kind: TxKind): Promise<Scenario> {
  const label = `${sample.label} — ${kind}`;
  const s = await renderReadyApp(kind);
  const reply = sample.reply();
  s.wallet.reply(reply);

  clickPrimary();
  await waitUntil(() => expect(s.wallet.sent.length).toBeGreaterThan(0), READY_TIMEOUT_MS);
  await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
  await settlePendingWork();

  // 전제: 지갑이 전송 요청을 받아 표본 오류로 응답했고 해시를 돌려주지 않았다.
  expect(
    s.wallet.sent.map((record) => record.errorCode),
    label,
  ).toEqual(s.wallet.sent.map(() => (reply.type === "error" ? reply.code : null)));
  expect(s.wallet.hashes(), label).toEqual([]);
  return s;
}

// 지갑이 선택 체인(Ethereum)과 다른 체인(Base)에 있고 체인 전환 요청에 `code` 오류로 응답하는 동안 주 버튼을 누른다.
async function runChainSwitchFailure(code: number, kind: TxKind): Promise<Scenario> {
  const label = `전환 ${code} — ${kind}`;
  const s = await renderReadyApp(kind, { walletChainId: base.id });
  s.chainSwitch.reply({ type: "error", code });
  const from = s.stub.requests.length;

  clickPrimary();
  await waitUntil(
    () => expect(requestsSince(s.stub, from, CHAIN_SWITCH_METHODS).length).toBeGreaterThan(0),
    READY_TIMEOUT_MS,
  );
  await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
  await settlePendingWork();

  // 전제: 지갑 체인은 바뀌지 않았고 전송 요청이 없다.
  expect(s.stub.chainId, label).toBe(base.id);
  expect(requestsSince(s.stub, from, SEND_TRANSACTION_METHODS), label).toEqual([]);
  return s;
}

describe("트랜잭션 실패 메시지 — approve·swap이 실패하면 사용자가 실패 종류를 구분해 본다", () => {
  describe("지갑이 서명·전송을 거부하거나 보내지 못한 경우", () => {
    /**
     * @spec EC-1 EC-5
     * @given 스텁 지갑이 선택 체인에 연결돼 있고 eth_sendTransaction에 오류로 응답한다. 표본: 지갑 오류(code 4001, code 5000 — viem이 4001로 정규화, 최상위 code가 -32603이고 원인(cause)에 code 4001이 든 오류) × 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then `result.status`가 `rejected`이고 `result.kind`가 표본의 실행(approve·swap)이다
     * @then `tx-status`의 `data-status`가 `rejected`이고 `data-kind`가 표본의 실행이다
     * @then `tx-link`가 없다
     */
    it(
      "[EC-1][EC-5] 서명 단계 오류의 원인 체인에 code 4001이 있으면 결과가 rejected이고 tx-link가 없다",
      async () => {
        await forEachSample(REJECTED_SEND_SAMPLES, async (sample, kind) => {
          const s = await runSendFailure(sample, kind);
          expectPreSendFailure(s, kind, "rejected", `${sample.label} — ${kind}`);
        });
      },
      caseTimeout(REJECTED_SEND_SAMPLES.length),
    );

    /**
     * @spec EC-4 EC-5
     * @given 스텁 지갑이 선택 체인에 연결돼 있고 eth_sendTransaction에 4001이 아닌 오류로 응답한다. 표본: 오류(code -32000, code -32603, 4001이 아닌 같은 code에 메시지만 viem 4001 정규화 오류와 같은 "User rejected the request."로 바꾼 오류) × 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then `result.status`가 메시지 문구와 무관하게 `send-failed`이고 `result.kind`가 표본의 실행이다
     * @then `tx-status`의 `data-status`가 `send-failed`이고 `data-kind`가 표본의 실행이다
     * @then `tx-link`가 없다
     */
    it(
      "[EC-4][EC-5] 그 밖의 전송 오류는 메시지 문구와 무관하게 결과가 send-failed이고 tx-link가 없다",
      async () => {
        await forEachSample(FAILED_SEND_SAMPLES, async (sample, kind) => {
          const s = await runSendFailure(sample, kind);
          expectPreSendFailure(s, kind, "send-failed", `${sample.label} — ${kind}`);
        });
      },
      caseTimeout(FAILED_SEND_SAMPLES.length),
    );
  });

  describe("네트워크 전환이 실패한 경우", () => {
    /**
     * @spec EC-2 EC-5
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 요청에 거부(4001)로 응답한다. 표본: 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then `result.status`가 `rejected`이고 `result.kind`가 표본의 실행이다
     * @then `tx-status`의 `data-status`가 `rejected`이고 `data-kind`가 표본의 실행이다
     * @then `tx-link`가 없다
     */
    it(
      "[EC-2][EC-5] 체인 전환을 거부하면 결과가 rejected이고 tx-link가 없다",
      async () => {
        await forEachSample([USER_REJECTED_CODE], async (code, kind) => {
          const s = await runChainSwitchFailure(code, kind);
          expectPreSendFailure(s, kind, "rejected", `전환 ${code} — ${kind}`);
        });
      },
      caseTimeout(1),
    );

    /**
     * @spec EC-3 EC-5
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 요청에 4001·4902가 아닌 code의 오류로 응답한다. 표본: 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 누른다
     * @then `result.status`가 `chain-switch-failed`이고 `result.kind`가 표본의 실행이다
     * @then `tx-status`의 `data-status`가 `chain-switch-failed`이고 `data-kind`가 표본의 실행이다
     * @then `tx-link`가 없다
     */
    it(
      "[EC-3][EC-5] 체인 전환이 4001이 아닌 이유로 실패하면 결과가 chain-switch-failed이고 tx-link가 없다",
      async () => {
        // 4001·4902가 아닌 code: 지갑 내부 오류(-32603)
        await forEachSample([RPC_INTERNAL_ERROR_CODE], async (code, kind) => {
          const s = await runChainSwitchFailure(code, kind);
          expectPreSendFailure(s, kind, "chain-switch-failed", `전환 ${code} — ${kind}`);
        });
      },
      caseTimeout(1),
    );
  });

  describe("서명 대기 중 선택 체인이 바뀌어 보내지 않은 경우", () => {
    /**
     * @spec EC-6
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 응답을 붙잡아 둔다. 이전 결과는 없다. 표본: 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 눌러 awaiting-signature가 된 동안 드롭다운에서 선택 체인을 다른 체인으로 바꾸고, 체인 전환 응답을 풀어 트랜잭션을 보내지 않고 끝나게 한다
     * @then `result`가 `null`이다
     * @then `tx-status`의 `data-status`가 `none`이다
     */
    it(
      "[EC-6] awaiting-signature 중 선택 체인이 바뀌어 전송하지 않으면 결과가 null이다",
      async () => {
        await forEachSample([arbitrum], async (nextChain, kind) => {
          // 지갑은 Base, 선택 체인은 Ethereum이다.
          const s = await renderReadyApp(kind, { walletChainId: base.id });
          const switchGate = s.chainSwitch.hold();
          const from = s.stub.requests.length;

          clickPrimary();
          await waitUntil(() => expect(switchGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          expect(s.probe().execution.phase, kind).toBe("awaiting-signature");

          await chooseChainFromDropdown(nextChain);
          expect(s.probe().execution.phase, kind).toBe("awaiting-signature");
          switchGate.release();

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();

          // 전제: 붙잡았던 전환은 클릭 시점 체인(Ethereum)으로의 성공으로 끝났고 트랜잭션을 보내지 않았다.
          expect(s.stub.chainId, kind).toBe(ETHEREUM_CHAIN_ID);
          expect(requestsSince(s.stub, from, SEND_TRANSACTION_METHODS), kind).toEqual([]);

          expect(s.probe().execution.result, kind).toBeNull();
          expect(txStatus().getAttribute("data-status"), kind).toBe("none");
        });
      },
      caseTimeout(1),
    );
  });

  describe("트랜잭션을 보낸 뒤 체결되지 않은 경우", () => {
    /**
     * @spec EC-7
     * @given 스텁 지갑이 eth_sendTransaction에 해시로 응답하고 영수증 스텁이 reverted로 응답한다. 표본: 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받고 reverted 영수증을 받는다
     * @then `result`가 `{ kind: 표본의 실행, status: "reverted", chainId: 트랜잭션을 보낸 체인, hash: 지갑이 돌려준 원 해시 }`다
     * @then `tx-status`의 `data-status`가 `reverted`이고 `data-kind`가 표본의 실행이다
     * @then `tx-link`가 있고 `href`가 `result.chainId`(트랜잭션을 보낸 체인) 탐색기의 `/tx/{result.hash}`(원 해시)이며, 기대값은 테스트가 정한 tx 체인과 스텁이 돌려준 원 해시로 만든 리터럴 URL(예: `https://etherscan.io/tx/{원 해시}`)이다
     */
    it(
      "[EC-7] 영수증이 reverted이면 결과가 reverted이고 tx-link가 있다",
      async () => {
        await forEachSample(["reverted"] as const, async (receipt, kind) => {
          // 잔액 주기 다시 읽기가 일어나지 않게 주기 타이머를 가짜로 둔다.
          fakePeriodicTimers();
          const s = await renderReadyApp(kind);
          rpc.setReceiptRule(makeReceiptRule(receipt));

          clickPrimary();
          await waitUntil(
            () => expect(receiptCalls().some((request) => request.status === "ok")).toBe(true),
            READY_TIMEOUT_MS,
          );
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();

          // 전제: 지갑이 원 해시 하나를 돌려줬다.
          expect(s.wallet.hashes(), kind).toEqual([ORIGINAL_HASH]);

          expect(s.probe().execution.result, kind).toEqual({
            kind,
            status: "reverted",
            chainId: ETHEREUM_CHAIN_ID,
            hash: ORIGINAL_HASH,
          });
          expect(txStatus().getAttribute("data-status"), kind).toBe("reverted");
          expect(txStatus().getAttribute("data-kind"), kind).toBe(kind);
          expect(txLink()?.getAttribute("href"), kind).toBe(`${ETHERSCAN_TX}${ORIGINAL_HASH}`);
        });
      },
      caseTimeout(1),
    );

    /**
     * @spec EC-8
     * @given 스텁 지갑이 eth_sendTransaction에 해시로 응답하고, 영수증 조회는 계속 미발견이며 eth_getTransactionByHash는 계속 실패해 가짜 타이머로 진행하면 영수증 대기가 reject된다. 표본: 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받고 영수증 대기가 reject될 때까지 가짜 타이머로 진행한다
     * @then `result`가 `{ kind: 표본의 실행, status: "receipt-failed", chainId: 트랜잭션을 보낸 체인, hash: 지갑이 돌려준 원 해시 }`다
     * @then `tx-status`의 `data-status`가 `receipt-failed`이고 `data-kind`가 표본의 실행이다
     * @then `tx-link`가 있고 `href`가 `result.chainId`(트랜잭션을 보낸 체인) 탐색기의 `/tx/{result.hash}`(원 해시)이며, 기대값은 테스트가 정한 tx 체인과 스텁이 돌려준 원 해시로 만든 리터럴 URL(예: `https://etherscan.io/tx/{원 해시}`)이다
     */
    it(
      "[EC-8] 영수증 대기가 reject되면 결과가 receipt-failed이고 tx-link가 있다",
      async () => {
        await forEachSample(["영수증 미발견 + 조회 지속 실패"] as const, async (_failure, kind) => {
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
          await waitUntilAdvancingFakeClock(() =>
            expect(s.probe().execution.result).not.toBeNull(),
          );

          // 전제: 지갑이 원 해시 하나를 돌려줬고, 트랜잭션 조회가 viem 재시도 끝에 모두 실패해 영수증 대기가 reject됐다.
          expect(s.wallet.hashes(), kind).toEqual([ORIGINAL_HASH]);
          expect(failedTransactionLookups(), kind).toBeGreaterThan(1);

          expect(s.probe().execution.result, kind).toEqual({
            kind,
            status: "receipt-failed",
            chainId: ETHEREUM_CHAIN_ID,
            hash: ORIGINAL_HASH,
          });
          expect(txStatus().getAttribute("data-status"), kind).toBe("receipt-failed");
          expect(txStatus().getAttribute("data-kind"), kind).toBe(kind);
          expect(txLink()?.getAttribute("href"), kind).toBe(`${ETHERSCAN_TX}${ORIGINAL_HASH}`);
        });
      },
      caseTimeout(1) + RETRY_TIMEOUT_MS,
    );
  });
});
