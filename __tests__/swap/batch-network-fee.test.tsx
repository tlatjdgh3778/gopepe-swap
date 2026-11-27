import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";

import {
  type AllowanceFn,
  type BalanceFn,
  type BalanceRpcRequest,
  type BalanceRpcStub,
  type NetworkFeeRule,
  STUB_MAX_UINT256,
  allowanceWhen,
  balancesWith,
  defaultAllowance,
  expectedStubUsdPrice,
  installBalanceRpcStub,
  matchAllowance,
  matchNetworkFee,
  matchUsdPrice,
  networkFeeRuleWith,
  parityQuoteRule,
  sameAddress,
  stubUsdMicros,
} from "../support/rpc-balance-stub";
import {
  type WalletCallsControl,
  type WalletCapabilitiesReply,
  atomicCapabilities,
  createStubEip1193,
  installWalletCalls,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  clearCookies,
  createNoopWagmiStorage,
  decodeApproveCalldata,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 계획 T-9. Vitest jsdom 통합 테스트(앱 전체 렌더).
// mock 허용 경계: T-6과 같은 것(실제 wagmi·Provider·화면, 스텁 EIP-1193(injected) 커넥터 지갑(wagmi mock 커넥터 아님), 전역 fetch URL 라우팅 스텁, 가짜 타이머,
// 지갑 `wallet_*` 세 메서드의 스텁 응답·오류·붙잡기, `vi.mock` 금지)에 F10 수수료 3분류 스텁(eth_estimateGas·eth_gasPrice·ETH 단가)을 더한다.
// `__tests__/support/*`는 고치지 않는다.
// 데이터 격리: 테스트마다 config·스텁·QueryClient를 새로 만들고 `clearCookies`.
// 공통 전제: 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며, 스텁은 eth_estimateGas·eth_gasPrice·ETH(WETH) 단가에 리터럴 값으로 성공 응답을 준다.
// 판정: 요소는 data-testid·접근성 role로 찾고 data 속성·요소 유무·요청 기록과 calldata 디코드로 판정한다(문구 판정 없음).
// 미검증: 지갑이 보여 줄 실제 배치 수수료는 증명하지 못한다(스펙 비목표).

// 기대값(주소·금액·gas·gasPrice)은 제품 config가 아니라 리터럴로 적는다. 기대 calldata는 하네스의 테스트 쪽 ERC-20 ABI로 디코드한다.
// 기대 심각도는 F10 규칙(DoD-22·23·25)을 스텁 단가로 테스트가 따로 계산한 값, 기대 ETH 부족은 F10 DoD-30·31(잔액 < feeWei)이다.
// 견적은 모든 티어가 수령량 = 입력 금액으로 응답한다(`parityQuoteRule`).

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const COMPARE_CASE_TIMEOUT_MS = 480_000;
const READY_TIMEOUT_MS = 10_000;

// 스펙 §4.1(F5) Ethereum SwapRouter02 주소(리터럴)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
// 공식 토큰 주소(리터럴)
const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETHEREUM_WETH: Address = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// 보내는 USDC·USDT(decimals 6) 금액 1 → amountInRaw 1_000_000. 부분 allowance 표본은 0 < 500_000 < 1_000_000
const AMOUNT = "1";
const AMOUNT_IN_RAW = 1_000_000n;
const PARTIAL_ALLOWANCE = 500_000n;
const MAX_UINT256 = 2n ** 256n - 1n;

// 공통 전제의 수수료 리터럴(gas·gasPrice)
const LITERAL_GAS = 51_001n;
const LITERAL_GAS_PRICE = 2_500_000_003n;

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

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다(config·스텁·QueryClient 새로 생성).
function resetSample() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearCookies();
  rpc = installBalanceRpcStub();
}

// ─── 수수료 규칙(테스트 쪽 리터럴) ──────────────────────────────────

// 모든 추정에 같은 gas, 가스 가격은 `gasPrice`로 성공 응답한다. feeWei = gas × gasPrice(Ethereum, F10 DoD-5).
function flatFeeRule(gas: bigint, gasPrice: bigint): NetworkFeeRule {
  return networkFeeRuleWith({
    estimateGas: () => ({ status: "ok", gas }),
    gasPrice: () => gasPrice,
  });
}

// ─── 화면 ─────────────────────────────────────────────────────────

type Side = "in" | "out";

function field(side: Side): HTMLElement {
  const found = screen
    .getAllByTestId("token-field")
    .find((element) => element.getAttribute("data-side") === side);
  if (!found) throw new Error(`token-field[data-side="${side}"]가 없다`);
  return found;
}

function amountInput(): HTMLInputElement {
  return within(field("in")).getByTestId("amount-input") as HTMLInputElement;
}

function primaryButton(): HTMLButtonElement {
  return screen.getByTestId("primary-button") as HTMLButtonElement;
}

function primaryState(): string | null {
  return primaryButton().getAttribute("data-state");
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

async function chooseToken(side: Side, address: Address) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  fireEvent.click(optionRow(address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
}

async function typeAmount(value: string) {
  fireEvent.change(amountInput(), { target: { value } });
  await waitUntil(() => expect(amountInput().value).toBe(value));
}

function networkFee(): HTMLElement | null {
  return screen.queryByTestId("network-fee");
}

// network-fee의 속성. 행이 없거나 속성이 없으면 null
function feeAttr(name: string): string | null {
  return networkFee()?.getAttribute(name) ?? null;
}

// network-fee 안의 testid 요소 유무
function hasInFee(testId: string): boolean {
  const fee = networkFee();
  return fee !== null && within(fee).queryByTestId(testId) !== null;
}

// 화면 전체의 testid 요소 유무
function hasOnScreen(testId: string): boolean {
  return screen.queryByTestId(testId) !== null;
}

async function waitFeeSuccess(label: string) {
  await waitUntil(() => expect(feeAttr("data-state"), label).toBe("success"), READY_TIMEOUT_MS);
  await settlePendingWork();
}

// ─── 렌더 ─────────────────────────────────────────────────────────

type RenderOptions = {
  capabilities: WalletCapabilitiesReply;
  allowance?: AllowanceFn;
  feeRule?: NetworkFeeRule;
  balances?: BalanceFn;
};

// 스텁 EIP-1193 지갑으로 Ethereum에 연결된 앱(지갑 체인 = 선택 체인 = Ethereum). 입력은 아직 하지 않는다.
async function renderConnected(options: RenderOptions): Promise<WalletCallsControl> {
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setAllowances(options.allowance ?? defaultAllowance);
  rpc.setNetworkFeeRule(options.feeRule ?? flatFeeRule(LITERAL_GAS, LITERAL_GAS_PRICE));
  if (options.balances) rpc.setBalances(options.balances);
  const stub = createStubEip1193({
    chainId: mainnet.id,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletCalls(stub);
  wallet.capabilities.reply(options.capabilities);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  renderAppHook(() => null, { config, initialChainId: mainnet.id });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(mainnet.id);
  }, READY_TIMEOUT_MS);
  return wallet;
}

// 보내는 토큰·받는 DAI·금액 `1`을 입력한다.
async function enterToDai(tokenIn: Address) {
  await chooseToken("in", tokenIn);
  await chooseToken("out", ETHEREUM_DAI);
  await typeAmount(AMOUNT);
}

function tokenAllowance(token: Address, value: bigint): AllowanceFn {
  return allowanceWhen(
    { chainId: mainnet.id, owner: TEST_ACCOUNT, spender: ETHEREUM_ROUTER, token },
    value,
  );
}

function allowanceReadDone(token: Address): boolean {
  return rpc
    .requests(
      matchAllowance.query({
        chainId: mainnet.id,
        owner: TEST_ACCOUNT,
        spender: ETHEREUM_ROUTER,
        token,
      }),
    )
    .some((request) => request.status === "ok");
}

// allowance 읽기와 연결 계정·체인 1의 capabilities 응답이 끝나고 주 버튼이 `state`가 되기를 기다린다.
async function waitReady(wallet: WalletCallsControl, token: Address, state: string, label: string) {
  await waitUntil(() => {
    expect(allowanceReadDone(token), `${label} allowance 읽기`).toBe(true);
    expect(
      wallet.capabilities.requestsFor(TEST_ACCOUNT, mainnet.id).some((r) => r.status === "ok"),
      `${label} capabilities 응답`,
    ).toBe(true);
    expect(primaryState(), label).toBe(state);
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
}

// ─── 요청 판독 ──────────────────────────────────────────────────────

function estimateCall(request: BalanceRpcRequest) {
  if (!request.estimateGas) throw new Error(`${request.seq}번 요청이 추정 요청이 아니다`);
  return request.estimateGas;
}

// to가 Ethereum SwapRouter02인 eth_estimateGas 요청(스왑 추정)
function swapEstimates(): BalanceRpcRequest[] {
  return rpc.requests(matchNetworkFee.estimateGas({ to: ETHEREUM_ROUTER }));
}

// 연결 계정의 ETH 잔액 요청이 응답을 받았는지
function ethBalanceAnswered(): boolean {
  return rpc
    .requests(
      (request) =>
        sameAddress(request.account, TEST_ACCOUNT) &&
        request.tokens.some((token) => sameAddress(token, NATIVE_ETH)) &&
        request.status === "ok",
    )
    .some(() => true);
}

// Ethereum ETH(WETH) 단가 요청이 나갔고 대기 중인 단가 요청이 없을 때까지 기다린다.
async function waitPricesSettled(label: string) {
  await waitUntil(() => {
    expect(
      rpc.requests(
        (request) => request.chainId === mainnet.id && matchUsdPrice.target(ETHEREUM_WETH)(request),
      ).length,
      `${label} ETH 단가 요청`,
    ).toBeGreaterThan(0);
    expect(
      rpc.requests((request) => matchUsdPrice.any(request) && request.status === "pending"),
      `${label} 대기 중 단가 요청`,
    ).toEqual([]);
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
}

// ─── 기대값(테스트 쪽 계산, F10 규칙) ─────────────────────────────

const BPS = 10_000n;
// F10 스펙 §4.3 NETWORK_FEE_WARNING_BPS
const WARNING_BPS = 500n;

// 보내는 USDC(ETH·WETH 아님)의 심각도: 수수료 USD micros ÷ 보내는 금액 USD micros가 500 bps 이상이면 warning(F10 DoD-22·23·25)
function expectedUsdcSeverity(feeWei: bigint): "normal" | "warning" {
  const ethPrice = expectedStubUsdPrice(rpc.usdPriceRule(), {
    chainId: mainnet.id,
    token: NATIVE_ETH,
    decimals: 18,
  });
  const usdcPrice = expectedStubUsdPrice(rpc.usdPriceRule(), {
    chainId: mainnet.id,
    token: ETHEREUM_USDC,
    decimals: 6,
  });
  expect(ethPrice.status, "ETH 단가").toBe("success");
  expect(usdcPrice.status, "USDC 단가").toBe("success");
  if (ethPrice.status !== "success" || usdcPrice.status !== "success")
    throw new Error("unreachable");
  const feeUsdMicros = stubUsdMicros(feeWei, ethPrice.price);
  const amountUsdMicros = stubUsdMicros(AMOUNT_IN_RAW, usdcPrice.price);
  expect(feeUsdMicros > 0n, "수수료 USD micros > 0").toBe(true);
  return feeUsdMicros * BPS >= amountUsdMicros * WARNING_BPS ? "warning" : "normal";
}

describe("배치 수수료 행 — 배치 실행을 앞둔 사용자가 승인 수수료와 스왑 수수료 안내를 본다", () => {
  describe("배치 실행 전 수수료 추정", () => {
    /**
     * @spec DoD-21
     * @given 공통 전제에서 capabilities가 `atomic.status = "supported"`이고 금액 `1`이다. 표본: 보내는 USDC(allowance 0)·받는 DAI(일반 토큰), 보내는 Ethereum USDT(0xdAC17F958D2ee523a2206206994597C13D831ec7, 0 초기화 대상)이고 0 < allowance < 보내는 금액·받는 DAI(USDT 부분 allowance)를 하나씩 반복한다
     * @when primary-button[data-state]가 `batch-ready`가 되고 수수료 추정이 끝나기를 기다린다
     * @then network-fee[data-kind]가 `approve`다
     * @then eth_estimateGas 요청 중 from이 연결 계정이고 to가 보내는 토큰 주소인 요청이 기록된다
     * @then 그 요청의 data를 디코드하면 일반 토큰 표본은 approve(체인 1 SwapRouter02 주소, maxUint256), USDT 부분 allowance 표본은 approve(체인 1 SwapRouter02 주소, 0)이다
     */
    it(
      "[DoD-21] batch-ready의 수수료는 approve 종류이고 승인 필요 상태와 같은 approve 요청으로 추정한다",
      async () => {
        const samples = [
          {
            label: "USDC allowance 0",
            token: ETHEREUM_USDC,
            allowance: defaultAllowance,
            expectedApprove: MAX_UINT256,
          },
          {
            label: "USDT 부분 allowance",
            token: ETHEREUM_USDT,
            allowance: tokenAllowance(ETHEREUM_USDT, PARTIAL_ALLOWANCE),
            expectedApprove: 0n,
          },
        ];
        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          const wallet = await renderConnected({
            capabilities: atomicCapabilities({ [mainnet.id]: "supported" }),
            allowance: sample.allowance,
          });
          await enterToDai(sample.token);
          await waitReady(wallet, sample.token, "batch-ready", label);
          await waitFeeSuccess(label);

          expect(primaryState(), label).toBe("batch-ready");
          expect(feeAttr("data-kind"), label).toBe("approve");

          const approveEstimates = rpc
            .requests(matchNetworkFee.estimateGas({ to: sample.token, from: TEST_ACCOUNT }))
            .filter((request) => request.status === "ok");
          expect(approveEstimates.length, `${label} approve 추정`).toBeGreaterThan(0);
          for (const request of approveEstimates) {
            const call = estimateCall(request);
            expect(call.data, `${label} data`).toBeDefined();
            const decoded = decodeApproveCalldata(call.data!);
            expect(sameAddress(decoded.spender, ETHEREUM_ROUTER), `${label} spender`).toBe(true);
            expect(decoded.amount, `${label} amount`).toBe(sample.expectedApprove);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-25
     * @given 공통 전제에서 capabilities가 `atomic.status = "supported"`이고 보내는 USDC·받는 DAI·금액 `1`이다. 표본: allowance 0(`batch-ready`), 양성 대조로 allowance가 보내는 금액 이상(`swap-ready`)을 하나씩 반복한다
     * @when primary-button[data-state]가 표본 상태가 되고 network-fee[data-state]가 `success`가 되기를 기다린다
     * @then `batch-ready` 표본에서 to가 체인 1 SwapRouter02 주소인 eth_estimateGas 요청이 0건이다
     * @then 양성 대조(`swap-ready`) 표본에서 to가 체인 1 SwapRouter02 주소인 eth_estimateGas 요청이 1건 이상 기록된다
     * @then 양성 대조(`swap-ready`) 표본에서 network-fee-batch-note가 없다
     */
    it(
      "[DoD-25] batch-ready에서는 스왑 eth_estimateGas를 보내지 않는다",
      async () => {
        const samples = [
          { label: "allowance 0", allowance: defaultAllowance, state: "batch-ready" },
          {
            label: "양성 대조 allowance 충분",
            allowance: tokenAllowance(ETHEREUM_USDC, STUB_MAX_UINT256),
            state: "swap-ready",
          },
        ] as const;
        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          const wallet = await renderConnected({
            capabilities: atomicCapabilities({ [mainnet.id]: "supported" }),
            allowance: sample.allowance,
          });
          await enterToDai(ETHEREUM_USDC);
          await waitReady(wallet, ETHEREUM_USDC, sample.state, label);
          await waitFeeSuccess(label);
          await waitUntil(
            () =>
              expect(
                rpc.requests(matchNetworkFee.any).every((request) => request.status !== "pending"),
                `${label} 대기 중 수수료 요청`,
              ).toBe(true),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(primaryState(), label).toBe(sample.state);
          if (sample.state === "batch-ready") {
            expect(swapEstimates(), label).toHaveLength(0);
          } else {
            expect(swapEstimates().length, label).toBeGreaterThanOrEqual(1);
            expect(hasOnScreen("network-fee-batch-note"), label).toBe(false);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("수수료 행의 안내 줄", () => {
    /**
     * @spec DoD-22 DoD-23
     * @given 공통 전제에서 capabilities가 `atomic.status = "supported"`이고 보내는 USDC(allowance 0)·받는 DAI·금액 `1`이다
     * @when primary-button[data-state]가 `batch-ready`가 되고 network-fee[data-state]가 `success`가 되기를 기다린다
     * @then network-fee 안에 network-fee-batch-note가 있다
     * @then network-fee-swap-pending이 없다
     */
    it(
      "[DoD-22][DoD-23] batch-ready에서는 배치 안내 줄이 있고 스왑 수수료 대기 줄이 없다",
      async () => {
        const label = "batch-ready";
        const wallet = await renderConnected({
          capabilities: atomicCapabilities({ [mainnet.id]: "supported" }),
        });
        await enterToDai(ETHEREUM_USDC);
        await waitReady(wallet, ETHEREUM_USDC, "batch-ready", label);
        await waitFeeSuccess(label);

        expect(primaryState(), label).toBe("batch-ready");
        expect(hasInFee("network-fee-batch-note"), label).toBe(true);
        expect(hasOnScreen("network-fee-swap-pending"), label).toBe(false);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("경고와 ETH 부족 안내", () => {
    /**
     * @spec DoD-24
     * @given 공통 전제에서 보내는 USDC(allowance 0)·받는 DAI·금액 `1`이고 같은 eth_estimateGas·eth_gasPrice·ETH 단가·ETH 잔액 응답을 두 지갑 조건에 준다: capabilities `atomic.status = "supported"`(`batch-ready`), `atomic.status = "unsupported"`(`approve-required`). 표본 수수료(approve feeWei의 USD ÷ 보내는 금액 USD): 500 bps 이상, 500 bps 미만 × 표본 ETH 잔액: approve feeWei보다 작음, approve feeWei 이상을 하나씩 반복한다
     * @when 각 지갑 조건에서 primary-button[data-state]가 해당 상태가 되고 network-fee[data-state]가 `success`가 되기를 기다린다
     * @then `batch-ready`의 network-fee[data-severity]가 같은 표본의 `approve-required` 값과 같고, F10 규칙으로 테스트가 계산한 값(500 bps 이상 `warning`, 미만 `normal`)과 같다
     * @then `batch-ready`의 network-fee-warning 유무가 같은 표본의 `approve-required`와 같다
     * @then `batch-ready`의 network-fee-eth-shortage 유무가 같은 표본의 `approve-required`와 같고, ETH 잔액 < approve feeWei 표본에만 있다
     * @then `approve-required` 표본에서 network-fee-batch-note가 없고 network-fee-swap-pending이 있다
     */
    it(
      "[DoD-24] batch-ready의 경고와 ETH 부족 안내는 approve 수수료에 F10 규칙을 적용한 결과와 같다",
      async () => {
        // feeWei = FEE_GAS × gasPrice. 기본 단가 규칙에서 보내는 금액 1 USDC 대비 warning 표본은 500 bps 이상,
        // normal 표본은 500 bps 미만이다(아래에서 테스트 계산으로 전제를 확인한다).
        const FEE_GAS = 100_000n;
        const fees = [
          { target: "warning", gasPrice: 9n },
          { target: "normal", gasPrice: 2n },
        ] as const;
        const balances = ["short", "enough"] as const;
        const conditions = [
          { status: "supported", state: "batch-ready" },
          { status: "unsupported", state: "approve-required" },
        ] as const;

        type Observed = {
          severity: string | null;
          warning: boolean;
          shortage: boolean;
          batchNote: boolean;
          swapPending: boolean;
        };

        let runIndex = 0;
        for (const fee of fees) {
          for (const balance of balances) {
            const feeWei = FEE_GAS * fee.gasPrice;
            const ethBalance = balance === "short" ? feeWei / 2n : feeWei;
            const expectedShortage = ethBalance < feeWei;
            const sampleLabel = `${fee.target} × ETH 잔액 ${balance}`;
            const observed: Partial<Record<(typeof conditions)[number]["state"], Observed>> = {};

            for (const condition of conditions) {
              if (runIndex > 0) resetSample();
              runIndex += 1;
              const label = `${sampleLabel} × ${condition.state}`;
              const wallet = await renderConnected({
                capabilities: atomicCapabilities({ [mainnet.id]: condition.status }),
                feeRule: flatFeeRule(FEE_GAS, fee.gasPrice),
                balances: balancesWith({ [NATIVE_ETH]: ethBalance }),
              });
              // 전제: 테스트 계산(F10 규칙)으로 표본의 심각도가 target이다.
              const expectedSeverity = expectedUsdcSeverity(feeWei);
              expect(expectedSeverity, label).toBe(fee.target);

              await enterToDai(ETHEREUM_USDC);
              await waitReady(wallet, ETHEREUM_USDC, condition.state, label);
              await waitFeeSuccess(label);
              await waitUntil(
                () => expect(ethBalanceAnswered(), `${label} ETH 잔액`).toBe(true),
                READY_TIMEOUT_MS,
              );
              await waitPricesSettled(label);
              // 전제: 표시한 feeWei가 테스트 계산값이다.
              expect(feeAttr("data-fee-wei"), label).toBe(feeWei.toString());
              expect(feeAttr("data-kind"), label).toBe("approve");
              await waitUntil(() => {
                expect(feeAttr("data-severity"), label).toBe(expectedSeverity);
                expect(hasOnScreen("network-fee-eth-shortage"), label).toBe(expectedShortage);
              }, READY_TIMEOUT_MS);
              await settlePendingWork();

              expect(primaryState(), label).toBe(condition.state);
              observed[condition.state] = {
                severity: feeAttr("data-severity"),
                warning: hasOnScreen("network-fee-warning"),
                shortage: hasOnScreen("network-fee-eth-shortage"),
                batchNote: hasOnScreen("network-fee-batch-note"),
                swapPending: hasOnScreen("network-fee-swap-pending"),
              };
            }

            const batch = observed["batch-ready"];
            const approve = observed["approve-required"];
            if (!batch || !approve) throw new Error(`${sampleLabel} 관측값이 없다`);

            expect(batch.severity, sampleLabel).toBe(approve.severity);
            expect(batch.severity, sampleLabel).toBe(fee.target);
            expect(batch.warning, sampleLabel).toBe(approve.warning);
            expect(batch.shortage, sampleLabel).toBe(approve.shortage);
            expect(batch.shortage, sampleLabel).toBe(expectedShortage);
            expect(approve.batchNote, sampleLabel).toBe(false);
            expect(approve.swapPending, sampleLabel).toBe(true);
          }
        }
      },
      COMPARE_CASE_TIMEOUT_MS,
    );
  });
});
