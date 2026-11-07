import { act, waitFor } from "@testing-library/react";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, describe, expect, it } from "vitest";

import { createWagmiConfig } from "@/config/wagmi";
import { useEnsureChain } from "@/hooks/use-ensure-chain";
import { useSelectedChain } from "@/providers/selected-chain-provider";

import { USER_REJECTED_CODE, createStubEip1193, providerRpcError } from "../support/stub-eip1193";
import {
  CHAIN_SWITCH_METHODS,
  TEST_ACCOUNT,
  UNSUPPORTED_CHAIN_ID,
  callEnsureChain,
  clearCookies,
  connectedChainId,
  createNoopWagmiStorage,
  currentButton,
  mockConnector,
  renderAppHook,
  requestsSince,
  stubConnector,
  waitForConnectedOn,
} from "../support/wagmi-harness";

// 선택 체인을 바꾸면 `gopepe-chain` 쿠키가 기록되므로 테스트마다 지운다.
afterEach(clearCookies);

function useEnsureChainProbe() {
  const ensureChain = useEnsureChain();
  const { selectedChainId, setSelectedChainId } = useSelectedChain();
  return { ensureChain, selectedChainId, setSelectedChainId };
}

function switchParamsChainId(params: unknown): string {
  return (params as [{ chainId: string }])[0].chainId;
}

describe("체인 전환 — 앱에 연결된 체인을 선택 체인에 맞춘다", () => {
  describe("전환이 끝나는 경우", () => {
    /**
     * @spec DoD-13
     * @given mock 커넥터로 Ethereum에 연결돼 있고, 훅이 마운트된 뒤 선택 체인을 Ethereum에서 표본 체인으로 바꾼 상태다. 표본: Base, Arbitrum을 하나씩 반복한다
     * @when ensureChain을 호출한다
     * @then ensureChain이 resolve한다
     * @then resolve 시점에 앱에 연결된 체인이 호출 전의 선택 체인과 같다
     * @then 선택 체인은 호출 전 값 그대로다
     */
    it("[DoD-13] 앱에 연결된 체인을 선택 체인으로 전환한 뒤 resolve한다", async () => {
      for (const sampleChainId of [base.id, arbitrum.id]) {
        const config = createWagmiConfig({
          connectors: [mockConnector({ defaultConnected: true, reconnect: true })],
          storage: createNoopWagmiStorage(),
          multiInjectedProviderDiscovery: false,
        });
        const { result, unmount } = renderAppHook(useEnsureChainProbe, {
          config,
          initialChainId: mainnet.id,
        });
        await waitForConnectedOn(config, mainnet.id);

        // 훅이 마운트된 뒤 선택 체인을 바꾼다.
        act(() => result.current.setSelectedChainId(sampleChainId));
        expect(result.current.selectedChainId, `표본 ${sampleChainId}`).toBe(sampleChainId);

        const outcome = await callEnsureChain(result.current.ensureChain, config);

        expect(outcome.status, `표본 ${sampleChainId}`).toBe("resolved");
        expect(outcome.connectedChainIdAtSettle, `표본 ${sampleChainId}`).toBe(sampleChainId);
        expect(result.current.selectedChainId, `표본 ${sampleChainId}`).toBe(sampleChainId);

        unmount();
      }
    });

    /**
     * @spec DoD-13 EC-5
     * @given 스텁 EIP-1193 provider로 연결돼 있고, 훅 마운트 시에는 앱에 연결된 체인이 선택 체인과 같으며, 마운트 뒤 지갑의 체인 변경 이벤트로 지갑이 비지원 체인(1, 8453, 42161 외의 체인 ID)이 된 상태다
     * @when ensureChain을 호출한다
     * @then 지갑이 선택 체인으로의 전환 요청을 받는다
     * @then resolve 시점에 앱에 연결된 체인이 선택 체인과 같다
     * @then 선택 체인은 그대로다
     */
    it("[DoD-13][EC-5] 지갑이 비지원 체인에 있어도 선택 체인으로 전환한 뒤 resolve한다", async () => {
      const stub = createStubEip1193({
        chainId: mainnet.id,
        accounts: [TEST_ACCOUNT],
        authorized: true,
        knownChainIds: [mainnet.id, UNSUPPORTED_CHAIN_ID],
      });
      const config = createWagmiConfig({
        connectors: [stubConnector(stub)],
        storage: createNoopWagmiStorage(),
        multiInjectedProviderDiscovery: false,
      });
      const { result } = renderAppHook(useEnsureChainProbe, { config, initialChainId: mainnet.id });
      await waitForConnectedOn(config, mainnet.id);

      // 마운트 뒤 지갑 쪽에서 비지원 체인으로 바뀐다.
      act(() => stub.changeChain(UNSUPPORTED_CHAIN_ID));
      await waitFor(() => expect(connectedChainId(config)).toBe(UNSUPPORTED_CHAIN_ID));
      const requestCountBefore = stub.requests.length;

      const outcome = await callEnsureChain(result.current.ensureChain, config);

      const switchRequests = requestsSince(stub, requestCountBefore, [
        "wallet_switchEthereumChain",
      ]);
      expect(switchRequests.map((request) => switchParamsChainId(request.params))).toContain("0x1");
      expect(outcome.status).toBe("resolved");
      expect(outcome.connectedChainIdAtSettle).toBe(mainnet.id);
      expect(result.current.selectedChainId).toBe(mainnet.id);
    });

    /**
     * @spec DoD-13
     * @given 스텁 EIP-1193 provider로 연결돼 있고, 훅 마운트 시에는 선택 체인이 앱에 연결된 체인과 다르며, 훅이 마운트된 뒤 선택 체인을 바꿔 연결된 체인과 같아진 상태다
     * @when ensureChain을 호출한다
     * @then ensureChain이 resolve한다
     * @then 지갑이 전환 요청을 받지 않는다
     */
    it("[DoD-13] 이미 선택 체인이면 지갑 요청 없이 resolve한다", async () => {
      const stub = createStubEip1193({
        chainId: base.id,
        accounts: [TEST_ACCOUNT],
        authorized: true,
        knownChainIds: [mainnet.id, base.id, arbitrum.id],
      });
      const config = createWagmiConfig({
        connectors: [stubConnector(stub)],
        storage: createNoopWagmiStorage(),
        multiInjectedProviderDiscovery: false,
      });
      // 마운트 시 선택 체인(Ethereum)은 연결된 체인(Base)과 다르다.
      const { result } = renderAppHook(useEnsureChainProbe, { config, initialChainId: mainnet.id });
      await waitForConnectedOn(config, base.id);

      act(() => result.current.setSelectedChainId(base.id));
      expect(result.current.selectedChainId).toBe(base.id);
      const requestCountBefore = stub.requests.length;

      const outcome = await callEnsureChain(result.current.ensureChain, config);

      expect(outcome.status).toBe("resolved");
      expect(requestsSince(stub, requestCountBefore, CHAIN_SWITCH_METHODS)).toEqual([]);
    });
  });

  describe("전환이 끝나지 못하는 경우", () => {
    /**
     * @spec EC-3
     * @given mock 커넥터로 연결돼 있고 선택 체인이 연결된 체인과 다르며, 체인 전환이 끝나지 못한다(`switchChainError`). 표본: 거부, 거부가 아닌 오류를 하나씩 반복한다
     * @when ensureChain을 호출한다
     * @then ensureChain이 reject한다
     * @then 선택 체인은 호출 전 값 그대로다
     * @then 앱에 연결된 체인은 호출 전 값 그대로다
     */
    it("[EC-3] 전환이 거부나 오류로 끝나면 선택 체인과 연결된 체인을 유지하고 reject한다", async () => {
      // 거부: mock 커넥터가 UserRejectedRequestError를 던진다. 오류: 거부가 아닌 오류를 그대로 던진다.
      const samples = [
        { label: "거부", switchChainError: true },
        { label: "거부가 아닌 오류", switchChainError: new Error("switch chain failed") },
      ] as const;

      for (const { label, switchChainError } of samples) {
        const config = createWagmiConfig({
          connectors: [
            mockConnector({ defaultConnected: true, reconnect: true, switchChainError }),
          ],
          storage: createNoopWagmiStorage(),
          multiInjectedProviderDiscovery: false,
        });
        const { result, unmount } = renderAppHook(useEnsureChainProbe, {
          config,
          initialChainId: base.id,
        });
        await waitForConnectedOn(config, mainnet.id);

        const outcome = await callEnsureChain(result.current.ensureChain, config);

        expect(outcome.status, label).toBe("rejected");
        expect(result.current.selectedChainId, label).toBe(base.id);
        expect(connectedChainId(config), label).toBe(mainnet.id);

        unmount();
      }
    });

    /**
     * @spec EC-3
     * @given 지갑이 연결돼 있지 않다. 표본: 선택 체인 Ethereum, Base를 하나씩 반복한다
     * @when ensureChain을 호출한다
     * @then ensureChain이 reject한다
     */
    it("[EC-3] 미연결 상태에서 호출하면 reject한다", async () => {
      for (const sampleChainId of [mainnet.id, base.id]) {
        const config = createWagmiConfig({
          connectors: [mockConnector({ defaultConnected: false, reconnect: false })],
          storage: createNoopWagmiStorage(),
          multiInjectedProviderDiscovery: false,
        });
        const { result, unmount } = renderAppHook(useEnsureChainProbe, {
          config,
          initialChainId: sampleChainId,
        });
        // 복원이 끝나 미연결 상태가 된 뒤에 호출한다.
        await waitFor(() => expect(currentButton("primary-button").state).toBe("disconnected"));

        const outcome = await callEnsureChain(result.current.ensureChain, config);

        expect(outcome.status, `선택 체인 ${sampleChainId}`).toBe("rejected");

        unmount();
      }
    });
  });

  describe("지갑에 선택 체인이 없는 경우", () => {
    /**
     * @spec EC-4
     * @given 스텁 EIP-1193 provider로 연결돼 있고, 지갑에 선택 체인이 없어 전환 요청이 체인 없음 오류로 끝나며, 체인 추가 요청은 수락된다
     * @when ensureChain을 호출한다
     * @then 지갑이 전환 요청 뒤에 선택 체인의 체인 추가 요청을 받는다
     * @then ensureChain이 resolve한다
     * @then resolve 시점에 앱에 연결된 체인이 선택 체인과 같다
     */
    it("[EC-4] 체인 추가를 시도하고 앱에 연결된 체인을 선택 체인으로 전환한다", async () => {
      // 지갑에는 Ethereum만 등록돼 있다. 체인 추가 요청은 기본 동작(등록 후 그 체인으로 전환)으로 수락된다.
      const stub = createStubEip1193({
        chainId: mainnet.id,
        accounts: [TEST_ACCOUNT],
        authorized: true,
        knownChainIds: [mainnet.id],
      });
      const config = createWagmiConfig({
        connectors: [stubConnector(stub)],
        storage: createNoopWagmiStorage(),
        multiInjectedProviderDiscovery: false,
      });
      const { result } = renderAppHook(useEnsureChainProbe, { config, initialChainId: base.id });
      await waitForConnectedOn(config, mainnet.id);
      const requestCountBefore = stub.requests.length;

      const outcome = await callEnsureChain(result.current.ensureChain, config);

      const requests = requestsSince(stub, requestCountBefore, CHAIN_SWITCH_METHODS);
      const switchIndex = requests.findIndex(
        (request) =>
          request.method === "wallet_switchEthereumChain" &&
          switchParamsChainId(request.params) === "0x2105",
      );
      const addIndex = requests.findIndex(
        (request) => request.method === "wallet_addEthereumChain",
      );
      expect(switchIndex).toBeGreaterThanOrEqual(0);
      expect(addIndex).toBeGreaterThan(switchIndex);

      const [addParameter] = requests[addIndex]!.params as [{ chainId: string; rpcUrls: string[] }];
      expect(addParameter.chainId).toBe("0x2105");
      // 지갑에 넘기는 RPC는 운영 viem 기본값이며 앱의 프록시 경로가 아니다.
      expect(addParameter.rpcUrls).toEqual([base.rpcUrls.default.http[0]]);
      expect(addParameter.rpcUrls.some((url) => url.includes("/api/rpc/"))).toBe(false);

      expect(outcome.status).toBe("resolved");
      expect(outcome.connectedChainIdAtSettle).toBe(base.id);
    });

    /**
     * @spec EC-4
     * @given 스텁 EIP-1193 provider로 연결돼 있고, 지갑에 선택 체인이 없어 전환 요청이 체인 없음 오류로 끝나며, 체인 추가 요청은 거부된다
     * @when ensureChain을 호출한다
     * @then 지갑이 선택 체인의 체인 추가 요청을 받는다
     * @then ensureChain이 reject한다
     */
    it("[EC-4] 체인 추가를 거부하면 reject한다", async () => {
      const stub = createStubEip1193({
        chainId: mainnet.id,
        accounts: [TEST_ACCOUNT],
        authorized: true,
        knownChainIds: [mainnet.id],
      });
      stub.setHandler("wallet_addEthereumChain", () => {
        throw providerRpcError(USER_REJECTED_CODE, "User rejected the request.");
      });
      const config = createWagmiConfig({
        connectors: [stubConnector(stub)],
        storage: createNoopWagmiStorage(),
        multiInjectedProviderDiscovery: false,
      });
      const { result } = renderAppHook(useEnsureChainProbe, { config, initialChainId: base.id });
      await waitForConnectedOn(config, mainnet.id);
      const requestCountBefore = stub.requests.length;

      const outcome = await callEnsureChain(result.current.ensureChain, config);

      const addRequests = requestsSince(stub, requestCountBefore, ["wallet_addEthereumChain"]);
      expect(addRequests.map((request) => switchParamsChainId(request.params))).toContain("0x2105");
      expect(outcome.status).toBe("rejected");
    });
  });
});
