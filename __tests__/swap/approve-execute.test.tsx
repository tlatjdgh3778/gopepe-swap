import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import type { SupportedChainId } from "@/config/chains";
import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";
import { useTokenAllowance } from "@/providers/token-allowance-provider";

import {
  type AllowanceFn,
  type BalanceRpcStub,
  allowanceAlways,
  allowanceWhen,
  defaultAllowance,
  installBalanceRpcStub,
  matchAllowance,
  matchReceipt,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  SEND_TRANSACTION_METHODS,
  type StubEip1193,
  type WalletTransactionControl,
  createStubEip1193,
  installWalletTransactions,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  clearCookies,
  createNoopWagmiStorage,
  decodeApproveCalldata,
  renderAppHook,
  requestsSince,
  settlePendingWork,
  stubConnector,
  waitUntil,
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 `primary-button`의 `data-state`·비활성과 지갑 전송 요청으로 판정한다.
// 지갑은 스텁 EIP-1193 커넥터(`setHandler`)를 쓴다. jsdom에서 mock 커넥터의 `eth_sendTransaction`은 스텁 라우트가 없는 체인 기본 RPC로 나가므로 전송 판정에는 쓰지 않는다.
// mock 허용 경계(사용자 확정): 실제 wagmi·Provider·화면, 스텁 EIP-1193, 전역 fetch URL 라우팅 스텁과 견적 aggregate3 스텁, allowance 응답·실패·붙잡기 스텁(기본 allowance 0),
// 스텁 EIP-1193 `eth_sendTransaction` 핸들러(해시 응답, 붙잡기), 영수증 성공·붙잡기 스텁, 가짜 타이머와 DOM 이벤트. `vi.mock`은 쓰지 않는다.
// 데이터 격리: 테스트마다 wagmi config를 새로 만들고 스텁을 초기화하며 clearCookies를 부른다. QueryClient는 렌더마다 새로 만든다.
// 이 파일에서 "전송 요청"은 스텁 EIP-1193 요청 기록 중 `eth_sendTransaction` 항목이다.
// approve calldata는 테스트 쪽 ABI 리터럴(`approve(address spender, uint256 amount)`)로 디코딩한다. 제품 config·ABI를 기대값으로 쓰지 않는다.
// 기대 주소는 리터럴로 적는다: Ethereum swapRouter02 `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, Base swapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`,
// Base USDT `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`, Base DAI `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb`,
// Ethereum USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`, DAI `0x6B175474E89094C44Da98b954EedeAC495271d0F`.
// maxUint256은 테스트 쪽 리터럴 `2n ** 256n - 1n`이다.
// 견적은 모든 티어가 수령량 = 입력 금액, slot0 가격 1로 응답한다(가격 영향 `normal`, 최소 수령량 > 0, T-7 `parityQuoteRule`).

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;

const MAX_UINT256 = 2n ** 256n - 1n;

// 스펙 §4.1 swapRouter02 주소(리터럴)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const BASE_ROUTER: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";

// 공식 토큰 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const BASE_USDT: Address = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const BASE_DAI: Address = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";

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

// 같은 case 안에서 표본마다 앱과 스텁을 새로 만든다.
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

function expectSameAddress(actual: string | undefined, expected: Address, label: string) {
  expect(actual?.toLowerCase(), label).toBe(expected.toLowerCase());
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution(), allowance: useTokenAllowance() };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletTransactionControl;
  probe: () => Probe;
};

type PairSample = {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amount: string;
  allowance: AllowanceFn;
};

// 스텁 EIP-1193 지갑으로 표본 체인에 연결되고(지갑 체인 = 선택 체인) 표본 페어와 금액을 입력해
// 주 버튼이 `approve-required`이고 활성이 될 때까지 기다린다. `eth_sendTransaction`은 해시로 응답한다.
async function renderApproveRequired(sample: PairSample): Promise<Scenario> {
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setAllowances(sample.allowance);
  const stub = createStubEip1193({
    chainId: sample.chainId,
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
  const view = renderAppHook(useProbe, { config, initialChainId: sample.chainId });
  await waitUntil(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(sample.chainId);
  }, READY_TIMEOUT_MS);
  await chooseToken("in", sample.tokenIn);
  await chooseToken("out", sample.tokenOut);
  await typeAmount(sample.amount);
  await waitUntil(() => expect(primaryState()).toBe("approve-required"), READY_TIMEOUT_MS);
  await settlePendingWork();
  expect(primaryState()).toBe("approve-required");
  expect(primaryButton().disabled).toBe(false);
  return { stub, wallet, probe: () => view.result.current };
}

// 표본 키(체인·연결 계정·spender·토큰)에만 `value`, 나머지는 기본 규칙(0)으로 응답하는 allowance 규칙
function allowanceFor(
  chainId: SupportedChainId,
  spender: Address,
  token: Address,
  value: bigint,
): AllowanceFn {
  return allowanceWhen({ chainId, owner: TEST_ACCOUNT, spender, token }, value);
}

// Ethereum 보내는 토큰의 SwapRouter02 allowance 읽기 요청(연결 계정)
function ethereumAllowanceReads(token: Address) {
  return rpc.requests(
    matchAllowance.query({
      chainId: mainnet.id,
      owner: TEST_ACCOUNT,
      spender: ETHEREUM_ROUTER,
      token,
    }),
  );
}

function sendCount(stub: StubEip1193): number {
  return requestsSince(stub, 0, SEND_TRANSACTION_METHODS).length;
}

function decodeSent(wallet: WalletTransactionControl, index: number) {
  const sent = wallet.sent[index];
  if (!sent?.data) throw new Error(`${index}번째 전송 요청의 calldata가 없다`);
  return decodeApproveCalldata(sent.data);
}

// EC-12·EC-13 공통 전제: Ethereum USDT(초기화 대상), 받는 DAI, 금액 10, allowance 1_000_000
const USDT_PARTIAL: PairSample = {
  chainId: mainnet.id,
  tokenIn: ETHEREUM_USDT,
  tokenOut: ETHEREUM_DAI,
  amount: "10",
  allowance: allowanceFor(mainnet.id, ETHEREUM_ROUTER, ETHEREUM_USDT, 1_000_000n),
};

describe("approve — 사용자가 보내는 토큰의 SwapRouter02 승인을 보내고 체결 뒤 스왑할 수 있게 된다", () => {
  describe("승인이 필요한 상태에서 주 버튼을 누르는 경우", () => {
    /**
     * @spec DoD-13 EC-12
     * @given 스텁 EIP-1193으로 표본 체인에 연결돼 있고(지갑 체인과 선택 체인이 같다) 보내는 토큰 잔액이 충분하며, 금액이 입력돼 견적이 `success`이고 주 버튼이 `approve-required`이며 활성이다. 표본(체인 — 보내는 토큰 → 받는 토큰 — 금액 — allowance): Ethereum — USDC → DAI — `1.5`(amountInRaw `1_500_000n`) — 0(기본 규칙), Ethereum — USDT(allowance 초기화 대상) → DAI — `10`(amountInRaw `10_000_000n`) — 0(EC-12 경계: 0은 `0 < allowance` 조건 밖), Ethereum — USDC(초기화 대상이 아닌 대조군) → DAI — `1.5` — `1_000_000n`(0 < allowance < amountInRaw), Base — Base USDT `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`(심볼이 `USDT`이지만 초기화 대상이 아닌 대조군, decimals 6) → Base DAI `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` — `10`(amountInRaw `10_000_000n`) — `1_000_000n`(0 < allowance < amountInRaw)을 하나씩 반복하며, 표본마다 config·스텁·QueryClient를 새로 만들어 앱을 새로 렌더링한다. `eth_sendTransaction` 핸들러는 해시로 응답한다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이다
     * @then 전송 요청의 `to`가 표본 보내는 토큰 컨트랙트 주소 리터럴이다
     * @then 전송 요청의 calldata를 테스트 쪽 `approve` ABI 리터럴로 디코딩하면 함수가 `approve`이고 spender가 표본 체인의 swapRouter02 주소 리터럴(Ethereum `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, Base `0x2626664c2603336E57B271c5C0b26F421741e481`), amount가 maxUint256 리터럴이다
     */
    it(
      "[DoD-13][EC-12] 보내는 토큰 컨트랙트에 approve(swapRouter02, maxUint256)을 보낸다(초기화 대상이 아닌 토큰의 부분 allowance 포함)",
      async () => {
        const samples: { label: string; sample: PairSample; router: Address }[] = [
          {
            label: "Ethereum USDC allowance 0",
            sample: {
              chainId: mainnet.id,
              tokenIn: ETHEREUM_USDC,
              tokenOut: ETHEREUM_DAI,
              amount: "1.5",
              allowance: defaultAllowance,
            },
            router: ETHEREUM_ROUTER,
          },
          {
            label: "Ethereum USDT allowance 0",
            sample: {
              chainId: mainnet.id,
              tokenIn: ETHEREUM_USDT,
              tokenOut: ETHEREUM_DAI,
              amount: "10",
              allowance: defaultAllowance,
            },
            router: ETHEREUM_ROUTER,
          },
          {
            label: "Ethereum USDC 부분 allowance(대조군)",
            sample: {
              chainId: mainnet.id,
              tokenIn: ETHEREUM_USDC,
              tokenOut: ETHEREUM_DAI,
              amount: "1.5",
              allowance: allowanceFor(mainnet.id, ETHEREUM_ROUTER, ETHEREUM_USDC, 1_000_000n),
            },
            router: ETHEREUM_ROUTER,
          },
          {
            label: "Base USDT 부분 allowance(대조군)",
            sample: {
              chainId: base.id,
              tokenIn: BASE_USDT,
              tokenOut: BASE_DAI,
              amount: "10",
              allowance: allowanceFor(base.id, BASE_ROUTER, BASE_USDT, 1_000_000n),
            },
            router: BASE_ROUTER,
          },
        ];

        for (const [index, { label, sample, router }] of samples.entries()) {
          if (index > 0) resetSample();
          const s = await renderApproveRequired(sample);

          clickPrimary();
          await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
          await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
          await settlePendingWork();

          expect(sendCount(s.stub), label).toBe(1);
          expect(s.wallet.sent, label).toHaveLength(1);
          expectSameAddress(s.wallet.sent[0]!.to, sample.tokenIn, `${label} to`);
          const decoded = decodeSent(s.wallet, 0);
          expectSameAddress(decoded.spender, router, `${label} spender`);
          expect(decoded.amount, `${label} amount`).toBe(MAX_UINT256);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("approve 영수증이 성공한 경우", () => {
    /**
     * @spec DoD-14 EC-15
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 보내는 USDC(잔액 충분), 받는 DAI, 금액 `1.5`(amountInRaw `1_500_000n`)의 견적이 `success`이며 allowance 0(기본 규칙)으로 주 버튼이 `approve-required`다. 주 버튼을 눌러 approve 전송 요청은 해시로 응답했고 영수증 성공 응답을 붙잡았다. 붙잡은 동안 allowance 읽기 요청 수를 기록하고 스텁의 allowance 응답을 maxUint256으로 바꿨다
     * @when 영수증을 붙잡은 채 대기 중인 작업을 진행시켜 allowance 읽기 요청 수를 확인한 뒤, 붙잡은 영수증을 성공으로 풀고 주 버튼이 `swap-ready`가 되기를 기다린 다음 대기 중인 작업을 진행시킨다(주 버튼은 다시 누르지 않는다)
     * @then 영수증이 붙잡힌 동안에는 allowance 읽기 요청이 기록한 수에서 늘지 않는다
     * @then 영수증을 푼 뒤 allowance 읽기 요청(연결 계정, Ethereum, USDC, spender swapRouter02)이 기록한 수보다 1건 이상 늘어난다
     * @then 주 버튼이 `swap-ready`이고 활성이다
     * @then 대기 뒤에도 전송 요청은 approve 1건뿐이다(approve 체결 뒤 추가 전송 요청 0건)
     * @then 이어서 주 버튼을 다시 누르면 그때 `to`가 swapRouter02 주소 리터럴인 전송 요청이 1건 생긴다
     */
    it(
      "[DoD-14][EC-15] 영수증 뒤에만 allowance를 다시 읽어 swap-ready가 되고 사용자가 다시 누르기 전까지 스왑을 보내지 않는다",
      async () => {
        const s = await renderApproveRequired({
          chainId: mainnet.id,
          tokenIn: ETHEREUM_USDC,
          tokenOut: ETHEREUM_DAI,
          amount: "1.5",
          allowance: defaultAllowance,
        });
        const receiptGate = rpc.holdReceipt();

        clickPrimary();
        await waitUntil(() => expect(s.wallet.hashes()).toHaveLength(1), READY_TIMEOUT_MS);
        await waitUntil(() => expect(receiptGate.heldCount).toBeGreaterThan(0), READY_TIMEOUT_MS);
        // 전제: 보낸 것은 approve(swapRouter02, maxUint256)이고 영수증을 기다리는 approving이다.
        expect(decodeSent(s.wallet, 0).amount).toBe(MAX_UINT256);
        expect(s.probe().execution.phase).toBe("approving");

        const allowanceReadsBefore = ethereumAllowanceReads(ETHEREUM_USDC).length;
        rpc.setAllowances(allowanceAlways(MAX_UINT256));

        // 영수증이 붙잡힌 동안에는 allowance를 다시 읽지 않는다.
        await settlePendingWork(10);
        expect(ethereumAllowanceReads(ETHEREUM_USDC)).toHaveLength(allowanceReadsBefore);
        expect(s.probe().execution.phase).toBe("approving");

        receiptGate.release();
        await waitUntil(() => expect(primaryState()).toBe("swap-ready"), READY_TIMEOUT_MS);
        await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        await settlePendingWork(10);

        expect(ethereumAllowanceReads(ETHEREUM_USDC).length).toBeGreaterThan(allowanceReadsBefore);
        expect(
          ethereumAllowanceReads(ETHEREUM_USDC)
            .slice(allowanceReadsBefore)
            .some((request) => request.status === "ok"),
        ).toBe(true);
        expect(primaryState()).toBe("swap-ready");
        expect(primaryButton().disabled).toBe(false);
        // approve 체결 뒤 추가 전송 요청 0건
        expect(sendCount(s.stub)).toBe(1);
        expect(s.wallet.sent).toHaveLength(1);

        clickPrimary();
        await waitUntil(() => expect(s.wallet.sent).toHaveLength(2), READY_TIMEOUT_MS);
        expect(sendCount(s.stub)).toBe(2);
        expectSameAddress(s.wallet.sent[1]!.to, ETHEREUM_ROUTER, "다시 누른 뒤 전송 요청 to");
        await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("allowance 초기화 대상 토큰에 부분 allowance가 있는 경우", () => {
    /**
     * @spec EC-12
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 보내는 Ethereum USDT(allowance 초기화 대상, 잔액 충분), 받는 DAI, 금액 `10`(amountInRaw `10_000_000n`)의 견적이 `success`이며, 스텁의 allowance 응답이 `1_000_000n`(0 < allowance < amountInRaw)이어서 주 버튼이 `approve-required`이고 활성이다. `eth_sendTransaction` 핸들러는 해시로 응답한다. 대조군(초기화 대상이 아닌 Ethereum USDC와 Base USDT의 0 < allowance < amountInRaw)은 DoD-13 case가 맡는다
     * @when 주 버튼을 한 번 누르고 전송 요청이 기록되기를 기다린다
     * @then 전송 요청이 1건이다
     * @then 전송 요청의 `to`가 USDT 주소 리터럴이다
     * @then 전송 요청의 calldata를 테스트 쪽 `approve` ABI 리터럴로 디코딩하면 함수가 `approve`이고 spender가 swapRouter02 주소 리터럴, amount가 `0n`이다
     */
    it(
      "[EC-12] Ethereum USDT의 0 < allowance < amountInRaw에서 approve(swapRouter02, 0)을 보낸다",
      async () => {
        const s = await renderApproveRequired(USDT_PARTIAL);
        // 전제: 현재 키의 allowance가 0 < 1_000_000 < amountInRaw(10_000_000)로 읽혔다.
        expect(s.probe().allowance).toEqual({ status: "success", allowance: 1_000_000n });

        clickPrimary();
        await waitUntil(() => expect(s.wallet.sent).toHaveLength(1), READY_TIMEOUT_MS);
        await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
        await settlePendingWork();

        expect(sendCount(s.stub)).toBe(1);
        expect(s.wallet.sent).toHaveLength(1);
        expectSameAddress(s.wallet.sent[0]!.to, ETHEREUM_USDT, "to");
        const decoded = decodeSent(s.wallet, 0);
        expectSameAddress(decoded.spender, ETHEREUM_ROUTER, "spender");
        expect(decoded.amount).toBe(0n);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-13
     * @given 스텁 EIP-1193으로 Ethereum에 연결돼 있고 EC-12 case와 같은 전제(보내는 Ethereum USDT, 받는 DAI, 금액 `10`, allowance `1_000_000n`, 주 버튼 `approve-required`)에서 주 버튼을 눌러 approve(swapRouter02, 0) 전송 요청을 붙잡았다. 붙잡은 동안 스텁의 allowance 응답을 `0n`으로 바꿨다. 영수증은 성공 스텁이 응답한다
     * @when 붙잡은 전송 요청을 해시로 응답해 풀고 주 버튼이 `approve-required`가 되기를 기다린 뒤 대기 중인 작업을 진행시키고, 이어서 주 버튼을 다시 한 번 누른다
     * @then approve(0) 영수증 성공 뒤 주 버튼이 `approve-required`이고 활성이다
     * @then 다시 누르기 전까지 전송 요청은 approve(0) 1건뿐이다
     * @then 다시 누른 뒤 전송 요청이 2건이 되고, 2번째 요청의 `to`가 USDT 주소 리터럴이며 calldata를 테스트 쪽 `approve` ABI 리터럴로 디코딩하면 spender가 swapRouter02 주소 리터럴, amount가 maxUint256 리터럴이다
     */
    it(
      "[EC-13] approve(0) 체결 뒤 다시 approve-required가 되고 다음 클릭이 approve(swapRouter02, maxUint256)을 보낸다",
      async () => {
        const s = await renderApproveRequired(USDT_PARTIAL);
        const sendGate = s.wallet.hold();

        clickPrimary();
        await waitUntil(() => expect(sendGate.heldCount).toBe(1), READY_TIMEOUT_MS);
        // 전제: 붙잡은 요청은 approve(swapRouter02, 0)이다.
        expectSameAddress(s.wallet.sent[0]!.to, ETHEREUM_USDT, "approve(0) to");
        expect(decodeSent(s.wallet, 0).amount).toBe(0n);
        rpc.setAllowances(allowanceFor(mainnet.id, ETHEREUM_ROUTER, ETHEREUM_USDT, 0n));
        const receiptsBefore = rpc.requests(
          matchReceipt.method("eth_getTransactionReceipt"),
        ).length;

        sendGate.release();
        await waitUntil(
          () =>
            expect(
              rpc
                .requests(matchReceipt.method("eth_getTransactionReceipt"))
                .slice(receiptsBefore)
                .some((request) => request.status === "ok"),
            ).toBe(true),
          READY_TIMEOUT_MS,
        );
        await waitUntil(() => {
          expect(s.probe().execution.phase).toBe("idle");
          expect(s.probe().allowance).toEqual({ status: "success", allowance: 0n });
          expect(primaryState()).toBe("approve-required");
        }, READY_TIMEOUT_MS);
        await settlePendingWork(10);

        expect(primaryState()).toBe("approve-required");
        expect(primaryButton().disabled).toBe(false);
        expect(sendCount(s.stub)).toBe(1);
        expect(s.wallet.sent).toHaveLength(1);

        clickPrimary();
        await waitUntil(() => expect(s.wallet.sent).toHaveLength(2), READY_TIMEOUT_MS);
        expect(sendCount(s.stub)).toBe(2);
        expectSameAddress(s.wallet.sent[1]!.to, ETHEREUM_USDT, "다시 누른 뒤 to");
        const decoded = decodeSent(s.wallet, 1);
        expectSameAddress(decoded.spender, ETHEREUM_ROUTER, "다시 누른 뒤 spender");
        expect(decoded.amount).toBe(MAX_UINT256);
        await waitUntil(() => expect(s.probe().execution.phase).toBe("idle"), READY_TIMEOUT_MS);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
