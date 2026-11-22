import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type WagmiConfig, createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
// EC-19의 묶음 크기 C만 제품 export 상수를 읽는다(사용자 결정 2026-11-22). 그 밖의 기대값은 리터럴과 테스트 쪽 계산이다.
import { TOKEN_USD_PRICE_BATCH_SIZE } from "@/lib/read-token-usd-price";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceFn,
  type BalanceRpcRequest,
  type BalanceRpcStub,
  type QuoteRule,
  type RequestMatcher,
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
  stubMultiplyPrices,
  stubPairPrice,
  stubPricesEqual,
  stubRevertQuote,
  stubUsdMicros,
  usdPriceTargets,
} from "../support/rpc-balance-stub";
import {
  advanceFakeTimeTo,
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  waitUntil,
  yieldToPendingWork,
} from "../support/wagmi-harness";

// 골격(T-11). 토큰 모달의 단가 일괄 조회(대상 선정, USDC 직접 → WETH 경유 2단계, 묶음 나누기, 묶음 실패,
// 열린 동안 재요청 없음, 다시 열기), 모달 행 USD 표시, 모달↔카드 캐시 공유를 앱 화면과 요청 디코드로 확인한다.
// 카드↔견적 행 방향 캐시 공유(DoD-29 일부)와 카드 단가의 주기·포커스 갱신은 usd-price-refresh.test.tsx가 맡는다.
// mock 경계(사용자 확정 2026-11-22): F3·F7 통합 경계(실제 wagmi·Provider·화면, wagmi mock 커넥터,
// 전역 fetch의 URL 라우팅 스텁, `vi.mock` 금지)에 T-8의 단가 aggregate3 스텁 분류·응답·실패·붙잡기와 가짜 타이머를 더한 것.
// 그 밖의 provider·훅·컴포넌트는 실제 코드를 쓴다.
// 증명하지 못하는 것: 실제 eth_call 가스 상한(EC-19의 가스 적합성은 계획 T-1 (1) 실측 기록에 의존한다).
// 데이터 격리: 테스트(표본)마다 config·RPC 스텁·QueryClient를 새로 만들고 쿠키를 지운다(clearCookies). 가짜 타이머는 테스트마다 원복한다.
// 이 파일에서 "단가 요청 1건"은 선택 체인으로 가는 단가 aggregate3(첫 하위 호출이 QuoterV2 `quoteExactInputSingle`인
// Multicall3 `eth_call`, 계획 §1) JSON-RPC 항목 1건이다. 요청을 디코드하면 (대상 토큰, 기준 토큰) 쌍 목록이 나온다.
// "모달 일괄 요청"은 대상 토큰에 카드 두 칸 토큰(ETH는 같은 체인 WETH로 본다)이 아닌 행 토큰을 함께 담은 단가 요청이다.
// 요청의 대상 토큰을 모을 때 (WETH, USDC) 구간 쌍은 뺀다. 카드 단가 갱신이 행 표시를 바꾸지 않도록 DoD-32 case 밖에서는
// 가짜 시계를 60초 진행하지 않고 window `focus` 이벤트를 내지 않는다. 재시도 없음 판정(EC-20)의 관찰 구간은 재시도 지연
// (TanStack 기본 1·2·4초, viem HTTP 재시도 150·300·600ms)보다 길어야 한다.
// 스텁은 토큰마다 다른 단가를 돌려줘 어느 단가로 계산했는지 data-usd-micros로 구분한다. 행 잔액은 그 행의 data-balance-raw다.
// 기대 micros는 테스트 쪽에서 `잔액 raw × 스텁 단가 분자 / 분모`를 버림해 계산한다. 기대 주소는 제품 config를 쓰지 않고 리터럴로 적는다.
// 묶음 크기는 계획 T-1이 정하는 제품 export 상수 C다(EC-19 판정 방식 사용자 확정 2026-11-22). 이 파일은 그 값을 숫자로 적지 않고
// 상수와의 상대 관계로 표본을 만들며, 본문은 제품 export 상수를 읽는다. 요청당 대상 토큰 수에 (WETH, USDC) 구간 쌍은 세지 않는다.
// 잔액 표본에는 ETH·WETH·체인 네이티브 USDC를 넣지 않는다(ETH→WETH 단가는 DoD-4, USDC 무요청은 DoD-3로 단가 조회 테스트가 판정한다).
// 예외는 세 토큰의 모달 행 USD를 보는 [DoD-20] ETH·WETH·USDC case 하나다.

const CASE_TIMEOUT_MS = 90_000;
const MULTI_SAMPLE_TIMEOUT_MS = 240_000;
// 응답·화면 반영을 기다리는 실제 시간 상한(모달 목록 484행 렌더 포함)
const WAIT_MS = 30_000;

// 스펙 값: 카드 단가 주기 60초(DoD-26). DoD-32에서 카드 주기가 지나도 모달 일괄 요청이 없음을 본다.
const PRICE_REFETCH_MS = 60_000;
// 재시도 관찰 구간(실제 시간). TanStack 기본 재시도의 첫 지연(1초)과 viem HTTP 재시도 지연의 합(150 + 300 + 600ms)보다 길다.
const RETRY_OBSERVATION_MS = 2_000;

// 묶음 크기 C(제품 export 상수)
const C = TOKEN_USD_PRICE_BATCH_SIZE;

let rpc: BalanceRpcStub;
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
const WETH: Address = STUB_WETH_BY_CHAIN[mainnet.id];
const USDC: Address = STUB_USDC_BY_CHAIN[mainnet.id];
// Ethereum 토큰 목록의 토큰(목록 스냅샷에서 확인한 주소 리터럴, 모두 18자리)
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const LINK: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const UNI: Address = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const AAVE: Address = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";
const MKR: Address = "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2";
// WETH 경유 표본(W)과 경로 없음 표본(N). 경로는 스텁 규칙으로 만든다.
const KNC: Address = "0xdd974D5C2e2928deA5F71b9825b8b646686BD200";
const SOLV: Address = "0x169E36F327cAA83d004f5c2668AC25A1424C940d";
// 잔액 0 표본과 잔액을 돌려주지 않는 표본
const WBTC: Address = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const API3: Address = "0x0b38210ea11411557c13457D4dA7dC6ea731B88a";

const ONE = 10n ** 18n;

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

function inList(list: readonly Address[], token: Address): boolean {
  return list.some((candidate) => sameAddress(candidate, token));
}

type PriceRuleOptions = {
  version?: bigint;
  // USDC 직접 경로가 없는(네 티어 모두 revert) 토큰. WETH 경로는 있다.
  noDirect?: readonly Address[];
  // USDC 직접·WETH 경로가 모두 없는 토큰
  noRoute?: readonly Address[];
};

// 단가 규칙. 따로 정하지 않은 쌍은 네 티어 모두 성공하고 체인·토큰마다 단가가 다르다.
function priceRule({
  version = 0n,
  noDirect = [],
  noRoute = [],
}: PriceRuleOptions = {}): QuoteRule {
  return {
    quote: (query) => {
      const toUsdc = sameAddress(query.tokenOut, STUB_USDC_BY_CHAIN[query.chainId]);
      const toWeth = sameAddress(query.tokenOut, STUB_WETH_BY_CHAIN[query.chainId]);
      if (toUsdc && (inList(noDirect, query.tokenIn) || inList(noRoute, query.tokenIn))) {
        return stubRevertQuote();
      }
      if (toWeth && inList(noRoute, query.tokenIn)) return stubRevertQuote();
      return {
        status: "ok",
        amountOut: TIER_AMOUNT_OUT[query.fee],
        sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
      };
    },
    slot0: (query) => ({ status: "ok", sqrtPriceX96: poolSqrtPriceX96(query, version) }),
  };
}

const RULE_V0 = priceRule();
const RULE_V1 = priceRule({ version: 1n });

// 규칙이 낼 단가(테스트 쪽 계산). 위 규칙의 티어 선택은 금액과 무관하므로 decimals는 결과에 영향이 없다.
function expectedPrice(rule: QuoteRule, token: Address): StubPrice {
  const expected = expectedStubUsdPrice(rule, { chainId: mainnet.id, token, decimals: 18 });
  if (expected.status !== "success") throw new Error(`기대 단가가 없다: ${token}`);
  return expected.price;
}

function micros(amountRaw: bigint, price: StubPrice): string {
  return stubUsdMicros(amountRaw, price).toString();
}

// ─── 잔액(테스트 쪽) ────────────────────────────────────────────────

// 토큰마다 다른 양의 잔액
function sampleBalance(index: number): bigint {
  return BigInt(index + 2) * 10n ** 19n + BigInt(index) * 7_777n + 1n;
}

// 지정한 토큰만 그 잔액이고 나머지는 0인 잔액 규칙
function balancesOnly(entries: Readonly<Record<string, bigint>>): BalanceFn {
  return balancesWith(entries, () => 0n);
}

function balancesFor(tokens: readonly Address[], offset = 0): Record<string, bigint> {
  return Object.fromEntries(tokens.map((token, index) => [token, sampleBalance(index + offset)]));
}

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

function cardBalanceRaw(side: Side): bigint | null {
  const raw = within(field(side)).queryByTestId("balance")?.getAttribute("data-balance-raw");
  return raw === undefined || raw === null ? null : BigInt(raw);
}

function balanceUsdMicros(side: Side): string | null {
  return within(field(side)).queryByTestId("balance-usd")?.getAttribute("data-usd-micros") ?? null;
}

function quoteUsdMicros(
  testId: "quote-amount-out-usd" | "quote-amount-out-minimum-usd",
): string | null {
  return screen.queryByTestId(testId)?.getAttribute("data-usd-micros") ?? null;
}

function tokenModal(): HTMLElement | null {
  return screen.queryByTestId("token-modal");
}

function modalRows(): HTMLElement[] {
  const modal = tokenModal();
  return modal ? within(modal).queryAllByTestId("token-option") : [];
}

function rowAddress(row: HTMLElement): Address {
  return row.getAttribute("data-token-address") as Address;
}

function optionRow(address: Address): HTMLElement {
  const row = modalRows().find((element) => sameAddress(rowAddress(element), address));
  if (!row) throw new Error(`token-option ${address}가 없다`);
  return row;
}

function rowBalance(address: Address): bigint | null {
  const raw = optionRow(address).getAttribute("data-balance-raw");
  return raw === null ? null : BigInt(raw);
}

function rowUsdMicros(address: Address): string | null {
  return (
    within(optionRow(address)).queryByTestId("token-option-usd")?.getAttribute("data-usd-micros") ??
    null
  );
}

function rowHasUsd(address: Address): boolean {
  return within(optionRow(address)).queryByTestId("token-option-usd") !== null;
}

function rowHasSkeleton(address: Address): boolean {
  return within(optionRow(address)).queryByTestId("usd-skeleton") !== null;
}

// 행 잔액과 단가로 테스트가 계산한 행 USD micros
function expectedRowMicros(address: Address, price: StubPrice): string {
  const balance = rowBalance(address);
  if (balance === null) throw new Error(`${address} 행에 잔액이 없다`);
  return micros(balance, price);
}

async function openModal(side: Side) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side), WAIT_MS);
}

// 모달 목록 잔액이 행에 반영될 때까지 기다린다.
async function waitRowBalances(addresses: readonly Address[]) {
  await waitUntil(() => {
    for (const address of addresses) expect(rowBalance(address), address).not.toBeNull();
  }, WAIT_MS);
}

// 현재 토큰(보내는 칸 ETH) 행을 눌러 토큰을 바꾸지 않고 모달을 닫는다.
async function closeModalKeepingToken() {
  fireEvent.click(optionRow(ETH_ADDRESS));
  await waitUntil(() => expect(tokenModal()).toBeNull(), WAIT_MS);
}

async function chooseToken(side: Side, address: Address) {
  await openModal(side);
  await waitRowBalances([address]);
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull(), WAIT_MS);
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
  return { form: useSwapForm(), quote: useSwapQuote(), minimum: useAmountOutMinimum() };
}

type ProbeView = { result: { current: ReturnType<typeof useProbe> } };

function appConfig(): WagmiConfig {
  return createWagmiConfig({
    connectors: [mockConnector({ defaultConnected: true, reconnect: true })],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱(보내는 ETH, 받는 칸 미선택). 카드 ETH 단가 읽기가 끝날 때까지 기다린다.
async function renderConnectedApp() {
  const view = renderAppHook(useProbe, {
    config: appConfig(),
    initialChainId: mainnet.id,
    onCommit: () => onCommitHook?.(),
  });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()), WAIT_MS);
  await waitCardPriceRead(WETH);
  return view;
}

// 카드 칸 토큰 단가 읽기가 끝났다: 그 토큰의 단가 요청이 있고 모두 응답을 받았다.
async function waitCardPriceRead(token: Address) {
  await waitUntil(() => {
    const requests = rpc.requests(matchUsdPrice.target(token));
    expect(requests.length, `${token} 카드 단가 요청`).toBeGreaterThan(0);
    expect(requests.every((request) => request.status !== "pending")).toBe(true);
  }, WAIT_MS);
  await settlePendingWork();
}

// ─── 요청 기록 ──────────────────────────────────────────────────────

function both(...matchers: RequestMatcher[]): RequestMatcher {
  return (request) => matchers.every((matcher) => matcher(request));
}

function lower(address: Address): string {
  return address.toLowerCase();
}

function lowerSet(addresses: Iterable<Address>): Set<string> {
  return new Set([...addresses].map(lower));
}

// 모달 일괄 요청: 대상 토큰((WETH, USDC) 구간 쌍을 뺀 `usdPriceTargets`)에 카드 두 칸 토큰(ETH는 WETH)이 아닌
// 행 토큰을 함께 담은 단가 요청. `sinceSeq` 이후에 받은 요청만 본다.
function modalBatchRequests(cardTokens: readonly Address[], sinceSeq = 0): BalanceRpcRequest[] {
  return rpc
    .requests(match.since(sinceSeq, matchUsdPrice.any))
    .filter((request) => usdPriceTargets(request).some((target) => !inList(cardTokens, target)));
}

function targetsOf(requests: readonly BalanceRpcRequest[]): Set<string> {
  return lowerSet(requests.flatMap((request) => usdPriceTargets(request)));
}

function stageOf(requests: readonly BalanceRpcRequest[], stage: "direct" | "routed") {
  return requests.filter(matchUsdPrice.stage(stage));
}

// 모달 목록 잔액 읽기 요청(`eth_getBalance`, 잔액 aggregate3 `eth_call`)
const LIST_BALANCE_READ: RequestMatcher = match.kind("eth_getBalance", "aggregate3");

// 모달 목록 잔액 읽기를 붙잡은 채 모달을 연다. 돌려주는 값으로 붙잡은 읽기를 푼다.
async function openModalHoldingBalances(side: Side) {
  const gate = rpc.hold(both(match.since(rpc.requests().length), LIST_BALANCE_READ));
  await openModal(side);
  await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0), WAIT_MS);
  await settlePendingWork();
  return gate;
}

// 붙잡은 목록 잔액 읽기 동안 모달 행 주소(화면 순서)에서 고른 표본 후보. ETH·WETH·USDC와 `exclude`는 뺀다.
function rowPool(exclude: readonly Address[] = []): Address[] {
  return modalRows()
    .map(rowAddress)
    .filter((address) => !inList([ETH_ADDRESS, WETH, USDC, ...exclude], address));
}

// 행 표시를 기록한다(usd-skeleton이 나타났는지 판정용).
function traceSkeletonIn(side: Side): { seen: boolean } {
  const trace = { seen: false };
  onCommitHook = () => {
    const sideField = screen
      .queryAllByTestId("token-field")
      .find((element) => element.getAttribute("data-side") === side);
    if (sideField?.querySelector('[data-testid="usd-skeleton"]')) trace.seen = true;
  };
  return trace;
}

function quotedAmountOut(view: ProbeView): bigint {
  const { quote } = view.result.current;
  if (quote.status !== "success" || !quote.quote) throw new Error("견적이 success가 아니다");
  return quote.quote.amountOut;
}

describe("토큰 모달 — 잔액이 있는 토큰 행에 USD가 함께 보인다", () => {
  describe("모달을 열어 잔액이 있는 토큰의 단가를 읽는 경우", () => {
    /**
     * @spec DoD-30 DoD-20
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났다. 스텁의 목록 잔액은 USDC 직접 경로가 있는 토큰 여럿이 0보다 크고, 다른 토큰 여럿이 0이며, 토큰 하나는 잔액을 돌려주지 않는다(행 잔액 `—`). 잔액 0보다 큰 토큰 수는 묶음 크기 상수 이하다. 스텁은 모달 잔액 일괄 읽기 응답을 붙잡는다
     * @when 보내는 칸 token-button으로 모달을 열고, 잔액 응답이 붙잡힌 동안 확인한 뒤 응답을 풀고 모달 일괄 요청의 응답을 기다린다
     * @then 잔액 응답이 붙잡힌 동안 모달 일괄 요청이 0건이다
     * @then 잔액 응답을 푼 뒤 모달 일괄 요청을 디코드한 대상 토큰 집합이 잔액이 0보다 큰 토큰 집합과 같다
     * @then 잔액이 0인 토큰과 잔액을 돌려주지 않은 토큰은 어느 모달 일괄 요청에도 없다
     * @then 잔액이 0보다 큰 토큰 행마다 token-option-usd가 있고 data-usd-micros가 그 행 data-balance-raw와 그 토큰 스텁 단가로 계산한 값이다
     * @then 잔액이 0인 행과 잔액을 돌려주지 않은 행에는 token-option-usd가 없다
     */
    it(
      "[DoD-30][DoD-20] 잔액 읽기가 끝난 뒤 잔액이 있는 토큰의 단가만 일괄 조회해 행에 USD를 보인다",
      async () => {
        const priced = [DAI, LINK, UNI, AAVE, MKR];
        const zero = [WBTC, USDT];
        const unreturned = API3;
        // 전제: 잔액이 0보다 큰 토큰 수가 묶음 크기 상수 이하다.
        expect(priced.length).toBeLessThanOrEqual(C);
        rpc.setBalances(
          balancesOnly({
            ...balancesFor(priced),
            [WBTC]: 0n,
            [USDT]: 0n,
            [API3]: sampleBalance(9),
          }),
        );
        rpc.failTokenWhen((query) => sameAddress(query.token, unreturned));
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        const cardTokens = [WETH];
        const seq = rpc.requests().length;

        const gate = await openModalHoldingBalances("in");
        expect(modalBatchRequests(cardTokens, seq), "잔액 응답이 붙잡힌 동안").toHaveLength(0);
        gate.release();

        await waitUntil(() => {
          for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
        }, WAIT_MS);
        await settlePendingWork();

        const requests = modalBatchRequests(cardTokens, seq);
        expect(targetsOf(requests)).toEqual(lowerSet(priced));
        for (const token of [...zero, unreturned]) {
          for (const request of rpc.requests(match.since(seq, matchUsdPrice.any))) {
            const tokensInRequest = request.usdPrice!.pairs.map((pair) => pair.tokenIn);
            expect(inList(tokensInRequest, token), `${token}가 일괄 요청에 없다`).toBe(false);
          }
        }
        for (const token of priced) {
          expect(rowUsdMicros(token), token).toBe(
            expectedRowMicros(token, expectedPrice(RULE_V0, token)),
          );
        }
        // 전제: 잔액 0 행과 잔액을 돌려주지 않은 행
        for (const token of zero) expect(rowBalance(token), token).toBe(0n);
        expect(rowBalance(unreturned), "잔액 미반환 행").toBeNull();
        for (const token of [...zero, unreturned]) expect(rowHasUsd(token), token).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-20
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났다. 스텁의 목록 잔액은 ETH·WETH·Ethereum 네이티브 USDC와 USDC 직접 경로가 있는 다른 토큰 여럿이 0보다 크다
     * @when 보내는 칸 token-button으로 모달을 열고 모달 일괄 요청의 응답을 기다린다
     * @then ETH 행 token-option-usd의 data-usd-micros가 ETH 행 잔액과 스텁 WETH 단가로 계산한 값이다
     * @then WETH 행 token-option-usd의 data-usd-micros가 WETH 행 잔액과 ETH 행과 같은 스텁 WETH 단가로 계산한 값이다
     * @then USDC 행 token-option-usd의 data-usd-micros가 USDC 행 잔액 raw와 같다($1 단가)
     * @then 어느 모달 일괄 요청에도 tokenIn이 USDC인 하위 호출이 없다
     */
    it(
      "[DoD-20] ETH·WETH·USDC 행도 잔액과 단가로 USD를 보인다",
      async () => {
        const priced = [ETH_ADDRESS, WETH, USDC, DAI, LINK];
        rpc.setBalances(balancesOnly(balancesFor(priced)));
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        const seq = rpc.requests().length;

        await openModal("in");
        await waitUntil(() => {
          for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
        }, WAIT_MS);
        await settlePendingWork();

        const wethPrice = expectedPrice(RULE_V0, WETH);
        const ethBalance = rowBalance(ETH_ADDRESS)!;
        const wethBalance = rowBalance(WETH)!;
        const usdcBalance = rowBalance(USDC)!;
        // 전제: ETH와 WETH 행 잔액이 다르다.
        expect(ethBalance).not.toBe(wethBalance);
        expect(rowUsdMicros(ETH_ADDRESS), "ETH 행").toBe(micros(ethBalance, wethPrice));
        expect(rowUsdMicros(WETH), "WETH 행").toBe(micros(wethBalance, wethPrice));
        expect(rowUsdMicros(USDC), "USDC 행").toBe(usdcBalance.toString());
        for (const request of rpc.requests(match.since(seq, matchUsdPrice.any))) {
          for (const pair of request.usdPrice!.pairs) {
            for (const call of pair.quotes) {
              expect(sameAddress(call.tokenIn, USDC), "tokenIn이 USDC인 하위 호출").toBe(false);
            }
          }
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-31 EC-7
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났다. 스텁의 목록 잔액이 0보다 큰 토큰은 USDC 직접 경로가 있는 토큰 여럿, USDC 직접 경로가 없고 WETH 경로가 있는 토큰 W, USDC 직접·WETH 경로가 모두 없는 토큰 N이며 그 수는 묶음 크기 상수 이하다. 표본 목록: 이 구성, W·N을 뺀 구성(모든 대상에 USDC 직접 경로가 있음)을 하나씩 반복한다
     * @when 보내는 칸 token-button으로 모달을 열고 모달 일괄 요청의 응답을 모두 기다린다
     * @then 1차 모달 일괄 요청의 쌍이 잔액이 0보다 큰 토큰마다 (그 토큰, Ethereum 네이티브 USDC)다
     * @then 2차 모달 일괄 요청은 1차 응답 뒤에 나가고, 쌍이 USDC 직접 경로가 없는 토큰(W·N)의 (그 토큰, WETH)와 (WETH, USDC)뿐이다(직접 경로가 있는 토큰의 쌍이 없다)
     * @then USDC 직접 경로가 없는 토큰이 없는 표본에서는 2차 모달 일괄 요청이 0건이다
     * @then W·N이 있는 표본에서 W 행 token-option-usd의 data-usd-micros가 W 행 잔액과 (W→WETH 스텁 현물가 × WETH→USDC 스텁 현물가)로 계산한 값이다
     * @then W·N이 있는 표본에서 N 행에는 token-option-usd와 usd-skeleton이 없다
     */
    it(
      "[DoD-31][EC-7] USDC 직접 경로 조회 뒤 직접 경로가 없는 토큰만 WETH 경유로 한 번 더 조회한다",
      async () => {
        const direct = [DAI, LINK, UNI];
        const samples = [
          { label: "W·N 있음", routed: [KNC], noRoute: [SOLV] },
          { label: "모두 직접 경로", routed: [] as Address[], noRoute: [] as Address[] },
        ];
        for (const [index, { label, routed, noRoute }] of samples.entries()) {
          if (index > 0) resetSample();
          const priced = [...direct, ...routed, ...noRoute];
          expect(priced.length, label).toBeLessThanOrEqual(C);
          const rule = priceRule({ noDirect: routed, noRoute });
          rpc.setBalances(balancesOnly(balancesFor(priced)));
          rpc.setUsdPriceRule(rule);
          await renderConnectedApp();
          const cardTokens = [WETH];
          const seq = rpc.requests().length;

          // 1차 요청의 응답을 붙잡아 그 동안 2차 요청이 없는지 본다.
          const directGate = rpc.holdUsdPrice(
            both(match.since(seq), matchUsdPrice.stage("direct")),
          );
          await openModal("in");
          await waitUntil(() => expect(directGate.heldCount).toBeGreaterThan(0), WAIT_MS);
          await settlePendingWork();
          expect(
            stageOf(modalBatchRequests(cardTokens, seq), "routed"),
            `${label}: 1차 응답 전`,
          ).toHaveLength(0);
          directGate.release();

          await waitUntil(() => {
            for (const token of [...direct, ...routed])
              expect(rowUsdMicros(token), token).not.toBeNull();
            const requests = modalBatchRequests(cardTokens, seq);
            expect(requests.every((request) => request.status !== "pending")).toBe(true);
            if (routed.length + noRoute.length > 0) {
              expect(stageOf(requests, "routed").length).toBeGreaterThan(0);
            }
          }, WAIT_MS);
          await settlePendingWork();

          const requests = modalBatchRequests(cardTokens, seq);
          const directRequests = stageOf(requests, "direct");
          const directPairs = directRequests.flatMap((request) => request.usdPrice!.pairs);
          for (const pair of directPairs) {
            expect(sameAddress(pair.tokenOut, USDC), `${label}: 1차 쌍 기준 토큰`).toBe(true);
          }
          expect(lowerSet(directPairs.map((pair) => pair.tokenIn)), `${label}: 1차 대상`).toEqual(
            lowerSet(priced),
          );

          const routedRequests = stageOf(requests, "routed");
          if (routed.length + noRoute.length === 0) {
            expect(routedRequests, `${label}: 2차 요청`).toHaveLength(0);
            continue;
          }
          const routedPairs = new Set(
            routedRequests.flatMap((request) =>
              request.usdPrice!.pairs.map(
                (pair) => `${lower(pair.tokenIn)}→${lower(pair.tokenOut)}`,
              ),
            ),
          );
          expect(routedPairs, `${label}: 2차 쌍`).toEqual(
            new Set([
              ...[...routed, ...noRoute].map((token) => `${lower(token)}→${lower(WETH)}`),
              `${lower(WETH)}→${lower(USDC)}`,
            ]),
          );

          const toWeth = stubPairPrice(rule, {
            chainId: mainnet.id,
            token: KNC,
            quoteToken: WETH,
            amountIn: ONE,
          });
          const wethToUsdc = stubPairPrice(rule, {
            chainId: mainnet.id,
            token: WETH,
            quoteToken: USDC,
            amountIn: ONE,
          });
          if (toWeth.status !== "ok" || wethToUsdc.status !== "ok")
            throw new Error("경유 구간 기대 단가");
          expect(rowUsdMicros(KNC), `${label}: W 행`).toBe(
            expectedRowMicros(KNC, stubMultiplyPrices(toWeth.price, wethToUsdc.price)),
          );
          expect(rowHasUsd(SOLV), `${label}: N 행 USD`).toBe(false);
          expect(rowHasSkeleton(SOLV), `${label}: N 행 스켈레톤`).toBe(false);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-8
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났고 이 앱에서 모달 행 토큰의 단가를 읽은 적이 없다. 스텁의 목록 잔액은 USDC 직접 경로가 있는 토큰 여럿이 0보다 크고, 스텁은 모달 일괄 요청의 응답을 붙잡는다
     * @when 보내는 칸 token-button으로 모달을 열고 행 잔액이 표시된 뒤, 단가 응답이 붙잡힌 동안 확인하고 응답을 푼다
     * @then 붙잡힌 동안 잔액이 0보다 큰 행마다 USD 자리에 usd-skeleton이 있고 data-usd-micros를 가진 token-option-usd가 없다
     * @then 응답을 풀면 그 행들의 usd-skeleton이 사라지고 token-option-usd의 data-usd-micros가 그 행 잔액과 스텁 단가로 계산한 값이다
     */
    it(
      "[EC-8] 단가 첫 조회 중 모달 행 USD 자리에 스켈레톤을 보인다",
      async () => {
        const priced = [DAI, LINK, UNI];
        rpc.setBalances(balancesOnly(balancesFor(priced)));
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        const seq = rpc.requests().length;
        // 전제: 이 앱에서 행 토큰의 단가를 읽은 적이 없다.
        for (const token of priced)
          expect(rpc.requests(matchUsdPrice.target(token)), token).toHaveLength(0);

        const gate = rpc.holdUsdPrice(match.since(seq, matchUsdPrice.any));
        await openModal("in");
        await waitRowBalances(priced);
        await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0), WAIT_MS);
        await settlePendingWork();
        for (const token of priced) {
          expect(rowHasSkeleton(token), `${token} 붙잡힌 동안 스켈레톤`).toBe(true);
          expect(rowUsdMicros(token), `${token} 붙잡힌 동안 USD`).toBeNull();
        }

        gate.release();
        await waitUntil(() => {
          for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
        }, WAIT_MS);
        for (const token of priced) {
          expect(rowHasSkeleton(token), `${token} 응답 뒤 스켈레톤`).toBe(false);
          expect(rowUsdMicros(token), token).toBe(
            expectedRowMicros(token, expectedPrice(RULE_V0, token)),
          );
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("잔액이 있는 토큰이 많은 경우", () => {
    /**
     * @spec EC-19
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났다. 본문은 먼저 잔액이 0보다 큰 토큰 수를 묶음 크기 상수의 2배보다 많게 만들 수 있는지(2 × 묶음 크기 상수 + 1 ≤ 선택 체인 목록 토큰 수) 확인하고, 아니면 테스트가 실패한다. 스텁의 목록 잔액이 0보다 큰 토큰 수가 묶음 크기 상수의 2배보다 많고 그 배수가 아니며, 그중 USDC 직접 경로가 없고 WETH 경로가 있는 토큰 수도 묶음 크기 상수보다 많다
     * @when 보내는 칸 token-button으로 모달을 열고 모달 일괄 요청의 응답을 모두 기다린다
     * @then 1차 모달 일괄 요청마다 대상 토큰 수가 묶음 크기 상수 이하이고, 1차 요청들의 대상 토큰을 합친 집합이 잔액이 0보다 큰 토큰 집합과 같다
     * @then 2차 모달 일괄 요청마다 (토큰, WETH) 쌍의 대상 토큰 수가 묶음 크기 상수 이하이고((WETH, USDC) 구간 쌍은 세지 않는다), 2차 요청들의 대상 토큰을 합친 집합이 USDC 직접 경로가 없는 토큰 집합과 같다
     * @then 잔액이 0보다 큰 모든 행에 token-option-usd가 있다
     */
    it(
      "[EC-19] 잔액이 있는 토큰이 많으면 묶음 크기 상수 이하로 나눠 일괄 조회한다",
      async () => {
        rpc.setBalances(() => 0n);
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        const cardTokens = [WETH];
        const seq = rpc.requests().length;

        const gate = await openModalHoldingBalances("in");
        // 전제: 잔액이 0보다 큰 토큰 수를 묶음 크기 상수의 2배보다 많게 만들 수 있다(2C + 1 ≤ 선택 체인 목록 토큰 수).
        const count = 2 * C + 1;
        expect(modalRows().length, "선택 체인 목록 토큰 수").toBeGreaterThanOrEqual(count);
        const pool = rowPool();
        expect(pool.length, "ETH·WETH·USDC를 뺀 표본 후보 수").toBeGreaterThanOrEqual(count);
        const priced = pool.slice(0, count);
        expect(priced.length % C, "묶음 크기 상수의 배수가 아니다").not.toBe(0);
        const routed = priced.slice(0, C + 1);
        expect(routed.length).toBeGreaterThan(C);
        rpc.setUsdPriceRule(priceRule({ noDirect: routed }));
        rpc.setBalances(balancesOnly(balancesFor(priced)));
        gate.release();

        await waitUntil(() => {
          for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
        }, WAIT_MS);
        await settlePendingWork();

        const requests = modalBatchRequests(cardTokens, seq);
        const directRequests = stageOf(requests, "direct");
        const routedRequests = stageOf(requests, "routed");
        for (const request of directRequests) {
          expect(usdPriceTargets(request).length, "1차 요청 대상 토큰 수").toBeLessThanOrEqual(C);
        }
        expect(targetsOf(directRequests), "1차 대상 합집합").toEqual(lowerSet(priced));
        for (const request of routedRequests) {
          // 2차 대상 토큰은 (토큰, WETH) 쌍의 토큰이다. (WETH, USDC) 구간 쌍은 세지 않는다.
          expect(usdPriceTargets(request).length, "2차 요청 대상 토큰 수").toBeLessThanOrEqual(C);
        }
        expect(targetsOf(routedRequests), "2차 대상 합집합").toEqual(lowerSet(routed));
        for (const token of priced) expect(rowHasUsd(token), token).toBe(true);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-20 EC-7
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났다. 스텁의 목록 잔액이 0보다 큰 토큰은 모두 USDC 직접 경로가 있고 그 수가 묶음 크기 상수보다 많아 1차 모달 일괄 요청이 2건 이상이다. 스텁은 토큰 F를 담은 1차 요청 하나만 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답한다. F와 같은 요청에 담긴 토큰은 카드에서 쓰지 않아 캐시된 단가가 없다
     * @when 보내는 칸 token-button으로 모달을 열고 모달 일괄 요청의 응답을 모두 기다린 뒤, 재시도 지연보다 긴 구간(재시도 지연 타이머(setTimeout)도 가짜로 두고 진행하거나 그만큼 실제 시간을 기다림)을 지난다
     * @then 실패한 요청에 담긴 토큰의 행에는 token-option-usd와 usd-skeleton이 없다
     * @then 실패한 묶음 요청(F를 담은 1차 모달 일괄 요청)은 재시도 지연보다 긴 구간이 지난 뒤에도 1건이다
     * @then 성공한 요청에 담긴 토큰의 행마다 token-option-usd의 data-usd-micros가 그 행 잔액과 스텁 단가로 계산한 값이다
     */
    it(
      "[EC-20][EC-7] 묶음 하나가 실패하면 그 묶음 토큰만 USD를 생략하고 나머지는 보인다",
      async () => {
        rpc.setBalances(() => 0n);
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        const cardTokens = [WETH];
        const seq = rpc.requests().length;

        const gate = await openModalHoldingBalances("in");
        const priced = rowPool().slice(0, C + 2);
        expect(priced.length).toBe(C + 2);
        const failing = priced[0];
        rpc.failUsdPriceWhen(both(matchUsdPrice.stage("direct"), matchUsdPrice.target(failing)));
        rpc.setBalances(balancesOnly(balancesFor(priced)));
        gate.release();

        await waitUntil(() => {
          const requests = modalBatchRequests(cardTokens, seq);
          expect(stageOf(requests, "direct").length).toBeGreaterThanOrEqual(2);
          expect(requests.every((request) => request.status !== "pending")).toBe(true);
          const failedTargets = targetsOf(
            requests.filter((request) => request.status === "failed"),
          );
          for (const token of priced) {
            if (!failedTargets.has(lower(token))) expect(rowUsdMicros(token), token).not.toBeNull();
          }
        }, WAIT_MS);
        // 재시도 지연보다 긴 구간(실제 시간)
        await yieldToPendingWork(RETRY_OBSERVATION_MS);
        await settlePendingWork();

        const requests = modalBatchRequests(cardTokens, seq);
        // 전제: 1차 모달 일괄 요청이 2건 이상이고, F를 담은 요청 하나만 실패했다.
        expect(stageOf(requests, "direct").length).toBeGreaterThanOrEqual(2);
        const failed = requests.filter((request) => request.status === "failed");
        expect(failed).toHaveLength(1);
        const failedTargets = targetsOf(failed);
        expect(failedTargets.has(lower(failing))).toBe(true);
        expect(
          rpc.requests(both(match.since(seq), matchUsdPrice.target(failing))),
          "실패한 묶음 요청 수(재시도 관찰 구간 뒤)",
        ).toHaveLength(1);

        for (const token of priced) {
          if (failedTargets.has(lower(token))) {
            expect(rowHasUsd(token), `${token} 실패 묶음 USD`).toBe(false);
            expect(rowHasSkeleton(token), `${token} 실패 묶음 스켈레톤`).toBe(false);
          } else {
            expect(rowUsdMicros(token), token).toBe(
              expectedRowMicros(token, expectedPrice(RULE_V0, token)),
            );
          }
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-20 EC-9
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI, 금액 `1`의 견적이 `success`이며 받는 칸 balance-usd·usd-value[data-side=out]·quote-amount-out-usd·quote-amount-out-minimum-usd가 DAI 단가로 표시됐다(카드 단가 읽기가 끝났고 카드의 DAI 단가 `success`). 스텁의 목록 잔액이 0보다 큰 토큰은 DAI를 포함해 모두 USDC 직접 경로가 있고 그 수가 묶음 크기 상수보다 많아 1차 모달 일괄 요청이 2건 이상이다. 스텁은 DAI를 담은 1차 요청 하나만 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답한다
     * @when 보내는 칸 token-button으로 모달을 열고 모달 일괄 요청의 응답을 모두 기다린다
     * @then 받는 칸 balance-usd의 data-usd-micros가 실패 전 값 그대로다
     * @then usd-value[data-side=out]이 `success`이고 usd-value[data-side=out]·quote-amount-out-usd·quote-amount-out-minimum-usd의 data-usd-micros가 실패 전 값 그대로다
     * @then DAI 행 token-option-usd의 data-usd-micros가 DAI 행 잔액과 실패 전 DAI 단가로 계산한 값이다
     * @then 성공한 요청에 담긴 토큰의 행마다 token-option-usd의 data-usd-micros가 그 행 잔액과 스텁 단가로 계산한 값이다
     */
    it(
      "[EC-20][EC-9] 실패한 묶음에 카드 단가가 있는 토큰이 있으면 카드와 그 행은 이전 값을 유지한다",
      async () => {
        const daiBalance = sampleBalance(40);
        rpc.setBalances(balancesOnly({ [DAI]: daiBalance }));
        rpc.setUsdPriceRule(RULE_V0);
        const view = await renderConnectedApp();
        await chooseToken("out", DAI);
        await typeAmount("1");
        await waitUntil(() => expect(view.result.current.quote.status).toBe("success"), WAIT_MS);
        const daiPriceV0 = expectedPrice(RULE_V0, DAI);
        await waitUntil(() => {
          const minimum = view.result.current.minimum;
          expect(minimum).not.toBeNull();
          const amountOut = quotedAmountOut(view);
          expect(balanceUsdMicros("out")).toBe(micros(daiBalance, daiPriceV0));
          expect(usdValue("out").getAttribute("data-usd-micros")).toBe(
            micros(amountOut, daiPriceV0),
          );
          expect(quoteUsdMicros("quote-amount-out-usd")).toBe(micros(amountOut, daiPriceV0));
          expect(quoteUsdMicros("quote-amount-out-minimum-usd")).toBe(micros(minimum!, daiPriceV0));
        }, WAIT_MS);
        await waitUntil(
          () =>
            expect(
              rpc.requests(matchUsdPrice.any).every((request) => request.status !== "pending"),
            ).toBe(true),
          WAIT_MS,
        );
        await settlePendingWork();
        const previous = {
          balanceOut: balanceUsdMicros("out"),
          out: usdValue("out").getAttribute("data-usd-micros"),
          quoteOut: quoteUsdMicros("quote-amount-out-usd"),
          quoteMinimum: quoteUsdMicros("quote-amount-out-minimum-usd"),
        };
        const cardTokens = [WETH, DAI];
        const seq = rpc.requests().length;

        const gate = await openModalHoldingBalances("in");
        const others = rowPool([DAI]).slice(0, C + 1);
        expect(others.length).toBe(C + 1);
        // 실패 묶음 밖의 행이 바뀐 단가를 보이도록 단가를 바꾼다(실패 묶음의 DAI는 이전 값을 유지해야 한다).
        rpc.setUsdPriceRule(RULE_V1);
        expect(stubPricesEqual(expectedPrice(RULE_V1, DAI), daiPriceV0)).toBe(false);
        rpc.failUsdPriceWhen(both(matchUsdPrice.stage("direct"), matchUsdPrice.target(DAI)));
        rpc.setBalances(balancesOnly({ [DAI]: daiBalance, ...balancesFor(others) }));
        gate.release();

        await waitUntil(() => {
          const requests = modalBatchRequests(cardTokens, seq);
          expect(stageOf(requests, "direct").length).toBeGreaterThanOrEqual(2);
          expect(requests.every((request) => request.status !== "pending")).toBe(true);
          const failedTargets = targetsOf(
            requests.filter((request) => request.status === "failed"),
          );
          expect(failedTargets.has(lower(DAI))).toBe(true);
          for (const token of others) {
            if (!failedTargets.has(lower(token))) expect(rowUsdMicros(token), token).not.toBeNull();
          }
        }, WAIT_MS);
        await settlePendingWork();

        expect(balanceUsdMicros("out"), "받는 칸 balance-usd").toBe(previous.balanceOut);
        expect(usdValue("out").getAttribute("data-state")).toBe("success");
        expect(usdValue("out").getAttribute("data-usd-micros"), "usd-value out").toBe(previous.out);
        expect(quoteUsdMicros("quote-amount-out-usd")).toBe(previous.quoteOut);
        expect(quoteUsdMicros("quote-amount-out-minimum-usd")).toBe(previous.quoteMinimum);
        expect(rowUsdMicros(DAI), "DAI 행").toBe(expectedRowMicros(DAI, daiPriceV0));
        const requests = modalBatchRequests(cardTokens, seq);
        const failedTargets = targetsOf(requests.filter((request) => request.status === "failed"));
        for (const token of others) {
          if (failedTargets.has(lower(token))) continue;
          expect(rowUsdMicros(token), token).toBe(
            expectedRowMicros(token, expectedPrice(RULE_V1, token)),
          );
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("모달 잔액 읽기가 실패한 경우", () => {
    /**
     * @spec EC-21
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 ETH 단가 읽기가 끝났다. 실패하지 않았다면 잔액이 0보다 컸을 토큰 여럿이 있다. 표본: 처음 여는 모달의 잔액 일괄 읽기 요청(`eth_getBalance`, aggregate3 `eth_call`)에 스텁이 실패 응답을 돌려줌, 한 번 성공적으로 열어 모달 일괄 조회가 끝난 뒤 토큰을 바꾸지 않고 닫았고 다시 열 때의 잔액 일괄 읽기 요청에 스텁이 실패 응답을 돌려줌을 하나씩 반복한다. 모달 일괄 요청 수를 기록해 둔다
     * @when 보내는 칸 token-button으로 표본의 마지막 열기를 하고 잔액 읽기 실패가 행에 반영된 뒤 남은 비동기 작업이 끝나기를 기다린다
     * @then 마지막으로 연 뒤 새 모달 일괄 요청이 0건이다
     * @then 처음 여는 표본에서 모달 어느 행에도 token-option-usd가 없다
     */
    it(
      "[EC-21] 모달 잔액 읽기가 실패하면 단가를 조회하지 않는다",
      async () => {
        const priced = [DAI, LINK, UNI];
        const samples = ["first-open", "reopen"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setBalances(balancesOnly(balancesFor(priced)));
          rpc.setUsdPriceRule(RULE_V0);
          await renderConnectedApp();
          const cardTokens = [WETH];
          if (sample === "reopen") {
            await openModal("in");
            await waitUntil(() => {
              for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
            }, WAIT_MS);
            await settlePendingWork();
            await closeModalKeepingToken();
            await settlePendingWork();
          }
          rpc.failWhen(LIST_BALANCE_READ);
          const seq = rpc.requests().length;

          await openModal("in");
          await waitUntil(() => {
            const reads = rpc.requests(both(match.since(seq), LIST_BALANCE_READ));
            expect(reads.length).toBeGreaterThan(0);
            expect(reads.every((request) => request.status === "failed")).toBe(true);
          }, WAIT_MS);
          if (sample === "first-open") {
            await waitUntil(() => {
              for (const token of priced) expect(rowBalance(token), token).toBeNull();
            }, WAIT_MS);
          }
          await yieldToPendingWork(RETRY_OBSERVATION_MS);
          await settlePendingWork();

          expect(modalBatchRequests(cardTokens, seq), `${sample}: 새 모달 일괄 요청`).toHaveLength(
            0,
          );
          if (sample === "first-open") {
            const modal = tokenModal()!;
            expect(within(modal).queryAllByTestId("token-option-usd"), sample).toHaveLength(0);
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("모달이 열려 있는 동안과 다시 여는 경우", () => {
    /**
     * @spec DoD-32
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 칸 미선택이고 카드 단가 읽기가 끝났다. 보내는 칸 모달을 열어 모달 일괄 조회가 끝나 잔액이 0보다 큰 행(카드에서 쓰지 않는 토큰)에 token-option-usd가 표시됐다. 그 뒤 스텁의 그 토큰들 단가를 다른 값으로 바꿨고, 카드 두 칸 토큰이 아닌 행 토큰을 담은 단가 요청 수를 기록해 둔다
     * @when 모달을 연 채로 가짜 시계를 60초씩 두 번 진행하고 window `focus` 이벤트를 발생시킨 뒤, token-search에 검색어를 입력했다가 지운다
     * @then 카드 두 칸 토큰이 아닌 행 토큰을 담은 단가 요청 수가 늘지 않는다
     * @then 카드에서 쓰지 않는 토큰 행의 token-option-usd data-usd-micros가 처음 값 그대로다
     */
    it(
      "[DoD-32] 모달이 열려 있는 동안 일괄 조회 요청을 다시 보내지 않는다",
      async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
        const priced = [DAI, LINK, UNI];
        rpc.setBalances(balancesOnly(balancesFor(priced)));
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        const cardTokens = [WETH];
        const seq = rpc.requests().length;

        await openModal("in");
        await waitUntil(() => {
          for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
        }, WAIT_MS);
        await settlePendingWork();
        const first = Object.fromEntries(priced.map((token) => [token, rowUsdMicros(token)]));
        rpc.setUsdPriceRule(RULE_V1);
        for (const token of priced) {
          expect(
            stubPricesEqual(expectedPrice(RULE_V1, token), expectedPrice(RULE_V0, token)),
          ).toBe(false);
        }
        const before = modalBatchRequests(cardTokens, seq).length;
        expect(before).toBeGreaterThan(0);

        await advanceFakeTimeTo(Date.now() + PRICE_REFETCH_MS);
        await settlePendingWork();
        await advanceFakeTimeTo(Date.now() + PRICE_REFETCH_MS);
        await settlePendingWork();
        focusWindow();
        await settlePendingWork();
        const search = within(tokenModal()!).getByTestId("token-search");
        fireEvent.change(search, { target: { value: "LINK" } });
        await waitUntil(() => expect(modalRows().length).toBeLessThan(priced.length + 10), WAIT_MS);
        fireEvent.change(search, { target: { value: "" } });
        await waitRowBalances(priced);
        await settlePendingWork();

        expect(modalBatchRequests(cardTokens, seq), "열린 동안 모달 일괄 요청").toHaveLength(
          before,
        );
        for (const token of priced) expect(rowUsdMicros(token), token).toBe(first[token]);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-22 DoD-30
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났다. 보내는 칸 모달을 한 번 열어 모달 일괄 조회가 끝난 뒤 토큰을 바꾸지 않고 닫았다. 그 뒤 스텁의 행 토큰 단가를 다른 값으로 바꿨고 모달 일괄 요청 수를 기록해 둔다. 표본 다시 열기: 잔액 응답을 바로 돌려줌, 다시 열 때의 잔액 일괄 읽기 응답을 붙잡았다가 확인 뒤 풂을 하나씩 반복한다
     * @when 보내는 칸 모달을 다시 열고 잔액 읽기와 모달 일괄 요청의 응답을 기다린다
     * @then 잔액 응답을 붙잡는 표본에서 붙잡힌 동안 새 모달 일괄 요청이 0건이다
     * @then 잔액 응답을 받은 뒤 모달 일괄 요청이 새로 나가고, 디코드한 대상 토큰 집합이 잔액이 0보다 큰 토큰 집합과 같다
     * @then 잔액이 0보다 큰 행의 token-option-usd data-usd-micros가 바뀐 스텁 단가로 계산한 값이다
     */
    it(
      "[EC-22][DoD-30] 모달을 닫았다가 다시 열면 잔액 읽기가 끝난 뒤 단가를 다시 조회한다",
      async () => {
        const priced = [DAI, LINK, UNI];
        const samples = ["immediate", "hold-balances"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          rpc.setBalances(balancesOnly(balancesFor(priced)));
          rpc.setUsdPriceRule(RULE_V0);
          await renderConnectedApp();
          const cardTokens = [WETH];
          await openModal("in");
          await waitUntil(() => {
            for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
          }, WAIT_MS);
          await settlePendingWork();
          await closeModalKeepingToken();
          await settlePendingWork();
          rpc.setUsdPriceRule(RULE_V1);
          const seq = rpc.requests().length;

          if (sample === "hold-balances") {
            const gate = await openModalHoldingBalances("in");
            expect(modalBatchRequests(cardTokens, seq), `${sample}: 붙잡힌 동안`).toHaveLength(0);
            gate.release();
          } else {
            await openModal("in");
          }
          await waitUntil(() => {
            for (const token of priced) {
              expect(rowUsdMicros(token), token).toBe(
                expectedRowMicros(token, expectedPrice(RULE_V1, token)),
              );
            }
          }, WAIT_MS);
          await settlePendingWork();
          const requests = modalBatchRequests(cardTokens, seq);
          expect(requests.length, `${sample}: 다시 연 뒤 모달 일괄 요청`).toBeGreaterThan(0);
          expect(targetsOf(requests), sample).toEqual(lowerSet(priced));
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("모달과 카드가 같은 토큰의 단가를 함께 쓰는 경우", () => {
    /**
     * @spec DoD-29
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI가 선택돼 받는 칸 balance-usd가 DAI 단가로 표시됐다(카드 단가 읽기가 끝났고 카드의 DAI 단가 `success`). 스텁의 목록 잔액은 DAI가 0보다 크고, DAI와 다른 USDC 직접 경로 토큰 여럿도 0보다 크다. 그 뒤 스텁의 DAI 단가를 다른 값으로 바꿨다
     * @when 보내는 칸 token-button으로 모달을 열고 모달 일괄 요청의 응답을 기다린다
     * @then DAI가 모달 일괄 요청의 대상 토큰 안에 있다(카드에 이미 있는 단가도 다시 조회한다)
     * @then DAI 행 token-option-usd의 data-usd-micros가 DAI 행 잔액과 바뀐 DAI 단가로 계산한 값이다
     * @then 받는 칸 balance-usd의 data-usd-micros가 받는 칸 잔액과 바뀐 DAI 단가로 계산한 값이다
     * @then 모달을 연 뒤 대상 토큰이 카드 토큰(DAI·WETH)뿐인 단가 요청이 0건이다
     */
    it(
      "[DoD-29] 모달 일괄 조회는 카드에 있는 단가도 다시 읽고 카드가 그 결과를 쓴다",
      async () => {
        const priced = [DAI, LINK, UNI];
        rpc.setBalances(balancesOnly(balancesFor(priced)));
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        await chooseToken("out", DAI);
        const cardDaiBalance = () => cardBalanceRaw("out");
        await waitUntil(() => {
          expect(cardDaiBalance()).not.toBeNull();
          expect(balanceUsdMicros("out")).toBe(
            micros(cardDaiBalance()!, expectedPrice(RULE_V0, DAI)),
          );
        }, WAIT_MS);
        await waitUntil(
          () =>
            expect(
              rpc.requests(matchUsdPrice.any).every((request) => request.status !== "pending"),
            ).toBe(true),
          WAIT_MS,
        );
        await settlePendingWork();
        rpc.setUsdPriceRule(RULE_V1);
        const daiPriceV1 = expectedPrice(RULE_V1, DAI);
        expect(stubPricesEqual(daiPriceV1, expectedPrice(RULE_V0, DAI))).toBe(false);
        const cardTokens = [WETH, DAI];
        const seq = rpc.requests().length;

        await openModal("in");
        await waitUntil(() => {
          for (const token of priced) {
            expect(rowUsdMicros(token), token).toBe(
              expectedRowMicros(token, expectedPrice(RULE_V1, token)),
            );
          }
        }, WAIT_MS);
        await settlePendingWork();

        const requests = modalBatchRequests(cardTokens, seq);
        expect(targetsOf(requests).has(lower(DAI)), "DAI가 모달 일괄 요청에 있다").toBe(true);
        expect(rowUsdMicros(DAI), "DAI 행").toBe(expectedRowMicros(DAI, daiPriceV1));
        await waitUntil(
          () => expect(balanceUsdMicros("out")).toBe(micros(cardDaiBalance()!, daiPriceV1)),
          WAIT_MS,
        );
        const cardOnly = rpc
          .requests(match.since(seq, matchUsdPrice.any))
          .filter((request) =>
            usdPriceTargets(request).every((target) => inList(cardTokens, target)),
          );
        expect(cardOnly, "대상이 카드 토큰뿐인 단가 요청").toHaveLength(0);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-29
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 칸 미선택이며 카드 단가 읽기가 끝났다. 보내는 칸 모달을 열어 모달 일괄 조회가 끝나 카드에서 쓰지 않던 토큰 X 행에 token-option-usd가 표시됐다. 단가 요청 수를 기록해 둔다
     * @when 모달에서 X 행을 눌러 보내는 칸 토큰을 X로 바꾸고 금액 `1`을 입력한다
     * @then 보내는 칸 balance-usd의 data-usd-micros가 보내는 칸 잔액과 모달이 읽은 X 단가로 계산한 값이다
     * @then usd-value[data-side=in]이 `success`이고 data-usd-micros가 `1`의 amountInRaw와 모달이 읽은 X 단가로 계산한 값이며 usd-skeleton이 나타나지 않는다
     * @then 고른 뒤 X 단가 요청 수가 늘지 않는다
     */
    it(
      "[DoD-29] 카드는 모달 일괄 조회 결과를 추가 요청 없이 쓴다",
      async () => {
        const priced = [DAI, LINK, UNI];
        rpc.setBalances(balancesOnly(balancesFor(priced)));
        rpc.setUsdPriceRule(RULE_V0);
        await renderConnectedApp();
        const linkPrice = expectedPrice(RULE_V0, LINK);
        // 전제: 카드에서 LINK 단가를 읽은 적이 없다.
        expect(rpc.requests(matchUsdPrice.target(LINK))).toHaveLength(0);

        await openModal("in");
        await waitUntil(() => {
          for (const token of priced) expect(rowUsdMicros(token), token).not.toBeNull();
        }, WAIT_MS);
        await settlePendingWork();
        expect(rowUsdMicros(LINK)).toBe(expectedRowMicros(LINK, linkPrice));
        const before = rpc.requests(matchUsdPrice.target(LINK)).length;

        const trace = traceSkeletonIn("in");
        fireEvent.click(optionRow(LINK));
        await waitUntil(() => expect(tokenModal()).toBeNull(), WAIT_MS);
        await typeAmount("1");
        await waitUntil(() => {
          const balance = cardBalanceRaw("in");
          expect(balance).not.toBeNull();
          expect(balanceUsdMicros("in")).toBe(micros(balance!, linkPrice));
        }, WAIT_MS);
        expect(usdValue("in").getAttribute("data-state")).toBe("success");
        expect(usdValue("in").getAttribute("data-usd-micros")).toBe(micros(ONE, linkPrice));
        await settlePendingWork();
        expect(trace.seen, "고른 뒤 usd-skeleton").toBe(false);
        expect(rpc.requests(matchUsdPrice.target(LINK)), "고른 뒤 LINK 단가 요청 수").toHaveLength(
          before,
        );
      },
      CASE_TIMEOUT_MS,
    );
  });
});
