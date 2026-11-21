import { type Page, expect, test } from "@playwright/test";
import { type Address, formatUnits } from "viem";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  readEthBalance,
  warmUpSwapQuote,
  warmUpTokenBalances,
} from "./support/anvil";
import { chainSelect, connectWithMock, openApp, primaryButton } from "./support/app";
import { quoteAmountOutRow, quoteDetails } from "./support/quote";
import {
  quoteAmountOutMinimumRow,
  readQuoteRawPair,
  slippageButton,
  slippageOption,
  slippagePopover,
} from "./support/slippage";
import {
  amountInput,
  cardBalance,
  selectToken,
  tokenAddressPattern,
  tokenButton,
} from "./support/swap-form";

// Ethereum 메인넷 토큰 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
const ETH = NATIVE_ETH_ADDRESS;
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DECIMALS_18 = 18;

// 보내는 금액: 1 ETH(F3 E2E와 같은 크기).
const DOD26_ETH_IN = 1_000_000_000_000_000_000n;

// 스펙 DoD-26의 1.0% 프리셋 값과 테스트 쪽 기대식 상수(`× 9900 / 10000`, bigint 내림).
const PRESET_1_0_PERCENT_BPS = 100;
const BPS_DENOMINATOR = 10_000n;
const AMOUNT_OUT_MINIMUM_NUMERATOR_1_0_PERCENT = 9_900n;

// 예열 뒤 견적 요청은 수 ms 안에 끝난다(F3 T-1). 입력 반영 대기와 브라우저·프록시 왕복을 넉넉하게 덮는다.
const QUOTE_SETTLE_TIMEOUT_MS = 10_000;

const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== ETH.toLowerCase());

async function openConnectedApp(page: Page): Promise<void> {
  await openApp(page);
  await connectWithMock(page);
  await expect(chainSelect(page)).toHaveAttribute("data-selected-chain-id", String(mainnet.id));
}

async function enterAmountIn(page: Page, amountRaw: bigint, decimals: number): Promise<void> {
  const amount = formatUnits(amountRaw, decimals);
  await amountInput(page, "in").fill(amount);
  await expect(amountInput(page, "in")).toHaveValue(amount);
}

// 화면에서 같은 시점에 읽은 예상 수령량 정수로 1.0% 최소 수령량 기대값을 만든다(제품 함수 미사용).
function expectedAmountOutMinimumAt1Percent(amountOutRaw: string): string {
  return (
    (BigInt(amountOutRaw) * AMOUNT_OUT_MINIMUM_NUMERATOR_1_0_PERCENT) /
    BPS_DENOMINATOR
  ).toString();
}

test.describe("슬리피지 — 사용자가 고른 허용치가 실제 견적의 최소 수령량에 반영된다", () => {
  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기와 견적 경로(풀 상태)를 올려 두어
  // 앱의 견적 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다. 이 hook의 시간 제한만 늘린다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await warmUpSwapQuote(WETH, USDC, DOD26_ETH_IN);
  });

  test.describe("실제 포크 견적에서 프리셋 선택", () => {
    /**
     * @spec DoD-26
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 사용자가 보내는 칸을 ETH, 받는 칸을 USDC로 정하고 0보다 크고 mock 계정의 ETH 잔액 이하인 금액을 입력해 실제 견적이 성공했다
     * @when 사용자가 `slippage-button`을 눌러 `slippage-popover`를 열고 `data-slippage-bps`가 `100`인 `slippage-option`(표시 `1.0%`)을 누른다
     * @then `quote-amount-out-minimum`(최소 수령량 행)의 `data-amount-out-minimum-raw`가 화면 `quote-amount-out`(예상 수령량 행)의 `data-amount-out-raw` × 9900 / 10000(테스트 안 bigint 내림 나눗셈)과 같다
     */
    test("[DoD-26] 실제 견적 후 1.0%를 고르면 최소 수령량이 예상 수령량 × 9900 / 10000(내림)이다", async ({
      page,
    }) => {
      // given: 러너가 anvil에서 읽은 ETH 잔액으로 보낼 금액이 0보다 크고 잔액 이하인지 확인한다
      const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
      expect(DOD26_ETH_IN > 0n && DOD26_ETH_IN <= ethBalance, "보낼 금액이 ETH 잔액 이하").toBe(
        true,
      );

      // given: 앱을 열고 mock 커넥터로 연결한다. 선택 체인은 Ethereum이다
      await openConnectedApp(page);

      // given: 보내는 칸 ETH(기본), 받는 칸 USDC를 고르고 금액을 입력한다
      await selectToken(page, "out", USDC);
      await expect(tokenButton(page, "in")).toHaveAttribute(
        "data-token-address",
        tokenAddressPattern(ETH),
      );
      await expect(tokenButton(page, "out")).toHaveAttribute(
        "data-token-address",
        tokenAddressPattern(USDC),
      );
      await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(ethBalance));
      await enterAmountIn(page, DOD26_ETH_IN, DECIMALS_18);

      // given: 실제 견적이 성공해 견적 정보와 예상 수령량 정수가 표시된다
      await expect(primaryButton(page)).toHaveAttribute("data-state", "swap-ready", {
        timeout: QUOTE_SETTLE_TIMEOUT_MS,
      });
      await expect(quoteDetails(page)).toBeVisible();
      await expect(quoteAmountOutRow(page)).toHaveAttribute("data-amount-out-raw", /^[0-9]+$/);

      // when: slippage-button으로 팝오버를 열고 data-slippage-bps가 100인 slippage-option을 누른다
      await slippageButton(page).click();
      await expect(slippageButton(page)).toHaveAttribute("aria-expanded", "true");
      await expect(slippagePopover(page)).toBeVisible();
      await slippageOption(page, PRESET_1_0_PERCENT_BPS).click();
      await expect(slippageOption(page, PRESET_1_0_PERCENT_BPS)).toHaveAttribute(
        "aria-checked",
        "true",
      );

      // then: 예상 수령량 정수와 최소 수령량 정수를 한 번에(같은 시점에) 읽고,
      // 읽은 예상 수령량으로 기대값을 만들어 비교한다. 15초 자동 갱신 중의 loading(최소 수령량 속성 없음)은 다시 읽는다.
      await expect(quoteAmountOutMinimumRow(page)).toBeVisible();
      await expect
        .poll(
          async () => {
            const { amountOutRaw, amountOutMinimumRaw } = await readQuoteRawPair(page);
            if (amountOutRaw === null) return { amountOutRaw, amountOutMinimumRaw, matches: false };
            const expected = expectedAmountOutMinimumAt1Percent(amountOutRaw);
            return {
              amountOutRaw,
              amountOutMinimumRaw,
              expected,
              matches: amountOutMinimumRaw === expected,
            };
          },
          { timeout: QUOTE_SETTLE_TIMEOUT_MS },
        )
        .toMatchObject({ matches: true });
    });
  });
});
