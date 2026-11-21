import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { type Address, hexToBigInt } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useSwapExecution } from "@/providers/swap-execution-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

import {
  type AllowanceFn,
  type BalanceRpcStub,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  type QuoteQuery,
  type QuoteRule,
  STUB_MAX_UINT256,
  STUB_Q96,
  type StubFeeTier,
  allowanceAlways,
  bestStubQuote,
  installBalanceRpcStub,
  matchAllowance,
  matchQuote,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type ChainSwitchControl,
  SEND_TRANSACTION_METHODS,
  type SentTransaction,
  type StubEip1193,
  type WalletTransactionControl,
  createStubEip1193,
  installChainSwitch,
  installWalletTransactions,
} from "../support/stub-eip1193";
import {
  type DecodedExactInputSingle,
  type DecodedRouterCall,
  TEST_ACCOUNT,
  advanceFakeTimeTo,
  clearCookies,
  createNoopWagmiStorage,
  decodeRouterMulticall,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 `primary-button`의 `data-state`·비활성, 지갑 전송 요청(`to`·calldata·`value`)으로 판정한다.
// useSwapExecution()의 phase·pendingTx·result, useSwapQuote(), useAmountOutMinimum()은 앱 Provider 안의 프로브로 읽는다.
// mock 경계(사용자 확정(2026-11-20) — F5 T-9·T-10 경계): 실제 wagmi·Provider·화면, mock 커넥터, 스텁 EIP-1193 지갑(`eth_sendTransaction` 기록·해시 응답·붙잡기, 체인 전환 요청 붙잡기),
// 전역 fetch URL 라우팅 RPC 스텁(견적 aggregate3, 잔액, allowance 응답·실패·붙잡기, 영수증 성공·붙잡기), `Date` 가짜 시계와 가짜 타이머, DOM 이벤트. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config·스텁·QueryClient를 새로 만들고 clearCookies를 부른다. 같은 case 안의 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링한다.
// "전송 요청"은 스텁 EIP-1193 요청 기록 중 `eth_sendTransaction` 항목이고, "지갑 요청"은 스텁 EIP-1193 요청 기록의 모든 항목이다.
// calldata는 테스트 쪽 ABI 리터럴로 디코딩한다: `multicall(uint256 deadline, bytes[] data)`,
// `exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))`,
// `unwrapWETH9(uint256 amountMinimum, address recipient)`.
// 기대 주소는 제품 config를 쓰지 않고 리터럴로 적는다: Ethereum swapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`,
// Ethereum WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, ADDRESS_THIS `0x0000000000000000000000000000000000000002`,
// USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F`.
// 기대 최소 수령량은 제품 함수를 쓰지 않고 테스트 쪽 bigint 식 `Q * (10000n - bps) / 10000n`으로 만든다.
// 견적 스텁은 따로 적지 않으면 가격 영향이 `normal` 등급이고 최소 수령량이 0보다 큰 수령량을 응답한다.

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 10_000;

const BPS_DENOMINATOR = 10_000n;
// 스펙 DoD-7·9가 따르는 F5 DoD-17의 deadline 여유(초)
const DEADLINE_SECONDS = 1800n;
// 스펙 값: 견적 주기 15초
const REFETCH_MS = 15_000;

// 스펙 §4.1·config 리터럴(제품 config를 쓰지 않는다)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

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

// 주기 타이머(setInterval)와 시계만 가짜로 둔다. 입력 반영 대기(setTimeout)는 실제 시간으로 흐른다.
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

// ─── 견적 규칙(테스트 쪽) ──────────────────────────────────────────

type BestTier = { fee: StubFeeTier; amountOut: bigint };

// `best`가 고른 티어만 그 수령량, 나머지 티어는 입력 금액과 같은 수령량으로 응답한다.
// slot0 가격이 1이라 두 방향 모두 수령량이 입력 금액 이상이면 가격 영향이 0 이하(`normal`)다.
function bestTierRule(best: (query: QuoteQuery) => BestTier): QuoteRule {
  return {
    quote: (query) => {
      const chosen = best(query);
      return {
        status: "ok",
        amountOut: query.fee === chosen.fee ? chosen.amountOut : query.amountIn,
        sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
      };
    },
    slot0: () => ({ status: "ok", sqrtPriceX96: STUB_Q96 }),
  };
}

function expectedMinimum(amountOut: bigint, bps: bigint): bigint {
  return (amountOut * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR;
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

function slippagePopover(): HTMLElement | null {
  return screen.queryByTestId("slippage-popover");
}

// 슬리피지 팝오버를 열고 프리셋을 고른다(실제 slippage-option 조작).
async function chooseSlippage(bps: number) {
  const button = screen.getByTestId("slippage-button");
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  await waitUntil(() => expect(slippagePopover()).not.toBeNull());
  const option = () =>
    within(slippagePopover()!)
      .getAllByTestId("slippage-option")
      .find((element) => element.getAttribute("data-slippage-bps") === String(bps));
  const target = option();
  if (!target) throw new Error(`slippage-option ${bps}가 없다`);
  fireEvent.click(target);
  await waitUntil(() => expect(option()?.getAttribute("aria-checked")).toBe("true"));
}

function clickPrimary() {
  fireEvent.click(primaryButton());
}

function expectSameAddress(actual: string | undefined, expected: Address, label?: string) {
  expect(actual?.toLowerCase(), label).toBe(expected.toLowerCase());
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return {
    execution: useSwapExecution(),
    allowance: useTokenAllowance(),
    quote: useSwapQuote(),
    minimum: useAmountOutMinimum(),
    form: useSwapForm(),
  };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  chainSwitch: ChainSwitchControl;
  probe: () => Probe;
};

type AppSetup = {
  quoteRule: QuoteRule;
  allowance: AllowanceFn;
  walletChainId?: SupportedChainId;
};

// 스텁 EIP-1193 지갑으로 연결되고 선택 체인이 Ethereum인 앱을 렌더링한다. `eth_sendTransaction`은 해시로 응답한다.
async function renderConnectedApp({
  quoteRule,
  allowance,
  walletChainId = mainnet.id,
}: AppSetup): Promise<Scenario> {
  rpc.setQuoteRule(quoteRule);
  rpc.setAllowances(allowance);
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
  return { stub, wallet, chainSwitch, probe: () => view.result.current };
}

// 페어와 금액을 입력하고 주 버튼이 `state`가 될 때까지 기다린다.
async function enterPair(
  tokenIn: Address,
  tokenOut: Address,
  amount: string,
  state: string,
): Promise<void> {
  await chooseToken("in", tokenIn);
  await chooseToken("out", tokenOut);
  if (amount !== "") await typeAmount(amount);
  await waitUntil(() => expect(primaryState()).toBe(state), READY_TIMEOUT_MS);
  await settlePendingWork();
  expect(primaryState()).toBe(state);
}

function sendCount(stub: StubEip1193): number {
  return requestsSince(stub, 0, SEND_TRANSACTION_METHODS).length;
}

// 전송 요청 calldata를 테스트 쪽 ABI 리터럴로 디코드한다(바깥이 multicall이 아니면 throw).
function decodeSentMulticall(sent: SentTransaction) {
  if (!sent.data) throw new Error("전송 요청의 calldata가 없다");
  return decodeRouterMulticall(sent.data);
}

function exactInputSingleOf(
  call: DecodedRouterCall | undefined,
  label: string,
): DecodedExactInputSingle {
  expect(call?.kind, `${label} exactInputSingle`).toBe("exactInputSingle");
  if (call?.kind !== "exactInputSingle") throw new Error(`${label}: exactInputSingle이 아니다`);
  return call.params;
}

function unwrapWeth9Of(call: DecodedRouterCall | undefined, label: string) {
  expect(call?.kind, `${label} unwrapWETH9`).toBe("unwrapWETH9");
  if (call?.kind !== "unwrapWETH9") throw new Error(`${label}: unwrapWETH9가 아니다`);
  return call;
}

// 지갑 요청의 `value`(16진)를 bigint로 읽는다. 필드가 없으면 undefined
function sentValue(sent: SentTransaction): bigint | undefined {
  return sent.value === undefined ? undefined : hexToBigInt(sent.value);
}

// Ethereum 보내는 USDC의 SwapRouter02 allowance 읽기 요청(연결 계정)
function usdcAllowanceReads() {
  return rpc.requests(
    matchAllowance.query({
      chainId: mainnet.id,
      owner: TEST_ACCOUNT,
      spender: ETHEREUM_ROUTER,
      token: ETHEREUM_USDC,
    }),
  );
}

// ─── 서명 대기 중 변화(클릭 시점 값) 공통 진행 ─────────────────────────

// 클릭 시점 견적: 티어 500(F1)의 수령량 Q1이 최선이다.
const CLICK_FEE: StubFeeTier = 500;
const CLICK_RULE = bestTierRule((query) => ({
  fee: CLICK_FEE,
  amountOut: query.amountIn * 2n + 11n,
}));
// 수령량·티어 변화: 티어 3000(F2)의 수령량 Q2가 최선이다.
const CHANGED_FEE: StubFeeTier = 3000;
const CHANGED_RULE = bestTierRule((query) => ({
  fee: CHANGED_FEE,
  amountOut: query.amountIn * 3n + 5n,
}));

type ClickTimeChange = "금액 변화" | "수령량·티어 변화";
const CLICK_TIME_CHANGES: readonly ClickTimeChange[] = ["금액 변화", "수령량·티어 변화"];

type ClickTimePair = {
  tokenIn: Address;
  tokenOut: Address;
  amount: string;
  amountInRaw: bigint;
  // 보내는 칸을 `2`로 바꾼 뒤의 amountInRaw
  changedAmountInRaw: bigint;
  // 견적 요청의 토큰(ETH를 WETH로 치환한 주소 리터럴)
  quoteTokenIn: Address;
  quoteTokenOut: Address;
};

type ClickTimeRun = {
  s: Scenario;
  sent: SentTransaction;
  clickFee: number;
  clickMinimum: bigint;
  T0: number;
  T1: number;
};

// 지갑 체인 Base·선택 체인 Ethereum에서 swap-ready를 누르고, 체인 전환 요청이 붙잡힌 동안 표본 변화를 일으킨 뒤
// 가짜 시계를 T1에 맞추고 체인 전환을 풀어 전송 요청과 영수증 후처리를 기다린다.
async function runClickTimeSample(
  change: ClickTimeChange,
  pair: ClickTimePair,
): Promise<ClickTimeRun> {
  fakePeriodicTimers();
  const s = await renderConnectedApp({
    quoteRule: CLICK_RULE,
    allowance: allowanceAlways(STUB_MAX_UINT256),
    walletChainId: base.id,
  });
  await enterPair(pair.tokenIn, pair.tokenOut, pair.amount, "swap-ready");

  const baseInput = {
    chainId: mainnet.id,
    tokenIn: pair.quoteTokenIn,
    tokenOut: pair.quoteTokenOut,
    amountIn: pair.amountInRaw,
  } as const;
  const Q1 = bestStubQuote(CLICK_RULE, baseInput)!.amountOut;
  const atClick = s.probe();
  if (atClick.quote.status !== "success") throw new Error(`${change}: 견적이 success가 아니다`);
  const clickFee = atClick.quote.quote.fee;
  const clickMinimum = atClick.minimum;
  // 전제: 클릭 시점 금액·견적은 F1의 Q1이고 최소 수령량은 Q1 기준(슬리피지 50)이다.
  expect(atClick.form.amountInRaw, change).toBe(pair.amountInRaw);
  expect(clickFee, change).toBe(CLICK_FEE);
  expect(atClick.quote.quote.amountOut, change).toBe(Q1);
  expect(clickMinimum, change).toBe(expectedMinimum(Q1, 50n));
  if (clickMinimum === null) throw new Error(`${change}: 클릭 시점 최소 수령량이 없다`);

  // 같은 입력의 15초 주기 시작(첫 견적 요청 시각)
  const periodStart = rpc.requests(matchQuote.input(baseInput))[0]!.at;
  // 클릭 직전에 가짜 시계를 정수 초 경계 T0에 맞춘다(주기 타이머가 실행되지 않는 1초 미만 진행).
  const T0 = Math.floor(Date.now() / 1000) * 1000 + 1000;
  await advanceFakeTimeTo(T0);
  const switchGate = s.chainSwitch.hold();

  clickPrimary();
  await waitUntil(() => expect(switchGate.heldCount).toBe(1), READY_TIMEOUT_MS);
  expect(s.wallet.sent, change).toHaveLength(0);

  if (change === "금액 변화") {
    await typeAmount("2");
    await waitUntil(() => {
      const { quote, form } = s.probe();
      expect(form.amountInRaw).toBe(pair.changedAmountInRaw);
      expect(quote.status).toBe("success");
      expect(quote.quote?.amountOut).toBe(
        bestStubQuote(CLICK_RULE, { ...baseInput, amountIn: pair.changedAmountInRaw })!.amountOut,
      );
    }, READY_TIMEOUT_MS);
  } else {
    const Q2 = bestStubQuote(CHANGED_RULE, baseInput)!.amountOut;
    expect(Q2, change).not.toBe(Q1);
    rpc.setQuoteRule(CHANGED_RULE);
    await advanceFakeTimeTo(periodStart + REFETCH_MS);
    await waitUntil(() => {
      const { quote } = s.probe();
      expect(quote.status).toBe("success");
      expect(quote.quote?.amountOut).toBe(Q2);
    }, READY_TIMEOUT_MS);
    expect(s.probe().quote.quote?.fee, change).toBe(CHANGED_FEE);
  }
  expect(s.probe().minimum, change).not.toBe(clickMinimum);
  expect(primaryState(), change).toBe("awaiting-signature");
  expect(switchGate.heldCount, change).toBe(1);
  expect(s.wallet.sent, change).toHaveLength(0);

  // 전송 직전 시각: 현재 가짜 시각 이후의 다음 정수 초 경계 T1
  const T1 = Math.floor(Date.now() / 1000) * 1000 + 1000;
  await advanceFakeTimeTo(T1);
  expect(T1, change).toBeGreaterThan(T0);

  switchGate.release();
  // 시계를 움직이지 않는 대기로 전송 요청을 기다린다.
  await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
  const sent = s.wallet.sent[0]!;
  await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
  await settlePendingWork();
  return { s, sent, clickFee, clickMinimum, T0, T1 };
}

describe("ETH가 낀 스왑 — 사용자가 ETH를 보내거나 받는 단일 홉 스왑을 approve 규칙에 맞게 실행한다", () => {
  describe("ETH를 보내는 스왑의 주 버튼", () => {
    /**
     * @spec DoD-1
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고(지갑 체인과 선택 체인이 같다) 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`(amountInRaw `1_000_000_000_000_000_000n`)이며 견적이 `success`이고 가격 영향이 `normal` 등급이며 useAmountOutMinimum()이 0보다 크다. 표본(RPC 스텁의 allowance 규칙): 0 응답, maxUint256 응답, 첫 응답 붙잡기, transport 재시도 대상이 아닌 JSON-RPC 오류 응답을 하나씩 반복한다
     * @when 견적이 `success`가 된 뒤 주 버튼을 읽는다
     * @then 모든 표본에서 주 버튼 data-state는 swap-ready다
     * @then 모든 표본에서 주 버튼은 활성이다
     */
    it(
      "[DoD-1] ETH를 보내면 allowance 상태와 무관하게 견적 success 뒤 swap-ready이고 활성이다",
      async () => {
        type Sample = { label: string; allowance: AllowanceFn; extra?: () => (() => void) | void };
        const samples: Sample[] = [
          { label: "allowance 0 응답", allowance: allowanceAlways(0n) },
          { label: "allowance maxUint256 응답", allowance: allowanceAlways(STUB_MAX_UINT256) },
          {
            label: "allowance 첫 응답 붙잡기",
            allowance: allowanceAlways(0n),
            extra: () => {
              const gate = rpc.holdAllowance();
              return () => gate.release();
            },
          },
          {
            label: "allowance JSON-RPC 오류",
            allowance: allowanceAlways(0n),
            extra: () => rpc.failAllowanceWhen(matchAllowance.any),
          },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const s = await renderConnectedApp({
            quoteRule: parityQuoteRule,
            allowance: sample.allowance,
          });
          const release = sample.extra?.();
          await enterPair(NATIVE_ETH, ETHEREUM_USDC, "1", "swap-ready");

          // 전제: 견적 success, 가격 영향 0 이하(normal), 최소 수령량 > 0
          const { quote, minimum } = s.probe();
          expect(quote.status, label).toBe("success");
          expect(quote.quote?.priceImpactBps, label).toBeLessThanOrEqual(0);
          expect(minimum !== null && minimum > 0n, `${label} 최소 수령량 > 0`).toBe(true);

          expect(primaryState(), label).toBe("swap-ready");
          expect(primaryButton().disabled, label).toBe(false);
          release?.();
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("ETH를 받는 스왑의 주 버튼", () => {
    /**
     * @spec DoD-4
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 보내는 USDC(잔액 충분), 받는 ETH, 금액 `1.5`(amountInRaw `1_500_000n`)이며 견적이 `success`이고 가격 영향이 `normal` 등급이며 useAmountOutMinimum()이 0보다 크다. RPC 스텁의 allowance 응답이 0이다(amountInRaw보다 작다)
     * @when allowance 읽기가 끝난 뒤 주 버튼을 읽는다
     * @then 주 버튼 data-state는 approve-required다
     * @then 주 버튼은 활성이다
     */
    it(
      "[DoD-4] ETH를 받을 때 allowance가 amountInRaw보다 작으면 approve-required이고 활성이다",
      async () => {
        const s = await renderConnectedApp({
          quoteRule: parityQuoteRule,
          allowance: allowanceAlways(0n),
        });
        await enterPair(ETHEREUM_USDC, NATIVE_ETH, "1.5", "approve-required");

        // 전제: 견적 success, 가격 영향 0 이하(normal), 최소 수령량 > 0, allowance 읽기가 0으로 끝났다.
        const { quote, minimum, allowance } = s.probe();
        expect(quote.status).toBe("success");
        expect(quote.quote?.priceImpactBps).toBeLessThanOrEqual(0);
        expect(minimum !== null && minimum > 0n, "최소 수령량 > 0").toBe(true);
        expect(usdcAllowanceReads().some((request) => request.status === "ok")).toBe(true);
        expect(allowance.status).toBe("success");
        expect(allowance.allowance).toBe(0n);

        expect(primaryState()).toBe("approve-required");
        expect(primaryButton().disabled).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-4
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 보내는 USDC(잔액 충분), 받는 ETH, 금액 `1.5`(amountInRaw `1_500_000n`)이며 견적이 `success`이고 가격 영향이 `normal` 등급이며 useAmountOutMinimum()이 0보다 크다. RPC 스텁의 allowance 응답이 maxUint256이다(amountInRaw 이상)
     * @when allowance 읽기가 끝난 뒤 주 버튼을 읽는다
     * @then 주 버튼 data-state는 swap-ready다
     * @then 주 버튼은 활성이다
     */
    it(
      "[DoD-4] ETH를 받을 때 allowance가 amountInRaw 이상이면 swap-ready이고 활성이다",
      async () => {
        const s = await renderConnectedApp({
          quoteRule: parityQuoteRule,
          allowance: allowanceAlways(STUB_MAX_UINT256),
        });
        await enterPair(ETHEREUM_USDC, NATIVE_ETH, "1.5", "swap-ready");

        // 전제: 견적 success, 가격 영향 0 이하(normal), 최소 수령량 > 0, allowance 읽기가 maxUint256으로 끝났다.
        const { quote, minimum, allowance } = s.probe();
        expect(quote.status).toBe("success");
        expect(quote.quote?.priceImpactBps).toBeLessThanOrEqual(0);
        expect(minimum !== null && minimum > 0n, "최소 수령량 > 0").toBe(true);
        expect(usdcAllowanceReads().some((request) => request.status === "ok")).toBe(true);
        expect(allowance.status).toBe("success");
        expect(allowance.allowance).toBe(STUB_MAX_UINT256);

        expect(primaryState()).toBe("swap-ready");
        expect(primaryButton().disabled).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("ETH를 보내는 스왑 트랜잭션", () => {
    /**
     * @spec DoD-7 DoD-8
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있다(지갑 체인과 선택 체인이 같다). 견적 스텁은 표본마다 한 fee 티어의 수령량 Q를 가장 크게 응답하고 두 표본의 최선 티어는 서로 다르다. 표본(보내는 → 받는 — 금액(amountInRaw) — 슬리피지 bps — 최선 티어): ETH → USDC — `1`(`1_000_000_000_000_000_000n`) — `50`(초기값) — `500`, ETH → DAI — `0.25`(`250_000_000_000_000_000n`) — `100`(금액 입력 전에 slippage-option으로 고름) — `3000`을 하나씩 반복한다. 주 버튼이 swap-ready이고 활성인 것을 확인한 뒤 클릭 시점의 useSwapQuote().quote.fee와 useAmountOutMinimum()을 기록하고, `Date`만 가짜로 두어 시스템 시각을 정수 초 경계 T(1000의 배수인 ms 리터럴)에 맞춰 전송 요청까지 움직이지 않게 한다. `eth_sendTransaction` 핸들러는 호출된 시점의 `Date.now()`를 기록하고 해시로 응답한다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이고 핸들러가 기록한 `Date.now()`가 T다
     * @then 전송 요청의 `to`가 Ethereum swapRouter02 주소 리터럴이다
     * @then 전송 요청의 calldata를 테스트 쪽 `multicall` ABI 리터럴로 디코딩하면 함수가 `multicall(uint256,bytes[])`이고 `data` 배열의 원소가 1개이며, 그 원소를 테스트 쪽 `exactInputSingle` ABI 리터럴로 디코딩하면 함수가 `exactInputSingle`이다
     * @then `multicall`의 deadline이 `T / 1000 + 1800`이다
     * @then `exactInputSingle`의 tokenIn이 Ethereum WETH 주소 리터럴이고 tokenOut이 표본 받는 토큰 주소 리터럴(USDC 또는 DAI)이다
     * @then `exactInputSingle`의 fee가 기록한 quote.fee이고 스텁이 고른 티어 리터럴이다
     * @then `exactInputSingle`의 recipient가 연결 계정이다
     * @then `exactInputSingle`의 amountIn이 표본 amountInRaw 리터럴이다
     * @then `exactInputSingle`의 amountOutMinimum이 기록한 useAmountOutMinimum()이고 테스트 쪽 식 `Q * (10000n - bps) / 10000n`과 같다
     * @then `exactInputSingle`의 sqrtPriceLimitX96이 `0n`이다
     * @then 전송 요청의 `value`가 표본 amountInRaw 리터럴이다
     */
    it(
      "[DoD-7][DoD-8] ETH를 보내는 swap-ready 클릭은 WETH 치환 exactInputSingle 하나를 담은 multicall을 amountInRaw value와 함께 swapRouter02로 보낸다",
      async () => {
        // 정수 초 경계(1000의 배수인 ms)
        const T = 1_900_000_000_000;
        const samples = [
          {
            label: "ETH → USDC, 슬리피지 50, 티어 500",
            tokenOut: ETHEREUM_USDC,
            amount: "1",
            amountInRaw: 1_000_000_000_000_000_000n,
            slippageBps: 50n,
            chooseSlippageFirst: false,
            fee: 500 as StubFeeTier,
          },
          {
            label: "ETH → DAI, 슬리피지 100, 티어 3000",
            tokenOut: ETHEREUM_DAI,
            amount: "0.25",
            amountInRaw: 250_000_000_000_000_000n,
            slippageBps: 100n,
            chooseSlippageFirst: true,
            fee: 3000 as StubFeeTier,
          },
        ];

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const rule = bestTierRule((query) => ({
            fee: sample.fee,
            amountOut: query.amountIn * 2n + 7n,
          }));
          const s = await renderConnectedApp({
            quoteRule: rule,
            allowance: allowanceAlways(STUB_MAX_UINT256),
          });
          if (sample.chooseSlippageFirst) await chooseSlippage(Number(sample.slippageBps));
          await enterPair(NATIVE_ETH, sample.tokenOut, sample.amount, "swap-ready");
          expect(primaryButton().disabled, label).toBe(false);

          // 견적은 WETH 치환 주소로 읽는다(테스트 쪽 기대 수령량).
          const Q = bestStubQuote(rule, {
            chainId: mainnet.id,
            tokenIn: ETHEREUM_WETH,
            tokenOut: sample.tokenOut,
            amountIn: sample.amountInRaw,
          })!.amountOut;
          const atClick = s.probe();
          if (atClick.quote.status !== "success")
            throw new Error(`${label}: 견적이 success가 아니다`);
          const clickFee = atClick.quote.quote.fee;
          const clickMinimum = atClick.minimum;
          // 전제: 스텁이 고른 티어와 수령량으로 견적이 끝났다.
          expect(clickFee, label).toBe(sample.fee);
          expect(atClick.quote.quote.amountOut, label).toBe(Q);

          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(T);
          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          const sent = s.wallet.sent[0]!;

          expect(sendCount(s.stub), label).toBe(1);
          expect(sent.at, label).toBe(T);
          expectSameAddress(sent.to, ETHEREUM_ROUTER, `${label} to`);

          const decoded = decodeSentMulticall(sent);
          expect(decoded.calls, label).toHaveLength(1);
          const params = exactInputSingleOf(decoded.calls[0], label);
          expect(decoded.deadline, label).toBe(BigInt(T / 1000) + DEADLINE_SECONDS);

          expectSameAddress(params.tokenIn, ETHEREUM_WETH, `${label} tokenIn`);
          expectSameAddress(params.tokenOut, sample.tokenOut, `${label} tokenOut`);
          expect(params.fee, label).toBe(clickFee);
          expect(params.fee, label).toBe(sample.fee);
          expectSameAddress(params.recipient, TEST_ACCOUNT, `${label} recipient`);
          expect(params.amountIn, label).toBe(sample.amountInRaw);
          expect(params.amountOutMinimum, label).toBe(clickMinimum);
          expect(params.amountOutMinimum, label).toBe(expectedMinimum(Q, sample.slippageBps));
          expect(params.sqrtPriceLimitX96, label).toBe(0n);

          expect(sentValue(sent), `${label} value`).toBe(sample.amountInRaw);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-8 DoD-7
     * @given 가짜 타이머(Date 포함)를 쓰고 스텁 EIP-1193으로 연결돼 있으며 지갑 체인은 Base(지갑 등록 체인 Base·Ethereum), 선택 체인은 Ethereum이라 둘이 다르다. 보내는 ETH(잔액 충분), 받는 USDC, 금액 `1`(amountInRaw `1_000_000_000_000_000_000n`), 슬리피지 `50`이고 견적이 티어 F1의 수령량 Q1을 최선으로 골라 `success`이며 주 버튼이 swap-ready다. 스텁 지갑은 `wallet_switchEthereumChain` 요청을 붙잡고, `eth_sendTransaction` 핸들러는 호출된 시점의 `Date.now()`를 기록하고 해시로 바로 응답한다. 클릭 직전에 가짜 시계를 정수 초 경계 T0(1000의 배수인 ms 리터럴)에 맞추고, 클릭 시점의 useSwapForm().amountInRaw, useSwapQuote().quote.fee, useAmountOutMinimum()을 기록한다. 표본(체인 전환 요청이 붙잡힌 서명 대기 중에 일으키는 변화): 금액 변화 — 보내는 칸 amount-input을 `2`로 바꾸고(스텁은 금액 `2`의 수령량을 Q1과 다르게 응답) 입력 반영 대기(300ms)가 지나 새 견적이 `success`가 되기를 기다림, 수령량·티어 변화 — 스텁의 같은 입력 응답을 F1과 다른 티어 F2의 수령량 Q2가 최선이 되도록 바꾸고 가짜 시계를 견적의 15초 주기 시각까지 진행해 견적 갱신을 기다림을 하나씩 반복한다
     * @when 주 버튼을 누르고 체인 전환 요청이 붙잡힌 동안 표본의 변화를 일으켜 반영되기를 기다린 뒤, 가짜 시계를 현재 가짜 시각 이후의 다음 정수 초 경계 T1(1000의 배수, T1 > T0)에 맞추고, 붙잡은 체인 전환 요청을 풀어(Ethereum으로 전환해 성공 응답) 시계를 움직이지 않는 대기로 전송 요청이 기록되기를 기다린다
     * @then 체인 전환 요청이 붙잡힌 동안 표본 변화가 반영됐고(금액 변화: useSwapForm().amountInRaw가 `2_000_000_000_000_000_000n`; 수령량·티어 변화: quote.fee가 F2이고 useAmountOutMinimum()이 클릭 시점 기록과 다르다) 주 버튼은 awaiting-signature다
     * @then 전송 요청이 1건이고 `to`가 Ethereum swapRouter02 주소 리터럴이다
     * @then 전송 요청의 `value`가 클릭 시점 amountInRaw `1_000_000_000_000_000_000n`이다
     * @then 전송 요청 calldata의 `exactInputSingle`은 amountIn이 클릭 시점 값 `1_000_000_000_000_000_000n`, amountOutMinimum이 클릭 시점에 기록한 값(Q1 기준), fee가 클릭 시점에 기록한 quote.fee(F1), tokenIn이 Ethereum WETH 주소 리터럴, tokenOut이 USDC 주소 리터럴, recipient가 연결 계정, sqrtPriceLimitX96이 `0n`이다
     * @then 핸들러가 기록한 `Date.now()`가 T1이고, `multicall`의 deadline이 전송 직전 시각 기준 `T1 / 1000 + 1800`이다(클릭 시각 기준 `T0 / 1000 + 1800`이 아니다)
     */
    it(
      "[DoD-8][DoD-7] ETH를 보내는 스왑의 서명 대기 중 금액·견적이 바뀌어도 value와 인자는 클릭 시점 값이다",
      async () => {
        for (const [index, change] of CLICK_TIME_CHANGES.entries()) {
          if (index > 0) resetSample();
          const run = await runClickTimeSample(change, {
            tokenIn: NATIVE_ETH,
            tokenOut: ETHEREUM_USDC,
            amount: "1",
            amountInRaw: 1_000_000_000_000_000_000n,
            changedAmountInRaw: 2_000_000_000_000_000_000n,
            quoteTokenIn: ETHEREUM_WETH,
            quoteTokenOut: ETHEREUM_USDC,
          });
          const { s, sent } = run;

          expect(sendCount(s.stub), change).toBe(1);
          expectSameAddress(sent.to, ETHEREUM_ROUTER, `${change} to`);
          expect(sentValue(sent), `${change} value`).toBe(1_000_000_000_000_000_000n);

          const decoded = decodeSentMulticall(sent);
          expect(decoded.calls, change).toHaveLength(1);
          const params = exactInputSingleOf(decoded.calls[0], change);
          expect(params.amountIn, change).toBe(1_000_000_000_000_000_000n);
          expect(params.amountOutMinimum, change).toBe(run.clickMinimum);
          expect(params.fee, change).toBe(run.clickFee);
          expectSameAddress(params.tokenIn, ETHEREUM_WETH, `${change} tokenIn`);
          expectSameAddress(params.tokenOut, ETHEREUM_USDC, `${change} tokenOut`);
          expectSameAddress(params.recipient, TEST_ACCOUNT, `${change} recipient`);
          expect(params.sqrtPriceLimitX96, change).toBe(0n);

          expect(sent.at, change).toBe(run.T1);
          expect(decoded.deadline, change).toBe(BigInt(run.T1 / 1000) + DEADLINE_SECONDS);
          expect(decoded.deadline, change).not.toBe(BigInt(run.T0 / 1000) + DEADLINE_SECONDS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("ETH를 받는 스왑 트랜잭션", () => {
    /**
     * @spec DoD-9
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고(지갑 체인과 선택 체인이 같다) RPC 스텁의 allowance 응답이 maxUint256이다. 견적 스텁은 표본마다 한 fee 티어의 수령량 Q를 가장 크게 응답하고 두 표본의 최선 티어는 서로 다르다. 표본(보내는 → 받는 — 금액(amountInRaw) — 슬리피지 bps — 최선 티어): USDC → ETH — `1.5`(`1_500_000n`) — `50`(초기값) — `500`, DAI → ETH — `2`(`2_000_000_000_000_000_000n`) — `100`(금액 입력 전에 slippage-option으로 고름) — `3000`을 하나씩 반복한다. 주 버튼이 swap-ready이고 활성인 것을 확인한 뒤 클릭 시점의 useSwapQuote().quote.fee와 useAmountOutMinimum()을 기록하고, `Date`만 가짜로 두어(타이머는 실제) 시스템 시각을 정수 초 경계 T(1000의 배수인 ms 리터럴)에 맞춰 전송 요청까지 움직이지 않게 한다. `eth_sendTransaction` 핸들러는 호출된 시점의 `Date.now()`를 기록하고 해시로 응답한다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이고 `to`가 Ethereum swapRouter02 주소 리터럴이다
     * @then 전송 요청의 calldata를 테스트 쪽 `multicall` ABI 리터럴로 디코딩하면 함수가 `multicall(uint256,bytes[])`이고 `data` 배열의 원소가 2개이며, 첫 원소는 테스트 쪽 `exactInputSingle` ABI 리터럴로, 둘째 원소는 테스트 쪽 `unwrapWETH9` ABI 리터럴로 디코딩된다
     * @then 핸들러가 기록한 `Date.now()`가 T이고, `multicall`의 deadline이 `T / 1000 + 1800`이다
     * @then `exactInputSingle`의 recipient가 ADDRESS_THIS 리터럴 `0x0000000000000000000000000000000000000002`다
     * @then `exactInputSingle`의 tokenIn이 표본 보내는 토큰 주소 리터럴(USDC 또는 DAI)이고 tokenOut이 Ethereum WETH 주소 리터럴이다
     * @then `exactInputSingle`의 fee가 기록한 quote.fee이고 스텁이 고른 티어 리터럴이다
     * @then `exactInputSingle`의 amountIn이 표본 amountInRaw 리터럴이다
     * @then `exactInputSingle`의 amountOutMinimum이 기록한 useAmountOutMinimum()이고 테스트 쪽 식 `Q * (10000n - bps) / 10000n`과 같다
     * @then `exactInputSingle`의 sqrtPriceLimitX96이 `0n`이다
     * @then `unwrapWETH9`의 amountMinimum이 기록한 useAmountOutMinimum()이다
     * @then `unwrapWETH9`의 recipient가 연결 계정이다
     */
    it(
      "[DoD-9] ETH를 받는 swap-ready 클릭은 ADDRESS_THIS로 받는 exactInputSingle과 연결 계정으로 보내는 unwrapWETH9를 담은 multicall을 swapRouter02로 보낸다",
      async () => {
        // 정수 초 경계(1000의 배수인 ms)
        const T = 1_900_000_000_000;
        const samples = [
          {
            label: "USDC → ETH, 슬리피지 50, 티어 500",
            tokenIn: ETHEREUM_USDC,
            amount: "1.5",
            amountInRaw: 1_500_000n,
            slippageBps: 50n,
            chooseSlippageFirst: false,
            fee: 500 as StubFeeTier,
          },
          {
            label: "DAI → ETH, 슬리피지 100, 티어 3000",
            tokenIn: ETHEREUM_DAI,
            amount: "2",
            amountInRaw: 2_000_000_000_000_000_000n,
            slippageBps: 100n,
            chooseSlippageFirst: true,
            fee: 3000 as StubFeeTier,
          },
        ];

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const rule = bestTierRule((query) => ({
            fee: sample.fee,
            amountOut: query.amountIn * 2n + 7n,
          }));
          const s = await renderConnectedApp({
            quoteRule: rule,
            allowance: allowanceAlways(STUB_MAX_UINT256),
          });
          if (sample.chooseSlippageFirst) await chooseSlippage(Number(sample.slippageBps));
          await enterPair(sample.tokenIn, NATIVE_ETH, sample.amount, "swap-ready");
          expect(primaryButton().disabled, label).toBe(false);

          // 견적은 WETH 치환 주소로 읽는다(테스트 쪽 기대 수령량).
          const Q = bestStubQuote(rule, {
            chainId: mainnet.id,
            tokenIn: sample.tokenIn,
            tokenOut: ETHEREUM_WETH,
            amountIn: sample.amountInRaw,
          })!.amountOut;
          const atClick = s.probe();
          if (atClick.quote.status !== "success")
            throw new Error(`${label}: 견적이 success가 아니다`);
          const clickFee = atClick.quote.quote.fee;
          const clickMinimum = atClick.minimum;
          // 전제: 스텁이 고른 티어와 수령량으로 견적이 끝났다.
          expect(clickFee, label).toBe(sample.fee);
          expect(atClick.quote.quote.amountOut, label).toBe(Q);

          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(T);
          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          const sent = s.wallet.sent[0]!;

          expect(sendCount(s.stub), label).toBe(1);
          expectSameAddress(sent.to, ETHEREUM_ROUTER, `${label} to`);

          const decoded = decodeSentMulticall(sent);
          expect(decoded.calls, label).toHaveLength(2);
          const params = exactInputSingleOf(decoded.calls[0], label);
          const unwrap = unwrapWeth9Of(decoded.calls[1], label);

          expect(sent.at, label).toBe(T);
          expect(decoded.deadline, label).toBe(BigInt(T / 1000) + DEADLINE_SECONDS);

          expectSameAddress(params.recipient, ADDRESS_THIS, `${label} recipient`);
          expectSameAddress(params.tokenIn, sample.tokenIn, `${label} tokenIn`);
          expectSameAddress(params.tokenOut, ETHEREUM_WETH, `${label} tokenOut`);
          expect(params.fee, label).toBe(clickFee);
          expect(params.fee, label).toBe(sample.fee);
          expect(params.amountIn, label).toBe(sample.amountInRaw);
          expect(params.amountOutMinimum, label).toBe(clickMinimum);
          expect(params.amountOutMinimum, label).toBe(expectedMinimum(Q, sample.slippageBps));
          expect(params.sqrtPriceLimitX96, label).toBe(0n);

          expect(unwrap.amountMinimum, `${label} unwrapWETH9 amountMinimum`).toBe(clickMinimum);
          expectSameAddress(unwrap.recipient, TEST_ACCOUNT, `${label} unwrapWETH9 recipient`);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-9
     * @given 가짜 타이머(Date 포함)를 쓰고 스텁 EIP-1193으로 연결돼 있으며 지갑 체인은 Base(지갑 등록 체인 Base·Ethereum), 선택 체인은 Ethereum이라 둘이 다르다. 보내는 USDC(잔액 충분), 받는 ETH, 금액 `1.5`(amountInRaw `1_500_000n`), 슬리피지 `50`, allowance maxUint256이고 견적이 티어 F1의 수령량 Q1을 최선으로 골라 `success`이며 주 버튼이 swap-ready다. 스텁 지갑은 `wallet_switchEthereumChain` 요청을 붙잡고, `eth_sendTransaction` 핸들러는 호출된 시점의 `Date.now()`를 기록하고 해시로 바로 응답한다. 클릭 직전에 가짜 시계를 정수 초 경계 T0(1000의 배수인 ms 리터럴)에 맞추고, 클릭 시점의 useSwapQuote().quote.fee와 useAmountOutMinimum()을 기록한다. 표본(체인 전환 요청이 붙잡힌 서명 대기 중에 일으키는 변화): 금액 변화 — 보내는 칸 amount-input을 `2`로 바꾸고(스텁은 금액 `2`의 수령량을 Q1과 다르게 응답) 입력 반영 대기(300ms)가 지나 새 견적이 `success`가 되기를 기다림, 수령량·티어 변화 — 스텁의 같은 입력 응답을 F1과 다른 티어 F2의 수령량 Q2가 최선이 되도록 바꾸고 가짜 시계를 견적의 15초 주기 시각까지 진행해 견적 갱신을 기다림을 하나씩 반복한다
     * @when 주 버튼을 누르고 체인 전환 요청이 붙잡힌 동안 표본의 변화를 일으켜 반영되기를 기다린 뒤, 가짜 시계를 현재 가짜 시각 이후의 다음 정수 초 경계 T1(1000의 배수, T1 > T0)에 맞추고, 붙잡은 체인 전환 요청을 풀어(Ethereum으로 전환해 성공 응답) 시계를 움직이지 않는 대기로 전송 요청이 기록되기를 기다린다
     * @then 체인 전환 요청이 붙잡힌 동안 표본 변화가 반영됐고(금액 변화: useSwapForm().amountInRaw가 `2_000_000n`; 수령량·티어 변화: quote.fee가 F2이고 useAmountOutMinimum()이 클릭 시점 기록과 다르다) 주 버튼은 awaiting-signature다
     * @then 전송 요청이 1건이고 `to`가 Ethereum swapRouter02 주소 리터럴이다
     * @then 전송 요청 calldata의 `exactInputSingle`은 amountIn이 클릭 시점 값 `1_500_000n`, amountOutMinimum이 클릭 시점에 기록한 값(Q1 기준), fee가 클릭 시점에 기록한 quote.fee(F1), tokenIn이 USDC 주소 리터럴, tokenOut이 Ethereum WETH 주소 리터럴, recipient가 ADDRESS_THIS 리터럴, sqrtPriceLimitX96이 `0n`이다
     * @then 전송 요청 calldata의 `unwrapWETH9`는 amountMinimum이 클릭 시점에 기록한 useAmountOutMinimum()(Q1 기준)이고 recipient가 연결 계정이다
     * @then 핸들러가 기록한 `Date.now()`가 T1이고, `multicall`의 deadline이 전송 직전 시각 기준 `T1 / 1000 + 1800`이다(클릭 시각 기준 `T0 / 1000 + 1800`이 아니다)
     */
    it(
      "[DoD-9] ETH를 받는 스왑의 서명 대기 중 금액·견적이 바뀌어도 exactInputSingle·unwrapWETH9 인자는 클릭 시점 값이다",
      async () => {
        for (const [index, change] of CLICK_TIME_CHANGES.entries()) {
          if (index > 0) resetSample();
          const run = await runClickTimeSample(change, {
            tokenIn: ETHEREUM_USDC,
            tokenOut: NATIVE_ETH,
            amount: "1.5",
            amountInRaw: 1_500_000n,
            changedAmountInRaw: 2_000_000n,
            quoteTokenIn: ETHEREUM_USDC,
            quoteTokenOut: ETHEREUM_WETH,
          });
          const { s, sent } = run;

          expect(sendCount(s.stub), change).toBe(1);
          expectSameAddress(sent.to, ETHEREUM_ROUTER, `${change} to`);

          const decoded = decodeSentMulticall(sent);
          expect(decoded.calls, change).toHaveLength(2);
          const params = exactInputSingleOf(decoded.calls[0], change);
          expect(params.amountIn, change).toBe(1_500_000n);
          expect(params.amountOutMinimum, change).toBe(run.clickMinimum);
          expect(params.fee, change).toBe(run.clickFee);
          expectSameAddress(params.tokenIn, ETHEREUM_USDC, `${change} tokenIn`);
          expectSameAddress(params.tokenOut, ETHEREUM_WETH, `${change} tokenOut`);
          expectSameAddress(params.recipient, ADDRESS_THIS, `${change} recipient`);
          expect(params.sqrtPriceLimitX96, change).toBe(0n);

          const unwrap = unwrapWeth9Of(decoded.calls[1], change);
          expect(unwrap.amountMinimum, `${change} unwrapWETH9 amountMinimum`).toBe(
            run.clickMinimum,
          );
          expectSameAddress(unwrap.recipient, TEST_ACCOUNT, `${change} unwrapWETH9 recipient`);

          expect(sent.at, change).toBe(run.T1);
          expect(decoded.deadline, change).toBe(BigInt(run.T1 / 1000) + DEADLINE_SECONDS);
          expect(decoded.deadline, change).not.toBe(BigInt(run.T0 / 1000) + DEADLINE_SECONDS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("ETH를 보내지 않는 스왑 트랜잭션의 value", () => {
    /**
     * @spec DoD-10
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고(지갑 체인과 선택 체인이 같다) RPC 스텁의 allowance 응답이 maxUint256이며 `eth_sendTransaction` 핸들러는 해시로 응답한다. 표본(보내는 → 받는 — 금액): ERC-20 페어 USDC → DAI — `1.5`, ETH를 받는 USDC → ETH — `1.5`를 하나씩 반복하며, 표본마다 주 버튼이 swap-ready이고 활성인 것을 확인한다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이고 `to`가 Ethereum swapRouter02 주소 리터럴이다
     * @then 전송 요청에 `value` 필드가 없거나 그 값이 0이다
     */
    it(
      "[DoD-10] ETH를 보내지 않는 스왑 전송 요청에는 value가 없거나 0이다",
      async () => {
        const samples = [
          { label: "ERC-20 페어 USDC → DAI", tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_DAI },
          { label: "ETH를 받는 USDC → ETH", tokenIn: ETHEREUM_USDC, tokenOut: NATIVE_ETH },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const s = await renderConnectedApp({
            quoteRule: parityQuoteRule,
            allowance: allowanceAlways(STUB_MAX_UINT256),
          });
          await enterPair(sample.tokenIn, sample.tokenOut, "1.5", "swap-ready");
          expect(primaryButton().disabled, label).toBe(false);

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          const sent = s.wallet.sent[0]!;

          expect(sendCount(s.stub), label).toBe(1);
          expectSameAddress(sent.to, ETHEREUM_ROUTER, `${label} to`);
          const value = sentValue(sent);
          expect(
            value === undefined || value === 0n,
            `${label} value 없음 또는 0 (실제 ${value})`,
          ).toBe(true);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("ETH가 낀 스왑의 진행과 결과 종류", () => {
    /**
     * @spec DoD-13
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 `eth_sendTransaction` 핸들러는 해시로 응답하며 영수증 응답을 붙잡는다. 표본(보내는 → 받는 — 금액): ETH → USDC — `1`, USDC → ETH — `1.5`(allowance maxUint256)를 하나씩 반복하며, 표본마다 주 버튼이 swap-ready인 것을 확인한다
     * @when 주 버튼을 눌러 해시를 받고, 영수증이 붙잡힌 동안 useSwapExecution()을 읽은 뒤 붙잡은 영수증을 성공으로 풀어 phase가 idle로 돌아가기를 기다린다
     * @then 영수증이 붙잡힌 동안 useSwapExecution().pendingTx.kind는 "swap"이다
     * @then 영수증 성공 뒤 useSwapExecution().result.kind는 "swap"이다
     */
    it(
      "[DoD-13] ETH를 보내거나 받는 스왑의 pendingTx.kind와 result.kind는 swap이다",
      async () => {
        const samples = [
          { label: "ETH → USDC", tokenIn: NATIVE_ETH, tokenOut: ETHEREUM_USDC, amount: "1" },
          { label: "USDC → ETH", tokenIn: ETHEREUM_USDC, tokenOut: NATIVE_ETH, amount: "1.5" },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const s = await renderConnectedApp({
            quoteRule: parityQuoteRule,
            allowance: allowanceAlways(STUB_MAX_UINT256),
          });
          await enterPair(sample.tokenIn, sample.tokenOut, sample.amount, "swap-ready");
          const receiptGate = rpc.holdReceipt();

          clickPrimary();
          await waitUntil(() => expect(s.wallet.hashes()).toHaveLength(1), READY_TIMEOUT_MS);
          await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
          const pending = s.probe().execution;
          expect(pending.phase, label).toBe("swapping");
          expect(pending.pendingTx?.kind, `${label} pendingTx.kind`).toBe("swap");

          receiptGate.release();
          await waitUntil(() => {
            const { execution } = s.probe();
            expect(execution.phase).toBe("idle");
            expect(execution.result).not.toBeNull();
          }, READY_TIMEOUT_MS);
          expect(s.probe().execution.result?.kind, `${label} result.kind`).toBe("swap");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
