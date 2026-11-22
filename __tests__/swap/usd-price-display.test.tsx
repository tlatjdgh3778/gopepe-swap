import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { renderToString } from "react-dom/server";
import type { Address } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateConnectorFn } from "wagmi";

import Home from "@/app/page";
import { type WagmiConfig, createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { useTokenUsdPrice } from "@/hooks/use-token-usd-price";
import { AppProviders } from "@/providers/app-providers";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type BalanceRpcStub,
  type HoldGate,
  type QuoteRule,
  type StubPrice,
  balancesWith,
  defaultQuoteRule,
  defaultSlot0SqrtPriceX96,
  expectedStubUsdPrice,
  installBalanceRpcStub,
  match,
  matchQuote,
  matchUsdPrice,
  sameAddress,
  stubRevertQuote,
  stubUsdMicros,
  usdPriceRuleWith,
} from "../support/rpc-balance-stub";
import {
  clearCookies,
  createNoopWagmiStorage,
  mockConnector,
  renderAppHook,
  settlePendingWork,
  waitUntil,
} from "../support/wagmi-harness";

// 골격(T-9). 보내는·받는 칸의 USD 행(usd-value), 카드 잔액 USD(balance-usd), 견적 정보 행 USD(quote-amount-out-usd·
// quote-amount-out-minimum-usd)의 상태별 표시와, 서버 렌더링과 첫 클라이언트 렌더의 usd-value 상태 일치를 앱 화면으로 확인한다.
// 판정은 스펙 §4.4의 testid·data 속성(data-side, data-state, data-usd-micros), usd-skeleton 유무, 접근성 이름(role 조회)과 스텁이 받은 요청으로 한다.
// 모달 행 USD(token-option-usd)는 T-11(usd-price-modal)이 맡는다.
// mock 경계(사용자 확정 2026-11-22): T-8 경계(실제 wagmi·Provider·화면, wagmi mock 커넥터, 전역 fetch의 URL 라우팅 스텁과
// 단가 aggregate3 스텁 분류·응답, HTTP 429 응답, vi.mock 금지)에 EC-24 한정 서버 렌더(`react-dom/server`)를 더한 것.
// 이 경계는 실제 Next SSR·하이드레이션 경로를 증명하지 못한다.
// 데이터 격리: 테스트(표본)마다 config·RPC 스텁·QueryClient를 새로 만들고 쿠키를 지운다(clearCookies).
// 기대 주소(ETH, WETH, USDC)는 제품 config를 쓰지 않고 리터럴로 적는다. 기대 micros는 스텁 slot0로 테스트가 따로 계산한 단가로
// 금액 × numerator / denominator를 버림한 값의 10진 문자열이다(제품 toUsdMicros로 만들지 않는다).

const CASE_TIMEOUT_MS = 30_000;
const MULTI_SAMPLE_TIMEOUT_MS = 180_000;

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

// 같은 case 안에서 표본마다 앱(config·QueryClient)과 스텁을 새로 만든다.
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  rpc = installBalanceRpcStub();
}

type Side = "in" | "out";

// ─── Ethereum 공식 주소·토큰(리터럴) ─────────────────────────────────

type TokenLiteral = { address: Address; decimals: number };

const ETH: TokenLiteral = { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", decimals: 18 };
const WETH: TokenLiteral = { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 };
const USDC: TokenLiteral = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 };
// USDC 직접 경로가 있는 토큰(기본 단가 규칙)
const DAI: TokenLiteral = { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 };
// 단가 없음·실패 표본 토큰
const LINK: TokenLiteral = { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 };

// 금액 문자열과 그 raw 값(테스트 쪽 리터럴, decimals 18)
const AMOUNT_ONE = { text: "1", raw: 10n ** 18n };
const AMOUNT_TWO = { text: "2", raw: 2n * 10n ** 18n };
const AMOUNT_FRACTION = { text: "1.234567890123456789", raw: 1_234_567_890_123_456_789n };

const NO_USD_PRICE_NAME = "USD 가격 없음";

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

// ─── 화면 ─────────────────────────────────────────────────────────

function field(side: Side): HTMLElement {
  const found = screen
    .getAllByTestId("token-field")
    .find((element) => element.getAttribute("data-side") === side);
  if (!found) throw new Error(`token-field[data-side="${side}"]가 없다`);
  return found;
}

function usdValue(side: Side): HTMLElement {
  const found = screen
    .queryAllByTestId("usd-value")
    .find((element) => element.getAttribute("data-side") === side);
  if (!found) throw new Error(`usd-value[data-side="${side}"]가 없다`);
  return found;
}

function usdState(side: Side): string | null {
  return usdValue(side).getAttribute("data-state");
}

function usdMicros(element: HTMLElement): string | null {
  return element.getAttribute("data-usd-micros");
}

function amountInput(): HTMLInputElement {
  return within(field("in")).getByTestId("amount-input") as HTMLInputElement;
}

function balanceRaw(side: Side): string | null {
  return within(field(side)).getByTestId("balance").getAttribute("data-balance-raw");
}

function balanceUsd(side: Side): HTMLElement | null {
  return within(field(side)).queryByTestId("balance-usd");
}

function quoteRow(testId: "quote-amount-out" | "quote-amount-out-minimum"): HTMLElement {
  const details = screen.queryByTestId("quote-details");
  if (!details) throw new Error("quote-details가 없다");
  return within(details).getByTestId(testId);
}

// 칸 안에서 usd-value 바깥에 있는 usd-skeleton 수(카드 잔액 USD 자리)
function skeletonsOutsideUsdValue(side: Side): number {
  const row = usdValue(side);
  return within(field(side))
    .queryAllByTestId("usd-skeleton")
    .filter((element) => !row.contains(element)).length;
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

async function chooseToken(side: Side, token: TokenLiteral) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  fireEvent.click(optionRow(token.address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function appConfig(connector?: CreateConnectorFn): WagmiConfig {
  return createWagmiConfig({
    connectors: connector ? [connector] : [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
}

// 단가 훅(스펙 §4.2)은 ETH와 표본 토큰 둘을 함께 읽어 단가 상태를 확인한다.
type ProbeTokens = { a?: Address; b?: Address };

function probeHook(tokens: ProbeTokens) {
  return () => ({
    quote: useSwapQuote(),
    amountOutMinimum: useAmountOutMinimum(),
    eth: useTokenUsdPrice(mainnet.id, ETH.address),
    a: useTokenUsdPrice(mainnet.id, tokens.a),
    b: useTokenUsdPrice(mainnet.id, tokens.b),
  });
}

// wagmi mock 커넥터로 Ethereum에 연결된 앱(선택 체인 Ethereum, 보내는 ETH가 기본)
async function renderConnectedApp(tokens: ProbeTokens = {}) {
  const config = appConfig(mockConnector({ defaultConnected: true, reconnect: true }));
  const view = renderAppHook(probeHook(tokens), { config, initialChainId: mainnet.id });
  await waitUntil(() => expect(CONNECTED_STATES).toContain(primaryState()));
  return view;
}

// 저장된 연결이 없는 미연결 앱. 커넥터가 없어 복원 시도가 곧 끝난다.
async function renderDisconnectedApp(tokens: ProbeTokens = {}) {
  const view = renderAppHook(probeHook(tokens), {
    config: appConfig(),
    initialChainId: mainnet.id,
  });
  await waitUntil(() => expect(primaryState()).toBe("disconnected"));
  return view;
}

// ─── 기대값(테스트 쪽 계산) ──────────────────────────────────────

// 현재 스텁 단가 규칙으로 테스트가 따로 계산한 Ethereum 토큰 단가
function expectedPrice(token: TokenLiteral): StubPrice {
  const expected = expectedStubUsdPrice(rpc.usdPriceRule(), {
    chainId: mainnet.id,
    token: token.address,
    decimals: token.decimals,
  });
  expect(expected.status, token.address).toBe("success");
  if (expected.status !== "success") throw new Error("unreachable");
  return expected.price;
}

// 토큰의 USDC 직접·WETH 경유 단가 견적을 모두 revert로 응답하는 규칙(단가 없음)
function noPriceRule(...tokens: TokenLiteral[]): QuoteRule {
  return usdPriceRuleWith(
    tokens.flatMap((token) => [
      {
        chainId: mainnet.id,
        tokenIn: token.address,
        tokenOut: USDC.address,
        quote: stubRevertQuote,
      },
      {
        chainId: mainnet.id,
        tokenIn: token.address,
        tokenOut: WETH.address,
        quote: stubRevertQuote,
      },
    ]),
  );
}

// 모든 풀의 slot0 sqrtPriceX96을 기본값 + 12,345(Q96의 정수배가 아님)로 응답하는 단가 규칙(DoD-16 버림 표본용)
const FRACTIONAL_SLOT0_USD_PRICE_RULE: QuoteRule = {
  quote: defaultQuoteRule.quote,
  slot0: (query) => ({ status: "ok", sqrtPriceX96: defaultSlot0SqrtPriceX96(query.fee) + 12_345n }),
};

// 견적 네 티어를 모두 revert로 응답하는 견적 규칙(`no-route`)
const NO_ROUTE_QUOTE_RULE: QuoteRule = { quote: stubRevertQuote, slot0: defaultQuoteRule.slot0 };

describe("USD 표시 — 사용자가 금액·잔액·예상·최소 수령량의 USD 환산을 본다", () => {
  describe("보내는 칸 USD 행", () => {
    /**
     * @spec DoD-16
     * @given 선택 체인은 Ethereum이다. 스텁은 단가에 성공 응답을 주고 고른 티어 풀의 slot0을 2^96이 아닌 sqrtPriceX96로 돌려준다. 연결 표본(mock 커넥터로 Ethereum에 연결): 보내는 토큰 ETH(받는 미선택), ETH(받는 USDC, 견적 응답 붙잡기 중), USDC 직접 경로 토큰(받는 미선택)과 금액 정수 금액, 소수부가 있어 버림이 드러나는 금액의 토큰 3 × 금액 2 조합. 미연결 표본(저장된 연결 없음, 복원 완료): 보내는 ETH(받는 미선택), 소수부가 있는 금액. 모든 표본을 하나씩 반복한다
     * @when 금액을 입력하고 보내는 토큰 단가 조회가 끝나기를 기다린다
     * @then usd-value[data-side=in]의 data-state가 `success`다
     * @then usd-value[data-side=in]의 data-usd-micros가 amountInRaw × 보내는 토큰 단가 numerator / denominator를 버림한 값(테스트 계산)의 10진 문자열이다
     * @then usd-value[data-side=in] 안에 usd-skeleton이 없다
     */
    it(
      "[DoD-16] 보내는 금액과 단가가 있으면 보내는 USD 행이 success와 환산 micros를 갖는다",
      async () => {
        type Sample = {
          connected: boolean;
          token: TokenLiteral;
          out: "none" | "usdc-held";
          amount: { text: string; raw: bigint };
        };
        const connectedTokens: Pick<Sample, "token" | "out">[] = [
          { token: ETH, out: "none" },
          { token: ETH, out: "usdc-held" },
          { token: DAI, out: "none" },
        ];
        const samples: Sample[] = [
          ...connectedTokens.flatMap(({ token, out }) =>
            [AMOUNT_TWO, AMOUNT_FRACTION].map((amount) => ({
              connected: true,
              token,
              out,
              amount,
            })),
          ),
          { connected: false, token: ETH, out: "none", amount: AMOUNT_FRACTION },
        ];

        for (const [index, sample] of samples.entries()) {
          const label = `${sample.connected ? "연결" : "미연결"} ${sample.token.address} ${sample.out} ${sample.amount.text}`;
          if (index > 0) resetSample();
          // 기본 slot0(2·3·5·7 × Q96)은 단가가 정수나 1/정수²라 버림이 드러나지 않을 수 있다.
          // 모든 풀의 slot0을 정수배가 아닌 값으로 바꿔 단가를 분수로 만든다.
          rpc.setUsdPriceRule(FRACTIONAL_SLOT0_USD_PRICE_RULE);
          const price = expectedPrice(sample.token);
          if (sample.amount === AMOUNT_FRACTION) {
            // 전제: 이 금액은 버림이 드러난다.
            expect((sample.amount.raw * price.numerator) % price.denominator, label).not.toBe(0n);
          }

          const gate = sample.out === "usdc-held" ? rpc.holdQuote() : undefined;
          if (sample.connected) await renderConnectedApp();
          else await renderDisconnectedApp();
          if (sample.token !== ETH) await chooseToken("in", sample.token);
          if (sample.out === "usdc-held") await chooseToken("out", USDC);
          await typeAmount(sample.amount.text);
          if (gate) await waitUntil(() => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1));

          await waitUntil(() => expect(usdState("in"), label).toBe("success"));
          expect(usdMicros(usdValue("in")), label).toBe(
            stubUsdMicros(sample.amount.raw, price).toString(),
          );
          expect(within(usdValue("in")).queryAllByTestId("usd-skeleton"), label).toHaveLength(0);
          gate?.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-1
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH가 선택돼 있다. 표본 보내는 ETH 단가: 성공 응답(`success`), ETH(WETH) 단가 견적 티어를 모두 revert로 응답(`no-price`), 단가 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답(`error`). 표본 금액: 빈 값(초기 상태), `0`, `0.00`, 금액 `1`로 usd-value[data-side=in]이 단가 표본의 상태가 된 뒤 금액을 지움. 단가 3 × 금액 4의 조합을 하나씩 반복한다
     * @when 표본 상태를 만든 뒤 보내는 칸을 확인한다
     * @then usd-value[data-side=in]이 렌더링돼 있다(행 자리를 유지한다)
     * @then usd-value[data-side=in]의 data-state가 `empty`이고 data-usd-micros가 없다
     */
    it(
      "[EC-1] 보내는 금액이 비었거나 0이면 보내는 USD 행은 자리를 유지한 채 empty다",
      async () => {
        const priceSamples = ["success", "no-price", "error"] as const;
        const expectEmpty = (label: string) => {
          expect(
            screen.queryAllByTestId("usd-value").some((e) => e.getAttribute("data-side") === "in"),
            label,
          ).toBe(true);
          expect(usdState("in"), label).toBe("empty");
          expect(usdMicros(usdValue("in")), label).toBeNull();
        };

        for (const [index, priceSample] of priceSamples.entries()) {
          if (index > 0) resetSample();
          if (priceSample === "no-price") rpc.setUsdPriceRule(noPriceRule(WETH));
          if (priceSample === "error") rpc.failUsdPriceWhen(matchUsdPrice.any);

          const view = await renderConnectedApp();
          // 전제: 보내는 ETH 단가가 표본 상태다.
          await waitUntil(() =>
            expect(view.result.current.eth.status, priceSample).toBe(priceSample),
          );

          expectEmpty(`${priceSample} 빈 값(초기 상태)`);
          for (const text of ["0", "0.00"]) {
            await typeAmount(text);
            await settlePendingWork();
            expectEmpty(`${priceSample} ${text}`);
          }
          await typeAmount(AMOUNT_ONE.text);
          await waitUntil(() => expect(usdState("in"), priceSample).toBe(priceSample));
          await typeAmount("");
          await settlePendingWork();
          expectEmpty(`${priceSample} 금액을 지움`);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("받는 칸 USD 행", () => {
    /**
     * @spec DoD-17 DoD-21 DoD-22
     * @given 선택 체인은 Ethereum이다. 스텁은 견적과 단가에 성공 응답을 주고 고른 티어 풀의 slot0을 2^96이 아닌 sqrtPriceX96로 돌려준다. 슬리피지는 기본값이다. 표본: mock 커넥터로 Ethereum에 연결돼 보내는 토큰 잔액이 금액보다 크게 읽힌 상태의 보내는 ETH·받는 USDC와 보내는 USDC·받는 ETH, 미연결(저장된 연결 없음, 복원 완료) 상태의 보내는 USDC·받는 ETH를 하나씩 반복하며 금액 `1`을 입력한다
     * @when 입력 반영 대기(300ms)가 지나고 견적과 받는 토큰 단가 조회가 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `success`다
     * @then usd-value[data-side=out]의 data-state가 `success`이고 data-usd-micros가 useSwapQuote()의 amountOut × 받는 토큰 단가 numerator / denominator를 버림한 값(테스트 계산)의 10진 문자열이다
     * @then quote-amount-out-usd의 data-usd-micros가 같은 amountOut과 받는 토큰 단가로 테스트가 계산한 값의 10진 문자열이다
     * @then quote-amount-out-minimum-usd의 data-usd-micros가 useAmountOutMinimum() 값 × 받는 토큰 단가 numerator / denominator를 버림한 값(테스트 계산)의 10진 문자열이다
     * @then quote-amount-out-minimum-usd의 data-usd-micros가 quote-amount-out-usd의 data-usd-micros와 다르다(최소 수령량을 쓴다)
     */
    it(
      "[DoD-17][DoD-21][DoD-22] 견적 success에서 받는 USD 행과 예상·최소 수령량 USD가 받는 토큰 단가로 환산된다",
      async () => {
        const samples: { connected: boolean; tokenIn: TokenLiteral; tokenOut: TokenLiteral }[] = [
          { connected: true, tokenIn: ETH, tokenOut: USDC },
          { connected: true, tokenIn: USDC, tokenOut: ETH },
          { connected: false, tokenIn: USDC, tokenOut: ETH },
        ];

        for (const [index, sample] of samples.entries()) {
          const label = `${sample.connected ? "연결" : "미연결"} ${sample.tokenIn.address}→${sample.tokenOut.address}`;
          if (index > 0) resetSample();
          const price = expectedPrice(sample.tokenOut);

          const view = sample.connected
            ? await renderConnectedApp()
            : await renderDisconnectedApp();
          if (sample.tokenIn !== ETH) await chooseToken("in", sample.tokenIn);
          await chooseToken("out", sample.tokenOut);
          await typeAmount("1");
          await waitUntil(() => expect(view.result.current.quote.status, label).toBe("success"));
          await waitUntil(() => expect(usdState("out"), label).toBe("success"));
          await waitUntil(() =>
            expect(screen.queryByTestId("quote-amount-out-minimum-usd"), label).not.toBeNull(),
          );
          await settlePendingWork();

          const quote = view.result.current.quote;
          expect(quote.status, label).toBe("success");
          const amountOut = quote.status === "success" ? quote.quote.amountOut : 0n;
          const minimum = view.result.current.amountOutMinimum;
          expect(minimum, label).not.toBeNull();

          const outMicros = stubUsdMicros(amountOut, price).toString();
          expect(usdState("out"), label).toBe("success");
          expect(usdMicros(usdValue("out")), label).toBe(outMicros);
          const amountOutUsd = within(quoteRow("quote-amount-out")).getByTestId(
            "quote-amount-out-usd",
          );
          expect(usdMicros(amountOutUsd), label).toBe(outMicros);
          const minimumUsd = within(quoteRow("quote-amount-out-minimum")).getByTestId(
            "quote-amount-out-minimum-usd",
          );
          expect(usdMicros(minimumUsd), label).toBe(stubUsdMicros(minimum!, price).toString());
          expect(usdMicros(minimumUsd), label).not.toBe(usdMicros(amountOutUsd));
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-3
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 USDC(잔액 충분), 받는 ETH, 금액 `1`이다. 표본 견적 상태: 견적 응답 붙잡기 중(`loading`), 견적 네 티어 모두 revert(`no-route`), 견적 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답(`error`). 표본 받는 ETH 단가: 성공 응답(`success`), 첫 응답 붙잡기 중, 단가 견적 티어 모두 revert(`no-price`). 견적 3 × 단가 3의 조합을 하나씩 반복한다
     * @when 표본 견적 상태가 되기를 기다린다
     * @then useSwapQuote()의 status가 표본 견적 상태다
     * @then usd-value[data-side=out]이 렌더링돼 있고 data-state가 `empty`이며 data-usd-micros가 없다
     */
    it(
      "[EC-3] 견적이 loading·no-route·error이면 받는 USD 행은 empty다",
      async () => {
        const priceSamples = ["success", "held", "no-price"] as const;
        const expectOutEmpty = (label: string) => {
          expect(
            screen.queryAllByTestId("usd-value").some((e) => e.getAttribute("data-side") === "out"),
            label,
          ).toBe(true);
          expect(usdState("out"), label).toBe("empty");
          expect(usdMicros(usdValue("out")), label).toBeNull();
        };

        for (const [index, priceSample] of priceSamples.entries()) {
          if (index > 0) resetSample();
          let priceGate: HoldGate | undefined;
          if (priceSample === "no-price") rpc.setUsdPriceRule(noPriceRule(WETH));
          if (priceSample === "held")
            priceGate = rpc.holdUsdPrice(matchUsdPrice.target(WETH.address));

          const view = await renderConnectedApp();
          await chooseToken("in", USDC);
          await chooseToken("out", ETH);
          // 전제: 받는 ETH 단가가 표본 상태다.
          if (priceGate) {
            await waitUntil(() =>
              expect(priceGate!.heldCount, priceSample).toBeGreaterThanOrEqual(1),
            );
            expect(view.result.current.eth.status, priceSample).toBe("loading");
          } else {
            await waitUntil(() =>
              expect(view.result.current.eth.status, priceSample).toBe(priceSample),
            );
          }

          // 견적 `loading`: 견적 응답을 붙잡는다.
          const quoteGate = rpc.holdQuote();
          await typeAmount("1");
          await waitUntil(() => expect(quoteGate.heldCount, priceSample).toBeGreaterThanOrEqual(1));
          expect(view.result.current.quote.status, `${priceSample} loading`).toBe("loading");
          expectOutEmpty(`${priceSample} loading`);

          // 견적 `no-route`: 붙잡은 응답을 네 티어 revert 규칙으로 푼다(응답 시점의 규칙으로 응답한다).
          rpc.setQuoteRule(NO_ROUTE_QUOTE_RULE);
          quoteGate.release();
          await waitUntil(() =>
            expect(view.result.current.quote.status, priceSample).toBe("no-route"),
          );
          await settlePendingWork();
          expectOutEmpty(`${priceSample} no-route`);

          // 견적 `error`: 다음 견적 요청을 JSON-RPC 오류로 응답한다.
          rpc.setQuoteRule(defaultQuoteRule);
          rpc.failQuoteWhen(matchQuote.input());
          await typeAmount("2");
          await waitUntil(() =>
            expect(view.result.current.quote.status, priceSample).toBe("error"),
          );
          await settlePendingWork();
          expectOutEmpty(`${priceSample} error`);

          if (priceGate) expect(view.result.current.eth.status, priceSample).toBe("loading");
          else expect(view.result.current.eth.status, priceSample).toBe(priceSample);
          priceGate?.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-18
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 토큰 잔액이 금액보다 크게 읽혔다. 스텁은 WETH 단가에 성공 응답을 주고 고른 티어 풀의 slot0을 2^96이 아닌 sqrtPriceX96로 돌려준다. 표본 페어: 보내는 ETH·받는 WETH(`wrap`), 보내는 WETH·받는 ETH(`unwrap`)를 하나씩 반복하며 금액 `1`을 입력한다
     * @when 단가 조회가 끝나기를 기다린다
     * @then useSwapQuote()의 status가 `wrap`이다
     * @then usd-value[data-side=in]과 usd-value[data-side=out]의 data-state가 모두 `success`다
     * @then 두 usd-value의 data-usd-micros가 같고, amountInRaw × WETH 단가 numerator / denominator를 버림한 값(테스트 계산)의 10진 문자열이다
     */
    it(
      "[DoD-18] ETH ↔ WETH 두 방향에서 보내는·받는 USD가 WETH 단가로 같은 micros다",
      async () => {
        const samples: { tokenIn: TokenLiteral; tokenOut: TokenLiteral }[] = [
          { tokenIn: ETH, tokenOut: WETH },
          { tokenIn: WETH, tokenOut: ETH },
        ];
        for (const [index, { tokenIn, tokenOut }] of samples.entries()) {
          const label = `${tokenIn.address}→${tokenOut.address}`;
          if (index > 0) resetSample();
          const price = expectedPrice(WETH);

          const view = await renderConnectedApp();
          if (tokenIn !== ETH) await chooseToken("in", tokenIn);
          await chooseToken("out", tokenOut);
          await typeAmount(AMOUNT_ONE.text);
          await waitUntil(() => expect(view.result.current.quote.status, label).toBe("wrap"));
          await waitUntil(() => {
            expect(usdState("in"), label).toBe("success");
            expect(usdState("out"), label).toBe("success");
          });

          const expected = stubUsdMicros(AMOUNT_ONE.raw, price).toString();
          expect(usdMicros(usdValue("in")), label).toBe(expected);
          expect(usdMicros(usdValue("out")), label).toBe(expected);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("단가를 기다리거나 표시할 수 없는 USD 행", () => {
    /**
     * @spec EC-2
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 토큰 잔액이 금액보다 크게 읽혔다. 표본: 보내는 ETH·받는 미선택·금액 `1`이고 스텁이 ETH 단가 첫 응답을 붙잡음(보내는 쪽), 보내는 USDC·받는 ETH·금액 `1`이고 견적은 `success`이며 스텁이 ETH 단가 첫 응답을 붙잡음(받는 쪽)을 하나씩 반복한다
     * @when 단가 응답을 붙잡은 상태에서 표본 쪽 usd-value를 확인한다
     * @then 표본 쪽 usd-value[data-side]의 data-state가 `loading`이고 data-usd-micros가 없다
     * @then 표본 쪽 usd-value[data-side] 안에 usd-skeleton이 있다
     */
    it(
      "[EC-2] 금액이 있고 단가 첫 조회 중이면 USD 행은 loading이고 usd-skeleton을 보인다",
      async () => {
        const samples = ["in", "out"] as const;
        for (const [index, side] of samples.entries()) {
          const label = side;
          if (index > 0) resetSample();
          // ETH 단가의 첫 응답을 붙잡는다.
          const gate = rpc.holdUsdPrice(matchUsdPrice.target(WETH.address));

          const view = await renderConnectedApp();
          if (side === "out") {
            await chooseToken("in", USDC);
            await chooseToken("out", ETH);
          }
          await typeAmount("1");
          if (side === "out") {
            await waitUntil(() => expect(view.result.current.quote.status, label).toBe("success"));
          }
          await waitUntil(() => expect(gate.heldCount, label).toBeGreaterThanOrEqual(1));
          await settlePendingWork();

          expect(view.result.current.eth.status, label).toBe("loading");
          expect(usdState(side), label).toBe("loading");
          expect(usdMicros(usdValue(side)), label).toBeNull();
          expect(
            within(usdValue(side)).queryAllByTestId("usd-skeleton").length,
            label,
          ).toBeGreaterThan(0);
          gate.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-4
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 스텁은 대상 토큰(주소 리터럴)의 USDC 직접·WETH 경유 단가 견적 티어를 모두 revert로 응답한다. 표본: 보내는 대상 토큰·받는 미선택·금액 `1`(보내는 쪽), 보내는 ETH·받는 대상 토큰·금액 `1`이고 견적은 `success`(받는 쪽)를 하나씩 반복한다
     * @when 대상 토큰 단가 결과가 나오기를 기다린다
     * @then 표본 쪽 usd-value[data-side]의 data-state가 `no-price`이고 data-usd-micros가 없다
     * @then 표본 쪽 usd-value[data-side] 안에서 접근성 이름이 `USD 가격 없음`인 요소를 role 조회로 찾는다
     */
    it(
      "[EC-4] 단가가 no-price이면 USD 행은 no-price이고 접근성 이름 USD 가격 없음을 보인다",
      async () => {
        const samples = ["in", "out"] as const;
        for (const [index, side] of samples.entries()) {
          const label = side;
          if (index > 0) resetSample();
          rpc.setUsdPriceRule(noPriceRule(LINK));

          const view = await renderConnectedApp({ a: LINK.address });
          if (side === "in") {
            await chooseToken("in", LINK);
          } else {
            await chooseToken("out", LINK);
          }
          await typeAmount("1");
          if (side === "out") {
            await waitUntil(() => expect(view.result.current.quote.status, label).toBe("success"));
          }
          await waitUntil(() => expect(view.result.current.a.status, label).toBe("no-price"));
          await waitUntil(() => expect(usdState(side), label).toBe("no-price"));

          expect(usdMicros(usdValue(side)), label).toBeNull();
          expect(
            within(usdValue(side)).getByRole("img", { name: NO_USD_PRICE_NAME }),
            label,
          ).toBeTruthy();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-5
     * @given mock 커넥터로 Ethereum에 연결돼 있다. 스텁은 대상 토큰 단가 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답한다(이전 값 없음). 표본: 보내는 ETH·받는 미선택·금액 `1`(보내는 쪽), 보내는 USDC·받는 ETH·금액 `1`이고 견적은 `success`(받는 쪽)를 하나씩 반복한다
     * @when 대상 토큰 단가 결과가 나오기를 기다린다
     * @then 표본 쪽 usd-value[data-side]의 data-state가 `error`이고 data-usd-micros가 없다
     * @then 표본 쪽 usd-value[data-side] 안에서 접근성 이름이 `USD 가격 없음`인 요소를 role 조회로 찾는다
     */
    it(
      "[EC-5] 단가가 error이면 USD 행은 error이고 접근성 이름 USD 가격 없음을 보인다",
      async () => {
        const samples = ["in", "out"] as const;
        for (const [index, side] of samples.entries()) {
          const label = side;
          if (index > 0) resetSample();
          rpc.failUsdPriceWhen(matchUsdPrice.any);

          const view = await renderConnectedApp();
          if (side === "out") {
            await chooseToken("in", USDC);
            await chooseToken("out", ETH);
          }
          await typeAmount("1");
          if (side === "out") {
            await waitUntil(() => expect(view.result.current.quote.status, label).toBe("success"));
          }
          await waitUntil(() => expect(view.result.current.eth.status, label).toBe("error"));
          await waitUntil(() => expect(usdState(side), label).toBe("error"));

          expect(usdMicros(usdValue(side)), label).toBeNull();
          expect(
            within(usdValue(side)).getByRole("img", { name: NO_USD_PRICE_NAME }),
            label,
          ).toBeTruthy();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("카드 잔액 USD", () => {
    /**
     * @spec DoD-19
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC가 선택돼 있다. 스텁은 두 칸의 카드 잔액을 0보다 큰 서로 다른 값으로, 단가에 성공 응답을 주고 고른 티어 풀의 slot0을 2^96이 아닌 sqrtPriceX96로 돌려준다. 표본 칸: 보내는 칸(ETH), 받는 칸(USDC)을 하나씩 확인한다
     * @when 카드 잔액 읽기와 두 토큰 단가 조회가 끝나기를 기다린다
     * @then 표본 칸(token-field[data-side]) 안 balance-usd의 data-usd-micros가 그 칸의 잔액 raw × 그 토큰 단가 numerator / denominator를 버림한 값(테스트 계산)의 10진 문자열이다
     */
    it(
      "[DoD-19] 연결 상태에서 잔액과 단가가 있으면 카드 잔액 USD가 환산 micros를 갖는다",
      async () => {
        const view = await renderConnectedApp();
        await chooseToken("out", USDC);
        await waitUntil(() => {
          expect(balanceRaw("in")).not.toBeNull();
          expect(balanceRaw("out")).not.toBeNull();
        });
        await waitUntil(() => expect(view.result.current.eth.status).toBe("success"));
        await waitUntil(() => {
          expect(balanceUsd("in")).not.toBeNull();
          expect(balanceUsd("out")).not.toBeNull();
        });

        const samples: { side: Side; token: TokenLiteral }[] = [
          { side: "in", token: ETH },
          { side: "out", token: USDC },
        ];
        for (const { side, token } of samples) {
          const raw = BigInt(balanceRaw(side)!);
          // 전제: 두 칸의 잔액이 0보다 크다.
          expect(raw, side).toBeGreaterThan(0n);
          expect(usdMicros(balanceUsd(side)!), side).toBe(
            stubUsdMicros(raw, expectedPrice(token)).toString(),
          );
        }
        // 전제: 스텁이 두 칸에 서로 다른 잔액을 돌려준다.
        expect(balanceRaw("in")).not.toBe(balanceRaw("out"));
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-6
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH가 선택돼 있다. 스텁은 ETH 단가에 성공 응답을 준다. 표본 카드 잔액: 잔액 0, 첫 잔액 읽기 응답 지연 중(`—`), 잔액 읽기 실패(`—`)를 하나씩 반복한다
     * @when ETH 단가 조회가 끝나고 표본 잔액 상태가 되기를 기다린다
     * @then 보내는 칸(token-field[data-side=in]) 안에 balance-usd가 없다
     */
    it(
      "[EC-6] 카드 잔액이 0이거나 알 수 없으면 카드 잔액 USD가 없다",
      async () => {
        const samples = ["잔액 0", "첫 잔액 읽기 지연", "잔액 읽기 실패"] as const;
        for (const [index, sample] of samples.entries()) {
          const label = sample;
          if (index > 0) resetSample();
          let gate: HoldGate | undefined;
          if (sample === "잔액 0") rpc.setBalances(balancesWith({ [ETH.address]: 0n }));
          if (sample === "첫 잔액 읽기 지연") gate = rpc.hold(match.kind("eth_getBalance"));
          if (sample === "잔액 읽기 실패") rpc.failWhen(match.kind("eth_getBalance"));

          const view = await renderConnectedApp();
          await waitUntil(() => expect(view.result.current.eth.status, label).toBe("success"));
          if (sample === "잔액 0") {
            await waitUntil(() => expect(balanceRaw("in"), label).toBe("0"));
          } else if (gate) {
            await waitUntil(() => expect(gate!.heldCount, label).toBeGreaterThanOrEqual(1));
          } else {
            await waitUntil(() =>
              expect(
                rpc
                  .requests(match.kind("eth_getBalance"))
                  .some((request) => request.status === "failed"),
                label,
              ).toBe(true),
            );
          }
          await settlePendingWork();
          if (sample !== "잔액 0") expect(balanceRaw("in"), label).toBeNull();

          expect(balanceUsd("in"), label).toBeNull();
          gate?.release();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("단가를 표시할 수 없는 잔액·견적 행 USD", () => {
    /**
     * @spec EC-7
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 대상 토큰 A, 받는 대상 토큰 B(주소 리터럴), 금액 `1`이다. 스텁은 두 칸의 카드 잔액을 0보다 크게, 견적에 성공 응답을 준다. 표본 단가 상태: 두 토큰 단가 견적 티어를 모두 revert로 응답(`no-price`), 두 토큰 단가 요청을 transport 재시도 대상이 아닌 JSON-RPC 오류로 응답(`error`, 이전 값 없음)을 하나씩 반복한다. 모달 행(token-option-usd)은 T-11이 판정한다
     * @when 카드 잔액 읽기, 견적, 두 토큰 단가 결과가 나오기를 기다린다
     * @then useSwapQuote()의 status가 `success`이고 두 칸 balance 요소에 data-balance-raw가 있다
     * @then 두 칸 어디에도 balance-usd가 없다
     * @then quote-amount-out-usd와 quote-amount-out-minimum-usd가 없다
     */
    it(
      "[EC-7] 단가가 no-price·error이면 카드 잔액·견적 행 USD가 없다",
      async () => {
        const samples = ["no-price", "error"] as const;
        for (const [index, sample] of samples.entries()) {
          const label = sample;
          if (index > 0) resetSample();
          if (sample === "no-price") rpc.setUsdPriceRule(noPriceRule(LINK, DAI));
          else {
            rpc.failUsdPriceWhen(
              (request) =>
                matchUsdPrice.target(LINK.address)(request) ||
                matchUsdPrice.target(DAI.address)(request),
            );
          }

          const view = await renderConnectedApp({ a: LINK.address, b: DAI.address });
          await chooseToken("in", LINK);
          await chooseToken("out", DAI);
          await typeAmount("1");
          await waitUntil(() => expect(view.result.current.quote.status, label).toBe("success"));
          await waitUntil(() => {
            expect(balanceRaw("in"), label).not.toBeNull();
            expect(balanceRaw("out"), label).not.toBeNull();
          });
          await waitUntil(() => {
            expect(view.result.current.a.status, label).toBe(sample);
            expect(view.result.current.b.status, label).toBe(sample);
          });
          await settlePendingWork();

          expect(balanceUsd("in"), label).toBeNull();
          expect(balanceUsd("out"), label).toBeNull();
          expect(screen.queryByTestId("quote-amount-out-usd"), label).toBeNull();
          expect(screen.queryByTestId("quote-amount-out-minimum-usd"), label).toBeNull();
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("단가 첫 조회 중인 잔액·견적 행 USD", () => {
    /**
     * @spec EC-8
     * @given mock 커넥터로 Ethereum에 연결돼 있고 보내는 ETH, 받는 USDC 직접 경로 토큰 B(주소 리터럴)가 선택돼 있다. 스텁은 두 칸의 카드 잔액을 0보다 크게, 견적에 성공 응답을 주고, 두 토큰 단가의 첫 응답을 붙잡는다. 모달 행(token-option-usd)은 T-11이 판정한다
     * @when 금액이 빈 상태에서 카드 잔액 읽기가 끝나기를 기다려 확인하고, 이어서 금액 `1`을 입력해 입력 반영 대기(300ms)가 지나고 견적이 끝나기를 기다려 확인한다
     * @then 금액이 빈 시점에 usd-value[data-side=in]·usd-value[data-side=out]의 data-state가 `empty`이고, 두 칸(token-field[data-side=in], token-field[data-side=out]) 각각 안 usd-value 바깥에 usd-skeleton이 있다(카드 잔액 USD 자리)
     * @then 견적 success 시점에 quote-amount-out과 quote-amount-out-minimum 각각 안에 usd-skeleton이 있고 quote-skeleton이 없다
     * @then 견적 success 시점에 quote-amount-out-usd와 quote-amount-out-minimum-usd에 data-usd-micros가 없다
     */
    it(
      "[EC-8] 단가 첫 조회 중 카드 잔액·견적 행의 USD 자리에 usd-skeleton을 보인다",
      async () => {
        // 두 토큰(ETH·DAI) 단가의 첫 응답을 붙잡는다.
        const gate = rpc.holdUsdPrice();
        const view = await renderConnectedApp({ a: DAI.address });
        await chooseToken("out", DAI);
        await waitUntil(() => {
          expect(balanceRaw("in")).not.toBeNull();
          expect(balanceRaw("out")).not.toBeNull();
        });
        await waitUntil(() => expect(gate.heldCount).toBeGreaterThanOrEqual(1));
        await settlePendingWork();
        expect(view.result.current.eth.status).toBe("loading");
        expect(view.result.current.a.status).toBe("loading");

        // 금액이 빈 시점
        expect(usdState("in")).toBe("empty");
        expect(usdState("out")).toBe("empty");
        expect(skeletonsOutsideUsdValue("in")).toBeGreaterThan(0);
        expect(skeletonsOutsideUsdValue("out")).toBeGreaterThan(0);

        // 견적 success 시점
        await typeAmount("1");
        await waitUntil(() => expect(view.result.current.quote.status).toBe("success"));
        await waitUntil(() => expect(view.result.current.amountOutMinimum).not.toBeNull());
        await settlePendingWork();
        expect(view.result.current.a.status).toBe("loading");
        for (const testId of ["quote-amount-out", "quote-amount-out-minimum"] as const) {
          const row = quoteRow(testId);
          expect(within(row).queryAllByTestId("usd-skeleton").length, testId).toBeGreaterThan(0);
          expect(within(row).queryAllByTestId("quote-skeleton"), testId).toHaveLength(0);
        }
        for (const testId of ["quote-amount-out-usd", "quote-amount-out-minimum-usd"] as const) {
          for (const element of screen.queryAllByTestId(testId)) {
            expect(usdMicros(element), testId).toBeNull();
          }
        }
        gate.release();
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("서버 렌더링", () => {
    /**
     * @spec EC-24
     * @given 저장된 연결이 없다. 스텁은 단가 요청을 JSON-RPC 항목 단위로 기록한다
     * @when 앱을 서버 렌더링(`react-dom/server`)해 SSR 마크업을 얻고, 그 마크업 위에 클라이언트 앱을 hydrate해 첫 클라이언트 렌더를 확인한다
     * @then 서버 렌더링 동안 스텁에 단가 요청이 0건이다
     * @then SSR 마크업에 usd-value[data-side=in]과 usd-value[data-side=out]이 모두 있고 두 data-state가 `empty`다
     * @then SSR 마크업의 usd-value[data-side=in]과 usd-value[data-side=out]의 data-state가 첫 클라이언트 렌더의 각 usd-value data-state와 같다
     */
    it(
      "[EC-24] 서버 렌더링은 단가를 조회하지 않고 SSR과 첫 클라이언트 렌더의 USD 행 상태가 같다",
      async () => {
        const readStates = (root: ParentNode) => {
          const states: Partial<Record<Side, string | null>> = {};
          for (const element of root.querySelectorAll('[data-testid="usd-value"]')) {
            const side = element.getAttribute("data-side") as Side;
            states[side] = element.getAttribute("data-state");
          }
          return states;
        };

        // 서버 렌더링(`react-dom/server`). 서버와 브라우저는 config를 따로 만든다.
        const html = renderToString(
          <AppProviders config={appConfig()} initialChainId={mainnet.id}>
            <Home />
          </AppProviders>,
        );
        // fetch 기록은 비동기로 쌓이므로 잠깐 기다린 뒤 센다.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rpc.requests(matchUsdPrice.any)).toHaveLength(0);
        expect(
          rpc.fetchStub.calls().filter((call) => call.body.toLowerCase().includes("c6a5026a")),
        ).toHaveLength(0);

        const container = document.createElement("div");
        container.innerHTML = html;
        document.body.appendChild(container);
        const ssrStates = readStates(container);
        expect(ssrStates).toEqual({ in: "empty", out: "empty" });

        // 같은 마크업 위에 클라이언트 앱을 hydrate하고 첫 커밋(DOM 반영 직후)의 상태를 읽는다.
        let firstClientStates: Partial<Record<Side, string | null>> | undefined;
        const onRender = () => {
          if (firstClientStates === undefined) firstClientStates = readStates(container);
        };
        // RTL `render`가 hydrateRoot를 act로 감싼다.
        render(
          <Profiler id="usd-price-ssr" onRender={onRender}>
            <AppProviders config={appConfig()} initialChainId={mainnet.id}>
              <Home />
            </AppProviders>
          </Profiler>,
          { container, hydrate: true },
        );
        expect(firstClientStates).toBeDefined();
        expect(firstClientStates).toEqual(ssrStates);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
