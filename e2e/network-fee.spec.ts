import type { Address } from "viem";

import { expect, test } from "@playwright/test";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  approveWarmUpRequest,
  exactInputSingleWarmUpRequest,
  quoteEachTierDirectly,
  readErc20Allowance,
  readErc20Balance,
  readEthBalance,
  revertAnvilSnapshot,
  setErc20Balance,
  takeAnvilSnapshot,
  warmUpEstimateGas,
  warmUpSwapQuote,
  warmUpTokenBalances,
  wrapWarmUpRequest,
} from "./support/anvil";
import { primaryButton } from "./support/app";
import {
  ALLOWANCE_SETTLE_TIMEOUT_MS,
  TX_SETTLE_TIMEOUT_MS,
  enterErc20Swap,
} from "./support/approve-swap";
import { expectEnabledNativeEthPrimaryState } from "./support/native-eth";
import { NETWORK_FEE_SETTLE_TIMEOUT_MS, expectNetworkFeeSuccess } from "./support/network-fee";
import { pickRunnerFeeTier } from "./support/usd-price";

// F10 network-fee E2E(T-14).
// 판정: 화면은 `network-fee`의 `data-kind`·`data-state`·`data-fee-wei`(세 속성을 같은 시점에 읽음)와 주 버튼 `data-state`로 본다.
// `data-fee-wei`는 0보다 큰지만 보고 러너 계산값과 비교하지 않는다(사용자 확정 2026-11-22: `--block-time 1`에서
// `eth_gasPrice` = baseFee + 1 gwei가 블록마다 바뀐다, T-1 (7). 계산은 통합 테스트가 덮는다). 문구는 판정에 쓰지 않는다.
// 경계(사용자 확정 2026-11-22): F9 E2E 경계(mock 커넥터, 감시만 하는 네트워크)에 러너→anvil 추정 경로 예열을 더한다.
// `page.route`는 쓰지 않는다. 제품 코드(`config/e2e-mock.ts` 포함)는 바꾸지 않는다.
// 이 경계가 증명하지 못하는 것: 실제 지갑(mock 커넥터 대체), L2 체인(Base·Arbitrum), Vercel WAF(로컬 프록시만).
// 격리: 테스트별 브라우저 컨텍스트, 쓰기 테스트(DoD-42)는 snapshot을 새로 잡고 끝에 revert(반환 true 단정), `workers: 1`.
// 실행 환경: 앱 3100(`NEXT_PUBLIC_E2E_MOCK=1`, `.next-e2e`), anvil 8546(`--block-time 1`), 포크 블록·포트는 `config/e2e.ts`,
// 계정은 `config/e2e-mock.ts`의 mock 계정(EIP-7702 위임 코드 그대로, T-1 (1): approve·ETH 입력 스왑·wrap·승인 뒤 스왑 추정 성공).
// 대상 체인은 Ethereum(anvil 포크)만. `check:build`와 동시에 실행하지 않는다.

// Ethereum 메인넷 주소(리터럴). 기대값·예열 요청은 제품 config를 거치지 않는다.
// 출처: Uniswap v3 Ethereum 배포 문서(SwapRouter02), 토큰 컨트랙트(WETH9, 네이티브 USDC).
const SWAP_ROUTER_02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const ETH = NATIVE_ETH_ADDRESS;
const WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// DoD-42 보내는 금액(입력 정수 `amountInRaw`): 5 USDC. T-1 (1)·(6) 표본(USDC→WETH 추정 131295 gas).
const USDC_TO_WETH_AMOUNT_IN_RAW = 5_000_000n;
// DoD-42 주입 USDC 잔액(절대값): 1000 USDC. 보내는 금액보다 커서 잔액 부족이 앞서지 않는다.
const USDC_BALANCE_RAW = 1_000_000_000n;
// DoD-43 보내는 금액: 1 ETH. T-1 (1)·(6) 표본(mock 계정 ETH 입력 추정 150212 gas).
const ETH_TO_USDC_AMOUNT_IN_RAW = 1_000_000_000_000_000_000n;
// DoD-44 wrap 금액: 1 ETH. T-1 (1) 표본(wrap 추정 27938 gas).
const WRAP_AMOUNT_IN_RAW = 1_000_000_000_000_000_000n;

// 모달 일괄 잔액 읽기 예열 대상(다른 E2E와 같은 목록). 예열에만 쓰고 판정에는 쓰지 않는다.
const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== ETH.toLowerCase());

// 예열: 러너가 고른 티어로 SwapRouter02 `exactInputSingle` 추정을 anvil에 미리 보낸다. 티어 후보가 없으면 건너뛴다
// (그때는 앱 견적도 실패해 테스트의 주 버튼 대기가 실패로 드러난다). 판정에는 쓰지 않는다.
async function warmUpSwapEstimate(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  value?: bigint;
}): Promise<void> {
  const picked = pickRunnerFeeTier(
    params.tokenIn,
    params.tokenOut,
    await quoteEachTierDirectly(params.tokenIn, params.tokenOut, params.amountIn),
  );
  if (picked === null) return;
  await warmUpEstimateGas(
    E2E_MOCK_ACCOUNT,
    exactInputSingleWarmUpRequest({
      router: SWAP_ROUTER_02,
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: picked.fee,
      recipient: E2E_MOCK_ACCOUNT,
      amountIn: params.amountIn,
      value: params.value,
    }),
  );
}

// given 공통(DoD-43·44): 러너가 읽은 mock 계정 ETH 잔액이 0보다 크고 보내는 금액보다 크다(주입하지 않는다).
async function expectEthBalanceAbove(amountInRaw: bigint): Promise<void> {
  const ethBalance = await readEthBalance(E2E_MOCK_ACCOUNT);
  expect(
    amountInRaw > 0n && ethBalance > amountInRaw,
    `mock 계정 ETH 잔액(${ethBalance})이 보내는 금액(${amountInRaw})보다 크다`,
  ).toBe(true);
}

test.describe("네트워크 수수료 — 사용자가 주 버튼이 보낼 트랜잭션의 예상 수수료를 미리 본다", () => {
  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기, 세 흐름의 견적 경로, 추정 경로(approve,
  // USDC→WETH·ETH→USDC 스왑, wrap)를 올려 두어 앱 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다
  // (T-1 (6): cold 첫 추정 최대 약 2.9초·견적 약 4초, CI는 캐시 없음). 이 hook의 시간 제한만 늘린다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + 2 * QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await Promise.all([
      warmUpSwapQuote(USDC, WETH, USDC_TO_WETH_AMOUNT_IN_RAW),
      warmUpSwapQuote(WETH, USDC, ETH_TO_USDC_AMOUNT_IN_RAW),
    ]);
    await Promise.all([
      warmUpEstimateGas(
        E2E_MOCK_ACCOUNT,
        approveWarmUpRequest(USDC, SWAP_ROUTER_02, USDC_TO_WETH_AMOUNT_IN_RAW),
      ),
      // 예열 시점에는 USDC 잔액·allowance가 없어 `STF`로 revert하지만, 그 지점까지의 라우터·풀 상태는 올라간다.
      warmUpSwapEstimate({ tokenIn: USDC, tokenOut: WETH, amountIn: USDC_TO_WETH_AMOUNT_IN_RAW }),
      warmUpSwapEstimate({
        tokenIn: WETH,
        tokenOut: USDC,
        amountIn: ETH_TO_USDC_AMOUNT_IN_RAW,
        value: ETH_TO_USDC_AMOUNT_IN_RAW,
      }),
      warmUpEstimateGas(E2E_MOCK_ACCOUNT, wrapWarmUpRequest(WETH, WRAP_AMOUNT_IN_RAW)),
    ]);
  });

  test.describe("ERC-20 입력: 승인 후 스왑", () => {
    // 쓰기 테스트(approve 체결)마다 anvil 상태를 새로 잡고 끝에 되돌린다. revert하지 않으면 USDC allowance·잔액이 남아
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

    /**
     * @spec DoD-42
     * @given 선택 체인은 Ethereum(anvil 포크)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡고 mock 계정에 USDC 잔액을 주입했으며 SwapRouter02 allowance는 보낼 금액보다 작다. 사용자가 보내는 칸을 USDC, 받는 칸을 WETH로 정하고 0보다 크고 잔액 이하인 금액을 입력해 주 버튼이 `approve-required`다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 수수료 추정이 끝나기를 기다린 뒤 `approve-required` 주 버튼을 누르고, 승인이 체결되어 주 버튼이 `swap-ready`가 된다
     * @then 승인 전 `network-fee`가 `data-kind=approve`·`data-state=success`이고 `data-fee-wei` > 0이다
     * @then 승인 뒤 `network-fee`가 `data-kind=swap`·`data-state=success`로 바뀌고 `data-fee-wei` > 0이다
     */
    test("[DoD-42] USDC→WETH 수수료 행이 approve에서 승인 뒤 swap으로 바뀌고 두 단계 모두 수수료가 0보다 크다", async ({
      page,
    }) => {
      // given: snapshot(beforeEach) 뒤 mock 계정에 USDC 잔액을 절대값으로 주입한다. allowance < 보낼 금액임을 러너가 확인한다
      await setErc20Balance(E2E_MOCK_ACCOUNT, USDC, USDC_BALANCE_RAW);
      expect(await readErc20Balance(E2E_MOCK_ACCOUNT, USDC), "주입한 USDC 잔액").toBe(
        USDC_BALANCE_RAW,
      );
      expect(
        USDC_TO_WETH_AMOUNT_IN_RAW > 0n && USDC_TO_WETH_AMOUNT_IN_RAW <= USDC_BALANCE_RAW,
        "보낼 금액이 0보다 크고 주입 USDC 잔액 이하",
      ).toBe(true);
      const allowance = await readErc20Allowance(E2E_MOCK_ACCOUNT, USDC, SWAP_ROUTER_02);
      expect(allowance < USDC_TO_WETH_AMOUNT_IN_RAW, "SwapRouter02 allowance < amountInRaw").toBe(
        true,
      );

      // given: 앱을 열고 mock 커넥터로 연결해 USDC→WETH 금액을 입력한다. 주 버튼이 approve-required다
      await enterErc20Swap(page, {
        tokenIn: USDC,
        tokenOut: WETH,
        amountInRaw: USDC_TO_WETH_AMOUNT_IN_RAW,
        decimalsIn: USDC_DECIMALS,
      });
      await expectEnabledNativeEthPrimaryState(
        page,
        "approve-required",
        ALLOWANCE_SETTLE_TIMEOUT_MS,
      );

      // then: 승인 전 network-fee가 kind=approve, state=success, fee-wei > 0이다(수수료 추정이 끝나기를 기다림을 겸한다)
      await expectNetworkFeeSuccess(page, "approve", NETWORK_FEE_SETTLE_TIMEOUT_MS);

      // when: approve-required 주 버튼을 누르고 승인이 체결되어 swap-ready가 될 때까지 기다린다
      await primaryButton(page).click();
      await expectEnabledNativeEthPrimaryState(page, "swap-ready", TX_SETTLE_TIMEOUT_MS);

      // then: 승인 뒤 network-fee가 kind=swap, state=success, fee-wei > 0이다
      await expectNetworkFeeSuccess(page, "swap", NETWORK_FEE_SETTLE_TIMEOUT_MS);

      // 정리: afterEach가 snapshot으로 revert한다
    });
  });

  test.describe("ETH 입력 스왑", () => {
    /**
     * @spec DoD-43
     * @given 선택 체인은 Ethereum(anvil 포크)이고 mock 커넥터로 지갑이 연결되어 있다. mock 계정은 ETH 잔액이 있다
     * @when 사용자가 보내는 칸을 ETH, 받는 칸을 USDC로 정하고 0보다 크고 ETH 잔액보다 작은 금액을 입력해 주 버튼이 `swap-ready`가 된다
     * @then `network-fee`가 `data-kind=swap`·`data-state=success`이다
     * @then `network-fee`의 `data-fee-wei` > 0이다
     */
    test("[DoD-43] ETH→USDC 수수료 행이 swap이고 수수료가 0보다 크다", async ({ page }) => {
      // given: 러너가 읽은 mock 계정 ETH 잔액 > 보내는 금액 > 0(상태를 바꾸지 않는다)
      await expectEthBalanceAbove(ETH_TO_USDC_AMOUNT_IN_RAW);

      // given + when: 앱을 열고 mock 커넥터로 연결해(Ethereum) 보내는 칸 ETH, 받는 칸 USDC, 금액을 입력해 주 버튼이 swap-ready가 된다
      await enterErc20Swap(page, {
        tokenIn: ETH,
        tokenOut: USDC,
        amountInRaw: ETH_TO_USDC_AMOUNT_IN_RAW,
        decimalsIn: ETH_DECIMALS,
      });
      await expectEnabledNativeEthPrimaryState(page, "swap-ready", ALLOWANCE_SETTLE_TIMEOUT_MS);

      // then: network-fee가 kind=swap, state=success, fee-wei > 0이다
      await expectNetworkFeeSuccess(page, "swap", NETWORK_FEE_SETTLE_TIMEOUT_MS);
    });
  });

  test.describe("ETH→WETH 전환", () => {
    /**
     * @spec DoD-44
     * @given 선택 체인은 Ethereum(anvil 포크)이고 mock 커넥터로 지갑이 연결되어 있다. mock 계정은 ETH 잔액이 있다
     * @when 사용자가 보내는 칸을 ETH, 받는 칸을 WETH로 정하고 0보다 크고 ETH 잔액보다 작은 금액을 입력해 주 버튼이 `wrap-ready`가 된다
     * @then `network-fee`가 `data-kind=wrap`·`data-state=success`이다
     * @then `network-fee`의 `data-fee-wei` > 0이다
     */
    test("[DoD-44] ETH→WETH 수수료 행이 wrap이고 수수료가 0보다 크다", async ({ page }) => {
      // given: 러너가 읽은 mock 계정 ETH 잔액 > 보내는 금액 > 0(상태를 바꾸지 않는다)
      await expectEthBalanceAbove(WRAP_AMOUNT_IN_RAW);

      // given + when: 앱을 열고 mock 커넥터로 연결해(Ethereum) 보내는 칸 ETH, 받는 칸 WETH, 금액을 입력해 주 버튼이 wrap-ready가 된다
      await enterErc20Swap(page, {
        tokenIn: ETH,
        tokenOut: WETH,
        amountInRaw: WRAP_AMOUNT_IN_RAW,
        decimalsIn: ETH_DECIMALS,
      });
      await expectEnabledNativeEthPrimaryState(page, "wrap-ready", ALLOWANCE_SETTLE_TIMEOUT_MS);

      // then: network-fee가 kind=wrap, state=success, fee-wei > 0이다
      await expectNetworkFeeSuccess(page, "wrap", NETWORK_FEE_SETTLE_TIMEOUT_MS);
    });
  });
});
