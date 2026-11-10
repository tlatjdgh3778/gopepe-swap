import { type Page, expect, test } from "@playwright/test";
import { type Address, formatUnits, getAddress, parseUnits } from "viem";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  readErc20Balance,
  readEthBalance,
  setErc20Balance,
  warmUpTokenBalances,
} from "./support/anvil";
import {
  chainSelect,
  connectWithMock,
  newIsolatedPage,
  openApp,
  primaryButton,
} from "./support/app";
import { fetchServerRenderedHtml, openServerRenderedDocument } from "./support/ssr";
import {
  type SwapSide,
  amountInput,
  cardBalance,
  flipButton,
  maxButton,
  openTokenModal,
  readTokenOptionRows,
  selectToken,
  tokenAddressPattern,
  tokenButton,
  tokenField,
  tokenOption,
} from "./support/swap-form";

// Ethereum 메인넷 토큰 주소. 고정 토큰은 스펙 DoD-9의 순서(ETH, WETH, USDC, USDT, DAI)다.
const ETH = NATIVE_ETH_ADDRESS;
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const PINNED_IN_ORDER: readonly Address[] = [ETH, WETH, USDC, USDT, DAI];
const USDC_DECIMALS = 6;
const ETH_DECIMALS = 18;

// DoD-9 주입 토큰(고정 토큰이 아니고 F1 테스트가 쓰지 않는 토큰): Chainlink LINK.
const LINK: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";

// T-1 확인: 포크 블록에서 mock 계정의 스냅샷 ERC-20 잔액은 484개 모두 0이다.
const EXISTING_NONZERO_TOKENS_AT_FORK_BLOCK: readonly Address[] = [];

// 스펙 §1.1·§4.4: Ethereum ETH `최대`의 가스 예약량 0.005 ETH.
const ETHEREUM_GAS_RESERVE_WEI = 5_000_000_000_000_000n;

// 테스트별 절대 주입값. 앞 테스트의 주입값과 겹치지 않게 서로 다르게 둔다.
const DOD13_USDC_RAW = 4_321_123_456n; // 4321.123456 USDC
const DOD30_USDC_RAW = 1_234_567_891n; // 1234.567891 USDC (소수부 6자리)
const DOD37_USDC_RAW = 777_777_777n; // 777.777777 USDC
const DOD38_USDC_RAW = 98_765_432_109n; // 98765.432109 USDC
const DOD9_LINK_RAW = 42_500_000_000_000_000_000n; // 42.5 LINK

const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== ETH.toLowerCase());

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// 러너가 USDC 잔액을 절대값으로 넣고 anvil에서 직접 다시 읽은 정수를 돌려준다.
async function injectUsdc(amount: bigint): Promise<bigint> {
  await setErc20Balance(E2E_MOCK_ACCOUNT, USDC, amount);
  const balance = await readErc20Balance(E2E_MOCK_ACCOUNT, USDC);
  expect(balance).toBe(amount);
  return balance;
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

async function readAmountRaw(page: Page, side: SwapSide, decimals: number): Promise<bigint> {
  return parseUnits(await amountInput(page, side).inputValue(), decimals);
}

// 보내는 칸 USDC, 받는 칸 ETH로 정하고 카드 잔액 읽기가 끝날 때까지 기다린다.
async function selectUsdcToEth(page: Page, usdcBalance: bigint): Promise<void> {
  await selectToken(page, "in", USDC);
  await selectToken(page, "out", ETH);
  await expectTokens(page, USDC, ETH);
  await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(usdcBalance));
}

test.describe("스왑 입력 — 사용자가 보낼 토큰·금액과 받을 토큰을 정한다", () => {
  // 주입 상태를 공유하는 같은 anvil을 쓰므로 이 파일 안에서는 순서대로 하나씩 실행한다.
  test.describe.configure({ mode: "default" });

  // 앱의 모달 일괄 읽기가 프록시 상류 시간 제한 안에 끝나도록 러너가 포크를 미리 데운다(판정에 쓰지 않음).
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
  });

  test.describe("서버 렌더링 초기값", () => {
    /**
     * @spec DoD-2
     * @given 선택 체인 쿠키가 없는(선택 체인이 Ethereum인) 요청이다
     * @when 그 요청으로 앱 문서를 서버에 요청해 서버 렌더링 결과를 받는다
     * @then 서버 렌더링 결과의 보내는 칸 토큰이 Ethereum의 ETH다
     * @then 서버 렌더링 결과의 받는 칸 토큰이 미선택이다
     * @then 서버 렌더링 결과의 보내는 칸 금액이 빈 값이다
     */
    test("[DoD-2] 서버 렌더링 결과의 토큰·금액 초기값이 페이지 초기값과 같다", async ({
      browser,
      request,
    }) => {
      const html = await fetchServerRenderedHtml(request, undefined);
      const ssr = await openServerRenderedDocument(browser, html);
      try {
        const page = ssr.page;
        await expect(chainSelect(page)).toHaveAttribute(
          "data-selected-chain-id",
          String(mainnet.id),
        );
        await expect(tokenField(page, "in")).toHaveCount(1);
        await expect(tokenField(page, "out")).toHaveCount(1);

        await expect(tokenButton(page, "in")).toHaveAttribute(
          "data-token-address",
          tokenAddressPattern(ETH),
        );
        await expect(tokenButton(page, "out")).toHaveAttribute("data-token-address", "");
        await expect(amountInput(page, "in")).toHaveValue("");
      } finally {
        await ssr.context.close();
      }
    });
  });

  test.describe("토큰 뒤집기", () => {
    /**
     * @spec DoD-7
     * @given 앱 페이지가 열려 있고 두 칸의 토큰이 표본 상태다 (표본: 보내는 칸 ETH·받는 칸 미선택, 보내는 칸 ETH·받는 칸 USDC)
     * @when 사용자가 뒤집기 버튼을 누른다
     * @then 보내는 칸의 토큰이 뒤집기 전 받는 칸의 토큰(미선택 포함)이 된다
     * @then 받는 칸의 토큰이 뒤집기 전 보내는 칸의 토큰이 된다
     */
    test("[DoD-7] 뒤집기 버튼을 누르면 두 칸의 토큰이 미선택을 포함해 맞바뀐다", async ({
      browser,
      baseURL,
    }) => {
      const samples: { name: string; tokenOut: Address | "" }[] = [
        { name: "보내는 칸 ETH·받는 칸 미선택", tokenOut: "" },
        { name: "보내는 칸 ETH·받는 칸 USDC", tokenOut: USDC },
      ];
      for (const sample of samples) {
        await test.step(`표본: ${sample.name}`, async () => {
          const { context, page } = await newIsolatedPage(browser, baseURL);
          try {
            await openApp(page);
            if (sample.tokenOut !== "") await selectToken(page, "out", sample.tokenOut);
            await expectTokens(page, ETH, sample.tokenOut);

            await flipButton(page).click();

            await expectTokens(page, sample.tokenOut, ETH);
          } finally {
            await context.close();
          }
        });
      }
    });
  });

  test.describe("연결 상태의 잔액", () => {
    /**
     * @spec DoD-13
     * @given 러너가 anvil에서 mock 계정에 USDC 잔액을 절대값으로 주입하고, mock 계정의 ETH 잔액과 USDC 잔액 정수를 anvil에서 직접 읽었다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있다
     * @when 사용자가 보내는 칸을 ETH, 받는 칸을 USDC로 정한다
     * @then 보내는 칸 잔액의 정수 값이 러너가 anvil에서 읽은 ETH 잔액 정수와 같다
     * @then 받는 칸 잔액의 정수 값이 러너가 anvil에서 읽은 USDC 잔액 정수와 같다
     */
    test("[DoD-13] 연결 상태에서 두 칸에 선택 토큰의 선택 체인 잔액을 표시한다", async ({
      page,
    }) => {
      const usdcBalance = await injectUsdc(DOD13_USDC_RAW);
      const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
      await openConnectedApp(page);

      // 보내는 칸은 초기값 ETH 그대로 두고 받는 칸만 USDC로 고른다.
      await selectToken(page, "out", USDC);
      await expectTokens(page, ETH, USDC);

      await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(ethBalance));
      await expect(cardBalance(page, "out")).toHaveAttribute(
        "data-balance-raw",
        String(usdcBalance),
      );
    });
  });

  test.describe("토큰 모달 목록 정렬", () => {
    /**
     * @spec DoD-9
     * @given 러너가 anvil에서 mock 계정에 고정 토큰이 아닌 토큰 하나의 잔액을 절대값으로 주입했다. 잔액이 0보다 큰 토큰의 기대 집합은 주입 토큰과 T-1에서 확인한 mock 계정의 포크 블록 기준 기존 잔액 보유 토큰이다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있다
     * @when 사용자가 토큰 모달을 열고 잔액 읽기가 끝난다
     * @then 목록의 처음 5행이 ETH, WETH, USDC, USDT, DAI 순서다
     * @then 고정 토큰 다음에 잔액이 0보다 큰 비고정 토큰 기대 집합이 놓인다
     * @then 그 뒤에 나머지 토큰이 놓인다
     */
    test("[DoD-9] 연결 상태의 모달 목록이 고정 토큰, 잔액 보유 토큰, 나머지 순으로 놓인다", async ({
      page,
    }) => {
      await setErc20Balance(E2E_MOCK_ACCOUNT, LINK, DOD9_LINK_RAW);
      const linkBalance = await readErc20Balance(E2E_MOCK_ACCOUNT, LINK);
      expect(linkBalance).toBe(DOD9_LINK_RAW);
      const expectedNonzero = [LINK, ...EXISTING_NONZERO_TOKENS_AT_FORK_BLOCK].map((address) =>
        getAddress(address),
      );
      await openConnectedApp(page);

      await openTokenModal(page, "in");
      // 잔액 읽기가 끝나면 주입 토큰 행에 러너가 읽은 잔액이 실린다(EC-15: 도착 후 다시 정렬).
      await expect(tokenOption(page, "in", LINK)).toHaveAttribute(
        "data-balance-raw",
        String(linkBalance),
      );

      const rows = await readTokenOptionRows(page, "in");
      expect(rows).toHaveLength(TOKENS_BY_CHAIN[mainnet.id].length);

      const pinnedRows = rows.slice(0, PINNED_IN_ORDER.length);
      expect(pinnedRows.map((row) => getAddress(row.address))).toEqual(
        PINNED_IN_ORDER.map((address) => getAddress(address)),
      );

      const nonzeroEnd = PINNED_IN_ORDER.length + expectedNonzero.length;
      const nonzeroRows = rows.slice(PINNED_IN_ORDER.length, nonzeroEnd);
      expect(nonzeroRows.map((row) => getAddress(row.address)).toSorted()).toEqual(
        expectedNonzero.toSorted(),
      );
      for (const row of nonzeroRows) {
        expect(row.balanceRaw, `${row.address} 잔액`).not.toBeNull();
        expect(BigInt(row.balanceRaw ?? "0") > 0n, `${row.address} 잔액 > 0`).toBe(true);
      }

      const restRows = rows.slice(nonzeroEnd);
      expect(restRows.length).toBeGreaterThan(0);
      const headAddresses = [...PINNED_IN_ORDER, ...expectedNonzero];
      for (const row of restRows) {
        expect(
          headAddresses.some((address) => sameAddress(address, row.address)),
          `${row.address}는 나머지 그룹에 있다`,
        ).toBe(false);
        // 나머지 그룹은 잔액이 0이거나 잔액을 모르는(읽기 실패, EC-14) 토큰이다.
        expect(
          row.balanceRaw === null || BigInt(row.balanceRaw) === 0n,
          `${row.address} 잔액`,
        ).toBe(true);
      }
    });
  });

  test.describe("`최대`로 금액 채우기", () => {
    /**
     * @spec DoD-30
     * @given 러너가 anvil에서 mock 계정에 소수부 6자리를 모두 쓰는 USDC 잔액을 절대값으로 주입하고 그 정수를 anvil에서 직접 읽었다. mock 커넥터로 지갑이 연결되어 있고 보내는 칸 토큰이 USDC이며 카드 잔액 읽기가 끝났다
     * @when 사용자가 `최대`를 누른다
     * @then 보내는 칸 금액을 USDC decimals로 정수 변환한 값이 러너가 읽은 USDC 잔액 정수와 같다
     */
    test("[DoD-30] ERC-20의 `최대`는 잔액 전체를 정밀도 손실 없이 금액에 넣는다", async ({
      page,
    }) => {
      const usdcBalance = await injectUsdc(DOD30_USDC_RAW);
      expect(usdcBalance % 10n, "소수부 6자리를 모두 쓴다").not.toBe(0n);
      await openConnectedApp(page);
      await selectToken(page, "in", USDC);
      await expect(cardBalance(page, "in")).toHaveAttribute(
        "data-balance-raw",
        String(usdcBalance),
      );
      await expect(maxButton(page)).toBeEnabled();

      await maxButton(page).click();

      await expect(amountInput(page, "in")).not.toHaveValue("");
      expect(await readAmountRaw(page, "in", USDC_DECIMALS)).toBe(usdcBalance);
    });

    /**
     * @spec DoD-31
     * @given 러너가 anvil에서 mock 계정의 ETH 잔액 정수를 직접 읽었고 그 값이 Ethereum 가스 예약량(0.005 ETH)보다 크다. 선택 체인은 Ethereum이고 mock 커넥터로 지갑이 연결되어 있으며 보내는 칸 토큰이 ETH이고 카드 잔액 읽기가 끝났다
     * @when 사용자가 `최대`를 누른다
     * @then 보내는 칸 금액을 ETH decimals로 정수 변환한 값이 러너가 읽은 ETH 잔액 정수에서 Ethereum 가스 예약량(5000000000000000 wei)을 뺀 값과 같다
     */
    test("[DoD-31] ETH의 `최대`는 잔액에서 선택 체인의 가스 예약량을 뺀 값을 넣는다", async ({
      page,
    }) => {
      const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
      expect(ethBalance > ETHEREUM_GAS_RESERVE_WEI).toBe(true);
      await openConnectedApp(page);
      await expectTokens(page, ETH, "");
      await expect(cardBalance(page, "in")).toHaveAttribute("data-balance-raw", String(ethBalance));
      await expect(maxButton(page)).toBeEnabled();

      await maxButton(page).click();

      await expect(amountInput(page, "in")).not.toHaveValue("");
      expect(await readAmountRaw(page, "in", ETH_DECIMALS)).toBe(
        ethBalance - ETHEREUM_GAS_RESERVE_WEI,
      );
    });
  });

  test.describe("주 버튼 입력 상태", () => {
    /**
     * @spec DoD-35
     * @given 페이지 초기 상태(보내는 칸 ETH, 받는 칸 미선택)에서 mock 커넥터로 지갑을 연결했다
     * @when 사용자가 두 칸 중 하나의 토큰이 미선택인 표본 상태를 만든다 (표본: 아무것도 바꾸지 않아 받는 칸 미선택, 뒤집기 버튼을 눌러 보내는 칸 미선택)
     * @then 주 버튼 상태가 `select-token`이다
     * @then 주 버튼이 비활성이다
     */
    test("[DoD-35] 연결 상태에서 토큰이 하나라도 미선택이면 주 버튼이 select-token이고 비활성이다", async ({
      page,
    }) => {
      await openConnectedApp(page);
      await expectTokens(page, ETH, "");

      await test.step("표본: 아무것도 바꾸지 않아 받는 칸 미선택", async () => {
        await expectTokens(page, ETH, "");
        await expect(primaryButton(page)).toHaveAttribute("data-state", "select-token");
        await expect(primaryButton(page)).toBeDisabled();
      });

      await test.step("표본: 뒤집기 버튼을 눌러 보내는 칸 미선택", async () => {
        await flipButton(page).click();
        await expectTokens(page, "", ETH);
        await expect(primaryButton(page)).toHaveAttribute("data-state", "select-token");
        await expect(primaryButton(page)).toBeDisabled();
      });
    });

    /**
     * @spec DoD-36
     * @given mock 커넥터로 지갑이 연결되어 있고 두 칸에 토큰이 선택되어 있다
     * @when 사용자가 보내는 칸 금액을 표본 값으로 둔다 (표본: 빈 값, `0`)
     * @then 주 버튼 상태가 `enter-amount`다
     * @then 주 버튼이 비활성이다
     */
    test("[DoD-36] 두 토큰이 선택되고 금액이 비었거나 0이면 주 버튼이 enter-amount이고 비활성이다", async ({
      page,
    }) => {
      await openConnectedApp(page);
      await selectToken(page, "out", USDC);
      await expectTokens(page, ETH, USDC);

      for (const amount of ["", "0"]) {
        await test.step(`표본: ${amount === "" ? "빈 값" : amount}`, async () => {
          await amountInput(page, "in").fill(amount);
          await expect(amountInput(page, "in")).toHaveValue(amount);
          await expect(primaryButton(page)).toHaveAttribute("data-state", "enter-amount");
          await expect(primaryButton(page)).toBeDisabled();
        });
      }
    });

    /**
     * @spec DoD-37
     * @given 러너가 anvil에서 mock 계정에 USDC 잔액을 절대값으로 주입하고 그 정수를 anvil에서 직접 읽었다. mock 커넥터로 지갑이 연결되어 있고 보내는 칸 USDC, 받는 칸에 다른 토큰이 선택되어 있으며 카드 잔액 읽기가 끝났다
     * @when 사용자가 러너가 읽은 USDC 잔액보다 큰 금액을 보내는 칸에 입력한다
     * @then 주 버튼 상태가 `insufficient-balance`다
     * @then 주 버튼이 비활성이다
     */
    test("[DoD-37] 금액이 보내는 토큰 잔액보다 크면 주 버튼이 insufficient-balance이고 비활성이다", async ({
      page,
    }) => {
      const usdcBalance = await injectUsdc(DOD37_USDC_RAW);
      await openConnectedApp(page);
      await selectUsdcToEth(page, usdcBalance);

      const amount = formatUnits(usdcBalance + 1n, USDC_DECIMALS);
      await amountInput(page, "in").fill(amount);
      await expect(amountInput(page, "in")).toHaveValue(amount);

      await expect(primaryButton(page)).toHaveAttribute("data-state", "insufficient-balance");
      await expect(primaryButton(page)).toBeDisabled();
    });

    /**
     * @spec DoD-38
     * @given 러너가 anvil에서 mock 계정에 USDC 잔액을 절대값으로 주입하고 그 정수를 anvil에서 직접 읽었다. mock 커넥터로 지갑이 연결되어 있고 보내는 칸 USDC, 받는 칸에 다른 토큰이 선택되어 있으며 카드 잔액 읽기가 끝났다
     * @when 사용자가 0보다 크고 러너가 읽은 USDC 잔액 이하인 금액을 보내는 칸에 입력한다 (표본: 잔액보다 작은 값, 잔액과 같은 값)
     * @then 주 버튼 상태가 `input-valid`다
     * @then 주 버튼이 비활성이다
     */
    test("[DoD-38] 토큰·금액·잔액 조건을 모두 만족하면 주 버튼이 input-valid이고 비활성이다", async ({
      page,
    }) => {
      const usdcBalance = await injectUsdc(DOD38_USDC_RAW);
      await openConnectedApp(page);
      await selectUsdcToEth(page, usdcBalance);

      const samples = [
        { name: "잔액보다 작은 값", raw: usdcBalance - 1n },
        { name: "잔액과 같은 값", raw: usdcBalance },
      ];
      for (const sample of samples) {
        await test.step(`표본: ${sample.name}`, async () => {
          expect(sample.raw > 0n).toBe(true);
          const amount = formatUnits(sample.raw, USDC_DECIMALS);
          await amountInput(page, "in").fill(amount);
          await expect(amountInput(page, "in")).toHaveValue(amount);

          await expect(primaryButton(page)).toHaveAttribute("data-state", "input-valid");
          await expect(primaryButton(page)).toBeDisabled();
        });
      }
    });
  });
});
