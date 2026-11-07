import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mainnet } from "viem/chains";
import { afterEach, describe, expect, it } from "vitest";

import { createWagmiConfig } from "@/config/wagmi";

import { announceEip6963Provider, createStubEip1193 } from "../support/stub-eip1193";
import {
  TEST_ACCOUNT,
  clearCookies,
  createNoopWagmiStorage,
  currentButton,
  renderApp,
} from "../support/wagmi-harness";

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  clearCookies();
});

const STUB_WALLET_INFO = {
  uuid: "6f1b8d3e-0c55-4c4e-9a43-2f2d1b7a9c01",
  name: "Stub Wallet",
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E",
  rdns: "com.example.stubwallet",
};

// 앱 기본 커넥터 구성(EIP-6963 감지 켬)으로 렌더링하고, 복원이 끝나 미연결 상태가 되면 연결 모달을 연다.
async function openConnectModalAfterRestore() {
  const config = createWagmiConfig({ storage: createNoopWagmiStorage() });
  renderApp({ config, initialChainId: mainnet.id });
  await waitFor(() => expect(currentButton("primary-button").state).toBe("disconnected"));

  await act(async () => {
    fireEvent.click(screen.getByTestId("primary-button"));
  });
  return screen.findByTestId("connect-modal");
}

function isMetaMaskHost(href: string | null): boolean {
  if (!href) return false;
  const { hostname } = new URL(href);
  return hostname === "metamask.io" || hostname.endsWith(".metamask.io");
}

describe("지갑 연결 — 지갑이 없는 사용자도 다음 행동을 안내받는다", () => {
  describe("연결 모달을 연 경우", () => {
    /**
     * @spec EC-1
     * @given 감지되는 브라우저 지갑이 없고 복원이 끝나 미연결 상태다
     * @when 연결 모달을 연다
     * @then 모달에 브라우저 지갑이 없다는 안내가 있다
     * @then 모달에 MetaMask 설치 링크가 있다
     */
    it("[EC-1] 브라우저 지갑이 없으면 안내와 MetaMask 설치 링크를 표시한다", async () => {
      // 브라우저 지갑이 EIP-6963으로 알려지지 않고, window.ethereum도 없다.
      expect((window as { ethereum?: unknown }).ethereum).toBeUndefined();

      const modal = await openConnectModalAfterRestore();

      // 안내는 요소로 판정하고 문구는 판정하지 않는다(문구 테스트는 스펙 비목표).
      expect(within(modal).queryByTestId("no-wallet-notice")).not.toBeNull();

      const installLink = within(modal).getByTestId("install-wallet-link");
      expect(installLink.tagName).toBe("A");
      expect(isMetaMaskHost(installLink.getAttribute("href"))).toBe(true);
    });

    /**
     * @spec EC-1
     * @given EIP-6963으로 감지되는 브라우저 지갑이 있고 복원이 끝나 미연결 상태다
     * @when 연결 모달을 연다
     * @then 모달에 브라우저 지갑이 없다는 안내가 없다
     * @then 모달에 MetaMask 설치 링크가 없다
     * @then 감지된 지갑이 모달의 연결 선택지로 있다
     */
    it("[EC-1] 브라우저 지갑이 감지되면 안내와 설치 링크를 표시하지 않는다", async () => {
      // 이 앱과 연결한 적 없는 브라우저 지갑이 EIP-6963으로 알려진다.
      const stub = createStubEip1193({ chainId: mainnet.id, accounts: [TEST_ACCOUNT] });
      cleanups.push(announceEip6963Provider(stub, STUB_WALLET_INFO));

      const modal = await openConnectModalAfterRestore();

      expect(within(modal).queryByTestId("no-wallet-notice")).toBeNull();
      expect(within(modal).queryByTestId("install-wallet-link")).toBeNull();
      const options = within(modal).getAllByTestId("connector-option");
      expect(options.map((option) => option.getAttribute("data-connector-id"))).toContain(
        STUB_WALLET_INFO.rdns,
      );
    });
  });
});
