import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { type Address, type Hash, type ReplacementReason, getAddress, hexToBigInt } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";

import {
  type BalanceRpcStub,
  type ReceiptStatus,
  type RequestMatcher,
  type StubTransaction,
  installBalanceRpcStub,
  makeReceiptRule,
  match,
  matchReceipt,
  receiptRuleByHash,
  sameAddress,
  stubReplacementHash,
  stubReplacementTransaction,
  stubTransaction,
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
  clearCookies,
  createNoopWagmiStorage,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 앱 Provider 안의 프로브로 읽은 useSwapExecution()의 phase·result,
// 상태 메시지 영역(tx-status의 data-status·data-kind, tx-link 유무와 href), 보내는 칸 amount-input 값, RPC 스텁의 잔액 읽기 요청 기록으로 판정한다.
// 기대값은 스펙 §4.2·§4.3과 EC 항목(F6 §4.1·§4.2 결과 모양 포함)에서 가져오고, 해시·체인 ID·탐색기 URL은 제품 config를 쓰지 않고 리터럴로 적는다.
// mock 경계(사용자 확정, 2026-11-20): F6 T-9 경계(스텁 EIP-1193 지갑의 체인 전환·전송 응답 제어와 지갑 오류의 원인(cause) 주입)와
// F6 T-6 경계(교체 주입: 해시별 트랜잭션 필드, 블록 트랜잭션 목록, 대체 영수증을 RPC 스텁이 돌려주고 영수증 대기 폴링을 가짜 타이머로 진행).
// 공통으로 실제 wagmi·Provider·화면, mock 커넥터·스텁 EIP-1193, 전역 fetch URL 라우팅 RPC 스텁, 가짜 타이머를 쓴다. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다.
// "원 해시"는 지갑이 eth_sendTransaction에 돌려준 해시, "대체 해시"는 같은 계정·nonce로 블록에 실린 다른 트랜잭션의 해시다.

// 원 트랜잭션 필드(보낸 계정·받는 주소·값·데이터)는 스텁 지갑이 받은 eth_sendTransaction 요청에서 가져오고, nonce는 테스트가 정한다.
// 대체 트랜잭션은 원 트랜잭션을 대기 중으로 조회한 응답을 본 뒤 다음 블록부터 블록 트랜잭션 목록에 싣는다.
// 실제 지갑의 오류 형태는 스텁으로만 증명한다. 가스 추정 실패는 지갑의 eth_sendTransaction 오류 응답(-32000)으로 표현한다.

const SAMPLE_TIMEOUT_MS = 50_000;
const READY_TIMEOUT_MS = 10_000;
// 영수증 대기 폴링(wagmi 기본 4초 간격)을 가짜 시계로 진행하는 대기의 단계와 실제 시간 한도
const POLL_STEP_MS = 250;
const POLL_TIMEOUT_MS = 30_000;
// 카드 잔액 주기(F2 15초). 결과 뒤 다시 읽기가 주기 읽기가 아님을 가르는 경계다.
const CARD_BALANCE_INTERVAL_MS = 15_000;

// 공식 주소(리터럴). 표본 체인은 Ethereum이다.
const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_CHAIN_ID = 1;
const ETHERSCAN_TX = "https://etherscan.io/tx/";

// 보내는 칸 금액(ETH·WETH decimals 18)
const AMOUNT = "1";

// 표본마다 새 스텁 지갑이 처음 돌려주는 해시(원 해시)와 대체 트랜잭션 해시
const ORIGINAL_HASH: Hash = stubTransactionHash(1);
const REPLACEMENT_HASH: Hash = stubReplacementHash(1);
// 원 트랜잭션의 nonce(테스트가 정한 값)
const ORIGINAL_NONCE = 7;

// EIP-1193 CAIP-25 사용자 거부 code. viem이 4001(`UserRejectedRequestError`)로 정규화한다.
const CAIP_USER_REJECTED_CODE = 5000;

type WrapKind = "wrap" | "unwrap";
const WRAP_KINDS: readonly WrapKind[] = ["wrap", "unwrap"];
const READY_STATE = { wrap: "wrap-ready", unwrap: "unwrap-ready" } as const;
const PROGRESS = { wrap: "wrapping", unwrap: "unwrapping" } as const;

// 표본 종류의 보내는·받는 토큰: wrap은 ETH → WETH, unwrap은 WETH → ETH
function pairOf(kind: WrapKind): { tokenIn: Address; tokenOut: Address } {
  return kind === "wrap"
    ? { tokenIn: ETH_ADDRESS, tokenOut: ETHEREUM_WETH }
    : { tokenIn: ETHEREUM_WETH, tokenOut: ETH_ADDRESS };
}

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

// 스텁 EIP-1193 지갑(`walletChainId`)으로 연결되고 선택 체인이 Ethereum인 앱에서 표본 종류의 페어와 금액 1을 입력해
// 주 버튼이 표본의 준비 상태(wrap-ready·unwrap-ready)이고 활성이 될 때까지 기다린다. 두 칸의 카드 잔액 읽기가 끝나 있다.
async function renderReady(
  kind: WrapKind,
  { walletChainId = mainnet.id }: { walletChainId?: SupportedChainId } = {},
): Promise<Scenario> {
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
    expect(sameAddress(connection.address, TEST_ACCOUNT)).toBe(true);
  }, READY_TIMEOUT_MS);

  const pair = pairOf(kind);
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
  expect(view.result.current.execution.result, `${kind} 클릭 전 result`).toBeNull();
  return { stub, wallet, chainSwitch, probe: () => view.result.current };
}

// 표본 목록 × 종류(wrap·unwrap)를 하나씩 반복한다. 표본마다 앱과 스텁을 새로 만든다.
async function forEachSample<T>(
  samples: readonly T[],
  run: (sample: T, kind: WrapKind) => Promise<void>,
): Promise<void> {
  let count = 0;
  for (const sample of samples) {
    for (const kind of WRAP_KINDS) {
      if (count > 0) resetSample();
      count += 1;
      await run(sample, kind);
    }
  }
}

function caseTimeout(samples: number): number {
  return samples * WRAP_KINDS.length * SAMPLE_TIMEOUT_MS;
}

// 전송 전 실패 결과의 메시지 영역 판정: data-status·data-kind, 링크 없음
function expectPreSendMessage(
  kind: WrapKind,
  status: "rejected" | "chain-switch-failed" | "send-failed",
  label: string,
) {
  expect(txStatus().getAttribute("data-status"), `${label} data-status`).toBe(status);
  expect(txStatus().getAttribute("data-kind"), `${label} data-kind`).toBe(kind);
  expect(txLink(), `${label} tx-link`).toBeNull();
}

// ─── 표본 ─────────────────────────────────────────────────────────

type SendErrorSample = { label: string; reply: () => WalletReply };

// 지갑이 eth_sendTransaction에 표본 오류로 응답하는 동안 주 버튼을 누르고 phase가 idle로 돌아가기를 기다린다.
async function runSendFailure(sample: SendErrorSample, kind: WrapKind): Promise<Scenario> {
  const label = `${sample.label} — ${kind}`;
  const s = await renderReady(kind);
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
async function runChainSwitchFailure(code: number, kind: WrapKind): Promise<Scenario> {
  const label = `전환 ${code} — ${kind}`;
  const s = await renderReady(kind, { walletChainId: base.id });
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

type RejectSample =
  | { label: string; via: "send"; reply: () => WalletReply }
  | { label: string; via: "chain-switch"; code: number };

// EC-1: 원인 체인에 code 4001이 있는 서명 단계 오류(전송 요청 3종, 체인 전환 요청 거부)
const REJECTED_SAMPLES: readonly RejectSample[] = [
  {
    label: "전송 4001",
    via: "send",
    reply: () => ({ type: "error", code: USER_REJECTED_CODE }),
  },
  {
    label: "전송 5000",
    via: "send",
    reply: () => ({ type: "error", code: CAIP_USER_REJECTED_CODE }),
  },
  {
    label: "전송 -32603 + 원인 4001",
    via: "send",
    reply: () => ({
      type: "error",
      code: RPC_INTERNAL_ERROR_CODE,
      cause: providerRpcError(USER_REJECTED_CODE, "User rejected the request."),
    }),
  },
  { label: "체인 전환 4001", via: "chain-switch", code: USER_REJECTED_CODE },
];

// EC-3: 원인 체인에 4001이 없는 그 밖의 전송 오류. -32000은 지갑의 가스 추정 실패에 해당한다.
const FAILED_SEND_SAMPLES: readonly SendErrorSample[] = [
  { label: "-32000", reply: () => ({ type: "error", code: RPC_INVALID_INPUT_CODE }) },
  { label: "-32603", reply: () => ({ type: "error", code: RPC_INTERNAL_ERROR_CODE }) },
];

// ─── 교체 주입 ────────────────────────────────────────────────────

function sameHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// 스텁 지갑이 받은 첫 eth_sendTransaction 요청의 필드와 테스트가 정한 nonce로 만든 원 트랜잭션
function originalTransaction(wallet: WalletTransactionControl): StubTransaction | undefined {
  const sent = wallet.sent[0];
  if (!sent?.hash || !sent.from) return undefined;
  return stubTransaction({
    hash: sent.hash,
    from: getAddress(sent.from),
    nonce: ORIGINAL_NONCE,
    to: sent.to ? getAddress(sent.to) : null,
    value: sent.value ? hexToBigInt(sent.value) : 0n,
    input: sent.data ?? "0x",
  });
}

// 원 해시 조회에는 지갑이 받은 요청의 필드로 대기 중 트랜잭션을 돌려준다.
function serveOriginalFields(wallet: WalletTransactionControl) {
  rpc.setTransactionFields(({ hash }) =>
    sameHash(hash, ORIGINAL_HASH) ? originalTransaction(wallet) : undefined,
  );
}

// 원 해시 영수증은 미발견, 대체 해시 영수증은 `receipt`, 트랜잭션 조회는 대기 중인 영수증 규칙
function installReplacementReceipts(receipt: Exclude<ReceiptStatus, "not-found">) {
  rpc.setReceiptRule(receiptRuleByHash({ [REPLACEMENT_HASH]: receipt }));
}

function originalLookups() {
  return rpc.requests(
    matchReceipt.hash(ORIGINAL_HASH, matchReceipt.method("eth_getTransactionByHash")),
  );
}

function replacementReceiptCalls() {
  return rpc.requests(
    matchReceipt.hash(REPLACEMENT_HASH, matchReceipt.method("eth_getTransactionReceipt")),
  );
}

// 트랜잭션 체인(Ethereum)·연결 계정의 카드 잔액 요청: ETH는 `eth_getBalance`, WETH는 WETH 주소로 가는 `balanceOf`
const ETH_BALANCE_KEY: RequestMatcher = match.chain(
  mainnet.id,
  match.account(TEST_ACCOUNT, match.kind("eth_getBalance")),
);
const WETH_BALANCE_KEY: RequestMatcher = match.chain(
  mainnet.id,
  match.account(TEST_ACCOUNT, match.balanceOfToken(ETHEREUM_WETH)),
);

describe("ETH ↔ WETH 전환 실패 — 전환이 거부·실패·교체되면 사용자가 실패 종류를 구분해 본다", () => {
  describe("지갑이 서명을 거부한 경우", () => {
    /**
     * @spec EC-1
     * @given 보내는 ETH·받는 WETH로 wrap-ready이거나 보내는 WETH·받는 ETH로 unwrap-ready다. 표본: 거부(지갑이 선택 체인에 연결돼 있고 eth_sendTransaction에 code 4001 오류로 응답, code 5000 오류로 응답 — viem이 4001로 정규화, 최상위 code가 -32603이고 원인(cause)에 code 4001이 든 오류로 응답, 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 요청에 code 4001로 거부) × 종류(wrap-ready에서 wrap, unwrap-ready에서 unwrap)를 하나씩 반복한다
     * @when 주 버튼을 누르고 phase가 idle로 돌아가기를 기다린다
     * @then useSwapExecution().result는 리터럴 { kind: 표본 종류("wrap" 또는 "unwrap"), status: "rejected" }와 같다(chainId·hash를 포함한 다른 필드가 없다)
     * @then tx-status[data-status]는 rejected이고 data-kind는 표본 종류다
     * @then tx-link가 없다
     */
    it(
      "[EC-1] 서명 단계 오류의 원인 체인에 4001이 있으면 wrap·unwrap 결과는 rejected다",
      async () => {
        await forEachSample(REJECTED_SAMPLES, async (sample, kind) => {
          const label = `${sample.label} — ${kind}`;
          const s =
            sample.via === "send"
              ? await runSendFailure(sample, kind)
              : await runChainSwitchFailure(sample.code, kind);
          expect(s.probe().execution.result, label).toStrictEqual({ kind, status: "rejected" });
          expectPreSendMessage(kind, "rejected", label);
        });
      },
      caseTimeout(REJECTED_SAMPLES.length),
    );
  });

  describe("네트워크 전환이 실패한 경우", () => {
    /**
     * @spec EC-2
     * @given 스텁 지갑이 선택 체인과 다른 체인에 연결돼 있고 체인 전환 요청에 4001·4902가 아닌 code의 오류로 응답한다. 표본: 종류(보내는 ETH·받는 WETH로 wrap-ready에서 wrap, 보내는 WETH·받는 ETH로 unwrap-ready에서 unwrap)를 하나씩 반복한다
     * @when 주 버튼을 누르고 phase가 idle로 돌아가기를 기다린다
     * @then useSwapExecution().result.status는 chain-switch-failed이고 result.kind는 표본 종류다
     * @then tx-status[data-status]는 chain-switch-failed이고 data-kind는 표본 종류다
     * @then tx-link가 없다
     */
    it(
      "[EC-2] 체인 전환이 4001이 아닌 이유로 실패하면 wrap·unwrap 결과는 chain-switch-failed다",
      async () => {
        // 4001·4902가 아닌 code: 지갑 내부 오류(-32603)
        await forEachSample([RPC_INTERNAL_ERROR_CODE], async (code, kind) => {
          const label = `전환 ${code} — ${kind}`;
          const s = await runChainSwitchFailure(code, kind);
          const result = s.probe().execution.result;
          expect(result?.status, `${label} result.status`).toBe("chain-switch-failed");
          expect(result?.kind, `${label} result.kind`).toBe(kind);
          expectPreSendMessage(kind, "chain-switch-failed", label);
        });
      },
      caseTimeout(1),
    );
  });

  describe("트랜잭션을 보내지 못한 경우", () => {
    /**
     * @spec EC-3
     * @given 스텁 지갑이 선택 체인에 연결돼 있고 eth_sendTransaction에 4001이 아닌 오류로 응답한다. 표본: 오류(code -32000 — 가스 추정 실패에 해당하는 전송 오류, code -32603) × 종류(보내는 ETH·받는 WETH로 wrap-ready에서 wrap, 보내는 WETH·받는 ETH로 unwrap-ready에서 unwrap)를 하나씩 반복한다
     * @when 주 버튼을 누르고 phase가 idle로 돌아가기를 기다린다
     * @then useSwapExecution().result.status는 send-failed이고 result.kind는 표본 종류다
     * @then tx-status[data-status]는 send-failed이고 data-kind는 표본 종류다
     * @then tx-link가 없다
     */
    it(
      "[EC-3] 그 밖의 전송 오류(가스 추정 실패 포함)면 wrap·unwrap 결과는 send-failed다",
      async () => {
        await forEachSample(FAILED_SEND_SAMPLES, async (sample, kind) => {
          const label = `${sample.label} — ${kind}`;
          const s = await runSendFailure(sample, kind);
          const result = s.probe().execution.result;
          expect(result?.status, `${label} result.status`).toBe("send-failed");
          expect(result?.kind, `${label} result.kind`).toBe(kind);
          expectPreSendMessage(kind, "send-failed", label);
        });
      },
      caseTimeout(FAILED_SEND_SAMPLES.length),
    );
  });

  describe("트랜잭션을 보낸 뒤 체결되지 않은 경우", () => {
    /**
     * @spec EC-5
     * @given 스텁 지갑이 Ethereum(1)에 연결돼 있고 선택 체인도 Ethereum이며, eth_sendTransaction에 해시로 응답하고 영수증 스텁이 reverted로 응답한다. 표본: 종류(보내는 ETH·받는 WETH로 wrap-ready에서 wrap, 보내는 WETH·받는 ETH로 unwrap-ready에서 unwrap)를 하나씩 반복한다
     * @when 주 버튼을 눌러 해시를 받고 reverted 영수증을 받은 뒤 phase가 idle로 돌아가기를 기다린다
     * @then useSwapExecution().result는 리터럴 { kind: 표본 종류, status: "reverted", chainId: 1, hash: 지갑이 돌려준 원 해시 }와 같다
     * @then tx-status[data-status]는 reverted이고 data-kind는 표본 종류다
     * @then tx-link가 있고 href는 https://etherscan.io/tx/{지갑이 돌려준 원 해시} 리터럴이다
     */
    it(
      "[EC-5] wrap·unwrap 영수증이 reverted이면 결과는 reverted이고 탐색기 링크가 있다",
      async () => {
        await forEachSample(["reverted"] as const, async (receipt, kind) => {
          // 잔액 주기 다시 읽기가 일어나지 않게 주기 타이머를 가짜로 둔다.
          fakePeriodicTimers();
          const s = await renderReady(kind);
          rpc.setReceiptRule(makeReceiptRule(receipt));

          clickPrimary();
          await waitUntil(
            () =>
              expect(
                rpc
                  .requests(matchReceipt.method("eth_getTransactionReceipt"))
                  .some((request) => request.status === "ok"),
              ).toBe(true),
            READY_TIMEOUT_MS,
          );
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();

          // 전제: 지갑이 원 해시 하나를 돌려줬다.
          expect(s.wallet.hashes(), kind).toEqual([ORIGINAL_HASH]);

          expect(s.probe().execution.result, kind).toStrictEqual({
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
  });

  describe("트랜잭션이 취소되거나 다른 트랜잭션으로 대체된 경우", () => {
    /**
     * @spec EC-6
     * @given 스텁 지갑이 Ethereum(1)에 연결돼 있고 선택 체인도 Ethereum이며, 보내는 칸 금액을 입력해 두었고 잔액 주기 다시 읽기는 가짜 타이머로 일어나지 않게 한다. 지갑이 원 해시를 돌려주고 노드가 원 트랜잭션을 pending으로 돌려준 뒤, 같은 계정·nonce의 대체 트랜잭션이 블록에 실린다. 대체 트랜잭션이 블록에 실리기 직전에 트랜잭션 체인·연결 계정의 ETH 잔액 읽기 요청 수와 WETH 잔액 읽기 요청 수를 기록한다. 표본: 사유(취소 cancelled: 자기 주소로 값 0을 보내는 트랜잭션, 대체 replaced: 받는 주소·값·데이터가 다른 트랜잭션) × 대체 영수증 status(success, reverted) × 종류(보내는 ETH·받는 WETH로 wrap-ready에서 wrap, 보내는 WETH·받는 ETH로 unwrap-ready에서 unwrap)를 하나씩 반복한다
     * @when 주 버튼을 눌러 원 해시를 받고 대체 트랜잭션이 드러나 결과가 기록될 때까지 영수증 대기를 가짜 타이머로 진행한다
     * @then useSwapExecution().result는 리터럴 { kind: 표본 종류, status: "replaced", chainId: 1, hash: 대체 해시 }와 같다(대체 영수증이 reverted여도 status는 "reverted"가 아니라 "replaced"다)
     * @then result.hash가 원 해시와 다르다
     * @then tx-status[data-status]는 replaced이고 data-kind는 표본 종류다
     * @then tx-link의 href는 https://etherscan.io/tx/{대체 해시} 리터럴이다
     * @then 보내는 칸 금액이 클릭 직전 값 그대로이고 빈 값이 되지 않는다
     * @then replaced 결과가 기록된 뒤 phase가 idle로 돌아간다
     * @then replaced 결과 뒤 트랜잭션 체인·연결 계정의 ETH 잔액 읽기 요청과 WETH 잔액 읽기 요청이 각각 기록한 수보다 늘어난다
     */
    it(
      "[EC-6] wrap·unwrap 트랜잭션이 취소·대체되면 결과는 replaced이고 보내는 칸 금액을 비우지 않으며 idle로 돌아가 카드 잔액을 다시 읽는다",
      async () => {
        const reasons = ["cancelled", "replaced"] as const satisfies readonly ReplacementReason[];
        const receipts = ["success", "reverted"] as const;
        const samples = reasons.flatMap((reason) =>
          receipts.map((receipt) => ({ reason, receipt })),
        );
        await forEachSample(samples, async ({ reason, receipt }, kind) => {
          const label = `${reason} — 대체 영수증 ${receipt} — ${kind}`;
          fakePeriodicTimers();
          const s = await renderReady(kind);
          installReplacementReceipts(receipt);
          serveOriginalFields(s.wallet);
          fakeAllTimers();
          const amountBefore = amountInput().value;
          // 전제: 보내는 칸 금액을 입력해 두었다.
          expect(amountBefore, label).toBe(AMOUNT);

          // 주 버튼을 눌러 원 해시를 받고, 영수증 대기가 원 트랜잭션을 대기 중으로 조회할 때까지 진행한다.
          clickPrimary();
          await waitUntilAdvancingFakeClock(() =>
            expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
          );
          expect(s.wallet.hashes(), label).toEqual([ORIGINAL_HASH]);
          await waitUntilAdvancingFakeClock(
            () => expect(originalLookups().some((request) => request.status === "ok")).toBe(true),
            POLL_STEP_MS,
            POLL_TIMEOUT_MS,
          );
          // 전제: 대체가 드러나기 전에는 결과가 없다.
          expect(s.probe().execution.result, label).toBeNull();

          // 대체 트랜잭션이 블록에 실리기 직전의 카드 잔액 요청 수
          const ethBefore = rpc.requests(ETH_BALANCE_KEY).length;
          const wethBefore = rpc.requests(WETH_BALANCE_KEY).length;
          const original = originalTransaction(s.wallet)!;
          rpc.addBlockTransaction(
            mainnet.id,
            stubReplacementTransaction(reason, original, REPLACEMENT_HASH),
            rpc.blockNumber(mainnet.id) + 1n,
          );
          await waitUntilAdvancingFakeClock(
            () => expect(s.probe().execution.result).not.toBeNull(),
            POLL_STEP_MS,
            POLL_TIMEOUT_MS,
          );
          // 전제: 대체 트랜잭션을 블록에서 찾아 그 영수증을 조회했다(원 해시 영수증은 계속 미발견).
          const replacementReceipt = replacementReceiptCalls().find(
            (request) => request.status === "ok",
          );
          expect(replacementReceipt, label).toBeDefined();

          const result = s.probe().execution.result;
          expect(result, label).toStrictEqual({
            kind,
            status: "replaced",
            chainId: ETHEREUM_CHAIN_ID,
            hash: REPLACEMENT_HASH,
          });
          expect(result && "hash" in result ? result.hash : undefined, label).not.toBe(
            ORIGINAL_HASH,
          );
          expect(txStatus().getAttribute("data-status"), label).toBe("replaced");
          expect(txStatus().getAttribute("data-kind"), label).toBe(kind);
          expect(txLink()?.getAttribute("href"), label).toBe(`${ETHERSCAN_TX}${REPLACEMENT_HASH}`);
          expect(amountInput().value, `${label} 보내는 칸 금액`).toBe(amountBefore);

          await waitUntilAdvancingFakeClock(() => expect(s.probe().execution.phase).toBe("idle"));
          // replaced 결과 뒤(대체 영수증 조회 이후), 잔액 주기가 오기 전에 생긴 다시 읽기 요청
          const afterReplaced = (request: { seq: number; at: number }) =>
            request.seq > replacementReceipt!.seq &&
            request.at - replacementReceipt!.at < CARD_BALANCE_INTERVAL_MS;
          await waitUntilAdvancingFakeClock(() => {
            expect(
              rpc.requests(ETH_BALANCE_KEY).length,
              `${label} ETH 잔액 요청 수`,
            ).toBeGreaterThan(ethBefore);
            expect(
              rpc.requests(WETH_BALANCE_KEY).length,
              `${label} WETH 잔액 요청 수`,
            ).toBeGreaterThan(wethBefore);
            expect(
              rpc.requests(ETH_BALANCE_KEY).filter(afterReplaced).length,
              `${label} replaced 뒤 ETH 잔액 요청`,
            ).toBeGreaterThan(0);
            expect(
              rpc.requests(WETH_BALANCE_KEY).filter(afterReplaced).length,
              `${label} replaced 뒤 WETH 잔액 요청`,
            ).toBeGreaterThan(0);
          });
          expect(amountInput().value, `${label} 보내는 칸 금액`).toBe(amountBefore);
        });
      },
      caseTimeout(4),
    );
  });
});
