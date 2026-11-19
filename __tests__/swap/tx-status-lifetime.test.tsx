import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, disconnect, getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";
import { type TxResult, useSwapExecution } from "@/providers/swap-execution-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSlippage } from "@/providers/slippage-provider";

import {
  type BalanceFn,
  type BalanceRpcStub,
  STUB_MAX_UINT256,
  allowanceAlways,
  balancesWith,
  installBalanceRpcStub,
  match,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type StubEip1193,
  USER_REJECTED_CODE,
  type WalletTransactionControl,
  createStubEip1193,
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

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 화면 조작(금액 입력, 모달 토큰 선택, 뒤집기, `최대`, 체인 선택 드롭다운, 슬리피지 팝오버)으로 상태를 만든다.
// useSwapExecution()의 phase·pendingTx·result와 approve·swap 호출은 앱 Provider 안의 프로브(renderAppHook)로 읽고 부른다.
// 지갑은 스텁 EIP-1193을 쓴다(체인 전환·eth_sendTransaction 기록·해시 응답·4001 거부·응답 붙잡기, 계정 변경, 연결 해제).
// RPC는 전역 fetch URL 라우팅 스텁이 응답한다(견적, 잔액, allowance, 영수증 계열의 성공·붙잡기).
// 시간은 가짜 타이머(가짜 시계)로 다룬다(EC-20). `vi.mock`은 쓰지 않는다.
// "입력 변경"은 금액·토큰·선택 체인 값이 실제로 바뀐 사용자 조작만이고, 슬리피지 변경은 입력 변경이 아니다.
// "새로 누르면"은 실행을 시작한(awaiting-signature로 넘어가는) approve·swap 호출만이다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다. 같은 case 안의 표본마다 앱과 스텁을 새로 만든다.
// 표본 페어는 ERC-20↔ERC-20 페어이고, 기대 해시·체인 ID·탐색기 URL은 제품 config를 쓰지 않고 리터럴로 적는다.

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;

// Ethereum 공식 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const ETHEREUM_CHAIN_ID = 1;
const BASE_CHAIN_ID = 8453;
const ETHERSCAN_TX = "https://etherscan.io/tx/";

// 보내는 USDC(decimals 6) 금액 1 → amountInRaw 1_000_000
const AMOUNT = "1";
const ONE_USDC_RAW = 1_000_000n;

// 첫 전송에 스텁 지갑이 돌려주는 해시
const FIRST_HASH = stubTransactionHash(1);

// EC-20: F5 EC-18 표본 길이(영수증 대기 라이브러리의 기본 시간 제한 값과 무관하게 충분히 긴 시간, 30분 이상)
const LONG_WAIT_MS = 31 * 60_000;
// 가짜 시계 단계. viem http 요청 제한 시간(10초)과 영수증 폴링 간격(4초)보다 짧다.
const LONG_WAIT_STEP_MS = 3_000;
// 가짜 시계에서 영수증 대기 폴링을 진행하는 대기의 단계와 실제 시간 한도
const POLL_STEP_MS = 250;
const POLL_TIMEOUT_MS = 30_000;

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

function selectedChainAttr(): string | null {
  return screen.getByTestId("chain-select").getAttribute("data-selected-chain-id");
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

function clickMax() {
  fireEvent.click(within(field("in")).getByTestId("max-button"));
}

function clickFlip() {
  fireEvent.click(screen.getByTestId("flip-button"));
}

function txStatus(): HTMLElement {
  return screen.getByTestId("tx-status");
}

function slippagePopover(): HTMLElement | null {
  return screen.queryByTestId("slippage-popover");
}

async function chooseSlippagePreset(bps: number) {
  fireEvent.click(screen.getByTestId("slippage-button"));
  await waitUntil(() => expect(slippagePopover()).not.toBeNull());
  const option = within(slippagePopover()!)
    .getAllByTestId("slippage-option")
    .find((element) => element.getAttribute("data-slippage-bps") === String(bps));
  if (!option) throw new Error(`slippage-option[data-slippage-bps="${bps}"]가 없다`);
  fireEvent.click(option);
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution(), form: useSwapForm(), slippage: useSlippage() };
}

type Probe = ReturnType<typeof useProbe>;

// 렌더마다 phase를 기록하는 프로브를 만든다(EC-28 전제: 호출이 awaiting-signature로 넘어가지 않았는지).
function createRecordingProbe(phases: string[]) {
  return function useRecordingProbe(): Probe {
    const value = useProbe();
    phases.push(value.execution.phase);
    return value;
  };
}

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  config: ReturnType<typeof createWagmiConfig>;
  phases: string[];
  probe: () => Probe;
};

// 스텁 EIP-1193 지갑(Ethereum)으로 연결되고 선택 체인이 Ethereum인 앱에서 보내는 USDC, 받는 DAI, 금액 1을 입력해
// 주 버튼이 표본의 준비 상태(approve-required·swap-ready)가 될 때까지 기다린다.
// 견적은 가격 영향 normal·최소 수령량 > 0 규칙, allowance는 approve 표본이 기본 규칙(0), swap 표본이 maxUint256이다.
async function renderReadyApp(
  kind: TxKind,
  { balances }: { balances?: BalanceFn } = {},
): Promise<Scenario> {
  rpc.setQuoteRule(parityQuoteRule);
  if (balances) rpc.setBalances(balances);
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
  const phases: string[] = [];
  const view = renderAppHook(createRecordingProbe(phases), {
    config,
    initialChainId: mainnet.id,
  });
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
  await settlePendingWork();
  expect(primaryButton().disabled).toBe(false);
  return { stub, wallet, config, phases, probe: () => view.result.current };
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

// 클릭 직전에 setTimeout까지 가짜로 바꾼다(viem 폴링·재시도 지연과 제품의 시간 기반 동작이 가짜 시계를 따른다).
function fakeAllTimers() {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}

// ─── 결과 만들기 ──────────────────────────────────────────────────

// phase가 idle로 돌아가고 결과가 기록되기를 기다린다.
async function waitForResult(s: Scenario): Promise<TxResult> {
  await waitUntil(() => {
    expect(s.probe().execution.phase).toBe("idle");
    expect(s.probe().execution.result).not.toBeNull();
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
  const result = s.probe().execution.result;
  if (!result) throw new Error("result가 없다");
  return result;
}

// 주 버튼을 눌러 표본 종류의 트랜잭션을 보내고 영수증 성공 결과를 받는다.
// 영수증 응답을 붙잡은 진행 중에 `beforeReceipt`를 실행한 뒤 응답을 푼다.
async function runToSuccess(
  s: Scenario,
  kind: TxKind,
  beforeReceipt?: () => void | Promise<void>,
): Promise<TxResult> {
  const receiptGate = rpc.holdReceipt();
  clickPrimary();
  await waitUntil(() => expect(s.probe().execution.phase).toBe(PROGRESS[kind]), READY_TIMEOUT_MS);
  await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
  await beforeReceipt?.();
  receiptGate.release();
  const result = await waitForResult(s);
  // 전제: 표본 종류의 성공 결과다.
  expect(result).toMatchObject({ kind, status: "success", chainId: ETHEREUM_CHAIN_ID });
  return result;
}

// approve-required에서 주 버튼을 눌러 지갑이 서명을 거부(4001)한 rejected 결과를 받는다. 이후 응답 방식은 해시로 되돌린다.
async function runToRejectedApprove(s: Scenario): Promise<TxResult> {
  s.wallet.reply({ type: "error", code: USER_REJECTED_CODE });
  clickPrimary();
  const result = await waitForResult(s);
  // 전제: approve rejected 결과다.
  expect(result).toEqual({ kind: "approve", status: "rejected" });
  s.wallet.reply({ type: "hash" });
  return result;
}

// approve 성공 결과(balanceDropped false)가 보이는 앱
async function renderWithApproveSuccess(options?: { balances?: BalanceFn }) {
  const s = await renderReadyApp("approve", options);
  const result = await runToSuccess(s, "approve");
  expect(txStatus().getAttribute("data-status")).toBe("success");
  return { s, result };
}

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

// 결과 메시지의 닫기를 누르고 결과·메시지 영역이 비워지기를 확인한다(DoD-13·DoD-2).
async function dismissAndExpectNone(s: Scenario, label: string) {
  // 전제: 결과 메시지와 닫기 버튼이 보인다.
  expect(txStatus().getAttribute("data-status"), label).not.toBe("none");
  const dismiss = screen.queryByTestId("tx-status-dismiss");
  expect(dismiss, label).not.toBeNull();

  fireEvent.click(dismiss!);
  await waitUntil(() => expect(s.probe().execution.result).toBeNull(), READY_TIMEOUT_MS);
  await settlePendingWork();

  expect(s.probe().execution.result, label).toBeNull();
  expect(txStatus().getAttribute("data-status"), label).toBe("none");
  expect(screen.queryByTestId("tx-link"), label).toBeNull();
  expect(screen.queryByTestId("tx-status-dismiss"), label).toBeNull();
  expect(screen.queryByTestId("tx-balance-notice"), label).toBeNull();
}

function formSnapshot(s: Scenario) {
  const { amountIn, tokenIn, tokenOut, chainId } = s.probe().form;
  return {
    amountIn,
    tokenIn: tokenIn?.address.toLowerCase() ?? null,
    tokenOut: tokenOut?.address.toLowerCase() ?? null,
    chainId,
    selectedChain: selectedChainAttr(),
  };
}

describe("트랜잭션 결과 메시지 — 사용자가 닫거나 입력을 바꾸거나 새로 실행하기 전까지 결과가 남는다", () => {
  describe("닫기", () => {
    /**
     * @spec DoD-13 DoD-2
     * @given 결과 메시지가 보인다. 표본: approve 성공 결과(balanceDropped false), balanceDropped가 true인 approve 성공 결과(다시 읽은 보내는 토큰 잔액이 클릭 시점 잔액보다 작아 tx-balance-notice가 보임), swap 성공 결과, approve 서명 거부(4001)로 끝난 rejected 결과를 하나씩 반복한다
     * @when 결과 메시지의 tx-status-dismiss를 누른다
     * @then useSwapExecution().result가 null이 된다
     * @then tx-status[data-status]가 none이 된다
     * @then 닫은 뒤 tx-link·tx-status-dismiss·tx-balance-notice가 없다
     */
    it(
      "[DoD-13][DoD-2] 결과 메시지의 닫기를 누르면 result가 null이 되고 data-status가 none이 되며 링크·닫기·잔액 감소 안내가 없다",
      async () => {
        const samples = [
          "approve 성공(balanceDropped false)",
          "approve 성공(balanceDropped true)",
          "swap 성공",
          "approve rejected",
        ] as const;

        for (const [index, sample] of samples.entries()) {
          nextSample(index);
          if (sample === "approve 성공(balanceDropped false)") {
            const s = await renderReadyApp("approve");
            const result = await runToSuccess(s, "approve");
            expect(result, sample).toMatchObject({ balanceDropped: false });
            await dismissAndExpectNone(s, sample);
          } else if (sample === "approve 성공(balanceDropped true)") {
            // 클릭 시점 USDC 잔액 5, 영수증 뒤 다시 읽은 잔액 4
            const s = await renderReadyApp("approve", {
              balances: balancesWith({ [ETHEREUM_USDC]: 5n * ONE_USDC_RAW }),
            });
            const result = await runToSuccess(s, "approve", () => {
              rpc.setBalances(balancesWith({ [ETHEREUM_USDC]: 4n * ONE_USDC_RAW }));
            });
            // 전제: 잔액 감소 안내가 보인다.
            expect(result, sample).toMatchObject({ balanceDropped: true });
            expect(screen.queryByTestId("tx-balance-notice"), sample).not.toBeNull();
            await dismissAndExpectNone(s, sample);
          } else if (sample === "swap 성공") {
            const s = await renderReadyApp("swap");
            await runToSuccess(s, "swap");
            await dismissAndExpectNone(s, sample);
          } else {
            const s = await renderReadyApp("approve");
            await runToRejectedApprove(s);
            await dismissAndExpectNone(s, sample);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("사용자 입력 변경", () => {
    /**
     * @spec DoD-14
     * @given approve 성공 결과 메시지가 보인다. 표본(사용자 조작): 보내는 칸에 현재와 다른 금액 입력, 보내는 칸 모달에서 현재와 다른 토큰 선택, 받는 칸 모달에서 현재와 다른 토큰 선택, 뒤집기, 현재 금액이 보내는 토큰 잔액 전체와 다를 때 `최대`, 체인 선택 드롭다운으로 현재와 다른 체인 선택을 하나씩 반복한다
     * @when 표본의 조작으로 금액·토큰·선택 체인 값을 실제로 바꾼다
     * @then useSwapExecution().result가 null이 된다
     */
    it(
      "[DoD-14] 결과가 보이는 동안 금액 입력·토큰 선택·뒤집기·최대·선택 체인 변경으로 값이 바뀌면 result가 null이 된다",
      async () => {
        const operations = [
          "금액 입력",
          "보내는 칸 토큰 선택",
          "받는 칸 토큰 선택",
          "뒤집기",
          "최대",
          "선택 체인 변경",
        ] as const;

        for (const [index, operation] of operations.entries()) {
          nextSample(index);
          const { s } = await renderWithApproveSuccess();
          const before = formSnapshot(s);
          expect(s.probe().execution.result, operation).not.toBeNull();

          if (operation === "금액 입력") {
            await typeAmount("2");
          } else if (operation === "보내는 칸 토큰 선택") {
            await chooseToken("in", ETHEREUM_WETH);
            expect(sameAddress(tokenAddress("in") ?? undefined, ETHEREUM_WETH), operation).toBe(
              true,
            );
          } else if (operation === "받는 칸 토큰 선택") {
            await chooseToken("out", ETHEREUM_USDT);
            expect(sameAddress(tokenAddress("out") ?? undefined, ETHEREUM_USDT), operation).toBe(
              true,
            );
          } else if (operation === "뒤집기") {
            clickFlip();
            await waitUntil(() =>
              expect(sameAddress(tokenAddress("in") ?? undefined, ETHEREUM_DAI)).toBe(true),
            );
          } else if (operation === "최대") {
            // 전제: 현재 금액(1)이 보내는 토큰 잔액 전체와 다르고 잔액을 안다.
            expect(
              within(field("in")).getByTestId("max-button").hasAttribute("disabled"),
              operation,
            ).toBe(false);
            clickMax();
            await waitUntil(() => expect(amountInput().value).not.toBe(AMOUNT));
          } else {
            await chooseChainFromDropdown(base);
          }

          // 전제: 표본의 조작으로 금액·토큰·선택 체인 값이 실제로 바뀌었다.
          expect(formSnapshot(s), operation).not.toEqual(before);
          await waitUntil(() => expect(s.probe().execution.result).toBeNull(), READY_TIMEOUT_MS);
          await settlePendingWork();
          expect(s.probe().execution.result, operation).toBeNull();
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-27
     * @given approve 성공 결과 메시지가 보인다. 표본(값을 바꾸지 않는 사용자 조작): 형식 검사에 걸려 금액 값이 바뀌지 않는 금액 입력, 모달에서 현재 선택된 토큰 재선택, 체인 선택 드롭다운에서 현재 선택된 체인 재선택, 금액이 이미 보내는 토큰 잔액 전체와 같을 때 `최대`를 하나씩 반복한다. 전제: 조작 뒤 금액·토큰·선택 체인 값이 조작 전과 같다
     * @when 표본의 조작을 한다
     * @then useSwapExecution().result가 조작 전 결과 그대로이고 null이 되지 않는다
     */
    it(
      "[EC-27] 값을 바꾸지 않는 사용자 조작으로는 result가 지워지지 않는다",
      async () => {
        const operations = [
          "형식 검사에 걸린 금액 입력",
          "같은 토큰 재선택",
          "같은 체인 재선택",
          "같은 값에서 최대",
        ] as const;

        for (const [index, operation] of operations.entries()) {
          nextSample(index);
          // `최대` 표본은 보내는 USDC 잔액을 금액과 같은 1 USDC로 둔다.
          const { s, result } = await renderWithApproveSuccess(
            operation === "같은 값에서 최대"
              ? { balances: balancesWith({ [ETHEREUM_USDC]: ONE_USDC_RAW }) }
              : undefined,
          );
          const before = formSnapshot(s);

          if (operation === "형식 검사에 걸린 금액 입력") {
            // USDC decimals(6)를 넘는 소수 자릿수
            fireEvent.change(amountInput(), { target: { value: "1.1234567" } });
          } else if (operation === "같은 토큰 재선택") {
            await chooseToken("in", ETHEREUM_USDC);
          } else if (operation === "같은 체인 재선택") {
            await chooseChainFromDropdown(mainnet);
          } else {
            // 전제: 금액이 이미 보내는 토큰 잔액 전체(1 USDC)와 같다.
            expect(
              within(field("in")).getByTestId("balance").getAttribute("data-balance-raw"),
              operation,
            ).toBe(String(ONE_USDC_RAW));
            expect(amountInput().value, operation).toBe(AMOUNT);
            clickMax();
          }
          await settlePendingWork();

          // 전제: 조작 뒤 금액·토큰·선택 체인 값이 조작 전과 같다.
          expect(formSnapshot(s), operation).toEqual(before);
          expect(amountInput().value, operation).toBe(AMOUNT);
          expect(s.probe().execution.result, operation).not.toBeNull();
          expect(s.probe().execution.result, operation).toEqual(result);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-18
     * @given swap-ready 상태에서 주 버튼을 눌러 swap 영수증이 성공으로 나온다
     * @when 앱이 스왑 성공 뒤 보내는 칸 금액을 빈 값으로 비운다
     * @then 보내는 칸 금액이 빈 값이 된 뒤에도 useSwapExecution().result는 { kind: "swap", status: "success", chainId, hash } 그대로이고 null이 되지 않는다
     */
    it(
      "[EC-18] 스왑 성공 뒤 앱이 보내는 칸 금액을 비워도 result가 지워지지 않는다",
      async () => {
        const s = await renderReadyApp("swap");
        await runToSuccess(s, "swap");

        await waitUntil(() => expect(amountInput().value).toBe(""), READY_TIMEOUT_MS);
        await settlePendingWork();

        expect(s.probe().form.amountIn).toBe("");
        expect(s.probe().execution.result).toEqual({
          kind: "swap",
          status: "success",
          chainId: ETHEREUM_CHAIN_ID,
          hash: FIRST_HASH,
        });
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-19
     * @given approve 성공 결과 메시지가 보인다
     * @when 슬리피지 팝오버에서 현재와 다른 프리셋을 고른다
     * @then useSwapExecution().result가 슬리피지 변경 전 결과 그대로이고 null이 되지 않는다
     */
    it(
      "[EC-19] 슬리피지를 바꿔도 result가 지워지지 않는다",
      async () => {
        const { s, result } = await renderWithApproveSuccess();
        const slippageBefore = s.probe().slippage.slippageBps;
        const target = slippageBefore === 10 ? 100 : 10;

        await chooseSlippagePreset(target);
        await waitUntil(() => expect(s.probe().slippage.slippageBps).toBe(target));
        await settlePendingWork();

        expect(s.probe().execution.result).not.toBeNull();
        expect(s.probe().execution.result).toEqual(result);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("새 실행", () => {
    /**
     * @spec DoD-15
     * @given 결과 메시지가 보이고 eth_sendTransaction 응답을 붙잡는다. 표본: approve 성공 결과 뒤 swap-ready가 된 주 버튼 클릭(swap 시작), approve 서명 거부(4001)로 끝난 rejected 결과 뒤 approve-required 주 버튼 재클릭(approve 시작)을 하나씩 반복한다
     * @when 표본의 주 버튼을 눌러 실행을 시작한다
     * @then phase가 awaiting-signature가 된다
     * @then 붙잡은 eth_sendTransaction 응답을 기다리는 awaiting-signature 동안 useSwapExecution().result는 null이다
     */
    it(
      "[DoD-15] 결과가 보이는 동안 실행을 시작하는 approve·swap 호출이 있으면 이전 result가 null이 된다",
      async () => {
        const samples = ["approve 성공 뒤 swap 클릭", "rejected 뒤 approve 재클릭"] as const;

        for (const [index, sample] of samples.entries()) {
          nextSample(index);
          const s = await renderReadyApp("approve");
          if (sample === "approve 성공 뒤 swap 클릭") {
            // 영수증 뒤 다시 읽은 allowance가 maxUint256이 되어 swap-ready가 된다.
            await runToSuccess(s, "approve", () => {
              rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
            });
            await waitUntil(() => expect(primaryState()).toBe("swap-ready"), READY_TIMEOUT_MS);
          } else {
            await runToRejectedApprove(s);
            await waitUntil(
              () => expect(primaryState()).toBe("approve-required"),
              READY_TIMEOUT_MS,
            );
          }
          // 전제: 결과 메시지가 보인다.
          expect(s.probe().execution.result, sample).not.toBeNull();
          expect(txStatus().getAttribute("data-status"), sample).not.toBe("none");

          const sendGate = s.wallet.hold();
          clickPrimary();
          await waitUntil(
            () => expect(s.probe().execution.phase).toBe("awaiting-signature"),
            READY_TIMEOUT_MS,
          );
          await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(s.probe().execution.phase, sample).toBe("awaiting-signature");
          expect(s.probe().execution.result, sample).toBeNull();

          sendGate.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-28
     * @given 결과 메시지가 보이고 renderAppHook 프로브로 useSwapExecution()을 읽는다. 호출 직전 지갑 요청 수와 result를 기록한다. 표본(결과 — 주 버튼 상태 — 호출 함수): approve 성공 결과 — swap-ready — `approve`, swap 성공 결과 — 금액이 비어 enter-amount — `approve`와 `swap`, approve 서명 거부(4001) rejected 결과 — approve-required — `swap`을 하나씩 반복한다
     * @when 표본 함수를 인자 없이 직접 호출하고 대기 중인 작업을 진행시킨다(전제 확인: 호출이 돌려준 Promise가 reject 없이 resolve하고 지갑 요청 수가 기록한 수에서 늘지 않으며 phase가 awaiting-signature로 넘어가지 않는다)
     * @then useSwapExecution().result가 호출 전 결과 그대로이고 null이 되지 않는다
     */
    it(
      "[EC-28] 실행을 시작하지 않고 끝나는 approve·swap 호출로는 result가 지워지지 않는다",
      async () => {
        type Sample = {
          label: string;
          state: string;
          calls: readonly TxKind[];
          setup: () => Promise<Scenario>;
        };
        const samples: Sample[] = [
          {
            label: "approve 성공 — swap-ready",
            state: "swap-ready",
            calls: ["approve"],
            setup: async () => {
              const s = await renderReadyApp("approve");
              await runToSuccess(s, "approve", () => {
                rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
              });
              return s;
            },
          },
          {
            label: "swap 성공 — enter-amount",
            state: "enter-amount",
            calls: ["approve", "swap"],
            setup: async () => {
              const s = await renderReadyApp("swap");
              await runToSuccess(s, "swap");
              return s;
            },
          },
          {
            label: "approve rejected — approve-required",
            state: "approve-required",
            calls: ["swap"],
            setup: async () => {
              const s = await renderReadyApp("approve");
              await runToRejectedApprove(s);
              return s;
            },
          },
        ];

        for (const [index, sample] of samples.entries()) {
          nextSample(index);
          const s = await sample.setup();
          await waitUntil(() => expect(primaryState()).toBe(sample.state), READY_TIMEOUT_MS);
          await settlePendingWork();

          for (const call of sample.calls) {
            const label = `${sample.label} — ${call}`;
            const resultBefore = s.probe().execution.result;
            expect(resultBefore, label).not.toBeNull();
            const walletRequestsBefore = s.stub.requests.length;
            const sentBefore = s.wallet.sent.length;
            const phaseMark = s.phases.length;

            let tracked: { outcome: CallOutcome | null } | undefined;
            act(() => {
              tracked = track(s.probe().execution[call]());
            });
            await waitUntil(() => expect(tracked?.outcome).not.toBeNull(), READY_TIMEOUT_MS);
            await settlePendingWork();

            // 전제: 실행을 시작하지 않고 끝났다.
            expect(tracked!.outcome, label).toEqual({ status: "resolved", value: undefined });
            expect(s.stub.requests, label).toHaveLength(walletRequestsBefore);
            expect(s.wallet.sent, label).toHaveLength(sentBefore);
            expect(s.phases.slice(phaseMark), label).not.toContain("awaiting-signature");
            expect(s.probe().execution.phase, label).toBe("idle");

            expect(s.probe().execution.result, label).not.toBeNull();
            expect(s.probe().execution.result, label).toEqual(resultBefore);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("시간 경과", () => {
    /**
     * @spec EC-20
     * @given approve 성공 결과 메시지가 보이고 시간은 가짜 시계로 다룬다
     * @when 가짜 시계로 시간을 오래 진행한다(길이는 F5 EC-18 표본 길이 이상)
     * @then 진행하는 동안과 진행한 뒤 useSwapExecution().result가 진행 전 결과 그대로이고 null이 되지 않는다
     */
    it(
      "[EC-20] 시간이 지나도 result가 지워지지 않는다",
      async () => {
        const s = await renderReadyApp("approve");
        // 결과가 기록되기 전에 가짜 시계를 켜, 결과 기록 뒤 예약되는 시간 기반 동작도 가짜 시계를 따르게 한다.
        fakeAllTimers();

        clickPrimary();
        await waitUntilAdvancingFakeClock(
          () => {
            expect(s.probe().execution.phase).toBe("idle");
            expect(s.probe().execution.result).not.toBeNull();
          },
          POLL_STEP_MS,
          POLL_TIMEOUT_MS,
        );
        const result = s.probe().execution.result;
        // 전제: approve 성공 결과 메시지가 보인다.
        expect(result).toMatchObject({
          kind: "approve",
          status: "success",
          chainId: ETHEREUM_CHAIN_ID,
          hash: FIRST_HASH,
        });
        expect(txStatus().getAttribute("data-status")).toBe("success");

        const startedAt = Date.now();
        const violations: string[] = [];
        await advanceFakeClockInSteps(LONG_WAIT_MS, LONG_WAIT_STEP_MS, (elapsedMs) => {
          const current = s.probe().execution.result;
          if (current === null || JSON.stringify(current) !== JSON.stringify(result)) {
            violations.push(`${elapsedMs}ms: result=${JSON.stringify(current)}`);
          }
        });

        expect(violations).toEqual([]);
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(LONG_WAIT_MS);
        expect(s.probe().execution.result).not.toBeNull();
        expect(s.probe().execution.result).toEqual(result);
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("진행 중 변경 뒤의 결과", () => {
    /**
     * @spec EC-22
     * @given 해시를 받은 뒤 영수증 응답을 붙잡아 진행 중이다. 표본: 진행 phase(approving, swapping) × 변경(보내는 칸 금액 변경, 보내는 토큰 변경)을 하나씩 반복한다
     * @when 진행 중에 표본의 변경을 하고, 그 뒤 붙잡은 영수증 응답을 성공으로 푼다
     * @then useSwapExecution().result는 null이 아니고 kind가 표본 종류(approve·swap), status가 success, hash가 지갑이 돌려준 해시다
     * @then tx-status[data-status]가 success이고 data-kind가 표본 종류다
     */
    it(
      "[EC-22] approving·swapping 중에 입력을 바꾼 뒤 나온 결과가 표시된다",
      async () => {
        const changes = ["보내는 칸 금액", "보내는 토큰"] as const;
        let sampleCount = 0;

        for (const kind of TX_KINDS) {
          for (const change of changes) {
            nextSample(sampleCount);
            sampleCount += 1;
            const label = `${PROGRESS[kind]} — ${change}`;
            const s = await renderReadyApp(kind);

            await runToSuccess(s, kind, async () => {
              if (change === "보내는 칸 금액") {
                await typeAmount("2");
              } else {
                await chooseToken("in", ETHEREUM_WETH);
                expect(sameAddress(tokenAddress("in") ?? undefined, ETHEREUM_WETH), label).toBe(
                  true,
                );
              }
              await settlePendingWork();
              // 전제: 변경 뒤에도 진행 중이다.
              expect(s.probe().execution.phase, label).toBe(PROGRESS[kind]);
            });

            const result = s.probe().execution.result;
            expect(result, label).not.toBeNull();
            expect(result, label).toMatchObject({ kind, status: "success", hash: FIRST_HASH });
            expect(txStatus().getAttribute("data-status"), label).toBe("success");
            expect(txStatus().getAttribute("data-kind"), label).toBe(kind);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-23
     * @given Ethereum에서 해시를 받은 뒤 영수증 응답을 붙잡아 진행 중이다. 표본: approving, swapping을 하나씩 반복한다
     * @when 진행 중에 체인 선택 드롭다운으로 선택 체인을 tx 체인과 다른 체인으로 바꾼 뒤, 붙잡은 영수증 응답을 성공으로 푼다
     * @then 결과가 나온 시점의 선택 체인이 tx 체인과 다른 상태에서 useSwapExecution().result가 null이 아니고 status가 success, chainId가 tx 체인(Ethereum)이다
     * @then tx-status[data-status]가 success이고 data-kind가 표본 종류다
     * @then tx-link의 href가 result.chainId·result.hash로 만든 tx 체인 탐색기 주소 `https://etherscan.io/tx/{지갑이 돌려준 해시}`다
     */
    it(
      "[EC-23] 결과 시점에 선택 체인이 tx 체인과 달라도 결과를 표시하고 tx-link는 tx 체인 탐색기를 가리킨다",
      async () => {
        for (const [index, kind] of TX_KINDS.entries()) {
          nextSample(index);
          const label = PROGRESS[kind];
          const s = await renderReadyApp(kind);

          await runToSuccess(s, kind, async () => {
            await chooseChainFromDropdown(base);
            await settlePendingWork();
            // 전제: 체인을 바꾼 뒤에도 진행 중이다.
            expect(s.probe().execution.phase, label).toBe(PROGRESS[kind]);
          });

          // 전제: 결과가 나온 시점의 선택 체인이 tx 체인(Ethereum)과 다르다.
          expect(selectedChainAttr(), label).toBe(String(BASE_CHAIN_ID));
          const result = s.probe().execution.result;
          expect(result, label).not.toBeNull();
          expect(result, label).toMatchObject({ status: "success", chainId: ETHEREUM_CHAIN_ID });
          expect(txStatus().getAttribute("data-status"), label).toBe("success");
          expect(txStatus().getAttribute("data-kind"), label).toBe(kind);
          expect(screen.getByTestId("tx-link").getAttribute("href"), label).toBe(
            `${ETHERSCAN_TX}${FIRST_HASH}`,
          );
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("지갑 연결 변경", () => {
    /**
     * @spec EC-25
     * @given approve 성공 결과 메시지가 보인다. 표본: 지갑 연결 해제, 계정 변경, 계정 변경 뒤 원래 계정으로 되돌림, 연결 해제 뒤 같은 계정 재연결을 하나씩 반복한다
     * @when 표본의 변경을 한다(되돌림·재연결 표본은 변경 뒤 원래 계정으로 되돌리거나 같은 계정으로 다시 연결한다)
     * @then 연결 해제·계정 변경 뒤 useSwapExecution().result가 null이 된다
     * @then 되돌림·재연결 표본은 원래 계정으로 되돌리거나 같은 계정으로 다시 연결한 뒤에도 useSwapExecution().result가 null이다
     */
    it(
      "[EC-25] 결과가 보이는 동안 지갑 연결이 해제되거나 계정이 바뀌면 result가 null이 된다",
      async () => {
        const samples = [
          "연결 해제",
          "계정 변경",
          "계정 변경 뒤 되돌림",
          "연결 해제 뒤 재연결",
        ] as const;

        for (const [index, sample] of samples.entries()) {
          nextSample(index);
          const { s } = await renderWithApproveSuccess();
          expect(s.probe().execution.result, sample).not.toBeNull();

          const disconnects = sample === "연결 해제" || sample === "연결 해제 뒤 재연결";
          if (disconnects) {
            await act(async () => {
              await disconnect(s.config);
            });
            await waitUntil(() => expect(primaryState()).toBe("disconnected"), READY_TIMEOUT_MS);
          } else {
            act(() => s.stub.changeAccounts([SECOND_ACCOUNT]));
            await waitUntil(
              () => expect(getConnection(s.config).address).toBe(SECOND_ACCOUNT),
              READY_TIMEOUT_MS,
            );
          }
          await waitUntil(() => expect(s.probe().execution.result).toBeNull(), READY_TIMEOUT_MS);
          await settlePendingWork();
          expect(s.probe().execution.result, `${sample} — 변경 뒤`).toBeNull();

          if (sample === "계정 변경 뒤 되돌림") {
            act(() => s.stub.changeAccounts([TEST_ACCOUNT]));
            await waitUntil(
              () => expect(getConnection(s.config).address).toBe(TEST_ACCOUNT),
              READY_TIMEOUT_MS,
            );
          } else if (sample === "연결 해제 뒤 재연결") {
            await act(async () => {
              await connect(s.config, { connector: s.config.connectors[0]! });
            });
            await waitUntil(() => {
              const connection = getConnection(s.config);
              expect(connection.status).toBe("connected");
              expect(connection.address).toBe(TEST_ACCOUNT);
            }, READY_TIMEOUT_MS);
          }
          if (sample === "계정 변경 뒤 되돌림" || sample === "연결 해제 뒤 재연결") {
            await waitUntil(
              () => expect(primaryState()).not.toBe("disconnected"),
              READY_TIMEOUT_MS,
            );
            await settlePendingWork();
            expect(s.probe().execution.result, `${sample} — 되돌린 뒤`).toBeNull();
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
