import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedChainId } from "@/config/chains";
import { type WagmiConfig, createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceFn,
  type BalanceRpcRequest,
  type BalanceRpcStub,
  type QuoteRule,
  type Slot0Query,
  type StubFeeTier,
  type StubPrice,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  STUB_ETH_ADDRESS,
  STUB_Q96,
  STUB_USDC_BY_CHAIN,
  STUB_WETH_BY_CHAIN,
  balancesWith,
  expectedStubUsdPrice,
  installBalanceRpcStub,
  match,
  matchUsdPrice,
  sameAddress,
  stubPricesEqual,
  stubUsdMicros,
} from "../support/rpc-balance-stub";
import {
  advanceFakeTimeTo,
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  waitUntil,
  waitUntilAdvancingFakeClock,
  yieldToPendingWork,
} from "../support/wagmi-harness";

// 골격(T-10). 카드(보내는·받는 칸의 usd-value, balance-usd)와 견적 정보 행(quote-amount-out-usd,
// quote-amount-out-minimum-usd)이 쓰는 단가의 60초 주기·포커스·숨김 탭 갱신, 카드↔견적 행 캐시 공유,
// 갱신 실패 시 이전 값 유지와 무재시도, 체인·토큰·금액 변화를 앱 화면과 요청 기록으로 확인한다.
// 모달 일괄 조회와 모달→카드 방향 캐시 공유(DoD-29 일부)는 usd-price-modal.test.tsx가 맡는다.
// mock 경계(사용자 확정 2026-11-22): F3·F7 통합 경계(실제 wagmi·Provider·화면, wagmi mock 커넥터,
// 전역 fetch의 URL 라우팅 스텁, `vi.mock` 금지)에 T-8의 단가 aggregate3 스텁 분류·응답, 가짜 타이머,
// `document.visibilityState` 스텁과 `visibilitychange` 이벤트, HTTP 429 응답을 더한 것. 그 밖의 provider·훅·컴포넌트는 실제 코드를 쓴다.
// 증명하지 못하는 것: 실제 브라우저의 탭 숨김과 타이머 스로틀링(가짜 타이머·visibility 스텁으로만 만든다).
// 데이터 격리: 테스트(표본)마다 config·RPC 스텁·QueryClient를 새로 만들고 쿠키를 지운다(clearCookies). 가짜 타이머는 테스트마다 원복한다.
// 이 파일에서 "단가 요청 1건"은 선택 체인으로 가는 단가 aggregate3(첫 하위 호출이 QuoterV2 `quoteExactInputSingle`인
// Multicall3 `eth_call`, 계획 §1) JSON-RPC 항목 1건이다(배치 배열은 항목마다 센다). 견적 요청은 세지 않는다.
// "토큰 X의 단가 요청"은 디코드한 쌍의 대상 토큰이 X인 단가 요청이다. ETH의 단가는 같은 체인 WETH 단가와 같다(DoD-4).
// 받는 칸 USDC는 단가 요청을 보내지 않으므로(DoD-3) 주기·포커스 판정의 받는 토큰은 USDC 직접 경로 토큰(DAI)을 쓴다.
// 스텁은 체인·토큰마다 다른 단가를 돌려줘 어느 단가로 계산했는지 data-usd-micros로 구분한다.
// 기대 micros는 테스트 쪽에서 `금액 raw × 스텁 단가 분자 / 분모`를 버림해 계산한다. 기대 주소는 제품 config를 쓰지 않고 리터럴로 적는다.
// 60초 주기 판정은 주기 타이머(setInterval·clearInterval)와 시계(Date)를 가짜로 두고, 주기 시작 시점(그 토큰의 첫 단가 요청 시각)부터
// 시계를 진행한다(F2 balances.test.tsx·F3 quote-refresh.test.tsx와 같은 방식). setTimeout은 기본적으로 실제 타이머다.
// 재시도 없음(EC-10) 판정은 관찰 구간이 재시도 지연(TanStack 기본 1·2·4초, viem HTTP 재시도 150·300·600ms)을 덮어야 한다.
// 첫 조회 실패는 usd-value가 `error`가 된 뒤(재시도가 있으면 그 뒤에야 `error`가 된다) 요청 수를 보고, 주기 갱신 실패는
// 재시도 지연 타이머(setTimeout)도 가짜로 두고 진행하거나 그만큼 실제 시간을 기다린 뒤 요청 수를 본다.
// 입력 반영 대기(300ms, EC-13) 판정은 그 타이머(setTimeout)를 가짜로 두고 진행하지 않은 시점에 본다.

const CASE_TIMEOUT_MS = 60_000;
const MULTI_SAMPLE_TIMEOUT_MS = 240_000;
// 응답·화면 반영을 기다리는 실제 시간 상한
const WAIT_MS = 20_000;

// 스펙 값: 카드·견적 행 단가 주기 60초(DoD-26)
const PRICE_REFETCH_MS = 60_000;
// 재시도 관찰 구간(실제 시간). TanStack 기본 재시도의 첫 지연(1초)과 viem HTTP 재시도 지연의 합(150 + 300 + 600ms)보다 길다.
// 어느 쪽이든 재시도가 있으면 이 구간 안에 같은 단가 요청이 한 건 이상 더 나간다.
const RETRY_OBSERVATION_MS = 2_000;

let rpc: BalanceRpcStub;
// 커밋마다 호출할 관찰 함수(표본마다 비운다)
let onCommitHook: (() => void) | null = null;

beforeEach(() => {
  rpc = installBalanceRpcStub();
});

afterEach(() => {
  onCommitHook = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
});

// 같은 case 안에서 표본마다 앱(config·QueryClient)과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  onCommitHook = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

type Side = "in" | "out";

// ─── 공식 주소(리터럴) ──────────────────────────────────────────────

const ETH_ADDRESS: Address = STUB_ETH_ADDRESS;
const ETHEREUM_WETH: Address = STUB_WETH_BY_CHAIN[mainnet.id];
const ETHEREUM_USDC: Address = STUB_USDC_BY_CHAIN[mainnet.id];
// Ethereum 토큰 목록의 18자리 토큰(목록 스냅샷에서 확인한 주소 리터럴)
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_LINK: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
// 세 체인 목록에 같은 주소로 있는 18자리 토큰
const ZRO: Address = "0x6985884C4392D348587B19cb9eAAf157F13271cd";

const ONE = 10n ** 18n;
const TWO = 2n * ONE;

const CONNECTED_STATES = [
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "wrapping",
  "unwrapping",
  "wrap-ready",
  "unwrap-ready",
  "swap-ready",
  "approve-required",
  "price-impact-too-high",
];

// ─── 단가 규칙(테스트 쪽) ────────────────────────────────────────────

// 네 티어 견적 수령량. 금액과 무관하게 500 티어가 가장 많아 고르는 티어가 토큰 decimals에 따라 바뀌지 않는다.
const TIER_AMOUNT_OUT: Record<StubFeeTier, bigint> = {
  100: 970n,
  500: 1_000n,
  3000: 990n,
  10000: 950n,
};

// 풀마다(체인·두 토큰·티어) 다른 slot0 sqrtPriceX96. `version`을 바꾸면 모든 풀의 값이 바뀐다.
function poolSqrtPriceX96(query: Slot0Query, version: bigint): bigint {
  const seed = (BigInt(query.token0) % 997n) * 1_000n + (BigInt(query.token1) % 991n);
  return (
    STUB_Q96 * (3n + seed + BigInt(query.fee) + (BigInt(query.chainId) % 1_009n) * 7n) +
    version * 1_000_003n
  );
}

// 모든 쌍에 USDC 직접 경로가 있는 단가 규칙. 체인·토큰마다 단가가 다르다.
function priceRule(version: bigint): QuoteRule {
  return {
    quote: (query) => ({
      status: "ok",
      amountOut: TIER_AMOUNT_OUT[query.fee],
      sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
    }),
    slot0: (query) => ({ status: "ok", sqrtPriceX96: poolSqrtPriceX96(query, version) }),
  };
}

const RULE_V0 = priceRule(0n);
const RULE_V1 = priceRule(1n);

// 규칙이 낼 단가(테스트 쪽 계산). 이 파일의 표본 토큰은 모두 18자리이고, 위 규칙의 티어 선택은 금액과 무관하다.
function expectedPrice(rule: QuoteRule, chainId: SupportedChainId, token: Address): StubPrice {
  const expected = expectedStubUsdPrice(rule, { chainId, token, decimals: 18 });
  if (expected.status !== "success") throw new Error(`기대 단가가 없다: ${chainId} ${token}`);
  return expected.price;
}

function micros(amountRaw: bigint, price: StubPrice): string {
  return stubUsdMicros(amountRaw, price).toString();
}

// ─── 잔액(테스트 쪽) ────────────────────────────────────────────────

// 카드 잔액. 토큰마다 다르다.
const CARD_BALANCES: BalanceFn = balancesWith(
  {
    [ETH_ADDRESS]: 7n * ONE + 123_456_789n,
    [ETHEREUM_DAI]: 3_210n * ONE + 987n,
    [ETHEREUM_LINK]: 45n * ONE + 4_321n,
    [ZRO]: 12n * ONE + 55n,
  },
  () => 0n,
);
// 모달 목록 잔액 읽기 동안의 잔액. 모두 0이라 모달 일괄 조회 대상이 없다(이 파일은 모달 일괄 조회를 판정하지 않는다).
const ZERO_BALANCES: BalanceFn = () => 0n;

// ─── 화면 ─────────────────────────────────────────────────────────

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

function usdValue(side: Side): HTMLElement {
  return within(field(side)).getByTestId("usd-value");
}

function usdState(side: Side): string | null {
  return usdValue(side).getAttribute("data-state");
}

function usdMicros(side: Side): string | null {
  return usdValue(side).getAttribute("data-usd-micros");
}

function cardBalanceRaw(side: Side): bigint | null {
  const raw = within(field(side)).queryByTestId("balance")?.getAttribute("data-balance-raw");
  return raw === undefined || raw === null ? null : BigInt(raw);
}

function balanceUsdMicros(side: Side): string | null {
  return within(field(side)).queryByTestId("balance-usd")?.getAttribute("data-usd-micros") ?? null;
}

function hasBalanceUsdWithMicros(side: Side): boolean {
  return field(side).querySelector('[data-testid="balance-usd"][data-usd-micros]') !== null;
}

function quoteUsdMicros(
  testId: "quote-amount-out-usd" | "quote-amount-out-minimum-usd",
): string | null {
  return screen.queryByTestId(testId)?.getAttribute("data-usd-micros") ?? null;
}

function hasQuoteUsdWithMicros(): boolean {
  return (
    document.querySelector(
      '[data-testid="quote-amount-out-usd"][data-usd-micros], [data-testid="quote-amount-out-minimum-usd"][data-usd-micros]',
    ) !== null
  );
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

// 모달 목록 잔액을 모두 0으로 읽게 하고 토큰을 고른다. 목록 잔액이 행에 반영된 뒤 카드 잔액 규칙으로 되돌리고 행을 누른다.
// 모달 일괄 조회 대상이 없어 이 파일의 단가 요청은 카드 칸 단가 읽기뿐이다.
async function chooseToken(side: Side, address: Address, beforeClick?: () => void) {
  rpc.setBalances(ZERO_BALANCES);
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  await waitUntil(
    () => expect(optionRow(address).getAttribute("data-balance-raw")).toBe("0"),
    WAIT_MS,
  );
  rpc.setBalances(CARD_BALANCES);
  beforeClick?.();
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"));
  });
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return {
    form: useSwapForm(),
    selected: useSelectedChain(),
    quote: useSwapQuote(),
    minimum: useAmountOutMinimum(),
  };
}

type ProbeView = { result: { current: ReturnType<typeof useProbe> } };

function appConfig(): WagmiConfig {
  return createWagmiConfig({
    connectors: [mockConnector({ defaultConnected: true, reconnect: true })],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱(보내는 ETH, 받는 칸 미선택)
async function renderConnectedApp() {
  const view = renderAppHook(useProbe, {
    config: appConfig(),
    initialChainId: mainnet.id,
    onCommit: () => onCommitHook?.(),
  });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()), WAIT_MS);
  return view;
}

// 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 둔다. setTimeout은 실제 타이머다.
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

// ─── 요청 기록 ──────────────────────────────────────────────────────

function priceRequests(token: Address, chainId: SupportedChainId = mainnet.id) {
  return rpc.requests(match.chain(chainId, matchUsdPrice.target(token)));
}

function priceCount(token: Address, chainId: SupportedChainId = mainnet.id): number {
  return priceRequests(token, chainId).length;
}

function allPriceCount(): number {
  return rpc.requests(matchUsdPrice.any).length;
}

// 토큰의 첫 단가 요청 시각(가짜 시계). 그 토큰 단가 주기의 시작 시점이다.
function firstPriceRequestAt(token: Address): number {
  const first = priceRequests(token)[0];
  if (!first) throw new Error(`${token}의 단가 요청이 없다`);
  return first.at;
}

async function waitPriceRequestsSettled() {
  await waitUntil(
    () =>
      expect(rpc.requests(matchUsdPrice.any).every((request) => request.status !== "pending")).toBe(
        true,
      ),
    WAIT_MS,
  );
  await settlePendingWork();
}

// ─── 표시 값 ───────────────────────────────────────────────────────

type UsdDisplay = {
  in: string | null;
  out: string | null;
  balanceIn: string | null;
  balanceOut: string | null;
  quoteOut: string | null;
  quoteMinimum: string | null;
};

function currentDisplay(): UsdDisplay {
  return {
    in: usdMicros("in"),
    out: usdMicros("out"),
    balanceIn: balanceUsdMicros("in"),
    balanceOut: balanceUsdMicros("out"),
    quoteOut: quoteUsdMicros("quote-amount-out-usd"),
    quoteMinimum: quoteUsdMicros("quote-amount-out-minimum-usd"),
  };
}

function quotedAmountOut(view: ProbeView): bigint {
  const { quote } = view.result.current;
  if (quote.status !== "success" || !quote.quote) throw new Error("견적이 success가 아니다");
  return quote.quote.amountOut;
}

// 보내는 금액 `amountInRaw`, 두 칸 단가로 테스트가 계산한 표시 값. 잔액은 카드에 표시된 값이다.
function expectedDisplay(
  view: ProbeView,
  amountInRaw: bigint,
  prices: { in: StubPrice; out: StubPrice },
): UsdDisplay {
  const amountOut = quotedAmountOut(view);
  const minimum = view.result.current.minimum;
  const balanceIn = cardBalanceRaw("in");
  const balanceOut = cardBalanceRaw("out");
  if (minimum === null || balanceIn === null || balanceOut === null) {
    throw new Error("최소 수령량이나 카드 잔액이 없다");
  }
  return {
    in: micros(amountInRaw, prices.in),
    out: micros(amountOut, prices.out),
    balanceIn: micros(balanceIn, prices.in),
    balanceOut: micros(balanceOut, prices.out),
    quoteOut: micros(amountOut, prices.out),
    quoteMinimum: micros(minimum, prices.out),
  };
}

const ETH_PRICE_V0 = () => expectedPrice(RULE_V0, mainnet.id, ETH_ADDRESS);
const DAI_PRICE_V0 = () => expectedPrice(RULE_V0, mainnet.id, ETHEREUM_DAI);
const ETH_PRICE_V1 = () => expectedPrice(RULE_V1, mainnet.id, ETH_ADDRESS);
const DAI_PRICE_V1 = () => expectedPrice(RULE_V1, mainnet.id, ETHEREUM_DAI);

// 보내는 ETH, 받는 DAI, 금액 1의 견적이 success이고 두 칸·견적 행 USD가 단가 규칙 V0으로 표시될 때까지 기다린다.
async function renderEthDaiQuote() {
  rpc.setBalances(CARD_BALANCES);
  rpc.setUsdPriceRule(RULE_V0);
  const view = await renderConnectedApp();
  await chooseToken("out", ETHEREUM_DAI);
  await typeAmount("1");
  await waitUntil(() => expect(view.result.current.quote.status).toBe("success"), WAIT_MS);
  await waitUntil(
    () =>
      expect(currentDisplay()).toEqual(
        expectedDisplay(view, ONE, { in: ETH_PRICE_V0(), out: DAI_PRICE_V0() }),
      ),
    WAIT_MS,
  );
  expect(usdState("in")).toBe("success");
  expect(usdState("out")).toBe("success");
  await waitPriceRequestsSettled();
  return view;
}

// 커밋마다 보이는 USD micros를 모은다(이전 토큰·체인 단가로 계산한 값이 나타났는지 판정용).
function traceUsdMicros(side: Side, includeQuoteRows: boolean): Set<string> {
  const seen = new Set<string>();
  onCommitHook = () => {
    const sideField = screen
      .queryAllByTestId("token-field")
      .find((element) => element.getAttribute("data-side") === side);
    if (!sideField) return;
    const values = [
      sideField.querySelector('[data-testid="usd-value"]')?.getAttribute("data-usd-micros"),
      sideField.querySelector('[data-testid="balance-usd"]')?.getAttribute("data-usd-micros"),
    ];
    if (includeQuoteRows) {
      values.push(
        document
          .querySelector('[data-testid="quote-amount-out-usd"]')
          ?.getAttribute("data-usd-micros"),
        document
          .querySelector('[data-testid="quote-amount-out-minimum-usd"]')
          ?.getAttribute("data-usd-micros"),
      );
    }
    for (const value of values) if (value) seen.add(value);
  };
  return seen;
}

function failedSince(seq: number, token: Address): BalanceRpcRequest[] {
  return rpc.requests(match.since(seq, matchUsdPrice.target(token)));
}

describe("달러 환산 — 카드와 견적 정보의 USD가 단가 갱신과 실패 속에서도 맞는 값을 보인다", () => {
  describe("같은 토큰의 단가를 다시 읽는 경우", () => {
    /**
     * @spec DoD-26
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이고 usd-value[data-side=in]·usd-value[data-side=out]·balance-usd·quote-amount-out-usd·quote-amount-out-minimum-usd가 표시됐다. 그 뒤 스텁의 ETH(WETH)·DAI 단가를 다른 값으로 바꿨다
     * @when 가짜 시계를 각 토큰의 첫 단가 요청 시점부터 60초 직전까지, 이어서 60초까지, 다시 60초 진행한다
     * @then 60초 직전까지 ETH(WETH)·DAI의 단가 요청 수가 늘지 않는다
     * @then 60초가 지나면 ETH(WETH)·DAI의 단가 요청이 토큰마다 1건씩 는다
     * @then 그 뒤 usd-value[data-side=in]의 data-usd-micros가 바뀐 ETH 단가로, usd-value[data-side=out]·quote-amount-out-usd·quote-amount-out-minimum-usd의 data-usd-micros가 바뀐 DAI 단가로 계산한 값이다
     * @then 그 뒤 두 칸 balance-usd의 data-usd-micros가 각 칸 잔액과 바뀐 단가로 계산한 값이다
     * @then 다시 60초가 지나면 ETH(WETH)·DAI의 단가 요청이 토큰마다 1건씩 더 는다
     */
    it(
      "[DoD-26] 카드와 견적 행이 쓰는 단가를 60초마다 다시 읽고 새 단가로 USD를 계산한다",
      async () => {
        fakePeriodicTimers();
        const view = await renderEthDaiQuote();
        const start = firstPriceRequestAt(ETHEREUM_WETH);
        // 전제: 설정 동안 가짜 시계를 진행하지 않아 두 토큰의 첫 단가 요청 시각(주기 시작)이 같다.
        expect(firstPriceRequestAt(ETHEREUM_DAI), "두 토큰의 주기 시작").toBe(start);
        const before = { eth: priceCount(ETHEREUM_WETH), dai: priceCount(ETHEREUM_DAI) };
        rpc.setUsdPriceRule(RULE_V1);
        // 전제: 바꾼 단가가 이전 단가와 다르다.
        expect(stubPricesEqual(ETH_PRICE_V1(), ETH_PRICE_V0())).toBe(false);
        expect(stubPricesEqual(DAI_PRICE_V1(), DAI_PRICE_V0())).toBe(false);

        await advanceFakeTimeTo(start + PRICE_REFETCH_MS - 1);
        await settlePendingWork();
        expect(priceCount(ETHEREUM_WETH), "60초 직전 ETH").toBe(before.eth);
        expect(priceCount(ETHEREUM_DAI), "60초 직전 DAI").toBe(before.dai);

        await advanceFakeTimeTo(start + PRICE_REFETCH_MS);
        await waitUntil(() => {
          expect(priceCount(ETHEREUM_WETH)).toBeGreaterThanOrEqual(before.eth + 1);
          expect(priceCount(ETHEREUM_DAI)).toBeGreaterThanOrEqual(before.dai + 1);
        }, WAIT_MS);
        await waitPriceRequestsSettled();
        expect(priceCount(ETHEREUM_WETH), "60초 ETH").toBe(before.eth + 1);
        expect(priceCount(ETHEREUM_DAI), "60초 DAI").toBe(before.dai + 1);
        await waitUntil(
          () =>
            expect(currentDisplay()).toEqual(
              expectedDisplay(view, ONE, { in: ETH_PRICE_V1(), out: DAI_PRICE_V1() }),
            ),
          WAIT_MS,
        );

        await advanceFakeTimeTo(start + 2 * PRICE_REFETCH_MS);
        await waitUntil(() => {
          expect(priceCount(ETHEREUM_WETH)).toBeGreaterThanOrEqual(before.eth + 2);
          expect(priceCount(ETHEREUM_DAI)).toBeGreaterThanOrEqual(before.dai + 2);
        }, WAIT_MS);
        await waitPriceRequestsSettled();
        expect(priceCount(ETHEREUM_WETH), "120초 ETH").toBe(before.eth + 2);
        expect(priceCount(ETHEREUM_DAI), "120초 DAI").toBe(before.dai + 2);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-27
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이고 두 칸 usd-value가 `success`로 표시됐다. 그 뒤 스텁의 ETH(WETH)·DAI 단가를 다른 값으로 바꿨고 60초 주기는 아직 오지 않았다
     * @when window `focus` 이벤트를 발생시킨다
     * @then ETH(WETH)·DAI의 단가 요청이 토큰마다 1건씩 는다
     * @then usd-value[data-side=in]의 data-usd-micros가 바뀐 ETH 단가로, usd-value[data-side=out]·quote-amount-out-usd·quote-amount-out-minimum-usd의 data-usd-micros가 바뀐 DAI 단가로 계산한 값이다
     */
    it(
      "[DoD-27] 창 포커스 때 단가를 다시 읽는다",
      async () => {
        const view = await renderEthDaiQuote();
        const before = { eth: priceCount(ETHEREUM_WETH), dai: priceCount(ETHEREUM_DAI) };
        rpc.setUsdPriceRule(RULE_V1);
        expect(stubPricesEqual(ETH_PRICE_V1(), ETH_PRICE_V0())).toBe(false);
        expect(stubPricesEqual(DAI_PRICE_V1(), DAI_PRICE_V0())).toBe(false);

        focusWindow();
        await waitUntil(() => {
          expect(priceCount(ETHEREUM_WETH)).toBeGreaterThanOrEqual(before.eth + 1);
          expect(priceCount(ETHEREUM_DAI)).toBeGreaterThanOrEqual(before.dai + 1);
        }, WAIT_MS);
        await waitPriceRequestsSettled();
        expect(priceCount(ETHEREUM_WETH), "포커스 ETH").toBe(before.eth + 1);
        expect(priceCount(ETHEREUM_DAI), "포커스 DAI").toBe(before.dai + 1);
        await waitUntil(() => {
          const expected = expectedDisplay(view, ONE, { in: ETH_PRICE_V1(), out: DAI_PRICE_V1() });
          expect(usdMicros("in")).toBe(expected.in);
          expect(usdMicros("out")).toBe(expected.out);
          expect(quoteUsdMicros("quote-amount-out-usd")).toBe(expected.quoteOut);
          expect(quoteUsdMicros("quote-amount-out-minimum-usd")).toBe(expected.quoteMinimum);
        }, WAIT_MS);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-28
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이고 두 칸 usd-value가 `success`로 표시됐다. `document.visibilityState`를 `hidden`으로 스텁하고 `visibilitychange` 이벤트를 발생시켜 탭을 숨겼다. 단가 요청 수를 기록해 둔다
     * @when 가짜 시계를 60초 이상 진행한다
     * @then ETH(WETH)·DAI의 단가 요청 수가 늘지 않는다
     */
    it(
      "[DoD-28] 숨김 탭에서는 단가 주기 갱신을 하지 않는다",
      async () => {
        fakePeriodicTimers();
        await renderEthDaiQuote();
        const start = firstPriceRequestAt(ETHEREUM_WETH);
        // 탭 숨김(visibility 스텁). afterEach의 restoreAllMocks가 되돌린다.
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await settlePendingWork();
        const before = { eth: priceCount(ETHEREUM_WETH), dai: priceCount(ETHEREUM_DAI) };

        await advanceFakeTimeTo(Math.max(start, Date.now()) + 2 * PRICE_REFETCH_MS);
        await settlePendingWork();
        expect(priceCount(ETHEREUM_WETH), "숨김 ETH").toBe(before.eth);
        expect(priceCount(ETHEREUM_DAI), "숨김 DAI").toBe(before.dai);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("카드와 견적 정보가 같은 토큰의 단가를 함께 쓰는 경우", () => {
    /**
     * @spec DoD-29
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI가 선택돼 받는 칸 balance-usd가 DAI 단가로 표시됐다(카드의 DAI 단가 `success`). 금액은 비어 있고 DAI 단가 요청 수를 기록해 둔다
     * @when 금액 `1`을 입력하고 견적이 `success`가 되기를 기다린다
     * @then quote-amount-out-usd의 data-usd-micros가 견적 amountOut과 카드가 읽은 DAI 단가로 계산한 값이다
     * @then quote-amount-out-minimum-usd의 data-usd-micros가 useAmountOutMinimum() 값과 카드가 읽은 DAI 단가로 계산한 값이다
     * @then DAI 단가 요청 수가 늘지 않는다
     */
    it(
      "[DoD-29] 견적 행은 카드가 이미 읽은 단가를 추가 요청 없이 쓴다",
      async () => {
        rpc.setBalances(CARD_BALANCES);
        rpc.setUsdPriceRule(RULE_V0);
        const view = await renderConnectedApp();
        await chooseToken("out", ETHEREUM_DAI);
        await waitUntil(() => {
          const balance = cardBalanceRaw("out");
          expect(balance).not.toBeNull();
          expect(balanceUsdMicros("out")).toBe(micros(balance!, DAI_PRICE_V0()));
        }, WAIT_MS);
        await waitPriceRequestsSettled();
        expect(amountInput().value).toBe("");
        const before = priceCount(ETHEREUM_DAI);

        await typeAmount("1");
        await waitUntil(() => expect(view.result.current.quote.status).toBe("success"), WAIT_MS);
        await waitUntil(() => {
          const minimum = view.result.current.minimum;
          expect(minimum).not.toBeNull();
          expect(quoteUsdMicros("quote-amount-out-usd")).toBe(
            micros(quotedAmountOut(view), DAI_PRICE_V0()),
          );
          expect(quoteUsdMicros("quote-amount-out-minimum-usd")).toBe(
            micros(minimum!, DAI_PRICE_V0()),
          );
        }, WAIT_MS);
        await settlePendingWork();
        expect(priceCount(ETHEREUM_DAI), "DAI 단가 요청 수").toBe(before);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-29 EC-12
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이며 usd-value[data-side=in](ETH 단가)과 quote-amount-out-usd·usd-value[data-side=out](DAI 단가)이 `success`로 표시됐다. 단가 요청 수를 기록해 두고, 스텁은 이후 단가 응답을 붙잡는다
     * @when flip-button을 눌러 보내는 DAI, 받는 ETH로 뒤집고 금액 `1`을 입력한 직후, 이어서 견적이 `success`가 된 뒤를 확인한다
     * @then 금액 입력 직후 usd-value[data-side=in]이 `success`이고 data-usd-micros가 DAI amountInRaw와 뒤집기 전에 견적 행이 쓴 DAI 단가로 계산한 값이며 usd-skeleton이 없다
     * @then 견적 `success` 뒤 usd-value[data-side=out]·quote-amount-out-usd·quote-amount-out-minimum-usd의 data-usd-micros가 뒤집기 전에 카드가 쓴 ETH 단가로 계산한 값이다(뒤집기 전 받는 토큰 DAI의 단가로 계산하지 않는다)
     * @then 뒤집기 뒤 단가 요청 수가 늘지 않는다
     */
    it(
      "[DoD-29][EC-12] 뒤집으면 카드와 견적 행이 서로 이미 읽은 단가를 바로 쓴다",
      async () => {
        const view = await renderEthDaiQuote();
        const before = allPriceCount();
        const gate = rpc.holdUsdPrice();
        // 전제: 두 토큰 단가가 다르다.
        expect(stubPricesEqual(ETH_PRICE_V0(), DAI_PRICE_V0())).toBe(false);

        fireEvent.click(screen.getByTestId("flip-button"));
        await waitUntil(() => {
          expect(sameAddress(view.result.current.form.tokenIn?.address, ETHEREUM_DAI)).toBe(true);
          expect(sameAddress(view.result.current.form.tokenOut?.address, ETH_ADDRESS)).toBe(true);
        });
        await typeAmount("1");
        // 금액 입력 직후
        expect(usdState("in")).toBe("success");
        expect(usdMicros("in")).toBe(micros(ONE, DAI_PRICE_V0()));
        expect(within(usdValue("in")).queryByTestId("usd-skeleton")).toBeNull();

        await waitUntil(() => expect(view.result.current.quote.status).toBe("success"), WAIT_MS);
        await waitUntil(() => {
          const minimum = view.result.current.minimum;
          expect(minimum).not.toBeNull();
          const amountOut = quotedAmountOut(view);
          expect(usdMicros("out")).toBe(micros(amountOut, ETH_PRICE_V0()));
          expect(quoteUsdMicros("quote-amount-out-usd")).toBe(micros(amountOut, ETH_PRICE_V0()));
          expect(quoteUsdMicros("quote-amount-out-minimum-usd")).toBe(
            micros(minimum!, ETH_PRICE_V0()),
          );
        }, WAIT_MS);
        const amountOut = quotedAmountOut(view);
        expect(usdMicros("out"), "뒤집기 전 받는 토큰(DAI) 단가").not.toBe(
          micros(amountOut, DAI_PRICE_V0()),
        );
        await settlePendingWork();
        expect(allPriceCount(), "뒤집기 뒤 단가 요청 수").toBe(before);
        expect(gate.heldCount).toBe(0);
        gate.release();
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("체인·토큰·금액이 바뀌는 경우", () => {
    /**
     * @spec EC-12
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이며 두 칸 usd-value가 `success`로 표시됐다. 스텁은 카드 잔액 읽기(LINK `balanceOf`)에는 0보다 큰 LINK 잔액을, 모달 목록 잔액 일괄 읽기에는 LINK 잔액 0을 돌려준다. 그래서 LINK는 카드 잔액이 0보다 크면서 모달 일괄 조회 대상이 아니고, 이 앱에서 LINK 단가를 읽은 적이 없다. 스텁은 LINK의 단가 응답을 붙잡고, ETH·DAI와 다른 단가를 돌려준다. 표본 변경: 보내는 칸 모달에서 LINK를 고르고 금액을 `1`로 둠, 받는 칸 모달에서 LINK를 고르고 견적이 `success`가 되기를 기다림을 하나씩 반복한다
     * @when 표본 변경을 일으키고 LINK 단가 응답이 붙잡힌 동안 확인한 뒤 응답을 푼다
     * @then 붙잡힌 동안 바꾼 칸의 usd-value가 `loading`이고 data-usd-micros가 없으며 안에 usd-skeleton이 있다
     * @then 붙잡힌 동안 바꾼 칸에 data-usd-micros를 가진 balance-usd가 없다(받는 칸 표본은 data-usd-micros를 가진 quote-amount-out-usd·quote-amount-out-minimum-usd도 없다). 첫 조회 중 요소는 usd-skeleton과 함께 있어도 된다
     * @then 응답을 풀면 바꾼 칸의 usd-value data-usd-micros가 LINK 단가로 계산한 값이다(바꾸기 전 토큰의 단가로 계산한 값이 한 번도 나타나지 않는다)
     */
    it(
      "[EC-12] 캐시가 없는 토큰으로 바꾸면 이전 토큰 단가를 쓰지 않고 loading이다",
      async () => {
        const samples: Side[] = ["in", "out"];
        for (const [index, side] of samples.entries()) {
          const label = `${side} 칸에서 LINK를 고름`;
          if (index > 0) resetSample();
          const view = await renderEthDaiQuote();
          const linkPrice = expectedPrice(RULE_V0, mainnet.id, ETHEREUM_LINK);
          const previousPrice = side === "in" ? ETH_PRICE_V0() : DAI_PRICE_V0();
          // 전제: LINK 단가가 바꾸기 전 토큰의 단가와 다르다.
          expect(stubPricesEqual(linkPrice, previousPrice), label).toBe(false);
          // 전제: 이 앱에서 LINK 단가를 읽은 적이 없다.
          expect(priceCount(ETHEREUM_LINK), label).toBe(0);
          const gate = rpc.holdUsdPrice(
            match.chain(mainnet.id, matchUsdPrice.target(ETHEREUM_LINK)),
          );

          let seen = new Set<string>();
          await chooseToken(side, ETHEREUM_LINK, () => {
            seen = traceUsdMicros(side, side === "out");
          });
          // 전제: 모달 목록 잔액 읽기는 LINK 잔액 0을 받았다(위 chooseToken). 카드 잔액은 0보다 크다.
          await waitUntil(() => expect(cardBalanceRaw(side)).toBeGreaterThan(0n), WAIT_MS);
          if (side === "in" && amountInput().value !== "1") await typeAmount("1");
          if (side === "out") {
            await waitUntil(() => {
              expect(view.result.current.quote.status).toBe("success");
              expect(sameAddress(view.result.current.form.tokenOut?.address, ETHEREUM_LINK)).toBe(
                true,
              );
            }, WAIT_MS);
          }
          await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0), WAIT_MS);
          await settlePendingWork();

          // 붙잡힌 동안
          expect(usdState(side), label).toBe("loading");
          expect(usdValue(side).hasAttribute("data-usd-micros"), label).toBe(false);
          expect(within(usdValue(side)).queryByTestId("usd-skeleton"), label).not.toBeNull();
          expect(hasBalanceUsdWithMicros(side), label).toBe(false);
          if (side === "out") expect(hasQuoteUsdWithMicros(), label).toBe(false);

          gate.release();
          const amountRaw = side === "in" ? ONE : quotedAmountOut(view);
          await waitUntil(
            () => expect(usdMicros(side)).toBe(micros(amountRaw, linkPrice)),
            WAIT_MS,
          );
          await settlePendingWork();

          // 바꾸기 전 토큰 단가로 계산한 값: 바꾼 칸 금액·카드 잔액(받는 칸은 견적 행 금액도)에 이전 단가를 곱한 값
          const balance = cardBalanceRaw(side)!;
          const previousValues = [micros(amountRaw, previousPrice), micros(balance, previousPrice)];
          if (side === "out") {
            const minimum = view.result.current.minimum;
            expect(minimum, label).not.toBeNull();
            previousValues.push(micros(minimum!, previousPrice));
          }
          for (const value of previousValues) {
            expect(seen.has(value), `${label}: 이전 토큰 단가 값 ${value}`).toBe(false);
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-11
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 스텁은 Base 단가 요청의 응답을 붙잡고, 표본 토큰의 Base 단가로 Ethereum과 다른 값을 돌려준다. 표본 토큰: ETH(체인마다 WETH 주소가 다르다), 세 체인 목록에 같은 주소로 있는 ZRO(`0x6985884C4392D348587B19cb9eAAf157F13271cd`, Base 목록 잔액은 0이어서 Base 모달 일괄 조회로 미리 채워지지 않는다)를 하나씩 반복한다. 표본마다 Ethereum에서 보내는 칸을 표본 토큰으로 두고(ZRO는 보내는 칸 모달에서 고른다) 금액 `1`의 usd-value[data-side=in]이 Ethereum 단가로 `success`다
     * @when 선택 체인을 Base로 바꿔 입력이 기본값(보내는 ETH)으로 돌아간 뒤 보내는 칸을 표본 토큰으로 두고(ZRO는 보내는 칸 모달에서 고른다) 금액 `1`을 입력하고, Base 단가 응답이 붙잡힌 동안 확인한 뒤 응답을 푼다
     * @then 붙잡힌 동안 usd-value[data-side=in]이 `loading`이고 data-usd-micros가 없으며 안에 usd-skeleton이 있다
     * @then 응답을 풀면 usd-value[data-side=in]의 data-usd-micros가 표본 토큰의 Base 단가로 계산한 값이다(Ethereum 단가로 계산한 값이 Base에서 한 번도 나타나지 않는다)
     */
    it(
      "[EC-11] 체인이 바뀌면 이전 체인 단가를 쓰지 않고 새 체인 단가가 없으면 loading이다",
      async () => {
        const samples: { label: string; token: Address }[] = [
          { label: "ETH", token: ETH_ADDRESS },
          { label: "ZRO", token: ZRO },
        ];
        for (const [index, { label, token }] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setBalances(CARD_BALANCES);
          rpc.setUsdPriceRule(RULE_V0);
          const ethereumPrice = expectedPrice(RULE_V0, mainnet.id, token);
          const basePrice = expectedPrice(RULE_V0, base.id, token);
          // 전제: 표본 토큰의 Base 단가가 Ethereum 단가와 다르다.
          expect(stubPricesEqual(ethereumPrice, basePrice), label).toBe(false);

          const view = await renderConnectedApp();
          if (token !== ETH_ADDRESS) await chooseToken("in", token);
          await typeAmount("1");
          await waitUntil(() => expect(usdMicros("in")).toBe(micros(ONE, ethereumPrice)), WAIT_MS);
          expect(usdState("in"), label).toBe("success");
          await waitPriceRequestsSettled();

          const gate = rpc.holdUsdPrice(match.chain(base.id, matchUsdPrice.any));
          const seen = traceUsdMicros("in", false);
          act(() => view.result.current.selected.setSelectedChainId(base.id));
          await waitUntil(() => {
            expect(view.result.current.form.chainId).toBe(base.id);
            expect(sameAddress(view.result.current.form.tokenIn?.address, ETH_ADDRESS)).toBe(true);
            expect(amountInput().value).toBe("");
          }, WAIT_MS);
          // Base 목록 잔액은 0이다(chooseToken이 목록 잔액 읽기 동안 0을 돌려준다).
          if (token !== ETH_ADDRESS) await chooseToken("in", token);
          await typeAmount("1");
          const priceToken = token === ETH_ADDRESS ? STUB_WETH_BY_CHAIN[base.id] : token;
          await waitUntil(
            () => expect(priceCount(priceToken, base.id)).toBeGreaterThan(0),
            WAIT_MS,
          );
          await settlePendingWork();

          // 붙잡힌 동안
          expect(usdState("in"), label).toBe("loading");
          expect(usdValue("in").hasAttribute("data-usd-micros"), label).toBe(false);
          expect(within(usdValue("in")).queryByTestId("usd-skeleton"), label).not.toBeNull();

          gate.release();
          await waitUntil(() => expect(usdMicros("in")).toBe(micros(ONE, basePrice)), WAIT_MS);
          await settlePendingWork();
          expect(seen.has(micros(ONE, ethereumPrice)), `${label}: Base에서 Ethereum 단가 값`).toBe(
            false,
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-13
     * @given 입력 반영 대기 타이머(setTimeout)를 포함해 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이고 두 칸 usd-value가 `success`다. 단가 요청 수를 기록해 둔다
     * @when 금액을 `2`로 바꾸고 입력 반영 대기(300ms)가 지나기 전(가짜 시계를 진행하지 않은 시점)에 확인한 뒤, 가짜 시계를 진행해 입력 반영 대기가 지나 새 견적이 `success`가 되기를 기다린다
     * @then 입력 반영 대기(300ms)가 지나기 전에 usd-value[data-side=in]이 `success`이고 data-usd-micros가 `2`의 amountInRaw와 같은 ETH 단가로 계산한 값이다
     * @then 새 견적 `success` 뒤 usd-value[data-side=out]의 data-usd-micros가 새 amountOut과 같은 DAI 단가로 계산한 값이다
     * @then 바꾼 뒤 새 견적 `success`까지 단가 요청 수가 늘지 않는다
     */
    it(
      "[EC-13] 금액이 바뀌면 단가를 다시 읽지 않고 USD만 즉시 다시 계산한다",
      async () => {
        const view = await renderEthDaiQuote();
        const previousAmountOut = quotedAmountOut(view);
        const beforePrice = allPriceCount();
        const beforeQuote = rpc.requests(match.kind("quote")).length;
        // 입력 반영 대기 타이머(setTimeout)를 포함해 가짜로 둔다. 이후 시계는 직접 진행할 때만 움직인다.
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
        });

        fireEvent.change(amountInput(), { target: { value: "2" } });
        // 입력 반영 대기(300ms)가 지나기 전: 가짜 시계를 진행하지 않았다.
        expect(amountInput().value).toBe("2");
        expect(rpc.requests(match.kind("quote")).length, "반영 대기 전 견적 요청").toBe(
          beforeQuote,
        );
        expect(usdState("in")).toBe("success");
        expect(usdMicros("in")).toBe(micros(TWO, ETH_PRICE_V0()));

        await waitUntilAdvancingFakeClock(
          () => {
            expect(view.result.current.quote.status).toBe("success");
            expect(quotedAmountOut(view)).not.toBe(previousAmountOut);
          },
          50,
          WAIT_MS,
        );
        await waitUntilAdvancingFakeClock(
          () => expect(usdMicros("out")).toBe(micros(quotedAmountOut(view), DAI_PRICE_V0())),
          10,
          WAIT_MS,
        );
        expect(allPriceCount(), "금액 변경 뒤 단가 요청 수").toBe(beforePrice);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("단가 읽기가 실패한 경우", () => {
    /**
     * @spec EC-9 EC-23
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이고 두 칸 usd-value·balance-usd·quote-amount-out-usd·quote-amount-out-minimum-usd가 표시됐다. 그 뒤 스텁이 단가 요청을 실패로 응답하게 바꿨다. 표본 실패: transport 재시도 대상이 아닌 JSON-RPC 오류, 프록시 HTTP 429 응답. 표본 갱신 계기: 60초 주기, window `focus` 이벤트. 두 표본 목록의 조합을 하나씩 반복한다
     * @when 표본 계기로 단가를 다시 읽게 하고 실패 응답을 받기를 기다린다
     * @then 두 칸 usd-value가 `success`이고 data-usd-micros가 실패 전 값 그대로다
     * @then 두 칸 balance-usd와 quote-amount-out-usd·quote-amount-out-minimum-usd의 data-usd-micros가 실패 전 값 그대로다
     * @then usd-skeleton이 없다
     */
    it(
      "[EC-9][EC-23] 단가 갱신이 실패해도 이전 USD를 유지한다",
      async () => {
        const failures = ["json-rpc", "http-429"] as const;
        const triggers = ["period", "focus"] as const;
        const samples = failures.flatMap((failure) =>
          triggers.map((trigger) => ({ failure, trigger })),
        );
        for (const [index, { failure, trigger }] of samples.entries()) {
          const label = `${failure} × ${trigger}`;
          if (index > 0) resetSample();
          fakePeriodicTimers();
          await renderEthDaiQuote();
          const start = firstPriceRequestAt(ETHEREUM_WETH);
          const previous = currentDisplay();
          if (failure === "json-rpc") rpc.failUsdPriceWhen(matchUsdPrice.any);
          else rpc.respondUsdPriceHttp429When(matchUsdPrice.any);
          const seq = rpc.requests().length;

          if (trigger === "period") await advanceFakeTimeTo(start + PRICE_REFETCH_MS);
          else focusWindow();
          await waitUntil(() => {
            for (const token of [ETHEREUM_WETH, ETHEREUM_DAI]) {
              const requests = failedSince(seq, token);
              expect(requests.length, `${label} ${token}`).toBeGreaterThan(0);
              expect(requests.every((request) => request.status === "failed")).toBe(true);
            }
          }, WAIT_MS);
          await settlePendingWork();

          expect(usdState("in"), label).toBe("success");
          expect(usdState("out"), label).toBe("success");
          expect(currentDisplay(), label).toEqual(previous);
          expect(screen.queryAllByTestId("usd-skeleton"), label).toHaveLength(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-10 EC-23
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 USDC(단가 요청 없음)가 선택돼 있다. 표본 실패: transport 재시도 대상이 아닌 JSON-RPC 오류, 프록시 HTTP 429 응답. 표본 실패 시점: 금액 `1`을 입력해 ETH 단가 첫 조회가 실패함, ETH 단가 `success` 뒤 60초 주기 다시 읽기가 실패함. 두 표본 목록의 조합을 하나씩 반복한다
     * @when 첫 조회 실패 표본은 usd-value[data-side=in]이 `error`가 되기를 기다린다. 주기 갱신 실패 표본은 실패 응답을 받은 뒤 재시도 지연보다 긴 구간(재시도 지연 타이머도 가짜로 두고 진행하거나 그만큼 실제 시간을 기다림)을 지나고, 가짜 시계를 실패한 요청 시점부터 다음 60초 주기 직전까지 진행한다
     * @then 첫 조회 실패 표본에서 usd-value[data-side=in]이 `error`가 된 뒤 실패한 읽기의 ETH(WETH) 단가 요청이 1건이다
     * @then 주기 갱신 실패 표본에서 실패한 요청 1건 뒤 재시도 지연보다 긴 구간을 지나 다음 60초 주기 직전까지 ETH(WETH) 단가 요청이 0건이다
     */
    it(
      "[EC-10][EC-23] 단가 조회가 실패하면 재시도하지 않는다",
      async () => {
        const failures = ["json-rpc", "http-429"] as const;
        const timings = ["first-read", "period-refresh"] as const;
        const samples = failures.flatMap((failure) =>
          timings.map((timing) => ({ failure, timing })),
        );
        const fail = (failure: (typeof failures)[number]) => {
          if (failure === "json-rpc") rpc.failUsdPriceWhen(matchUsdPrice.any);
          else rpc.respondUsdPriceHttp429When(matchUsdPrice.any);
        };
        for (const [index, { failure, timing }] of samples.entries()) {
          const label = `${failure} × ${timing}`;
          if (index > 0) resetSample();
          fakePeriodicTimers();
          rpc.setBalances(CARD_BALANCES);
          rpc.setUsdPriceRule(RULE_V0);
          if (timing === "first-read") fail(failure);

          await renderConnectedApp();
          await chooseToken("out", ETHEREUM_USDC);
          await typeAmount("1");

          if (timing === "first-read") {
            await waitUntil(() => expect(usdState("in")).toBe("error"), WAIT_MS);
            await settlePendingWork();
            expect(priceCount(ETHEREUM_WETH), `${label}: error 뒤 ETH 단가 요청`).toBe(1);
            continue;
          }

          await waitUntil(() => expect(usdMicros("in")).toBe(micros(ONE, ETH_PRICE_V0())), WAIT_MS);
          await waitPriceRequestsSettled();
          const start = firstPriceRequestAt(ETHEREUM_WETH);
          const before = priceCount(ETHEREUM_WETH);
          fail(failure);
          await advanceFakeTimeTo(start + PRICE_REFETCH_MS);
          await waitUntil(() => {
            const failed = priceRequests(ETHEREUM_WETH).slice(before);
            expect(failed.length).toBeGreaterThan(0);
            expect(failed.every((request) => request.status === "failed")).toBe(true);
          }, WAIT_MS);
          const failedAt = priceRequests(ETHEREUM_WETH)[before].at;
          // 재시도 지연보다 긴 구간(실제 시간)
          await yieldToPendingWork(RETRY_OBSERVATION_MS);
          await settlePendingWork();
          expect(priceCount(ETHEREUM_WETH), `${label}: 재시도 관찰 구간 뒤`).toBe(before + 1);
          await advanceFakeTimeTo(failedAt + PRICE_REFETCH_MS - 1);
          await settlePendingWork();
          expect(priceCount(ETHEREUM_WETH), `${label}: 다음 주기 직전`).toBe(before + 1);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-23
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH가 선택돼 있으며 보내는 칸 카드 잔액이 0보다 크고(`data-balance-raw` 있음) 이 앱에서 ETH 단가를 읽은 적이 없다. 스텁은 단가 요청에 프록시 HTTP 429를 돌려준다
     * @when 금액 `1`을 입력하고 단가 조회 실패를 기다린다
     * @then usd-value[data-side=in]이 `error`이고 data-usd-micros가 없다
     * @then usd-value[data-side=in] 안에 접근성 이름 `USD 가격 없음`인 요소가 있다
     * @then 보내는 칸 balance-usd가 없다
     */
    it(
      "[EC-23] 첫 단가 조회가 429로 실패하면 다른 실패와 같이 error다",
      async () => {
        rpc.setBalances(CARD_BALANCES);
        rpc.setUsdPriceRule(RULE_V0);
        rpc.respondUsdPriceHttp429When(matchUsdPrice.any);
        await renderConnectedApp();
        // 전제: 보내는 칸 카드 잔액이 0보다 크다.
        await waitUntil(() => expect(cardBalanceRaw("in")).toBeGreaterThan(0n), WAIT_MS);
        await typeAmount("1");
        await waitUntil(() => expect(usdState("in")).toBe("error"), WAIT_MS);
        await settlePendingWork();
        // 전제: 단가 요청이 429로 실패했다.
        expect(priceRequests(ETHEREUM_WETH).every((request) => request.status === "failed")).toBe(
          true,
        );

        expect(usdValue("in").hasAttribute("data-usd-micros")).toBe(false);
        expect(within(usdValue("in")).getByRole("img", { name: "USD 가격 없음" })).toBeTruthy();
        expect(within(field("in")).queryByTestId("balance-usd")).toBeNull();
      },
      CASE_TIMEOUT_MS,
    );
  });
});
