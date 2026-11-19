import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { type Address, type Hash, type ReplacementReason, getAddress, hexToBigInt } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";

import {
  type BalanceRpcStub,
  type ReceiptStatus,
  STUB_MAX_UINT256,
  STUB_REPLACED_TO,
  STUB_START_BLOCK,
  type StubTransaction,
  allowanceAlways,
  installBalanceRpcStub,
  match,
  matchAllowance,
  matchReceipt,
  parityQuoteRule,
  receiptRuleByHash,
  sameAddress,
  stubReplacementHash,
  stubReplacementTransaction,
  stubTransaction,
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
  advanceFakeClockInSteps,
  clearCookies,
  createNoopWagmiStorage,
  renderAppHook,
  requestsSince,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 상태 메시지 영역(tx-status의 data-status·data-kind, tx-link의 href)과
// 앱 Provider 안의 프로브로 읽은 useSwapExecution()의 phase·result로 판정한다.
// mock 경계(사용자 확정): 지갑은 스텁 EIP-1193, RPC는 전역 fetch URL 라우팅 스텁, 가짜 타이머. `vi.mock`은 쓰지 않는다.
// 교체 주입: 해시별 트랜잭션 필드, 블록 트랜잭션 목록, 대체 영수증을 RPC 스텁이 돌려주고, 영수증 대기 폴링은 가짜 타이머로 진행한다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다.
// 표본은 Ethereum의 ERC-20↔ERC-20 페어이고, 기대 해시·체인 ID·탐색기 URL은 제품 config를 쓰지 않고 리터럴로 적는다.
// "원 해시"는 지갑이 eth_sendTransaction에 돌려준 해시, "대체 해시"·"새 해시"는 같은 계정·nonce로 블록에 실린 다른 트랜잭션의 해시다.
// 원 트랜잭션 필드(보낸 계정·받는 주소·값·데이터)는 스텁 지갑이 받은 eth_sendTransaction 요청에서 가져오고, nonce는 테스트가 정한다.
// 대체 트랜잭션은 원 트랜잭션을 대기 중으로 조회한 응답을 본 뒤 다음 블록부터 블록 트랜잭션 목록에 싣는다.

const CASE_TIMEOUT_MS = 120_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;
// 영수증 대기 폴링(wagmi 기본 4초 간격)을 가짜 시계로 진행하는 대기의 단계와 실제 시간 한도
const POLL_STEP_MS = 250;
const POLL_TIMEOUT_MS = 30_000;
// EC-13 관찰 시간: 폴링 다섯 번 이상
const OBSERVE_MS = 20_000;
const OBSERVE_STEP_MS = 1_000;
// EC-29: F5 EC-18 표본 길이(영수증 대기 라이브러리의 기본 시간 제한 값과 무관하게 충분히 긴 시간, 30분 이상)
const LONG_WAIT_MS = 31 * 60_000;
// 가짜 시계 단계. viem http 요청 제한 시간(10초)과 영수증 폴링 간격(4초)보다 짧다.
const LONG_WAIT_STEP_MS = 3_000;
// 잔액 주기 다시 읽기 간격(F2). 결과 뒤 다시 읽기가 주기 읽기가 아님을 가르는 경계다.
const BALANCE_REFRESH_INTERVAL_MS = 15_000;

// Ethereum 공식 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_CHAIN_ID = 1;
const ETHERSCAN_TX = "https://etherscan.io/tx/";

// 보내는 USDC(decimals 6) 금액 1
const AMOUNT = "1";

// 표본마다 새 스텁 지갑이 처음 돌려주는 해시(원 해시)와 대체·새 트랜잭션 해시
const ORIGINAL_HASH: Hash = stubTransactionHash(1);
const REPLACEMENT_HASH: Hash = stubReplacementHash(1);
// 원 트랜잭션의 nonce(테스트가 정한 값)
const ORIGINAL_NONCE = 7;

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

function txLinkHref(): string | null {
  return screen.queryByTestId("tx-link")?.getAttribute("href") ?? null;
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution() };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  probe: () => Probe;
};

// 스텁 EIP-1193 지갑(Ethereum)으로 연결되고 선택 체인이 Ethereum인 앱에서 보내는 USDC, 받는 DAI, 금액 1을 입력해
// 주 버튼이 표본의 준비 상태(approve-required·swap-ready)가 될 때까지 기다린다.
// 견적은 가격 영향 normal·최소 수령량 > 0 규칙, allowance는 approve 표본이 기본 규칙(0), swap 표본이 maxUint256이다.
async function renderReadyApp(kind: TxKind): Promise<Scenario> {
  rpc.setQuoteRule(parityQuoteRule);
  if (kind === "swap") rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
  const stub = createStubEip1193({
    chainId: mainnet.id,
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
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(mainnet.id);
  }, READY_TIMEOUT_MS);
  await chooseToken("in", ETHEREUM_USDC);
  await chooseToken("out", ETHEREUM_DAI);
  await typeAmount(AMOUNT);
  await waitUntil(() => expect(primaryState()).toBe(READY_STATE[kind]), READY_TIMEOUT_MS);
  await waitUntil(() => {
    // 전제: 클릭 시점의 보내는 토큰 잔액을 읽어 두었다.
    expect(
      rpc.requests(match.balanceOfToken(ETHEREUM_USDC)).some((request) => request.status === "ok"),
    ).toBe(true);
  }, READY_TIMEOUT_MS);
  expect(primaryButton().disabled).toBe(false);
  return { stub, wallet, probe: () => view.result.current };
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

function nextSample(index: number) {
  if (index > 0) resetSample();
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

function blockScans() {
  return rpc.requests(matchReceipt.method("eth_getBlockByNumber"));
}

// 주 버튼을 눌러 원 해시를 받고, 영수증 대기가 원 트랜잭션 조회 응답을 받을 때까지 가짜 시계로 진행한다.
async function clickAndAwaitOriginalLookup(s: Scenario, kind: TxKind, label: string) {
  clickPrimary();
  await waitUntilAdvancingFakeClock(() => expect(s.probe().execution.phase).toBe(PROGRESS[kind]));
  // 전제: 지갑이 원 해시를 돌려줬다.
  expect(s.wallet.hashes(), label).toEqual([ORIGINAL_HASH]);
  await waitUntilAdvancingFakeClock(
    () => expect(originalLookups().some((request) => request.status === "ok")).toBe(true),
    POLL_STEP_MS,
    POLL_TIMEOUT_MS,
  );
}

// 다음 블록부터 블록 트랜잭션 목록에 싣는다(지금까지 응답한 블록에는 없다).
function mineFromNextBlock(transaction: StubTransaction) {
  rpc.addBlockTransaction(mainnet.id, transaction, rpc.blockNumber(mainnet.id) + 1n);
}

async function awaitResult(s: Scenario) {
  await waitUntilAdvancingFakeClock(
    () => expect(s.probe().execution.result).not.toBeNull(),
    POLL_STEP_MS,
    POLL_TIMEOUT_MS,
  );
}

// 원 트랜잭션을 대기 중으로 조회한 뒤 `reason`의 대체·새 트랜잭션을 다음 블록부터 싣고, 결과가 기록될 때까지 진행한다.
// 대체·새 해시 영수증 상태는 미리 설치한 영수증 규칙(`installReplacementReceipts`)을 따른다.
// 반환값은 대체 해시 영수증 조회 응답(대체가 블록에서 드러난 시점)이다.
async function runReplacement(s: Scenario, kind: TxKind, reason: ReplacementReason, label: string) {
  await clickAndAwaitOriginalLookup(s, kind, label);
  // 전제: 대체가 드러나기 전에는 결과가 없다.
  expect(s.probe().execution.result, label).toBeNull();
  const original = originalTransaction(s.wallet)!;
  mineFromNextBlock(stubReplacementTransaction(reason, original, REPLACEMENT_HASH));
  await awaitResult(s);
  // 전제: 대체 트랜잭션을 블록에서 찾아 그 영수증을 조회했다(원 해시 영수증은 계속 미발견).
  const replacementReceipt = replacementReceiptCalls().find((request) => request.status === "ok");
  expect(replacementReceipt, label).toBeDefined();
  return replacementReceipt!;
}

// 원 해시 영수증은 미발견, 대체·새 해시 영수증은 `receipt`, 트랜잭션 조회는 대기 중인 영수증 규칙
function installReplacementReceipts(receipt: Exclude<ReceiptStatus, "not-found">) {
  rpc.setReceiptRule(receiptRuleByHash({ [REPLACEMENT_HASH]: receipt }));
}

describe("트랜잭션 교체·가속 — 취소되거나 대체되거나 가속된 트랜잭션의 결과를 구분해 보고 탐색기에서 확인한다", () => {
  describe("트랜잭션이 취소되거나 다른 트랜잭션으로 대체된 경우", () => {
    /**
     * @spec EC-9 EC-10 EC-11
     * @given 보내는 칸 금액을 입력해 두었고 잔액 주기 다시 읽기는 가짜 타이머로 일어나지 않게 한다. 지갑이 원 해시를 돌려주고 노드가 원 트랜잭션을 pending으로 돌려준 뒤, 같은 계정·nonce의 대체 트랜잭션이 블록에 실린다. 표본: 사유(취소 cancelled: 자기 주소로 값 0을 보내는 트랜잭션, 대체 replaced: 받는 주소·값·데이터가 다른 트랜잭션) × 대체 영수증 status(success, reverted) × 실행(approve-required에서 approve, swap-ready에서 swap)을 하나씩 반복한다
     * @when 주 버튼을 눌러 원 해시를 받고 대체 트랜잭션이 드러나 결과가 기록될 때까지 영수증 대기를 가짜 타이머로 진행한다
     * @then result의 kind·status·chainId·hash가 각각 표본 kind, "replaced", 1(Ethereum), 대체 해시다(대체 영수증이 reverted여도 status는 "reverted"가 아니라 "replaced"다)
     * @then result.hash가 원 해시와 다르다
     * @then tx-status의 data-status는 "replaced"이고 data-kind는 표본 kind다
     * @then tx-link의 href는 https://etherscan.io/tx/{대체 해시}다
     * @then swap 표본은 보내는 칸 금액이 클릭 직전 값 그대로다
     * @then swap 표본은 phase가 idle로 돌아간다
     * @then swap 표본은 replaced 결과 뒤 잔액 읽기 요청이 새로 생긴다
     * @then swap 표본은 replaced 결과 뒤 allowance 읽기 요청이 새로 생긴다
     */
    it(
      "[EC-9][EC-10][EC-11] 취소되거나 대체되면 대체 영수증 결과와 무관하게 replaced를 대체 해시로 기록하고, swap은 금액을 비우지 않고 idle로 돌아가 잔액과 allowance를 다시 읽는다",
      async () => {
        const reasons = ["cancelled", "replaced"] as const satisfies readonly ReplacementReason[];
        const receipts = ["success", "reverted"] as const;
        let sampleCount = 0;
        for (const reason of reasons) {
          for (const receipt of receipts) {
            for (const kind of TX_KINDS) {
              nextSample(sampleCount);
              sampleCount += 1;
              const label = `${reason} — 대체 영수증 ${receipt} — ${kind}`;
              fakePeriodicTimers();
              const s = await renderReadyApp(kind);
              installReplacementReceipts(receipt);
              serveOriginalFields(s.wallet);
              fakeAllTimers();
              const amountBefore = amountInput().value;

              const replacementReceipt = await runReplacement(s, kind, reason, label);

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
              expect(txLinkHref(), label).toBe(`${ETHERSCAN_TX}${REPLACEMENT_HASH}`);

              if (kind === "swap") {
                expect(amountBefore, label).toBe(AMOUNT);
                expect(amountInput().value, label).toBe(amountBefore);
                expect(s.probe().execution.phase, label).toBe("idle");
                // 대체가 드러난 뒤(대체 영수증 조회 이후), 잔액 주기가 오기 전에 생긴 다시 읽기 요청
                const afterReplaced = (request: { seq: number; at: number }) =>
                  request.seq > replacementReceipt.seq &&
                  request.at - replacementReceipt.at < BALANCE_REFRESH_INTERVAL_MS;
                await waitUntilAdvancingFakeClock(() => {
                  for (const token of [ETHEREUM_USDC, ETHEREUM_DAI]) {
                    expect(
                      rpc.requests(match.balanceOfToken(token)).filter(afterReplaced).length,
                      `${label} 잔액 ${token}`,
                    ).toBeGreaterThan(0);
                  }
                  expect(
                    rpc.requests(matchAllowance.any).filter(afterReplaced).length,
                    `${label} allowance`,
                  ).toBeGreaterThan(0);
                });
                expect(amountInput().value, label).toBe(amountBefore);
              }
            }
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("트랜잭션이 가속(repriced)된 경우", () => {
    /**
     * @spec EC-12
     * @given 클릭 시점의 보내는 토큰 잔액을 읽어 두었고, approve 표본은 새 영수증 뒤 다시 읽은 보내는 토큰 잔액이 클릭 시점 잔액과 같다. 지갑이 원 해시를 돌려주고 노드가 원 트랜잭션을 pending으로 돌려준 뒤, 받는 주소·값·데이터가 같고 가스 가격만 다른 같은 계정·nonce의 새 트랜잭션이 블록에 실리고 새 영수증은 success다. 표본: approve-required에서 approve, swap-ready에서 swap을 하나씩 반복한다
     * @when 주 버튼을 눌러 원 해시를 받고 새 트랜잭션이 드러나 결과가 기록될 때까지 영수증 대기를 가짜 타이머로 진행한다
     * @then approve 표본의 result는 { kind: "approve", status: "success", chainId: 1, hash: 새 해시, balanceDropped: false }다
     * @then swap 표본의 result는 { kind: "swap", status: "success", chainId: 1, hash: 새 해시 }이고 balanceDropped 필드가 없다
     * @then result.hash가 원 해시와 다르다
     * @then tx-status의 data-status는 "success"다
     * @then tx-link의 href는 https://etherscan.io/tx/{새 해시}다
     * @then approve 표본은 새 영수증 뒤 allowance 읽기 요청과 보내는 토큰 잔액 읽기 요청이 새로 생긴다
     */
    it(
      "[EC-12] 가속된 새 트랜잭션 영수증이 success이면 success를 새 해시로 기록한다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          nextSample(index);
          const label = `repriced success — ${kind}`;
          fakePeriodicTimers();
          const s = await renderReadyApp(kind);
          installReplacementReceipts("success");
          serveOriginalFields(s.wallet);
          fakeAllTimers();
          // 잔액 규칙은 바꾸지 않는다: 새 영수증 뒤 다시 읽은 잔액이 클릭 시점 잔액과 같다.
          const balanceQuery = {
            chainId: mainnet.id,
            account: TEST_ACCOUNT,
            token: ETHEREUM_USDC,
          } as const;
          const balanceAtClick = rpc.balanceOf(balanceQuery);

          const newReceipt = await runReplacement(s, kind, "repriced", label);

          const result = s.probe().execution.result;
          if (kind === "approve") {
            expect(result, label).toStrictEqual({
              kind: "approve",
              status: "success",
              chainId: ETHEREUM_CHAIN_ID,
              hash: REPLACEMENT_HASH,
              balanceDropped: false,
            });
            // 전제: 다시 읽은 잔액이 클릭 시점 잔액과 같다.
            expect(rpc.balanceOf(balanceQuery), label).toBe(balanceAtClick);
            const sinceReceipt = (request: { seq: number }) => request.seq > newReceipt.seq;
            expect(
              rpc.requests(matchAllowance.any).filter(sinceReceipt).length,
              `${label} allowance`,
            ).toBeGreaterThan(0);
            expect(
              rpc.requests(match.balanceOfToken(ETHEREUM_USDC)).filter(sinceReceipt).length,
              `${label} 보내는 토큰 잔액`,
            ).toBeGreaterThan(0);
          } else {
            expect(result, label).toStrictEqual({
              kind: "swap",
              status: "success",
              chainId: ETHEREUM_CHAIN_ID,
              hash: REPLACEMENT_HASH,
            });
            expect(result !== null && "balanceDropped" in result, label).toBe(false);
          }
          expect(result && "hash" in result ? result.hash : undefined, label).not.toBe(
            ORIGINAL_HASH,
          );
          expect(txStatus().getAttribute("data-status"), label).toBe("success");
          expect(txLinkHref(), label).toBe(`${ETHERSCAN_TX}${REPLACEMENT_HASH}`);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-12
     * @given 지갑이 원 해시를 돌려주고 노드가 원 트랜잭션을 pending으로 돌려준 뒤, 받는 주소·값·데이터가 같고 가스 가격만 다른 같은 계정·nonce의 새 트랜잭션이 블록에 실리고 새 영수증은 reverted다. 표본: approve-required에서 approve, swap-ready에서 swap을 하나씩 반복한다
     * @when 주 버튼을 눌러 원 해시를 받고 새 트랜잭션이 드러날 때까지 영수증 대기를 가짜 타이머로 진행한다
     * @then result의 kind·status·chainId·hash가 각각 표본 kind, "reverted", 1(Ethereum), 새 해시다
     * @then result.hash가 원 해시와 다르다
     * @then tx-status의 data-status는 "reverted"다
     * @then tx-link의 href는 https://etherscan.io/tx/{새 해시}다
     */
    it(
      "[EC-12] 가속된 새 트랜잭션 영수증이 reverted이면 reverted를 새 해시로 기록한다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          nextSample(index);
          const label = `repriced reverted — ${kind}`;
          fakePeriodicTimers();
          const s = await renderReadyApp(kind);
          installReplacementReceipts("reverted");
          serveOriginalFields(s.wallet);
          fakeAllTimers();

          await runReplacement(s, kind, "repriced", label);

          const result = s.probe().execution.result;
          expect(result, label).toStrictEqual({
            kind,
            status: "reverted",
            chainId: ETHEREUM_CHAIN_ID,
            hash: REPLACEMENT_HASH,
          });
          expect(result && "hash" in result ? result.hash : undefined, label).not.toBe(
            ORIGINAL_HASH,
          );
          expect(txStatus().getAttribute("data-status"), label).toBe("reverted");
          expect(txLinkHref(), label).toBe(`${ETHERSCAN_TX}${REPLACEMENT_HASH}`);
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-13
     * @given 지갑이 원 해시를 돌려주고 노드가 원 트랜잭션을 한 번 pending으로 돌려준 뒤 원 트랜잭션 조회가 not found로 바뀌어 노드에서 사라졌고, 가속된 새 트랜잭션(받는 주소·값·데이터가 같고 가스 가격만 다른 같은 계정·nonce의 트랜잭션)은 아직 블록에 실리지 않았다. 표본: approve-required에서 approve, swap-ready에서 swap을 하나씩 반복한다
     * @when 주 버튼을 눌러 원 해시를 받고, 원 트랜잭션이 사라진 뒤 새 트랜잭션이 블록에 드러나기 전까지 영수증 대기를 가짜 타이머로 진행한다
     * @then 그동안 tx-status의 data-status는 "pending"이다
     * @then 그동안 tx-link의 href는 https://etherscan.io/tx/{원 해시}다
     * @then 그동안 result는 null이다
     */
    it(
      "[EC-13] 원 트랜잭션이 노드에서 사라지고 가속된 트랜잭션이 아직 블록에 없는 pending 동안 tx-link는 원래 해시를 가리킨다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          nextSample(index);
          const label = `repriced 대기 — ${kind}`;
          const s = await renderReadyApp(kind);
          // 원 해시 조회는 처음 한 번만 대기 중이고 그 뒤로는 not found다. 새 해시 영수증은 success다.
          let originalServed = false;
          rpc.setReceiptRule(
            receiptRuleByHash(
              { [REPLACEMENT_HASH]: "success" },
              {
                transaction: ({ hash }) => {
                  if (!sameHash(hash, ORIGINAL_HASH)) return "pending";
                  if (originalServed) return "not-found";
                  originalServed = true;
                  return "pending";
                },
              },
            ),
          );
          serveOriginalFields(s.wallet);
          fakeAllTimers();

          await clickAndAwaitOriginalLookup(s, kind, label);
          // 가속된 새 트랜잭션은 관찰 구간이 끝난 뒤에야 블록에 실린다(아직 블록에 없다).
          const original = originalTransaction(s.wallet)!;
          rpc.addBlockTransaction(
            mainnet.id,
            stubReplacementTransaction("repriced", original, REPLACEMENT_HASH),
            rpc.blockNumber(mainnet.id) + 1_000_000n,
          );
          const scansBefore = blockScans().length;

          const violations: string[] = [];
          const expectedHref = `${ETHERSCAN_TX}${ORIGINAL_HASH}`;
          const check = (at: string) => {
            const status = txStatus().getAttribute("data-status");
            const href = txLinkHref();
            const result = s.probe().execution.result;
            if (status !== "pending" || href !== expectedHref || result !== null) {
              violations.push(
                `${at}: data-status=${status} href=${href} result=${JSON.stringify(result)}`,
              );
            }
          };
          check("관찰 시작");
          await advanceFakeClockInSteps(OBSERVE_MS, OBSERVE_STEP_MS, (elapsedMs) =>
            check(`${elapsedMs}ms`),
          );

          expect(violations, label).toEqual([]);
          // 전제: 원 트랜잭션은 한 번 대기 중으로 조회된 뒤 not found로 바뀌었고, 그동안 영수증 대기는 블록을 계속 확인했으나
          // 새 트랜잭션은 블록에 드러나지 않았다.
          expect(originalServed, label).toBe(true);
          expect(blockScans().length - scansBefore, label).toBeGreaterThanOrEqual(2);
          expect(replacementReceiptCalls(), label).toEqual([]);
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("원 트랜잭션을 한 번도 pending으로 보지 못한 채 교체된 경우", () => {
    /**
     * @spec EC-29
     * @given 지갑이 원 해시를 돌려주지만 노드는 원 트랜잭션 조회에 처음부터 계속 not found로 응답하고 원 영수증도 계속 미발견이며, 같은 계정·nonce의 다른 해시 트랜잭션이 블록에 실려 있다. 표본: approve-required에서 approve, swap-ready에서 swap을 하나씩 반복한다
     * @when 주 버튼을 눌러 원 해시를 받은 뒤 가짜 타이머로 영수증이 오래 나오지 않는 시간(F5 EC-18 표본 길이 이상)을 진행한다
     * @then 진행하는 동안 tx-status의 data-status는 "pending"을 유지한다
     * @then 진행하는 동안 tx-link의 href는 https://etherscan.io/tx/{원 해시}를 유지한다
     * @then 진행하는 동안 result는 null이고 phase는 표본의 진행 phase(approving·swapping)를 유지한다
     * @then 클릭부터 지갑의 eth_sendTransaction 요청까지 nonce 조회 요청(eth_getTransactionCount)이 RPC와 지갑 어디에도 없다
     */
    it(
      "[EC-29] 원 트랜잭션을 pending으로 보지 못한 채 교체되면 교체를 감지하지 않고 pending과 원 해시 tx-link를 유지한다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          nextSample(index);
          const label = `원 트랜잭션 미조회 — ${kind}`;
          const s = await renderReadyApp(kind);
          // 원 해시는 조회·영수증 모두 처음부터 not found, 같은 계정·nonce의 다른 해시 트랜잭션은 모든 블록에 실려 있고 영수증이 있다.
          rpc.setReceiptRule(
            receiptRuleByHash(
              { [REPLACEMENT_HASH]: "success" },
              {
                transaction: ({ hash }) =>
                  sameHash(hash, ORIGINAL_HASH) ? "not-found" : "pending",
              },
            ),
          );
          rpc.addBlockTransaction(
            mainnet.id,
            stubTransaction({
              hash: REPLACEMENT_HASH,
              from: TEST_ACCOUNT,
              nonce: ORIGINAL_NONCE,
              to: STUB_REPLACED_TO,
              value: 1n,
            }),
            STUB_START_BLOCK,
          );
          fakeAllTimers();
          const rpcSeqAtClick = rpc.requests().length;
          const walletFrom = s.stub.requests.length;

          clickPrimary();
          await waitUntilAdvancingFakeClock(() =>
            expect(s.probe().execution.phase).toBe(PROGRESS[kind]),
          );
          // 전제: 지갑이 원 해시를 돌려줬다.
          expect(s.wallet.hashes(), label).toEqual([ORIGINAL_HASH]);
          await waitUntilAdvancingFakeClock(
            () => expect(originalLookups().length).toBeGreaterThan(0),
            POLL_STEP_MS,
            POLL_TIMEOUT_MS,
          );

          const expectedHref = `${ETHERSCAN_TX}${ORIGINAL_HASH}`;
          const startedAt = Date.now();
          const violations: string[] = [];
          await advanceFakeClockInSteps(LONG_WAIT_MS, LONG_WAIT_STEP_MS, (elapsedMs) => {
            const status = txStatus().getAttribute("data-status");
            const href = txLinkHref();
            const { result, phase } = s.probe().execution;
            if (
              status !== "pending" ||
              href !== expectedHref ||
              result !== null ||
              phase !== PROGRESS[kind]
            ) {
              violations.push(
                `${elapsedMs}ms: data-status=${status} href=${href} phase=${phase} result=${JSON.stringify(result)}`,
              );
            }
          });

          expect(violations, label).toEqual([]);
          expect(Date.now() - startedAt, label).toBeGreaterThanOrEqual(LONG_WAIT_MS);
          // 전제: 그동안 원 트랜잭션 조회가 계속 not found로 응답받으며 이어졌고, 대체 영수증은 조회되지 않았다.
          expect(originalLookups().length, label).toBeGreaterThan(1);
          expect(
            originalLookups().every((request) => request.status === "ok"),
            label,
          ).toBe(true);
          expect(replacementReceiptCalls(), label).toEqual([]);

          // nonce 조회 없음: 클릭 뒤 RPC와 지갑이 받은 요청 전체(클릭~eth_sendTransaction 구간을 포함)에 eth_getTransactionCount가 없다.
          expect(s.wallet.sent, label).toHaveLength(1);
          expect(
            rpc
              .requests(match.since(rpcSeqAtClick))
              .filter((request) => request.method === "eth_getTransactionCount"),
            label,
          ).toEqual([]);
          expect(requestsSince(s.stub, walletFrom, ["eth_getTransactionCount"]), label).toEqual([]);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
