import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { type Address, type Hex, decodeFunctionData, hexToBigInt } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

import {
  type BalanceRpcRequest,
  type BalanceRpcStub,
  type EstimateGasRpcCall,
  allowanceAlways,
  allowanceWhen,
  installBalanceRpcStub,
  match,
  matchNetworkFee,
  matchQuote,
  matchReceipt,
  matchUsdPrice,
  networkFeeRuleWith,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  type SentTransaction,
  type StubEip1193,
  type WalletTransactionControl,
  createStubEip1193,
  installWalletTransactions,
} from "../support/stub-eip1193";
import {
  STUB_SWAP_ROUTER02_ETH_ABI,
  TEST_ACCOUNT,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  decodeApproveCalldata,
  decodeRouterMulticall,
  decodeWethCalldata,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 골격(T-8). 주 버튼이 다음에 보낼 트랜잭션(approve·swap·wrap·unwrap)과 같은 요청으로 `eth_estimateGas`를 보내는지,
// 체인별 수수료 계산(Ethereum·Arbitrum은 gas × gasPrice, Base는 여기에 GasPriceOracle `getL1Fee`를 더함)과
// 성공 표시(`network-fee[data-state][data-fee-wei]`), USDT approve(0) 뒤 approve(max) 재추정, 선택 체인 RPC 경로를 확인한다.
// 판정은 스텁이 받은 요청(JSON-RPC 항목 단위 분류·디코드)과 `network-fee`·`primary-button`의 testid·data 속성으로 한다.
// mock 경계(사용자 확정 2026-11-22): F9 통합 경계(실제 wagmi·Provider·화면, wagmi mock 커넥터·스텁 EIP-1193 지갑,
// 전역 fetch의 URL 라우팅 스텁, vi.mock 금지)에 수수료 3분류(`estimate-gas`·`gas-price`·`l1-fee`) 스텁 응답·revert·실패·붙잡기·HTTP 429를 더한 것.
// 주 버튼이 보내는 tx와 비교하는 case는 스텁 EIP-1193 지갑을 쓴다.
// 그 밖의 provider·훅·컴포넌트는 실제 코드를 쓴다. 이 경계는 실제 노드의 추정값을 증명하지 못한다(실제 추정은 포크 테스트가 본다).
// 데이터 격리: 테스트(표본)마다 config·RPC 스텁·지갑 스텁·QueryClient를 새로 만들고 쿠키를 지운다(clearCookies).
// 기대 주소(SwapRouter02, WETH, 토큰, GasPriceOracle, 연결 계정)는 제품 config를 쓰지 않고 테스트 리터럴로 적는다.
// 기대 calldata는 테스트 쪽 ABI 리터럴과 하네스 디코더로 디코드해 비교하고, 기대 feeWei는 스텁 응답값으로 테스트가 따로 계산한다.

const CASE_TIMEOUT_MS = 90_000;
const MULTI_SAMPLE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;

const MAX_UINT256 = 2n ** 256n - 1n;
const ONE_ETH = 10n ** 18n;

// ─── 공식 주소(리터럴) ───────────────────────────────────────────────

const NATIVE_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
// Uniswap swap-router-contracts `Constants.ADDRESS_THIS`
const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
// OP Stack GasPriceOracle predeploy
const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";
// `getL1Fee(bytes)` 셀렉터
const GET_L1_FEE_SELECTOR = "0x49948e0e";

const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const BASE_ROUTER: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
const WETH_BY_CHAIN: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  [base.id]: "0x4200000000000000000000000000000000000006",
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
const USDC_BY_CHAIN: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [arbitrum.id]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};
const ETHEREUM_WETH = WETH_BY_CHAIN[mainnet.id];
const ETHEREUM_USDC = USDC_BY_CHAIN[mainnet.id];
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

// 체인별 RPC 프록시 경로(리터럴)
const RPC_PATH_BY_CHAIN: Record<SupportedChainId, string> = {
  [mainnet.id]: "/api/rpc/1",
  [base.id]: "/api/rpc/8453",
  [arbitrum.id]: "/api/rpc/42161",
};
const CHAIN_BY_ID = { [mainnet.id]: mainnet, [base.id]: base, [arbitrum.id]: arbitrum };

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

// 같은 case 안에서 표본마다 앱(config·QueryClient)과 스텁을 새로 만든다.
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

function clickPrimary() {
  fireEvent.click(primaryButton());
}

function networkFee(): HTMLElement | null {
  return screen.queryByTestId("network-fee");
}

function feeState(): string | null | undefined {
  return networkFee()?.getAttribute("data-state");
}

function feeWei(): string | null | undefined {
  return networkFee()?.getAttribute("data-fee-wei");
}

function expectSameAddress(actual: string | undefined, expected: Address, label: string) {
  expect(actual?.toLowerCase(), label).toBe(expected.toLowerCase());
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution(), allowance: useTokenAllowance() };
}

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  probe: () => ReturnType<typeof useProbe>;
};

// 스텁 EIP-1193 지갑으로 `walletChainId`에 연결된 앱을 렌더링한다(처음 선택 체인 = 지갑 체인).
// `selectedChainId`가 다르면 체인 드롭다운으로 앱의 선택 체인만 바꾼다(지갑 체인은 그대로).
// 견적은 가격 영향 normal·최소 수령량 > 0 규칙(`parityQuoteRule`)이다. 지갑 `eth_sendTransaction`은 기록하고 해시로 응답한다.
async function renderStubApp(
  walletChainId: SupportedChainId,
  selectedChainId: SupportedChainId = walletChainId,
): Promise<Scenario> {
  rpc.setQuoteRule(parityQuoteRule);
  const stub = createStubEip1193({
    chainId: walletChainId,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletTransactions(stub);
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId: walletChainId });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(walletChainId);
  }, READY_TIMEOUT_MS);
  if (selectedChainId !== walletChainId) {
    await chooseChainFromDropdown(CHAIN_BY_ID[selectedChainId]);
    // 전제: 지갑 체인은 그대로다.
    expect(getConnection(config).chainId).toBe(walletChainId);
    expect(stub.chainId).toBe(walletChainId);
  }
  return { stub, wallet, probe: () => view.result.current };
}

// 페어와 금액을 입력하고 주 버튼이 `state`가 될 때까지 기다린다.
async function enterPair(tokenIn: Address, tokenOut: Address, amount: string, state: string) {
  await chooseToken("in", tokenIn);
  await chooseToken("out", tokenOut);
  await typeAmount(amount);
  await waitUntil(() => expect(primaryState()).toBe(state), READY_TIMEOUT_MS);
}

async function waitFeeSuccess(label?: string) {
  await waitUntil(() => expect(feeState(), label).toBe("success"), READY_TIMEOUT_MS);
  await settlePendingWork();
}

// 같은 시점의 견적(보내는 ETH = 선택 체인 WETH, 입력 금액 `amountInRaw`)과 ETH(WETH → USDC) 단가 조회가 응답되기를 기다린다.
async function waitQuoteAndEthPrice(chainId: SupportedChainId, amountInRaw: bigint, label: string) {
  const weth = WETH_BY_CHAIN[chainId];
  const usdc = USDC_BY_CHAIN[chainId];
  await waitUntil(() => {
    expect(
      rpc
        .requests(matchQuote.input({ chainId, tokenIn: weth, amountIn: amountInRaw }))
        .some((request) => request.status === "ok"),
      `${label} 견적`,
    ).toBe(true);
    expect(
      rpc
        .requests(match.chain(chainId, matchUsdPrice.pair(weth, usdc)))
        .some((request) => request.status === "ok"),
      `${label} ETH 단가`,
    ).toBe(true);
  }, READY_TIMEOUT_MS);
  await settlePendingWork();
}

// ─── 요청 판독 ──────────────────────────────────────────────────────

function estimateOf(request: BalanceRpcRequest): EstimateGasRpcCall {
  if (!request.estimateGas) throw new Error(`${request.seq}번 요청이 추정 요청이 아니다`);
  return request.estimateGas;
}

// `seq` 앞에 받은 추정 요청
function estimatesBefore(seq: number): BalanceRpcRequest[] {
  return rpc.requests(matchNetworkFee.estimateGas()).filter((request) => request.seq < seq);
}

// 테스트 쪽 SwapRouter02 ABI 리터럴로 `multicall(deadline, data)`의 하위 호출 bytes를 읽는다. multicall이 아니면 undefined
function routerSubcalls(data: Hex | undefined): readonly Hex[] | undefined {
  if (!data) return undefined;
  try {
    const decoded = decodeFunctionData({ abi: STUB_SWAP_ROUTER02_ETH_ABI, data });
    return decoded.functionName === "multicall" ? decoded.args[1] : undefined;
  } catch {
    return undefined;
  }
}

function lowerAll(values: readonly Hex[] | undefined): string[] | undefined {
  return values?.map((value) => value.toLowerCase());
}

// 지갑 전송 요청의 `value`(16진). 없으면 0
function sentValue(sent: SentTransaction): bigint {
  return sent.value === undefined ? 0n : hexToBigInt(sent.value);
}

type RawItem = { url: string; method: string; params: unknown[] };

// 전역 fetch 스텁이 받은 JSON-RPC 항목(분류와 무관한 원본, 배치는 항목마다)
function rawItems(): RawItem[] {
  return rpc.fetchStub.calls().flatMap((call) => {
    let body: unknown;
    try {
      body = JSON.parse(call.body);
    } catch {
      return [];
    }
    const items = (Array.isArray(body) ? body : [body]) as {
      method?: string;
      params?: unknown[];
    }[];
    return items.map((item) => ({
      url: call.url,
      method: item.method ?? "",
      params: item.params ?? [],
    }));
  });
}

function rawCallObject(item: RawItem): { to?: string; data?: string } {
  const first = (item.params[0] ?? {}) as { to?: string; data?: string; input?: string };
  return { to: first.to, data: first.data ?? first.input };
}

describe("네트워크 수수료 추정 — 주 버튼이 보낼 트랜잭션의 수수료를 선택 체인에서 추정한다", () => {
  describe("approve 단계", () => {
    /**
     * @spec DoD-1 DoD-4
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고(지갑 체인과 선택 체인이 같다) 지갑 전송 요청은 기록만 하고 붙잡는다. 보내는 토큰 잔액이 충분하고 받는 토큰은 Ethereum DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F`다. 전역 fetch 스텁은 견적·단가에 기본 성공 응답을, 수수료 3분류(`estimate-gas`·`gas-price`·`l1-fee`)에 기본 성공 응답을 주고 모든 JSON-RPC 항목을 분류해 기록한다. 표본(보내는 토큰 — 금액 — allowance 응답 — 기대 approve 금액): Ethereum USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` — `1.5`(amountInRaw `1_500_000n`) — 0 — 2^256-1, Ethereum USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`(allowance 초기화 대상) — `10`(amountInRaw `10_000_000n`) — `1_000_000n`(0 < allowance < amountInRaw) — 0을 하나씩 반복한다
     * @when 주 버튼이 `approve-required`가 되고 `network-fee`가 `data-state=success`가 되기를 기다린 뒤, 주 버튼을 한 번 눌러 지갑 전송 요청이 기록되기를 기다린다
     * @then `estimate-gas` 분류 요청이 1건 이상이고, 그중 approve 추정 요청의 `to`가 보내는 토큰 주소 리터럴, `from`이 연결 계정 주소 리터럴 `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`이다
     * @then approve 추정 요청의 `data`를 테스트 쪽 ERC-20 approve ABI 리터럴로 디코드하면 spender가 Ethereum SwapRouter02 주소 리터럴 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`이고 amount가 표본의 기대 approve 금액이다(USDT 초기화 단계는 `approve(0)`)
     * @then approve 추정 요청의 `to`·`data`가 주 버튼을 눌러 지갑에 간 approve 전송 요청의 `to`·`data`와 같다
     * @then 주 버튼을 누르기 전까지 기록된 `estimate-gas` 분류 요청 중 `to`가 SwapRouter02 주소 리터럴이거나 `data`가 SwapRouter02 `multicall`로 디코드되는 스왑 추정 요청이 0건이다
     */
    it(
      "[DoD-1][DoD-4] approve-required면 버튼이 보낼 approve와 같은 요청만 추정하고 스왑은 추정하지 않는다",
      async () => {
        const samples = [
          {
            label: "USDC allowance 0",
            token: ETHEREUM_USDC,
            amount: "1.5",
            allowance: 0n,
            expectedApprove: MAX_UINT256,
          },
          {
            label: "USDT 부분 allowance",
            token: ETHEREUM_USDT,
            amount: "10",
            allowance: 1_000_000n,
            expectedApprove: 0n,
          },
        ];

        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          rpc.setAllowances(
            allowanceWhen(
              {
                chainId: mainnet.id,
                owner: TEST_ACCOUNT,
                spender: ETHEREUM_ROUTER,
                token: sample.token,
              },
              sample.allowance,
            ),
          );
          const app = await renderStubApp(mainnet.id);
          const sendGate = app.wallet.hold();
          await enterPair(sample.token, ETHEREUM_DAI, sample.amount, "approve-required");
          await waitFeeSuccess(label);
          expect(primaryState(), label).toBe("approve-required");

          const clickSeq = rpc.requests().length;
          clickPrimary();
          await waitUntil(() => expect(sendGate.heldCount, label).toBe(1), READY_TIMEOUT_MS);
          const sent = app.wallet.sent[0]!;
          expect(sent.data, `${label} 전송 calldata`).toBeDefined();

          const estimates = estimatesBefore(clickSeq);
          expect(estimates.length, `${label} estimate-gas`).toBeGreaterThan(0);
          const approveEstimates = estimates.filter((request) =>
            sameAddress(estimateOf(request).to, sample.token),
          );
          expect(approveEstimates.length, `${label} approve 추정`).toBeGreaterThan(0);
          for (const request of approveEstimates) {
            const call = estimateOf(request);
            expectSameAddress(call.to, sample.token, `${label} to`);
            expectSameAddress(call.from, TEST_ACCOUNT, `${label} from`);
            const decoded = decodeApproveCalldata(call.data!);
            expectSameAddress(decoded.spender, ETHEREUM_ROUTER, `${label} spender`);
            expect(decoded.amount, `${label} amount`).toBe(sample.expectedApprove);
            expectSameAddress(call.to, sent.to as Address, `${label} 전송 to`);
            expect(call.data?.toLowerCase(), `${label} 전송 data`).toBe(sent.data?.toLowerCase());
          }

          const swapEstimates = estimates.filter((request) => {
            const call = estimateOf(request);
            return sameAddress(call.to, ETHEREUM_ROUTER) || routerSubcalls(call.data) !== undefined;
          });
          expect(swapEstimates, `${label} 스왑 추정`).toHaveLength(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec EC-14
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 보내는 Ethereum USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`(잔액 충분), 받는 DAI, 금액 `10`(amountInRaw `10_000_000n`)의 견적이 `success`이며, 스텁의 allowance 응답이 `1_000_000n`(0 < allowance < amountInRaw)이어서 주 버튼이 `approve-required`다. 전역 fetch 스텁의 `estimate-gas` 규칙은 approve amount 0 요청과 2^256-1 요청에 서로 다른 gas 값을, `gas-price`는 1이 아닌 고정 값을 응답한다. 지갑 전송 요청은 붙잡고, 영수증은 성공 스텁이 응답한다
     * @when `approve(0)` 추정과 `network-fee` 성공을 기다린 뒤 주 버튼을 눌러 approve(SwapRouter02, 0) 전송 요청을 붙잡고, 붙잡은 동안 스텁의 allowance 응답을 `0n`으로 바꾼 다음 전송 요청을 해시로 응답해 풀고, 주 버튼이 다시 `approve-required`가 되고 `network-fee`가 `data-state=success`가 되기를 기다린다
     * @then `approve(0)` 영수증 성공 뒤에 기록된 `estimate-gas` 분류 요청 중 `to`가 USDT 주소 리터럴이고 디코드한 spender가 SwapRouter02 주소 리터럴, amount가 2^256-1인 approve 추정 요청이 1건 이상이다
     * @then `approve(0)` 영수증 성공 뒤에 기록된 approve 추정 요청에 amount 0인 요청이 없다
     * @then `network-fee`의 `data-fee-wei`가 approve(max) 요청의 gas 응답값 × gasPrice 응답값으로 테스트가 계산한 10진 문자열이고, approve(0) 요청의 gas 응답값으로 계산한 값과 다르다
     */
    it(
      "[EC-14] USDT approve(0) 성공 뒤 다시 approve-required가 되면 approve(max)로 새로 추정한다",
      async () => {
        const GAS_APPROVE_ZERO = 31_219n;
        const GAS_APPROVE_MAX = 48_893n;
        const GAS_OTHER = 77_777n;
        const GAS_PRICE = 3_000_000_017n;
        rpc.setNetworkFeeRule(
          networkFeeRuleWith({
            estimateGas: (query) => {
              if (query.tx.kind !== "approve") return { status: "ok", gas: GAS_OTHER };
              if (query.tx.amount === 0n) return { status: "ok", gas: GAS_APPROVE_ZERO };
              if (query.tx.amount === MAX_UINT256) return { status: "ok", gas: GAS_APPROVE_MAX };
              return { status: "ok", gas: GAS_OTHER };
            },
            gasPrice: () => GAS_PRICE,
          }),
        );
        const usdtAllowance = (value: bigint) =>
          allowanceWhen(
            {
              chainId: mainnet.id,
              owner: TEST_ACCOUNT,
              spender: ETHEREUM_ROUTER,
              token: ETHEREUM_USDT,
            },
            value,
          );
        rpc.setAllowances(usdtAllowance(1_000_000n));
        const app = await renderStubApp(mainnet.id);
        await enterPair(ETHEREUM_USDT, ETHEREUM_DAI, "10", "approve-required");
        await waitFeeSuccess();
        // 전제: approve(0) 추정이 나갔고 그 값을 표시한다.
        const zeroEstimates = rpc
          .requests(matchNetworkFee.estimateGas())
          .filter((request) => sameAddress(estimateOf(request).to, ETHEREUM_USDT))
          .filter((request) => decodeApproveCalldata(estimateOf(request).data!).amount === 0n);
        expect(zeroEstimates.length).toBeGreaterThan(0);
        expect(feeWei()).toBe((GAS_APPROVE_ZERO * GAS_PRICE).toString());

        const sendGate = app.wallet.hold();
        clickPrimary();
        await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
        // 전제: 붙잡은 요청은 approve(SwapRouter02, 0)이다.
        expectSameAddress(app.wallet.sent[0]!.to, ETHEREUM_USDT, "approve(0) to");
        expect(decodeApproveCalldata(app.wallet.sent[0]!.data!).amount).toBe(0n);
        rpc.setAllowances(usdtAllowance(0n));
        const receiptsBefore = rpc.requests(
          matchReceipt.method("eth_getTransactionReceipt"),
        ).length;

        sendGate.release();
        let receiptSeq = -1;
        await waitUntil(() => {
          const receipt = rpc
            .requests(matchReceipt.method("eth_getTransactionReceipt"))
            .slice(receiptsBefore)
            .find((request) => request.status === "ok");
          expect(receipt).toBeDefined();
          receiptSeq = receipt!.seq;
        }, READY_TIMEOUT_MS);
        await waitUntil(() => {
          expect(app.probe().execution.phase).toBe("idle");
          expect(app.probe().allowance).toEqual({ status: "success", allowance: 0n });
          expect(primaryState()).toBe("approve-required");
          expect(
            rpc
              .requests(match.since(receiptSeq, matchNetworkFee.estimateGas()))
              .some((request) => request.status === "ok"),
          ).toBe(true);
          expect(feeState()).toBe("success");
        }, READY_TIMEOUT_MS);
        await settlePendingWork();

        const afterReceipt = rpc
          .requests(match.since(receiptSeq, matchNetworkFee.estimateGas()))
          .filter((request) => sameAddress(estimateOf(request).to, ETHEREUM_USDT));
        const maxEstimates = afterReceipt.filter((request) => {
          const decoded = decodeApproveCalldata(estimateOf(request).data!);
          return sameAddress(decoded.spender, ETHEREUM_ROUTER) && decoded.amount === MAX_UINT256;
        });
        expect(maxEstimates.length).toBeGreaterThan(0);
        for (const request of afterReceipt) {
          expect(decodeApproveCalldata(estimateOf(request).data!).amount).not.toBe(0n);
        }
        expect(feeState()).toBe("success");
        expect(feeWei()).toBe((GAS_APPROVE_MAX * GAS_PRICE).toString());
        expect(feeWei()).not.toBe((GAS_APPROVE_ZERO * GAS_PRICE).toString());
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("swap 단계", () => {
    /**
     * @spec DoD-2
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고(지갑 체인과 선택 체인이 같다) 지갑 전송 요청은 기록만 하고 붙잡는다. 보내는 토큰 잔액(ETH 포함)이 충분하고, ERC-20 보내는 토큰의 allowance 응답은 amountInRaw 이상이다. 전역 fetch 스텁은 견적·단가·수수료 3분류에 기본 성공 응답을 주고 모든 JSON-RPC 항목을 분류해 기록한다. 표본(보내는 토큰 → 받는 토큰): ERC-20 입력 USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` → DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F`, ETH 입력 ETH `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` → USDC, ETH 출력 USDC → ETH를 하나씩 반복한다
     * @when 금액을 입력하고 주 버튼이 `swap-ready`가 되고 `network-fee`가 `data-state=success`가 되기를 기다린 뒤, 주 버튼을 한 번 눌러 지갑 전송 요청이 기록되기를 기다린다
     * @then 스왑 추정 요청(`estimate-gas` 분류)의 `to`가 Ethereum SwapRouter02 주소 리터럴 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`이고 `from`이 연결 계정 주소 리터럴이다
     * @then 스왑 추정 요청의 `value`가 ETH 입력 표본에서 amountInRaw이고 ERC-20 입력·ETH 출력 표본에서는 없거나 0이다
     * @then 스왑 추정 요청의 `data`를 테스트 쪽 SwapRouter02 ABI 리터럴로 디코드하면 `multicall(deadline, data)`이고, ERC-20 입력 표본은 하위 호출이 `exactInputSingle` 1개(tokenIn USDC 리터럴, tokenOut DAI 리터럴, recipient 연결 계정), ETH 입력 표본은 `exactInputSingle` 1개(tokenIn Ethereum WETH 리터럴 `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, amountIn amountInRaw), ETH 출력 표본은 `exactInputSingle`(tokenOut WETH 리터럴, recipient `0x0000000000000000000000000000000000000002`)과 `unwrapWETH9`(amountMinimum = 같은 calldata의 exactInputSingle amountOutMinimum, recipient 연결 계정) 2개다
     * @then deadline 인자를 뺀 스왑 추정 요청의 `to`·`value`·`multicall` 하위 호출 bytes가 주 버튼을 눌러 지갑에 간 swap 전송 요청과 같다
     */
    it(
      "[DoD-2] swap-ready면 버튼이 보낼 swap과 deadline 외에 같은 요청으로 추정한다",
      async () => {
        type Shape = "erc20" | "eth-in" | "eth-out";
        const samples: {
          label: string;
          tokenIn: Address;
          tokenOut: Address;
          amount: string;
          amountInRaw: bigint;
          shape: Shape;
        }[] = [
          {
            label: "ERC-20 입력",
            tokenIn: ETHEREUM_USDC,
            tokenOut: ETHEREUM_DAI,
            amount: "1.5",
            amountInRaw: 1_500_000n,
            shape: "erc20",
          },
          {
            label: "ETH 입력",
            tokenIn: NATIVE_ETH,
            tokenOut: ETHEREUM_USDC,
            amount: "0.5",
            amountInRaw: 5n * 10n ** 17n,
            shape: "eth-in",
          },
          {
            label: "ETH 출력",
            tokenIn: ETHEREUM_USDC,
            tokenOut: NATIVE_ETH,
            amount: "1.5",
            amountInRaw: 1_500_000n,
            shape: "eth-out",
          },
        ];

        for (const [index, sample] of samples.entries()) {
          const { label } = sample;
          if (index > 0) resetSample();
          rpc.setAllowances(allowanceAlways(MAX_UINT256));
          const app = await renderStubApp(mainnet.id);
          const sendGate = app.wallet.hold();
          await enterPair(sample.tokenIn, sample.tokenOut, sample.amount, "swap-ready");
          await waitFeeSuccess(label);
          expect(primaryState(), label).toBe("swap-ready");

          const clickSeq = rpc.requests().length;
          clickPrimary();
          await waitUntil(() => expect(sendGate.heldCount, label).toBe(1), READY_TIMEOUT_MS);
          const sent = app.wallet.sent[0]!;

          const estimates = estimatesBefore(clickSeq);
          expect(estimates.length, `${label} 스왑 추정`).toBeGreaterThan(0);
          for (const request of estimates) {
            const call = estimateOf(request);
            expectSameAddress(call.to, ETHEREUM_ROUTER, `${label} to`);
            expectSameAddress(call.from, TEST_ACCOUNT, `${label} from`);
            if (sample.shape === "eth-in") {
              expect(call.value, `${label} value`).toBe(sample.amountInRaw);
            } else {
              expect(call.value ?? 0n, `${label} value`).toBe(0n);
            }

            const decoded = decodeRouterMulticall(call.data!);
            if (sample.shape === "erc20") {
              expect(decoded.calls, label).toHaveLength(1);
              const [exact] = decoded.calls;
              expect(exact!.kind, label).toBe("exactInputSingle");
              if (exact!.kind !== "exactInputSingle") throw new Error("unreachable");
              expectSameAddress(exact.params.tokenIn, ETHEREUM_USDC, `${label} tokenIn`);
              expectSameAddress(exact.params.tokenOut, ETHEREUM_DAI, `${label} tokenOut`);
              expectSameAddress(exact.params.recipient, TEST_ACCOUNT, `${label} recipient`);
            } else if (sample.shape === "eth-in") {
              expect(decoded.calls, label).toHaveLength(1);
              const [exact] = decoded.calls;
              expect(exact!.kind, label).toBe("exactInputSingle");
              if (exact!.kind !== "exactInputSingle") throw new Error("unreachable");
              expectSameAddress(exact.params.tokenIn, ETHEREUM_WETH, `${label} tokenIn`);
              expect(exact.params.amountIn, `${label} amountIn`).toBe(sample.amountInRaw);
            } else {
              expect(decoded.calls, label).toHaveLength(2);
              const [exact, unwrap] = decoded.calls;
              expect(exact!.kind, label).toBe("exactInputSingle");
              expect(unwrap!.kind, label).toBe("unwrapWETH9");
              if (exact!.kind !== "exactInputSingle" || unwrap!.kind !== "unwrapWETH9") {
                throw new Error("unreachable");
              }
              expectSameAddress(exact.params.tokenOut, ETHEREUM_WETH, `${label} tokenOut`);
              expectSameAddress(exact.params.recipient, ADDRESS_THIS, `${label} recipient`);
              expect(unwrap.amountMinimum, `${label} unwrap amountMinimum`).toBe(
                exact.params.amountOutMinimum,
              );
              expectSameAddress(unwrap.recipient, TEST_ACCOUNT, `${label} unwrap recipient`);
            }
          }

          // deadline 인자를 뺀 비교: 마지막 추정 요청과 지갑에 간 swap 전송 요청
          const last = estimateOf(estimates.at(-1)!);
          expectSameAddress(last.to, sent.to as Address, `${label} 전송 to`);
          expect(last.value ?? 0n, `${label} 전송 value`).toBe(sentValue(sent));
          const estimateSubcalls = lowerAll(routerSubcalls(last.data));
          expect(estimateSubcalls, `${label} 추정 하위 호출`).toBeDefined();
          expect(estimateSubcalls, `${label} 전송 하위 호출`).toEqual(
            lowerAll(routerSubcalls(sent.data)),
          );
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("wrap·unwrap 단계", () => {
    /**
     * @spec DoD-3
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고(지갑 체인과 선택 체인이 같다) 보내는 토큰 잔액이 충분하며, 지갑 전송 요청은 기록만 하고 붙잡는다. 전역 fetch 스텁은 수수료 3분류에 기본 성공 응답을 주고 모든 JSON-RPC 항목을 분류해 기록한다. 금액은 `0.5`(amountInRaw `5 × 10^17`)다. 표본(보내는 토큰 → 받는 토큰 — 주 버튼 상태): wrap ETH `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` → Ethereum WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` — `wrap-ready`, unwrap Ethereum WETH → ETH — `unwrap-ready`를 하나씩 반복한다
     * @when 주 버튼이 표본의 상태(`wrap-ready`·`unwrap-ready`)가 되고 `network-fee`가 `data-state=success`가 되기를 기다린 뒤, 주 버튼을 한 번 눌러 지갑 전송 요청이 기록되기를 기다린다
     * @then 두 표본 모두 `estimate-gas` 분류 요청의 `to`가 Ethereum WETH 주소 리터럴이고 `from`이 연결 계정 주소 리터럴이다
     * @then wrap 표본은 그 요청의 `data`를 테스트 쪽 WETH ABI 리터럴로 디코드하면 인자 없는 `deposit()`이고 `value`가 amountInRaw다
     * @then unwrap 표본은 그 요청의 `data`를 테스트 쪽 WETH ABI 리터럴로 디코드하면 `withdraw(wad)`이고 wad가 amountInRaw이며 `value`가 없거나 0이다
     * @then 두 표본 모두 그 요청의 `to`·`data`·`value`가 주 버튼을 눌러 지갑에 간 wrap·unwrap 전송 요청과 같다
     */
    it(
      "[DoD-3] wrap-ready는 WETH deposit + value, unwrap-ready는 WETH withdraw 요청으로 추정한다",
      async () => {
        const amountInRaw = 5n * 10n ** 17n;
        const samples = [
          {
            kind: "wrap",
            tokenIn: NATIVE_ETH,
            tokenOut: ETHEREUM_WETH,
            state: "wrap-ready",
          },
          {
            kind: "unwrap",
            tokenIn: ETHEREUM_WETH,
            tokenOut: NATIVE_ETH,
            state: "unwrap-ready",
          },
        ] as const;

        for (const [index, sample] of samples.entries()) {
          const label = sample.kind;
          if (index > 0) resetSample();
          const app = await renderStubApp(mainnet.id);
          const sendGate = app.wallet.hold();
          await enterPair(sample.tokenIn, sample.tokenOut, "0.5", sample.state);
          await waitFeeSuccess(label);
          expect(primaryState(), label).toBe(sample.state);

          const clickSeq = rpc.requests().length;
          clickPrimary();
          await waitUntil(() => expect(sendGate.heldCount, label).toBe(1), READY_TIMEOUT_MS);
          const sent = app.wallet.sent[0]!;

          const estimates = estimatesBefore(clickSeq);
          expect(estimates.length, `${label} estimate-gas`).toBeGreaterThan(0);
          for (const request of estimates) {
            const call = estimateOf(request);
            expectSameAddress(call.to, ETHEREUM_WETH, `${label} to`);
            expectSameAddress(call.from, TEST_ACCOUNT, `${label} from`);
            const decoded = decodeWethCalldata(call.data!);
            if (sample.kind === "wrap") {
              expect(decoded.functionName, label).toBe("deposit");
              expect(call.value, `${label} value`).toBe(amountInRaw);
            } else {
              expect(decoded, label).toEqual({ functionName: "withdraw", wad: amountInRaw });
              expect(call.value ?? 0n, `${label} value`).toBe(0n);
            }
          }

          const last = estimateOf(estimates.at(-1)!);
          expectSameAddress(last.to, sent.to as Address, `${label} 전송 to`);
          expect(last.data?.toLowerCase(), `${label} 전송 data`).toBe(sent.data?.toLowerCase());
          expect(last.value ?? 0n, `${label} 전송 value`).toBe(sentValue(sent));
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });

  describe("체인별 수수료 계산", () => {
    /**
     * @spec DoD-5 DoD-7 DoD-13
     * @given 스텁 EIP-1193 지갑으로 표본 체인에 연결돼 있고 선택 체인도 표본 체인이다. 보내는 ETH 잔액이 충분하고 보내는 ETH `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` → 받는 체인 네이티브 USDC(주소 리터럴)를 고르고 금액을 입력해 주 버튼이 `swap-ready`다. 전역 fetch 스텁은 견적·단가에 기본 성공 응답을, `eth_estimateGas`에 gas G, `eth_gasPrice`에 가격 P를 응답한다(G·P는 1이 아니고 G × P와 G + P가 구별되는 고정 값). 스텁은 모든 JSON-RPC 항목을 분류해 기록하고 GasPriceOracle `0x420000000000000000000000000000000000000F`의 `getL1Fee` eth_call은 `l1-fee`로 분류한다. 표본 체인: Ethereum(USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`), Arbitrum(USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`)을 하나씩 반복한다
     * @when `network-fee`가 `data-state=success`가 되고 같은 시점의 견적과 ETH 단가 조회가 끝나기를 기다린다
     * @then `network-fee`의 `data-state`가 `success`다
     * @then `network-fee`의 `data-fee-wei`가 G × P를 테스트가 계산한 10진 문자열이다
     * @then 기록된 요청 중 `l1-fee` 분류 요청과 GasPriceOracle 주소로 간 `eth_call`이 0건이다
     * @then 양성 대조로 `estimate-gas`·`gas-price` 분류 요청이 각각 1건 이상이고, 같은 시점의 견적 aggregate3 요청은 `quote` 분류, ETH 단가 aggregate3 요청은 `usd-price` 분류로 기록되며 수수료 3분류에 들어가지 않는다
     */
    it(
      "[DoD-5][DoD-7][DoD-13] Ethereum·Arbitrum의 수수료는 gas × gasPrice이고 getL1Fee를 보내지 않는다",
      async () => {
        const GAS = 123_457n;
        const GAS_PRICE = 1_000_000_007n;
        const amountInRaw = 2n * ONE_ETH;
        const chains: SupportedChainId[] = [mainnet.id, arbitrum.id];

        for (const [index, chainId] of chains.entries()) {
          const label = String(chainId);
          if (index > 0) resetSample();
          rpc.setNetworkFeeRule(
            networkFeeRuleWith({
              estimateGas: () => ({ status: "ok", gas: GAS }),
              gasPrice: () => GAS_PRICE,
            }),
          );
          const weth = WETH_BY_CHAIN[chainId];
          const usdc = USDC_BY_CHAIN[chainId];
          await renderStubApp(chainId);
          await enterPair(NATIVE_ETH, usdc, "2", "swap-ready");
          await waitFeeSuccess(label);
          await waitQuoteAndEthPrice(chainId, amountInRaw, label);

          expect(feeState(), label).toBe("success");
          expect(feeWei(), label).toBe((GAS * GAS_PRICE).toString());

          expect(rpc.requests(match.kind("l1-fee")), `${label} l1-fee`).toHaveLength(0);
          const oracleCalls = rawItems().filter(
            (item) =>
              item.method === "eth_call" && sameAddress(rawCallObject(item).to, GAS_PRICE_ORACLE),
          );
          expect(oracleCalls, `${label} GasPriceOracle eth_call`).toHaveLength(0);

          // 양성 대조
          const estimates = rpc.requests(match.chain(chainId, matchNetworkFee.estimateGas()));
          expect(estimates.length, `${label} estimate-gas`).toBeGreaterThan(0);
          for (const request of estimates) expect(request.method, label).toBe("eth_estimateGas");
          const gasPrices = rpc.requests(match.chain(chainId, matchNetworkFee.gasPrice));
          expect(gasPrices.length, `${label} gas-price`).toBeGreaterThan(0);
          for (const request of gasPrices) expect(request.method, label).toBe("eth_gasPrice");

          const quotes = rpc.requests(
            matchQuote.input({ chainId, tokenIn: weth, amountIn: amountInRaw }),
          );
          expect(quotes.length, `${label} 견적`).toBeGreaterThan(0);
          for (const request of quotes) expect(request.kind, `${label} 견적`).toBe("quote");
          const ethPrices = rpc
            .requests(match.chain(chainId, matchUsdPrice.pair(weth, usdc)))
            .filter((request) =>
              request.usdPrice!.pairs.some(
                (pair) =>
                  sameAddress(pair.tokenIn, weth) &&
                  sameAddress(pair.tokenOut, usdc) &&
                  pair.amountIn === ONE_ETH,
              ),
            );
          expect(ethPrices.length, `${label} ETH 단가`).toBeGreaterThan(0);
          for (const request of ethPrices)
            expect(request.kind, `${label} ETH 단가`).toBe("usd-price");
          // 수수료 3분류에 eth_call(견적·단가 aggregate3)이 들어가지 않는다.
          for (const request of rpc.requests(matchNetworkFee.any)) {
            expect(["eth_estimateGas", "eth_gasPrice"], label).toContain(request.method);
          }
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-6 DoD-13
     * @given 스텁 EIP-1193 지갑으로 Base에 연결돼 있고 선택 체인도 Base다. 보내는 ETH 잔액이 충분하고 보내는 ETH `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE` → 받는 Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`를 고르고 금액을 입력해 주 버튼이 `swap-ready`다. 전역 fetch 스텁은 견적·단가에 기본 성공 응답을, `eth_estimateGas`에 gas G, `eth_gasPrice`에 가격 P, GasPriceOracle `0x420000000000000000000000000000000000000F`의 `getL1Fee` eth_call에 L1 수수료 L을 응답한다(G·P·L은 0·1이 아닌 고정 값). 스텁은 모든 JSON-RPC 항목을 분류해 기록한다
     * @when `network-fee`가 `data-state=success`가 되고 같은 시점의 견적과 ETH 단가 조회가 끝나기를 기다린다
     * @then `network-fee`의 `data-state`가 `success`다
     * @then `network-fee`의 `data-fee-wei`가 G × P + L을 테스트가 계산한 10진 문자열이고 G × P(L1 수수료를 뺀 값)와 다르다
     * @then `l1-fee` 분류 요청이 1건 이상이고 모두 Base `/api/rpc/8453`로 간 GasPriceOracle 주소 리터럴 대상 `getL1Fee` eth_call이다
     * @then `getL1Fee` eth_call의 bytes 인자를 tx로 디코드하면 같은 추정 키로 보낸 `eth_estimateGas` 요청(스왑 추정)과 `to`·`data`·`value`가 같다(빈 data나 다른 kind의 calldata가 아니다)
     * @then 양성 대조로 `estimate-gas`·`gas-price` 분류 요청이 각각 1건 이상이고, 같은 시점의 견적 aggregate3 요청은 `quote` 분류, ETH 단가 aggregate3 요청은 `usd-price` 분류로 기록되며 `l1-fee`를 포함한 수수료 3분류에 들어가지 않는다
     */
    it(
      "[DoD-6][DoD-13] Base의 수수료는 gas × gasPrice + getL1Fee다",
      async () => {
        const GAS = 123_457n;
        const GAS_PRICE = 6_000_007n;
        const L1_FEE = 987_654_321n;
        const amountInRaw = 2n * ONE_ETH;
        const weth = WETH_BY_CHAIN[base.id];
        const usdc = USDC_BY_CHAIN[base.id];
        rpc.setNetworkFeeRule(
          networkFeeRuleWith({
            estimateGas: () => ({ status: "ok", gas: GAS }),
            gasPrice: () => GAS_PRICE,
            l1Fee: () => L1_FEE,
          }),
        );
        await renderStubApp(base.id);
        await enterPair(NATIVE_ETH, usdc, "2", "swap-ready");
        await waitFeeSuccess();
        await waitQuoteAndEthPrice(base.id, amountInRaw, "Base");

        expect(feeState()).toBe("success");
        expect(feeWei()).toBe((GAS * GAS_PRICE + L1_FEE).toString());
        expect(feeWei()).not.toBe((GAS * GAS_PRICE).toString());

        const l1Requests = rpc.requests(match.kind("l1-fee"));
        expect(l1Requests.length).toBeGreaterThan(0);
        for (const request of l1Requests) {
          expect(request.chainId).toBe(base.id);
          expect(request.url).toBe("/api/rpc/8453");
          expect(request.method).toBe("eth_call");
          expectSameAddress(request.l1Fee!.target, GAS_PRICE_ORACLE, "getL1Fee 대상");

          // bytes 인자를 tx로 디코드한 값이 같은 추정 키로 앞서 보낸 스왑 추정 요청과 같다.
          const tx = request.l1Fee!.tx;
          expect(tx, "getL1Fee bytes 디코드").toBeDefined();
          const previous = rpc
            .requests(match.chain(base.id, matchNetworkFee.estimateGas()))
            .filter((candidate) => candidate.seq < request.seq)
            .at(-1);
          expect(previous, "앞선 추정 요청").toBeDefined();
          const estimate = estimateOf(previous!);
          expectSameAddress(estimate.to, BASE_ROUTER, "스왑 추정 to");
          expect(routerSubcalls(estimate.data), "스왑 추정 calldata").toBeDefined();
          expectSameAddress(tx!.to, estimate.to!, "getL1Fee tx to");
          expect(tx!.data, "getL1Fee tx data").toBeDefined();
          expect(tx!.data?.toLowerCase()).toBe(estimate.data?.toLowerCase());
          expect(tx!.value ?? 0n, "getL1Fee tx value").toBe(estimate.value ?? 0n);
        }

        // 양성 대조
        const estimates = rpc.requests(match.chain(base.id, matchNetworkFee.estimateGas()));
        expect(estimates.length).toBeGreaterThan(0);
        for (const request of estimates) expect(request.method).toBe("eth_estimateGas");
        const gasPrices = rpc.requests(match.chain(base.id, matchNetworkFee.gasPrice));
        expect(gasPrices.length).toBeGreaterThan(0);
        for (const request of gasPrices) expect(request.method).toBe("eth_gasPrice");

        const quotes = rpc.requests(
          matchQuote.input({ chainId: base.id, tokenIn: weth, amountIn: amountInRaw }),
        );
        expect(quotes.length, "견적").toBeGreaterThan(0);
        for (const request of quotes) expect(request.kind, "견적").toBe("quote");
        const ethPrices = rpc
          .requests(match.chain(base.id, matchUsdPrice.pair(weth, usdc)))
          .filter((request) =>
            request.usdPrice!.pairs.some(
              (pair) =>
                sameAddress(pair.tokenIn, weth) &&
                sameAddress(pair.tokenOut, usdc) &&
                pair.amountIn === ONE_ETH,
            ),
          );
        expect(ethPrices.length, "ETH 단가").toBeGreaterThan(0);
        for (const request of ethPrices) expect(request.kind, "ETH 단가").toBe("usd-price");
        // `l1-fee`로 분류된 eth_call은 GasPriceOracle `getL1Fee` 호출뿐이다(원본 항목 수와 같다).
        const rawL1Calls = rawItems().filter((item) => {
          const { to, data } = rawCallObject(item);
          return (
            item.method === "eth_call" &&
            sameAddress(to, GAS_PRICE_ORACLE) &&
            (data ?? "").toLowerCase().startsWith(GET_L1_FEE_SELECTOR)
          );
        });
        expect(l1Requests).toHaveLength(rawL1Calls.length);
        for (const request of rpc.requests(matchNetworkFee.any)) {
          if (request.method === "eth_call") expect(request.kind).toBe("l1-fee");
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("요청 경로", () => {
    /**
     * @spec EC-15
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결된 채로 두고 체인 드롭다운으로 앱의 선택 체인만 바꾼다(지갑 체인 Ethereum ≠ 선택 체인). 보내는 ETH 잔액이 충분하고 보내는 ETH → 받는 선택 체인 네이티브 USDC(주소 리터럴)를 고르고 금액을 입력해 주 버튼이 `swap-ready`다. 전역 fetch 스텁은 견적·단가·수수료 3분류에 기본 성공 응답을 주고 모든 JSON-RPC 항목을 요청 URL과 함께 기록한다. 표본 선택 체인: Base(SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`, USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), Arbitrum(SwapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`)을 하나씩 반복한다
     * @when `network-fee`가 `data-state=success`가 되기를 기다린다
     * @then `estimate-gas`·`gas-price` 분류 요청(Base 표본은 `l1-fee` 포함)이 모두 선택 체인의 `/api/rpc/[선택 체인 ID]` URL로 갔다
     * @then 지갑 체인(Ethereum) `/api/rpc/1`로 간 `estimate-gas`·`gas-price`·`l1-fee` 분류 요청이 0건이다
     * @then 스왑 추정 요청의 `to`가 선택 체인 SwapRouter02 주소 리터럴이다
     * @then 지갑 스텁이 받은 요청에 `eth_estimateGas`·`eth_gasPrice`가 없다
     */
    it(
      "[EC-15] 지갑 체인이 달라도 추정 요청은 선택 체인 RPC로 간다",
      async () => {
        const samples: { chainId: SupportedChainId; router: Address }[] = [
          { chainId: base.id, router: BASE_ROUTER },
          { chainId: arbitrum.id, router: ETHEREUM_ROUTER },
        ];

        for (const [index, { chainId, router }] of samples.entries()) {
          const label = String(chainId);
          if (index > 0) resetSample();
          const app = await renderStubApp(mainnet.id, chainId);
          await enterPair(NATIVE_ETH, USDC_BY_CHAIN[chainId], "0.5", "swap-ready");
          await waitFeeSuccess(label);
          // 전제: 지갑 체인은 Ethereum 그대로다.
          expect(app.stub.chainId, label).toBe(mainnet.id);

          const feeRequests = rpc.requests(matchNetworkFee.any);
          const expectedKinds =
            chainId === base.id
              ? ["estimate-gas", "gas-price", "l1-fee"]
              : ["estimate-gas", "gas-price"];
          for (const kind of expectedKinds) {
            expect(
              feeRequests.filter((request) => request.kind === kind).length,
              `${label} ${kind}`,
            ).toBeGreaterThan(0);
          }
          for (const request of feeRequests) {
            expect(request.chainId, `${label} ${request.kind} 체인`).toBe(chainId);
            expect(request.url, `${label} ${request.kind} URL`).toBe(RPC_PATH_BY_CHAIN[chainId]);
          }

          expect(
            rpc.requests(match.chain(mainnet.id, matchNetworkFee.any)),
            `${label} Ethereum 수수료 요청`,
          ).toHaveLength(0);
          const walletChainRaw = rawItems().filter((item) => {
            if (item.url !== "/api/rpc/1") return false;
            if (item.method === "eth_estimateGas" || item.method === "eth_gasPrice") return true;
            const { data } = rawCallObject(item);
            return (
              item.method === "eth_call" &&
              (data ?? "").toLowerCase().startsWith(GET_L1_FEE_SELECTOR)
            );
          });
          expect(walletChainRaw, `${label} /api/rpc/1 수수료 항목`).toHaveLength(0);

          const estimates = rpc.requests(matchNetworkFee.estimateGas());
          for (const request of estimates) {
            expectSameAddress(estimateOf(request).to, router, `${label} 스왑 추정 to`);
          }

          const walletFeeRequests = app.stub.requests.filter(
            (request) => request.method === "eth_estimateGas" || request.method === "eth_gasPrice",
          );
          expect(walletFeeRequests, `${label} 지갑 수수료 요청`).toHaveLength(0);
        }
      },
      MULTI_SAMPLE_TIMEOUT_MS,
    );
  });
});
