import { type Address, formatUnits } from "viem";

import { expect, test } from "@playwright/test";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  quoteEachTierDirectly,
  readEachTierPoolSlot0Directly,
  readEthBalance,
  warmUpSwapQuote,
  warmUpTokenBalances,
  warmUpUsdPricePath,
} from "./support/anvil";
import { chainSelect, connectWithMock, openApp, requireBaseURL } from "./support/app";
import { watchJsonRpcTraffic } from "./support/network";
import {
  amountInput,
  cardBalance,
  openTokenModal,
  selectToken,
  tokenAddressPattern,
  tokenButton,
  tokenOption,
} from "./support/swap-form";
import {
  RUNNER_USDC_USD_PRICE,
  USD_MICROS_PATTERN,
  cardBalanceUsd,
  pickRunnerFeeTier,
  runnerDirectUsdPrice,
  runnerUsdMicros,
  tokenOptionUsd,
  usdValue,
  watchUsdPriceRequests,
} from "./support/usd-price";

// F9 usd-price E2E(T-15).
// 판정: 화면은 `usd-value`의 `data-side`·`data-state`·`data-usd-micros`와 `token-option-usd`의 유무로, 기대 micros는
// 러너가 anvil 포크에서 직접 읽은 QuoterV2 티어별 견적과 고른 티어 풀의 `slot0`로 테스트 쪽에서 계산한다(제품 함수를 쓰지 않는다).
// 네트워크는 가로채지 않고 감시만 한다. `page.route`는 쓰지 않는다. 문구는 판정에 쓰지 않는다.
// 경계(사용자 확정 2026-11-22): F3 E2E 경계(mock 커넥터, 감시만 하는 네트워크, 러너→anvil 직접 견적·예열)에
// 러너→anvil 단가 경로 예열과 풀 `slot0` 직접 읽기를 더한다. 제품 코드(`config/e2e-mock.ts` 포함)는 바꾸지 않는다.
// 이 경계가 증명하지 못하는 것: 실제 지갑(mock 커넥터 대체), L2 체인(Base·Arbitrum, T-16 수동), Vercel WAF(로컬 프록시만).
// 격리: 테스트별 브라우저 컨텍스트, 포크 상태를 바꾸지 않는 읽기 전용, `workers: 1`.
// 실행 환경: 앱 3100(`NEXT_PUBLIC_E2E_MOCK=1`, `.next-e2e`), anvil 8546(`--block-time 1`), 포크 블록·포트는 `config/e2e.ts`,
// 계정은 `config/e2e-mock.ts`의 mock 계정. 대상 체인은 Ethereum(anvil 포크)만. `check:build`와 동시에 실행하지 않는다.

// Ethereum 메인넷 토큰 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
// 출처: 토큰 컨트랙트(WETH9, 네이티브 USDC).
const ETH = NATIVE_ETH_ADDRESS;
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_DECIMALS = 18;

// 단가 기준량: 토큰 1개(10^decimals, F9 DoD-1). ETH 단가는 WETH 단가와 같다(F9 DoD-4).
const ONE_WETH_RAW = 10n ** 18n;
// DoD-23·DoD-24 보내는 금액(입력 정수 `amountInRaw`): 1 ETH. F3 E2E DoD-11과 같은 표본(mock 계정 ETH 10000 이하).
const ETH_IN_RAW = 1_000_000_000_000_000_000n;

// 앱의 단가·견적 요청이 끝나 화면에 반영될 때까지. 예열 뒤 요청은 수 초 안에 끝난다(F9 T-1 (9): 웜 ≤2.3초).
const USD_SETTLE_TIMEOUT_MS = 10_000;

// 모달 일괄 잔액 읽기 예열 대상(F3·F2 E2E와 같은 목록). 예열에만 쓰고 판정에는 쓰지 않는다.
const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== ETH.toLowerCase());

const PRICE_RPC_PATHNAME = `/api/rpc/${mainnet.id}`;

test.describe("달러 환산 — 사용자가 보내는·받는 금액과 보유 토큰의 USD 가치를 함께 본다", () => {
  // 같은 anvil을 쓰므로 이 파일 안에서는 순서대로 하나씩 실행한다.
  test.describe.configure({ mode: "default" });

  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기, 견적 경로, 단가 경로(WETH→USDC 티어별 견적과
  // 풀 slot0)를 올려 두어 앱 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다(F9 T-1 (9): cold ETH 단가 7.1초).
  // 이 hook의 시간 제한만 늘린다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await Promise.all([
      warmUpUsdPricePath(WETH, USDC, ONE_WETH_RAW),
      warmUpSwapQuote(WETH, USDC, ETH_IN_RAW),
    ]);
  });

  test.describe("ETH→USDC 금액 입력과 견적", () => {
    /**
     * @spec DoD-23 DoD-24 DoD-7
     * @given 러너가 anvil 포크에서 WETH 1개(10^18)를 USDC로 QuoterV2 네 티어(100·500·3000·10000)별로 직접 견적해 `selectFeeTier` 규칙(테스트 쪽에서 따로 적용)으로 티어를 고르고, 그 티어 풀의 `slot0`를 직접 읽어 ETH 단가 유리수를 계산했다. 러너가 보낼 금액(0보다 큰 정수)과 같은 입력(WETH→USDC)으로 QuoterV2를 티어별 직접 호출해 고른 수령량 정수를 구했다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있다. 페이지 이동 전부터 브라우저 컨텍스트의 JSON-RPC 요청을 `page.route` 없이 감시한다
     * @when 사용자가 보내는 칸을 ETH, 받는 칸을 USDC로 정하고 보내는 칸에 그 금액을 입력해 견적이 나온다
     * @then `usd-value[data-side=in]`의 `data-state`가 `success`이고 `data-usd-micros`가 보낼 금액 정수 × 러너가 계산한 ETH 단가를 버림한 값과 같다
     * @then `usd-value[data-side=out]`의 `data-state`가 `success`이고 `data-usd-micros`가 러너가 고른 수령량 정수 × USDC 단가 $1과 같다
     * @then 감시한 전체 구간에서 앱 출처의 `/api/rpc/*`와 mock 커넥터용 anvil 외의 JSON-RPC 요청이 없다
     * @then 단가 조회 aggregate3(첫 하위 호출이 QuoterV2인 aggregate3) 요청이 1건 이상이고 모두 `POST /api/rpc/1`로 나간다
     */
    test("[DoD-23][DoD-24][DoD-7] ETH→USDC 보내는·받는 USD가 포크 현물가 계산과 같고 프록시로만 조회한다", async ({
      context,
      page,
      baseURL,
    }) => {
      const appOrigin = new URL(requireBaseURL(baseURL)).origin;

      // 러너 기대값: ETH 단가 = WETH 1개를 USDC로 티어별 견적해 고른 티어 풀의 slot0 현물가.
      const ethUsdPrice = runnerDirectUsdPrice(
        WETH,
        USDC,
        await quoteEachTierDirectly(WETH, USDC, ONE_WETH_RAW),
        await readEachTierPoolSlot0Directly(WETH, USDC),
      );
      expect(ethUsdPrice, "러너가 anvil에서 계산한 ETH 단가").not.toBeNull();
      const expectedInMicros = runnerUsdMicros(ETH_IN_RAW, ethUsdPrice!);

      // 러너 기대값: 같은 입력(WETH→USDC)으로 티어별 견적해 고른 수령량 × USDC 단가 $1.
      const pickedQuote = pickRunnerFeeTier(
        WETH,
        USDC,
        await quoteEachTierDirectly(WETH, USDC, ETH_IN_RAW),
      );
      expect(pickedQuote, "러너가 anvil에서 고른 견적 티어").not.toBeNull();
      const expectedOutMicros = runnerUsdMicros(pickedQuote!.amountOut, RUNNER_USDC_USD_PRICE);

      // 페이지 이동 전에 감시를 시작한다(가로채지 않는다).
      const traffic = watchJsonRpcTraffic(context, page);
      const priceRequests = watchUsdPriceRequests(context, page);

      await openApp(page);
      await connectWithMock(page);
      await expect(chainSelect(page)).toHaveAttribute("data-selected-chain-id", String(mainnet.id));
      await selectToken(page, "out", USDC);
      await expect(tokenButton(page, "in")).toHaveAttribute(
        "data-token-address",
        tokenAddressPattern(ETH),
      );
      await expect(tokenButton(page, "out")).toHaveAttribute(
        "data-token-address",
        tokenAddressPattern(USDC),
      );

      const amount = formatUnits(ETH_IN_RAW, ETH_DECIMALS);
      await amountInput(page, "in").fill(amount);
      await expect(amountInput(page, "in")).toHaveValue(amount);

      await expect(usdValue(page, "in")).toHaveAttribute("data-state", "success", {
        timeout: USD_SETTLE_TIMEOUT_MS,
      });
      await expect(usdValue(page, "in")).toHaveAttribute(
        "data-usd-micros",
        String(expectedInMicros),
      );

      await expect(usdValue(page, "out")).toHaveAttribute("data-state", "success", {
        timeout: USD_SETTLE_TIMEOUT_MS,
      });
      await expect(usdValue(page, "out")).toHaveAttribute(
        "data-usd-micros",
        String(expectedOutMicros),
      );

      expect(traffic.calls.length, "감시한 JSON-RPC 요청 수").toBeGreaterThan(0);
      expect(traffic.disallowed(appOrigin), "허용 밖 JSON-RPC 요청").toEqual([]);
      expect(priceRequests.requests.length, "단가 aggregate3 요청 수").toBeGreaterThan(0);
      expect(
        priceRequests.notTo(appOrigin, PRICE_RPC_PATHNAME),
        "POST /api/rpc/1 밖으로 나간 단가 aggregate3 요청",
      ).toEqual([]);
    });
  });

  test.describe("토큰 모달 잔액", () => {
    /**
     * @spec DoD-25 DoD-7
     * @given T-1 (8)에서 확인한 포크 블록 기준 mock 계정이 잔액을 가진 토큰의 잔액이 0보다 큼을 러너가 anvil에서 직접 읽어 확인했다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있다. 페이지 이동 전부터 브라우저 컨텍스트의 JSON-RPC 요청을 `page.route` 없이 감시한다
     * @when 사용자가 보내는 칸의 토큰 모달을 열고 잔액 읽기와 단가 일괄 조회가 끝난다
     * @then 그 토큰의 모달 행 안에 `token-option-usd`가 있고 `data-usd-micros` 속성을 가진다
     * @then 감시한 전체 구간에서 앱 출처의 `/api/rpc/*`와 mock 커넥터용 anvil 외의 JSON-RPC 요청이 없다
     * @then 모달 단가 일괄 조회 aggregate3(첫 하위 호출이 QuoterV2인 aggregate3) 요청이 1건 이상이고 모두 `POST /api/rpc/1`로 나간다
     */
    test("[DoD-25][DoD-7] 잔액이 있는 토큰의 모달 행에 USD가 있고 프록시로만 조회한다", async ({
      context,
      page,
      baseURL,
    }) => {
      const appOrigin = new URL(requireBaseURL(baseURL)).origin;

      // 대상 토큰: F9 T-1 (8)에서 포크 블록 기준 mock 계정은 ERC-20 잔액이 모두 0이고 ETH만 있어 ETH 행이다.
      const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
      expect(ethBalance, "러너가 anvil에서 읽은 mock 계정 ETH 잔액").toBeGreaterThan(0n);

      // 페이지 이동 전에 감시를 시작한다(가로채지 않는다).
      const traffic = watchJsonRpcTraffic(context, page);
      const priceRequests = watchUsdPriceRequests(context, page);

      await openApp(page);
      await connectWithMock(page);
      await expect(chainSelect(page)).toHaveAttribute("data-selected-chain-id", String(mainnet.id));
      await expect(tokenButton(page, "in")).toHaveAttribute(
        "data-token-address",
        tokenAddressPattern(ETH),
      );
      // 모달을 열기 전에 카드의 ETH 단가 조회가 끝나 있게 해, 그 뒤에 나가는 단가 요청을 모달 일괄 조회로 본다.
      await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(ethBalance));
      await expect(cardBalanceUsd(page, "in")).toHaveAttribute(
        "data-usd-micros",
        USD_MICROS_PATTERN,
        { timeout: USD_SETTLE_TIMEOUT_MS },
      );
      const priceRequestsBeforeModal = priceRequests.requests.length;

      await openTokenModal(page, "in");
      // 잔액 읽기가 끝나 ETH 행에 러너가 읽은 잔액이 반영된다.
      await expect(tokenOption(page, "in", ETH)).toHaveAttribute(
        "data-balance-raw",
        String(ethBalance),
        { timeout: USD_SETTLE_TIMEOUT_MS },
      );
      // 잔액 읽기 뒤 모달 단가 일괄 조회가 나가고 응답이 끝난다.
      await expect
        .poll(() => priceRequests.requests.length, {
          message: "모달을 연 뒤 나간 단가 aggregate3 요청 수",
          timeout: USD_SETTLE_TIMEOUT_MS,
        })
        .toBeGreaterThan(priceRequestsBeforeModal);
      const modalBatchRequests = priceRequests.requests.slice(priceRequestsBeforeModal);
      const modalBatchStatuses = await Promise.all(
        modalBatchRequests.map(
          async (observed) => (await observed.request?.response())?.status() ?? null,
        ),
      );
      expect(modalBatchStatuses, "모달 단가 일괄 조회 응답 상태(전제)").toEqual(
        modalBatchRequests.map(() => 200),
      );

      await expect(tokenOptionUsd(page, "in", ETH)).toHaveAttribute(
        "data-usd-micros",
        USD_MICROS_PATTERN,
        { timeout: USD_SETTLE_TIMEOUT_MS },
      );

      expect(traffic.calls.length, "감시한 JSON-RPC 요청 수").toBeGreaterThan(0);
      expect(traffic.disallowed(appOrigin), "허용 밖 JSON-RPC 요청").toEqual([]);
      expect(
        priceRequests.notTo(appOrigin, PRICE_RPC_PATHNAME),
        "POST /api/rpc/1 밖으로 나간 단가 aggregate3 요청",
      ).toEqual([]);
    });
  });
});
