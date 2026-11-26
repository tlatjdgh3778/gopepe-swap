import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { type Address, type Hex, decodeFunctionData } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useAmountOutMinimum } from "@/hooks/use-amount-out-minimum";
import { buildSwapTransactionRequest } from "@/lib/swap-transaction";
import { useSwapExecution } from "@/providers/swap-execution-provider";
import { useSwapForm } from "@/providers/swap-form-provider";
import { useSwapQuote } from "@/providers/swap-quote-provider";

import {
  type AllowanceFn,
  type BalanceRpcStub,
  allowanceWhen,
  defaultAllowance,
  installBalanceRpcStub,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  ATOMIC_READY_UPGRADE_REJECTED_CODE,
  BUNDLE_TOO_LARGE_CODE,
  type ChainSwitchControl,
  DUPLICATE_ID_CODE,
  METHOD_NOT_FOUND_RPC_CODE,
  RPC_INTERNAL_ERROR_CODE,
  RPC_INVALID_INPUT_CODE,
  SEND_TRANSACTION_METHODS,
  type StubEip1193,
  UNSUPPORTED_METHOD_RPC_CODE,
  UNSUPPORTED_NON_OPTIONAL_CAPABILITY_CODE,
  USER_REJECTED_CODE,
  type WalletCallsControl,
  type WalletCallsErrorReply,
  type WalletCapabilitiesReply,
  atomicCapabilities,
  createStubEip1193,
  installChainSwitch,
  installWalletCalls,
  providerRpcError,
} from "../support/stub-eip1193";
import {
  STUB_SWAP_ROUTER02_ETH_ABI,
  TEST_ACCOUNT,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  decodeApproveCalldata,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격: 계획 T-7. Vitest jsdom 통합 테스트(앱 전체 렌더).
// mock 허용 경계: T-6과 같다. 실제 wagmi·Provider·화면, 스텁 EIP-1193(injected) 커넥터 지갑(wagmi mock 커넥터 아님), 전역 fetch URL 라우팅 스텁, 가짜 타이머,
// 지갑 `wallet_*` 세 메서드의 스텁 응답·오류·붙잡기. `vi.mock` 금지. `__tests__/support/*`는 고치지 않는다.
// 데이터 격리: 테스트마다 config·스텁·QueryClient를 새로 만들고 `clearCookies`.
// 판정: 요소는 data-testid·접근성 role로 찾고 data 속성·`useSwapExecution().result`·지갑 요청 기록과 calldata 디코드로 판정한다(문구 판정 없음).
// 미검증: 실제 지갑의 오류 형태(code·cause 구조)와 실제 지갑의 capabilities 형태는 스텁으로 증명하지 못한다.

// 이 파일에서 "wallet_sendCalls 요청"은 스텁 EIP-1193 지갑의 요청 기록(`stub.requests`) 중 `wallet_sendCalls` 항목이고,
// 그 params는 `installWalletCalls`의 `sendCalls.sent`로 읽는다. "전송 요청"은 `eth_sendTransaction`·`wallet_sendTransaction` 항목이다.
// calldata는 테스트 쪽 ABI 리터럴(하네스의 `decodeApproveCalldata`·`STUB_SWAP_ROUTER02_ETH_ABI`)로 디코드한다.
// swap 항목의 기대값은 클릭 직전 앱 상태(useSwapForm·useSwapQuote·useAmountOutMinimum)로 `buildSwapTransactionRequest`를 불러 만들고,
// deadline 인자는 비교에서 뺀다. 주소는 리터럴로 적는다. 견적은 모든 티어가 수령량 = 입력 금액으로 응답한다(`parityQuoteRule`).

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 10_000;

const MAX_UINT256 = 2n ** 256n - 1n;

// 스펙 §4.1(F5) SwapRouter02 주소(리터럴)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
// 공식 토큰 주소(리터럴)
const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const ARBITRUM_USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const ARBITRUM_DAI: Address = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1";

// 보내는 토큰(decimals 6) 금액 1 → amountInRaw 1_000_000. 부분 allowance 표본은 0 < 500_000 < 1_000_000
const AMOUNT = "1";
const PARTIAL_ALLOWANCE = 500_000n;

const SEND_CALLS_METHODS = ["wallet_sendCalls"];
const CHAIN_SWITCH_METHOD = "wallet_switchEthereumChain";

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

function txStatus(): HTMLElement {
  return screen.getByTestId("tx-status");
}

function networkFee(): HTMLElement | null {
  return screen.queryByTestId("network-fee");
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

async function enterPair(tokenIn: Address, tokenOut: Address, amount = AMOUNT) {
  await chooseToken("in", tokenIn);
  await chooseToken("out", tokenOut);
  await typeAmount(amount);
}

function clickPrimary() {
  fireEvent.click(primaryButton());
}

function expectSameAddress(actual: string | undefined, expected: Address, label: string) {
  expect(actual?.toLowerCase(), label).toBe(expected.toLowerCase());
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return {
    execution: useSwapExecution(),
    form: useSwapForm(),
    quote: useSwapQuote(),
    minimum: useAmountOutMinimum(),
  };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletCallsControl;
  chainSwitch: ChainSwitchControl;
  probe: () => Probe;
};

type RenderOptions = {
  // 지갑 체인(기본 Ethereum)
  walletChainId?: SupportedChainId;
  // 처음 선택 체인(기본 지갑 체인)
  initialChainId?: SupportedChainId;
  capabilities?: WalletCapabilitiesReply;
  allowance?: AllowanceFn;
};

const ETHEREUM_SUPPORTED = atomicCapabilities({ [mainnet.id]: "supported" });

// 스텁 EIP-1193 지갑으로 연결된 앱. 입력은 아직 하지 않는다.
async function renderConnected(options: RenderOptions = {}): Promise<Scenario> {
  const walletChainId = options.walletChainId ?? mainnet.id;
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setAllowances(options.allowance ?? defaultAllowance);
  const stub = createStubEip1193({
    chainId: walletChainId,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletCalls(stub);
  wallet.capabilities.reply(options.capabilities ?? ETHEREUM_SUPPORTED);
  const chainSwitch = installChainSwitch(stub);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, {
    config,
    initialChainId: options.initialChainId ?? walletChainId,
  });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(walletChainId);
  }, READY_TIMEOUT_MS);
  return { stub, wallet, chainSwitch, probe: () => view.result.current };
}

async function waitForBatchReady(label = "") {
  await waitUntil(() => expect(primaryState(), label).toBe("batch-ready"), READY_TIMEOUT_MS);
  await settlePendingWork();
  expect(primaryState(), label).toBe("batch-ready");
}

// Ethereum 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 `batch-ready`인 앱
async function renderUsdcBatchReady(options: RenderOptions = {}): Promise<Scenario> {
  const s = await renderConnected(options);
  await enterPair(ETHEREUM_USDC, ETHEREUM_DAI);
  await waitForBatchReady();
  return s;
}

function noPendingRpc() {
  expect(rpc.requests().every((request) => request.status !== "pending")).toBe(true);
}

// 결과가 기록되고 phase가 idle로 돌아가며 그로 생긴 읽기가 끝나기를 기다린다.
async function waitForResult(s: Scenario, label = "") {
  await waitUntil(() => {
    expect(s.probe().execution.result, label).not.toBeNull();
    expect(s.probe().execution.phase, label).toBe("idle");
  }, READY_TIMEOUT_MS);
  await waitUntil(noPendingRpc, READY_TIMEOUT_MS);
  await settlePendingWork();
}

function sendCallsSince(s: Scenario, from: number) {
  return requestsSince(s.stub, from, SEND_CALLS_METHODS);
}

function sendTransactionsSince(s: Scenario, from: number) {
  return requestsSince(s.stub, from, SEND_TRANSACTION_METHODS);
}

// ─── swap 항목 기대값 ───────────────────────────────────────────────

type ExpectedSwap = ReturnType<typeof buildSwapTransactionRequest>;

// 클릭 직전 앱 상태로 만든 swap 트랜잭션 요청(deadline은 비교에서 빼므로 0)
function expectedSwapAt(s: Scenario): ExpectedSwap {
  const { form, quote, minimum } = s.probe();
  if (!form.tokenIn || !form.tokenOut || form.amountInRaw === null) {
    throw new Error("입력이 완성되지 않았다");
  }
  if (quote.status !== "success" || minimum === null) throw new Error("견적이 success가 아니다");
  return buildSwapTransactionRequest({
    chainId: form.chainId,
    tokenIn: form.tokenIn,
    tokenOut: form.tokenOut,
    fee: quote.quote.fee,
    account: TEST_ACCOUNT,
    amountInRaw: form.amountInRaw,
    amountOutMinimum: minimum,
    deadline: 0n,
  });
}

function hexValue(value: Hex | undefined): bigint | undefined {
  return value === undefined ? undefined : BigInt(value);
}

// swap 항목이 기대 요청과 deadline 인자만 빼고 같다.
function expectSwapCall(
  call: { to: Address | undefined; data: Hex | undefined; value: Hex | undefined },
  expected: ExpectedSwap,
  label: string,
) {
  expectSameAddress(call.to, expected.to, `${label} swap to`);
  expect(hexValue(call.value), `${label} swap value`).toEqual(expected.value);
  if (!call.data) throw new Error(`${label} swap data가 없다`);
  const decoded = decodeFunctionData({ abi: STUB_SWAP_ROUTER02_ETH_ABI, data: call.data });
  expect(decoded.functionName, `${label} swap 함수`).toBe("multicall");
  const [, inner] = decoded.args as readonly [bigint, readonly Hex[]];
  expect(
    inner.map((data) => data.toLowerCase()),
    `${label} multicall data[]`,
  ).toEqual(expected.args[1].map((data) => data.toLowerCase()));
}

function expectApproveCall(
  call: { to: Address | undefined; data: Hex | undefined; value: Hex | undefined },
  token: Address,
  amount: bigint,
  label: string,
) {
  expectSameAddress(call.to, token, `${label} approve to`);
  if (!call.data) throw new Error(`${label} approve data가 없다`);
  const decoded = decodeApproveCalldata(call.data);
  expectSameAddress(decoded.spender, ETHEREUM_ROUTER, `${label} approve spender`);
  expect(decoded.amount, `${label} approve amount`).toBe(amount);
  expect(hexValue(call.value) ?? 0n, `${label} approve value`).toBe(0n);
}

// EIP-5792 배치 미지원 분류(EC-7) code
const UNSUPPORTED_CODES = [
  METHOD_NOT_FOUND_RPC_CODE,
  UNSUPPORTED_METHOD_RPC_CODE,
  UNSUPPORTED_NON_OPTIONAL_CAPABILITY_CODE,
  BUNDLE_TOO_LARGE_CODE,
  ATOMIC_READY_UPGRADE_REJECTED_CODE,
] as const;

// 배치 미지원 code로 실패시킨다.
async function failBatchWith(s: Scenario, reply: WalletCallsErrorReply, label: string) {
  s.wallet.sendCalls.reply(reply);
  clickPrimary();
  await waitUntil(
    () => expect(s.wallet.sendCalls.sent.length, label).toBeGreaterThan(0),
    READY_TIMEOUT_MS,
  );
  await waitForResult(s, label);
  expect(
    s.wallet.sendCalls.sent.map((record) => record.errorCode),
    `${label} 전제: 지갑이 표본 오류로 응답`,
  ).toEqual([reply.code]);
}

// 보내는 토큰의 Ethereum SwapRouter02 allowance만 `value`, 나머지는 0으로 응답하는 규칙
function routerAllowance(token: Address, value: bigint): AllowanceFn {
  return allowanceWhen(
    { chainId: mainnet.id, owner: TEST_ACCOUNT, spender: ETHEREUM_ROUTER, token },
    value,
  );
}

// 지갑은 Arbitrum, 선택 체인은 드롭다운으로 바꾼 Ethereum이고 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 `batch-ready`인 앱
async function renderArbitrumWalletBatchReady(): Promise<Scenario> {
  const s = await renderConnected({ walletChainId: arbitrum.id, initialChainId: arbitrum.id });
  await chooseChainFromDropdown(mainnet);
  await enterPair(ETHEREUM_USDC, ETHEREUM_DAI);
  await waitForBatchReady();
  expect(s.stub.chainId, "전제: 지갑 체인은 Arbitrum").toBe(arbitrum.id);
  return s;
}

async function expectChainSwitchFailure(code: number, status: "rejected" | "chain-switch-failed") {
  const s = await renderArbitrumWalletBatchReady();
  s.chainSwitch.reply({ type: "error", code });
  const from = s.stub.requests.length;

  clickPrimary();
  await waitUntil(
    () =>
      expect(
        requestsSince(s.stub, from, [CHAIN_SWITCH_METHOD]).length,
        "전제: 체인 전환 요청",
      ).toBeGreaterThan(0),
    READY_TIMEOUT_MS,
  );
  await waitForResult(s, status);

  expect(s.probe().execution.result?.status).toBe(status);
  expect(txStatus().getAttribute("data-status")).toBe(status);
  expect(s.probe().execution.result?.kind).toBe("batch");
  expect(txStatus().getAttribute("data-kind")).toBe("batch");
  expect(sendCallsSince(s, from)).toEqual([]);
  expect(s.wallet.sendCalls.sent).toEqual([]);
}

// Ethereum·같은 계정에서 강등된 상태: 주 버튼 approve-required, 수수료 행 success에서 배치 안내 줄 없음·스왑 대기 줄 있음
async function expectDowngradedOnEthereum(label: string) {
  await waitUntil(() => {
    expect(primaryState(), label).toBe("approve-required");
    expect(networkFee()?.getAttribute("data-state"), label).toBe("success");
    noPendingRpc();
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
  expect(primaryState(), label).toBe("approve-required");
  expect(networkFee()?.getAttribute("data-state"), label).toBe("success");
  expect(screen.queryByTestId("network-fee-batch-note"), `${label} batch-note`).toBeNull();
  expect(screen.queryByTestId("network-fee-swap-pending"), `${label} swap-pending`).not.toBeNull();
}

describe("배치 전송 — 사용자가 주 버튼 한 번으로 승인과 스왑을 지갑 요청 하나로 보낸다", () => {
  describe("배치 요청의 내용", () => {
    /**
     * @spec DoD-7 DoD-9 DoD-10
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities가 `atomic.status = "supported"`, 스텁은 wallet_sendCalls에 배치 id로 응답한다. 표본 입력(0 초기화 대상이 아닌 보내는 토큰, 금액 `1`): 보내는 USDC(allowance 0)·받는 DAI, 보내는 USDC(0 < allowance < 보내는 금액)·받는 DAI, 보내는 USDC(allowance 0)·받는 ETH(unwrapWETH9 경로)를 하나씩 반복하고, 0 초기화 대상이지만 allowance가 0인 보내는 Ethereum USDT(0xdAC17F958D2ee523a2206206994597C13D831ec7, allowance 0)·받는 DAI를 더한다
     * @when primary-button[data-state]가 `batch-ready`가 되면 주 버튼을 한 번 누르고 wallet_sendCalls 요청이 기록되기를 기다린다
     * @then wallet_sendCalls 요청이 1건이고 from은 연결 계정이다
     * @then calls가 2개이고 calls[0]은 to가 보내는 토큰 주소, data를 디코드하면 approve(체인 1 SwapRouter02 주소, maxUint256)이며 value가 없거나 0이다
     * @then calls[1]은 to·value가 같은 시점 입력으로 만든 buildSwapTransactionRequest 결과와 같고, data를 디코드하면 multicall(deadline, data[])이며 data[]가 그 결과의 calldata와 deadline 인자만 빼고 같다
     * @then wallet_sendCalls 요청은 원자 실행을 요구한다(`atomicRequired: true`)
     * @then 클릭 뒤 eth_sendTransaction·wallet_sendTransaction 요청이 0건이다
     */
    it(
      "[DoD-7][DoD-9][DoD-10] wallet_sendCalls 한 번에 approve(max)·multicall 순서로 원자 실행을 요구하고 eth_sendTransaction은 보내지 않는다",
      async () => {
        const samples: {
          label: string;
          tokenIn: Address;
          tokenOut: Address;
          allowance: AllowanceFn;
        }[] = [
          {
            label: "USDC(allowance 0) → DAI",
            tokenIn: ETHEREUM_USDC,
            tokenOut: ETHEREUM_DAI,
            allowance: defaultAllowance,
          },
          {
            label: "USDC(0 < allowance < 금액) → DAI",
            tokenIn: ETHEREUM_USDC,
            tokenOut: ETHEREUM_DAI,
            allowance: routerAllowance(ETHEREUM_USDC, PARTIAL_ALLOWANCE),
          },
          {
            label: "USDC(allowance 0) → ETH",
            tokenIn: ETHEREUM_USDC,
            tokenOut: NATIVE_ETH,
            allowance: defaultAllowance,
          },
          {
            label: "USDT(초기화 대상, allowance 0) → DAI",
            tokenIn: ETHEREUM_USDT,
            tokenOut: ETHEREUM_DAI,
            allowance: defaultAllowance,
          },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const s = await renderConnected({ allowance: sample.allowance });
          await enterPair(sample.tokenIn, sample.tokenOut);
          await waitForBatchReady(label);
          const expected = expectedSwapAt(s);
          const from = s.stub.requests.length;

          clickPrimary();
          await waitUntil(
            () => expect(s.wallet.sendCalls.sent, label).toHaveLength(1),
            READY_TIMEOUT_MS,
          );
          await waitForResult(s, label);

          expect(sendCallsSince(s, from), label).toHaveLength(1);
          const sent = s.wallet.sendCalls.sent[0]!;
          expectSameAddress(sent.from, TEST_ACCOUNT, `${label} from`);
          expect(sent.calls, `${label} calls 수`).toHaveLength(2);
          expectApproveCall(sent.calls[0]!, sample.tokenIn, MAX_UINT256, `${label} calls[0]`);
          expectSwapCall(sent.calls[1]!, expected, `${label} calls[1]`);
          expect(sent.atomicRequired, `${label} atomicRequired`).toBe(true);
          expect(sendTransactionsSince(s, from), `${label} 전송 요청`).toEqual([]);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-8
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities가 `atomic.status = "supported"`, 스텁은 wallet_sendCalls에 배치 id로 응답한다. 보내는 토큰은 0 초기화 대상인 Ethereum USDT(0xdAC17F958D2ee523a2206206994597C13D831ec7)이고 0 < allowance < 보내는 금액이며 받는 토큰은 DAI, 금액 `1`이다
     * @when primary-button[data-state]가 `batch-ready`가 되면 주 버튼을 한 번 누르고 wallet_sendCalls 요청이 기록되기를 기다린다
     * @then calls가 3개다
     * @then calls[0]은 to가 USDT 주소이고 data를 디코드하면 approve(체인 1 SwapRouter02 주소, 0)이다
     * @then calls[1]은 to가 USDT 주소이고 data를 디코드하면 approve(체인 1 SwapRouter02 주소, maxUint256)이다
     * @then calls[2]는 to·value가 같은 시점 입력으로 만든 buildSwapTransactionRequest 결과와 같고, data를 디코드하면 multicall(deadline, data[])이며 data[]가 그 결과의 calldata와 deadline 인자만 빼고 같다
     */
    it(
      "[DoD-8] 0 초기화 대상 토큰의 부분 allowance면 approve(0)·approve(max)·multicall 순서다",
      async () => {
        const s = await renderConnected({
          allowance: routerAllowance(ETHEREUM_USDT, PARTIAL_ALLOWANCE),
        });
        await enterPair(ETHEREUM_USDT, ETHEREUM_DAI);
        await waitForBatchReady();
        const expected = expectedSwapAt(s);

        clickPrimary();
        await waitUntil(() => expect(s.wallet.sendCalls.sent).toHaveLength(1), READY_TIMEOUT_MS);
        await waitForResult(s);

        const { calls } = s.wallet.sendCalls.sent[0]!;
        expect(calls).toHaveLength(3);
        expectApproveCall(calls[0]!, ETHEREUM_USDT, 0n, "calls[0]");
        expectApproveCall(calls[1]!, ETHEREUM_USDT, MAX_UINT256, "calls[1]");
        expectSwapCall(calls[2]!, expected, "calls[2]");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("전송 전 체인 확인", () => {
    /**
     * @spec DoD-11
     * @given 스텁 EIP-1193 지갑으로 Arbitrum(42161)에 연결돼 있고 체인 드롭다운으로 선택 체인을 Ethereum으로 바꿨다. 스텁은 체인 전환 요청을 성공시키고 wallet_sendCalls에 배치 id로 응답한다. capabilities는 체인 1에서 `atomic.status = "supported"`이고 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 primary-button[data-state]가 `batch-ready`다
     * @when 주 버튼을 한 번 누르고 wallet_sendCalls 요청이 기록되기를 기다린다
     * @then 체인 1로의 체인 전환 요청이 wallet_sendCalls 요청보다 먼저 기록된다
     * @then wallet_sendCalls 요청의 체인 인자가 선택 체인 ID(1)이다
     */
    it(
      "[DoD-11] 전송 전에 선택 체인으로 전환하고 배치를 선택 체인으로 보낸다",
      async () => {
        const s = await renderArbitrumWalletBatchReady();
        const from = s.stub.requests.length;

        clickPrimary();
        await waitUntil(() => expect(s.wallet.sendCalls.sent).toHaveLength(1), READY_TIMEOUT_MS);

        const requests = s.stub.requests.slice(from);
        const switchIndex = requests.findIndex(
          (request) =>
            request.method === CHAIN_SWITCH_METHOD &&
            (request.params as [{ chainId: string }])[0].chainId === "0x1",
        );
        const sendIndex = requests.findIndex((request) => request.method === "wallet_sendCalls");
        expect(switchIndex).toBeGreaterThanOrEqual(0);
        expect(sendIndex).toBeGreaterThan(switchIndex);
        expect(s.wallet.sendCalls.sent[0]!.chainId).toBe(mainnet.id);

        await waitForResult(s);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-11
     * @given 스텁 EIP-1193 지갑으로 Arbitrum(42161)에 연결돼 있고 선택 체인은 Ethereum이며 체인 1 capabilities가 `atomic.status = "supported"`, primary-button[data-state]가 `batch-ready`다. 스텁은 체인 전환 요청을 거부(code 4001)로 응답한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `rejected`다
     * @then tx-status[data-status]가 `rejected`다
     * @then result.kind가 batch이고 tx-status[data-kind]가 batch다
     * @then wallet_sendCalls 요청이 0건이다
     */
    it(
      "[EC-11] 전송 전 체인 전환을 거부하면 rejected이고 wallet_sendCalls를 보내지 않는다",
      async () => {
        await expectChainSwitchFailure(USER_REJECTED_CODE, "rejected");
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-11
     * @given 스텁 EIP-1193 지갑으로 Arbitrum(42161)에 연결돼 있고 선택 체인은 Ethereum이며 체인 1 capabilities가 `atomic.status = "supported"`, primary-button[data-state]가 `batch-ready`다. 스텁은 체인 전환 요청을 4001·4902가 아닌 code의 오류로 응답한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `chain-switch-failed`다
     * @then tx-status[data-status]가 `chain-switch-failed`다
     * @then result.kind가 batch이고 tx-status[data-kind]가 batch다
     * @then wallet_sendCalls 요청이 0건이다
     */
    it(
      "[EC-11] 전송 전 체인 전환이 실패하면 chain-switch-failed이고 wallet_sendCalls를 보내지 않는다",
      async () => {
        // 4001·4902가 아닌 code: 지갑 내부 오류(-32603)
        await expectChainSwitchFailure(RPC_INTERNAL_ERROR_CODE, "chain-switch-failed");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("지갑이 배치를 거부하거나 보내지 못한 경우", () => {
    /**
     * @spec EC-5 EC-6
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities가 `atomic.status = "supported"`, 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 primary-button[data-state]가 `batch-ready`다. 표본 wallet_sendCalls 오류: code 4001, 최상위 code가 -32603이고 원인(cause)에 code 4001이 든 오류를 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록되기를 기다린다
     * @then useSwapExecution().result.status가 `rejected`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `rejected`이고 data-kind가 `batch`다
     * @then primary-button[data-state]가 `batch-ready`다
     */
    it(
      "[EC-5][EC-6] wallet_sendCalls를 4001로 거부하면 rejected이고 주 버튼은 batch-ready로 남는다",
      async () => {
        const samples: { label: string; reply: () => WalletCallsErrorReply }[] = [
          { label: "4001", reply: () => ({ type: "error", code: USER_REJECTED_CODE }) },
          {
            label: "-32603 + 원인 4001",
            reply: () => ({
              type: "error",
              code: RPC_INTERNAL_ERROR_CODE,
              cause: providerRpcError(USER_REJECTED_CODE, "User rejected the request."),
            }),
          },
        ];
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { label } = sample;
          const s = await renderUsdcBatchReady();
          await failBatchWith(s, sample.reply(), label);

          expect(s.probe().execution.result?.status, label).toBe("rejected");
          expect(s.probe().execution.result?.kind, label).toBe("batch");
          expect(txStatus().getAttribute("data-status"), label).toBe("rejected");
          expect(txStatus().getAttribute("data-kind"), label).toBe("batch");
          await waitUntil(
            () => expect(primaryState(), label).toBe("batch-ready"),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();
          expect(primaryState(), label).toBe("batch-ready");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-7 EC-9
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities가 `atomic.status = "supported"`, 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 primary-button[data-state]가 `batch-ready`다. 표본 wallet_sendCalls 오류: code -32601, 4200, 5700, 5740, 5750을 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록된 뒤 그 결과로 생긴 읽기가 끝나기를 기다린다
     * @then useSwapExecution().result.status가 `send-failed`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `send-failed`이고 data-kind가 `batch`다
     * @then 클릭 뒤 eth_sendTransaction·wallet_sendTransaction 요청이 0건이다
     */
    it(
      "[EC-7][EC-9] 배치 미지원 code로 실패하면 send-failed이고 approve를 자동으로 보내지 않는다",
      async () => {
        for (const [index, code] of UNSUPPORTED_CODES.entries()) {
          if (index > 0) resetSample();
          const label = `code ${code}`;
          const s = await renderUsdcBatchReady();
          const from = s.stub.requests.length;
          await failBatchWith(s, { type: "error", code }, label);

          expect(s.probe().execution.result?.status, label).toBe("send-failed");
          expect(s.probe().execution.result?.kind, label).toBe("batch");
          expect(txStatus().getAttribute("data-status"), label).toBe("send-failed");
          expect(txStatus().getAttribute("data-kind"), label).toBe("batch");
          expect(sendTransactionsSince(s, from), `${label} 전송 요청`).toEqual([]);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-8
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities는 체인 1과 체인 42161 모두 계속 `atomic.status = "supported"`로 응답하고, 수수료 추정(eth_estimateGas·eth_gasPrice·ETH 단가)에는 성공 응답을 준다. 보내는 USDC(allowance 0)·받는 DAI·금액 `1`의 `batch-ready`에서 주 버튼을 눌러 wallet_sendCalls가 미지원 code로 실패했다. 표본 오류: code -32601, 4200, 5700, 5740, 5750을 하나씩 반복한다
     * @when 같은 계정을 유지한 채 금액을 `2`로 바꾸고, 보내는 토큰을 다른 ERC-20으로 바꿨다 USDC로 되돌리고, 체인 드롭다운으로 선택 체인을 Arbitrum으로 바꿔 Arbitrum에서 보내는 USDC(allowance 0)·받는 DAI(Arbitrum 주소)·금액 `1`을 입력하고, 선택 체인을 Ethereum으로 되돌린 뒤 보내는 USDC(allowance 0)·받는 DAI·금액 `1`을 다시 입력하며(새로고침 없음) 각 단계의 읽기가 끝나기를 기다린다
     * @then 실패 직후와 Ethereum 단계(금액 변경, 토큰 왕복, Ethereum으로 되돌려 다시 입력) 뒤 primary-button[data-state]가 `approve-required`다
     * @then 실패 직후와 Ethereum 단계 뒤 network-fee[data-state]가 `success`가 된 상태에서 network-fee-batch-note가 없다
     * @then 실패 직후와 Ethereum 단계 뒤 network-fee-swap-pending이 있다
     * @then Arbitrum에서 승인이 필요한 ERC-20 페어(allowance 0)를 입력하고 체인 42161 capabilities가 supported이면 primary-button[data-state]가 `batch-ready`다(강등은 그 계정·체인에만 걸린다)
     */
    it(
      "[EC-8] 배치 미지원 code로 실패한 뒤 같은 계정·체인에서는 새로고침 전까지 approve-required다",
      async () => {
        for (const [index, code] of UNSUPPORTED_CODES.entries()) {
          if (index > 0) resetSample();
          const label = `code ${code}`;
          const s = await renderUsdcBatchReady({
            capabilities: atomicCapabilities({
              [mainnet.id]: "supported",
              [arbitrum.id]: "supported",
            }),
          });
          await failBatchWith(s, { type: "error", code }, label);
          expect(s.probe().execution.result?.status, `${label} 전제`).toBe("send-failed");

          // 실패 직후
          await expectDowngradedOnEthereum(`${label} 실패 직후`);

          // 금액 변경
          await typeAmount("2");
          await expectDowngradedOnEthereum(`${label} 금액 변경`);

          // 보내는 토큰 왕복(USDC → USDT → USDC)
          await chooseToken("in", ETHEREUM_USDT);
          await waitUntil(noPendingRpc, READY_TIMEOUT_MS);
          await chooseToken("in", ETHEREUM_USDC);
          await expectDowngradedOnEthereum(`${label} 토큰 왕복`);

          // Arbitrum: 강등은 그 계정·체인(Ethereum)에만 걸린다
          await chooseChainFromDropdown(arbitrum);
          await enterPair(ARBITRUM_USDC, ARBITRUM_DAI);
          await waitUntil(
            () =>
              expect(
                s.wallet.capabilities
                  .requestsFor(TEST_ACCOUNT, arbitrum.id)
                  .some((request) => request.status === "ok"),
              ).toBe(true),
            READY_TIMEOUT_MS,
          );
          await waitForBatchReady(`${label} Arbitrum`);

          // Ethereum으로 되돌려 다시 입력
          await chooseChainFromDropdown(mainnet);
          await enterPair(ETHEREUM_USDC, ETHEREUM_DAI);
          await expectDowngradedOnEthereum(`${label} Ethereum으로 되돌려 다시 입력`);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-10
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities가 `atomic.status = "supported"`, 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 primary-button[data-state]가 `batch-ready`다. 표본 wallet_sendCalls 오류(4001·-32601·4200·5700·5740·5750이 아닌 것): code -32000, code -32603, code 5720을 하나씩 반복한다
     * @when 주 버튼을 누르고 결과가 기록된 뒤 그 결과로 생긴 읽기가 끝나기를 기다린다
     * @then useSwapExecution().result.status가 `send-failed`이고 result.kind가 `batch`다
     * @then tx-status[data-status]가 `send-failed`이고 data-kind가 `batch`다
     * @then primary-button[data-state]가 `batch-ready`다
     */
    it(
      "[EC-10] 그 밖의 오류로 실패하면 send-failed이고 주 버튼은 batch-ready로 남는다",
      async () => {
        const codes = [RPC_INVALID_INPUT_CODE, RPC_INTERNAL_ERROR_CODE, DUPLICATE_ID_CODE];
        for (const [index, code] of codes.entries()) {
          if (index > 0) resetSample();
          const label = `code ${code}`;
          const s = await renderUsdcBatchReady();
          await failBatchWith(s, { type: "error", code }, label);

          expect(s.probe().execution.result?.status, label).toBe("send-failed");
          expect(s.probe().execution.result?.kind, label).toBe("batch");
          expect(txStatus().getAttribute("data-status"), label).toBe("send-failed");
          expect(txStatus().getAttribute("data-kind"), label).toBe("batch");
          await waitUntil(
            () => expect(primaryState(), label).toBe("batch-ready"),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();
          expect(primaryState(), label).toBe("batch-ready");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("연달아 누르는 경우", () => {
    /**
     * @spec EC-19
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities가 `atomic.status = "supported"`, 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 primary-button[data-state]가 `batch-ready`다. 스텁은 wallet_sendCalls 응답을 붙잡아 둔다. 표본 클릭: 같은 작업 단위 안에서 두 번 연달아 누름, 첫 클릭 뒤 wallet_sendCalls 요청이 기록된 다음 다시 누름을 하나씩 반복한다
     * @when 표본대로 주 버튼을 누른 뒤 붙잡은 응답을 배치 id로 풀고 요청 기록이 안정되기를 기다린다
     * @then wallet_sendCalls 요청이 1건이다
     * @then eth_sendTransaction·wallet_sendTransaction 요청이 0건이다
     */
    it(
      "[EC-19] batch-ready를 연달아 눌러도 wallet_sendCalls는 한 번이다",
      async () => {
        const samples = ["같은 작업 단위에서 두 번", "요청 기록 뒤 다시 누름"] as const;
        for (const [index, label] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderUsdcBatchReady();
          const gate = s.wallet.sendCalls.hold();
          const from = s.stub.requests.length;

          if (index === 0) {
            // 렌더가 반영되기 전(같은 act 안)에 두 번 누른다.
            act(() => {
              primaryButton().click();
              primaryButton().click();
            });
            await waitUntil(
              () => expect(s.wallet.sendCalls.sent.length, label).toBeGreaterThan(0),
              READY_TIMEOUT_MS,
            );
          } else {
            clickPrimary();
            await waitUntil(
              () => expect(s.wallet.sendCalls.sent.length, label).toBeGreaterThan(0),
              READY_TIMEOUT_MS,
            );
            clickPrimary();
          }
          await settlePendingWork();
          gate.release();
          await waitForResult(s, label);

          expect(sendCallsSince(s, from), label).toHaveLength(1);
          expect(s.wallet.sendCalls.sent, label).toHaveLength(1);
          expect(sendTransactionsSince(s, from), `${label} 전송 요청`).toEqual([]);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
