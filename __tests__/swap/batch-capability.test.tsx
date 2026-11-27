import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import type { Address } from "viem";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnection } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";
import { useSwapExecution } from "@/providers/swap-execution-provider";

import {
  type AllowanceFn,
  type BalanceRpcStub,
  allowanceWhen,
  defaultAllowance,
  installBalanceRpcStub,
  matchAllowance,
  parityQuoteRule,
  sameAddress,
} from "../support/rpc-balance-stub";
import {
  ATOMIC_READY_UPGRADE_REJECTED_CODE,
  type StubEip1193,
  type WalletCallsControl,
  type WalletCapabilitiesReply,
  atomicCapabilities,
  callsStatus,
  createStubEip1193,
  installWalletCalls,
} from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  advanceFakeClockInSteps,
  chooseChainFromDropdown,
  clearCookies,
  createNoopWagmiStorage,
  renderAppHook,
  settlePendingWork,
  stubConnector,
  waitUntil,
  waitUntilAdvancingFakeClock,
} from "../support/wagmi-harness";

// 골격: 계획 T-6. Vitest jsdom 통합 테스트(앱 전체 렌더).
// mock 허용 경계: 실제 wagmi·Provider·화면, 스텁 EIP-1193(injected) 커넥터 지갑(wagmi mock 커넥터 아님), 전역 fetch URL 라우팅 스텁, 가짜 타이머,
// 지갑 `wallet_*` 세 메서드(wallet_getCapabilities·wallet_sendCalls·wallet_getCallsStatus)의 스텁 응답·오류·붙잡기. `vi.mock` 금지.
// 데이터 격리: 테스트마다 config·스텁·QueryClient를 새로 만들고 `clearCookies`.
// 판정: 요소는 data-testid·접근성 role로 찾고 data 속성·활성 여부·요청 기록으로 판정한다(문구 판정 없음).
// 미검증: 실제 지갑의 capabilities 형태는 스텁으로 증명하지 못한다.

// 이 파일에서 "capabilities 요청"은 스텁 EIP-1193 지갑이 받은 `wallet_getCapabilities` 요청 기록(`installWalletCalls`)이다.
// "allowance 읽기"는 연결 계정·Ethereum SwapRouter02·보내는 USDC의 ERC-20 `allowance` `eth_call`(RPC fetch 스텁)이다.
// 기대값(주소·체인 ID)은 제품 config가 아니라 리터럴로 적는다. 견적은 모든 티어가 수령량 = 입력 금액으로 응답한다(`parityQuoteRule`).

const CASE_TIMEOUT_MS = 90_000;
const LONG_CASE_TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 10_000;
// 가짜 타이머에서 대기할 때 확인 사이마다 진행하는 가짜 시간(시각 경계를 판정하지 않는 대기에만 쓴다)
const FAKE_WAIT_STEP_MS = 50;
// EC-2: TanStack 기본 재시도 지연 합(1+2+4초)과 앱의 가장 긴 주기 읽기(60초)를 모두 넘기는 가짜 시간
const EC2_FAKE_ADVANCE_MS = 65_000;
const EC2_FAKE_ADVANCE_STEP_MS = 1_000;

// 스펙 §4.1(F5) SwapRouter02 주소(리터럴)
const ETHEREUM_ROUTER: Address = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
// 공식 토큰 주소(리터럴)
const ETHEREUM_USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETHEREUM_USDT: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETHEREUM_DAI: Address = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
// 스텁 EIP-1193 계정 변경 표본의 두 번째 계정(계정 B)
const SECOND_ACCOUNT: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// 보내는 USDC(decimals 6) 금액 1 → amountInRaw 1_000_000. 부분 allowance 표본은 0 < 500_000 < 1_000_000
const AMOUNT = "1";
const PARTIAL_ALLOWANCE = 500_000n;

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

// setTimeout·setInterval(과 짝인 clear*)만 가짜로 둔다.
function fakeTimeouts() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

// ─── 대기 ─────────────────────────────────────────────────────────

type Waiter = (assertion: () => void) => Promise<void>;

const realWait: Waiter = (assertion) => waitUntil(assertion, READY_TIMEOUT_MS);
// 가짜 타이머(setTimeout 포함)를 켠 표본에서 쓴다. 확인 사이마다 가짜 시계를 조금씩 진행한다.
const fakeWait: Waiter = (assertion) =>
  waitUntilAdvancingFakeClock(assertion, FAKE_WAIT_STEP_MS, READY_TIMEOUT_MS);

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

async function chooseToken(side: Side, address: Address, wait: Waiter = realWait) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await wait(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  fireEvent.click(optionRow(address));
  await wait(() => expect(tokenModal()).toBeNull());
}

async function typeAmount(value: string, wait: Waiter = realWait) {
  fireEvent.change(amountInput(), { target: { value } });
  await wait(() => expect(amountInput().value).toBe(value));
}

// TanStack focusManager가 듣는 window까지 닿도록 `visibilitychange`를 bubbling으로 보낸다.
function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  vi.spyOn(document, "hidden", "get").mockReturnValue(state === "hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
}

function focusWindow() {
  act(() => {
    window.dispatchEvent(new FocusEvent("focus"));
  });
}

// ─── 렌더 ─────────────────────────────────────────────────────────

function useProbe() {
  return { execution: useSwapExecution() };
}

type Probe = ReturnType<typeof useProbe>;

type Scenario = {
  stub: StubEip1193;
  wallet: WalletCallsControl;
  probe: () => Probe;
};

type RenderOptions = {
  // 렌더 전에 정하는 capabilities 응답
  capabilities: WalletCapabilitiesReply;
  // allowance 규칙(기본 0)
  allowance?: AllowanceFn;
  // 렌더 전에 capabilities 응답을 붙잡는다
  holdCapabilities?: boolean;
  wait?: Waiter;
};

// 스텁 EIP-1193 지갑으로 Ethereum에 연결된 앱(지갑 체인 = 선택 체인 = Ethereum). 입력은 아직 하지 않는다.
async function renderConnected(options: RenderOptions) {
  const wait = options.wait ?? realWait;
  rpc.setQuoteRule(parityQuoteRule);
  rpc.setAllowances(options.allowance ?? defaultAllowance);
  const stub = createStubEip1193({
    chainId: mainnet.id,
    accounts: [TEST_ACCOUNT],
    authorized: true,
    knownChainIds: [mainnet.id, base.id, arbitrum.id],
  });
  const wallet = installWalletCalls(stub);
  wallet.capabilities.reply(options.capabilities);
  const capabilityGate = options.holdCapabilities ? wallet.capabilities.hold() : undefined;
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId: mainnet.id });
  await wait(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(mainnet.id);
  });
  const scenario: Scenario = { stub, wallet, probe: () => view.result.current };
  return { scenario, capabilityGate };
}

// 보내는 USDC·받는 DAI·금액 `1`을 입력한다.
async function enterUsdcToDai(wait: Waiter = realWait) {
  await chooseToken("in", ETHEREUM_USDC, wait);
  await chooseToken("out", ETHEREUM_DAI, wait);
  await typeAmount(AMOUNT, wait);
}

function usdcAllowanceReadDone(): boolean {
  return rpc
    .requests(
      matchAllowance.query({
        chainId: mainnet.id,
        owner: TEST_ACCOUNT,
        spender: ETHEREUM_ROUTER,
        token: ETHEREUM_USDC,
      }),
    )
    .some((request) => request.status === "ok");
}

function capabilitiesFor(s: Scenario, account: Address, chainId: number) {
  return s.wallet.capabilities.requestsFor(account, chainId);
}

// 연결 계정·체인 1의 capabilities 요청이 표본 결과(`ok`·`error`)로 끝났고 allowance 읽기도 끝났다.
async function waitForReads(s: Scenario, status: "ok" | "error", wait: Waiter = realWait) {
  await wait(() => {
    expect(usdcAllowanceReadDone()).toBe(true);
    expect(capabilitiesFor(s, TEST_ACCOUNT, mainnet.id).some((r) => r.status === status)).toBe(
      true,
    );
  });
}

function usdcAllowance(value: bigint): AllowanceFn {
  return allowanceWhen(
    { chainId: mainnet.id, owner: TEST_ACCOUNT, spender: ETHEREUM_ROUTER, token: ETHEREUM_USDC },
    value,
  );
}

// 다른 capability만 있고 `atomic`이 없는 체인 1 항목
const NO_ATOMIC_ENTRY: WalletCapabilitiesReply = {
  type: "capabilities",
  chains: { [mainnet.id]: { paymasterService: { supported: true } } },
};

describe("배치 실행 판정 — 원자 배치를 지원하는 지갑에서 승인이 필요한 ERC-20 스왑의 주 버튼이 배치 실행으로 바뀐다", () => {
  describe("지갑이 선택 체인에서 원자 배치를 지원하는 경우", () => {
    /**
     * @spec DoD-1 DoD-2 DoD-5
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며, 보내는 ERC-20 잔액이 금액보다 크고 견적이 성공해 F5 규칙상 주 버튼이 `approve-required`인 입력이다. 표본 capabilities(연결 계정·체인 1 항목): `atomic.status = "supported"`, `atomic.status = "ready"`. 표본 입력: 보내는 USDC(allowance 0)·받는 DAI·금액 `1`, 보내는 USDC(0 < allowance < 보내는 금액)·받는 DAI·금액 `1`. capabilities 2 × 입력 2를 하나씩 반복한다
     * @when allowance 읽기와 wallet_getCapabilities 응답이 끝나기를 기다린다
     * @then primary-button[data-state]가 `batch-ready`다
     * @then primary-button이 활성(disabled 아님)이다
     */
    it(
      "[DoD-1][DoD-2][DoD-5] atomic이 supported·ready이고 승인이 필요하면 주 버튼은 활성 batch-ready다",
      async () => {
        const statuses = ["supported", "ready"] as const;
        const inputs = [
          { label: "USDC allowance 0", allowance: defaultAllowance },
          { label: "USDC 0 < allowance < 금액", allowance: usdcAllowance(PARTIAL_ALLOWANCE) },
        ];
        let sampleIndex = 0;
        for (const status of statuses) {
          for (const input of inputs) {
            if (sampleIndex > 0) resetSample();
            sampleIndex += 1;
            const label = `atomic ${status} × ${input.label}`;
            const { scenario: s } = await renderConnected({
              capabilities: atomicCapabilities({ [mainnet.id]: status }),
              allowance: input.allowance,
            });
            await enterUsdcToDai();
            await waitForReads(s, "ok");
            await waitUntil(
              () => expect(primaryState(), label).toBe("batch-ready"),
              READY_TIMEOUT_MS,
            );
            await settlePendingWork();

            expect(primaryState(), label).toBe("batch-ready");
            expect(primaryButton().disabled, label).toBe(false);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("지갑이 원자 배치를 지원하지 않거나 지원 여부를 알 수 없는 경우", () => {
    /**
     * @spec DoD-3
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 F5 규칙상 `approve-required`다. 표본 capabilities: 체인 1 항목이 `atomic.status = "unsupported"`, 체인 1 항목이 없음(다른 체인 항목에만 `atomic.status = "supported"`), 체인 1 항목은 있으나 `atomic` 항목이 없음을 하나씩 반복한다
     * @when allowance 읽기와 wallet_getCapabilities 응답이 끝나기를 기다린다
     * @then primary-button[data-state]가 `approve-required`다
     */
    it(
      "[DoD-3] unsupported이거나 선택 체인·atomic 항목이 없으면 주 버튼은 approve-required다",
      async () => {
        const samples: { label: string; capabilities: WalletCapabilitiesReply }[] = [
          {
            label: "체인 1 atomic unsupported",
            capabilities: atomicCapabilities({ [mainnet.id]: "unsupported" }),
          },
          {
            label: "체인 1 항목 없음(Base 항목만 supported)",
            capabilities: atomicCapabilities({ [base.id]: "supported" }),
          },
          { label: "체인 1 항목에 atomic 없음", capabilities: NO_ATOMIC_ENTRY },
        ];
        for (const [index, { label, capabilities }] of samples.entries()) {
          if (index > 0) resetSample();
          const { scenario: s } = await renderConnected({ capabilities });
          await enterUsdcToDai();
          await waitForReads(s, "ok");
          await settlePendingWork();
          await waitUntil(
            () => expect(primaryState(), label).toBe("approve-required"),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(primaryState(), label).toBe("approve-required");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec DoD-4
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 F5 규칙상 `approve-required`다. 스텁은 wallet_getCapabilities 응답을 붙잡아 둔다(붙잡은 응답이 풀렸다면 `atomic.status = "supported"`)
     * @when allowance 읽기가 끝나고 wallet_getCapabilities 요청이 1건 이상 기록되기를 기다린다(응답은 붙잡은 채)
     * @then primary-button[data-state]가 `approve-required`다
     * @then primary-button이 활성(disabled 아님)이다
     */
    it(
      "[DoD-4] capabilities를 읽는 중이면 주 버튼은 활성 approve-required다",
      async () => {
        const { scenario: s, capabilityGate } = await renderConnected({
          capabilities: atomicCapabilities({ [mainnet.id]: "supported" }),
          holdCapabilities: true,
        });
        if (!capabilityGate) throw new Error("capabilities 붙잡기 게이트가 없다");
        await enterUsdcToDai();
        await waitUntil(() => {
          expect(usdcAllowanceReadDone()).toBe(true);
          expect(capabilitiesFor(s, TEST_ACCOUNT, mainnet.id).length).toBeGreaterThanOrEqual(1);
          expect(capabilityGate.heldCount).toBeGreaterThanOrEqual(1);
        }, READY_TIMEOUT_MS);
        await waitUntil(() => expect(primaryState()).toBe("approve-required"), READY_TIMEOUT_MS);
        await settlePendingWork();

        // 응답은 아직 붙잡혀 있다(읽는 중)
        expect(
          capabilitiesFor(s, TEST_ACCOUNT, mainnet.id).every((r) => r.status === "pending"),
        ).toBe(true);
        expect(primaryState()).toBe("approve-required");
        expect(primaryButton().disabled).toBe(false);

        // 전제 대조: 붙잡은 응답(supported)을 풀면 batch-ready가 된다
        capabilityGate.release();
        await waitUntil(() => expect(primaryState()).toBe("batch-ready"), READY_TIMEOUT_MS);
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-1
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 F5 규칙상 `approve-required`다. 표본 wallet_getCapabilities 오류: code 4200, code -32601, 그 밖의 오류(code -32603)를 하나씩 반복한다
     * @when allowance 읽기가 끝나고 wallet_getCapabilities 실패가 기록되기를 기다린다
     * @then primary-button[data-state]가 `approve-required`다
     */
    it(
      "[EC-1] wallet_getCapabilities가 실패하면 주 버튼은 approve-required다",
      async () => {
        const codes = [4200, -32601, -32603];
        for (const [index, code] of codes.entries()) {
          if (index > 0) resetSample();
          const label = `code ${code}`;
          const { scenario: s } = await renderConnected({ capabilities: { type: "error", code } });
          await enterUsdcToDai();
          await waitForReads(s, "error");
          expect(
            capabilitiesFor(s, TEST_ACCOUNT, mainnet.id).map((r) => r.errorCode),
            label,
          ).toContain(code);
          await settlePendingWork();
          await waitUntil(
            () => expect(primaryState(), label).toBe("approve-required"),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(primaryState(), label).toBe("approve-required");
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });

  describe("capabilities 조회 요청", () => {
    /**
     * @spec EC-2
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 보내는 USDC(allowance 0)·받는 DAI다. 표본 wallet_getCapabilities 오류: code 4200, code -32601, 그 밖의 오류(code -32603)를 하나씩 반복한다
     * @when 첫 wallet_getCapabilities 실패가 기록된 뒤, 같은 계정·체인을 유지한 채 금액을 `1`에서 `2`로 바꾸고, 보내는 토큰을 다른 ERC-20으로 바꿨다 되돌리고, 창 포커스(visibilitychange·focus) 이벤트를 보내고, 각 변화로 생긴 읽기가 끝나기를 기다린 뒤, 가짜 시간을 60초를 넘겨 진행한다(TanStack 기본 재시도 지연 합과 앱의 가장 긴 주기 읽기 60초를 모두 넘긴다)
     * @then 그 계정·체인 1에 대한 wallet_getCapabilities 요청 기록이 첫 요청 1건뿐이다
     */
    it(
      "[EC-2] 조회가 실패해도 같은 계정·체인에서 wallet_getCapabilities를 다시 보내지 않는다",
      async () => {
        const codes = [4200, -32601, -32603];
        // 변화로 생긴 읽기(견적 디바운스 300ms 뒤 요청 포함)가 시작되도록 가짜 시간을 조금 진행한 뒤, 대기 중인 RPC 읽기가 없어질 때까지 기다린다.
        const settleReads = async () => {
          await advanceFakeClockInSteps(500, FAKE_WAIT_STEP_MS);
          await fakeWait(() =>
            expect(rpc.requests().every((request) => request.status !== "pending")).toBe(true),
          );
        };
        for (const [index, code] of codes.entries()) {
          if (index > 0) resetSample();
          const label = `code ${code}`;
          // 실패 시점부터 재시도 지연(setTimeout)·주기 읽기(setInterval)가 가짜 시계를 따르도록 렌더 전에 켠다.
          fakeTimeouts();
          const { scenario: s } = await renderConnected({
            capabilities: { type: "error", code },
            wait: fakeWait,
          });
          await enterUsdcToDai(fakeWait);
          await waitForReads(s, "error", fakeWait);
          const first = capabilitiesFor(s, TEST_ACCOUNT, mainnet.id);
          expect(first, label).toHaveLength(1);
          expect(first[0]!.errorCode, label).toBe(code);

          // 금액 1 → 2
          await typeAmount("2", fakeWait);
          await settleReads();
          // 보내는 토큰을 다른 ERC-20(USDT)으로 바꿨다 USDC로 되돌린다
          await chooseToken("in", ETHEREUM_USDT, fakeWait);
          await fakeWait(() =>
            expect(
              rpc
                .requests(
                  matchAllowance.query({
                    chainId: mainnet.id,
                    owner: TEST_ACCOUNT,
                    spender: ETHEREUM_ROUTER,
                    token: ETHEREUM_USDT,
                  }),
                )
                .some((request) => request.status === "ok"),
            ).toBe(true),
          );
          await chooseToken("in", ETHEREUM_USDC, fakeWait);
          await settleReads();

          // 창 포커스. focusManager까지 닿았는지 양성 대조로 확인한다.
          const focusSignals: boolean[] = [];
          const unsubscribe = focusManager.subscribe((focused) => {
            focusSignals.push(focused);
          });
          setVisibility("hidden");
          setVisibility("visible");
          focusWindow();
          unsubscribe();
          expect(focusSignals, `${label} 포커스 양성 대조`).toContain(true);
          await settleReads();

          // 재시도 지연 합과 가장 긴 주기 읽기(60초)를 모두 넘긴다
          await advanceFakeClockInSteps(EC2_FAKE_ADVANCE_MS, EC2_FAKE_ADVANCE_STEP_MS);
          await settleReads();

          expect(capabilitiesFor(s, TEST_ACCOUNT, mainnet.id), label).toHaveLength(1);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-3
     * @given 스텁 EIP-1193 지갑으로 계정 A·Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 첫 wallet_getCapabilities 요청(계정 A·체인 1)이 기록됐다. 표본 변화: 스텁 EIP-1193 지갑의 연결 계정을 계정 B로 바꿈(선택 체인 Ethereum 유지), 체인 드롭다운으로 선택 체인을 Arbitrum(42161)으로 바꿈(계정 A 유지)을 하나씩 반복한다
     * @when 표본 변화를 일으키고 새 wallet_getCapabilities 요청이 기록되기를 기다린다
     * @then 변화 뒤 wallet_getCapabilities 요청이 기록되고, 그 요청의 계정 인자는 변화 뒤 연결 계정이고 체인 인자는 변화 뒤 선택 체인 ID다(계정 변경 표본은 계정 B·체인 1, 체인 변경 표본은 계정 A·체인 42161)
     */
    it(
      "[EC-3] 연결 계정이나 선택 체인이 바뀌면 바뀐 계정·체인으로 wallet_getCapabilities를 보낸다",
      async () => {
        const samples = [
          { label: "계정 A → B", change: "account", account: SECOND_ACCOUNT, chainId: mainnet.id },
          { label: "체인 1 → 42161", change: "chain", account: TEST_ACCOUNT, chainId: arbitrum.id },
        ] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { scenario: s } = await renderConnected({
            capabilities: atomicCapabilities({
              [mainnet.id]: "supported",
              [arbitrum.id]: "supported",
            }),
          });
          await waitUntil(
            () =>
              expect(
                capabilitiesFor(s, TEST_ACCOUNT, mainnet.id).some((r) => r.status === "ok"),
              ).toBe(true),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();
          const before = s.wallet.capabilities.requests.length;

          if (sample.change === "account") {
            act(() => {
              s.stub.changeAccounts([SECOND_ACCOUNT]);
            });
          } else {
            await chooseChainFromDropdown(arbitrum);
          }
          await waitUntil(
            () =>
              expect(capabilitiesFor(s, sample.account, sample.chainId).length).toBeGreaterThan(0),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          const after = s.wallet.capabilities.requests.slice(before);
          expect(after.length, sample.label).toBeGreaterThan(0);
          for (const request of after) {
            expect(request.account?.toLowerCase(), sample.label).toBe(sample.account.toLowerCase());
            expect(request.chainIds, sample.label).toEqual([sample.chainId]);
          }
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-4
     * @given 스텁 EIP-1193 지갑으로 Ethereum에 연결돼 있고 선택 체인도 Ethereum이며 capabilities가 `atomic.status = "supported"`, 보내는 USDC(allowance 0)·받는 DAI·금액 `1`로 primary-button[data-state]가 `batch-ready`다. 클릭 직전 wallet_getCapabilities 요청 수를 기록해 둔다. 스텁은 wallet_sendCalls 응답을 붙잡아 둔다. 표본 종료: 성공 종료(붙잡은 응답을 배치 id로 풀고 wallet_getCallsStatus가 200·receipt 모두 success로 응답), 미지원 code 실패(붙잡은 응답을 code 5750 오류로 풂)를 하나씩 반복한다
     * @when 주 버튼을 누르고 wallet_sendCalls 요청이 기록되면 붙잡은 응답을 표본대로 풀고, 결과가 기록되고 그 뒤의 읽기가 끝날 때까지 기다린다
     * @then 클릭 뒤 wallet_getCapabilities 요청 수가 클릭 직전과 같다
     */
    it(
      "[EC-4] batch-ready 클릭은 wallet_getCapabilities를 보내지 않는다",
      async () => {
        const samples = [
          { label: "성공 종료", ending: "success" },
          { label: "미지원 code 5750 실패", ending: "unsupported" },
        ] as const;
        for (const [index, sample] of samples.entries()) {
          if (index > 0) resetSample();
          const { scenario: s } = await renderConnected({
            capabilities: atomicCapabilities({ [mainnet.id]: "supported" }),
          });
          await enterUsdcToDai();
          await waitForReads(s, "ok");
          await waitUntil(() => expect(primaryState()).toBe("batch-ready"), READY_TIMEOUT_MS);
          await settlePendingWork();
          s.wallet.callsStatus.reply(
            callsStatus(200, [{ status: "success" }, { status: "success" }]),
          );
          const sendGate = s.wallet.sendCalls.hold();
          const before = s.wallet.capabilities.requests.length;

          fireEvent.click(primaryButton());
          await waitUntil(
            () => expect(s.wallet.sendCalls.sent, sample.label).toHaveLength(1),
            READY_TIMEOUT_MS,
          );
          if (sample.ending === "unsupported") {
            s.wallet.sendCalls.reply({ type: "error", code: ATOMIC_READY_UPGRADE_REJECTED_CODE });
          }
          sendGate.release();
          await waitUntil(() => {
            expect(s.probe().execution.result, sample.label).not.toBeNull();
            expect(s.probe().execution.phase, sample.label).toBe("idle");
          }, READY_TIMEOUT_MS);
          // 표본 종료 확인(전제)
          expect(s.probe().execution.result?.status, sample.label).toBe(
            sample.ending === "success" ? "success" : "send-failed",
          );
          await waitUntil(
            () => expect(rpc.requests().every((r) => r.status !== "pending")).toBe(true),
            READY_TIMEOUT_MS,
          );
          await settlePendingWork();

          expect(s.wallet.capabilities.requests.length, sample.label).toBe(before);
        }
      },
      LONG_CASE_TIMEOUT_MS,
    );
  });
});
