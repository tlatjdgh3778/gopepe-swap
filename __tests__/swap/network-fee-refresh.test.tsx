import { useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { type WagmiConfig, createWagmiConfig } from "@/config/wagmi";

import {
  type BalanceFn,
  type BalanceRpcRequest,
  type BalanceRpcStub,
  type NetworkFeeFailure,
  type NetworkFeeTxFilter,
  type QuoteRule,
  type RequestMatcher,
  type StubFeeTier,
  DEFAULT_SQRT_PRICE_X96_AFTER,
  STUB_Q96,
  defaultBalance,
  installBalanceRpcStub,
  match,
  matchNetworkFee,
  matchUsdPrice,
  networkFeeRuleWith,
  parityQuoteRule,
  sameAddress,
  shiftQuoteAmounts,
  stubGasVaryingByInput,
} from "../support/rpc-balance-stub";
import {
  type StubEip1193,
  createStubEip1193,
  installWalletTransactions,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeClockInSteps,
  advanceFakeTimeTo,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
  yieldToPendingWork,
} from "../support/wagmi-harness";

// 골격(T-10). 네트워크 수수료 행(network-fee)이 쓰는 추정(eth_estimateGas, Base는 getL1Fee 포함)·가스 가격(eth_gasPrice)·
// F10 ETH 잔액·F10 ETH 단가 요청의 갱신 시점, 평시 요청 수, 실패 무재시도·마지막 값 유지, 체인·계정·키 전환 경합을
// 앱 화면(network-fee의 data-state·data-kind·data-fee-wei·data-usd-micros, network-fee-eth-shortage)과 요청 기록으로 확인한다.
//
// mock 경계(사용자 확정 2026-11-22): F9 경계(실제 wagmi·Provider·화면, wagmi mock 커넥터, 계정 변경 표본만 스텁 EIP-1193 지갑,
// 전역 fetch의 URL 라우팅 스텁, `vi.mock` 금지)에 수수료 3분류(eth_estimateGas·eth_gasPrice·getL1Fee) 스텁 응답·revert(code 3)·
// JSON-RPC 실패·프록시 HTTP 429 응답·붙잡기, 가짜 타이머, `document.visibilityState` 스텁을 더한 것.
// 테스트 쪽 관찰(앱 QueryClient 안의 탐침 쿼리)을 포커스 복귀 양성 대조로 쓴다(DoD-38).
// approve 전송이 필요한 EC-13도 스텁 EIP-1193 지갑을 쓴다(wagmi mock 커넥터는 전송을 체인 기본 RPC URL로 보내 스텁 밖으로 나간다).
// 그 밖의 provider·훅·컴포넌트는 실제 코드를 쓴다.
// 증명하지 못하는 것: 실제 브라우저의 타이머 스로틀링, 실제 노드의 추정값.
// 데이터 격리: 테스트(표본)마다 config·RPC 스텁·QueryClient를 새로 만들고 쿠키를 지운다. 가짜 타이머는 테스트(표본)마다 원복한다.
//
// 요청 집계(JSON-RPC 메서드별 항목 수. 배치 배열은 항목마다 센다. 선택 체인의 `/api/rpc/[chainId]`로 간 요청만 센다.
// 예외: DoD-39 Base 표본은 체인 경로 판정을 위해 `/api/rpc/*` 전체를 센다. DoD-36 chainId 표본은 체인 전환 뒤 기록된 요청(기록 순번 기준)만
// 센다):
// - "eth_estimateGas 요청": method `eth_estimateGas` 항목
// - "eth_gasPrice 요청": method `eth_gasPrice` 항목
// - "getL1Fee 요청": method `eth_call`이고 대상이 GasPriceOracle `0x420000000000000000000000000000000000000F`,
//   selector가 `getL1Fee(bytes)`인 항목
// - "ETH 잔액 요청": method `eth_getBalance`이고 주소 인자가 연결 계정인 항목. 모달 목록 잔액 일괄 읽기도 `eth_getBalance`를
//   보내므로 토큰 선택 모달이 닫힌 뒤부터 센다
// - "ETH 단가 요청": 단가 aggregate3(첫 하위 호출이 QuoterV2 `quoteExactInputSingle`인 Multicall3 `eth_call`)를 디코드한
//   대상 토큰이 선택 체인 WETH(Ethereum `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, Base `0x4200000000000000000000000000000000000006`)인 항목
// - "F10 요청": eth_estimateGas·eth_gasPrice·getL1Fee 요청 전부, 그리고 양쪽 토큰이 모두 ETH가 아닐 때의 ETH 잔액 요청,
//   양쪽 칸의 단가 주소가 모두 WETH가 아닐 때의 ETH 단가 요청. 견적·allowance·카드 `balanceOf`·카드 단가 요청은 F10 요청이 아니다
// 모달 일괄 단가 조회가 집계에 섞이지 않도록 토큰 선택 모달의 목록 잔액은 0으로 읽게 한다(usd-price-refresh와 같은 방식).
// 스텁은 체인·계정·kind·토큰·금액마다 다른 가스, 체인마다 다른 가스 가격·L1 수수료를 돌려줘 어느 응답으로 계산한 feeWei인지
// data-fee-wei로 구분한다. 기대 feeWei는 테스트 쪽에서 `가스 × 가스 가격 (+ L1 수수료)`로 계산한다. 주소 기대값은 리터럴이다.
// 60초 주기 판정은 주기 타이머(setInterval·clearInterval)와 시계(Date)를 가짜로 두고, 그 요청의 첫 요청 시각부터 시계를 진행한다.
// 재시도 없음(EC-5) 판정은 관찰 구간이 재시도 지연(TanStack 기본 1·2·4초, viem HTTP 재시도 150·300·600ms)을 덮어야 한다.
// 이전 값이 한 번도 나타나지 않았는지는 커밋마다 network-fee의 data-kind·data-fee-wei와 network-fee-eth-shortage 유무를 기록해 판정한다.
//
// 토큰 주소(리터럴): Ethereum USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`,
// DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F`, LINK `0x514910771AF9Ca656af840dff83E8264EcF986CA`,
// Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Base DAI `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb`.

const CASE_TIMEOUT_MS = 120_000;
const MULTI_SAMPLE_TIMEOUT_MS = 600_000;
// 응답·화면 반영을 기다리는 실제 시간 상한
const WAIT_MS = 20_000;

// 스펙 값: 가스 가격과 F10 ETH 잔액의 주기 60초(DoD-37, DoD-39)
const GAS_PRICE_REFETCH_MS = 60_000;
// 기존 계약: F3 견적 주기 15초, F2 카드 잔액 주기 15초, F3 견적 입력 반영 대기 300ms
const QUOTE_REFETCH_MS = 15_000;
const CARD_BALANCE_REFETCH_MS = 15_000;
const QUOTE_DEBOUNCE_MS = 300;
// 재시도 관찰 구간(실제 시간). TanStack 기본 재시도의 첫 지연(1초)과 viem HTTP 재시도 지연의 합(150 + 300 + 600ms)보다 길다.
// 어느 쪽이든 재시도가 있으면 이 구간 안에 같은 요청이 한 건 이상 더 나간다.
const RETRY_OBSERVATION_MS = 2_000;

const MAX_UINT256 = 2n ** 256n - 1n;
const ONE_ETH = 10n ** 18n;

// ─── 주소(리터럴) ──────────────────────────────────────────────────

const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_LINK: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_DAI: Address = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const WETH_BY_CHAIN: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  [base.id]: "0x4200000000000000000000000000000000000006",
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
// 체인별 RPC 프록시 경로(리터럴)
const RPC_PATH_BY_CHAIN: Record<SupportedChainId, string> = {
  [mainnet.id]: "/api/rpc/1",
  [base.id]: "/api/rpc/8453",
  [arbitrum.id]: "/api/rpc/42161",
};

// ─── 수수료 스텁 응답(리터럴)과 기대값(테스트 쪽 계산) ─────────────────────

// 체인별 가스 가격(체인마다 다르다)
const GAS_PRICE_BY_CHAIN: Record<SupportedChainId, bigint> = {
  [mainnet.id]: 3_000_000_017n,
  [base.id]: 7_000_003n,
  [arbitrum.id]: 11_000_021n,
};
// Base L1 데이터 수수료(wei)
const L1_FEE = 2_345_678_901n;
// 추정은 체인·계정·kind·토큰·금액·approve 금액·fee tier마다 다른 gas로 응답한다(`stubGasVaryingByInput`).
const FEE_RULE = networkFeeRuleWith({
  estimateGas: (query) => ({ status: "ok", gas: stubGasVaryingByInput(query) }),
  gasPrice: (query) => GAS_PRICE_BY_CHAIN[query.chainId],
  l1Fee: () => L1_FEE,
});

// 추정 요청 하나로 테스트가 계산한 feeWei: gas × 가스 가격(+ Base는 L1 수수료). 요청이 아직 응답되지 않았어도 계산한다.
function expectedFeeWei(request: BalanceRpcRequest): string {
  if (!request.estimateGas) throw new Error(`${request.seq}번 요청이 추정 요청이 아니다`);
  const gas = stubGasVaryingByInput({ ...request.estimateGas, chainId: request.chainId });
  const l1Fee = request.chainId === base.id ? L1_FEE : 0n;
  return (gas * GAS_PRICE_BY_CHAIN[request.chainId] + l1Fee).toString();
}

// `best` 티어의 수령량이 가장 많은 견적 규칙(가격 영향 0). 나머지 티어는 수령량이 1% 적다.
function bestTierQuoteRule(best: StubFeeTier): QuoteRule {
  return {
    quote: (query) => ({
      status: "ok",
      amountOut: query.fee === best ? query.amountIn : (query.amountIn * 99n) / 100n,
      sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
    }),
    slot0: () => ({ status: "ok", sqrtPriceX96: STUB_Q96 }),
  };
}

// ─── 스텁 상태 ─────────────────────────────────────────────────────

let rpc: BalanceRpcStub;
// 카드 잔액 규칙(토큰 선택 모달의 목록 잔액 읽기 동안만 0으로 바꾼다)
let cardBalances: BalanceFn = defaultBalance;
// 토큰(소문자 주소)별 allowance. 없으면 2^256-1
let allowanceByToken = new Map<string, bigint>();
// 커밋마다 호출할 관찰 함수
let onCommitHook: (() => void) | null = null;
// 포커스 복귀 탐침 쿼리의 queryFn 호출 수
let focusProbeCalls = 0;

const ZERO_BALANCES: BalanceFn = () => 0n;

function prepareStub() {
  focusProbeCalls = 0;
  cardBalances = defaultBalance;
  allowanceByToken = new Map();
  rpc.setBalances(cardBalances);
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setNetworkFeeRule(FEE_RULE);
  rpc.setAllowances((query) => allowanceByToken.get(query.token.toLowerCase()) ?? MAX_UINT256);
}

function setAllowance(token: Address, value: bigint) {
  allowanceByToken.set(token.toLowerCase(), value);
}

function setCardBalances(fn: BalanceFn) {
  cardBalances = fn;
  rpc.setBalances(fn);
}

beforeEach(() => {
  rpc = installBalanceRpcStub();
  prepareStub();
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
  prepareStub();
}

// 주기 타이머(setInterval·clearInterval)와 시계(Date)만 가짜로 둔다. setTimeout은 실제 타이머다.
function fakePeriodicTimers() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
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

function cardBalanceRaw(side: Side): string | null {
  return within(field(side)).queryByTestId("balance")?.getAttribute("data-balance-raw") ?? null;
}

function minimumRaw(): string | null {
  return (
    screen.queryByTestId("quote-amount-out-minimum")?.getAttribute("data-amount-out-minimum-raw") ??
    null
  );
}

function networkFee(): HTMLElement | null {
  return screen.queryByTestId("network-fee");
}

function feeState(): string | null {
  return networkFee()?.getAttribute("data-state") ?? null;
}

function feeKind(): string | null {
  return networkFee()?.getAttribute("data-kind") ?? null;
}

function feeWei(): string | null {
  return networkFee()?.getAttribute("data-fee-wei") ?? null;
}

function hasShortage(): boolean {
  return screen.queryByTestId("network-fee-eth-shortage") !== null;
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

// 모달 목록 잔액을 모두 0으로 읽게 하고 토큰을 고른다(모달 일괄 단가 조회 대상이 없다).
// 목록 잔액이 행에 반영된 뒤 카드 잔액 규칙으로 되돌리고 행을 누른다.
async function chooseToken(side: Side, address: Address) {
  rpc.setBalances(ZERO_BALANCES);
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side), WAIT_MS);
  await waitUntil(
    () => expect(optionRow(address).getAttribute("data-balance-raw")).toBe("0"),
    WAIT_MS,
  );
  rpc.setBalances(cardBalances);
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull(), WAIT_MS);
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value), WAIT_MS);
}

// 보내는 칸(ETH가 아니면 모달에서 고름)과 받는 칸을 고르고 금액을 입력한다. 처음 보내는 칸은 ETH다.
async function enterPair(tokenIn: Address, tokenOut: Address, amount: string) {
  if (!sameAddress(tokenIn, NATIVE_ETH)) await chooseToken("in", tokenIn);
  await chooseToken("out", tokenOut);
  await typeAmount(amount);
}

async function waitPrimary(state: string, label?: string) {
  await waitUntil(() => expect(primaryState(), label).toBe(state), WAIT_MS);
}

async function waitFeeSuccess(kind: string, label?: string) {
  await waitUntil(() => {
    expect(feeState(), label).toBe("success");
    expect(feeKind(), label).toBe(kind);
  }, WAIT_MS);
  await settlePendingWork();
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"));
  });
}

// `document.visibilityState`를 스텁하고 `visibilitychange`를 TanStack focusManager가 듣는 window 리스너까지 전달되게 보낸다
// (document에서 bubbling으로 보내 window에 닿는다). afterEach·resetSample의 restoreAllMocks가 스텁을 되돌린다.
function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  vi.spyOn(document, "hidden", "get").mockReturnValue(state === "hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
}

// ─── 커밋 기록 ──────────────────────────────────────────────────────

type FeeSnapshot = {
  state: string | null;
  kind: string | null;
  feeWei: string | null;
  usdMicros: string | null;
  severity: string | null;
  skeleton: boolean;
  shortage: boolean;
  // 커밋 시점의 선택 체인(chain-select[data-selected-chain-id])
  selectedChainId: string | null;
  // 커밋 시점의 연결 계정
  account: Address | undefined;
};

function feeSnapshot(config: WagmiConfig): FeeSnapshot {
  const fee = document.querySelector('[data-testid="network-fee"]');
  return {
    state: fee?.getAttribute("data-state") ?? null,
    kind: fee?.getAttribute("data-kind") ?? null,
    feeWei: fee?.getAttribute("data-fee-wei") ?? null,
    usdMicros: fee?.getAttribute("data-usd-micros") ?? null,
    severity: fee?.getAttribute("data-severity") ?? null,
    skeleton: document.querySelector('[data-testid="network-fee-skeleton"]') !== null,
    shortage: document.querySelector('[data-testid="network-fee-eth-shortage"]') !== null,
    selectedChainId:
      document
        .querySelector('[data-testid="chain-select"]')
        ?.getAttribute("data-selected-chain-id") ?? null,
    account: getConnection(config).address,
  };
}

// 지금부터 커밋마다 수수료 행 상태를 기록한다(React Profiler가 커밋 직후 동기로 호출한다).
function recordCommits(config: WagmiConfig): FeeSnapshot[] {
  const commits: FeeSnapshot[] = [];
  onCommitHook = () => {
    commits.push(feeSnapshot(config));
  };
  return commits;
}

// ─── 렌더 ─────────────────────────────────────────────────────────

const FOCUS_PROBE_QUERY_KEY = ["network-fee-refresh-focus-probe"] as const;

// 앱 QueryClient 안의 테스트 쪽 탐침 쿼리. `staleTime` 0이고 `refetchOnWindowFocus`는 기본값이라
// TanStack이 포커스 복귀를 받으면 queryFn이 한 번 더 불린다(DoD-38 양성 대조).
function useFocusProbe() {
  useQuery({
    queryKey: FOCUS_PROBE_QUERY_KEY,
    queryFn: () => {
      focusProbeCalls += 1;
      return focusProbeCalls;
    },
    staleTime: 0,
    retry: false,
  });
}

type App = { config: WagmiConfig; stub: StubEip1193 | null };

function renderWith(config: WagmiConfig) {
  renderAppHook(useFocusProbe, {
    config,
    initialChainId: mainnet.id,
    onCommit: () => onCommitHook?.(),
  });
}

async function waitConnected(config: WagmiConfig) {
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(sameAddress(connection.address, TEST_ACCOUNT)).toBe(true);
    // 보내는 ETH, 받는 칸 미선택
    expect(primaryState()).toBe("select-token");
  }, WAIT_MS);
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱(선택 체인 Ethereum, 보내는 ETH, 받는 칸 미선택)
async function renderMockApp(): Promise<App> {
  const config = createWagmiConfig({
    connectors: [mockConnector({ defaultConnected: true, reconnect: true })],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  renderWith(config);
  await waitConnected(config);
  return { config, stub: null };
}

// 스텁 EIP-1193 지갑으로 Ethereum에 연결된 앱. 계정 변경(accountsChanged)과 지갑 전송(해시 응답)을 쓴다.
async function renderStubApp(): Promise<App> {
  const stub = createStubEip1193({
    chainId: mainnet.id,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  installWalletTransactions(stub);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  renderWith(config);
  await waitConnected(config);
  return { config, stub };
}

// ─── 요청 기록 ──────────────────────────────────────────────────────

// 다음에 기록될 요청의 순번
function nextSeq(): number {
  return rpc.requests().length;
}

function estimates(chainId: SupportedChainId, filter: NetworkFeeTxFilter = {}) {
  return rpc.requests(match.chain(chainId, matchNetworkFee.estimateGas(filter)));
}

function estimatesSince(seq: number, filter: NetworkFeeTxFilter = {}) {
  return rpc.requests(match.since(seq, matchNetworkFee.estimateGas(filter)));
}

function gasPrices(chainId: SupportedChainId) {
  return rpc.requests(match.chain(chainId, matchNetworkFee.gasPrice));
}

function l1Fees(chainId: SupportedChainId) {
  return rpc.requests(match.chain(chainId, matchNetworkFee.l1Fee()));
}

// 연결 계정의 `eth_getBalance`
function ethBalances(chainId: SupportedChainId, sinceSeq = 0, account: Address = TEST_ACCOUNT) {
  return rpc.requests(
    match.since(
      sinceSeq,
      match.chain(chainId, match.account(account, match.kind("eth_getBalance"))),
    ),
  );
}

// 대상 토큰이 선택 체인 WETH인 단가 aggregate3
function ethPrices(chainId: SupportedChainId, sinceSeq = 0) {
  return rpc.requests(
    match.since(sinceSeq, match.chain(chainId, matchUsdPrice.target(WETH_BY_CHAIN[chainId]))),
  );
}

function quotes(chainId: SupportedChainId) {
  return rpc.requests(match.chain(chainId, match.kind("quote")));
}

// F10 요청(양쪽 토큰이 ETH·WETH가 아닌 입력): 수수료 3분류, 연결 계정 ETH 잔액, ETH 단가
function f10Request(chainId: SupportedChainId): RequestMatcher {
  const ethPrice = matchUsdPrice.target(WETH_BY_CHAIN[chainId]);
  return match.chain(
    chainId,
    (request) =>
      matchNetworkFee.any(request) ||
      (request.kind === "eth_getBalance" && sameAddress(request.account, TEST_ACCOUNT)) ||
      ethPrice(request),
  );
}

// 기록된 요청이 모두 응답될 때까지 기다린다(붙잡은 요청이 없을 때만 쓴다).
async function waitRequestsSettled() {
  await waitUntil(
    () => expect(rpc.requests().every((request) => request.status !== "pending")).toBe(true),
    WAIT_MS,
  );
  await settlePendingWork();
}

function requestBySeq(seq: number): BalanceRpcRequest {
  const found = rpc.requests().find((request) => request.seq === seq);
  if (!found) throw new Error(`${seq}번 요청이 없다`);
  return found;
}

describe("네트워크 수수료 — 입력이 같으면 요청을 아끼고, 바뀌면 새 값만 보인다", () => {
  describe("같은 입력에서 수수료 값을 다시 읽는 경우", () => {
    /**
     * @spec DoD-35
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`로 주 버튼이 `swap-ready`이고 network-fee가 `data-kind=swap`·`data-state=success`다. 스텁은 다음 견적 응답의 수령량(같은 fee tier)을 바꿔 최소 수령량이 바뀌게 한다. eth_estimateGas 요청 수를 기록해 둔다
     * @when 가짜 시계를 견적 15초 갱신 시점까지 진행하고 quote-amount-out-minimum의 data-amount-out-minimum-raw가 바뀌기를 기다린다
     * @then 최소 수령량이 바뀐 뒤 대기 중인 비동기 작업을 정리하고 견적 입력 반영 대기(300ms)보다 긴 구간을 지나도 eth_estimateGas 요청 수가 늘지 않는다
     */
    it(
      "[DoD-35] 견적 15초 갱신으로 최소 수령량만 바뀌면 추정을 다시 보내지 않는다",
      async () => {
        fakePeriodicTimers();
        await renderMockApp();
        await enterPair(NATIVE_ETH, ETHEREUM_DAI, "1");
        await waitPrimary("swap-ready");
        await waitFeeSuccess("swap");
        await waitRequestsSettled();
        const minimumBefore = minimumRaw();
        expect(minimumBefore, "전제: 최소 수령량").not.toBeNull();
        const estimatesBefore = estimates(mainnet.id).length;
        expect(estimatesBefore, "전제: 추정 요청").toBeGreaterThan(0);
        // 다음 견적 응답의 수령량만 바꾼다. 네 티어의 수령량이 함께 같은 양만큼 줄어 고르는 fee tier는 그대로다.
        rpc.setQuoteRule(shiftQuoteAmounts(parityQuoteRule, -1_000n));
        const lastQuoteAt = quotes(mainnet.id).at(-1)!.at;

        await advanceFakeTimeTo(lastQuoteAt + QUOTE_REFETCH_MS);
        await waitUntil(() => expect(minimumRaw()).not.toBe(minimumBefore), WAIT_MS);
        await settlePendingWork();
        // 추정 요청이 나갈 수 있는 구간: 대기 중인 비동기 작업 정리 + 견적 입력 반영 대기(300ms)보다 긴 실제 시간
        await yieldToPendingWork(QUOTE_DEBOUNCE_MS + 200);
        await settlePendingWork();
        expect(estimates(mainnet.id).length, "최소 수령량이 바뀐 뒤 추정 요청 수").toBe(
          estimatesBefore,
        );
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-37
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`로 주 버튼이 `swap-ready`이고 network-fee가 `data-state=success`다. Ethereum eth_gasPrice 요청 수를 기록해 둔다. 주기 관찰 뒤 단계의 표본 키 요소 변경: 금액을 `2`로 바꿈, 받는 칸 모달에서 LINK를 고름, kind(보내는 칸을 allowance 0이고 잔액이 금액 이상인 USDC로 바꿔 `approve-required`이고 network-fee가 `data-kind=approve`·`success`가 된 뒤, 스텁 allowance를 금액보다 크게 바꾸고 window `focus` 이벤트로 allowance를 다시 읽혀 `swap-ready`가 됨. DoD-36 kind 표본과 같은 경로이며 이 표본의 변경 시점은 `focus` 이벤트다)를 차례로 일으킨다
     * @when 입력을 바꾸지 않고 가짜 시계를 첫 eth_gasPrice 요청 시각부터 60초 직전까지, 이어서 60초까지, 다시 60초(120초까지) 진행한다. 그 뒤 가짜 시계를 더 진행하지 않고 표본 키 요소 변경마다 변경 직전의 eth_estimateGas·eth_gasPrice 요청 수를 기록하고 변경을 일으켜 network-fee가 다시 `data-state=success`가 되기를 기다린다(kind 표본은 `data-kind=swap`·`success`)
     * @then 60초 직전까지 eth_gasPrice 요청 수가 늘지 않는다
     * @then 60초가 지나면 eth_gasPrice 요청이 1건 는다
     * @then 다시 60초가 지나면 eth_gasPrice 요청이 1건 더 는다
     * @then 120초 관찰 뒤 표본 키 요소 변경마다 변경부터 network-fee `success`까지 eth_estimateGas 요청은 1건 이상 늘고(양성 대조) eth_gasPrice 요청 수는 늘지 않는다
     */
    it(
      "[DoD-37] 가스 가격은 체인별 하나의 쿼리로 60초마다 다시 읽는다",
      async () => {
        fakePeriodicTimers();
        // kind 표본에서 보내는 칸을 USDC로 바꾸면 allowance 0으로 `approve-required`가 된다.
        setAllowance(ETHEREUM_USDC, 0n);
        await renderMockApp();
        await enterPair(NATIVE_ETH, ETHEREUM_DAI, "1");
        await waitPrimary("swap-ready");
        await waitFeeSuccess("swap");
        await waitRequestsSettled();
        const start = gasPrices(mainnet.id)[0]!.at;
        const before = gasPrices(mainnet.id).length;

        await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS - 1);
        await settlePendingWork();
        expect(gasPrices(mainnet.id).length, "60초 직전").toBe(before);

        await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS);
        await waitUntil(
          () => expect(gasPrices(mainnet.id).length).toBeGreaterThanOrEqual(before + 1),
          WAIT_MS,
        );
        await waitRequestsSettled();
        expect(gasPrices(mainnet.id).length, "60초").toBe(before + 1);

        await advanceFakeTimeTo(start + 2 * GAS_PRICE_REFETCH_MS);
        await waitUntil(
          () => expect(gasPrices(mainnet.id).length).toBeGreaterThanOrEqual(before + 2),
          WAIT_MS,
        );
        await waitRequestsSettled();
        expect(gasPrices(mainnet.id).length, "120초").toBe(before + 2);

        // 120초 관찰 뒤: 가짜 시계를 더 진행하지 않고 키 요소를 차례로 바꾼다.
        const steps: {
          label: string;
          prepare?: () => Promise<void>;
          change: () => Promise<void>;
        }[] = [
          { label: "금액 2", change: () => typeAmount("2") },
          { label: "받는 LINK", change: () => chooseToken("out", ETHEREUM_LINK) },
          {
            label: "kind",
            prepare: async () => {
              await chooseToken("in", ETHEREUM_USDC);
              await waitPrimary("approve-required", "kind 전제");
              await waitFeeSuccess("approve", "kind 전제");
              setAllowance(ETHEREUM_USDC, MAX_UINT256);
            },
            change: async () => focusWindow(),
          },
        ];
        for (const step of steps) {
          if (step.prepare) await step.prepare();
          await waitRequestsSettled();
          const seq = nextSeq();
          const gasPricesBefore = gasPrices(mainnet.id).length;
          await step.change();
          await waitUntil(() => {
            expect(
              estimatesSince(seq).some((request) => request.status === "ok"),
              step.label,
            ).toBe(true);
            expect(primaryState(), step.label).toBe("swap-ready");
            expect(feeState(), step.label).toBe("success");
            expect(feeKind(), step.label).toBe("swap");
          }, WAIT_MS);
          await waitRequestsSettled();
          expect(estimatesSince(seq).length, `${step.label}: 추정 요청(양성 대조)`).toBeGreaterThan(
            0,
          );
          expect(gasPrices(mainnet.id).length, `${step.label}: 가스 가격 요청`).toBe(
            gasPricesBefore,
          );
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-38
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI, 금액 `1`로 주 버튼이 `swap-ready`이며 network-fee가 `data-state=success`다. `visibilitychange` 이벤트는 TanStack focusManager가 듣는 window 리스너까지 전달되는 방식으로 보낸다. 표본 포커스 계기: (가) window `focus` 이벤트(60초 주기 전), (나) `document.visibilityState`를 `hidden`으로 스텁하고 `visibilitychange`를 보낸 뒤 `visible`로 스텁하고 다시 `visibilitychange`를 보냄(60초 주기 전), (다) 가짜 타이머(setInterval·clearInterval·Date)를 쓰고 (나)처럼 `hidden`으로 바꾼 뒤 가짜 시계를 첫 eth_gasPrice 요청 시각부터 60초를 넘게 진행하고 `visible`로 스텁하고 `visibilitychange`를 보냄(가스 가격이 stale인 상태의 포커스 복귀)을 하나씩 반복한다. (나)·(다) 표본은 앱 QueryClient 안에 `staleTime` 0·`refetchOnWindowFocus` 기본값인 테스트 쪽 탐침 쿼리를 렌더해 두거나 TanStack focusManager 구독을 걸어 둔다. 표본마다 계기 직전의 견적·eth_estimateGas·eth_gasPrice 요청 수와 탐침 관찰 값을 기록해 둔다
     * @when 표본 계기를 일으키고, (가)는 견적 요청이 1건 늘기를 기다리고, (나)·(다)는 탐침이 포커스 복귀를 받기를 기다린 뒤 대기 중인 비동기 작업을 정리한다. (다)는 이어서 가짜 시계를 첫 eth_gasPrice 요청 시각에서 시작한 60초 주기의 다음 tick(첫 요청 시각 + 60초의 배수 중 `visible`로 바꾼 시각 뒤 첫 시각. `visible` 시각 + 60초가 아니다) 직전까지 진행한다
     * @then (가)에서 견적 요청이 1건 는다(양성 대조)
     * @then (나)·(다)에서 같은 계기로 TanStack이 포커스 복귀를 받는다(양성 대조: 탐침 쿼리의 queryFn 호출이 1회 늘거나 focusManager의 focused=true 통지가 1회 온다)
     * @then 그 뒤에도 eth_estimateGas 요청 수가 계기 직전 그대로다
     * @then 그 뒤에도 eth_gasPrice 요청 수가 계기 직전 그대로다((다)는 첫 eth_gasPrice 요청 시각에서 시작한 주기의 다음 tick 직전까지 그대로다)
     */
    it(
      "[DoD-38] 창 포커스로는 추정과 가스 가격을 다시 보내지 않는다",
      async () => {
        const samples = ["window focus", "visibilitychange", "visibilitychange(stale)"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          if (sample === "visibilitychange(stale)") fakePeriodicTimers();
          await renderMockApp();
          await enterPair(NATIVE_ETH, ETHEREUM_DAI, "1");
          await waitPrimary("swap-ready", sample);
          await waitFeeSuccess("swap", sample);
          await waitRequestsSettled();
          const counts = () => ({
            quote: quotes(mainnet.id).length,
            estimate: estimates(mainnet.id).length,
            gasPrice: gasPrices(mainnet.id).length,
          });

          if (sample === "window focus") {
            const before = counts();
            focusWindow();
            await waitUntil(
              () => expect(quotes(mainnet.id).length).toBeGreaterThanOrEqual(before.quote + 1),
              WAIT_MS,
            );
            await waitRequestsSettled();
            expect(quotes(mainnet.id).length, `${sample}: 견적 요청(양성 대조)`).toBe(
              before.quote + 1,
            );
            expect(estimates(mainnet.id).length, `${sample}: 추정 요청`).toBe(before.estimate);
            expect(gasPrices(mainnet.id).length, `${sample}: 가스 가격 요청`).toBe(before.gasPrice);
            continue;
          }

          if (sample === "visibilitychange") {
            const before = counts();
            const probeBefore = focusProbeCalls;
            setVisibility("hidden");
            await settlePendingWork();
            setVisibility("visible");
            await waitUntil(
              () => expect(focusProbeCalls).toBeGreaterThanOrEqual(probeBefore + 1),
              WAIT_MS,
            );
            await waitRequestsSettled();
            expect(focusProbeCalls, `${sample}: 탐침 queryFn 호출(양성 대조)`).toBe(
              probeBefore + 1,
            );
            expect(estimates(mainnet.id).length, `${sample}: 추정 요청`).toBe(before.estimate);
            expect(gasPrices(mainnet.id).length, `${sample}: 가스 가격 요청`).toBe(before.gasPrice);
            continue;
          }

          // 가스 가격이 stale인 상태의 포커스 복귀
          const start = gasPrices(mainnet.id)[0]!.at;
          setVisibility("hidden");
          await settlePendingWork();
          await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS + 1_000);
          await settlePendingWork();
          const before = counts();
          const probeBefore = focusProbeCalls;
          setVisibility("visible");
          const visibleAt = Date.now();
          await waitUntil(
            () => expect(focusProbeCalls).toBeGreaterThanOrEqual(probeBefore + 1),
            WAIT_MS,
          );
          await waitRequestsSettled();
          expect(focusProbeCalls, `${sample}: 탐침 queryFn 호출(양성 대조)`).toBe(probeBefore + 1);
          expect(estimates(mainnet.id).length, `${sample}: 추정 요청`).toBe(before.estimate);
          expect(gasPrices(mainnet.id).length, `${sample}: 가스 가격 요청`).toBe(before.gasPrice);
          // 첫 eth_gasPrice 요청 시각에서 시작한 주기의 다음 tick(visible로 바꾼 시각 뒤 첫 tick) 직전까지
          const nextTick =
            start +
            (Math.floor((visibleAt - start) / GAS_PRICE_REFETCH_MS) + 1) * GAS_PRICE_REFETCH_MS;
          await advanceFakeTimeTo(nextTick - 1);
          await settlePendingWork();
          expect(estimates(mainnet.id).length, `${sample}: 다음 tick 직전 추정 요청`).toBe(
            before.estimate,
          );
          expect(gasPrices(mainnet.id).length, `${sample}: 다음 tick 직전 가스 가격 요청`).toBe(
            before.gasPrice,
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-39
     * @given 가짜 타이머를 쓰고 mock 커넥터로 지갑 체인 Ethereum에 연결돼 있다. 표본: (가) 선택 체인 Ethereum에서 보내는 USDC·받는 DAI, (나) 드롭다운으로 선택 체인만 Base로 바꾸고(지갑 체인은 Ethereum 그대로) 보내는 Base USDC·받는 Base DAI를 하나씩 반복한다. 표본마다 금액 `1`이고 스텁은 USDC allowance를 금액보다 크게 읽혀 주 버튼이 `swap-ready`, network-fee가 `data-state=success`다(양쪽 토큰 모두 ETH가 아니다). (나) 표본의 ETH 잔액 요청은 선택 체인만이 아니라 `/api/rpc/*` 전체에서 센다. 토큰 선택 모달이 닫힌 뒤 ETH 잔액 요청 수를 기록해 둔다
     * @when 가짜 시계를 모달이 닫힌 뒤 선택 체인으로 간 첫 ETH 잔액 요청 시각부터 60초 직전까지, 이어서 60초까지, 다시 60초 진행한다
     * @then 60초 직전까지 선택 체인의 ETH 잔액 요청 수가 늘지 않는다
     * @then 60초가 지나면 선택 체인의 ETH 잔액 요청이 1건 는다
     * @then 다시 60초가 지나면 선택 체인의 ETH 잔액 요청이 1건 더 는다
     * @then (나) 표본에서 모달이 닫힌 뒤 F10 ETH 잔액 요청은 모두 `/api/rpc/8453`으로 가고, `/api/rpc/1`로 간 연결 계정 `eth_getBalance`는 0건이다
     */
    it(
      "[DoD-39] 양쪽 토큰이 ETH가 아니면 F10의 ETH 잔액을 60초마다 읽는다",
      async () => {
        const samples = [
          { chainId: mainnet.id, usdc: ETHEREUM_USDC, dai: ETHEREUM_DAI },
          { chainId: base.id, usdc: BASE_USDC, dai: BASE_DAI },
        ] as const;
        for (const [index, { chainId, usdc, dai }] of samples.entries()) {
          const label = String(chainId);
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const app = await renderMockApp();
          if (chainId !== mainnet.id) await chooseChainFromDropdown(base);
          await chooseToken("in", usdc);
          await chooseToken("out", dai);
          await settlePendingWork();
          // 토큰 선택 모달이 닫힌 뒤부터 센다.
          const seq = nextSeq();
          await typeAmount("1");
          await waitPrimary("swap-ready", label);
          await waitFeeSuccess("swap", label);
          await waitRequestsSettled();
          // 전제: 지갑 체인은 Ethereum 그대로다.
          expect(getConnection(app.config).chainId, label).toBe(mainnet.id);

          const first = ethBalances(chainId, seq)[0];
          expect(first, `${label}: 첫 ETH 잔액 요청`).toBeDefined();
          const start = first!.at;
          const before = ethBalances(chainId, seq).length;

          await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS - 1);
          await settlePendingWork();
          expect(ethBalances(chainId, seq).length, `${label}: 60초 직전`).toBe(before);

          await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS);
          await waitUntil(
            () => expect(ethBalances(chainId, seq).length).toBeGreaterThanOrEqual(before + 1),
            WAIT_MS,
          );
          await waitRequestsSettled();
          expect(ethBalances(chainId, seq).length, `${label}: 60초`).toBe(before + 1);

          await advanceFakeTimeTo(start + 2 * GAS_PRICE_REFETCH_MS);
          await waitUntil(
            () => expect(ethBalances(chainId, seq).length).toBeGreaterThanOrEqual(before + 2),
            WAIT_MS,
          );
          await waitRequestsSettled();
          expect(ethBalances(chainId, seq).length, `${label}: 120초`).toBe(before + 2);

          if (chainId === base.id) {
            // 이 표본은 `/api/rpc/*` 전체에서 연결 계정 `eth_getBalance`를 센다.
            const allChains = rpc.requests(
              match.since(seq, match.account(TEST_ACCOUNT, match.kind("eth_getBalance"))),
            );
            expect(allChains.length, label).toBeGreaterThan(0);
            for (const request of allChains) {
              expect(request.url, `${label}: F10 ETH 잔액 경로`).toBe(RPC_PATH_BY_CHAIN[base.id]);
            }
            expect(
              allChains.filter((request) => request.url === RPC_PATH_BY_CHAIN[mainnet.id]),
              `${label}: /api/rpc/1 ETH 잔액`,
            ).toHaveLength(0);
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-49
     * @given 가짜 타이머를 쓰고 mock 커넥터로 연결돼 선택 체인이 Base이며 보내는 Base USDC, 받는 Base DAI, 금액 `1`이고 스텁은 allowance를 금액보다 크게 읽혀 주 버튼이 `swap-ready`, network-fee가 `data-state=success`다. 이때까지 eth_estimateGas 요청과 getL1Fee 요청이 같은 수만큼 나갔고 두 요청 수와 Base eth_gasPrice 요청 수를 기록해 둔다
     * @when 가짜 시계를 첫 eth_gasPrice 요청 시각부터 120초 진행한 뒤, 금액을 `2`로 바꿔 network-fee가 `success`가 되기를 기다린다
     * @then 120초 동안 eth_gasPrice 요청이 2건 늘고 getL1Fee 요청 수와 eth_estimateGas 요청 수는 늘지 않는다
     * @then 금액을 바꾼 뒤 eth_estimateGas 요청이 1건, getL1Fee 요청이 1건 는다
     */
    it(
      "[DoD-49] Base L1 수수료는 추정 키가 바뀔 때 추정과 함께만 읽고 60초 주기로 다시 읽지 않는다",
      async () => {
        fakePeriodicTimers();
        await renderMockApp();
        await chooseChainFromDropdown(base);
        await enterPair(BASE_USDC, BASE_DAI, "1");
        await waitPrimary("swap-ready");
        await waitFeeSuccess("swap");
        await waitRequestsSettled();
        const estimatesBefore = estimates(base.id).length;
        const l1Before = l1Fees(base.id).length;
        // 전제: 이때까지 eth_estimateGas와 getL1Fee가 같은 수만큼 나갔다.
        expect(estimatesBefore).toBeGreaterThan(0);
        expect(l1Before).toBe(estimatesBefore);
        const gasPricesBefore = gasPrices(base.id).length;
        const start = gasPrices(base.id)[0]!.at;

        await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS);
        await waitUntil(
          () => expect(gasPrices(base.id).length).toBeGreaterThanOrEqual(gasPricesBefore + 1),
          WAIT_MS,
        );
        await waitRequestsSettled();
        await advanceFakeTimeTo(start + 2 * GAS_PRICE_REFETCH_MS);
        await waitUntil(
          () => expect(gasPrices(base.id).length).toBeGreaterThanOrEqual(gasPricesBefore + 2),
          WAIT_MS,
        );
        await waitRequestsSettled();
        expect(gasPrices(base.id).length, "120초 가스 가격").toBe(gasPricesBefore + 2);
        expect(l1Fees(base.id).length, "120초 getL1Fee").toBe(l1Before);
        expect(estimates(base.id).length, "120초 추정").toBe(estimatesBefore);

        const seq = nextSeq();
        await typeAmount("2");
        await waitUntil(() => {
          expect(estimatesSince(seq).some((request) => request.status === "ok")).toBe(true);
          expect(feeState()).toBe("success");
        }, WAIT_MS);
        await waitRequestsSettled();
        expect(estimates(base.id).length, "금액 변경 뒤 추정").toBe(estimatesBefore + 1);
        expect(l1Fees(base.id).length, "금액 변경 뒤 getL1Fee").toBe(l1Before + 1);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("평시 요청 수", () => {
    /**
     * @spec DoD-34
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있다. 표본: 보내는 ETH·받는 DAI·금액 `1`(보내는 칸이 ETH), 보내는 USDC·받는 ETH·금액 `1`이고 스텁이 USDC allowance를 금액보다 크게 읽힘(받는 칸이 ETH)을 하나씩 반복한다. 표본마다 금액을 입력하기 전 ETH 칸의 카드 잔액(data-balance-raw)이 표시돼 있고 토큰 선택 모달이 닫힌 뒤 ETH 잔액 요청 수를 기록해 둔다
     * @when 금액 `1`을 입력해 주 버튼이 `swap-ready`, network-fee가 `data-state=success`가 되기를 기다린 뒤, 가짜 시계를 60초 진행한다
     * @then 금액 입력부터 network-fee `success`까지 ETH 잔액 요청 수가 늘지 않는다
     * @then 60초 동안 ETH 잔액 요청이 카드 잔액 15초 주기 몫(4건)만 는다
     */
    it(
      "[DoD-34] 한쪽 토큰이 ETH이면 ETH 부족 판정을 위해 ETH 잔액을 따로 읽지 않는다",
      async () => {
        const samples: { label: string; tokenIn: Address; tokenOut: Address; ethSide: Side }[] = [
          { label: "보내는 ETH", tokenIn: NATIVE_ETH, tokenOut: ETHEREUM_DAI, ethSide: "in" },
          { label: "받는 ETH", tokenIn: ETHEREUM_USDC, tokenOut: NATIVE_ETH, ethSide: "out" },
        ];
        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          fakePeriodicTimers();
          await renderMockApp();
          if (!sameAddress(sample.tokenIn, NATIVE_ETH)) await chooseToken("in", sample.tokenIn);
          await chooseToken("out", sample.tokenOut);
          // 전제: 금액을 입력하기 전 ETH 칸의 카드 잔액이 표시돼 있다.
          await waitUntil(
            () => expect(cardBalanceRaw(sample.ethSide), label).not.toBeNull(),
            WAIT_MS,
          );
          await waitRequestsSettled();
          const before = ethBalances(mainnet.id).length;

          await typeAmount("1");
          await waitPrimary("swap-ready", label);
          await waitFeeSuccess("swap", label);
          await waitRequestsSettled();
          expect(ethBalances(mainnet.id).length, `${label}: 금액 입력부터 success까지`).toBe(
            before,
          );

          await advanceFakeClockInSteps(GAS_PRICE_REFETCH_MS, 1_000);
          await waitRequestsSettled();
          expect(ethBalances(mainnet.id).length, `${label}: 60초`).toBe(
            before + GAS_PRICE_REFETCH_MS / CARD_BALANCE_REFETCH_MS,
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-40
     * @given 가짜 타이머를 쓰고 mock 커넥터로 연결돼 있으며 탭이 보이는 상태다(`document.visibilityState`가 `visible`). 표본 체인: Ethereum(보내는 USDC, 받는 DAI), Base(보내는 Base USDC, 받는 Base DAI)를 하나씩 반복한다. 표본마다 금액 `1`이고 스텁이 allowance를 금액보다 크게 읽혀 주 버튼이 `swap-ready`, network-fee가 `data-state=success`이며 F10 요청의 첫 요청이 모두 끝났다. 이후 입력을 바꾸지 않는다
     * @when 그 시점부터 가짜 시계를 60초 진행한다
     * @then 60초 구간의 F10 요청(eth_estimateGas·eth_gasPrice·getL1Fee·ETH 잔액·ETH 단가 요청의 합)이 4건 이하다
     */
    it(
      "[DoD-40] swap-ready에서 입력이 그대로면 F10이 더하는 요청은 60초당 4건 이하다",
      async () => {
        const samples = [
          { chainId: mainnet.id, usdc: ETHEREUM_USDC, dai: ETHEREUM_DAI },
          { chainId: base.id, usdc: BASE_USDC, dai: BASE_DAI },
        ] as const;
        for (const [index, { chainId, usdc, dai }] of samples.entries()) {
          const label = String(chainId);
          if (index > 0) resetSample();
          fakePeriodicTimers();
          // 탭이 보이는 상태
          vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
          await renderMockApp();
          if (chainId !== mainnet.id) await chooseChainFromDropdown(base);
          await enterPair(usdc, dai, "1");
          await waitPrimary("swap-ready", label);
          await waitFeeSuccess("swap", label);
          await waitRequestsSettled();
          // 전제: F10 첫 요청(추정·가스 가격)이 끝났다.
          expect(estimates(chainId).length, label).toBeGreaterThan(0);
          expect(gasPrices(chainId).length, label).toBeGreaterThan(0);

          const seq = nextSeq();
          const quotesBefore = quotes(chainId).length;
          await advanceFakeClockInSteps(GAS_PRICE_REFETCH_MS, 1_000);
          await waitRequestsSettled();
          // 전제: 가짜 시계가 진행돼 다른 주기 요청(견적 15초)이 나갔다.
          expect(quotes(chainId).length, `${label}: 견적 주기`).toBeGreaterThan(quotesBefore);

          const f10 = rpc.requests(match.since(seq, f10Request(chainId)));
          expect(f10.length, `${label}: 60초 F10 요청`).toBeLessThanOrEqual(4);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-53
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 USDC, 받는 DAI가 선택돼 있다(양쪽 토큰 모두 ETH가 아니다). 표본 주 버튼 상태: 금액이 비어 있음(`enter-amount`), 금액이 보내는 칸 잔액보다 큼(`insufficient-balance`)을 하나씩 반복한다. 표본마다 network-fee가 없고(`idle`) 토큰 선택 모달이 닫힌 뒤 ETH 잔액·ETH 단가 요청 수를 기록해 둔다
     * @when 가짜 시계를 60초 이상 진행한다
     * @then 모달이 닫힌 뒤 ETH 잔액 요청이 0건이다
     * @then 모달이 닫힌 뒤 ETH 단가 요청이 0건이다
     */
    it(
      "[DoD-53] 수수료 행이 idle이면 F10의 ETH 잔액과 ETH 단가를 읽지 않는다",
      async () => {
        const samples = ["enter-amount", "insufficient-balance"] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          fakePeriodicTimers();
          // 보내는 USDC 카드 잔액 1 USDC
          setCardBalances((query) =>
            sameAddress(query.token, ETHEREUM_USDC) ? 1_000_000n : defaultBalance(query),
          );
          await renderMockApp();
          await chooseToken("in", ETHEREUM_USDC);
          await chooseToken("out", ETHEREUM_DAI);
          await settlePendingWork();
          // 토큰 선택 모달이 닫힌 뒤부터 센다.
          const seq = nextSeq();
          if (sample === "insufficient-balance") await typeAmount("2");
          await waitPrimary(sample, sample);
          await settlePendingWork();
          expect(networkFee(), `${sample}: network-fee`).toBeNull();

          await advanceFakeClockInSteps(GAS_PRICE_REFETCH_MS + 5_000, 5_000);
          await waitRequestsSettled();
          // 전제: 그동안 계속 idle이다.
          expect(primaryState(), sample).toBe(sample);
          expect(networkFee(), `${sample}: network-fee`).toBeNull();
          expect(ethBalances(mainnet.id, seq), `${sample}: ETH 잔액 요청`).toHaveLength(0);
          expect(ethPrices(mainnet.id, seq), `${sample}: ETH 단가 요청`).toHaveLength(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("추정 키가 바뀌는 경우", () => {
    /**
     * @spec DoD-36
     * @given mock 커넥터로 Ethereum에 연결돼 있고(계정 표본은 스텁 EIP-1193) 보내는 USDC, 받는 DAI, 금액 `1`, 스텁이 allowance를 금액보다 크게 읽혀 주 버튼이 `swap-ready`이고 network-fee가 `data-state=success`다(kind 표본·approve amount 표본은 각 표본의 시작 상태를 따른다). 어느 표본도 approve·swap 트랜잭션을 보내지 않아 실행 phase가 바뀌지 않는다. eth_estimateGas 요청 수를 기록해 둔다. 표본 키 요소: chainId(드롭다운으로 Base로 바꾸고 보내는 Base USDC·받는 Base DAI·금액 `1` 입력. 이 표본은 변경 전 요청 수 기준선 대신 체인 전환 뒤 기록된 요청(기록 순번 기준)만 센다), account(연결 계정을 두 번째 계정으로 바꿈, accountsChanged), kind(USDC allowance 0으로 `approve-required`이고 network-fee가 `data-kind=approve`·`success`인 상태에서 스텁 allowance를 금액보다 크게 바꾸고 window `focus` 이벤트로 allowance를 다시 읽혀 `swap-ready`가 됨. approve amount도 함께 바뀐다), tokenIn(보내는 칸을 같은 6자리 USDT로 바꿈), tokenOut(받는 칸을 LINK로 바꿈), fee tier(스텁 견적 규칙을 바꾸고 window `focus` 이벤트로 견적을 다시 읽혀 고른 fee tier가 500에서 3000으로 바뀜, 금액은 그대로), amountInRaw(금액을 `2`로 바꿈), approve amount(보내는 USDT의 allowance가 0보다 크고 금액보다 작아 `approve(0)`을 추정한 `approve-required`이고 network-fee가 `success`인 상태에서 스텁 allowance를 0으로 바꾸고 window `focus` 이벤트로 allowance를 다시 읽혀 `approve(max)` 단계의 `approve-required`가 됨)를 하나씩 반복한다
     * @when 표본 키 요소를 바꾸고 network-fee가 `data-state=success`가 되기를 기다린다
     * @then 바꾼 뒤 eth_estimateGas 요청이 1건 이상 는다
     * @then 바꾼 뒤의 eth_estimateGas 요청에 바뀐 값이 담겨 있다(chainId는 요청 경로 `/api/rpc/8453`, account는 `from`, tokenIn·tokenOut·fee tier·amountInRaw는 디코드한 `to`·calldata, kind는 `to`가 USDC에서 라우터로·calldata가 `approve`에서 스왑으로 바뀜, approve amount는 디코드한 `approve` amount가 0에서 max로 바뀜)
     */
    it(
      "[DoD-36] 추정 키 요소 하나가 바뀌면 추정을 다시 보낸다",
      async () => {
        type Sample = {
          label: string;
          stubWallet?: boolean;
          tokenIn?: Address;
          amount?: string;
          allowances?: [Address, bigint][];
          startState?: string;
          startKind?: string;
          // 바꾸기 전 전제
          check?: () => void;
          change: (app: App) => Promise<void>;
          // 바꾼 뒤의 요청에 담겨야 하는 바뀐 값
          changed: RequestMatcher;
          endState?: string;
          endKind?: string;
        };
        const samples: Sample[] = [
          {
            label: "chainId",
            change: async () => {
              await chooseChainFromDropdown(base);
              await enterPair(BASE_USDC, BASE_DAI, "1");
            },
            changed: (request) =>
              request.url === RPC_PATH_BY_CHAIN[base.id] &&
              matchNetworkFee.estimateGas({ tokenIn: BASE_USDC, tokenOut: BASE_DAI })(request),
          },
          {
            label: "account",
            stubWallet: true,
            change: async (app) => {
              act(() => app.stub!.changeAccounts([SECOND_ACCOUNT]));
              await waitUntil(
                () =>
                  expect(sameAddress(getConnection(app.config).address, SECOND_ACCOUNT)).toBe(true),
                WAIT_MS,
              );
            },
            changed: matchNetworkFee.estimateGas({ from: SECOND_ACCOUNT }),
          },
          {
            label: "kind",
            allowances: [[ETHEREUM_USDC, 0n]],
            startState: "approve-required",
            startKind: "approve",
            check: () => {
              expect(
                estimates(mainnet.id, { kind: "approve", to: ETHEREUM_USDC }).length,
              ).toBeGreaterThan(0);
              expect(estimates(mainnet.id, { kind: "swap" })).toHaveLength(0);
            },
            change: async () => {
              setAllowance(ETHEREUM_USDC, MAX_UINT256);
              focusWindow();
            },
            changed: matchNetworkFee.estimateGas({ kind: "swap", to: ETHEREUM_ROUTER }),
          },
          {
            label: "tokenIn",
            change: () => chooseToken("in", ETHEREUM_USDT),
            changed: matchNetworkFee.estimateGas({ kind: "swap", tokenIn: ETHEREUM_USDT }),
          },
          {
            label: "tokenOut",
            change: () => chooseToken("out", ETHEREUM_LINK),
            changed: matchNetworkFee.estimateGas({ kind: "swap", tokenOut: ETHEREUM_LINK }),
          },
          {
            label: "fee tier",
            check: () => {
              expect(estimates(mainnet.id, { kind: "swap", fee: 500 }).length).toBeGreaterThan(0);
              expect(estimates(mainnet.id, { fee: 3000 })).toHaveLength(0);
            },
            change: async () => {
              rpc.setQuoteRule(bestTierQuoteRule(3000));
              focusWindow();
            },
            changed: matchNetworkFee.estimateGas({ kind: "swap", fee: 3000 }),
          },
          {
            label: "amountInRaw",
            change: () => typeAmount("2"),
            changed: matchNetworkFee.estimateGas({ kind: "swap", amountIn: 2_000_000n }),
          },
          {
            label: "approve amount",
            tokenIn: ETHEREUM_USDT,
            amount: "10",
            allowances: [[ETHEREUM_USDT, 1_000_000n]],
            startState: "approve-required",
            startKind: "approve",
            check: () => {
              expect(
                estimates(mainnet.id, { kind: "approve", approveAmount: 0n }).length,
              ).toBeGreaterThan(0);
              expect(estimates(mainnet.id, { approveAmount: MAX_UINT256 })).toHaveLength(0);
            },
            change: async () => {
              setAllowance(ETHEREUM_USDT, 0n);
              focusWindow();
            },
            changed: matchNetworkFee.estimateGas({
              kind: "approve",
              to: ETHEREUM_USDT,
              approveAmount: MAX_UINT256,
            }),
            endState: "approve-required",
            endKind: "approve",
          },
        ];
        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          rpc.setQuoteRule(bestTierQuoteRule(500));
          for (const [token, value] of sample.allowances ?? []) setAllowance(token, value);
          const app = sample.stubWallet ? await renderStubApp() : await renderMockApp();
          await enterPair(sample.tokenIn ?? ETHEREUM_USDC, ETHEREUM_DAI, sample.amount ?? "1");
          await waitPrimary(sample.startState ?? "swap-ready", label);
          await waitFeeSuccess(sample.startKind ?? "swap", label);
          await waitRequestsSettled();
          sample.check?.();

          const seq = nextSeq();
          await sample.change(app);
          await waitUntil(() => {
            expect(
              rpc
                .requests(match.since(seq, sample.changed))
                .some((request) => request.status === "ok"),
              label,
            ).toBe(true);
            expect(primaryState(), label).toBe(sample.endState ?? "swap-ready");
            expect(feeState(), label).toBe("success");
            expect(feeKind(), label).toBe(sample.endKind ?? "swap");
          }, WAIT_MS);
          await waitRequestsSettled();
          expect(estimatesSince(seq).length, `${label}: 바꾼 뒤 추정 요청`).toBeGreaterThan(0);
          expect(
            rpc.requests(match.since(seq, sample.changed)).length,
            `${label}: 바뀐 값을 담은 추정 요청`,
          ).toBeGreaterThan(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-52
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI, 금액 `1`로 주 버튼이 `swap-ready`이며 network-fee가 `data-state=success`다. 금액 `1`의 eth_estimateGas 요청(디코드한 amountIn이 `1` ETH)이 1건이다
     * @when 금액을 `2`로 바꿔 금액 `2`의 추정으로 network-fee가 `success`가 된 뒤, 다시 `1`로 바꾸고 eth_estimateGas 요청이 모두 응답되기를 기다린다(다시 추정하는 동안 금액 `1`의 마지막 값을 표시하는 것은 허용한다)
     * @then 금액 `1`로 돌아온 뒤 디코드한 amountIn이 `1` ETH인 eth_estimateGas 요청이 2건이다
     */
    it(
      "[DoD-52] 이전에 추정한 키로 돌아와도 캐시를 쓰지 않고 추정을 다시 보낸다",
      async () => {
        await renderMockApp();
        await enterPair(NATIVE_ETH, ETHEREUM_DAI, "1");
        await waitPrimary("swap-ready");
        await waitFeeSuccess("swap");
        await waitRequestsSettled();
        const amountOne = () => estimates(mainnet.id, { kind: "swap", amountIn: ONE_ETH });
        expect(amountOne(), "전제: 금액 1의 추정 요청").toHaveLength(1);

        const seq = nextSeq();
        await typeAmount("2");
        await waitUntil(() => {
          expect(
            estimatesSince(seq, { kind: "swap", amountIn: 2n * ONE_ETH }).some(
              (request) => request.status === "ok",
            ),
          ).toBe(true);
          expect(feeState()).toBe("success");
        }, WAIT_MS);
        await waitRequestsSettled();

        await typeAmount("1");
        await waitUntil(() => expect(amountOne().length).toBeGreaterThanOrEqual(2), WAIT_MS);
        await waitRequestsSettled();
        expect(amountOne(), "금액 1로 돌아온 뒤").toHaveLength(2);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("요청이 실패하는 경우", () => {
    /**
     * @spec EC-5
     * @given 가짜 타이머를 쓰고 mock 커넥터로 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`로 주 버튼이 `swap-ready`가 되는 입력이다. 표본 실패(대상 × 실패 종류): Ethereum eth_estimateGas 첫 요청이 JSON-RPC 오류·revert(code 3)·프록시 HTTP 429, Base getL1Fee 첫 요청이 JSON-RPC 오류·프록시 HTTP 429(Base에서 같은 입력), Ethereum eth_gasPrice 첫 요청이 JSON-RPC 오류·프록시 HTTP 429, Ethereum eth_gasPrice가 `success` 뒤 60초 주기 다시 읽기에서 JSON-RPC 오류·프록시 HTTP 429를 하나씩 반복한다. HTTP 429는 viem transport 재시도 대상이므로 transport 재시도를 끄지 않은 구현은 이 표본에서 같은 요청을 더 보낸다
     * @when 첫 요청 실패 표본은 network-fee가 `data-state=error`가 되기를 기다리고, 주기 실패 표본은 실패 응답을 받기를 기다린 뒤, 재시도 지연보다 긴 구간(재시도 지연 타이머도 가짜로 두고 진행하거나 그만큼 실제 시간을 기다림)을 지난다. 주기 실패 표본은 이어서 가짜 시계를 실패한 요청 시각부터 다음 60초 주기 직전까지 진행한다
     * @then 추정 실패 표본에서 실패한 키의 eth_estimateGas 요청이 1건이다(getL1Fee 실패 표본은 eth_estimateGas 1건, getL1Fee 1건이다)
     * @then eth_gasPrice 첫 요청 실패 표본에서 eth_gasPrice 요청이 1건이다
     * @then eth_gasPrice 주기 실패 표본에서 실패한 요청 1건 뒤 다음 60초 주기 직전까지 eth_gasPrice 요청이 0건이다
     */
    it(
      "[EC-5] 추정이나 가스 가격 요청이 실패해도 같은 요청을 자동으로 다시 보내지 않는다",
      async () => {
        type Target = "estimate" | "l1-fee" | "gas-price" | "gas-price-period";
        const samples: { target: Target; failure: NetworkFeeFailure }[] = [
          { target: "estimate", failure: "rpc-error" },
          { target: "estimate", failure: "revert" },
          { target: "estimate", failure: "http-429" },
          { target: "l1-fee", failure: "rpc-error" },
          { target: "l1-fee", failure: "http-429" },
          { target: "gas-price", failure: "rpc-error" },
          { target: "gas-price", failure: "http-429" },
          { target: "gas-price-period", failure: "rpc-error" },
          { target: "gas-price-period", failure: "http-429" },
        ];
        for (const [index, { target, failure }] of samples.entries()) {
          const label = `${target} × ${failure}`;
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const chainId: SupportedChainId = target === "l1-fee" ? base.id : mainnet.id;
          if (target === "estimate")
            rpc.failEstimateGasWhen(matchNetworkFee.estimateGas(), failure);
          if (target === "l1-fee") rpc.failL1FeeWhen(matchNetworkFee.l1Fee(), failure);
          if (target === "gas-price") rpc.failGasPriceWhen(matchNetworkFee.gasPrice, failure);
          await renderMockApp();
          if (chainId === base.id) await chooseChainFromDropdown(base);
          await enterPair(NATIVE_ETH, chainId === base.id ? BASE_DAI : ETHEREUM_DAI, "1");
          await waitPrimary("swap-ready", label);

          if (target !== "gas-price-period") {
            await waitUntil(() => expect(feeState(), label).toBe("error"), WAIT_MS);
            // 재시도 지연보다 긴 실제 시간을 기다린다.
            await yieldToPendingWork(RETRY_OBSERVATION_MS);
            await waitRequestsSettled();
            if (target === "estimate") {
              expect(estimates(chainId), `${label}: 추정 요청`).toHaveLength(1);
              expect(estimates(chainId)[0]!.status, label).toBe("failed");
            }
            if (target === "l1-fee") {
              expect(estimates(chainId), `${label}: 추정 요청`).toHaveLength(1);
              expect(l1Fees(chainId), `${label}: getL1Fee 요청`).toHaveLength(1);
              expect(l1Fees(chainId)[0]!.status, label).toBe("failed");
            }
            if (target === "gas-price") {
              expect(gasPrices(chainId), `${label}: 가스 가격 요청`).toHaveLength(1);
              expect(gasPrices(chainId)[0]!.status, label).toBe("failed");
            }
            continue;
          }

          await waitFeeSuccess("swap", label);
          await waitRequestsSettled();
          const start = gasPrices(chainId)[0]!.at;
          const before = gasPrices(chainId).length;
          rpc.failGasPriceWhen(matchNetworkFee.gasPrice, failure);
          await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS);
          await waitUntil(() => {
            const refreshed = gasPrices(chainId).slice(before);
            expect(refreshed.length).toBeGreaterThan(0);
            expect(refreshed.every((request) => request.status === "failed")).toBe(true);
          }, WAIT_MS);
          const failedAt = gasPrices(chainId)[before]!.at;
          // 재시도 지연보다 긴 실제 시간을 기다린다.
          await yieldToPendingWork(RETRY_OBSERVATION_MS);
          await settlePendingWork();
          expect(gasPrices(chainId).length, `${label}: 재시도 관찰 구간 뒤`).toBe(before + 1);
          await advanceFakeTimeTo(failedAt + GAS_PRICE_REFETCH_MS - 1);
          await settlePendingWork();
          expect(gasPrices(chainId).length, `${label}: 다음 60초 주기 직전`).toBe(before + 1);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-6
     * @given 가짜 타이머를 쓰고 mock 커넥터로 Ethereum에 연결돼 있으며 보내는 ETH, 받는 DAI, 금액 `1`로 주 버튼이 `swap-ready`이고 network-fee가 `data-kind=swap`·`data-state=success`이며 data-fee-wei·data-usd-micros·data-severity가 표시됐다. 그 뒤 스텁이 eth_gasPrice 요청을 붙잡았다가 JSON-RPC 오류로 응답하게 바꿨고, 커밋마다 network-fee의 data-state·data-kind·data-fee-wei·data-usd-micros·data-severity와 network-fee-skeleton 유무를 기록한다
     * @when 가짜 시계를 첫 eth_gasPrice 요청 시각부터 60초 진행해 다시 읽은 eth_gasPrice가 붙잡힌 동안 확인한 뒤, 응답을 풀어 실패 응답을 받기를 기다린다
     * @then 60초 tick부터 실패 응답 뒤까지 기록한 모든 커밋에서 network-fee가 `data-state=success`이고 data-kind·data-fee-wei·data-usd-micros·data-severity가 실패 전 값 그대로이며 network-fee-skeleton이 없다
     * @then 실패 응답 뒤 network-fee가 `data-state=success`이고 data-kind·data-fee-wei·data-usd-micros·data-severity가 실패 전 값 그대로다
     * @then 실패 응답 뒤 network-fee-skeleton이 없다
     */
    it(
      "[EC-6] 같은 키에서 가스 가격 60초 갱신이 실패해도 마지막 성공 값을 유지한다",
      async () => {
        fakePeriodicTimers();
        const app = await renderMockApp();
        await enterPair(NATIVE_ETH, ETHEREUM_DAI, "1");
        await waitPrimary("swap-ready");
        await waitUntil(() => {
          expect(feeState()).toBe("success");
          expect(feeKind()).toBe("swap");
          expect(networkFee()!.getAttribute("data-fee-wei")).not.toBeNull();
          expect(networkFee()!.getAttribute("data-usd-micros")).not.toBeNull();
          expect(networkFee()!.getAttribute("data-severity")).not.toBeNull();
        }, WAIT_MS);
        await waitRequestsSettled();
        const shown = (snapshot: FeeSnapshot) => ({
          state: snapshot.state,
          kind: snapshot.kind,
          feeWei: snapshot.feeWei,
          usdMicros: snapshot.usdMicros,
          severity: snapshot.severity,
          skeleton: snapshot.skeleton,
        });
        const previous = shown(feeSnapshot(app.config));
        expect(previous.skeleton, "전제: 스켈레톤 없음").toBe(false);
        const start = gasPrices(mainnet.id)[0]!.at;
        const before = gasPrices(mainnet.id).length;
        const gate = rpc.holdGasPrice();
        rpc.failGasPriceWhen(matchNetworkFee.gasPrice, "rpc-error");
        const commits = recordCommits(app.config);

        await advanceFakeTimeTo(start + GAS_PRICE_REFETCH_MS);
        await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0), WAIT_MS);
        await settlePendingWork();
        gate.release();
        await waitUntil(() => {
          const refreshed = gasPrices(mainnet.id).slice(before);
          expect(refreshed.length).toBeGreaterThan(0);
          expect(refreshed.every((request) => request.status === "failed")).toBe(true);
        }, WAIT_MS);
        await settlePendingWork();
        onCommitHook = null;

        for (const [index, commit] of commits.entries()) {
          expect(shown(commit), `커밋 ${index}`).toEqual(previous);
        }
        expect(feeState()).toBe("success");
        expect(shown(feeSnapshot(app.config)), "실패 응답 뒤").toEqual(previous);
        expect(screen.queryByTestId("network-fee-skeleton"), "실패 응답 뒤 스켈레톤").toBeNull();
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("체인·계정·키가 바뀌는 동안", () => {
    /**
     * @spec EC-10
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 DAI, 금액 `1`로 network-fee가 `data-state=success`이며 data-fee-wei가 Ethereum 응답으로 계산한 값이다. 스텁은 Base eth_estimateGas 응답을 붙잡고, Base에서 Ethereum과 다른 feeWei가 나오는 가스·가스 가격·L1 수수료를 돌려준다
     * @when 선택 체인을 Base로 바꿔 입력이 기본값으로 돌아간 뒤 받는 Base DAI·금액 `1`을 입력하고, Base 추정 응답이 붙잡힌 동안 확인한 뒤 응답을 푼다
     * @then 붙잡힌 동안 network-fee가 `data-state=success`가 아니고 data-fee-wei가 없다
     * @then 응답을 풀면 data-fee-wei가 Base 응답으로 계산한 값이다
     * @then 체인을 바꾼 뒤 Ethereum feeWei가 data-fee-wei로 한 번도 나타나지 않는다
     */
    it(
      "[EC-10] 선택 체인이 바뀌면 이전 체인의 수수료를 표시하지 않는다",
      async () => {
        const app = await renderMockApp();
        await enterPair(NATIVE_ETH, ETHEREUM_DAI, "1");
        await waitPrimary("swap-ready");
        await waitFeeSuccess("swap");
        await waitRequestsSettled();
        const ethereumFee = feeWei();
        // 전제: data-fee-wei가 Ethereum 응답으로 계산한 값이다.
        expect(ethereumFee).toBe(expectedFeeWei(estimates(mainnet.id).at(-1)!));
        const gate = rpc.holdEstimateGas(match.chain(base.id, matchNetworkFee.estimateGas()));
        const commits = recordCommits(app.config);

        await chooseChainFromDropdown(base);
        await enterPair(NATIVE_ETH, BASE_DAI, "1");
        await waitPrimary("swap-ready");
        await waitUntil(() => {
          expect(gate.heldCount).toBeGreaterThan(0);
          expect(networkFee()).not.toBeNull();
        }, WAIT_MS);
        await settlePendingWork();
        // 붙잡힌 동안
        expect(feeState(), "붙잡힌 동안").not.toBe("success");
        expect(networkFee()!.hasAttribute("data-fee-wei"), "붙잡힌 동안 data-fee-wei").toBe(false);
        const baseFee = expectedFeeWei(estimates(base.id).at(-1)!);
        // 전제: Base feeWei가 Ethereum feeWei와 다르다.
        expect(baseFee).not.toBe(ethereumFee);

        gate.release();
        await waitUntil(() => {
          expect(feeState()).toBe("success");
          expect(feeWei()).toBe(baseFee);
        }, WAIT_MS);
        await settlePendingWork();
        onCommitHook = null;
        const onBase = commits.filter((commit) => commit.selectedChainId === String(base.id));
        expect(onBase.length, "Base 커밋").toBeGreaterThan(0);
        expect(
          onBase.filter((commit) => commit.feeWei === ethereumFee),
          "Base에서 Ethereum feeWei",
        ).toHaveLength(0);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-11
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 보내는 USDC, 받는 DAI, 금액 `1`이며 스텁이 두 계정 모두 USDC 잔액을 금액 이상으로, allowance를 금액보다 크게 읽혀 두 계정 모두 최종적으로 `swap-ready`가 되는 입력이다(계정 전환 중 allowance 다시 읽기로 행이 잠시 없을 수 있다). 첫 계정은 ETH 잔액이 0이어서 network-fee가 `data-state=success`이고 network-fee-eth-shortage가 있다. 두 번째 계정은 ETH 잔액이 수수료보다 충분히 크고, 스텁은 두 번째 계정의 eth_estimateGas 응답을 붙잡으며 첫 계정과 다른 가스를 돌려준다
     * @when 지갑이 두 번째 계정으로 바뀌었다고 알리고(accountsChanged), 두 번째 계정의 추정 응답이 붙잡힌 동안 확인한 뒤 응답을 푼다
     * @then 붙잡힌 동안 network-fee가 `data-state=success`가 아니고 data-fee-wei가 없다
     * @then 응답을 풀면 data-fee-wei가 두 번째 계정의 응답으로 계산한 값이고 network-fee-eth-shortage가 없다
     * @then 계정을 바꾼 뒤 첫 계정의 feeWei가 data-fee-wei로, network-fee-eth-shortage가 한 번도 나타나지 않는다
     */
    it(
      "[EC-11] 계정이 바뀌면 이전 계정의 수수료와 ETH 부족 안내를 표시하지 않는다",
      async () => {
        setCardBalances((query) => {
          if (sameAddress(query.token, NATIVE_ETH)) {
            return sameAddress(query.account, TEST_ACCOUNT) ? 0n : 10n * ONE_ETH;
          }
          if (sameAddress(query.token, ETHEREUM_USDC)) return 5_000_000n;
          return defaultBalance(query);
        });
        const app = await renderStubApp();
        await enterPair(ETHEREUM_USDC, ETHEREUM_DAI, "1");
        await waitPrimary("swap-ready");
        await waitUntil(() => {
          expect(feeState()).toBe("success");
          expect(hasShortage()).toBe(true);
        }, WAIT_MS);
        await waitRequestsSettled();
        const firstFee = feeWei();
        // 전제: 첫 계정의 응답으로 계산한 값이다.
        expect(firstFee).toBe(
          expectedFeeWei(estimates(mainnet.id, { from: TEST_ACCOUNT }).at(-1)!),
        );
        const gate = rpc.holdEstimateGas(matchNetworkFee.estimateGas({ from: SECOND_ACCOUNT }));
        const commits = recordCommits(app.config);

        act(() => app.stub!.changeAccounts([SECOND_ACCOUNT]));
        await waitUntil(
          () => expect(sameAddress(getConnection(app.config).address, SECOND_ACCOUNT)).toBe(true),
          WAIT_MS,
        );
        await waitPrimary("swap-ready");
        await waitUntil(() => {
          expect(gate.heldCount).toBeGreaterThan(0);
          expect(networkFee()).not.toBeNull();
        }, WAIT_MS);
        await settlePendingWork();
        // 붙잡힌 동안
        expect(feeState(), "붙잡힌 동안").not.toBe("success");
        expect(networkFee()!.hasAttribute("data-fee-wei"), "붙잡힌 동안 data-fee-wei").toBe(false);
        const secondFee = expectedFeeWei(estimates(mainnet.id, { from: SECOND_ACCOUNT }).at(-1)!);
        // 전제: 두 계정의 feeWei가 다르다.
        expect(secondFee).not.toBe(firstFee);

        gate.release();
        await waitUntil(() => {
          expect(feeState()).toBe("success");
          expect(feeWei()).toBe(secondFee);
        }, WAIT_MS);
        await waitRequestsSettled();
        expect(hasShortage(), "응답을 푼 뒤 ETH 부족 안내").toBe(false);
        onCommitHook = null;
        const afterSwitch = commits.filter((commit) => sameAddress(commit.account, SECOND_ACCOUNT));
        expect(afterSwitch.length, "계정을 바꾼 뒤 커밋").toBeGreaterThan(0);
        expect(
          afterSwitch.filter((commit) => commit.feeWei === firstFee),
          "첫 계정 feeWei",
        ).toHaveLength(0);
        expect(
          afterSwitch.filter((commit) => commit.shortage),
          "ETH 부족 안내",
        ).toHaveLength(0);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-12
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 스텁은 금액·보내는 토큰·받는 토큰마다 다른 가스를 돌려주고, 토큰 잔액은 금액 이상, allowance는 금액보다 크게 읽힌다. 커밋마다 network-fee의 data-fee-wei를 기록한다. 표본(이전 키 → 새 키): (가) 금액: 보내는 ETH·받는 DAI·금액 `1`로 network-fee가 `success`인 상태에서 금액 `2`의 eth_estimateGas 응답을 붙잡고 금액을 `2`로 바꾼 뒤 금액을 `3`으로 바꿈, (나) tokenOut: 보내는 USDC·받는 DAI·금액 `1`의 eth_estimateGas 응답을 붙잡은 채 받는 칸 모달에서 LINK를 고름, (다) tokenIn: 보내는 USDC·받는 DAI·금액 `1`의 eth_estimateGas 응답을 붙잡은 채 보내는 칸 모달에서 같은 6자리 USDT를 고름을 하나씩 반복한다
     * @when 표본마다 이전 키의 추정 요청이 붙잡힌 뒤 새 키로 바꿔 새 키의 추정으로 network-fee가 `success`가 되기를 기다리고, 이어서 이전 키의 응답을 푼다
     * @then 새 키로 바꾼 뒤 새 키의 eth_estimateGas 요청(디코드한 calldata가 새 금액·새 토큰)이 보내졌다
     * @then 응답을 푼 뒤에도 data-fee-wei가 새 키의 스텁 응답으로 계산한 값이다
     * @then 새 키로 바꾼 뒤 기록한 커밋에서 이전 키의 응답으로 계산한 feeWei가 data-fee-wei로 한 번도 나타나지 않는다
     */
    it(
      "[EC-12] 키가 바뀐 뒤 늦게 도착한 이전 키의 추정 응답을 표시하지 않는다",
      async () => {
        const samples: {
          label: string;
          tokenIn: Address;
          // 이전 키(붙잡을 추정)
          oldKey: NetworkFeeTxFilter;
          // 이전 키를 만드는 입력. (가)는 금액 `1`로 success가 된 뒤 금액을 `2`로 바꾼다.
          enterOld: () => Promise<void>;
          change: () => Promise<void>;
          newKey: NetworkFeeTxFilter;
        }[] = [
          {
            label: "금액",
            tokenIn: NATIVE_ETH,
            oldKey: { kind: "swap", amountIn: 2n * ONE_ETH },
            enterOld: async () => {
              await typeAmount("1");
              await waitPrimary("swap-ready", "금액");
              await waitFeeSuccess("swap", "금액");
              await waitRequestsSettled();
              await typeAmount("2");
            },
            change: () => typeAmount("3"),
            newKey: { kind: "swap", amountIn: 3n * ONE_ETH },
          },
          {
            label: "tokenOut",
            tokenIn: ETHEREUM_USDC,
            oldKey: { kind: "swap", tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_DAI },
            enterOld: () => typeAmount("1"),
            change: () => chooseToken("out", ETHEREUM_LINK),
            newKey: { kind: "swap", tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_LINK },
          },
          {
            label: "tokenIn",
            tokenIn: ETHEREUM_USDC,
            oldKey: { kind: "swap", tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_DAI },
            enterOld: () => typeAmount("1"),
            change: () => chooseToken("in", ETHEREUM_USDT),
            newKey: { kind: "swap", tokenIn: ETHEREUM_USDT, tokenOut: ETHEREUM_DAI },
          },
        ];
        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          const app = await renderMockApp();
          if (!sameAddress(sample.tokenIn, NATIVE_ETH)) await chooseToken("in", sample.tokenIn);
          await chooseToken("out", ETHEREUM_DAI);
          const gate = rpc.holdEstimateGas(matchNetworkFee.estimateGas(sample.oldKey));
          await sample.enterOld();
          await waitUntil(() => expect(gate.heldCount, label).toBeGreaterThan(0), WAIT_MS);
          await settlePendingWork();
          const oldRequest = estimates(mainnet.id, sample.oldKey)[0]!;
          const oldFee = expectedFeeWei(oldRequest);

          const seq = nextSeq();
          const commits = recordCommits(app.config);
          await sample.change();
          let newFee = "";
          await waitUntil(() => {
            const next = estimatesSince(seq, sample.newKey).find(
              (request) => request.status === "ok",
            );
            expect(next, `${label}: 새 키 추정 요청`).toBeDefined();
            newFee = expectedFeeWei(next!);
            expect(feeState(), label).toBe("success");
            expect(feeWei(), label).toBe(newFee);
          }, WAIT_MS);
          // 전제: 이전 키와 새 키의 feeWei가 다르다.
          expect(newFee, label).not.toBe(oldFee);
          expect(
            estimatesSince(seq, sample.newKey).length,
            `${label}: 새 키 추정 요청`,
          ).toBeGreaterThan(0);

          gate.release();
          await waitUntil(
            () => expect(requestBySeq(oldRequest.seq).status, label).not.toBe("pending"),
            WAIT_MS,
          );
          await waitRequestsSettled();
          onCommitHook = null;
          expect(feeState(), `${label}: 응답을 푼 뒤`).toBe("success");
          expect(feeWei(), `${label}: 응답을 푼 뒤`).toBe(newFee);
          expect(
            commits.filter((commit) => commit.feeWei === oldFee),
            `${label}: 이전 키 feeWei`,
          ).toHaveLength(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-13
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC, 받는 DAI, 금액 `1`이며 USDC allowance가 0이어서 주 버튼이 `approve-required`이고 network-fee가 `data-kind=approve`·`data-state=success`다. 스텁은 approve와 swap에 다른 가스를 돌려주고, swap eth_estimateGas 응답을 붙잡는다. approve 성공 뒤 allowance는 금액보다 크게 읽힌다
     * @when 주 버튼으로 approve를 보내 성공하고 주 버튼이 `swap-ready`가 된 뒤, swap 추정 응답이 붙잡힌 동안 확인하고 응답을 푼다
     * @then `swap-ready`가 된 뒤 network-fee가 `data-kind=swap`이다
     * @then 붙잡힌 동안 network-fee가 `data-state=success`가 아니고 data-fee-wei가 없다
     * @then 응답을 풀면 data-fee-wei가 swap 응답으로 계산한 값이다
     * @then `data-kind=swap`인 동안 approve feeWei가 data-fee-wei로 한 번도 나타나지 않는다
     */
    it(
      "[EC-13] approve 성공 뒤 swap-ready가 되면 approve 수수료를 스왑 수수료로 표시하지 않는다",
      async () => {
        setAllowance(ETHEREUM_USDC, 0n);
        const app = await renderStubApp();
        await enterPair(ETHEREUM_USDC, ETHEREUM_DAI, "1");
        await waitPrimary("approve-required");
        await waitFeeSuccess("approve");
        await waitRequestsSettled();
        const approveFee = feeWei();
        // 전제: approve 추정 응답으로 계산한 값이다.
        expect(approveFee).toBe(expectedFeeWei(estimates(mainnet.id, { kind: "approve" }).at(-1)!));
        const gate = rpc.holdEstimateGas(matchNetworkFee.estimateGas({ kind: "swap" }));
        const commits = recordCommits(app.config);
        // approve 영수증 성공 뒤 allowance 다시 읽기는 금액보다 큰 값을 받는다.
        setAllowance(ETHEREUM_USDC, MAX_UINT256);

        fireEvent.click(primaryButton());
        await waitPrimary("swap-ready");
        expect(feeKind(), "swap-ready 뒤 data-kind").toBe("swap");
        await waitUntil(() => expect(gate.heldCount).toBeGreaterThan(0), WAIT_MS);
        await settlePendingWork();
        // 붙잡힌 동안
        expect(feeState(), "붙잡힌 동안").not.toBe("success");
        expect(networkFee()!.hasAttribute("data-fee-wei"), "붙잡힌 동안 data-fee-wei").toBe(false);
        const swapFee = expectedFeeWei(estimates(mainnet.id, { kind: "swap" }).at(-1)!);
        // 전제: approve와 swap의 feeWei가 다르다.
        expect(swapFee).not.toBe(approveFee);

        gate.release();
        await waitUntil(() => {
          expect(feeState()).toBe("success");
          expect(feeWei()).toBe(swapFee);
        }, WAIT_MS);
        await settlePendingWork();
        onCommitHook = null;
        const swapCommits = commits.filter((commit) => commit.kind === "swap");
        expect(swapCommits.length, "data-kind=swap 커밋").toBeGreaterThan(0);
        expect(
          swapCommits.filter((commit) => commit.feeWei === approveFee),
          "data-kind=swap에서 approve feeWei",
        ).toHaveLength(0);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
