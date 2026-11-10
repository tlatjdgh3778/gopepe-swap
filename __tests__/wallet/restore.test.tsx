import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { Address } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieToInitialState } from "wagmi";
import { connect } from "wagmi/actions";

import { createWagmiConfig } from "@/config/wagmi";

import { type StubEip1193, createStubEip1193, providerRpcError } from "../support/stub-eip1193";
import {
  type TrackedButton,
  TEST_ACCOUNT,
  clearCookies,
  createButtonStateRecorder,
  createDeferred,
  currentButton,
  renderApp,
  stubConnector,
} from "../support/wagmi-harness";

// 저장된 연결은 앱과 같은 wagmi cookieStorage(jsdom 쿠키)에 남기므로 테스트마다 지운다.
afterEach(() => {
  vi.useRealTimers();
  clearCookies();
});

const BUTTONS: readonly TrackedButton[] = ["primary-button", "wallet-button"];

const RESTORING = { state: "restoring", disabled: true, busy: true };
const DISCONNECTED = { state: "disconnected", disabled: false, busy: false };
// 연결 상태의 주 버튼 상태(F2 스펙 §4.1). `restoring`·`disconnected`는 포함하지 않는다.
const CONNECTED_PRIMARY_STATES: readonly (string | null)[] = [
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "input-valid",
];

// 앱과 같은 구성(기본 cookieStorage)으로 지갑을 연결해 두어, 쿠키에 연결을 저장한다.
async function saveConnection(stub: StubEip1193) {
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    multiInjectedProviderDiscovery: false,
  });
  await connect(config, { connector: config.connectors[0]! });
}

// 새로고침: 서버(layout)처럼 요청 시점의 쿠키에서 초기 상태를 읽고, 클라이언트 config를 새로 만든다.
// 쿠키는 config 생성 전에 읽는다. 새 config가 만들어지면서 자기 초기 상태를 cookieStorage에 다시 쓰기 때문이다
// (서버는 그보다 앞선 요청 헤더의 쿠키를 받는다).
function reloadApp(stub: StubEip1193) {
  const requestCookie = document.cookie;
  const config = createWagmiConfig({
    connectors: [stubConnector(stub)],
    multiInjectedProviderDiscovery: false,
  });
  const initialState = cookieToInitialState(config, requestCookie);
  return { config, initialState };
}

function startApp(stub: StubEip1193) {
  const { config, initialState } = reloadApp(stub);
  const recorder = createButtonStateRecorder();
  renderApp({ config, initialChainId: mainnet.id, initialState, onCommit: recorder.onCommit });
  return { initialState, recorder };
}

// 가짜 타이머로 시간을 진행하고, 그 사이의 비동기 작업과 렌더링을 반영한다.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function expectPrimaryButtonOpensConnectModal() {
  expect(screen.queryByTestId("connect-modal")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByTestId("primary-button"));
  });
  await advance(0);
  expect(screen.getByTestId("connect-modal")).toBeTruthy();
}

describe("연결 복원 — 복원이 끝나기 전에 미연결로 보이지 않는다", () => {
  describe("복원이 시간 제한 안에 끝나는 경우", () => {
    /**
     * @spec DoD-15
     * @given 저장된 연결이 있고 복원이 성공한다
     * @when 앱을 시작해 복원이 끝날 때까지 화면 상태를 지켜본다
     * @then 주 버튼·지갑 버튼이 로딩·비활성으로 시작한다
     * @then 복원 중 상태에서 연결 상태로 바뀐다
     * @then 그 사이에 미연결 상태가 한 번도 표시되지 않는다
     */
    it("[DoD-15] 저장된 연결은 미연결 상태를 거치지 않고 연결 상태로 복원된다", async () => {
      const stub = createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT] });
      await saveConnection(stub);

      const { initialState, recorder } = startApp(stub);
      expect(initialState?.connections.size).toBe(1);

      await waitFor(() => {
        expect(currentButton("wallet-button").state).toBe("connected");
        expect(CONNECTED_PRIMARY_STATES).toContain(currentButton("primary-button").state);
      });
      expect(
        screen.getByTestId("wallet-button").getAttribute("data-connected-address")?.toLowerCase(),
      ).toBe(TEST_ACCOUNT.toLowerCase());

      for (const button of BUTTONS) {
        expect(recorder.snapshots(button)[0], button).toEqual(RESTORING);
        expect(recorder.states(button), button).not.toContain("disconnected");
      }
    });

    /**
     * @spec DoD-15
     * @given 저장된 연결이 없다
     * @when 앱을 시작해 복원이 끝날 때까지 기다린다
     * @then 주 버튼·지갑 버튼이 로딩·비활성으로 시작한다
     * @then 복원 중 상태에서 미연결 상태로 바뀐다
     */
    it("[DoD-15] 저장된 연결이 없으면 복원이 끝난 뒤 미연결 상태가 된다", async () => {
      // 브라우저 지갑은 있지만 이 앱과 연결한 적이 없다.
      const stub = createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT] });

      const { initialState, recorder } = startApp(stub);
      expect(initialState).toBeUndefined();

      await waitFor(() => {
        for (const button of BUTTONS) expect(currentButton(button), button).toEqual(DISCONNECTED);
      });

      for (const button of BUTTONS) {
        expect(recorder.snapshots(button)[0], button).toEqual(RESTORING);
        expect(recorder.states(button).at(-1), button).toBe("disconnected");
      }
    });
  });

  describe("복원에 실패하거나 시간 제한을 넘기는 경우", () => {
    /**
     * @spec EC-6
     * @given 저장된 연결이 있고 복원이 시간 제한 전에 실패한다
     * @when 앱을 시작해 복원이 실패할 때까지 기다린다
     * @then 주 버튼이 미연결 상태(활성이고 연결 모달을 연다)로 표시된다
     * @then 지갑 버튼이 미연결 상태(로딩 표시 없음, 활성)로 표시된다
     */
    it("[EC-6] 복원에 실패하면 미연결 상태로 표시한다", async () => {
      const stub = createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT] });
      await saveConnection(stub);
      // 새로고침 후 지갑이 계정 조회에 실패한다.
      stub.setHandler("eth_accounts", () => {
        throw providerRpcError(-32603, "Internal error");
      });
      vi.useFakeTimers();

      const { initialState } = startApp(stub);
      expect(initialState?.connections.size).toBe(1);

      // 시간 제한(5000ms)에 이르기 전에 판정한다.
      await advance(4999);

      expect(currentButton("primary-button")).toEqual(DISCONNECTED);
      expect(currentButton("wallet-button")).toEqual(DISCONNECTED);
      await expectPrimaryButtonOpensConnectModal();
    });

    /**
     * @spec EC-6
     * @given 저장된 연결이 있고 복원이 끝나지 않는다
     * @when 앱을 시작해 4999ms 시점과 5000ms 시점의 상태를 확인한다
     * @then 4999ms 시점에 주 버튼·지갑 버튼이 복원 중 상태(로딩 표시, 비활성)다
     * @then 5000ms 시점에 주 버튼이 미연결 상태(활성이고 연결 모달을 연다)로 표시된다
     * @then 5000ms 시점에 지갑 버튼이 미연결 상태(로딩 표시 없음, 활성)로 표시된다
     */
    it("[EC-6] 복원이 5000ms 안에 끝나지 않으면 미연결 상태로 표시한다", async () => {
      const stub = createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT] });
      await saveConnection(stub);
      // 새로고침 후 지갑이 계정 조회에 응답하지 않는다.
      stub.setHandler("eth_accounts", () => new Promise(() => {}));
      vi.useFakeTimers();

      const { initialState } = startApp(stub);
      expect(initialState?.connections.size).toBe(1);

      await advance(4999);
      expect(currentButton("primary-button")).toEqual(RESTORING);
      expect(currentButton("wallet-button")).toEqual(RESTORING);

      await advance(1);
      expect(currentButton("primary-button")).toEqual(DISCONNECTED);
      expect(currentButton("wallet-button")).toEqual(DISCONNECTED);
      await expectPrimaryButtonOpensConnectModal();
    });

    /**
     * @spec EC-6
     * @given 저장된 연결이 있고 복원이 시간 제한을 넘긴 뒤에 성공한다
     * @when 시간 제한이 지나 미연결 상태로 표시된 뒤 복원이 성공한다
     * @then 미연결 상태에서 연결 상태로 바뀐다
     */
    it("[EC-6] 시간 제한 후 복원이 늦게 성공하면 연결 상태로 바뀐다", async () => {
      const stub = createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT] });
      await saveConnection(stub);
      // 새로고침 후 지갑의 계정 응답이 시간 제한보다 늦게 온다.
      const accounts = createDeferred<readonly Address[]>();
      stub.setHandler("eth_accounts", () => accounts.promise);
      vi.useFakeTimers();

      const { recorder } = startApp(stub);

      await advance(5000);
      expect(currentButton("primary-button").state).toBe("disconnected");
      expect(currentButton("wallet-button").state).toBe("disconnected");

      accounts.resolve([TEST_ACCOUNT]);
      await advance(1000);

      expect(currentButton("wallet-button").state).toBe("connected");
      expect(CONNECTED_PRIMARY_STATES).toContain(currentButton("primary-button").state);
      for (const button of BUTTONS) {
        const states = recorder.states(button);
        expect(states.indexOf("disconnected"), button).toBeGreaterThanOrEqual(0);
        expect(states.at(-1), button).not.toBe("disconnected");
        expect(states.lastIndexOf("disconnected"), button).toBe(states.length - 2);
      }
    });
  });
});
