import { act, waitFor } from "@testing-library/react";
import { base, mainnet } from "viem/chains";
import { afterEach, describe, expect, it } from "vitest";

import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";

import { createStubEip1193 } from "../support/stub-eip1193";
import {
  CHAIN_SWITCH_METHODS,
  TEST_ACCOUNT,
  UNSUPPORTED_CHAIN_ID,
  clearCookies,
  connectedChainId,
  createNoopWagmiStorage,
  readCookie,
  renderAppHook,
  requestsSince,
  stubConnector,
  waitForConnectedOn,
  yieldToPendingWork,
} from "../support/wagmi-harness";

// 스펙 §4.2의 선택 체인 쿠키 이름
const SELECTED_CHAIN_COOKIE = "gopepe-chain";

afterEach(clearCookies);

describe("선택 체인 — 선택 체인이 앱의 기준으로 남는다", () => {
  describe("지갑 쪽에서 체인이 바뀌는 경우", () => {
    /**
     * @spec EC-5
     * @given 스텁 EIP-1193 provider로 연결돼 있고 선택 체인이 Ethereum이다. 표본: 지갑의 새 체인이 지원 체인 Base, 비지원 체인(1, 8453, 42161 외의 체인 ID)인 경우를 하나씩 반복한다
     * @when 지갑이 체인 변경 이벤트를 보낸다
     * @then 앱에 연결된 체인이 지갑이 알린 체인 ID로 바뀐다
     * @then 선택 체인은 Ethereum 그대로다
     * @then 선택 체인 쿠키 값은 바뀌지 않는다
     * @then 지갑이 전환 요청을 받지 않는다
     */
    it("[EC-5] 지갑의 체인이 바뀌어도 선택 체인을 유지한다", async () => {
      for (const sampleChainId of [base.id, UNSUPPORTED_CHAIN_ID]) {
        // 선택 체인 Ethereum이 쿠키에 저장돼 있는 상태(서버가 이 값으로 initialChainId를 정한다).
        document.cookie = `${SELECTED_CHAIN_COOKIE}=${mainnet.id}; path=/`;
        const stub = createStubEip1193({
          chainId: mainnet.id,
          accounts: [TEST_ACCOUNT],
          authorized: true,
          knownChainIds: [mainnet.id, base.id, UNSUPPORTED_CHAIN_ID],
        });
        const config = createWagmiConfig({
          connectors: [stubConnector(stub)],
          storage: createNoopWagmiStorage(),
          multiInjectedProviderDiscovery: false,
        });
        const { result, unmount } = renderAppHook(useSelectedChain, {
          config,
          initialChainId: mainnet.id,
        });
        await waitForConnectedOn(config, mainnet.id);
        const requestCountBefore = stub.requests.length;

        act(() => stub.changeChain(sampleChainId));

        await waitFor(() =>
          expect(connectedChainId(config), `표본 ${sampleChainId}`).toBe(sampleChainId),
        );
        // 체인 변경에 반응하는 effect·요청이 있다면 진행되도록 기다린 뒤 판정한다.
        await yieldToPendingWork();

        expect(connectedChainId(config), `표본 ${sampleChainId}`).toBe(sampleChainId);
        expect(result.current.selectedChainId, `표본 ${sampleChainId}`).toBe(mainnet.id);
        expect(readCookie(SELECTED_CHAIN_COOKIE), `표본 ${sampleChainId}`).toBe(String(mainnet.id));
        expect(
          requestsSince(stub, requestCountBefore, CHAIN_SWITCH_METHODS),
          `표본 ${sampleChainId}`,
        ).toEqual([]);

        unmount();
        clearCookies();
      }
    });
  });
});
