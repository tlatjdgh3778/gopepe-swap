import { createPublicClient, getAddress, http, parseAbi, toHex } from "viem";
import { mainnet } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { FORK_BLOCK_NUMBER, FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";

// global-setup.ts가 전용 포트에 띄운 Ethereum anvil 포크. 모든 호출은 읽기 전용이다.
const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;
const FORK_BLOCK = BigInt(FORK_BLOCK_NUMBER);
const ETHEREUM_CONTRACTS = CONTRACTS_BY_CHAIN[1];

const forkClient = createPublicClient({ chain: mainnet, transport: http(ANVIL_URL) });

// Uniswap V3 QuoterV2가 노출하는 PeripheryImmutableState 조회 함수.
const quoterImmutablesAbi = parseAbi([
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
]);

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;

describe("Ethereum 포크 — 이후 기능이 올라갈 실제 체인 환경을 제공한다", () => {
  describe("포크에 직접 요청할 때", () => {
    /**
     * @spec DoD-5
     * @given 원본 체인 ID를 유지하고 포크 블록을 상수로 고정한 Ethereum anvil 포크가 전용 포트에 떠 있다
     * @when 포크에 체인 ID를 조회한다
     * @then 체인 ID 1로 응답한다
     */
    it("[DoD-5] Ethereum 포크가 체인 ID 1로 응답한다", async () => {
      const chainId = await forkClient.getChainId();

      expect(chainId).toBe(1);
    });

    /**
     * @spec DoD-6
     * @given 상수로 고정한 포크 블록의 Ethereum anvil 포크와 Ethereum config의 컨트랙트 주소 표본(QuoterV2, Factory, WETH)을 하나씩 반복한다
     * @when 포크에 해당 주소의 코드를 `eth_getCode`로 조회한다
     * @then 각 주소에 코드가 있다
     */
    it("[DoD-6] Ethereum config의 컨트랙트 주소에 포크 기준 코드가 있다", async () => {
      const samples = [
        ["QuoterV2", ETHEREUM_CONTRACTS.quoterV2],
        ["Factory", ETHEREUM_CONTRACTS.factory],
        ["WETH", ETHEREUM_CONTRACTS.weth],
      ] as const;

      for (const [name, address] of samples) {
        const code = await forkClient.getCode({ address, blockNumber: FORK_BLOCK });

        // viem은 빈 코드(`0x`)를 undefined로 돌려준다.
        expect(code, `${name} ${address}`).toBeDefined();
        expect(code, `${name} ${address}`).not.toBe("0x");
      }
    });

    /**
     * @spec DoD-23
     * @given 상수로 고정한 포크 블록의 Ethereum anvil 포크와 Ethereum config의 QuoterV2, Factory, WETH 주소가 있다
     * @when 포크의 QuoterV2에 Factory와 WETH 값을 조회한다
     * @then 돌려준 Factory 값이 Ethereum config의 Factory와 같다
     * @then 돌려준 WETH 값이 Ethereum config의 WETH와 같다
     */
    it("[DoD-23] Ethereum config의 Factory와 WETH가 포크의 QuoterV2가 돌려주는 값과 같다", async () => {
      const quoter = { address: ETHEREUM_CONTRACTS.quoterV2, abi: quoterImmutablesAbi } as const;

      const factory = await forkClient.readContract({
        ...quoter,
        functionName: "factory",
        blockNumber: FORK_BLOCK,
      });
      const weth = await forkClient.readContract({
        ...quoter,
        functionName: "WETH9",
        blockNumber: FORK_BLOCK,
      });

      expect(getAddress(factory)).toBe(getAddress(ETHEREUM_CONTRACTS.factory));
      expect(getAddress(weth)).toBe(getAddress(ETHEREUM_CONTRACTS.weth));
    });
  });

  describe("프록시를 거쳐 요청할 때", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /**
     * @spec DoD-17
     * @given 프록시의 Ethereum 대상이 상수로 고정한 포크 블록의 anvil 포크로 맞춰져 있다
     * @when 같은 사이트 요청으로 `POST /api/rpc/1`에 허용 메서드로 최신(`latest`) 블록 조회를 보낸다
     * @then 프록시가 정상 응답한다
     * @then 응답의 블록이 고정한 포크 블록이어서 공개 RPC의 응답과 구분된다
     */
    it("[DoD-17] 프록시를 거친 요청이 Ethereum 포크에서 정상 응답한다", async () => {
      vi.stubEnv("ETH_MAINNET_RPC_URL", ANVIL_URL);
      const request = new Request(`${SAME_SITE_ORIGIN}/api/rpc/1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: SAME_SITE_HOST,
          origin: SAME_SITE_ORIGIN,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        }),
      });

      const response = await handleRpcProxyRequest(request, "1");
      const body = (await response.json()) as {
        id?: unknown;
        error?: unknown;
        result?: { number?: string } | null;
      };

      expect(response.ok).toBe(true);
      expect(body.error).toBeUndefined();
      expect(body.id).toBe(1);
      // anvil은 트랜잭션이 없으면 채굴하지 않으므로 `latest`가 고정 포크 블록에 머문다.
      // 공개 RPC로 넘어갔다면 메인넷 최신 블록이 돌아와 이 값과 다르다.
      expect(body.result?.number).toBe(toHex(FORK_BLOCK));
    });
  });
});
