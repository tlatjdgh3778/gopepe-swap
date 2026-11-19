import type { Address } from "viem";

import { type Page, expect, test } from "@playwright/test";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  readAccountNonce,
  readErc20Allowance,
  readErc20Balance,
  readTransactionHashBySenderAndNonce,
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
import {
  etherscanTxUrl,
  expectTxStatus,
  failWalletTransactionsWith,
  txLink,
} from "./support/tx-status";

// F6 tx-status E2E(T-12).
// 경계: mock 커넥터와 E2E 전용 제어값(`sendTransactionError`의 true·Error 객체 주입), 러너→anvil 상태 주입·조회
// (잔액·allowance·체결 해시), 테스트마다 러너→anvil snapshot/revert. `page.route`와 채굴 제어는 쓰지 않는다.
// 대상 체인: Ethereum(anvil 포크)만.
// 격리: 테스트별 브라우저 컨텍스트, 쓰기 테스트마다 snapshot을 새로 잡고 끝에 revert, 절대값 주입, `workers: 1`.

// Ethereum 메인넷 주소(리터럴). 기대값 계산은 제품 config를 거치지 않는다.
// 출처: Uniswap v3 Ethereum 배포 문서(SwapRouter02), 토큰 컨트랙트.
const SWAP_ROUTER_02: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDC_DECIMALS = 6;

// 보내는 금액(입력 정수 `amountInRaw`): 5 USDC. F5 T-1 확인 표본(티어 100, 가격 영향 normal, 최소 수령량 0 아님).
const AMOUNT_IN_RAW = 5_000_000n;
// 주입 USDC 잔액(절대값): 1000 USDC. 보내는 금액보다 커서 잔액 부족이 앞서지 않는다.
const USDC_BALANCE_RAW = 1_000_000_000n;

// EC-4 주입 오류: 메시지 문구와 무관하게 code -32000이면 send-failed다(스펙 EC-4).
const SEND_FAILED_ERROR = { code: -32000, message: "insufficient funds for gas * price + value" };

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

// given 공통: 앱을 열고 mock 커넥터로 연결해 USDC→DAI 금액을 입력한다. 실제 견적이 성공해 approve-required다.
async function enterUsdcToDaiUntilApproveRequired(page: Page): Promise<void> {
  await enterErc20Swap(page, {
    tokenIn: USDC,
    tokenOut: DAI,
    amountInRaw: AMOUNT_IN_RAW,
    decimalsIn: USDC_DECIMALS,
  });
  await expectEnabledPrimaryState(page, "approve-required", ALLOWANCE_SETTLE_TIMEOUT_MS);
}

// when 공통: mock 지갑이 클릭 뒤 전송 요청을 하나 이상 받을(그리고 제어값으로 실패시킬) 때까지 기다린다.
// -32000은 viem이 `wallet_sendTransaction`으로 한 번 더 보내 2건이 기록되므로(T-1) 건수를 고정하지 않는다.
async function waitForSendTransactionRequest(page: Page, countBefore: number): Promise<void> {
  await expect
    .poll(() => readSendTransactionRequestCount(page), {
      message: "mock 지갑이 받은(실패시킨) 전송 요청 수",
      timeout: TX_SETTLE_TIMEOUT_MS,
    })
    .toBeGreaterThan(countBefore);
}

test.describe("트랜잭션 상태 — approve·swap을 실행한 사용자가 결과를 상태 메시지로 구분해 보고 탐색기 링크로 트랜잭션을 확인한다", () => {
  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기와 USDC→DAI 표본 금액의 견적 경로를 올려 두어
  // 앱 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다. 이 hook의 시간 제한만 늘린다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await warmUpSwapQuote(USDC, DAI, AMOUNT_IN_RAW);
  });

  // 쓰기 테스트마다 anvil 상태를 새로 잡고 끝에 되돌린다. revert하지 않으면 USDC allowance와 nonce가 남아
  // 다음 실행의 전제가 달라지므로 revert 결과(`true`)를 단정한다.
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

  test.describe("성공 결과와 탐색기 링크", () => {
    /**
     * @spec DoD-7 DoD-8 DoD-9
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡고 mock 계정에 보내는 토큰(USDC) 잔액을 절대값으로 주입했으며, 러너가 읽은 SwapRouter02 allowance는 `amountInRaw`보다 작다. 사용자가 보내는 칸을 USDC, 받는 칸을 DAI로 정하고 0보다 크고 주입 잔액 이하인 금액을 입력해 실제 견적이 성공했고 주 버튼은 `approve-required`다. 러너가 클릭 전에 anvil에서 mock 계정의 nonce n을 읽어 두고, 체결 해시는 제품 코드와 화면 값에 의존하지 않고 러너가 snapshot 이후 블록을 조회해 (mock 계정, nonce)의 트랜잭션 해시로 찾는다(anvil이 지원하면 `*_getTransactionBySenderAndNonce` 조회로 대신한다). approve는 nonce n, swap은 nonce n+1이다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `approve-required` 주 버튼을 누르고, approve 결과 메시지가 표시되고 주 버튼이 `swap-ready`가 되면 `swap-ready` 주 버튼을 누른다
     * @then approve 영수증이 성공하면 `tx-status`가 `data-status="success"`·`data-kind="approve"`다
     * @then approve 성공 결과의 `tx-link` `href`는 `https://etherscan.io/tx/{러너가 anvil에서 얻은 approve 체결 트랜잭션 해시}`다
     * @then swap 영수증이 성공하면 `tx-status`가 `data-status="success"`·`data-kind="swap"`이다
     * @then swap 성공 결과의 `tx-link` `href`는 `https://etherscan.io/tx/{러너가 anvil에서 얻은 swap 체결 트랜잭션 해시}`다
     */
    test("[DoD-7][DoD-8][DoD-9] USDC→DAI를 approve 후 스왑하면 각 단계의 성공 메시지와 체결 해시 탐색기 링크가 보인다", async ({
      page,
    }) => {
      // given: snapshot(beforeEach), USDC 잔액 절대값 주입, allowance < amountInRaw 확인
      await injectUsdcAndReadBefore();

      // given: 앱을 열고 mock 커넥터로 연결해 USDC→DAI 금액을 입력한다. 주 버튼은 approve-required
      await enterUsdcToDaiUntilApproveRequired(page);

      // given: 클릭 전에 러너가 anvil에서 mock 계정의 nonce n을 읽는다
      const nonce = await readAccountNonce(E2E_MOCK_ACCOUNT);

      // when: approve-required를 누른다
      await primaryButton(page).click();

      // then: tx-status가 success·approve가 된다
      await expectTxStatus(page, { status: "success", kind: "approve" }, TX_SETTLE_TIMEOUT_MS);

      // then: 러너가 anvil에서 (mock 계정, nonce n) 트랜잭션 해시를 찾고(eth_getTransactionBySenderAndNonce),
      //       https://etherscan.io/tx/{해시}를 기대 href로 만들어 tx-link href와 대조한다(화면 값을 기대값으로 쓰지 않는다)
      const approveHash = await readTransactionHashBySenderAndNonce(E2E_MOCK_ACCOUNT, nonce);
      await expect(txLink(page)).toHaveAttribute("href", etherscanTxUrl(approveHash));

      // when: 주 버튼이 swap-ready가 되면 누른다
      await expectEnabledPrimaryState(page, "swap-ready", TX_SETTLE_TIMEOUT_MS);
      // 전제 확인: approve가 nonce n으로 체결되어 swap은 nonce n+1로 나간다
      expect(await readAccountNonce(E2E_MOCK_ACCOUNT), "swap 클릭 전 mock 계정 nonce").toBe(
        nonce + 1,
      );
      await primaryButton(page).click();

      // then: tx-status가 success·swap이 된다
      await expectTxStatus(page, { status: "success", kind: "swap" }, TX_SETTLE_TIMEOUT_MS);

      // then: 러너가 anvil에서 (mock 계정, nonce n+1) 트랜잭션 해시를 찾고(eth_getTransactionBySenderAndNonce),
      //       https://etherscan.io/tx/{해시}를 기대 href로 만들어 tx-link href와 대조한다
      const swapHash = await readTransactionHashBySenderAndNonce(E2E_MOCK_ACCOUNT, nonce + 1);
      await expect(txLink(page)).toHaveAttribute("href", etherscanTxUrl(swapHash));

      // 끝: afterEach가 snapshot으로 revert한다
    });
  });

  test.describe("전송 전 실패", () => {
    /**
     * @spec EC-1
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡고 mock 계정에 보내는 토큰(USDC) 잔액을 절대값으로 주입했으며, 러너가 읽은 SwapRouter02 allowance는 `amountInRaw`보다 작다. 사용자가 USDC→DAI 금액을 입력해 실제 견적이 성공했고 주 버튼은 `approve-required`다. 기존 E2E 제어값 `sendTransactionError`를 `true`로 설정해 mock 지갑의 트랜잭션 전송이 code 4001(사용자 거부)로 실패한다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `approve-required` 주 버튼을 누르고 지갑 서명이 거부된다
     * @then `tx-status`가 `data-status="rejected"`다
     */
    test("[EC-1] approve 서명을 거부하면 거부 메시지가 보이고 체결이 없다", async ({ page }) => {
      // given: snapshot(beforeEach), USDC 잔액 절대값 주입, allowance < amountInRaw 확인, 클릭 전 allowance·USDC·DAI를 러너가 읽는다
      const before = await injectUsdcAndReadBefore();

      // given: 앱 연결, USDC→DAI 금액 입력, approve-required
      await enterUsdcToDaiUntilApproveRequired(page);

      // given: sendTransactionError = true (4001). 클릭 전 전송 요청 수를 기록한다
      await rejectWalletTransactions(page);
      const sendRequestsBefore = await readSendTransactionRequestCount(page);

      // when: approve-required를 누르고, mock 지갑이 전송 요청을 받아 거부할 때까지 기다린다
      await primaryButton(page).click();
      await waitForSendTransactionRequest(page, sendRequestsBefore);

      // then: tx-status가 rejected가 된다
      await expectTxStatus(page, { status: "rejected" }, TX_SETTLE_TIMEOUT_MS);

      // 전제 확인(계획 T-12 완료 조건. F5 EC-2와 같은 판정이라 @then에 두지 않는다): 체결이 없어 러너가 다시 읽은 allowance·USDC·DAI가 클릭 전 값 그대로다
      expect(await readAnvil()).toEqual(before);

      // 끝: afterEach가 snapshot으로 revert한다
    });

    /**
     * @spec EC-4
     * @given 선택 체인은 Ethereum(anvil 포크, 고정 블록)이고 mock 커넥터로 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡고 mock 계정에 보내는 토큰(USDC) 잔액을 절대값으로 주입했으며, 러너가 읽은 SwapRouter02 allowance는 `amountInRaw`보다 작다. 사용자가 USDC→DAI 금액을 입력해 실제 견적이 성공했고 주 버튼은 `approve-required`다. 기존 E2E 제어값 `sendTransactionError`에 code -32000인 Error 객체를 주입해 mock 지갑의 트랜잭션 전송이 그 오류로 실패한다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `approve-required` 주 버튼을 누르고 트랜잭션 전송이 -32000 오류로 실패한다
     * @then `tx-status`가 `data-status="send-failed"`다
     * @then 트랜잭션이 체결되지 않아 러너가 anvil에서 직접 읽은 SwapRouter02 allowance와 보내는 토큰·받는 토큰 잔액이 클릭 전 값 그대로다
     */
    test("[EC-4] approve 전송이 -32000 오류로 실패하면 전송 실패 메시지가 보이고 체결이 없다", async ({
      page,
    }) => {
      // given: snapshot(beforeEach), USDC 잔액 절대값 주입, allowance < amountInRaw 확인, 클릭 전 allowance·USDC·DAI를 러너가 읽는다
      const before = await injectUsdcAndReadBefore();

      // given: 앱 연결, USDC→DAI 금액 입력, approve-required
      await enterUsdcToDaiUntilApproveRequired(page);

      // given: sendTransactionError = code -32000인 Error 객체. 클릭 전 전송 요청 수를 기록한다
      await failWalletTransactionsWith(page, SEND_FAILED_ERROR);
      const sendRequestsBefore = await readSendTransactionRequestCount(page);

      // when: approve-required를 누르고, mock 지갑이 전송 요청을 받아 실패시킬 때까지 기다린다
      await primaryButton(page).click();
      await waitForSendTransactionRequest(page, sendRequestsBefore);

      // then: tx-status가 send-failed가 된다
      await expectTxStatus(page, { status: "send-failed" }, TX_SETTLE_TIMEOUT_MS);

      // then: 러너가 다시 읽은 allowance·USDC·DAI가 클릭 전 값 그대로다
      expect(await readAnvil()).toEqual(before);

      // 끝: afterEach가 snapshot으로 revert한다
    });
  });
});
