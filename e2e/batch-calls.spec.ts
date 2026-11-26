import type { Address } from "viem";

import { expect, test } from "@playwright/test";
import { mainnet } from "viem/chains";

import { E2E_MOCK_ACCOUNT } from "../config/e2e-mock";
import { NATIVE_ETH_ADDRESS, TOKENS_BY_CHAIN } from "../config/tokens";
import {
  ANVIL_WARM_UP_TIMEOUT_MS,
  QUOTE_WARM_UP_TIMEOUT_MS,
  approveWarmUpRequest,
  readErc20Allowance,
  readErc20Balance,
  revertAnvilSnapshot,
  setErc20Balance,
  takeAnvilSnapshot,
  warmUpEstimateGas,
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
  countWalletSendRequestsSince,
  enableAtomicBatch,
  expectBatchTxStatus,
  expectEnabledBatchReady,
  readWalletRequestCount,
  setBatchDelegation,
} from "./support/batch-calls";

// F11 batch-calls E2E(T-13).
// 경계: mock 커넥터 + `config/e2e-mock.ts` 배치 opt-in 제어값(테스트가 켤 때만) + 러너→anvil 준비
// (잔액 주입, snapshot/revert, 7702 위임 표식). `page.route`는 쓰지 않는다. 배치 실행 방식은 계획 T-1 (a)에서 A2로 확정됐다.
// 미검증: 실제 지갑의 확인 UI·위임 컨트랙트·WAF는 증명하지 못한다.
// 격리: 테스트별 브라우저 컨텍스트, 테스트마다 snapshot을 잡고 끝에 revert, `workers: 1`. Ethereum만.

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

const SNAPSHOT_ERC20_ADDRESSES = TOKENS_BY_CHAIN[mainnet.id]
  .map((token) => token.address)
  .filter((address) => address.toLowerCase() !== NATIVE_ETH_ADDRESS.toLowerCase());

test.describe("배치 실행 — 배치를 지원하는 지갑에서 ERC-20 입력 스왑을 지갑 요청 한 번으로 체결한다", () => {
  // 러너가 포크를 미리 데운다(판정에 쓰지 않음). 모달의 토큰 잔액 일괄 읽기, USDC→DAI 표본 금액의 견적 경로,
  // `batch-ready` 수수료 행의 approve 추정 경로를 올려 두어 앱 요청이 프록시 상류 시간 제한(5초) 안에 끝나게 한다.
  test.beforeAll(async () => {
    test.setTimeout(ANVIL_WARM_UP_TIMEOUT_MS + 2 * QUOTE_WARM_UP_TIMEOUT_MS);
    await warmUpTokenBalances(E2E_MOCK_ACCOUNT, SNAPSHOT_ERC20_ADDRESSES);
    await warmUpSwapQuote(USDC, DAI, AMOUNT_IN_RAW);
    await warmUpEstimateGas(
      E2E_MOCK_ACCOUNT,
      approveWarmUpRequest(USDC, SWAP_ROUTER_02, AMOUNT_IN_RAW),
    );
  });

  // 쓰기 테스트마다 anvil 상태를 새로 잡고 끝에 되돌린다. revert로 USDC 잔액·allowance·DAI 잔액과
  // mock 계정의 위임 표식(Simple7702Account → 포크 블록의 기존 위임)이 원복되므로 revert 결과(`true`)를 단정한다.
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

  test.describe("batch-ready 한 번 클릭으로 체결", () => {
    /**
     * @spec DoD-27 DoD-28 DoD-29
     * @given 선택 체인은 Ethereum(anvil 포크)이고, 배치 지원(체인 1 `atomic.status = "supported"`)을 켠 mock 지갑이 연결되어 있다. 러너가 anvil 상태를 snapshot으로 잡고 mock 계정에 7702 배치 실행 컨트랙트 위임 표식을 두고 보내는 ERC-20 토큰 잔액을 준비했으며, 사용자가 ERC-20 입력 스왑(보내는 토큰과 받는 토큰이 모두 ERC-20)의 금액을 입력해 주 버튼이 `batch-ready`다. 테스트 끝에 snapshot으로 revert한다
     * @when 사용자가 `batch-ready` 주 버튼을 한 번 누른다
     * @then `tx-status`가 `success`·`batch`가 된다
     * @then 러너가 anvil에서 읽은 보내는 토큰 잔액은 클릭 전보다 줄고 받는 토큰 잔액은 클릭 전보다 늘었다
     * @then 클릭 뒤 앱이 보낸 지갑 전송 요청은 `wallet_sendCalls` 1건이고 `eth_sendTransaction`·`wallet_sendTransaction`은 0건이다
     */
    test("[DoD-27][DoD-28][DoD-29] batch-ready를 한 번 누르면 배치로 체결되고 잔액이 바뀌며 지갑 전송 요청은 wallet_sendCalls 1건이다", async ({
      page,
    }) => {
      // given: snapshot은 beforeEach가 잡았다. 러너가 mock 계정에 Simple7702Account 위임 표식을 anvil_setCode로 두고 코드를 단정한다
      //        (표식이 없으면 포크 블록의 기존 위임이 executeBatch 자기 호출을 삼켜 잔액이 바뀌지 않는다)
      await setBatchDelegation(E2E_MOCK_ACCOUNT);

      // given: 러너가 USDC 잔액을 절대값으로 주입하고 클릭 전 USDC·DAI 잔액과 SwapRouter02 allowance를 읽는다.
      //        allowance가 보내는 금액보다 작아야 F5 규칙상 approve-required → 배치 가능 지갑에서 batch-ready다
      await setErc20Balance(E2E_MOCK_ACCOUNT, USDC, USDC_BALANCE_RAW);
      const [usdcBefore, daiBefore, allowanceBefore] = await Promise.all([
        readErc20Balance(E2E_MOCK_ACCOUNT, USDC),
        readErc20Balance(E2E_MOCK_ACCOUNT, DAI),
        readErc20Allowance(E2E_MOCK_ACCOUNT, USDC, SWAP_ROUTER_02),
      ]);
      expect(usdcBefore, "주입한 USDC 잔액").toBe(USDC_BALANCE_RAW);
      expect(allowanceBefore < AMOUNT_IN_RAW, "SwapRouter02 allowance < amountInRaw").toBe(true);

      // given: 앱 로드(연결) 전에 mock 지갑의 배치 opt-in을 켠다. 켜면 래퍼가 체인 1 atomic supported를 보고하고,
      //        wallet_sendCalls를 executeBatch 자기 호출 1건으로 보내며, wallet_getCallsStatus를 그 receipt로 응답한다
      await enableAtomicBatch(page);

      // given: 앱을 열고 mock 커넥터로 연결해 USDC→DAI 금액을 입력한다. 견적·allowance·capabilities 읽기 뒤 batch-ready다
      await enterErc20Swap(page, {
        tokenIn: USDC,
        tokenOut: DAI,
        amountInRaw: AMOUNT_IN_RAW,
        decimalsIn: USDC_DECIMALS,
      });
      await expectEnabledBatchReady(page, ALLOWANCE_SETTLE_TIMEOUT_MS);

      // when: 클릭 직전 지갑 요청 기록 길이를 잡고 batch-ready 주 버튼을 한 번 누른다
      const requestCountBeforeClick = await readWalletRequestCount(page);
      await primaryButton(page).click();

      // then(DoD-27): tx-status가 data-kind=batch, data-status=success가 된다
      await expectBatchTxStatus(page, "success", TX_SETTLE_TIMEOUT_MS);

      // then(DoD-28): 러너가 anvil에서 직접 다시 읽은 USDC 잔액은 줄고 DAI 잔액은 늘었다
      const [usdcAfter, daiAfter] = await Promise.all([
        readErc20Balance(E2E_MOCK_ACCOUNT, USDC),
        readErc20Balance(E2E_MOCK_ACCOUNT, DAI),
      ]);
      expect(usdcAfter < usdcBefore, `USDC 잔액 감소 (전 ${usdcBefore}, 후 ${usdcAfter})`).toBe(
        true,
      );
      expect(daiAfter > daiBefore, `DAI 잔액 증가 (전 ${daiBefore}, 후 ${daiAfter})`).toBe(true);

      // then(DoD-29): 클릭 뒤 앱이 보낸 지갑 요청(walletRequests, 래퍼 내부 전송은 기록되지 않음)에서
      //       wallet_sendCalls 1건, eth_sendTransaction·wallet_sendTransaction 0건이다
      expect(
        await countWalletSendRequestsSince(page, requestCountBeforeClick),
        "클릭 뒤 지갑 전송 요청 수",
      ).toEqual({ walletSendCalls: 1, ethSendTransaction: 0, walletSendTransaction: 0 });

      // 정리: afterEach가 snapshot으로 revert한다
    });
  });
});
