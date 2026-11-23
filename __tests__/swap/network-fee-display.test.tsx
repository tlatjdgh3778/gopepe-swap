import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";
import { getConnection, switchChain } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { type WagmiConfig, createWagmiConfig } from "@/config/wagmi";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceFn,
  type BalanceRpcStub,
  type HoldGate,
  type NetworkFeeRule,
  type QuoteRule,
  type RequestMatcher,
  type StubPrice,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  STUB_MAX_UINT256,
  STUB_Q96,
  allowanceAlways,
  balancesWith,
  defaultBalance,
  defaultQuoteRule,
  defaultSlot0SqrtPriceX96,
  expectedStubUsdPrice,
  installBalanceRpcStub,
  matchAllowance,
  matchNetworkFee,
  matchQuote,
  matchUsdPrice,
  networkFeeRuleWith,
  parityQuoteRule,
  sameAddress,
  stubEstimateGasRevert,
  stubPricesEqual,
  stubRevertQuote,
  stubUsdMicros,
  usdPriceRuleWith,
} from "../support/rpc-balance-stub";
import {
  type WalletTransactionControl,
  createStubEip1193,
  installWalletTransactions,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeClockInSteps,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// T-9. 수수료 행(network-fee)의 주 버튼 상태별 표시·종류, 추정 상태별 값(success·loading·error),
// 경고 줄(network-fee-warning), 승인 후 안내(network-fee-swap-pending), ETH 부족 안내(network-fee-eth-shortage),
// 경고·부족·오류에 따른 주 버튼 불변, 수수료 행이 없는 조건을 앱 화면으로 확인한다.
// 판정은 스펙 §4.4의 testid·data 속성(data-state, data-kind, data-severity, data-fee-wei, data-usd-micros),
// primary-button[data-state]와 disabled 여부, 접근성 이름(role 조회)과 스텁이 받은 요청 기록으로 한다. 문구·색상은 보지 않는다.
// 추정 요청 calldata·체인별 계산은 T-8(network-fee-estimate), 갱신·요청 수·경합은 T-10(network-fee-refresh)이 맡는다.
// mock 경계(사용자 확정 2026-11-22): F9 경계(실제 wagmi·Provider·화면, wagmi mock 커넥터·스텁 EIP-1193 지갑,
// 전역 fetch URL 라우팅 스텁, 가짜 타이머, vi.mock 금지)에 수수료 3분류(eth_estimateGas·eth_gasPrice·getL1Fee) 스텁 응답·revert·실패·
// 붙잡기·HTTP 429 응답을 더한 것.
// 이 경계는 실제 노드의 추정값을 증명하지 못한다.
// 데이터 격리: 테스트(표본)마다 config·RPC 스텁·QueryClient를 새로 만들고 쿠키를 지운다.
// 기대 주소는 리터럴, 기대 feeWei는 스텁 응답 리터럴로 테스트가 계산한 gas × gasPrice(+ Base L1 수수료),
// 기대 micros는 스텁 slot0로 테스트가 따로 계산한 ETH(WETH) 단가로 feeWei × numerator / denominator를 버림한 값이다.

const CASE_TIMEOUT_MS = 90_000;
const MULTI_SAMPLE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 10_000;

// ─── 공식 주소(리터럴) ───────────────────────────────────────────────

const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_LINK: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const BASE_WETH: Address = "0x4200000000000000000000000000000000000006";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_DAI: Address = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const WETH_BY_CHAIN: Record<SupportedChainId, Address> = {
  [mainnet.id]: ETHEREUM_WETH,
  [base.id]: BASE_WETH,
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
const CHAIN_BY_ID = { [mainnet.id]: mainnet, [base.id]: base, [arbitrum.id]: arbitrum };

const ONE_ETH = 10n ** 18n;
const USDC_UNIT = 10n ** 6n;

// 스펙 EC-1의 추정 불가 기호 접근성 이름
const FEE_UNAVAILABLE_NAME = "수수료를 추정할 수 없음";

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

// 같은 case 안에서 표본(실행)마다 앱(config·QueryClient)과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// 주기 타이머(setInterval)와 시계만 가짜로 둔다. setTimeout(입력 반영 대기, RPC 시간 제한)은 실제다.
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

// ─── 수수료 규칙(테스트 쪽 리터럴) ──────────────────────────────────

type FeeKind = "approve" | "swap" | "wrap" | "unwrap";

// kind별 gas, 체인별 gasPrice, L1 수수료 리터럴. 기대 feeWei는 이 값으로 테스트가 계산한다.
const GAS_BY_KIND: Record<FeeKind, bigint> = {
  approve: 51_001n,
  swap: 160_003n,
  wrap: 30_007n,
  unwrap: 40_009n,
};
const GAS_UNKNOWN_TX = 99_991n;
const GAS_PRICE_BY_CHAIN: Record<SupportedChainId, bigint> = {
  [mainnet.id]: 2_500_000_003n,
  [base.id]: 7_000_001n,
  [arbitrum.id]: 10_000_007n,
};
const L1_FEE = 987_654_321n;

function literalFeeRule(): NetworkFeeRule {
  return networkFeeRuleWith({
    estimateGas: (query) => ({
      status: "ok",
      gas: query.tx.kind === "unknown" ? GAS_UNKNOWN_TX : GAS_BY_KIND[query.tx.kind],
    }),
    gasPrice: (query) => GAS_PRICE_BY_CHAIN[query.chainId],
    l1Fee: () => L1_FEE,
  });
}

// 리터럴 규칙의 feeWei(테스트 계산): gas × gasPrice, Base는 L1 수수료를 더한다(스펙 DoD-5·6).
function literalFeeWei(kind: FeeKind, chainId: SupportedChainId): bigint {
  return GAS_BY_KIND[kind] * GAS_PRICE_BY_CHAIN[chainId] + (chainId === base.id ? L1_FEE : 0n);
}

// 경고·ETH 부족 표본용: 모든 kind의 gas가 같고 gasPrice만 표본이 정한다(Ethereum). feeWei = FLAT_GAS × gasPrice.
const FLAT_GAS = 100_000n;

function flatFeeRule(gasPrice: bigint): NetworkFeeRule {
  return networkFeeRuleWith({
    estimateGas: () => ({ status: "ok", gas: FLAT_GAS }),
    gasPrice: () => gasPrice,
    l1Fee: () => L1_FEE,
  });
}

// ─── 단가·견적 규칙(테스트 쪽 리터럴) ───────────────────────────────

// Base WETH/USDC 풀의 slot0만 11 × 2^96으로 응답해 Base WETH 단가를 Ethereum WETH 단가와 다르게 한다.
const BASE_DISTINCT_USD_PRICE_RULE: QuoteRule = usdPriceRuleWith([
  {
    chainId: base.id,
    tokenIn: BASE_WETH,
    tokenOut: BASE_USDC,
    slot0: () => ({ status: "ok", sqrtPriceX96: 11n * STUB_Q96 }),
  },
]);

// 토큰의 USDC 직접·WETH 경유 단가 견적 티어를 모두 revert로 응답하는 Ethereum 단가 규칙(단가 없음)
function noPriceRule(...tokens: Address[]): QuoteRule {
  return usdPriceRuleWith(
    tokens.flatMap((token) => [
      { chainId: mainnet.id, tokenIn: token, tokenOut: ETHEREUM_USDC, quote: stubRevertQuote },
      { chainId: mainnet.id, tokenIn: token, tokenOut: ETHEREUM_WETH, quote: stubRevertQuote },
    ]),
  );
}

// ETH(WETH) 단가 요청(선택 체인)
function ethPriceRequest(chainId: SupportedChainId) {
  const weth = WETH_BY_CHAIN[chainId];
  return (request: Parameters<RequestMatcher>[0]) =>
    request.chainId === chainId && matchUsdPrice.target(weth)(request);
}

// 견적 네 티어 모두 revert(`no-route`)
const NO_ROUTE_QUOTE_RULE: QuoteRule = { quote: stubRevertQuote, slot0: defaultQuoteRule.slot0 };

// 가격 영향 `error` 등급 견적: 500 티어가 가장 많이 받고(amountIn × 0.4995) 그 풀의 slot0 가격이 1이다.
const IMPACT_FEE = 500;
const ERROR_IMPACT_QUOTE_RULE: QuoteRule = {
  quote: (query) => {
    const amountOut = (query.amountIn * 4_995n) / 10_000n;
    return {
      status: "ok",
      amountOut: query.fee === IMPACT_FEE ? amountOut : amountOut / 2n,
      sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
    };
  },
  slot0: (query) => ({
    status: "ok",
    sqrtPriceX96: query.fee === IMPACT_FEE ? STUB_Q96 : defaultSlot0SqrtPriceX96(query.fee),
  }),
};

// 최소 수령량 0 견적(USDC→DAI 금액 1): 모든 티어 수령량 1(raw), slot0 sqrtPriceX96 = 1000 × 2^96.
const DUST_OUT_QUOTE_RULE: QuoteRule = {
  quote: () => ({ status: "ok", amountOut: 1n, sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER }),
  slot0: () => ({ status: "ok", sqrtPriceX96: 1_000n * STUB_Q96 }),
};

// ─── 입력 표본 ────────────────────────────────────────────────────

type ReadyState = "approve-required" | "swap-ready" | "wrap-ready" | "unwrap-ready";

type InputSample = {
  label: string;
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amount: string;
  // 금액 문자열의 raw 값(테스트 쪽 리터럴)
  amountInRaw: bigint;
  // allowance 응답: zero는 기본 규칙(0), max는 2^256-1
  allowance: "zero" | "max";
  state: ReadyState;
  kind: FeeKind;
  // 보내는 토큰이 ETH·WETH
  ethLikeIn: boolean;
  // 보내는 토큰이 ETH
  ethIn: boolean;
};

const APPROVE_USDC_DAI: InputSample = {
  label: "USDC→DAI approve",
  chainId: mainnet.id,
  tokenIn: ETHEREUM_USDC,
  tokenOut: ETHEREUM_DAI,
  amount: "1",
  amountInRaw: USDC_UNIT,
  allowance: "zero",
  state: "approve-required",
  kind: "approve",
  ethLikeIn: false,
  ethIn: false,
};
const SWAP_USDC_DAI: InputSample = {
  ...APPROVE_USDC_DAI,
  label: "USDC→DAI swap",
  allowance: "max",
  state: "swap-ready",
  kind: "swap",
};
const SWAP_ETH_USDC: InputSample = {
  label: "ETH→USDC swap",
  chainId: mainnet.id,
  tokenIn: NATIVE_ETH,
  tokenOut: ETHEREUM_USDC,
  amount: "1",
  amountInRaw: ONE_ETH,
  allowance: "zero",
  state: "swap-ready",
  kind: "swap",
  ethLikeIn: true,
  ethIn: true,
};
const SWAP_USDC_ETH: InputSample = {
  ...SWAP_USDC_DAI,
  label: "USDC→ETH swap",
  tokenOut: NATIVE_ETH,
};
const SWAP_WETH_USDC: InputSample = {
  label: "WETH→USDC swap",
  chainId: mainnet.id,
  tokenIn: ETHEREUM_WETH,
  tokenOut: ETHEREUM_USDC,
  amount: "1",
  amountInRaw: ONE_ETH,
  allowance: "max",
  state: "swap-ready",
  kind: "swap",
  ethLikeIn: true,
  ethIn: false,
};
const SWAP_LINK_USDC: InputSample = {
  ...SWAP_WETH_USDC,
  label: "LINK→USDC swap",
  tokenIn: ETHEREUM_LINK,
  ethLikeIn: false,
};
const WRAP_ETH_WETH: InputSample = {
  label: "ETH→WETH wrap",
  chainId: mainnet.id,
  tokenIn: NATIVE_ETH,
  tokenOut: ETHEREUM_WETH,
  amount: "1",
  amountInRaw: ONE_ETH,
  allowance: "zero",
  state: "wrap-ready",
  kind: "wrap",
  ethLikeIn: true,
  ethIn: true,
};
const UNWRAP_WETH_ETH: InputSample = {
  label: "WETH→ETH unwrap",
  chainId: mainnet.id,
  tokenIn: ETHEREUM_WETH,
  tokenOut: NATIVE_ETH,
  amount: "1",
  amountInRaw: ONE_ETH,
  allowance: "zero",
  state: "unwrap-ready",
  kind: "unwrap",
  ethLikeIn: true,
  ethIn: false,
};
const BASE_SWAP_USDC_DAI: InputSample = {
  ...SWAP_USDC_DAI,
  label: "Base USDC→DAI swap(지갑 체인 Ethereum)",
  chainId: base.id,
  tokenIn: BASE_USDC,
  tokenOut: BASE_DAI,
};
const BASE_SWAP_ETH_USDC: InputSample = {
  ...SWAP_ETH_USDC,
  label: "Base ETH→USDC swap",
  chainId: base.id,
  tokenOut: BASE_USDC,
};

// 주 버튼 불변 비교에 쓰는 다섯 입력
const READY_INPUTS: readonly InputSample[] = [
  APPROVE_USDC_DAI,
  SWAP_ETH_USDC,
  SWAP_USDC_DAI,
  WRAP_ETH_WETH,
  UNWRAP_WETH_ETH,
];

function withAmount(sample: InputSample, amount: string, amountInRaw: bigint): InputSample {
  return { ...sample, label: `${sample.label} ${amount}`, amount, amountInRaw };
}

// 견적은 가격 영향 normal·최소 수령량 > 0 규칙, allowance는 표본 값으로 응답하게 한다.
function prepareInput(sample: InputSample) {
  rpc.setQuoteRule(parityQuoteRule);
  if (sample.allowance === "max") rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
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

function balanceRaw(side: Side): string | null {
  return within(field(side)).getByTestId("balance").getAttribute("data-balance-raw");
}

function primaryButton(): HTMLButtonElement {
  return screen.getByTestId("primary-button") as HTMLButtonElement;
}

function primaryState(): string | null {
  return primaryButton().getAttribute("data-state");
}

type PrimarySnapshot = { state: string | null; disabled: boolean };

function primarySnapshot(): PrimarySnapshot {
  return { state: primaryState(), disabled: primaryButton().disabled };
}

function clickPrimary() {
  fireEvent.click(primaryButton());
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

// 보내는 칸은 처음에 ETH이므로 보내는 ETH 표본은 보내는 칸을 고르지 않는다.
async function enterPair(sample: Pick<InputSample, "tokenIn" | "tokenOut" | "amount">) {
  if (!sameAddress(sample.tokenIn, NATIVE_ETH)) await chooseToken("in", sample.tokenIn);
  await chooseToken("out", sample.tokenOut);
  await typeAmount(sample.amount);
}

async function waitPrimary(state: string, label: string) {
  await waitUntil(() => expect(primaryState(), label).toBe(state), READY_TIMEOUT_MS);
}

function selectedChainId(): string | null {
  return screen.getByTestId("chain-select").getAttribute("data-selected-chain-id");
}

function networkFee(): HTMLElement | null {
  return screen.queryByTestId("network-fee");
}

// network-fee의 속성. 행이 없거나 속성이 없으면 null
function feeAttr(name: string): string | null {
  return networkFee()?.getAttribute(name) ?? null;
}

function hasFeeAttr(name: string): boolean {
  return networkFee()?.hasAttribute(name) ?? false;
}

async function waitFeeState(state: "loading" | "success" | "error", label: string) {
  await waitUntil(() => expect(feeAttr("data-state"), label).toBe(state), READY_TIMEOUT_MS);
  await settlePendingWork();
}

// 선택 체인 ETH(WETH) 단가 요청이 나갔고 대기 중인 단가 요청이 없을 때까지 기다린다.
async function waitPricesSettled(chainId: SupportedChainId, label: string) {
  await waitUntil(() => {
    expect(rpc.requests(ethPriceRequest(chainId)).length, `${label} ETH 단가 요청`).toBeGreaterThan(
      0,
    );
    expect(
      rpc.requests((request) => matchUsdPrice.any(request) && request.status === "pending"),
      `${label} 대기 중 단가 요청`,
    ).toEqual([]);
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
}

// 연결 계정의 ETH 잔액 요청이 응답을 받았는지
function ethBalanceAnswered(): boolean {
  return rpc
    .requests(
      (request) =>
        sameAddress(request.account, TEST_ACCOUNT) &&
        request.tokens.some((token) => sameAddress(token, NATIVE_ETH)) &&
        request.status === "ok",
    )
    .some(() => true);
}

// ETH 잔액만 `value`로, 나머지는 기본 규칙(표본 금액보다 훨씬 큼)으로 응답한다.
function ethBalanceRule(value: bigint): BalanceFn {
  return balancesWith({ [NATIVE_ETH]: value });
}

// ─── 기대값(테스트 쪽 계산) ──────────────────────────────────────

// 현재 스텁 단가 규칙으로 테스트가 계산한 토큰 단가(성공이어야 한다)
function expectedPrice(chainId: SupportedChainId, token: Address, decimals: number): StubPrice {
  const expected = expectedStubUsdPrice(rpc.usdPriceRule(), { chainId, token, decimals });
  expect(expected.status, `${chainId} ${token} 단가`).toBe("success");
  if (expected.status !== "success") throw new Error("unreachable");
  return expected.price;
}

function expectedEthPrice(chainId: SupportedChainId): StubPrice {
  return expectedPrice(chainId, NATIVE_ETH, 18);
}

type Severity = "normal" | "warning" | "unknown";

const BPS = 10_000n;
// 스펙 §4.3 NETWORK_FEE_WARNING_BPS
const WARNING_BPS = 500n;

// 스펙 DoD-22~25·EC-16·17·20의 심각도(테스트 쪽 계산). ETH·WETH 입력은 wei 비교, 그 밖은 USD micros 비교다.
function expectedSeverity(input: {
  feeWei: bigint;
  amountInRaw: bigint;
  ethLikeIn: boolean;
  feeUsdMicros: bigint | null;
  amountInUsdMicros: bigint | null;
}): Severity {
  if (input.ethLikeIn) {
    return input.feeWei * BPS >= input.amountInRaw * WARNING_BPS ? "warning" : "normal";
  }
  if (input.feeUsdMicros === null) return "unknown";
  if (input.feeUsdMicros === 0n) return "normal";
  if (input.amountInUsdMicros === null) return "unknown";
  return input.feeUsdMicros * BPS >= input.amountInUsdMicros * WARNING_BPS ? "warning" : "normal";
}

// 단가가 모두 성공인 Ethereum 표본의 심각도(테스트 계산). USDC 입력은 USDC 단가로 보내는 금액 USD를 구한다.
function expectedSeverityWithPrices(sample: InputSample, feeWei: bigint): Severity {
  if (sample.ethLikeIn) {
    return expectedSeverity({
      feeWei,
      amountInRaw: sample.amountInRaw,
      ethLikeIn: true,
      feeUsdMicros: null,
      amountInUsdMicros: null,
    });
  }
  const decimals = sameAddress(sample.tokenIn, ETHEREUM_USDC) ? 6 : 18;
  return expectedSeverity({
    feeWei,
    amountInRaw: sample.amountInRaw,
    ethLikeIn: false,
    feeUsdMicros: stubUsdMicros(feeWei, expectedEthPrice(sample.chainId)),
    amountInUsdMicros: stubUsdMicros(
      sample.amountInRaw,
      expectedPrice(sample.chainId, sample.tokenIn, decimals),
    ),
  });
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { quote: useSwapQuote() };
}

type App = {
  config: WagmiConfig;
  probe: () => ReturnType<typeof useProbe>;
  wallet?: WalletTransactionControl;
};

function appConfig(connector?: CreateConnectorFn): WagmiConfig {
  return createWagmiConfig({
    connectors: connector ? [connector] : [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// wagmi mock 커넥터로 연결된 앱. 선택 체인은 `selectedChainId`, 지갑 체인은 mock 커넥터의 첫 체인(Ethereum)이다.
async function renderMockApp(selectedChainId: SupportedChainId = mainnet.id): Promise<App> {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(useProbe, { config, initialChainId: selectedChainId });
  await waitUntil(() => {
    expect(getConnection(config).status).toBe("connected");
    expect(["restoring", "disconnected"]).not.toContain(primaryState());
  }, READY_TIMEOUT_MS);
  return { config, probe: () => view.result.current };
}

// 스텁 EIP-1193 지갑으로 Ethereum에 연결된 앱(지갑 전송 요청은 기록하고 해시로 응답한다).
async function renderStubWalletApp(): Promise<App & { wallet: WalletTransactionControl }> {
  const stub = createStubEip1193({
    chainId: mainnet.id,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletTransactions(stub);
  const config = appConfig(stubConnector(stub));
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(mainnet.id);
  }, READY_TIMEOUT_MS);
  return { config, probe: () => view.result.current, wallet };
}

// 저장된 연결이 없는 미연결 앱. 커넥터가 없어 복원 시도가 곧 끝난다.
async function renderDisconnectedApp(selectedChainId: SupportedChainId): Promise<App> {
  const config = appConfig();
  const view = renderAppHook(useProbe, { config, initialChainId: selectedChainId });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"), READY_TIMEOUT_MS);
  return { config, probe: () => view.result.current };
}

// 표본 입력을 넣고 주 버튼이 표본 상태가 되기를 기다린다.
async function renderReadyInput(sample: InputSample): Promise<App> {
  const app = await renderMockApp();
  if (sample.chainId !== mainnet.id) await chooseChainFromDropdown(CHAIN_BY_ID[sample.chainId]);
  await enterPair(sample);
  await waitPrimary(sample.state, sample.label);
  return app;
}

// ─── 경고 표본(DoD-27·28) ─────────────────────────────────────────

// USDC 입력(USD 비교)과 ETH·WETH 입력(wei 비교)의 gasPrice. feeWei = FLAT_GAS × gasPrice.
const USD_SAMPLE_GAS_PRICE = 9n;
const WEI_SAMPLE_GAS_PRICE = 10n ** 9n;

type SeveritySample = { input: InputSample; price: "success" | "no-price"; gasPrice: bigint };

// 경고(500 bps 이상)·경고 없음(500 bps 미만) 표본. ETH·WETH 입력의 단가 성공 표본은 ETH→USDC 하나뿐이고
// 나머지 ETH·WETH 입력은 ETH(WETH) 단가 없음으로만 돈다. USDC→DAI는 단가 성공만 쓴다.
function severitySamples(target: "warning" | "normal"): SeveritySample[] {
  const weiAmount: [string, bigint] = target === "warning" ? ["0.001", 10n ** 15n] : ["1", ONE_ETH];
  const usdAmount: [string, bigint] =
    target === "warning" ? ["1", USDC_UNIT] : ["100", 100n * USDC_UNIT];
  const weiInput = (sample: InputSample) => withAmount(sample, ...weiAmount);
  return [
    {
      input: withAmount(SWAP_USDC_DAI, ...usdAmount),
      price: "success",
      gasPrice: USD_SAMPLE_GAS_PRICE,
    },
    { input: weiInput(SWAP_ETH_USDC), price: "success", gasPrice: WEI_SAMPLE_GAS_PRICE },
    ...[SWAP_ETH_USDC, SWAP_WETH_USDC, WRAP_ETH_WETH, UNWRAP_WETH_ETH].map(
      (sample): SeveritySample => ({
        input: weiInput(sample),
        price: "no-price",
        gasPrice: WEI_SAMPLE_GAS_PRICE,
      }),
    ),
  ];
}

async function runSeverityCase(target: "warning" | "normal") {
  for (const [index, sample] of severitySamples(target).entries()) {
    const label = `${sample.input.label} 단가 ${sample.price}`;
    if (index > 0) resetSample();
    rpc.setNetworkFeeRule(flatFeeRule(sample.gasPrice));
    if (sample.price === "no-price") rpc.setUsdPriceRule(noPriceRule(ETHEREUM_WETH));
    prepareInput(sample.input);
    const feeWei = FLAT_GAS * sample.gasPrice;
    // 전제: 테스트 계산으로 표본의 심각도가 target이다(ETH·WETH 입력은 wei 비교라 단가와 무관하다).
    expect(expectedSeverityWithPrices(sample.input, feeWei), label).toBe(target);
    if (sample.price === "no-price") {
      // 전제: 스텁 규칙에서 ETH 단가는 no-price다.
      expect(
        expectedStubUsdPrice(rpc.usdPriceRule(), {
          chainId: mainnet.id,
          token: NATIVE_ETH,
          decimals: 18,
        }).status,
        label,
      ).toBe("no-price");
    }

    await renderReadyInput(sample.input);
    await waitFeeState("success", label);
    await waitPricesSettled(mainnet.id, label);
    // 전제: 표시한 feeWei가 테스트 계산값이다.
    expect(feeAttr("data-fee-wei"), label).toBe(feeWei.toString());

    expect(feeAttr("data-state"), label).toBe("success");
    expect(feeAttr("data-severity"), label).toBe(target);
    expect(screen.queryByTestId("network-fee-warning") !== null, label).toBe(target === "warning");
  }
}

describe("네트워크 수수료 — 사용자가 다음 트랜잭션의 예상 수수료와 경고·ETH 부족 안내를 본다", () => {
  describe("수수료 행의 종류와 값", () => {
    /**
     * @spec DoD-11 DoD-12 DoD-13 DoD-14 DoD-20 DoD-21
     * @given mock 커넥터로 Ethereum에 연결돼 있으며(지갑 체인 Ethereum) 보내는 토큰 잔액이 금액보다 크다. 스텁은 견적에 성공 응답을, eth_estimateGas·eth_gasPrice(Base는 getL1Fee도)에 리터럴 값으로 성공 응답을, ETH(WETH) 단가에 성공 응답을 주고 고른 티어 풀의 slot0을 2^96이 아닌 sqrtPriceX96로 돌려준다. Base 단가 규칙의 WETH slot0은 Ethereum과 다른 sqrtPriceX96로 응답해 Base WETH 단가와 Ethereum WETH 단가가 다르다(테스트 계산으로 전제를 확인한다). 표본(선택 체인 Ethereum): 보내는 USDC(allowance 0)·받는 DAI(`approve-required`, ETH 단가는 단건 단가 경로), 보내는 USDC(allowance 충분)·받는 DAI(`swap-ready`, 단건 단가 경로), 보내는 ETH·받는 USDC(`swap-ready`, 보내는 칸 단가 경로), 보내는 USDC(allowance 충분)·받는 ETH(`swap-ready`, 받는 칸 단가 경로), 보내는 ETH·받는 WETH(`wrap-ready`), 보내는 WETH·받는 ETH(`unwrap-ready`). 체인 불일치 표본: 지갑 체인은 Ethereum 그대로 두고 체인 드롭다운으로 선택 체인을 Base로 바꾼 뒤 보내는 Base USDC(allowance 충분)·받는 Base DAI(Base 주소 리터럴, `swap-ready`, 단건 ETH 단가 경로). 모든 표본을 금액 `1`로 하나씩 반복한다
     * @when primary-button[data-state]가 표본 상태가 되고 수수료 추정과 ETH 단가 조회가 끝나기를 기다린다
     * @then network-fee[data-kind]가 `approve-required` 표본에서 `approve`, `swap-ready` 표본에서 `swap`, `wrap-ready` 표본에서 `wrap`, `unwrap-ready` 표본에서 `unwrap`이다
     * @then network-fee-swap-pending은 data-kind가 `approve`인 표본에만 있고 나머지 표본에는 없다
     * @then `wrap-ready`·`unwrap-ready` 표본에서 quote-details가 없다
     * @then network-fee의 data-state가 `success`이고 data-fee-wei가 스텁 eth_estimateGas 응답 × eth_gasPrice 응답(체인 불일치 표본은 + 스텁 getL1Fee 응답, 테스트 계산)의 10진 문자열이다
     * @then network-fee[data-usd-micros]가 그 feeWei × 선택 체인의 ETH 단가 numerator / denominator를 버림한 값(테스트 계산)의 10진 문자열이다
     * @then 체인 불일치 표본의 data-usd-micros는 스텁 Base 단가 규칙으로 테스트가 계산한 Base WETH 단가로 구한 값이고, Ethereum WETH 단가로 구한 값과 다르다
     */
    it(
      "[DoD-11][DoD-12][DoD-13][DoD-14][DoD-20][DoD-21] 주 버튼 상태별 수수료 행의 종류·승인 후 안내·견적 정보 유무와 추정 성공 값",
      async () => {
        const samples: InputSample[] = [
          APPROVE_USDC_DAI,
          SWAP_USDC_DAI,
          SWAP_ETH_USDC,
          SWAP_USDC_ETH,
          WRAP_ETH_WETH,
          UNWRAP_WETH_ETH,
          BASE_SWAP_USDC_DAI,
        ];
        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          rpc.setUsdPriceRule(BASE_DISTINCT_USD_PRICE_RULE);
          rpc.setNetworkFeeRule(literalFeeRule());
          prepareInput(sample);
          const ethPrice = expectedEthPrice(sample.chainId);
          const ethereumPrice = expectedEthPrice(mainnet.id);
          if (sample.chainId !== mainnet.id) {
            // 전제: 스텁의 Base WETH 단가와 Ethereum WETH 단가가 다르다.
            expect(stubPricesEqual(ethPrice, ethereumPrice), label).toBe(false);
          }

          const app = await renderMockApp();
          if (sample.chainId !== mainnet.id) {
            await chooseChainFromDropdown(CHAIN_BY_ID[sample.chainId]);
            // 전제: 지갑 체인은 Ethereum 그대로다.
            expect(getConnection(app.config).chainId, label).toBe(mainnet.id);
          }
          await enterPair(sample);
          await waitPrimary(sample.state, label);
          await waitUntil(() => {
            expect(feeAttr("data-state"), label).toBe("success");
            expect(feeAttr("data-usd-micros"), label).not.toBeNull();
          }, READY_TIMEOUT_MS);
          await waitPricesSettled(sample.chainId, label);

          const feeWei = literalFeeWei(sample.kind, sample.chainId);
          expect(networkFee(), label).not.toBeNull();
          expect(feeAttr("data-kind"), label).toBe(sample.kind);
          expect(screen.queryByTestId("network-fee-swap-pending") !== null, label).toBe(
            sample.kind === "approve",
          );
          if (sample.kind === "wrap" || sample.kind === "unwrap") {
            expect(screen.queryByTestId("quote-details"), label).toBeNull();
          }
          expect(feeAttr("data-state"), label).toBe("success");
          expect(feeAttr("data-fee-wei"), label).toBe(feeWei.toString());
          expect(feeAttr("data-usd-micros"), label).toBe(
            stubUsdMicros(feeWei, ethPrice).toString(),
          );
          if (sample.chainId !== mainnet.id) {
            expect(feeAttr("data-usd-micros"), label).not.toBe(
              stubUsdMicros(feeWei, ethereumPrice).toString(),
            );
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("추정 상태별 값", () => {
    /**
     * @spec DoD-15
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH·받는 USDC·금액 `1`(`swap-ready`)이다. 이전 추정 값이 없다. 표본: 스텁이 첫 eth_estimateGas 응답을 붙잡음, 첫 eth_gasPrice 응답을 붙잡음을 하나씩 반복한다
     * @when primary-button[data-state]가 `swap-ready`가 되고 붙잡은 요청이 1건 이상 기록되기를 기다린다
     * @then network-fee의 data-state가 `loading`이다
     * @then network-fee 안에 network-fee-skeleton이 있다
     * @then network-fee에 data-fee-wei·data-usd-micros·data-severity가 없다
     */
    it(
      "[DoD-15] 첫 추정 중이면 loading이고 값 자리에 수수료 스켈레톤이 있다",
      async () => {
        const samples = ["eth_estimateGas", "eth_gasPrice"] as const;
        for (const [index, held] of samples.entries()) {
          const label = held;
          if (index > 0) resetSample();
          rpc.setNetworkFeeRule(literalFeeRule());
          prepareInput(SWAP_ETH_USDC);
          const gate = held === "eth_estimateGas" ? rpc.holdEstimateGas() : rpc.holdGasPrice();

          await renderReadyInput(SWAP_ETH_USDC);
          await waitUntil(
            () => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(feeAttr("data-state"), label).toBe("loading");
          expect(
            within(networkFee()!).queryAllByTestId("network-fee-skeleton").length,
            label,
          ).toBeGreaterThan(0);
          for (const name of ["data-fee-wei", "data-usd-micros", "data-severity"]) {
            expect(hasFeeAttr(name), `${label} ${name}`).toBe(false);
          }
          gate.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-19
     * @given mock 커넥터로 Ethereum에 연결돼 있고 스텁은 수수료 추정에 성공 응답을 준다. 표본 ETH 단가: ETH(WETH) 단가 견적 티어를 모두 revert로 응답(`no-price`), ETH(WETH) 단가 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답(`error`, 이전 값 없음). 표본 페어: 보내는 USDC(allowance 충분)·받는 DAI(단건 단가 경로), 보내는 ETH·받는 USDC(보내는 칸 단가 경로). 단가 2 × 페어 2의 조합을 금액 `1`로 하나씩 반복한다
     * @when 수수료 추정과 ETH 단가 결과가 나오기를 기다린다
     * @then network-fee의 data-state가 `success`이고 data-fee-wei가 스텁 응답으로 테스트가 계산한 feeWei의 10진 문자열이다
     * @then network-fee에 data-usd-micros가 없다
     * @then network-fee 안에 network-fee-skeleton과 접근성 이름 `수수료를 추정할 수 없음`인 요소가 없다
     */
    it(
      "[EC-19] ETH 단가가 no-price·error이면 수수료 USD 없이 ETH 값만 표시된다",
      async () => {
        const priceSamples = ["no-price", "error"] as const;
        const pairs: InputSample[] = [SWAP_USDC_DAI, SWAP_ETH_USDC];
        let count = 0;
        for (const priceSample of priceSamples) {
          for (const pair of pairs) {
            const label = `${priceSample} ${pair.label}`;
            if (count > 0) resetSample();
            count += 1;
            rpc.setNetworkFeeRule(literalFeeRule());
            prepareInput(pair);
            if (priceSample === "no-price") {
              rpc.setUsdPriceRule(noPriceRule(ETHEREUM_WETH));
              // 전제: 스텁 규칙에서 ETH 단가는 no-price다.
              expect(
                expectedStubUsdPrice(rpc.usdPriceRule(), {
                  chainId: mainnet.id,
                  token: NATIVE_ETH,
                  decimals: 18,
                }).status,
                label,
              ).toBe("no-price");
            } else {
              rpc.failUsdPriceWhen(ethPriceRequest(mainnet.id));
            }

            await renderReadyInput(pair);
            await waitFeeState("success", label);
            await waitPricesSettled(mainnet.id, label);
            if (priceSample === "error") {
              // 전제: ETH 단가 요청이 실패로 끝났다.
              expect(
                rpc.requests(ethPriceRequest(mainnet.id)).some((r) => r.status === "failed"),
                label,
              ).toBe(true);
            }

            expect(feeAttr("data-state"), label).toBe("success");
            expect(feeAttr("data-fee-wei"), label).toBe(
              literalFeeWei("swap", mainnet.id).toString(),
            );
            expect(hasFeeAttr("data-usd-micros"), label).toBe(false);
            const row = networkFee()!;
            expect(within(row).queryAllByTestId("network-fee-skeleton"), label).toHaveLength(0);
            expect(
              within(row).queryByRole("img", { name: FEE_UNAVAILABLE_NAME }),
              label,
            ).toBeNull();
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("추정 실패", () => {
    /**
     * @spec EC-1
     * @given mock 커넥터로 Ethereum에 연결돼 있고 스텁은 eth_estimateGas를 revert(code 3)로 응답하고 eth_gasPrice에는 성공 응답을 준다. 표본: 보내는 USDC(allowance 0)·받는 DAI(`approve`), 보내는 USDC(allowance 충분)·받는 DAI(`swap`), 보내는 ETH·받는 WETH(`wrap`), 보내는 WETH·받는 ETH(`unwrap`)를 금액 `1`로 하나씩 반복한다
     * @when 수수료 추정 결과가 나오기를 기다린다
     * @then network-fee의 data-state가 `error`다
     * @then network-fee 안에서 접근성 이름이 `수수료를 추정할 수 없음`인 요소를 role 조회로 찾는다
     * @then network-fee에 data-fee-wei·data-usd-micros가 없다
     */
    it(
      "[EC-1] eth_estimateGas가 revert하면 error이고 추정 불가 기호를 보인다",
      async () => {
        const samples: InputSample[] = [
          APPROVE_USDC_DAI,
          SWAP_USDC_DAI,
          WRAP_ETH_WETH,
          UNWRAP_WETH_ETH,
        ];
        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          rpc.setNetworkFeeRule(
            networkFeeRuleWith({ estimateGas: stubEstimateGasRevert }, literalFeeRule()),
          );
          prepareInput(sample);

          await renderReadyInput(sample);
          await waitFeeState("error", label);
          // 전제: 표본 kind의 추정 요청이 나갔다.
          expect(
            rpc.requests(matchNetworkFee.estimateGas({ kind: sample.kind })).length,
            label,
          ).toBeGreaterThan(0);

          expect(feeAttr("data-state"), label).toBe("error");
          expect(
            within(networkFee()!).getByRole("img", { name: FEE_UNAVAILABLE_NAME }),
            label,
          ).toBeTruthy();
          expect(hasFeeAttr("data-fee-wei"), label).toBe(false);
          expect(hasFeeAttr("data-usd-micros"), label).toBe(false);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-2
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH·받는 USDC·금액 `1`(`swap-ready`)이다. 스텁은 eth_estimateGas에 성공 응답을 주고 eth_gasPrice를 처음부터 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답한다(이전 값 없음)
     * @when eth_gasPrice 실패가 기록되고 수수료 상태가 정해지기를 기다린다
     * @then network-fee의 data-state가 `error`다
     * @then network-fee에 data-fee-wei가 없다
     */
    it(
      "[EC-2] 이전 값 없이 eth_gasPrice가 실패하면 error다",
      async () => {
        rpc.setNetworkFeeRule(literalFeeRule());
        rpc.failGasPriceWhen(matchNetworkFee.gasPrice);
        prepareInput(SWAP_ETH_USDC);

        await renderReadyInput(SWAP_ETH_USDC);
        await waitUntil(
          () =>
            expect(
              rpc.requests(matchNetworkFee.gasPrice).some((request) => request.status === "failed"),
            ).toBe(true),
          READY_TIMEOUT_MS,
        );
        await waitFeeState("error", "gasPrice 실패");
        // 전제: 성공한 eth_gasPrice 응답이 없다(이전 값 없음).
        expect(rpc.requests(matchNetworkFee.gasPrice).some((r) => r.status === "ok")).toBe(false);

        expect(feeAttr("data-state")).toBe("error");
        expect(hasFeeAttr("data-fee-wei")).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-3
     * @given 선택 체인은 Base이고 mock 커넥터로 Base에 연결돼 있으며 보내는 ETH·받는 USDC(Base 주소 리터럴)·금액 `1`(`swap-ready`)이다. 스텁은 eth_estimateGas·eth_gasPrice에 성공 응답을 주고 GasPriceOracle getL1Fee eth_call을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답한다
     * @when getL1Fee 실패가 기록되고 수수료 상태가 정해지기를 기다린다
     * @then network-fee의 data-state가 `error`다
     * @then network-fee에 data-fee-wei가 없다(L1 수수료를 뺀 gas × gasPrice 값을 표시하지 않는다)
     */
    it(
      "[EC-3] Base에서 getL1Fee가 실패하면 error이고 L1을 뺀 값을 보이지 않는다",
      async () => {
        rpc.setNetworkFeeRule(literalFeeRule());
        rpc.failL1FeeWhen(matchNetworkFee.l1Fee());
        prepareInput(BASE_SWAP_ETH_USDC);

        const app = await renderMockApp(base.id);
        await act(async () => {
          await switchChain(app.config, { chainId: base.id });
        });
        await waitUntil(
          () => expect(getConnection(app.config).chainId).toBe(base.id),
          READY_TIMEOUT_MS,
        );
        // 전제: 선택 체인과 지갑 체인이 Base다.
        expect(selectedChainId()).toBe(String(base.id));
        await enterPair(BASE_SWAP_ETH_USDC);
        await waitPrimary("swap-ready", "Base");
        await waitUntil(
          () =>
            expect(
              rpc.requests(matchNetworkFee.l1Fee()).some((request) => request.status === "failed"),
            ).toBe(true),
          READY_TIMEOUT_MS,
        );
        await waitFeeState("error", "getL1Fee 실패");
        // 전제: 같은 체인의 eth_estimateGas·eth_gasPrice는 성공했다.
        const okOnBase = (matcher: RequestMatcher) =>
          rpc.requests((r) => r.chainId === base.id && matcher(r) && r.status === "ok").length > 0;
        expect(okOnBase(matchNetworkFee.estimateGas())).toBe(true);
        expect(okOnBase(matchNetworkFee.gasPrice)).toBe(true);

        expect(feeAttr("data-state")).toBe("error");
        expect(hasFeeAttr("data-fee-wei")).toBe(false);
        expect(feeAttr("data-fee-wei")).not.toBe(
          (GAS_BY_KIND.swap * GAS_PRICE_BY_CHAIN[base.id]).toString(),
        );
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-4
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 표본 입력: 보내는 USDC(allowance 0)·받는 DAI(`approve-required`), 보내는 ETH·받는 USDC(`swap-ready`), 보내는 USDC(allowance 충분)·받는 DAI(`swap-ready`), 보내는 ETH·받는 WETH(`wrap-ready`), 보내는 WETH·받는 ETH(`unwrap-ready`)를 금액 `1`로. 표본 오류: eth_estimateGas revert, eth_gasPrice JSON-RPC 오류(이전 값 없음). 각 입력마다 추정 성공 실행 1회와 오류 표본별 실행을 같은 잔액·allowance·견적 응답으로 새 앱에서 하나씩 반복한다
     * @when 각 실행에서 수수료 상태가 정해지기를 기다려 network-fee[data-state]가 성공 실행은 `success`, 오류 실행은 `error`임을 확인하고 주 버튼을 읽는다
     * @then 오류 실행의 primary-button[data-state]가 같은 입력의 성공 실행과 같다
     * @then 오류 실행의 primary-button disabled 여부가 같은 입력의 성공 실행과 같다
     */
    it(
      "[EC-4] 수수료 추정 오류여도 주 버튼 상태와 활성 여부는 추정 성공 때와 같다",
      async () => {
        const runs = ["success", "estimate-revert", "gas-price-error"] as const;
        let count = 0;
        for (const input of READY_INPUTS) {
          const results = new Map<(typeof runs)[number], PrimarySnapshot>();
          for (const run of runs) {
            const label = `${input.label} ${run}`;
            if (count > 0) resetSample();
            count += 1;
            rpc.setNetworkFeeRule(
              run === "estimate-revert"
                ? networkFeeRuleWith({ estimateGas: stubEstimateGasRevert }, literalFeeRule())
                : literalFeeRule(),
            );
            if (run === "gas-price-error") rpc.failGasPriceWhen(matchNetworkFee.gasPrice);
            prepareInput(input);

            await renderMockApp();
            await enterPair(input);
            await waitFeeState(run === "success" ? "success" : "error", label);
            results.set(run, primarySnapshot());
          }
          const success = results.get("success")!;
          // 전제: 성공 실행의 주 버튼은 입력의 준비 상태다.
          expect(success.state, input.label).toBe(input.state);
          for (const run of ["estimate-revert", "gas-price-error"] as const) {
            const failed = results.get(run)!;
            expect(failed.state, `${input.label} ${run} data-state`).toBe(success.state);
            expect(failed.disabled, `${input.label} ${run} disabled`).toBe(success.disabled);
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("수수료 경고", () => {
    /**
     * @spec DoD-27 DoD-24
     * @given mock 커넥터로 Ethereum에 연결돼 있고 스텁은 수수료 추정에 리터럴 값으로 성공 응답을 준다. 표본(수수료 ÷ 보내는 금액이 500 bps 이상이 되게 금액을 고르고 테스트 계산으로 전제를 확인한다): 보내는 토큰이 ETH·WETH가 아닌 페어 보내는 USDC·받는 DAI(USD micros 비교)는 ETH 단가와 USDC 단가가 모두 성공인 경우만 쓴다(단가가 없으면 EC-20 `unknown`이라 이 case의 표본이 아니다). 보내는 토큰이 ETH·WETH인 페어(wei 비교) 보내는 ETH·받는 USDC, 보내는 WETH(allowance 충분)·받는 USDC, 보내는 ETH·받는 WETH, 보내는 WETH·받는 ETH는 ETH(WETH) 단가 없음(단가 견적 티어 모두 revert)으로만 돌린다(단가 성공이면 USD 비율과 wei 비율이 같아 USD 단가 사용 여부를 가려내지 못한다). 단가 성공 ETH 표본은 보내는 ETH·받는 USDC 1개만 둔다. 이 표본들을 하나씩 반복한다
     * @when 수수료 추정과 단가 결과가 나오기를 기다린다
     * @then network-fee의 data-state가 `success`이고 data-severity가 `warning`이다
     * @then network-fee-warning이 있다
     */
    it(
      "[DoD-27][DoD-24] 수수료 비율이 500 bps 이상이면 warning이고 경고 줄이 있다",
      async () => {
        await runSeverityCase("warning");
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-28 DoD-24
     * @given mock 커넥터로 Ethereum에 연결돼 있고 스텁은 수수료 추정에 리터럴 값으로 성공 응답을 준다. 표본(수수료 ÷ 보내는 금액이 500 bps 미만이 되게 금액을 고르고 테스트 계산으로 전제를 확인한다): 보내는 토큰이 ETH·WETH가 아닌 페어 보내는 USDC·받는 DAI(USD micros 비교)는 ETH 단가와 USDC 단가가 모두 성공인 경우만 쓴다(단가가 없으면 EC-20 `unknown`이라 이 case의 표본이 아니다). 보내는 토큰이 ETH·WETH인 페어(wei 비교) 보내는 ETH·받는 USDC, 보내는 WETH(allowance 충분)·받는 USDC, 보내는 ETH·받는 WETH, 보내는 WETH·받는 ETH는 ETH(WETH) 단가 없음(단가 견적 티어 모두 revert)으로만 돌린다(단가 성공이면 USD 비율과 wei 비율이 같아 USD 단가 사용 여부를 가려내지 못한다). 단가 성공 ETH 표본은 보내는 ETH·받는 USDC 1개만 둔다. 이 표본들을 하나씩 반복한다
     * @when 수수료 추정과 단가 결과가 나오기를 기다린다
     * @then network-fee의 data-state가 `success`이고 data-severity가 `normal`이다
     * @then network-fee-warning이 없다
     */
    it(
      "[DoD-28][DoD-24] 수수료 비율이 500 bps 미만이면 normal이고 경고 줄이 없다",
      async () => {
        await runSeverityCase("normal");
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-20
     * @given mock 커넥터로 Ethereum에 연결돼 있고 스텁은 수수료 추정에 0보다 큰 feeWei가 되는 성공 응답을 준다. 표본: 보내는 USDC·받는 DAI·금액 `1`이고 ETH(WETH) 단가 견적 티어 모두 revert(수수료 USD 모름), 같은 입력에 ETH(WETH) 단가 요청 JSON-RPC 오류(수수료 USD 모름), 보내는 Ethereum LINK(`0x514910771AF9Ca656af840dff83E8264EcF986CA`, decimals 18, LINK의 USDC 직접·WETH 경유 단가 견적 티어 모두 revert)·받는 USDC·금액 `1`이고 ETH 단가 성공(수수료 USD > 0, 보내는 금액 USD 모름)을 하나씩 반복한다
     * @when 수수료 추정과 단가 결과가 나오기를 기다린다
     * @then network-fee의 data-state가 `success`이고 data-severity가 `unknown`이다
     * @then network-fee-warning이 없다
     */
    it(
      "[EC-20] ETH·WETH가 아닌 보내는 토큰에서 USD 비교가 불가하면 unknown이고 경고 줄이 없다",
      async () => {
        const samples: { label: string; input: InputSample; setup: () => void }[] = [
          {
            label: "ETH 단가 no-price",
            input: SWAP_USDC_DAI,
            setup: () => rpc.setUsdPriceRule(noPriceRule(ETHEREUM_WETH)),
          },
          {
            label: "ETH 단가 error",
            input: SWAP_USDC_DAI,
            setup: () => rpc.failUsdPriceWhen(ethPriceRequest(mainnet.id)),
          },
          {
            label: "LINK 단가 no-price",
            input: SWAP_LINK_USDC,
            setup: () => rpc.setUsdPriceRule(noPriceRule(ETHEREUM_LINK)),
          },
        ];
        for (const [index, sample] of samples.entries()) {
          const { label, input } = sample;
          if (index > 0) resetSample();
          rpc.setNetworkFeeRule(literalFeeRule());
          prepareInput(input);
          sample.setup();
          const feeWei = literalFeeWei("swap", mainnet.id);
          // 전제: feeWei > 0이다.
          expect(feeWei > 0n, label).toBe(true);
          if (sample.input === SWAP_LINK_USDC) {
            // 전제: LINK 단가는 no-price이고 ETH 단가는 성공이며 수수료 USD > 0이다.
            expect(
              expectedStubUsdPrice(rpc.usdPriceRule(), {
                chainId: mainnet.id,
                token: ETHEREUM_LINK,
                decimals: 18,
              }).status,
              label,
            ).toBe("no-price");
            expect(stubUsdMicros(feeWei, expectedEthPrice(mainnet.id)) > 0n, label).toBe(true);
          }

          await renderReadyInput(input);
          await waitFeeState("success", label);
          await waitPricesSettled(mainnet.id, label);

          expect(feeAttr("data-state"), label).toBe("success");
          expect(feeAttr("data-severity"), label).toBe("unknown");
          expect(screen.queryByTestId("network-fee-warning"), label).toBeNull();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-29
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 표본 입력: 보내는 USDC(allowance 0)·받는 DAI(`approve-required`), 보내는 ETH·받는 USDC(`swap-ready`), 보내는 USDC(allowance 충분)·받는 DAI(`swap-ready`), 보내는 ETH·받는 WETH(`wrap-ready`), 보내는 WETH·받는 ETH(`unwrap-ready`). 각 입력마다 같은 금액·잔액·allowance·견적·단가 응답으로, 스텁 수수료 추정 응답만 바꿔 경고 실행(500 bps 이상)과 경고 없음 실행(500 bps 미만)을 새 앱에서 하나씩 반복한다
     * @when 각 실행에서 network-fee[data-severity]가 경고 실행은 `warning`, 경고 없음 실행은 `normal`이 되기를 기다리고 주 버튼을 읽는다
     * @then 경고 실행의 primary-button[data-state]가 같은 입력의 경고 없음 실행과 같다
     * @then 경고 실행의 primary-button disabled 여부가 같은 입력의 경고 없음 실행과 같다
     */
    it(
      "[DoD-29] 수수료 경고가 있어도 주 버튼 상태와 활성 여부는 경고가 없을 때와 같다",
      async () => {
        const runs = ["warning", "normal"] as const;
        let count = 0;
        for (const input of READY_INPUTS) {
          // 같은 입력에서 gasPrice 응답만 바꾼다. ETH·WETH 입력은 wei 비교, USDC 입력은 USD 비교로 경고 여부가 갈린다.
          const gasPrices = input.ethLikeIn
            ? { warning: 10n ** 12n, normal: 10n ** 9n }
            : { warning: 9n, normal: 1n };
          const results = new Map<(typeof runs)[number], PrimarySnapshot>();
          for (const run of runs) {
            const label = `${input.label} ${run}`;
            if (count > 0) resetSample();
            count += 1;
            rpc.setNetworkFeeRule(flatFeeRule(gasPrices[run]));
            prepareInput(input);
            // 전제: 테스트 계산으로 이 실행의 심각도가 run이다.
            expect(expectedSeverityWithPrices(input, FLAT_GAS * gasPrices[run]), label).toBe(run);

            await renderMockApp();
            await enterPair(input);
            await waitFeeState("success", label);
            await waitPricesSettled(mainnet.id, label);
            await waitUntil(
              () => expect(feeAttr("data-severity"), label).toBe(run),
              READY_TIMEOUT_MS,
            );
            await settlePendingWork();
            results.set(run, primarySnapshot());
          }
          const warning = results.get("warning")!;
          const normal = results.get("normal")!;
          // 전제: 경고 없음 실행의 주 버튼은 입력의 준비 상태다.
          expect(normal.state, input.label).toBe(input.state);
          expect(warning.state, `${input.label} data-state`).toBe(normal.state);
          expect(warning.disabled, `${input.label} disabled`).toBe(normal.disabled);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("ETH 부족 안내", () => {
    /**
     * @spec DoD-32 EC-23
     * @given mock 커넥터로 Ethereum에 연결돼 있고 스텁은 수수료 추정에 0보다 큰 feeWei가 되는 성공 응답을 준다. 표본: 보내는 ETH·받는 USDC(`swap-ready`)와 보내는 ETH·받는 WETH(`wrap-ready`)에서 ETH 잔액이 보내는 금액 이상이고 보내는 금액 + feeWei(테스트 계산)보다 작음, 보내는 USDC(allowance 0)·받는 DAI(`approve-required`)와 보내는 USDC(allowance 충분)·받는 DAI(`swap-ready`)와 보내는 WETH·받는 ETH(`unwrap-ready`)에서 ETH 잔액이 0보다 크고 feeWei보다 작음을 하나씩 반복한다
     * @when primary-button[data-state]가 표본 상태가 되고 수수료 추정이 끝나기를 기다린다
     * @then network-fee의 data-state가 `success`다
     * @then network-fee-eth-shortage가 있다
     */
    it(
      "[DoD-32][EC-23] ETH 잔액이 보내는 ETH 금액 + 수수료보다 작으면 ETH 부족 안내가 있다",
      async () => {
        const gasPrice = 10n ** 9n;
        const feeWei = FLAT_GAS * gasPrice;
        const samples: { input: InputSample; ethBalance: bigint }[] = [
          { input: SWAP_ETH_USDC, ethBalance: SWAP_ETH_USDC.amountInRaw + feeWei / 2n },
          { input: WRAP_ETH_WETH, ethBalance: WRAP_ETH_WETH.amountInRaw + feeWei / 2n },
          { input: APPROVE_USDC_DAI, ethBalance: feeWei / 2n },
          { input: SWAP_USDC_DAI, ethBalance: feeWei / 2n },
          { input: UNWRAP_WETH_ETH, ethBalance: feeWei / 2n },
        ];
        for (const [index, { input, ethBalance }] of samples.entries()) {
          const { label } = input;
          if (index > 0) resetSample();
          // 전제: ETH 입력은 금액 ≤ 잔액 < 금액 + feeWei, 그 밖은 0 < 잔액 < feeWei다(테스트 계산).
          if (input.ethIn) {
            expect(ethBalance >= input.amountInRaw, label).toBe(true);
            expect(ethBalance < input.amountInRaw + feeWei, label).toBe(true);
          } else {
            expect(ethBalance > 0n && ethBalance < feeWei, label).toBe(true);
          }
          rpc.setNetworkFeeRule(flatFeeRule(gasPrice));
          rpc.setBalances(ethBalanceRule(ethBalance));
          prepareInput(input);

          await renderReadyInput(input);
          await waitFeeState("success", label);
          await waitUntil(() => expect(ethBalanceAnswered(), label).toBe(true), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(feeAttr("data-state"), label).toBe("success");
          expect(feeAttr("data-fee-wei"), label).toBe(feeWei.toString());
          expect(screen.queryByTestId("network-fee-eth-shortage"), label).not.toBeNull();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-21
     * @given mock 커넥터로 Ethereum에 연결돼 있고 ETH 잔액이 0이다. 표본 입력: 보내는 USDC(allowance 0)·받는 DAI(`approve-required`), 보내는 USDC(allowance 충분)·받는 DAI(`swap-ready`), 보내는 WETH·받는 ETH(`unwrap-ready`)를 금액 `1`로. 표본 추정 상태: 스텁이 첫 eth_estimateGas 응답을 붙잡음(`loading`), eth_estimateGas revert(`error`). 입력 3 × 추정 상태 2의 조합을 하나씩 반복한다
     * @when ETH 잔액 0이 읽히고 network-fee[data-state]가 표본 추정 상태가 되기를 기다린다
     * @then network-fee의 data-state가 표본 추정 상태(`loading` 또는 `error`)다
     * @then network-fee-eth-shortage가 있다
     */
    it(
      "[EC-21] ETH 잔액이 0이면 추정이 loading·error여도 ETH 부족 안내가 있다",
      async () => {
        const inputs: InputSample[] = [APPROVE_USDC_DAI, SWAP_USDC_DAI, UNWRAP_WETH_ETH];
        const feeStates = ["loading", "error"] as const;
        let count = 0;
        for (const input of inputs) {
          for (const feeState of feeStates) {
            const label = `${input.label} ${feeState}`;
            if (count > 0) resetSample();
            count += 1;
            rpc.setBalances(ethBalanceRule(0n));
            rpc.setNetworkFeeRule(
              feeState === "error"
                ? networkFeeRuleWith({ estimateGas: stubEstimateGasRevert }, literalFeeRule())
                : literalFeeRule(),
            );
            const gate = feeState === "loading" ? rpc.holdEstimateGas() : undefined;
            prepareInput(input);

            await renderReadyInput(input);
            await waitUntil(() => expect(ethBalanceAnswered(), label).toBe(true), READY_TIMEOUT_MS);
            if (gate) {
              await waitUntil(
                () => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1),
                READY_TIMEOUT_MS,
              );
            }
            await waitFeeState(feeState, label);

            expect(feeAttr("data-state"), label).toBe(feeState);
            expect(screen.queryByTestId("network-fee-eth-shortage"), label).not.toBeNull();
            gate?.release();
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-33
     * @given mock 커넥터로 Ethereum에 연결돼 있고 스텁은 수수료 추정에 성공 응답을 준다. 표본 입력: 보내는 USDC(allowance 0)·받는 DAI(`approve-required`), 보내는 ETH·받는 USDC(`swap-ready`), 보내는 USDC(allowance 충분)·받는 DAI(`swap-ready`), 보내는 ETH·받는 WETH(`wrap-ready`), 보내는 WETH·받는 ETH(`unwrap-ready`). 각 입력마다 같은 금액·allowance·견적·수수료 응답으로, ETH 잔액만 바꿔 부족 실행(ETH 입력은 금액 이상이고 금액 + feeWei보다 작은 잔액, 그 밖은 0)과 부족 없음 실행(금액 + feeWei보다 충분히 큰 잔액)을 새 앱에서 하나씩 반복한다
     * @when 각 실행에서 network-fee-eth-shortage가 부족 실행은 있고 부족 없음 실행은 없게 되기를 기다리고 주 버튼을 읽는다
     * @then 부족 실행의 primary-button[data-state]가 같은 입력의 부족 없음 실행과 같다
     * @then 부족 실행의 primary-button disabled 여부가 같은 입력의 부족 없음 실행과 같다
     */
    it(
      "[DoD-33] ETH 부족 안내가 있어도 주 버튼 상태와 활성 여부는 안내가 없을 때와 같다",
      async () => {
        const gasPrice = 10n ** 9n;
        const feeWei = FLAT_GAS * gasPrice;
        const runs = ["shortage", "enough"] as const;
        let count = 0;
        for (const input of READY_INPUTS) {
          const balances = {
            shortage: input.ethIn ? input.amountInRaw + feeWei / 2n : 0n,
            enough: 10n ** 21n,
          };
          const results = new Map<(typeof runs)[number], PrimarySnapshot>();
          for (const run of runs) {
            const label = `${input.label} ${run}`;
            if (count > 0) resetSample();
            count += 1;
            rpc.setNetworkFeeRule(flatFeeRule(gasPrice));
            rpc.setBalances(ethBalanceRule(balances[run]));
            prepareInput(input);

            await renderMockApp();
            await enterPair(input);
            await waitFeeState("success", label);
            await waitUntil(() => expect(ethBalanceAnswered(), label).toBe(true), READY_TIMEOUT_MS);
            await waitUntil(
              () =>
                expect(screen.queryByTestId("network-fee-eth-shortage") !== null, label).toBe(
                  run === "shortage",
                ),
              READY_TIMEOUT_MS,
            );
            await settlePendingWork();
            results.set(run, primarySnapshot());
          }
          const shortage = results.get("shortage")!;
          const enough = results.get("enough")!;
          // 전제: 부족 없음 실행의 주 버튼은 입력의 준비 상태다.
          expect(enough.state, input.label).toBe(input.state);
          expect(shortage.state, `${input.label} data-state`).toBe(enough.state);
          expect(shortage.disabled, `${input.label} disabled`).toBe(enough.disabled);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-24
     * @given mock 커넥터·스텁 지갑으로 Ethereum에 연결돼 있고 ETH 잔액이 0이며 보내는 USDC(allowance 0)·받는 DAI·금액 `1`(`approve-required`)이다. 스텁은 approve 영수증을 성공으로 주고, 그 뒤 다시 읽는 USDC 잔액을 클릭 시점 잔액보다 작지만 금액 이상으로 돌려준다
     * @when 주 버튼(approve)을 누르고 approve 영수증 성공 뒤 수수료 추정이 끝나기를 기다린다
     * @then tx-status의 data-status가 `success`이고 data-kind가 `approve`다
     * @then tx-balance-notice가 있다
     * @then network-fee가 있고 network-fee-eth-shortage가 있다
     */
    it(
      "[EC-24] approve 성공 뒤 잔액 감소 안내와 ETH 부족 안내가 함께 있다",
      async () => {
        const clickBalance = 100n * USDC_UNIT;
        const afterBalance = 90n * USDC_UNIT;
        // 전제: 다시 읽은 잔액은 클릭 시점보다 작고 금액 이상이다.
        expect(afterBalance < clickBalance && afterBalance >= APPROVE_USDC_DAI.amountInRaw).toBe(
          true,
        );
        // 주기 다시 읽기가 클릭 시점 잔액을 바꾸지 않게 주기 타이머를 가짜로 둔다.
        fakePeriodicTimers();
        let phase: "pre" | "after" = "pre";
        rpc.setBalances((query) => {
          if (sameAddress(query.token, NATIVE_ETH)) return 0n;
          if (
            query.chainId === mainnet.id &&
            sameAddress(query.account, TEST_ACCOUNT) &&
            sameAddress(query.token, ETHEREUM_USDC)
          ) {
            return phase === "pre" ? clickBalance : afterBalance;
          }
          return defaultBalance(query);
        });
        rpc.setNetworkFeeRule(literalFeeRule());
        prepareInput(APPROVE_USDC_DAI);

        const app = await renderStubWalletApp();
        await enterPair(APPROVE_USDC_DAI);
        await waitPrimary("approve-required", "클릭 전");
        await waitUntil(
          () => expect(balanceRaw("in")).toBe(clickBalance.toString()),
          READY_TIMEOUT_MS,
        );
        await waitFeeState("success", "클릭 전");

        const receiptGate = rpc.holdReceipt();
        clickPrimary();
        await waitPrimary("approving", "approve 영수증 대기");
        await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
        // 전제: 지갑에 approve 전송 요청 하나가 갔다.
        expect(app.wallet.sent).toHaveLength(1);
        // 영수증 뒤 allowance는 충분하고 USDC 잔액은 줄어든 값으로 읽힌다.
        rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
        phase = "after";
        receiptGate.release();

        await waitUntil(() => {
          expect(screen.getByTestId("tx-status").getAttribute("data-status")).toBe("success");
          expect(screen.queryByTestId("tx-balance-notice")).not.toBeNull();
        }, READY_TIMEOUT_MS);
        await waitPrimary("swap-ready", "approve 뒤");
        await waitFeeState("success", "approve 뒤");
        await waitUntil(() => expect(ethBalanceAnswered()).toBe(true), READY_TIMEOUT_MS);
        await settlePendingWork();

        const txStatus = screen.getByTestId("tx-status");
        expect(txStatus.getAttribute("data-status")).toBe("success");
        expect(txStatus.getAttribute("data-kind")).toBe("approve");
        expect(screen.queryByTestId("tx-balance-notice")).not.toBeNull();
        expect(networkFee()).not.toBeNull();
        expect(screen.queryByTestId("network-fee-eth-shortage")).not.toBeNull();
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("수수료 행이 없는 경우", () => {
    /**
     * @spec EC-7
     * @given 저장된 연결이 없다(미연결, 복원 완료). 스텁은 견적·단가에 성공 응답을 주고 JSON-RPC 요청을 항목 단위로 기록한다. 표본: 선택 체인 Ethereum에서 보내는 ETH·받는 USDC·금액 `1`, 보내는 ETH·받는 WETH·금액 `1`, 선택 체인 Base에서 보내는 ETH·받는 USDC(Base 주소 리터럴)·금액 `1`을 하나씩 반복한다
     * @when primary-button[data-state]가 `disconnected`인 앱에서 금액을 입력하고 견적이 `success`(wrap 표본은 `wrap`)가 되기를 기다린 뒤, 대기 중인 비동기 작업을 정리하고 setInterval 계열 가짜 타이머로 가스 가격 주기(60초)를 넘겨(60초 초과) 다시 비동기 작업을 정리한다. 관찰 구간은 앱 렌더부터 이 시점까지다
     * @then 관찰 구간 끝에 network-fee가 없다
     * @then 관찰 구간 전체에서 스텁에 기록된 eth_estimateGas·eth_gasPrice·getL1Fee 요청이 각각 0건이다
     */
    it(
      "[EC-7] 지갑 미연결이면 수수료 행이 없고 수수료 요청이 0건이다",
      async () => {
        const samples: { input: InputSample; quote: "success" | "wrap" }[] = [
          { input: SWAP_ETH_USDC, quote: "success" },
          { input: WRAP_ETH_WETH, quote: "wrap" },
          { input: BASE_SWAP_ETH_USDC, quote: "success" },
        ];
        for (const [index, { input, quote }] of samples.entries()) {
          const { label } = input;
          if (index > 0) resetSample();
          // 가스 가격 주기(60초)를 가짜 시계로 넘긴다.
          fakePeriodicTimers();
          rpc.setQuoteRule(parityQuoteRule);
          rpc.setNetworkFeeRule(literalFeeRule());

          const app = await renderDisconnectedApp(input.chainId);
          // 전제: 선택 체인이 표본 체인이다.
          expect(selectedChainId(), label).toBe(String(input.chainId));
          await enterPair(input);
          await waitUntil(
            () => expect(app.probe().quote.status, label).toBe(quote),
            READY_TIMEOUT_MS,
          );
          if (quote === "success") {
            // 전제: 표본 체인의 견적 요청이 응답을 받았다(요청 기록이 동작한다).
            expect(
              rpc
                .requests(matchQuote.input({ chainId: input.chainId }))
                .some((request) => request.status === "ok"),
              label,
            ).toBe(true);
          }
          await settlePendingWork();
          await advanceFakeClockInSteps(61_000, 5_000);
          await settlePendingWork();

          expect(primaryState(), label).toBe("disconnected");
          expect(networkFee(), label).toBeNull();
          expect(
            rpc.requests(matchNetworkFee.estimateGas()),
            `${label} eth_estimateGas`,
          ).toHaveLength(0);
          expect(rpc.requests(matchNetworkFee.gasPrice), `${label} eth_gasPrice`).toHaveLength(0);
          expect(rpc.requests(matchNetworkFee.l1Fee()), `${label} getL1Fee`).toHaveLength(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-8
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 표본 주 버튼 상태: `select-token`(받는 미선택), `enter-amount`(금액 빈 값), `insufficient-balance`(금액이 잔액보다 큼), `quoting`(견적 응답 붙잡기 중), `no-route`(견적 네 티어 모두 revert), `quote-error`(견적 JSON-RPC 오류), `price-impact-too-high`(가격 영향이 오류 등급인 견적), `amount-too-small`(최소 수령량이 0인 견적), `checking-allowance`(allowance 응답 붙잡기 중), `allowance-error`(allowance 읽기 실패)를 하나씩 반복한다
     * @when primary-button[data-state]가 표본 상태가 되기를 기다린다
     * @then primary-button[data-state]가 표본 상태다
     * @then network-fee가 없다
     */
    it(
      "[EC-8] 주 버튼이 수수료 대상 네 상태 밖이면 수수료 행이 없다",
      async () => {
        const states = [
          "select-token",
          "enter-amount",
          "insufficient-balance",
          "quoting",
          "no-route",
          "quote-error",
          "price-impact-too-high",
          "amount-too-small",
          "checking-allowance",
          "allowance-error",
        ] as const;
        const ethToUsdc = { tokenIn: NATIVE_ETH, tokenOut: ETHEREUM_USDC, amount: "1" };
        const usdcToDai = { tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_DAI, amount: "1" };
        for (const [index, state] of states.entries()) {
          const label = state;
          if (index > 0) resetSample();
          rpc.setNetworkFeeRule(literalFeeRule());
          rpc.setQuoteRule(parityQuoteRule);
          let gate: HoldGate | undefined;
          switch (state) {
            case "insufficient-balance":
              rpc.setBalances(ethBalanceRule(ONE_ETH));
              break;
            case "quoting":
              gate = rpc.holdQuote();
              break;
            case "no-route":
              rpc.setQuoteRule(NO_ROUTE_QUOTE_RULE);
              break;
            case "quote-error":
              rpc.failQuoteWhen(matchQuote.input());
              break;
            case "price-impact-too-high":
              rpc.setQuoteRule(ERROR_IMPACT_QUOTE_RULE);
              rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
              break;
            case "amount-too-small":
              rpc.setQuoteRule(DUST_OUT_QUOTE_RULE);
              rpc.setAllowances(allowanceAlways(STUB_MAX_UINT256));
              break;
            case "checking-allowance":
              gate = rpc.holdAllowance();
              break;
            case "allowance-error":
              rpc.failAllowanceWhen(matchAllowance.any);
              break;
            default:
              break;
          }

          await renderMockApp();
          if (state === "enter-amount") {
            await chooseToken("out", ETHEREUM_USDC);
          } else if (state === "insufficient-balance") {
            await enterPair({ ...ethToUsdc, amount: "2" });
          } else if (state === "quoting" || state === "no-route" || state === "quote-error") {
            await enterPair(ethToUsdc);
          } else if (state !== "select-token") {
            await enterPair(usdcToDai);
          }
          if (gate) {
            await waitUntil(
              () => expect(gate!.heldCount, label).toBeGreaterThanOrEqual(1),
              READY_TIMEOUT_MS,
            );
          }
          await waitPrimary(state, label);
          await settlePendingWork();

          expect(primaryState(), label).toBe(state);
          expect(networkFee(), label).toBeNull();
          gate?.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-9
     * @given mock 커넥터·스텁 지갑으로 Ethereum에 연결돼 있고 시작 전 network-fee가 있음을 확인한다. 표본: 보내는 USDC(allowance 0)·받는 DAI(`approve-required`), 보내는 ETH·받는 USDC(`swap-ready`), 보내는 ETH·받는 WETH(`wrap-ready`), 보내는 WETH·받는 ETH(`unwrap-ready`) 각각에서 지갑 서명 응답을 붙잡음(`awaiting-signature`)과 서명 뒤 영수증을 붙잡음(`approving`·`swapping`·`wrapping`·`unwrapping`)을 하나씩 반복한다
     * @when 주 버튼을 누르고 primary-button[data-state]가 표본 phase가 되기를 기다린다
     * @then primary-button[data-state]가 표본 phase다
     * @then network-fee가 없다
     */
    it(
      "[EC-9] 서명 대기와 approve·swap·wrap·unwrap pending 중에는 수수료 행이 없다",
      async () => {
        const PROGRESS_BY_KIND: Record<FeeKind, string> = {
          approve: "approving",
          swap: "swapping",
          wrap: "wrapping",
          unwrap: "unwrapping",
        };
        const inputs: InputSample[] = [
          APPROVE_USDC_DAI,
          SWAP_ETH_USDC,
          WRAP_ETH_WETH,
          UNWRAP_WETH_ETH,
        ];
        const phases = ["awaiting-signature", "pending"] as const;
        let count = 0;
        for (const input of inputs) {
          for (const phaseSample of phases) {
            const expected =
              phaseSample === "awaiting-signature"
                ? "awaiting-signature"
                : PROGRESS_BY_KIND[input.kind];
            const label = `${input.label} ${expected}`;
            if (count > 0) resetSample();
            count += 1;
            rpc.setNetworkFeeRule(literalFeeRule());
            prepareInput(input);

            const app = await renderStubWalletApp();
            await enterPair(input);
            await waitPrimary(input.state, label);
            await waitFeeState("success", label);
            // 전제: 누르기 전에는 수수료 행이 있다.
            expect(networkFee(), label).not.toBeNull();

            if (phaseSample === "awaiting-signature") {
              const sendGate = app.wallet.hold();
              clickPrimary();
              await waitUntil(() => {
                expect(sendGate.heldCount, label).toBe(1);
                expect(primaryState(), label).toBe(expected);
              }, READY_TIMEOUT_MS);
            } else {
              const receiptGate = rpc.holdReceipt();
              clickPrimary();
              await waitUntil(() => {
                expect(receiptGate.heldCount, label).toBeGreaterThan(0);
                expect(primaryState(), label).toBe(expected);
              }, READY_TIMEOUT_MS);
            }
            await settlePendingWork();

            expect(primaryState(), label).toBe(expected);
            expect(networkFee(), label).toBeNull();
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });
});
