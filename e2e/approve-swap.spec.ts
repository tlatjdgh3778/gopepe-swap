import type { Address } from "viem";

import { expect, test } from "@playwright/test";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  readErc20Allowance,
  readErc20Balance,
  revertAnvilSnapshot,
  setErc20Balance,
  takeAnvilSnapshot,
  warmUpSwapQuote,
  warmUpTokenBalances,
} from "./support/anvil";
import { primaryButton } from "./support/app";
import {
  ALLOWANCE_SETTLE_TIMEOUT_MS,
  TX_SETTLE_TIMEOUT_MS,
  enterErc20Swap,
  expectEnabledPrimaryState,
  readSendTransactionRequestCount,
  rejectWalletTransactions,
} from "./support/approve-swap";

// F5 approve-swap E2E(T-13).
// 경계: mock 커넥터와 E2E 전용 제어값(`config/e2e-mock.ts`), 러너→anvil 상태 주입·조회(잔액·allowance),
// 테스트마다 러너→anvil `evm_snapshot`/`evm_revert`. `page.route`와 automine 제어는 쓰지 않는다.
// 격리: 테스트별 브라우저 컨텍스트, 쓰기 테스트마다 snapshot을 새로 잡고 끝에 revert, 절대값 주입, `workers: 1`.

// Ethereum 메인넷 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
// 출처: Uniswap v3 Ethereum 배포 문서(SwapRouter02), 토큰 컨트랙트.
const SWAP_ROUTER_02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDC_DECIMALS = 6;

// 보내는 금액(입력 정수 `amountInRaw`): 5 USDC. T-1 확인 표본(티어 100, 가격 영향 normal, 최소 수령량 0 아님).
const AMOUNT_IN_RAW = 5_000_000n;
// 주입 USDC 잔액(절대값): 1000 USDC. 보내는 금액보다 커서 잔액 부족이 앞서지 않는다.
const USDC_BALANCE_RAW = 1_000_000_000n;

const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase());

type AnvilReadings = { allowance: bigint; usdc: bigint; dai: bigint };

// 러너가 anvil에서 직접 읽는다(앱 요청과 분리).
async function readAnvil(): Promise<AnvilReadings> {
  const [allowance, usdc, dai] = await Promise.all([
    readErc20Allowance(E2E_MOCK_ACCOUNT, USDC, SWAP_ROUTER_02),
    readErc20Balance(E2E_MOCK_ACCOUNT, USDC),
    readErc20Balance(E2E_MOCK_ACCOUNT, DAI),
  ]);
  return { allowance, usdc, dai };
}

// given 공통: USDC 잔액을 절대값으로 주입하고, allowance가 보내는 금액보다 작음을 확인한 뒤 클릭 전 값을 돌려준다.
async function injectUsdcAndReadBefore(): Promise<AnvilReadings> {
  await setErc20Balance(E2E_MOCK_ACCOUNT, USDC, USDC_BALANCE_RAW);
  const before = await readAnvil();
  expect(before.usdc, "주입한 USDC 잔액").toBe(USDC_BALANCE_RAW);
  expect(
    AMOUNT_IN_RAW > 0n && AMOUNT_IN_RAW <= before.usdc,
    "보낼 금액이 0보다 크고 USDC 잔액 이하",
  ).toBe(true);
  expect(before.allowance < AMOUNT_IN_RAW, "SwapRouter02 allowance < amountInRaw").toBe(true);
  return before;
}

test.describe("승인과 스왑 — 연결된 사용자가 ERC-20 토큰을 다른 ERC-20 토큰으로 바꾼다", () => {
  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기와 USDC→DAI 표본 금액의 견적 경로를 올려 두어
  // 앱 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다(cold 포크 USDC→DAI 견적은 약 9초, T-1). 이 hook의 시간 제한만 늘린다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await warmUpSwapQuote(USDC, DAI, AMOUNT_IN_RAW);
  });

  // 쓰기 테스트마다 anvil 상태를 새로 잡고 끝에 되돌린다. revert하지 않으면 USDC allowance가 남아
  // 다음 실행이 `swap-ready`로 시작하므로 revert 결과(`true`)를 단정한다.
  let snapshotId: string | null = null;

  test.beforeEach(async () => {
    snapshotId = await takeAnvilSnapshot();
  });

  test.afterEach(async () => {
    const id = snapshotId;
    snapshotId = null;
    expect(id, "beforeEach에서 잡은 snapshot id").not.toBeNull();
    if (id === null) return;
    expect(await revertAnvilSnapshot(id), "evm_revert 결과").toBe(true);
  });

  test.describe("approve 후 스왑 체결", () => {
    /**
     * @spec DoD-26
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡고 mock 계정에 보내는 토큰(USDC) 잔액을 절대값으로 주입했으며, 러너가 읽은 SwapRouter02 allowance는 `amountInRaw`보다 작다. 사용자가 보내는 칸을 USDC, 받는 칸을 DAI로 정하고 0보다 크고 주입 잔액 이하인 금액을 입력해 실제 견적이 성공했고 주 버튼은 `approve-required`다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `approve-required` 주 버튼을 누르고, 주 버튼이 `swap-ready`가 되면 `swap-ready` 주 버튼을 누른다
     * @then 러너가 anvil에서 직접 읽은 보내는 토큰(USDC) 잔액이 클릭 전보다 `amountInRaw`만큼 줄어든다
     * @then 러너가 anvil에서 직접 읽은 받는 토큰(DAI) 잔액이 클릭 전보다 늘어난다
     */
    test("[DoD-26] USDC→DAI를 approve 후 스왑하면 USDC가 amountInRaw만큼 줄고 DAI가 늘어난다", async ({
      page,
    }) => {
      // given: USDC 잔액 절대값 주입, allowance < amountInRaw 확인, 클릭 전 USDC·DAI 잔액을 러너가 읽는다
      const before = await injectUsdcAndReadBefore();

      // given: 앱을 열고 mock 커넥터로 연결해 USDC→DAI 금액을 입력한다. 실제 견적이 성공해 approve-required다
      await enterErc20Swap(page, {
        tokenIn: USDC,
        tokenOut: DAI,
        amountInRaw: AMOUNT_IN_RAW,
        decimalsIn: USDC_DECIMALS,
      });
      await expectEnabledPrimaryState(page, "approve-required", ALLOWANCE_SETTLE_TIMEOUT_MS);

      // when: approve-required를 누르고, swap-ready가 되면 swap-ready를 누른다
      await primaryButton(page).click();
      await expectEnabledPrimaryState(page, "swap-ready", TX_SETTLE_TIMEOUT_MS);
      await primaryButton(page).click();

      // then: 러너가 다시 읽은 USDC 잔액이 클릭 전 - amountInRaw가 될 때까지 기다린다(체결 대기 겸 판정)
      await expect
        .poll(async () => before.usdc - (await readErc20Balance(E2E_MOCK_ACCOUNT, USDC)), {
          message: "USDC 잔액 감소량",
          timeout: TX_SETTLE_TIMEOUT_MS,
        })
        .toBe(AMOUNT_IN_RAW);

      // then: 같은 트랜잭션으로 DAI 잔액이 클릭 전보다 늘었다
      const daiAfter = await readErc20Balance(E2E_MOCK_ACCOUNT, DAI);
      expect(daiAfter > before.dai, `DAI 잔액 증가 (전 ${before.dai}, 후 ${daiAfter})`).toBe(true);
    });
  });

  test.describe("지갑 서명 거부", () => {
    /**
     * @spec EC-2
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡고 mock 계정에 보내는 토큰(USDC) 잔액을 절대값으로 주입했으며, 러너가 읽은 SwapRouter02 allowance는 `amountInRaw`보다 작다. 사용자가 USDC→DAI 금액을 입력해 실제 견적이 성공했고 주 버튼은 `approve-required`다. E2E 제어값으로 mock 지갑의 트랜잭션 전송을 거부(4001)하도록 설정했다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `approve-required` 주 버튼을 누르고 지갑 서명이 거부된다
     * @then 주 버튼이 클릭 전 상태(`approve-required`, 활성)로 돌아간다
     * @then 트랜잭션이 체결되지 않아 러너가 anvil에서 직접 읽은 SwapRouter02 allowance와 보내는 토큰·받는 토큰 잔액이 클릭 전 값 그대로다
     */
    test("[EC-2] approve 서명을 거부하면 주 버튼이 approve-required로 돌아가고 체결이 없다", async ({
      page,
    }) => {
      // given: USDC 잔액 절대값 주입, allowance < amountInRaw 확인, 클릭 전 allowance·USDC·DAI를 러너가 읽는다
      const before = await injectUsdcAndReadBefore();

      // given: 앱 연결, USDC→DAI 금액 입력, approve-required
      await enterErc20Swap(page, {
        tokenIn: USDC,
        tokenOut: DAI,
        amountInRaw: AMOUNT_IN_RAW,
        decimalsIn: USDC_DECIMALS,
      });
      await expectEnabledPrimaryState(page, "approve-required", ALLOWANCE_SETTLE_TIMEOUT_MS);

      // given: E2E 제어값으로 전송 거부(4001)를 켜고, 클릭 전 전송 요청 수를 기록한다
      await rejectWalletTransactions(page);
      const sendRequestsBefore = await readSendTransactionRequestCount(page);

      // when: approve-required를 누르고, 지갑이 전송 요청을 받아 거부할 때까지 기다린다
      await primaryButton(page).click();
      await expect
        .poll(() => readSendTransactionRequestCount(page), {
          message: "mock 지갑이 받은(거부한) 전송 요청 수",
          timeout: TX_SETTLE_TIMEOUT_MS,
        })
        .toBe(sendRequestsBefore + 1);

      // then: 주 버튼이 클릭 전 상태(approve-required, 활성)로 돌아간다
      await expectEnabledPrimaryState(page, "approve-required", TX_SETTLE_TIMEOUT_MS);

      // then: 체결이 없어 러너가 다시 읽은 allowance·USDC·DAI가 클릭 전 값 그대로다
      expect(await readAnvil()).toEqual(before);
    });
  });
});
