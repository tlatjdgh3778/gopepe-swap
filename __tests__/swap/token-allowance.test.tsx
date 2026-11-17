import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";
import { getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";
import { useSwapQuote } from "@/providers/swap-quote-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

import {
  type AllowanceQuery,
  type BalanceRpcStub,
  type HoldGate,
  type QuoteInputFilter,
  type RequestMatcher,
  allowanceAlways,
  allowanceWhen,
  installBalanceRpcStub,
  match,
  matchAllowance,
  matchQuote,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import { createStubEip1193 } from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeClockInSteps,
  chooseChainFromDropdown,
  clearCookies,
  createDeferred,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고, 앱 Provider 안의 프로브로 useTokenAllowance()·useSwapQuote()를 읽는다.
// 지갑은 mock 커넥터 또는 스텁 EIP-1193(계정 변경 표본)을 쓴다. RPC는 전역 fetch URL 라우팅 스텁이 응답하고, 견적은 aggregate3 스텁, allowance는 allowance 응답·실패·붙잡기 스텁이 응답한다.
// 시간과 입력은 가짜 타이머와 DOM 이벤트(window `focus`·`offline`·`online` 포함)로 다룬다. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.

// 이 파일에서 "allowance 요청"은 ERC-20 `allowance(owner, spender)` `eth_call` JSON-RPC 항목이다(배치 배열은 항목마다 센다). 요청의 키는 RPC 프록시 경로의 체인, 호출 대상 토큰 주소, 디코드한 owner·spender다.
// 스텁의 기본 allowance 응답은 0이다(사용자 확정). 표본마다 다른 값이 필요하면 스텁 리터럴로 정한다.
// 기대값(allowance, 라우터·토큰 주소)은 제품 config나 제품 함수로 만들지 않고 스텁 리터럴과 스펙 §4.1 리터럴로 적는다.
// 라우터 주소 리터럴(스펙 §4.1): Ethereum `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, Base `0x2626664c2603336E57B271c5C0b26F421741e481`.
// 기본 ERC-20 페어는 Ethereum 보내는 USDC(decimals 6), 받는 DAI, 금액 `1`(amountInRaw `1000000`)이고 보내는 토큰 잔액은 금액보다 크게 읽힌다.
// 트랜잭션 종료 뒤 다시 읽기는 T-9(DoD-14·DoD-20), 금액 변경 시 다시 읽지 않음은 approve-swap-button의 DoD-10·DoD-11·EC-15 case가 맡는다.
// 15초 주기 판정은 F3 quote-refresh와 같이 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 둔다.

const CASE_TIMEOUT_MS = 60_000;
const MULTI_SAMPLE_TIMEOUT_MS = 120_000;
const LONG_CASE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 10_000;

// 스펙 값: 입력 반영 대기 300ms(F3 DoD-26)
const DEBOUNCE_MS = 300;
// 견적 15초 주기를 40번 넘기는 길이(10분)와, 주기 경계를 하나씩 넘기는 가짜 시계 단계
const TEN_MINUTES_MS = 600_000;
const PERIOD_STEP_MS = 5_000;

// 공식 주소(리터럴, 제품 config를 쓰지 않는다)
const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_DAI: Address = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
// 스펙 §4.1 SwapRouter02 주소(리터럴)
const ETHEREUM_SWAP_ROUTER02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const BASE_SWAP_ROUTER02: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
// 스텁 EIP-1193 계정 변경 표본의 두 번째 계정
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// 보내는 USDC(decimals 6) 금액 1 → amountInRaw 1_000_000
const AMOUNT = "1";
const AMOUNT_IN_RAW = 1_000_000n;

// 기본 키(Ethereum, 연결 계정, Ethereum SwapRouter02, Ethereum USDC)
const BASE_KEY: AllowanceQuery = {
  chainId: mainnet.id,
  owner: TEST_ACCOUNT,
  spender: ETHEREUM_SWAP_ROUTER02,
  token: ETHEREUM_USDC,
};

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

// 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 둔다(F3 quote-refresh와 같다).
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

function allowanceCount(matcher: RequestMatcher = matchAllowance.any): number {
  return rpc.requests(matcher).length;
}

function windowEvent(type: "focus" | "offline" | "online") {
  act(() => {
    window.dispatchEvent(new Event(type));
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

function primaryState(): string | null {
  return screen.getByTestId("primary-button").getAttribute("data-state");
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

function slippageButton(): HTMLElement {
  return screen.getByTestId("slippage-button");
}

function slippageOption(bps: number): HTMLElement {
  const popover = screen.getByTestId("slippage-popover");
  const option = within(popover)
    .getAllByTestId("slippage-option")
    .find((element) => element.getAttribute("data-slippage-bps") === String(bps));
  if (!option) throw new Error(`slippage-option ${bps}가 없다`);
  return option;
}

async function chooseSlippage(bps: number) {
  if (slippageButton().getAttribute("aria-expanded") !== "true") {
    fireEvent.click(slippageButton());
  }
  await waitUntil(() => expect(screen.queryByTestId("slippage-popover")).not.toBeNull());
  fireEvent.click(slippageOption(bps));
  await waitUntil(() => expect(slippageOption(bps).getAttribute("aria-checked")).toBe("true"));
}

function quoteSlippageBps(): string | null {
  const details = screen.getByTestId("quote-details");
  return within(details).getByTestId("quote-slippage").getAttribute("data-slippage-bps");
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { quote: useSwapQuote(), allowance: useTokenAllowance() };
}

type Probe = ReturnType<typeof useProbe>;

type App = {
  probe: () => Probe;
  stub?: ReturnType<typeof createStubEip1193>;
};

type Wallet = "mock" | "stub";

function appConfig(connectors: CreateConnectorFn[] = []) {
  return createWagmiConfig({
    connectors,
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// Ethereum에 연결된 앱. `mock`은 wagmi mock 커넥터, `stub`은 스텁 EIP-1193(계정 변경 표본)이다.
// 기본 잔액 규칙은 모든 토큰 잔액이 표본 금액보다 훨씬 크다.
async function renderConnectedApp(wallet: Wallet = "mock"): Promise<App> {
  const stub =
    wallet === "stub"
      ? createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT], authorized: true })
      : undefined;
  const config = appConfig([
    stub ? stubConnector(stub) : mockConnector({ defaultConnected: true, reconnect: true }),
  ]);
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(mainnet.id);
  }, READY_TIMEOUT_MS);
  return { probe: () => view.result.current, stub };
}

// 저장된 연결이 없고 복원이 끝나 미연결인 앱
async function renderDisconnectedApp(): Promise<App> {
  const view = renderAppHook(useProbe, { config: appConfig(), initialChainId: mainnet.id });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"), READY_TIMEOUT_MS);
  return { probe: () => view.result.current };
}

// 저장된 연결이 있고 지갑이 계정 응답을 끝내지 않아 복원 중인 앱.
// 복원 제한 시간(5초)이 실제 시간으로 지나지 않도록 가짜 타이머를 켜고 시계는 필요한 만큼만 움직인다(F2·F3 관례).
async function renderRestoringApp(): Promise<App> {
  vi.useFakeTimers();
  const stub = createStubEip1193({
    chainId: mainnet.id,
    accounts: [TEST_ACCOUNT],
    authorized: true,
  });
  const accounts = createDeferred<readonly Address[]>();
  stub.setHandler("eth_accounts", () => accounts.promise);
  const view = renderAppHook(useProbe, {
    config: appConfig([stubConnector(stub)]),
    initialChainId: mainnet.id,
  });
  await settlePendingWork();
  expect(primaryState()).toBe("restoring");
  return { probe: () => view.result.current, stub };
}

// 표본 입력의 견적 요청이 응답을 받고 useSwapQuote()가 success가 되기를 기다린다.
async function waitForQuoteOf(app: App, filter: QuoteInputFilter) {
  await waitUntil(() => {
    expect(rpc.requests(matchQuote.input(filter)).some((r) => r.status === "ok")).toBe(true);
    expect(app.probe().quote.status).toBe("success");
  }, READY_TIMEOUT_MS);
}

// 보내는 칸·받는 칸 토큰과 금액을 입력하고 그 입력의 견적이 success가 되기를 기다린다.
// 보내는 칸은 처음에 ETH이므로 보내는 ETH 표본은 보내는 칸을 고르지 않는다.
async function enterPair(app: App, tokenIn: Address, tokenOut: Address, amount = AMOUNT) {
  if (!sameAddress(tokenIn, NATIVE_ETH)) await chooseToken("in", tokenIn);
  await chooseToken("out", tokenOut);
  await typeAmount(amount);
  await waitForQuoteOf(app, { chainId: mainnet.id });
}

// 기본 키의 allowance가 표본 값으로 읽히기를 기다린다.
async function waitForAllowance(app: App, value: bigint, label: string) {
  await waitUntil(
    () => expect(app.probe().allowance, label).toEqual({ status: "success", allowance: value }),
    READY_TIMEOUT_MS,
  );
}

describe("allowance — 사용자가 지금 계정·체인·보내는 토큰의 SwapRouter02 승인 상태를 필요할 때만 새로 읽어 본다", () => {
  describe("allowance를 읽지 않는 경우", () => {
    /**
     * @spec DoD-12
     * @given 앱이 Ethereum으로 렌더링됐고 스텁은 견적에 기본 성공 응답을 준다. 표본: mock 커넥터로 연결돼 있고 보내는 ETH·받는 USDC·금액 `1`, 저장된 연결이 없고 복원이 끝나 미연결이며 보내는 USDC·받는 DAI·금액 `1`, 저장된 연결이 있고 복원이 끝나지 않아 복원 중이며 보내는 USDC·받는 DAI·금액 `1`을 하나씩 반복한다
     * @when 표본 상태를 만들고 입력 반영 대기(300ms)가 지나 견적 상태가 정해지기를 기다린 뒤 window `focus` 이벤트를 발생시킨다
     * @then useTokenAllowance()의 status가 `idle`이고 allowance가 `null`이다
     * @then 렌더링부터 판정 시점까지 allowance 요청이 0건이다
     */
    it(
      "[DoD-12] 보내는 토큰이 ETH이거나 미연결·복원 중이면 idle이고 allowance 요청을 보내지 않는다",
      async () => {
        const samples = ["연결·보내는 ETH", "미연결·보내는 USDC", "복원 중·보내는 USDC"] as const;
        for (const [index, label] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setQuoteRule(parityQuoteRule);
          let app: App;
          if (label === "연결·보내는 ETH") {
            app = await renderConnectedApp();
            await enterPair(app, NATIVE_ETH, ETHEREUM_USDC);
          } else if (label === "미연결·보내는 USDC") {
            app = await renderDisconnectedApp();
            await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
            expect(primaryState(), label).toBe("disconnected");
          } else {
            app = await renderRestoringApp();
            await chooseToken("in", ETHEREUM_USDC);
            await chooseToken("out", ETHEREUM_DAI);
            await typeAmount(AMOUNT);
            // 가짜 setTimeout: 반영 대기를 지나게 하고, 응답 반영(0ms 알림)이 실행되도록 시계를 조금씩 진행한다.
            await act(async () => {
              await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
            });
            await waitUntilAdvancingFakeClock(() =>
              expect(app.probe().quote.status, label).toBe("success"),
            );
            expect(primaryState(), label).toBe("restoring");
          }

          windowEvent("focus");
          await settlePendingWork();

          expect(app.probe().allowance, label).toEqual({ status: "idle", allowance: null });
          expect(rpc.requests(matchAllowance.any), label).toHaveLength(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("다시 읽는 계기가 아닌 변화가 일어난 경우", () => {
    /**
     * @spec EC-15
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 USDC, 받는 DAI, 금액 `1`의 견적이 `success`이고 allowance가 스텁 값 `1500000`으로 읽혀 useTokenAllowance()의 status가 `success`다. allowance 요청 수를 기록해 둔다. 표본 변화: 가짜 시계를 15초 주기 경계를 하나씩 넘기며 10분(600초, 견적 주기 40회) 진행해 같은 입력의 견적 다시 읽기가 여러 번 일어나게 함(allowance에 분 단위 주기 갱신이 있어도 드러나는 길이), slippage-button으로 팝오버를 열고 슬리피지 `100`을 고름, 받는 칸 모달에서 WETH를 고름, window `offline` 이벤트 뒤 `online` 이벤트를 발생시킴(네트워크 재연결)을 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 위 전제를 다시 만든다
     * @when 표본 변화를 일으키고, 15초 주기 표본은 10분을 다 진행하고 마지막 견적 다시 읽기가 `success`로 끝나기를, 받는 토큰 변경 표본은 견적이 다시 `success`가 되기를, 슬리피지 표본은 quote-slippage의 data-slippage-bps가 `100`이 되기를, 네트워크 재연결 표본은 `online` 이벤트 뒤 대기 중인 작업이 끝나기를 기다린다
     * @then allowance 요청 수가 기록한 값에서 늘지 않는다
     * @then useTokenAllowance()의 status가 `success`이고 allowance가 `1500000n`이다
     */
    it(
      "[EC-15] 견적 15초 주기·슬리피지·받는 토큰 변경·네트워크 재연결에서는 allowance를 다시 읽지 않는다",
      async () => {
        const samples = [
          "견적 15초 주기 10분",
          "슬리피지 100",
          "받는 토큰 WETH",
          "네트워크 재연결",
        ] as const;
        for (const [index, label] of samples.entries()) {
          if (index > 0) resetSample();
          fakePeriodicTimers();
          rpc.setQuoteRule(parityQuoteRule);
          rpc.setAllowances(allowanceAlways(1_500_000n));
          const app = await renderConnectedApp();
          await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
          await waitForAllowance(app, 1_500_000n, label);
          await settlePendingWork();
          const allowanceBefore = allowanceCount();
          // 전제: allowance를 읽었다(분류 양성 대조).
          expect(allowanceBefore, label).toBeGreaterThanOrEqual(1);

          if (label === "견적 15초 주기 10분") {
            const sameInput = matchQuote.input({
              chainId: mainnet.id,
              tokenIn: ETHEREUM_USDC,
              tokenOut: ETHEREUM_DAI,
              amountIn: AMOUNT_IN_RAW,
            });
            const quotesBefore = rpc.requests(sameInput).length;
            await advanceFakeClockInSteps(TEN_MINUTES_MS, PERIOD_STEP_MS, (elapsed) => {
              expect(allowanceCount(), `${label} ${elapsed}ms`).toBe(allowanceBefore);
            });
            await waitUntil(() => {
              expect(rpc.requests(sameInput).at(-1)?.status, label).toBe("ok");
              expect(app.probe().quote.status, label).toBe("success");
            }, READY_TIMEOUT_MS);
            // 전제: 같은 입력의 견적 다시 읽기가 여러 번 일어났다.
            expect(rpc.requests(sameInput).length - quotesBefore, label).toBeGreaterThanOrEqual(2);
          } else if (label === "슬리피지 100") {
            await chooseSlippage(100);
            await waitUntil(() => expect(quoteSlippageBps(), label).toBe("100"), READY_TIMEOUT_MS);
          } else if (label === "받는 토큰 WETH") {
            await chooseToken("out", ETHEREUM_WETH);
            await waitForQuoteOf(app, {
              chainId: mainnet.id,
              tokenIn: ETHEREUM_USDC,
              tokenOut: ETHEREUM_WETH,
            });
          } else {
            windowEvent("offline");
            await settlePendingWork();
            windowEvent("online");
          }
          await settlePendingWork();

          expect(allowanceCount(), label).toBe(allowanceBefore);
          expect(app.probe().allowance, label).toEqual({
            status: "success",
            allowance: 1_500_000n,
          });
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("allowance 키가 바뀌는 경우", () => {
    /**
     * @spec EC-15
     * @given Ethereum에 연결돼 있고(계정 변경 표본은 스텁 EIP-1193, 나머지 표본은 mock 커넥터) 보내는 USDC, 받는 DAI, 금액 `1`의 allowance가 스텁 값 `1500000`으로 읽혀 useTokenAllowance()의 status가 `success`다. 스텁은 새 키의 allowance 요청에 `1500000`과 다른 값 `7000000`으로 응답한다. allowance 요청 수를 기록해 둔다. 표본 변경: 연결 계정을 두 번째 계정으로 바꿈(accountsChanged), 드롭다운으로 선택 체인을 Base로 바꾸고(입력이 기본값으로 돌아간다) 보내는 Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`·받는 Base DAI·금액 `1`을 입력함, 보내는 칸 모달에서 Ethereum WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`를 고름을 하나씩 반복한다
     * @when 표본 변경을 일으키고 새 키의 allowance 응답을 받기를 기다린다
     * @then 기록 뒤 새 키(표본의 체인, 토큰 주소, owner = 표본의 연결 계정, spender = 표본 체인의 SwapRouter02 리터럴)의 allowance 요청이 생긴다
     * @then useTokenAllowance()의 status가 `success`이고 allowance가 `7000000n`이다
     */
    it(
      "[EC-15] 연결 계정·선택 체인·보내는 토큰이 바뀌면 새 키의 allowance를 읽는다",
      async () => {
        const samples = ["계정 변경", "체인 변경", "보내는 토큰 변경"] as const;
        for (const [index, label] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setQuoteRule(parityQuoteRule);
          // 기본 키는 1_500_000, 그 밖의 키(새 키)는 7_000_000
          rpc.setAllowances(allowanceWhen(BASE_KEY, 1_500_000n, allowanceAlways(7_000_000n)));
          const app = await renderConnectedApp(label === "계정 변경" ? "stub" : "mock");
          await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
          await waitForAllowance(app, 1_500_000n, label);
          await settlePendingWork();
          const from = rpc.requests().length;

          let newKey: AllowanceQuery;
          if (label === "계정 변경") {
            app.stub!.changeAccounts([SECOND_ACCOUNT]);
            newKey = { ...BASE_KEY, owner: SECOND_ACCOUNT };
          } else if (label === "체인 변경") {
            await chooseChainFromDropdown(base);
            await chooseToken("in", BASE_USDC);
            await chooseToken("out", BASE_DAI);
            await typeAmount(AMOUNT);
            newKey = {
              chainId: base.id,
              owner: TEST_ACCOUNT,
              spender: BASE_SWAP_ROUTER02,
              token: BASE_USDC,
            };
          } else {
            await chooseToken("in", ETHEREUM_WETH);
            newKey = { ...BASE_KEY, token: ETHEREUM_WETH };
          }
          await waitForAllowance(app, 7_000_000n, label);

          expect(
            rpc.requests(match.since(from, matchAllowance.query(newKey))).length,
            label,
          ).toBeGreaterThanOrEqual(1);
          expect(app.probe().allowance, label).toEqual({
            status: "success",
            allowance: 7_000_000n,
          });
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("같은 키를 다시 읽는 경우", () => {
    /**
     * @spec EC-15
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC, 받는 DAI, 금액 `1`의 견적이 `success`이며 allowance가 스텁 값 `0`으로 읽혀 primary-button의 data-state가 `approve-required`다. 그 뒤 스텁의 같은 키 allowance 응답을 `1500000`으로 바꿨고 allowance 요청 수를 기록해 둔다
     * @when window `focus` 이벤트를 발생시키고 allowance 응답을 받기를 기다린다
     * @then 기록 뒤 같은 키(Ethereum, USDC, 연결 계정, Ethereum SwapRouter02 리터럴)의 allowance 요청이 는다
     * @then useTokenAllowance()의 status가 `success`이고 allowance가 `1500000n`이다
     * @then primary-button의 data-state가 `swap-ready`다
     */
    it(
      "[EC-15] 창 포커스가 돌아오면 같은 키의 allowance를 다시 읽는다",
      async () => {
        rpc.setQuoteRule(parityQuoteRule);
        const app = await renderConnectedApp();
        await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
        await waitUntil(() => expect(primaryState()).toBe("approve-required"), READY_TIMEOUT_MS);
        await settlePendingWork();
        // 전제: 기본 스텁 값 0으로 읽혔다.
        expect(app.probe().allowance).toEqual({ status: "success", allowance: 0n });

        rpc.setAllowances(allowanceAlways(1_500_000n));
        const from = rpc.requests().length;
        windowEvent("focus");
        await waitForAllowance(app, 1_500_000n, "포커스");
        await waitUntil(() => expect(primaryState()).toBe("swap-ready"), READY_TIMEOUT_MS);

        expect(
          rpc.requests(match.since(from, matchAllowance.query(BASE_KEY))).length,
        ).toBeGreaterThanOrEqual(1);
        expect(app.probe().allowance).toEqual({ status: "success", allowance: 1_500_000n });
        expect(primaryState()).toBe("swap-ready");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("성공 값이 있는 키를 다시 읽는 중이거나 다시 읽기가 실패한 경우", () => {
    /**
     * @spec EC-17
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC, 받는 DAI, 금액 `1`의 견적이 `success`이며 allowance가 스텁 값 `1500000`으로 읽혀 primary-button의 data-state가 `swap-ready`다. 표본: 스텁이 같은 키의 다음 allowance 응답을 붙잡음, 스텁이 같은 키의 다음 allowance 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답함을 하나씩 반복한다
     * @when window `focus` 이벤트를 발생시키고, 붙잡기 표본은 allowance 요청이 붙잡힌 동안, 실패 표본은 실패 응답을 받은 뒤 확인한다
     * @then 같은 키의 allowance 요청이 포커스 전보다 늘어 있다(다시 읽기가 일어났다)
     * @then useTokenAllowance()의 status가 `success`이고 allowance가 `1500000n`이다
     * @then primary-button의 data-state가 `swap-ready`다(`checking-allowance`나 `allowance-error`가 되지 않는다)
     */
    it(
      "[EC-17] 성공 값이 있는 키를 다시 읽는 중이거나 다시 읽기가 실패해도 success와 이전 값을 유지한다",
      async () => {
        const samples = ["다시 읽기 붙잡기", "다시 읽기 실패"] as const;
        const sameKey = matchAllowance.query(BASE_KEY);
        for (const [index, label] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setQuoteRule(parityQuoteRule);
          rpc.setAllowances(allowanceAlways(1_500_000n));
          const app = await renderConnectedApp();
          await enterPair(app, ETHEREUM_USDC, ETHEREUM_DAI);
          await waitUntil(() => expect(primaryState(), label).toBe("swap-ready"), READY_TIMEOUT_MS);
          await settlePendingWork();
          const from = rpc.requests().length;

          let gate: HoldGate | undefined;
          if (label === "다시 읽기 붙잡기") {
            gate = rpc.holdAllowance(sameKey);
            windowEvent("focus");
            await waitUntil(
              () => expect(gate!.heldCount, label).toBeGreaterThanOrEqual(1),
              READY_TIMEOUT_MS,
            );
          } else {
            rpc.failAllowanceWhen(sameKey);
            windowEvent("focus");
            await waitUntil(
              () =>
                expect(
                  rpc
                    .requests(match.since(from, sameKey))
                    .some((request) => request.status === "failed"),
                  label,
                ).toBe(true),
              READY_TIMEOUT_MS,
            );
          }
          await settlePendingWork();

          expect(rpc.requests(match.since(from, sameKey)).length, label).toBeGreaterThanOrEqual(1);
          expect(app.probe().allowance, label).toEqual({
            status: "success",
            allowance: 1_500_000n,
          });
          expect(primaryState(), label).toBe("swap-ready");

          gate?.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });
});
