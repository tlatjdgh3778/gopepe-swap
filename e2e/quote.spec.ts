import { type Page, type Request, expect, test } from "@playwright/test";
import { type Address, type Hex, decodeFunctionData, formatUnits, parseAbi } from "viem";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  DIRECT_QUOTE_FEE_TIERS,
  type DirectQuoteFeeTier,
  type DirectTierQuotes,
  QUOTER_V2_ADDRESS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  quoteEachTierDirectly,
  readErc20Balance,
  readEthBalance,
  setErc20Balance,
  warmUpSwapQuote,
  warmUpTokenBalances,
} from "./support/anvil";
import {
  chainSelect,
  connectWithMock,
  openApp,
  primaryButton,
  requireBaseURL,
} from "./support/app";
import {
  PRICE_IMPACT_SEVERITY,
  quoteAmountOutRow,
  quoteDetails,
  quoteFeeTierRow,
  quotePriceImpactRow,
} from "./support/quote";
import {
  type SwapSide,
  amountInput,
  cardBalance,
  openTokenModal,
  selectToken,
  tokenAddressPattern,
  tokenButton,
  tokenModal,
  tokenOption,
} from "./support/swap-form";

// Ethereum 메인넷 토큰 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
const ETH = NATIVE_ETH_ADDRESS;
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// EC-4 표본: T-1 (1)에서 포크 블록 기준 네 티어 모두 풀이 없고 견적이 revert한 페어(DAI→PENDLE).
// DAI는 고정 토큰이라 주입해도 F2 DoD-9의 잔액 보유 비고정 토큰 기대(LINK)를 바꾸지 않는다(T-1 (2)).
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const PENDLE: Address = "0x808507121B80c02388fAd14726482e061B8da827";
const PENDLE_SEARCH_QUERY = "PENDLE";
const DECIMALS_18 = 18;

// QuoterV2가 `sqrtPriceLimitX96 = 0`일 때 쓰는 방향별 한계값.
// 출처: Uniswap v3-core `TickMath.MIN_SQRT_RATIO`·`MAX_SQRT_RATIO`, v3-periphery `QuoterV2`.
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

// 보내는 금액. 모두 18자리 토큰의 1 단위다(T-1 확인 표본과 같은 크기).
const DOD11_ETH_IN = 1_000_000_000_000_000_000n; // 1 ETH
const EC4_DAI_IN = 1_000_000_000_000_000_000n; // 1 DAI
const EC6_ETH_IN = 1_000_000_000_000_000_000n; // 1 ETH
// EC-4 주입 잔액(절대값). 보내는 금액보다 커서 잔액 부족이 앞서지 않는다.
const EC4_DAI_BALANCE_RAW = 1_000_000_000_000_000_000_000n; // 1000 DAI

// 예열 뒤 견적 요청은 수 ms 안에 끝난다(T-1). 입력 반영 대기와 브라우저·프록시 왕복을 넉넉하게 덮는다.
const QUOTE_SETTLE_TIMEOUT_MS = 10_000;
// EC-6: `no-route`를 본 뒤 QuoterV2 요청이 나오는지 지켜보는 시간. 입력 반영 대기(300ms)의 10배다.
const EC6_OBSERVE_AFTER_NO_ROUTE_MS = 3_000;

const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== ETH.toLowerCase());

// 출처: Multicall3 `aggregate3`.
const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

type ExpectedQuote = { fee: DirectQuoteFeeTier; amountOut: bigint };

// 스펙 §5.1·DoD-2·DoD-3 규칙을 테스트 쪽에서 따로 적용한다.
// revert(EC-1), 수령량 0(EC-2), 유동성 소진(EC-3, 견적 후 가격이 방향별 한계값) 티어를 빼고
// 수령량이 가장 많은 티어, 같으면 수수료가 가장 낮은 티어를 고른다. 후보가 없으면 null이다.
function pickExpectedQuote(
  tokenIn: Address,
  tokenOut: Address,
  quotes: DirectTierQuotes,
): ExpectedQuote | null {
  const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;

  const candidates = DIRECT_QUOTE_FEE_TIERS.flatMap((fee) => {
    const quote = quotes[fee];
    if (quote.status !== "ok") return [];
    if (quote.amountOut === 0n) return [];
    if (quote.sqrtPriceX96After === limit) return [];
    return [{ fee, amountOut: quote.amountOut }];
  });

  candidates.sort((a, b) => {
    if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut ? -1 : 1;
    return a.fee - b.fee;
  });
  return candidates[0] ?? null;
}

function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// JSON-RPC 항목 하나가 담은 QuoterV2 호출 수. 호출 대상이 QuoterV2이면 1,
// aggregate3이면 하위 호출 중 대상이 QuoterV2인 수, 그 밖의 호출 데이터에 QuoterV2 주소가 있으면 1로 센다.
function countQuoterV2CallsInItem(item: unknown): number {
  if (typeof item !== "object" || item === null) return 0;
  const params = (item as { params?: unknown }).params;
  if (!Array.isArray(params)) return 0;
  const call = params[0];
  if (typeof call !== "object" || call === null) return 0;
  const { to, data, input } = call as { to?: unknown; data?: unknown; input?: unknown };
  if (typeof to === "string" && sameAddress(to, QUOTER_V2_ADDRESS)) return 1;

  const callData = typeof data === "string" ? data : typeof input === "string" ? input : null;
  if (callData === null) return 0;
  try {
    const { args } = decodeFunctionData({ abi: multicall3Abi, data: callData as Hex });
    return args[0].filter((subcall) => sameAddress(subcall.target, QUOTER_V2_ADDRESS)).length;
  } catch {
    return callData.toLowerCase().includes(QUOTER_V2_ADDRESS.slice(2).toLowerCase()) ? 1 : 0;
  }
}

function countQuoterV2Calls(request: Request): number {
  const body = parseJson(request.postData());
  const items = Array.isArray(body) ? body : [body];
  return items.reduce<number>((total, item) => total + countQuoterV2CallsInItem(item), 0);
}

// 브라우저 컨텍스트가 앱 출처의 RPC 프록시(`/api/rpc/*`)로 보낸 요청을 가로채지 않고 센다.
// 페이지 이동 전에 시작해야 전체 구간을 본다.
function watchProxyQuoterV2Calls(page: Page, appOrigin: string) {
  const observed = { proxyRequests: 0, quoterV2Calls: 0 };
  page.context().on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin !== appOrigin || !target.pathname.startsWith("/api/rpc/")) return;
    observed.proxyRequests += 1;
    observed.quoterV2Calls += countQuoterV2Calls(request);
  });
  return observed;
}

async function openConnectedApp(page: Page): Promise<void> {
  await openApp(page);
  await connectWithMock(page);
  await expect(chainSelect(page)).toHaveAttribute("data-selected-chain-id", String(mainnet.id));
}

async function expectTokens(page: Page, tokenIn: Address | "", tokenOut: Address | "") {
  await expect(tokenButton(page, "in")).toHaveAttribute(
    "data-token-address",
    tokenAddressPattern(tokenIn),
  );
  await expect(tokenButton(page, "out")).toHaveAttribute(
    "data-token-address",
    tokenAddressPattern(tokenOut),
  );
}

// 칸의 토큰 모달에서 검색어를 입력해 토큰을 고르고, 모달이 닫혀 그 칸에 반영될 때까지 기다린다.
async function selectTokenBySearch(
  page: Page,
  side: SwapSide,
  address: Address,
  query: string,
): Promise<void> {
  await openTokenModal(page, side);
  await tokenModal(page, side).getByTestId("token-search").fill(query);
  await tokenOption(page, side, address).click();
  await expect(tokenModal(page, side)).toBeHidden();
  await expect(tokenButton(page, side)).toHaveAttribute(
    "data-token-address",
    tokenAddressPattern(address),
  );
}

async function enterAmountIn(page: Page, amountRaw: bigint, decimals: number): Promise<void> {
  const amount = formatUnits(amountRaw, decimals);
  await amountInput(page, "in").fill(amount);
  await expect(amountInput(page, "in")).toHaveValue(amount);
}

test.describe("견적 — 사용자가 보낼 금액의 예상 수령량·가격 영향·수수료 티어를 보고 스왑 가능 여부를 안다", () => {
  // 주입 상태를 공유하는 같은 anvil을 쓰므로 이 파일 안에서는 순서대로 하나씩 실행한다.
  test.describe.configure({ mode: "default" });

  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기와 견적 경로(풀 상태)를 올려 두어
  // 앱의 견적 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다. 이 hook의 시간 제한만 늘린다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await Promise.all([
      warmUpSwapQuote(WETH, USDC, DOD11_ETH_IN),
      warmUpSwapQuote(DAI, PENDLE, EC4_DAI_IN),
    ]);
  });

  test.describe("견적 성공", () => {
    /**
     * @spec DoD-11 DoD-12 DoD-35 DoD-36
     * @given 러너가 anvil에서 mock 계정의 ETH 잔액 정수를 직접 읽었다. 러너가 보낼 금액(0보다 크고 그 ETH 잔액 이하)과 같은 입력(WETH→USDC)으로 anvil의 QuoterV2를 수수료 티어 100·500·3000·10000별로 직접 호출해, 후보 중 수령량이 가장 많은 티어(같으면 수수료가 가장 낮은 티어)와 그 수령량 정수를 골랐다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있다
     * @when 사용자가 보내는 칸을 ETH, 받는 칸을 USDC로 정하고 보내는 칸에 그 금액을 입력한다
     * @then 받는 칸 금액 칸의 `data-amount-out-raw`가 러너가 고른 수령량 정수와 같다
     * @then `quote-details`가 표시되고 예상 수령량 행의 `data-amount-out-raw`가 러너가 고른 수령량 정수와 같다
     * @then `quote-details`에 가격 영향 행이 표시되고 `data-severity`가 `normal`·`warning`·`error` 중 하나다
     * @then `quote-details`에 수수료 티어 행이 표시되고 `data-fee`가 러너가 고른 티어와 같다
     * @then 주 버튼 상태가 `quote-ready`다
     * @then 주 버튼이 비활성이다
     */
    test("[DoD-11][DoD-12][DoD-35][DoD-36] ETH→USDC 견적이 성공하면 러너가 anvil에서 고른 수령량·티어를 표시하고 주 버튼이 quote-ready이고 비활성이다", async ({
      page,
    }) => {
      const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
      expect(DOD11_ETH_IN > 0n && DOD11_ETH_IN <= ethBalance, "보낼 금액이 ETH 잔액 이하").toBe(
        true,
      );
      const expected = pickExpectedQuote(
        WETH,
        USDC,
        await quoteEachTierDirectly(WETH, USDC, DOD11_ETH_IN),
      );
      expect(expected, "러너가 anvil에서 고른 티어").not.toBeNull();
      const { fee, amountOut } = expected!;

      await openConnectedApp(page);
      await selectToken(page, "out", USDC);
      await expectTokens(page, ETH, USDC);
      await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(ethBalance));

      await enterAmountIn(page, DOD11_ETH_IN, DECIMALS_18);

      await expect(amountInput(page, "out")).toHaveAttribute(
        "data-amount-out-raw",
        String(amountOut),
        { timeout: QUOTE_SETTLE_TIMEOUT_MS },
      );
      await expect(quoteDetails(page)).toBeVisible();
      await expect(quoteAmountOutRow(page)).toHaveAttribute(
        "data-amount-out-raw",
        String(amountOut),
      );
      await expect(quotePriceImpactRow(page)).toBeVisible();
      await expect(quotePriceImpactRow(page)).toHaveAttribute(
        "data-severity",
        PRICE_IMPACT_SEVERITY,
      );
      await expect(quoteFeeTierRow(page)).toBeVisible();
      await expect(quoteFeeTierRow(page)).toHaveAttribute("data-fee", String(fee));
      await expect(primaryButton(page)).toHaveAttribute("data-state", "quote-ready");
      await expect(primaryButton(page)).toBeDisabled();
    });
  });

  test.describe("견적할 직접 풀이 없는 페어", () => {
    /**
     * @spec EC-4 DoD-33 DoD-36
     * @given T-1에서 확인한 페어(포크 블록에서 네 티어 모두 풀이 없는 페어)의 보내는 토큰 잔액을 러너가 anvil에서 mock 계정에 절대값으로 주입하고 그 정수를 anvil에서 직접 읽었다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있다
     * @when 사용자가 보내는 칸을 그 페어의 보내는 토큰, 받는 칸을 그 페어의 받는 토큰으로 정하고 0보다 크고 러너가 읽은 잔액 이하인 금액을 입력한다
     * @then 주 버튼 상태가 `no-route`다
     * @then 주 버튼이 비활성이다
     */
    test("[EC-4][DoD-33][DoD-36] 네 티어 모두 풀이 없는 페어는 잔액이 충분해도 주 버튼이 no-route이고 비활성이다", async ({
      page,
    }) => {
      // 전제: 지금 anvil에서도 네 티어 모두 후보가 없다(T-1 (1) 결과가 유지된다).
      expect(
        pickExpectedQuote(DAI, PENDLE, await quoteEachTierDirectly(DAI, PENDLE, EC4_DAI_IN)),
        "러너가 anvil에서 직접 견적한 DAI→PENDLE 후보",
      ).toBeNull();
      await setErc20Balance(E2E_MOCK_ACCOUNT, DAI, EC4_DAI_BALANCE_RAW);
      const daiBalance = await readErc20Balance(E2E_MOCK_ACCOUNT, DAI);
      expect(daiBalance).toBe(EC4_DAI_BALANCE_RAW);
      expect(EC4_DAI_IN > 0n && EC4_DAI_IN <= daiBalance, "보낼 금액이 DAI 잔액 이하").toBe(true);

      await openConnectedApp(page);
      await selectToken(page, "in", DAI);
      await selectTokenBySearch(page, "out", PENDLE, PENDLE_SEARCH_QUERY);
      await expectTokens(page, DAI, PENDLE);
      await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(daiBalance));

      await enterAmountIn(page, EC4_DAI_IN, DECIMALS_18);

      await expect(primaryButton(page)).toHaveAttribute("data-state", "no-route", {
        timeout: QUOTE_SETTLE_TIMEOUT_MS,
      });
      await expect(primaryButton(page)).toBeDisabled();
    });
  });

  test.describe("ETH ↔ WETH", () => {
    /**
     * @spec EC-6 DoD-33 DoD-36
     * @given 러너가 anvil에서 mock 계정의 ETH 잔액 정수를 직접 읽었다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있으며 보내는 칸 토큰이 ETH다. 브라우저가 보내는 RPC 프록시 요청을 감시한다
     * @when 사용자가 받는 칸을 WETH로 정하고 0보다 크고 러너가 읽은 ETH 잔액 이하인 금액을 보내는 칸에 입력한다
     * @then 주 버튼 상태가 `no-route`다
     * @then 주 버튼이 비활성이다
     * @then 주 버튼이 `no-route`가 된 뒤 입력 반영 대기(300ms)보다 충분히 긴 시간이 지나도 브라우저가 보낸 RPC 프록시 요청 중 QuoterV2 호출이 0건이다
     */
    test("[EC-6][DoD-33][DoD-36] ETH→WETH는 QuoterV2를 호출하지 않고 주 버튼이 no-route이고 비활성이다", async ({
      page,
      baseURL,
    }) => {
      const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
      expect(EC6_ETH_IN > 0n && EC6_ETH_IN <= ethBalance, "보낼 금액이 ETH 잔액 이하").toBe(true);
      const observed = watchProxyQuoterV2Calls(page, new URL(requireBaseURL(baseURL)).origin);

      await openConnectedApp(page);
      await selectToken(page, "out", WETH);
      await expectTokens(page, ETH, WETH);
      await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(ethBalance));
      // 감시 동작 확인(전제): 카드 잔액 읽기가 거친 프록시 요청이 기록되어 있다.
      expect(observed.proxyRequests, "감시한 프록시 요청 수").toBeGreaterThan(0);

      await enterAmountIn(page, EC6_ETH_IN, DECIMALS_18);

      await expect(primaryButton(page)).toHaveAttribute("data-state", "no-route");
      await expect(primaryButton(page)).toBeDisabled();

      // 일어나지 않아야 하는 요청을 판정하므로, 자동 대기 대신 정해진 시간을 지켜본 뒤 센다.
      await page.waitForTimeout(EC6_OBSERVE_AFTER_NO_ROUTE_MS);
      await expect(primaryButton(page)).toHaveAttribute("data-state", "no-route");
      expect(observed.quoterV2Calls, "프록시 요청 중 QuoterV2 호출 수").toBe(0);
    });
  });
});
