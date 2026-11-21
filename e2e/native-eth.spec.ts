import type { Address, Hex } from "viem";

import { expect, test } from "@playwright/test";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  readErc20Allowance,
  readErc20Balance,
  readEthBalance,
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
} from "./support/approve-swap";
import {
  clearDelegationCode,
  expectDelegationCodeRestored,
  expectEnabledNativeEthPrimaryState,
  readDelegationCode,
} from "./support/native-eth";
import { expectTxStatus } from "./support/tx-status";

// F7 native-eth E2E(T-16).
// 판정: 화면은 주 버튼 `data-state`와 `tx-status`의 `data-status`·`data-kind`로, 잔액은 러너가 anvil에서 직접 읽은
// 값과 입력 정수(`amountInRaw`)로 판정한다. 문구는 판정에 쓰지 않는다.
// 경계(D-3 사용자 확정): F5 T-13·F6 T-12 경계(mock 커넥터, 기존 E2E 제어값 `sendTransactionError`, 러너→anvil 잔액 읽기·
// ERC-20 주입·해시 조회)에 준비 단계에서만 러너→anvil 위임 코드 제거(`anvil_setCode`)와 WETH 절대값 주입을 더한다.
// `page.route`는 쓰지 않는다. 제품 코드(`config/e2e-mock.ts` 포함)는 바꾸지 않는다.
// 격리: 테스트별 브라우저 컨텍스트, 쓰기 테스트마다 snapshot을 새로 잡고 끝에 revert(반환 true 단정), `workers: 1`.
// 실행 환경: 앱 3100(`NEXT_PUBLIC_E2E_MOCK=1`, `.next-e2e`), anvil 8546(`--block-time 1`), 포크 블록·포트는 `config/e2e.ts`,
// 계정은 `config/e2e-mock.ts`의 mock 계정. 대상 체인은 Ethereum(anvil 포크)만. `check:build`와 동시에 실행하지 않는다.

// Ethereum 메인넷 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
// 출처: Uniswap v3 Ethereum 배포 문서(SwapRouter02), 토큰 컨트랙트(WETH9, USDC).
const SWAP_ROUTER_02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const ETH = NATIVE_ETH_ADDRESS;
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_DECIMALS = 18;
const WETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// DoD-35 보내는 금액(입력 정수 `amountInRaw`): 1 ETH. T-1 확인 표본(티어 100, 가격 영향 normal, 50bps 최소 수령량 > 0).
const ETH_TO_USDC_AMOUNT_IN_RAW = 1_000_000_000_000_000_000n;
// DoD-36 보내는 금액: 1000 USDC. T-1 확인 표본(티어 100, 가격 영향 normal).
const USDC_TO_ETH_AMOUNT_IN_RAW = 1_000_000_000n;
// DoD-36 주입 USDC 잔액(절대값): 2000 USDC. 보내는 금액보다 커서 잔액 부족이 앞서지 않는다.
const USDC_BALANCE_RAW = 2_000_000_000n;
// DoD-37 wrap 금액: 1 ETH.
const WRAP_AMOUNT_IN_RAW = 1_000_000_000_000_000_000n;
// DoD-38 unwrap 금액: 0.5 WETH. 주입 WETH 잔액(절대값) 1 WETH 이하다(T-1 (7) 표본).
const UNWRAP_AMOUNT_IN_RAW = 500_000_000_000_000_000n;
const WETH_BALANCE_RAW = 1_000_000_000_000_000_000n;

const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase());

// given 공통(DoD-35·37): 러너가 읽은 mock 계정 ETH 잔액이 보내는 금액보다 크다(주입하지 않는다).
async function expectEthBalanceAbove(amountInRaw: bigint): Promise<void> {
  const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
  expect(
    amountInRaw > 0n && ethBalance > amountInRaw,
    `mock 계정 ETH 잔액(${ethBalance})이 보내는 금액(${amountInRaw})보다 크다`,
  ).toBe(true);
}

test.describe("ETH 스왑과 전환 — 연결된 사용자가 ETH를 보내거나 받는 스왑과 ETH ↔ WETH 전환을 실행한다", () => {
  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기와 두 스왑 표본의 견적 경로
  // (ETH는 WETH 치환 주소)를 올려 두어 앱 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다. 이 hook의 시간 제한만 늘린다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + 2 * QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await warmUpSwapQuote(WETH, USDC, ETH_TO_USDC_AMOUNT_IN_RAW);
    await warmUpSwapQuote(USDC, WETH, USDC_TO_ETH_AMOUNT_IN_RAW);
  });

  // 쓰기 테스트마다 anvil 상태를 새로 잡고 끝에 되돌린다. revert하지 않으면 잔액·allowance·nonce와 지운 위임 코드가 남아
  // 다음 실행의 전제가 달라지므로 revert 결과(`true`)를 단정한다.
  let snapshotId: string | null = null;
  // 위임 코드를 지운 테스트(DoD-36·38)가 지우기 전에 확인한 코드. revert 뒤 복원을 보조 확인한다.
  let clearedDelegationCode: Hex | null = null;

  test.beforeEach(async () => {
    snapshotId = await takeAnvilSnapshot();
    clearedDelegationCode = null;
  });

  test.afterEach(async () => {
    const id = snapshotId;
    const code = clearedDelegationCode;
    snapshotId = null;
    clearedDelegationCode = null;
    expect(id, "beforeEach에서 잡은 snapshot id").not.toBeNull();
    if (id === null) return;
    expect(await revertAnvilSnapshot(id), "evm_revert 결과").toBe(true);
    // 보조 확인(계획 T-16 완료 조건, @then 아님): revert 뒤 mock 계정 코드가 지우기 전 위임 코드로 복원됐다
    if (code !== null) await expectDelegationCodeRestored(E2E_MOCK_ACCOUNT, code);
  });

  // 준비(DoD-36·38): snapshot(beforeEach) 뒤, 러너가 읽은 mock 계정 코드가 위임 표식인지 확인하고 지운다.
  async function clearMockDelegationCode(): Promise<void> {
    const code = await readDelegationCode(E2E_MOCK_ACCOUNT);
    clearedDelegationCode = code;
    await clearDelegationCode(E2E_MOCK_ACCOUNT);
  }

  test.describe("ETH를 보내는 스왑", () => {
    /**
     * @spec DoD-35
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡았고, 러너가 읽은 mock 계정의 ETH 잔액은 보내는 금액보다 크다. 사용자가 보내는 칸을 ETH, 받는 칸을 USDC로 정하고 0보다 큰 금액을 입력해 실제 견적이 성공했고 주 버튼은 `swap-ready`다. 러너가 클릭 전에 anvil에서 mock 계정의 USDC 잔액을 읽어 둔다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `swap-ready` 주 버튼을 누른다
     * @then swap 영수증이 성공하면 `tx-status`가 `data-status="success"`·`data-kind="swap"`이다
     * @then 러너가 anvil에서 직접 읽은 USDC 잔액이 클릭 전보다 늘어난다
     */
    test("[DoD-35] ETH→USDC 스왑이 체결되고 USDC 잔액이 늘어난다", async ({ page }) => {
      // given: snapshot(beforeEach), 러너가 읽은 mock 계정 ETH 잔액 > 보내는 금액
      await expectEthBalanceAbove(ETH_TO_USDC_AMOUNT_IN_RAW);

      // given: 앱을 열고 mock 커넥터로 연결해 ETH→USDC 금액을 입력한다. 실제 견적이 성공해 swap-ready다
      await enterErc20Swap(page, {
        tokenIn: ETH,
        tokenOut: USDC,
        amountInRaw: ETH_TO_USDC_AMOUNT_IN_RAW,
        decimalsIn: ETH_DECIMALS,
      });
      await expectEnabledNativeEthPrimaryState(page, "swap-ready", ALLOWANCE_SETTLE_TIMEOUT_MS);

      // given: 클릭 전 USDC 잔액을 러너가 anvil에서 읽는다
      const usdcBefore = await readErc20Balance(E2E_MOCK_ACCOUNT, USDC);

      // when: swap-ready를 누른다
      await primaryButton(page).click();

      // then: tx-status가 success·swap이 된다
      await expectTxStatus(page, { status: "success", kind: "swap" }, TX_SETTLE_TIMEOUT_MS);

      // then: 러너가 다시 읽은 USDC 잔액이 클릭 전보다 늘었다
      await expect
        .poll(() => readErc20Balance(E2E_MOCK_ACCOUNT, USDC), {
          message: `USDC 잔액이 클릭 전(${usdcBefore})보다 늘어난다`,
          timeout: TX_SETTLE_TIMEOUT_MS,
        })
        .toBeGreaterThan(usdcBefore);

      // 끝: afterEach가 snapshot으로 revert한다
    });
  });

  test.describe("ETH를 받는 스왑", () => {
    /**
     * @spec DoD-36
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 준비 단계에서 러너가 anvil 상태를 snapshot으로 잡은 뒤, 러너가 읽은 mock 계정 코드가 EIP-7702 위임 표식(`0xef0100`으로 시작)임을 확인하고 위임 코드를 지운 다음, mock 계정에 보내는 토큰(USDC) 잔액을 절대값으로 주입했으며, 러너가 읽은 SwapRouter02 allowance는 `amountInRaw`보다 작다. 사용자가 보내는 칸을 USDC, 받는 칸을 ETH로 정하고 0보다 크고 주입 잔액 이하인 금액을 입력해 실제 견적이 성공했고 주 버튼은 `approve-required`다. 러너가 클릭 전에 anvil에서 mock 계정의 USDC 잔액을 읽어 둔다. 테스트 끝에 snapshot으로 revert해 위임 코드를 되돌린다
     * @when 사용자가 `approve-required` 주 버튼을 누르고, 주 버튼이 `swap-ready`가 되면 `swap-ready` 주 버튼을 누른다
     * @then swap 영수증이 성공하면 `tx-status`가 `data-status="success"`·`data-kind="swap"`이다
     * @then 러너가 anvil에서 직접 읽은 USDC 잔액이 클릭 전보다 `amountInRaw`만큼 줄어든다
     */
    test("[DoD-36] approve 뒤 USDC→ETH 스왑이 체결되고 USDC 잔액이 amountInRaw만큼 줄어든다", async ({
      page,
    }) => {
      // given: snapshot(beforeEach) → mock 계정 코드가 0xef0100으로 시작하는지 확인 → 위임 코드 지우기
      await clearMockDelegationCode();

      // given: USDC 잔액 절대값 주입, allowance < amountInRaw 확인
      await setErc20Balance(E2E_MOCK_ACCOUNT, USDC, USDC_BALANCE_RAW);
      expect(await readErc20Balance(E2E_MOCK_ACCOUNT, USDC), "주입한 USDC 잔액").toBe(
        USDC_BALANCE_RAW,
      );
      expect(
        USDC_TO_ETH_AMOUNT_IN_RAW > 0n && USDC_TO_ETH_AMOUNT_IN_RAW <= USDC_BALANCE_RAW,
        "보낼 금액이 0보다 크고 주입 USDC 잔액 이하",
      ).toBe(true);
      const allowance = await readErc20Allowance(E2E_MOCK_ACCOUNT, USDC, SWAP_ROUTER_02);
      expect(allowance < USDC_TO_ETH_AMOUNT_IN_RAW, "SwapRouter02 allowance < amountInRaw").toBe(
        true,
      );

      // given: 앱을 열고 mock 커넥터로 연결해 USDC→ETH 금액을 입력한다. 실제 견적이 성공해 approve-required다
      await enterErc20Swap(page, {
        tokenIn: USDC,
        tokenOut: ETH,
        amountInRaw: USDC_TO_ETH_AMOUNT_IN_RAW,
        decimalsIn: USDC_DECIMALS,
      });
      await expectEnabledNativeEthPrimaryState(
        page,
        "approve-required",
        ALLOWANCE_SETTLE_TIMEOUT_MS,
      );

      // given: 클릭 전 USDC 잔액을 러너가 anvil에서 읽는다
      const usdcBefore = await readErc20Balance(E2E_MOCK_ACCOUNT, USDC);

      // when: approve-required를 누르고, swap-ready가 되면 swap-ready를 누른다
      await primaryButton(page).click();
      await expectEnabledNativeEthPrimaryState(page, "swap-ready", TX_SETTLE_TIMEOUT_MS);
      await primaryButton(page).click();

      // then: tx-status가 success·swap이 된다
      await expectTxStatus(page, { status: "success", kind: "swap" }, TX_SETTLE_TIMEOUT_MS);

      // then: 러너가 다시 읽은 USDC 잔액이 클릭 전 - amountInRaw다
      await expect
        .poll(async () => usdcBefore - (await readErc20Balance(E2E_MOCK_ACCOUNT, USDC)), {
          message: "USDC 잔액 감소량",
          timeout: TX_SETTLE_TIMEOUT_MS,
        })
        .toBe(USDC_TO_ETH_AMOUNT_IN_RAW);

      // 끝: afterEach가 snapshot으로 revert하고, 보조 확인으로 위임 코드 복원을 본다
    });
  });

  test.describe("ETH를 WETH로 전환", () => {
    /**
     * @spec DoD-37
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡았고, 러너가 읽은 mock 계정의 ETH 잔액은 보내는 금액보다 크다. 사용자가 보내는 칸을 ETH, 받는 칸을 WETH로 정하고 0보다 큰 금액(`amountInRaw`)을 입력해 주 버튼은 `wrap-ready`다. 러너가 클릭 전에 anvil에서 mock 계정의 WETH 잔액을 읽어 둔다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `wrap-ready` 주 버튼을 누른다
     * @then wrap 영수증이 성공하면 `tx-status`가 `data-status="success"`·`data-kind="wrap"`이다
     * @then 러너가 anvil에서 직접 읽은 WETH 잔액이 클릭 전보다 `amountInRaw`만큼 늘어난다
     */
    test("[DoD-37] ETH→WETH 전환이 체결되고 WETH 잔액이 금액만큼 늘어난다", async ({ page }) => {
      // given: snapshot(beforeEach), 러너가 읽은 mock 계정 ETH 잔액 > 보내는 금액
      await expectEthBalanceAbove(WRAP_AMOUNT_IN_RAW);

      // given: 앱을 열고 mock 커넥터로 연결해 ETH→WETH 금액을 입력한다. 주 버튼은 wrap-ready다
      await enterErc20Swap(page, {
        tokenIn: ETH,
        tokenOut: WETH,
        amountInRaw: WRAP_AMOUNT_IN_RAW,
        decimalsIn: ETH_DECIMALS,
      });
      await expectEnabledNativeEthPrimaryState(page, "wrap-ready", ALLOWANCE_SETTLE_TIMEOUT_MS);

      // given: 클릭 전 WETH 잔액을 러너가 anvil에서 읽는다
      const wethBefore = await readErc20Balance(E2E_MOCK_ACCOUNT, WETH);

      // when: wrap-ready를 누른다
      await primaryButton(page).click();

      // then: tx-status가 success·wrap이 된다
      await expectTxStatus(page, { status: "success", kind: "wrap" }, TX_SETTLE_TIMEOUT_MS);

      // then: 러너가 다시 읽은 WETH 잔액이 클릭 전 + amountInRaw다
      await expect
        .poll(async () => (await readErc20Balance(E2E_MOCK_ACCOUNT, WETH)) - wethBefore, {
          message: "WETH 잔액 증가량",
          timeout: TX_SETTLE_TIMEOUT_MS,
        })
        .toBe(WRAP_AMOUNT_IN_RAW);

      // 끝: afterEach가 snapshot으로 revert한다
    });
  });

  test.describe("WETH를 ETH로 전환", () => {
    /**
     * @spec DoD-38
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 읽은 mock 계정 코드는 EIP-7702 위임 표식(`0xef0100`으로 시작)이다. 준비 단계에서 러너가 anvil 상태를 snapshot으로 잡고, 그 뒤 mock 계정의 위임 코드를 지우고, mock 계정에 WETH를 절대값으로 주입한다. 사용자가 보내는 칸을 WETH, 받는 칸을 ETH로 정하고 0보다 크고 주입 잔액 이하인 금액(`amountInRaw`)을 입력해 주 버튼은 `unwrap-ready`다. 러너가 클릭 전에 anvil에서 mock 계정의 WETH 잔액을 읽어 둔다. 테스트 끝에 snapshot으로 revert해 위임 코드를 되돌린다
     * @when 사용자가 `unwrap-ready` 주 버튼을 누른다
     * @then unwrap 영수증이 성공하면 `tx-status`가 `data-status="success"`·`data-kind="unwrap"`이다
     * @then 러너가 anvil에서 직접 읽은 WETH 잔액이 클릭 전보다 `amountInRaw`만큼 줄어든다
     */
    test("[DoD-38] 위임 코드를 지운 계정에서 WETH→ETH 전환이 체결되고 WETH 잔액이 금액만큼 줄어든다", async ({
      page,
    }) => {
      // given: snapshot(beforeEach) → mock 계정 코드가 0xef0100으로 시작하는지 확인(읽기만 하므로 snapshot 앞뒤가 같은 값) → 위임 코드 지우기
      await clearMockDelegationCode();

      // given: WETH 잔액 절대값 주입
      await setErc20Balance(E2E_MOCK_ACCOUNT, WETH, WETH_BALANCE_RAW);
      expect(await readErc20Balance(E2E_MOCK_ACCOUNT, WETH), "주입한 WETH 잔액").toBe(
        WETH_BALANCE_RAW,
      );
      expect(
        UNWRAP_AMOUNT_IN_RAW > 0n && UNWRAP_AMOUNT_IN_RAW <= WETH_BALANCE_RAW,
        "보낼 금액이 0보다 크고 주입 WETH 잔액 이하",
      ).toBe(true);

      // given: 앱을 열고 mock 커넥터로 연결해 WETH→ETH 금액을 입력한다. 주 버튼은 unwrap-ready다
      await enterErc20Swap(page, {
        tokenIn: WETH,
        tokenOut: ETH,
        amountInRaw: UNWRAP_AMOUNT_IN_RAW,
        decimalsIn: WETH_DECIMALS,
      });
      await expectEnabledNativeEthPrimaryState(page, "unwrap-ready", ALLOWANCE_SETTLE_TIMEOUT_MS);

      // given: 클릭 전 WETH 잔액을 러너가 anvil에서 읽는다
      const wethBefore = await readErc20Balance(E2E_MOCK_ACCOUNT, WETH);

      // when: unwrap-ready를 누른다
      await primaryButton(page).click();

      // then: tx-status가 success·unwrap이 된다
      await expectTxStatus(page, { status: "success", kind: "unwrap" }, TX_SETTLE_TIMEOUT_MS);

      // then: 러너가 다시 읽은 WETH 잔액이 클릭 전 - amountInRaw다
      await expect
        .poll(async () => wethBefore - (await readErc20Balance(E2E_MOCK_ACCOUNT, WETH)), {
          message: "WETH 잔액 감소량",
          timeout: TX_SETTLE_TIMEOUT_MS,
        })
        .toBe(UNWRAP_AMOUNT_IN_RAW);

      // 끝: afterEach가 snapshot으로 revert하고, 보조 확인으로 위임 코드 복원을 본다
    });
  });
});
