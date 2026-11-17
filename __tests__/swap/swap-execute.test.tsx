import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
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
  STUB_Q96,
  type StubFeeTier,
  allowanceAlways,
  bestStubQuote,
  defaultAllowance,
  installBalanceRpcStub,
  match,
  matchAllowance,
  matchQuote,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type ChainSwitchControl,
  SEND_TRANSACTION_METHODS,
  type StubEip1193,
  type WalletTransactionControl,
  createStubEip1193,
  installChainSwitch,
  installWalletTransactions,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeTimeTo,
  clearCookies,
  createNoopWagmiStorage,
  decodeSwapCalldata,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 `primary-button`의 `data-state`·비활성, 지갑 전송 요청, RPC 요청 집계로 판정한다.
// 실행 함수 직접 호출(EC-19)은 `renderAppHook`으로 앱 Provider 안의 프로브에서 useSwapExecution()의 `approve`·`swap`을 부른다.
// 지갑은 스텁 EIP-1193 커넥터(`setHandler`)를 쓴다. jsdom에서 mock 커넥터의 `eth_sendTransaction`은 스텁 라우트가 없는 체인 기본 RPC로 나가므로 전송 판정에는 쓰지 않는다.
// mock 허용 경계(사용자 확정): 실제 wagmi·Provider·화면, 스텁 EIP-1193, 전역 fetch URL 라우팅 스텁과 견적 aggregate3 스텁, allowance 응답·실패·붙잡기 스텁(기본 allowance 0),
// 스텁 EIP-1193 `eth_sendTransaction` 핸들러(해시 응답, 붙잡기), 영수증 성공·붙잡기 스텁, 스텁 EIP-1193 체인 전환 요청 붙잡기(EC-11), `Date` 가짜 시계(DoD-17), 가짜 타이머와 DOM 이벤트. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.
// 이 파일에서 "전송 요청"은 스텁 EIP-1193 요청 기록 중 `eth_sendTransaction` 항목이고, "지갑 요청"은 스텁 EIP-1193 요청 기록의 모든 항목이다.
// swap calldata는 테스트 쪽 ABI 리터럴(`multicall(uint256 deadline, bytes[] data)`,
// `exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))`)로 디코딩한다.
// 기대 주소는 제품 config를 쓰지 않고 리터럴로 적는다: Ethereum swapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`,
// USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F`, USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`.
// 기대 최소 수령량은 제품 함수를 쓰지 않고 리터럴이나 테스트 쪽 bigint 식 `Q * (10000n - bps) / 10000n`으로 만든다.
// 15초 주기 판정은 F2·F3 관례대로 주기 타이머(setInterval·clearInterval)와 시계(Date)를 가짜로 둔다.
// 견적 스텁의 slot0 가격은 1(sqrtPriceX96 = 2^96)이고, 고른 티어의 수령량은 입력 금액보다 커서 가격 영향이 `normal` 등급이다(따로 적은 표본 제외).

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 10_000;

const MAX_UINT256 = 2n ** 256n - 1n;
const BPS_DENOMINATOR = 10_000n;
// 스펙 DoD-17의 deadline 여유(초)
const DEADLINE_SECONDS = 1800n;
// 스펙 값: 견적·카드 잔액 주기 15초
const REFETCH_MS = 15_000;

// 스펙 §4.1 Ethereum swapRouter02 주소(리터럴)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

// Ethereum 공식 주소(리터럴)
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
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

// `best`가 고른 티어만 그 수령량, 나머지 티어는 입력 금액과 같은 수령량으로 응답한다. slot0 가격은 1이다.
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

// 최소 수령량이 0이 되는 견적: 모든 티어 수령량 1(raw). slot0 가격을 높여 가격 영향이 음수(`normal`)가 되게 한다.
const AMOUNT_TOO_SMALL_RULE: QuoteRule = {
  quote: () => ({ status: "ok", amountOut: 1n, sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER }),
  slot0: () => ({ status: "ok", sqrtPriceX96: STUB_Q96 * 2_000n }),
};

// 가격 영향 `error` 등급 견적: slot0 가격 1에서 수령량이 입력 금액의 절반(가격 영향 약 50%).
const PRICE_IMPACT_ERROR_RULE: QuoteRule = {
  quote: (query) => ({
    status: "ok",
    amountOut: query.amountIn / 2n,
    sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
  }),
  slot0: () => ({ status: "ok", sqrtPriceX96: STUB_Q96 }),
};

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

function decodeSent(wallet: WalletTransactionControl, index: number) {
  const sent = wallet.sent[index];
  if (!sent?.data) throw new Error(`${index}번째 전송 요청의 calldata가 없다`);
  return decodeSwapCalldata(sent.data);
}

function sendCount(stub: StubEip1193): number {
  return requestsSince(stub, 0, SEND_TRANSACTION_METHODS).length;
}

// 호출이 돌려준 Promise의 결과를 기록한다.
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

// Ethereum 카드 잔액 읽기 요청(연결 계정, 토큰)
function cardBalanceReads(token: Address) {
  return rpc.requests(
    match.chain(mainnet.id, match.account(TEST_ACCOUNT, match.balanceOfToken(token))),
  );
}

describe("swap — 사용자가 클릭 시점의 견적과 최소 수령량으로 단일 홉 스왑을 보내고 체결 뒤 화면이 갱신된다", () => {
  describe("스왑 가능한 상태에서 주 버튼을 누르는 경우", () => {
    /**
     * @spec DoD-15 DoD-16 DoD-17
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있다(지갑 체인과 선택 체인이 같다). 스텁의 allowance 응답이 maxUint256(amountInRaw 이상)이고, 견적 스텁은 표본마다 한 fee 티어의 수령량 Q를 가장 크게 응답해 quote.fee가 그 티어(리터럴)이며, 두 표본의 최선 티어는 서로 다르다(fee 하드코딩 구현을 배제). 표본(보내는 토큰 → 받는 토큰 — 금액 — 슬리피지 bps — 최선 티어): USDC → DAI — `1.5`(amountInRaw `1_500_000n`) — `50`(초기값) — `100`, WETH → USDC — `0.25`(amountInRaw `250_000_000_000_000_000n`) — `100`(금액 입력 전에 slippage-option으로 고름) — `3000`을 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링한다(보내는 토큰 잔액은 충분). 견적이 `success`이고 주 버튼이 `swap-ready`이며 활성인 것을 확인한 뒤, 클릭 시점의 useSwapQuote().quote.fee와 useAmountOutMinimum()을 기록하고, `Date`만 가짜로 두어(타이머는 실제) 시스템 시각을 정수 초 경계 T(1000의 배수인 ms 리터럴)에 맞춰 전송 요청까지 움직이지 않게 한다. `eth_sendTransaction` 핸들러는 호출된 시점의 `Date.now()`를 기록하고 해시로 응답한다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이고, 핸들러가 기록한 `Date.now()`가 T다
     * @then 전송 요청의 `to`가 swapRouter02 주소 리터럴이다
     * @then 전송 요청의 calldata를 테스트 쪽 `multicall` ABI 리터럴로 디코딩하면 함수가 `multicall(uint256,bytes[])`이고 `data` 배열의 원소가 1개이며, 그 원소를 테스트 쪽 `exactInputSingle` ABI 리터럴로 디코딩하면 함수가 `exactInputSingle`이다
     * @then `multicall`의 deadline이 `T / 1000 + 1800`이다(T가 정수 초 경계라 초 변환의 반올림 방식과 무관하다)
     * @then `exactInputSingle`의 tokenIn·tokenOut이 표본 보내는·받는 토큰 주소 리터럴(WETH 표본은 WETH 주소 리터럴)이고, 같은 입력의 견적 요청(`quoteExactInputSingle`)의 tokenIn·tokenOut과 같다
     * @then `exactInputSingle`의 fee가 기록한 quote.fee이고 스텁이 고른 티어 리터럴이다
     * @then `exactInputSingle`의 recipient가 연결 계정이다
     * @then `exactInputSingle`의 amountIn이 표본 amountInRaw 리터럴이다
     * @then `exactInputSingle`의 amountOutMinimum이 기록한 useAmountOutMinimum()이고 테스트 쪽 식 `Q * (10000n - bps) / 10000n`(bps는 표본 슬리피지 `50n` | `100n`)과 같다
     * @then `exactInputSingle`의 sqrtPriceLimitX96이 `0n`이다
     */
    it(
      "[DoD-15][DoD-16][DoD-17] swapRouter02에 클릭 시점 값의 multicall(deadline, [exactInputSingle(params)])을 보낸다",
      async () => {
        // 정수 초 경계(1000의 배수인 ms)
        const T = 1_900_000_000_000;
        const samples = [
          {
            label: "USDC → DAI, 슬리피지 50, 티어 100",
            tokenIn: ETHEREUM_USDC,
            tokenOut: ETHEREUM_DAI,
            amount: "1.5",
            amountInRaw: 1_500_000n,
            slippageBps: 50n,
            chooseSlippageFirst: false,
            fee: 100 as StubFeeTier,
          },
          {
            label: "WETH → USDC, 슬리피지 100, 티어 3000",
            tokenIn: ETHEREUM_WETH,
            tokenOut: ETHEREUM_USDC,
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
            allowance: allowanceAlways(MAX_UINT256),
          });
          if (sample.chooseSlippageFirst) await chooseSlippage(Number(sample.slippageBps));
          await enterPair(sample.tokenIn, sample.tokenOut, sample.amount, "swap-ready");
          expect(primaryButton().disabled, label).toBe(false);

          const quoteInput = {
            chainId: mainnet.id,
            tokenIn: sample.tokenIn,
            tokenOut: sample.tokenOut,
            amountIn: sample.amountInRaw,
          } as const;
          const Q = bestStubQuote(rule, quoteInput)!.amountOut;
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

          const decoded = decodeSent(s.wallet, 0);
          expect(decoded.calls, label).toHaveLength(1);
          expect(decoded.deadline, label).toBe(BigInt(T / 1000) + DEADLINE_SECONDS);

          const params = decoded.calls[0]!;
          expectSameAddress(params.tokenIn, sample.tokenIn, `${label} tokenIn`);
          expectSameAddress(params.tokenOut, sample.tokenOut, `${label} tokenOut`);
          const quoted = rpc.requests(matchQuote.input(quoteInput)).at(-1)?.quote?.quotes[0];
          expectSameAddress(params.tokenIn, quoted!.tokenIn, `${label} 견적 tokenIn`);
          expectSameAddress(params.tokenOut, quoted!.tokenOut, `${label} 견적 tokenOut`);
          expect(params.fee, label).toBe(clickFee);
          expect(params.fee, label).toBe(sample.fee);
          expectSameAddress(params.recipient, TEST_ACCOUNT, `${label} recipient`);
          expect(params.amountIn, label).toBe(sample.amountInRaw);
          expect(params.amountOutMinimum, label).toBe(clickMinimum);
          expect(params.amountOutMinimum, label).toBe(expectedMinimum(Q, sample.slippageBps));
          expect(params.sqrtPriceLimitX96, label).toBe(0n);

          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("체인 전환 서명을 기다리는 동안 견적·금액·받는 토큰이 바뀌는 경우", () => {
    /**
     * @spec EC-11 DoD-16 DoD-17
     * @given 가짜 타이머(Date 포함)를 쓰고 스텁 EIP-1193으로 연결돼 있으며 지갑 체인은 Base(지갑 등록 체인 Base·Ethereum), 선택 체인은 Ethereum이라 둘이 다르다. 보내는 USDC(잔액 충분), 받는 DAI, 금액 `1.5`(amountInRaw `1_500_000n`), 슬리피지 `50`, allowance maxUint256이고 견적이 티어 F1의 수령량 Q1을 최선으로 골라 `success`이며 주 버튼이 `swap-ready`다. 스텁 지갑은 `wallet_switchEthereumChain` 요청을 붙잡고(클릭과 calldata 인코딩 사이), `eth_sendTransaction` 핸들러는 호출된 시점의 `Date.now()`를 기록하고 해시로 바로 응답한다. 영수증은 성공 스텁이 응답한다. 클릭 직전에 가짜 시계를 정수 초 경계 T0(1000의 배수인 ms 리터럴)에 맞추고, 클릭 시점의 useSwapQuote().quote.fee와 useAmountOutMinimum()(테스트 쪽 식 `Q1 * (10000n - 50n) / 10000n`과 같음)을 기록한다. 표본(체인 전환 요청이 붙잡힌 동안 일으키는 변화): 수령량·티어 변화 — 스텁의 같은 입력 응답을 F1과 다른 티어 F2의 수령량 Q2(Q1과 다름)가 최선이 되도록 바꾸고 가짜 시계를 견적의 15초 주기 시각까지 진행해 견적 갱신을 기다림, 금액 변화 — 보내는 칸 amount-input을 `2`로 바꾸고(스텁은 금액 `2`의 수령량을 Q1과 다르게 응답) 입력 반영 대기(300ms)가 지나 새 견적을 기다림, 받는 토큰 변화 — 받는 칸 모달에서 Ethereum USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`를 고르고(스텁은 USDC→USDT 견적을 F1과 다른 티어가 최선이고 수령량이 Q1과 다르게 응답) 새 견적을 기다림을 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링한다
     * @when 주 버튼을 누르고 체인 전환 요청이 붙잡힌 동안 표본의 변화를 일으켜 반영되기를 기다린 뒤, 가짜 시계를 현재 가짜 시각 이후의 다음 정수 초 경계 T1(1000의 배수, T1 > T0)에 맞추고, 붙잡은 체인 전환 요청을 풀어(Ethereum으로 전환해 성공 응답) 시계를 움직이지 않는 대기로 전송 요청이 기록되기를 기다린 다음 영수증 후처리가 끝나기를 기다린다
     * @then 체인 전환 요청이 붙잡힌 동안 표본 변화가 반영됐다(수령량·티어 변화: useSwapQuote().quote.amountOut이 Q2, quote.fee가 F2이고 useAmountOutMinimum()이 `Q2 * (10000n - 50n) / 10000n`; 금액 변화: useSwapForm().amountInRaw가 `2_000_000n`이고 새 금액의 견적이 `success`이며 useAmountOutMinimum()이 클릭 시점 기록과 다르다; 받는 토큰 변화: useSwapForm()의 tokenOut의 address가 USDT 주소 리터럴이고 새 견적이 `success`이며 quote.fee와 useAmountOutMinimum()이 클릭 시점 기록과 다르다), 주 버튼은 `awaiting-signature`다
     * @then 영수증 후처리가 끝날 때까지 전송 요청은 1건뿐이고 `to`가 swapRouter02 주소 리터럴이다
     * @then 그 전송 요청의 calldata를 테스트 쪽 ABI 리터럴로 디코딩한 `exactInputSingle`의 amountIn이 클릭 시점 값 `1_500_000n`, amountOutMinimum이 클릭 시점에 기록한 값(Q1 기준)이고, tokenIn이 USDC 주소 리터럴, tokenOut이 클릭 시점 받는 토큰인 DAI 주소 리터럴, fee가 클릭 시점에 기록한 quote.fee(F1), recipient가 연결 계정, sqrtPriceLimitX96이 `0n`이다
     * @then 핸들러가 기록한 `Date.now()`가 T1이고, `multicall`의 deadline이 전송 직전 시각 기준 `T1 / 1000 + 1800`이다(클릭 시각 기준 `T0 / 1000 + 1800`이 아니다. deadline은 EC-11의 클릭 시점 값 규칙에서 예외다)
     */
    it(
      "[EC-11][DoD-16][DoD-17] 체인 전환 대기 중 견적·금액·받는 토큰이 바뀌어도 인자는 클릭 시점 값이고 deadline만 전송 직전 시각 기준이다",
      async () => {
        // 클릭 시점 견적: DAI는 티어 500(F1), USDT는 티어 10000이 최선이다.
        const F1: StubFeeTier = 500;
        const clickRule = bestTierRule((query) =>
          sameAddress(query.tokenOut, ETHEREUM_USDT)
            ? { fee: 10000, amountOut: query.amountIn * 2n + 99n }
            : { fee: F1, amountOut: query.amountIn * 2n + 11n },
        );
        // 수령량·티어 변화: 티어 3000(F2)의 수령량 Q2가 최선이다.
        const F2: StubFeeTier = 3000;
        const changedRule = bestTierRule((query) => ({
          fee: F2,
          amountOut: query.amountIn * 3n + 5n,
        }));
        const baseInput = {
          chainId: mainnet.id,
          tokenIn: ETHEREUM_USDC,
          tokenOut: ETHEREUM_DAI,
          amountIn: 1_500_000n,
        } as const;
        const Q1 = bestStubQuote(clickRule, baseInput)!.amountOut;
        const Q2 = bestStubQuote(changedRule, baseInput)!.amountOut;
        expect(Q2).not.toBe(Q1);

        const changes = ["수령량·티어 변화", "금액 변화", "받는 토큰 변화"] as const;
        for (const [index, change] of changes.entries()) {
          if (index > 0) resetSample();
          fakePeriodicTimers();
          const s = await renderConnectedApp({
            quoteRule: clickRule,
            allowance: allowanceAlways(MAX_UINT256),
            walletChainId: base.id,
          });
          await enterPair(ETHEREUM_USDC, ETHEREUM_DAI, "1.5", "swap-ready");

          const atClick = s.probe();
          if (atClick.quote.status !== "success")
            throw new Error(`${change}: 견적이 success가 아니다`);
          const clickFee = atClick.quote.quote.fee;
          const clickMinimum = atClick.minimum;
          // 전제: 클릭 시점 견적은 F1의 Q1이고 최소 수령량은 Q1 기준이다.
          expect(clickFee, change).toBe(F1);
          expect(atClick.quote.quote.amountOut, change).toBe(Q1);
          expect(clickMinimum, change).toBe(expectedMinimum(Q1, 50n));

          // 같은 입력의 15초 주기 시작(첫 견적 요청 시각)
          const periodStart = rpc.requests(matchQuote.input(baseInput))[0]!.at;
          // 클릭 직전에 가짜 시계를 정수 초 경계 T0에 맞춘다(주기 타이머가 실행되지 않는 1초 미만 진행).
          const T0 = Math.floor(Date.now() / 1000) * 1000 + 1000;
          await advanceFakeTimeTo(T0);
          const switchGate = s.chainSwitch.hold();

          clickPrimary();
          await waitUntil(() => expect(switchGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          expect(s.wallet.sent, change).toHaveLength(0);

          if (change === "수령량·티어 변화") {
            rpc.setQuoteRule(changedRule);
            await advanceFakeTimeTo(periodStart + REFETCH_MS);
            await waitUntil(() => {
              const { quote } = s.probe();
              expect(quote.status).toBe("success");
              expect(quote.quote?.amountOut).toBe(Q2);
            }, READY_TIMEOUT_MS);
            const now = s.probe();
            expect(now.quote.quote?.fee, change).toBe(F2);
            expect(now.minimum, change).toBe(expectedMinimum(Q2, 50n));
          } else if (change === "금액 변화") {
            await typeAmount("2");
            await waitUntil(() => {
              const { quote, form } = s.probe();
              expect(form.amountInRaw).toBe(2_000_000n);
              expect(quote.status).toBe("success");
              expect(quote.quote?.amountOut).toBe(
                bestStubQuote(clickRule, { ...baseInput, amountIn: 2_000_000n })!.amountOut,
              );
            }, READY_TIMEOUT_MS);
            expect(s.probe().minimum, change).not.toBe(clickMinimum);
          } else {
            await chooseToken("out", ETHEREUM_USDT);
            await waitUntil(() => {
              const { quote, form } = s.probe();
              expectSameAddress(form.tokenOut?.address, ETHEREUM_USDT);
              expect(quote.status).toBe("success");
              expect(quote.quote?.amountOut).toBe(
                bestStubQuote(clickRule, { ...baseInput, tokenOut: ETHEREUM_USDT })!.amountOut,
              );
            }, READY_TIMEOUT_MS);
            const now = s.probe();
            expect(now.quote.quote?.fee, change).not.toBe(clickFee);
            expect(now.minimum, change).not.toBe(clickMinimum);
          }
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

          expect(sendCount(s.stub), change).toBe(1);
          expectSameAddress(sent.to, ETHEREUM_ROUTER, `${change} to`);
          const decoded = decodeSent(s.wallet, 0);
          expect(decoded.calls, change).toHaveLength(1);
          const params = decoded.calls[0]!;
          expect(params.amountIn, change).toBe(1_500_000n);
          expect(params.amountOutMinimum, change).toBe(clickMinimum);
          expectSameAddress(params.tokenIn, ETHEREUM_USDC, `${change} tokenIn`);
          expectSameAddress(params.tokenOut, ETHEREUM_DAI, `${change} tokenOut`);
          expect(params.fee, change).toBe(clickFee);
          expectSameAddress(params.recipient, TEST_ACCOUNT, `${change} recipient`);
          expect(params.sqrtPriceLimitX96, change).toBe(0n);

          expect(sent.at, change).toBe(T1);
          expect(decoded.deadline, change).toBe(BigInt(T1 / 1000) + DEADLINE_SECONDS);
          expect(decoded.deadline, change).not.toBe(BigInt(T0 / 1000) + DEADLINE_SECONDS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("스왑 영수증이 성공한 경우", () => {
    /**
     * @spec DoD-19 DoD-20 EC-15
     * @given 가짜 타이머(setInterval·clearInterval·Date)를 쓰고 스텁 EIP-1193으로 Ethereum에 연결돼 있으며 보내는 USDC(잔액 충분), 받는 DAI, 금액 `1.5`, allowance maxUint256으로 견적이 `success`이고 주 버튼이 `swap-ready`다. 두 칸의 카드 잔액 읽기가 성공했고 각 칸의 마지막 잔액 읽기 시각(15초 주기 시작)을 기록했다. 주 버튼을 눌러 swap 전송 요청은 해시로 응답했고 영수증 성공 응답을 붙잡았으며, 붙잡은 동안 보내는 USDC·받는 DAI의 카드 잔액 읽기 요청 수와 allowance 읽기 요청 수를 기록했다
     * @when 영수증을 붙잡은 채 대기 중인 작업을 진행시켜 allowance 읽기 요청 수를 확인한 뒤, 붙잡은 영수증을 성공으로 풀고, 가짜 시계가 각 칸의 다음 15초 주기 시각(기록한 마지막 잔액 읽기 시각 + 15초)에 이르기 전 범위에서 영수증 후처리가 끝나기를 기다린다
     * @then 영수증이 붙잡힌 동안에는 allowance 읽기 요청이 기록한 수에서 늘지 않는다
     * @then 보내는 칸 amount-input 값이 빈 문자열이다
     * @then 보내는 토큰과 받는 토큰 선택이 클릭 전과 같다(useSwapForm()의 tokenIn의 address가 USDC 주소 리터럴, tokenOut의 address가 DAI 주소 리터럴)
     * @then 가짜 시계가 다음 15초 주기 시각에 이르기 전에 보내는 USDC와 받는 DAI의 카드 잔액 읽기 요청(연결 계정, Ethereum)이 각각 기록한 수보다 1건 이상 늘어난다
     * @then 가짜 시계가 다음 15초 주기 시각에 이르기 전에 allowance 읽기 요청(연결 계정, Ethereum, USDC, spender swapRouter02)이 기록한 수보다 1건 이상 늘어난다
     */
    it(
      "[DoD-19][DoD-20][EC-15] 영수증 뒤 금액을 비우고 토큰 선택을 유지하며 두 잔액과 allowance를 15초 주기 전에 다시 읽는다",
      async () => {
        fakePeriodicTimers();
        const s = await renderConnectedApp({
          quoteRule: parityQuoteRule,
          allowance: allowanceAlways(MAX_UINT256),
        });
        await enterPair(ETHEREUM_USDC, ETHEREUM_DAI, "1.5", "swap-ready");
        await waitUntil(() => {
          for (const token of [ETHEREUM_USDC, ETHEREUM_DAI]) {
            expect(cardBalanceReads(token).some((request) => request.status === "ok")).toBe(true);
          }
        }, READY_TIMEOUT_MS);
        // 각 칸의 마지막 잔액 읽기 시각(15초 주기 시작)
        const nextPeriod = {
          in: cardBalanceReads(ETHEREUM_USDC).at(-1)!.at + REFETCH_MS,
          out: cardBalanceReads(ETHEREUM_DAI).at(-1)!.at + REFETCH_MS,
        };
        const receiptGate = rpc.holdReceipt();

        clickPrimary();
        await waitUntil(() => expect(s.wallet.hashes()).toHaveLength(1), READY_TIMEOUT_MS);
        await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
        expect(s.probe().execution.phase).toBe("swapping");
        const before = {
          in: cardBalanceReads(ETHEREUM_USDC).length,
          out: cardBalanceReads(ETHEREUM_DAI).length,
          allowance: usdcAllowanceReads().length,
        };

        // 영수증이 붙잡힌 동안에는 allowance를 다시 읽지 않는다.
        await settlePendingWork(10);
        expect(usdcAllowanceReads()).toHaveLength(before.allowance);

        receiptGate.release();
        await waitUntil(() => {
          expect(s.probe().execution.phase).toBe("idle");
          expect(cardBalanceReads(ETHEREUM_USDC).length).toBeGreaterThan(before.in);
          expect(cardBalanceReads(ETHEREUM_DAI).length).toBeGreaterThan(before.out);
          expect(usdcAllowanceReads().length).toBeGreaterThan(before.allowance);
        }, READY_TIMEOUT_MS);
        // 다시 읽기가 일어난 시점까지 가짜 시계가 어느 칸의 다음 15초 주기에도 이르지 않았다.
        const now = Date.now();
        expect(now).toBeLessThan(nextPeriod.in);
        expect(now).toBeLessThan(nextPeriod.out);
        for (const request of [
          ...cardBalanceReads(ETHEREUM_USDC).slice(before.in),
          ...cardBalanceReads(ETHEREUM_DAI).slice(before.out),
          ...usdcAllowanceReads().slice(before.allowance),
        ]) {
          expect(request.at).toBeLessThan(Math.min(nextPeriod.in, nextPeriod.out));
        }
        await settlePendingWork();

        expect(amountInput().value).toBe("");
        const { form } = s.probe();
        expectSameAddress(form.tokenIn?.address, ETHEREUM_USDC, "tokenIn");
        expectSameAddress(form.tokenOut?.address, ETHEREUM_DAI, "tokenOut");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("실행 함수를 허용 상태 밖에서 호출하는 경우", () => {
    /**
     * @spec EC-19
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 `renderAppHook`의 프로브로 useSwapExecution()과 주 버튼 상태를 읽는다. 표본(호출 함수 — 주 버튼 상태): `approve` — `swap-ready`(보내는 USDC, 받는 DAI, 금액 `1.5`, allowance maxUint256), `approve` — `enter-amount`(보내는 USDC, 받는 DAI, 금액 빈 값), `approve` — `quote-ready`(보내는 ETH, 받는 USDC, 금액 `1`의 견적 `success`), `approve` — `allowance-error`(보내는 USDC, 받는 DAI, 금액 `1.5`, 스텁이 allowance 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답하고 현재 키에 성공 값이 없음), `approve` — `checking-allowance`(보내는 USDC, 받는 DAI, 금액 `1.5`, 스텁이 첫 allowance 응답을 붙잡음), `approve` — `amount-too-small`(보내는 USDC, 받는 DAI, 금액 `1.5`, allowance 0, 스텁이 견적 수령량을 `1`(raw)로 응답해 useAmountOutMinimum()이 `0n`),`swap` — `approve-required`(보내는 USDC, 받는 DAI, 금액 `1.5`, allowance 0), `swap` — `enter-amount`(보내는 USDC, 받는 DAI, 금액 빈 값), `swap` — `quote-ready`(보내는 ETH, 받는 USDC, 금액 `1`의 견적 `success`), `swap` — `amount-too-small`(보내는 USDC, 받는 DAI, 금액 `1.5`, allowance maxUint256, 스텁이 견적 수령량을 `1`(raw)로 응답해 useAmountOutMinimum()이 `0n`), `swap` — `price-impact-too-high`(보내는 USDC, 받는 DAI, 금액 `1.5`, allowance maxUint256, 스텁이 가격 영향 `error` 등급이 되는 견적을 응답), `approve` — `price-impact-too-high`(보내는 USDC, 받는 DAI, 금액 `1.5`, allowance 0, 스텁이 가격 영향 `error` 등급이 되는 견적을 응답)를 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링한다. 호출 직전 지갑 요청 수를 기록한다
     * @when 표본 함수를 인자 없이 호출하고 대기 중인 작업을 진행시킨다
     * @then 돌려준 Promise가 reject 없이 `undefined`로 resolve한다
     * @then 지갑 요청 수가 기록한 수에서 늘지 않는다
     * @then 전송 요청이 0건이다
     */
    it(
      "[EC-19] approve-required가 아닐 때 approve, swap-ready가 아닐 때 swap을 부르면 지갑 요청 없이 resolve한다",
      async () => {
        type OutOfStateSample = {
          call: "approve" | "swap";
          state: string;
          tokenIn: Address;
          tokenOut: Address;
          amount: string;
          quoteRule: QuoteRule;
          allowance: AllowanceFn;
          // 렌더 전에 allowance 스텁을 실패·붙잡기로 둔다.
          allowanceMode?: "fail" | "hold";
        };
        const usdcDai = { tokenIn: ETHEREUM_USDC, tokenOut: ETHEREUM_DAI, amount: "1.5" };
        const ethUsdc = { tokenIn: NATIVE_ETH, tokenOut: ETHEREUM_USDC, amount: "1" };
        const max = allowanceAlways(MAX_UINT256);
        const samples: OutOfStateSample[] = [
          {
            call: "approve",
            state: "swap-ready",
            ...usdcDai,
            quoteRule: parityQuoteRule,
            allowance: max,
          },
          {
            call: "approve",
            state: "enter-amount",
            ...usdcDai,
            amount: "",
            quoteRule: parityQuoteRule,
            allowance: defaultAllowance,
          },
          {
            call: "approve",
            state: "quote-ready",
            ...ethUsdc,
            quoteRule: parityQuoteRule,
            allowance: defaultAllowance,
          },
          {
            call: "approve",
            state: "allowance-error",
            ...usdcDai,
            quoteRule: parityQuoteRule,
            allowance: defaultAllowance,
            allowanceMode: "fail",
          },
          {
            call: "approve",
            state: "checking-allowance",
            ...usdcDai,
            quoteRule: parityQuoteRule,
            allowance: defaultAllowance,
            allowanceMode: "hold",
          },
          {
            call: "approve",
            state: "amount-too-small",
            ...usdcDai,
            quoteRule: AMOUNT_TOO_SMALL_RULE,
            allowance: defaultAllowance,
          },
          {
            call: "swap",
            state: "approve-required",
            ...usdcDai,
            quoteRule: parityQuoteRule,
            allowance: defaultAllowance,
          },
          {
            call: "swap",
            state: "enter-amount",
            ...usdcDai,
            amount: "",
            quoteRule: parityQuoteRule,
            allowance: max,
          },
          {
            call: "swap",
            state: "quote-ready",
            ...ethUsdc,
            quoteRule: parityQuoteRule,
            allowance: max,
          },
          {
            call: "swap",
            state: "amount-too-small",
            ...usdcDai,
            quoteRule: AMOUNT_TOO_SMALL_RULE,
            allowance: max,
          },
          {
            call: "swap",
            state: "price-impact-too-high",
            ...usdcDai,
            quoteRule: PRICE_IMPACT_ERROR_RULE,
            allowance: max,
          },
          {
            call: "approve",
            state: "price-impact-too-high",
            ...usdcDai,
            quoteRule: PRICE_IMPACT_ERROR_RULE,
            allowance: defaultAllowance,
          },
        ];

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const label = `${sample.call} — ${sample.state}`;
          if (sample.allowanceMode === "fail") rpc.failAllowanceWhen(matchAllowance.any);
          const allowanceGate = sample.allowanceMode === "hold" ? rpc.holdAllowance() : null;
          const s = await renderConnectedApp({
            quoteRule: sample.quoteRule,
            allowance: sample.allowance,
          });
          await enterPair(sample.tokenIn, sample.tokenOut, sample.amount, sample.state);
          if (sample.state === "amount-too-small") expect(s.probe().minimum, label).toBe(0n);
          const walletRequestsBefore = s.stub.requests.length;

          let tracked: { outcome: CallOutcome | null } | undefined;
          act(() => {
            tracked = track(s.probe().execution[sample.call]());
          });
          await waitUntil(() => expect(tracked?.outcome).not.toBeNull(), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(tracked!.outcome, label).toEqual({ status: "resolved", value: undefined });
          expect(s.stub.requests, label).toHaveLength(walletRequestsBefore);
          expect(sendCount(s.stub), label).toBe(0);
          expect(s.wallet.sent, label).toHaveLength(0);
          // 전제: 호출 뒤에도 표본 상태 그대로다.
          expect(primaryState(), label).toBe(sample.state);

          allowanceGate?.release();
          await settlePendingWork();
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-19
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 `renderAppHook`의 프로브로 useSwapExecution()을 읽는다. 표본(진행 중인 실행 — 붙잡는 요청): approve `awaiting-signature` — 보내는 USDC·받는 DAI·금액 `1.5`·allowance 0에서 주 버튼을 눌러 `eth_sendTransaction` 요청을 붙잡음, swap `awaiting-signature` — 보내는 USDC·받는 DAI·금액 `1.5`·allowance maxUint256에서 주 버튼을 눌러 `eth_sendTransaction` 요청을 붙잡음, `approving` — 보내는 USDC·받는 DAI·금액 `1.5`·allowance 0에서 주 버튼을 눌러 전송 요청은 해시로 응답하고 approve 영수증 응답을 붙잡음, `swapping` — 보내는 USDC·받는 DAI·금액 `1.5`·allowance maxUint256에서 주 버튼을 눌러 전송 요청은 해시로 응답하고 swap 영수증 응답을 붙잡음을 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링한다. 진행 중 상태가 된 뒤 지갑 요청 수를 기록한다
     * @when 진행 중에 `approve`와 `swap`을 각각 인자 없이 호출하고 대기 중인 작업을 진행시킨다
     * @then 두 호출이 돌려준 Promise가 모두 붙잡은 요청(전송 요청 또는 영수증)을 풀기 전에 reject 없이 `undefined`로 resolve한다
     * @then 지갑 요청 수가 기록한 수에서 늘지 않는다
     * @then 전송 요청은 처음 클릭의 1건뿐이다
     */
    it(
      "[EC-19] 진행 중에 approve·swap을 부르면 지갑 요청 없이 resolve한다",
      async () => {
        type ProgressSample = {
          phase: "awaiting-signature" | "approving" | "swapping";
          ready: "approve-required" | "swap-ready";
          hold: "send" | "receipt";
        };
        const samples: ProgressSample[] = [
          { phase: "awaiting-signature", ready: "approve-required", hold: "send" },
          { phase: "awaiting-signature", ready: "swap-ready", hold: "send" },
          { phase: "approving", ready: "approve-required", hold: "receipt" },
          { phase: "swapping", ready: "swap-ready", hold: "receipt" },
        ];

        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const label = `${sample.ready} 클릭 뒤 ${sample.phase}`;
          const s = await renderConnectedApp({
            quoteRule: parityQuoteRule,
            allowance:
              sample.ready === "swap-ready" ? allowanceAlways(MAX_UINT256) : defaultAllowance,
          });
          await enterPair(ETHEREUM_USDC, ETHEREUM_DAI, "1.5", sample.ready);
          const sendGate = sample.hold === "send" ? s.wallet.hold() : null;
          const receiptGate = sample.hold === "receipt" ? rpc.holdReceipt() : null;

          clickPrimary();
          if (sendGate) {
            await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
          } else {
            await waitUntil(
              () => expect(receiptGate!.heldCount).toBeGreaterThan(0),
              READY_TIMEOUT_MS,
            );
          }
          await waitUntil(
            () => expect(s.probe().execution.phase).toBe(sample.phase),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();
          const walletRequestsBefore = s.stub.requests.length;

          const calls: { outcome: CallOutcome | null }[] = [];
          act(() => {
            calls.push(track(s.probe().execution.approve()));
            calls.push(track(s.probe().execution.swap()));
          });
          // 붙잡은 요청을 풀기 전에 두 호출 모두 resolve한다.
          await waitUntil(() => {
            for (const call of calls) expect(call.outcome).not.toBeNull();
          }, READY_TIMEOUT_MS);
          await settlePendingWork();

          for (const [callIndex, call] of calls.entries()) {
            expect(call.outcome, `${label} #${callIndex}`).toEqual({
              status: "resolved",
              value: undefined,
            });
          }
          expect(s.stub.requests, label).toHaveLength(walletRequestsBefore);
          expect(sendCount(s.stub), label).toBe(1);
          expect(s.wallet.sent, label).toHaveLength(1);
          expect(s.probe().execution.phase, label).toBe(sample.phase);

          sendGate?.release();
          receiptGate?.release();
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
