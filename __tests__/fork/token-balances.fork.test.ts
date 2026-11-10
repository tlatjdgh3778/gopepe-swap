import {
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  getAddress,
  http,
} from "viem";
import { mainnet } from "viem/chains";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FORK_TEST_ANVIL_PORT } from "@/config/e2e";
import { NATIVE_ETH_ADDRESS, PINNED_TOKENS_BY_CHAIN, TOKENS_BY_CHAIN } from "@/config/tokens";
import { handleRpcProxyRequest } from "@/lib/rpc-proxy";
import { readTokenListBalances } from "@/lib/token-balances";
import { sortTokenList } from "@/lib/token-list";

// global-setup.ts가 전용 포트에 띄운 Ethereum anvil 포크(상수로 고정한 포크 블록).
// 판정 대상 일괄 읽기는 viem `http` transport의 `fetchFn`을 프록시 핸들러에 연결해 보낸다.
// anvil 직접 호출은 판정과 분리한 예열 읽기와 EC-14 실패 토큰 표본의 상태 변경·되돌림에만 쓴다.
const ANVIL_URL = `http://127.0.0.1:${FORK_TEST_ANVIL_PORT}`;

// 같은 사이트 판정(Origin과 Host 일치)을 통과하는 요청 출처.
const SAME_SITE_HOST = "localhost:3000";
const SAME_SITE_ORIGIN = `http://${SAME_SITE_HOST}`;
const PROXY_URL = `${SAME_SITE_ORIGIN}/api/rpc/1`;

const ETHEREUM_TOKENS = TOKENS_BY_CHAIN[1];
const ETHEREUM_PINNED_TOKENS = PINNED_TOKENS_BY_CHAIN[1];
const SNAPSHOT_TOKEN_COUNT = 484;

// 판정 계정: Uniswap V3 USDC/WETH 풀. 이 풀의 USDC 잔액은 포크 블록(26250000)과 메인넷 최신 블록에서 다르므로,
// 일괄 읽기가 공개 RPC로 넘어갔다면 이 값과 달라진다(T-1 확인값).
const ACCOUNT: Address = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
const USDC_ADDRESS: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ACCOUNT_USDC_AT_FORK_BLOCK = 59_421_213_915_816n;

// EC-14 실패 토큰 표본. 포크에는 `balanceOf`가 실패하는 토큰이 없어(T-1) 코드를 바꿔 만든다.
const LINK_ADDRESS: Address = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const PEPE_ADDRESS: Address = "0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const REVERT_BYTECODE: Hex = "0x60006000fd"; // PUSH1 0 PUSH1 0 REVERT
const EMPTY_BYTECODE: Hex = "0x";

// cold 포크의 484개 일괄 읽기는 업체 RPC에서 상태를 가져와 수십 초~수 분이 걸린다(T-1: 약 95초).
const WARM_UP_TIMEOUT_MS = 240_000;

const anvilClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: WARM_UP_TIMEOUT_MS - 10_000, retryCount: 0 }),
});

const anvilTestClient = createTestClient({
  chain: mainnet,
  mode: "anvil",
  transport: http(ANVIL_URL, { retryCount: 0 }),
});

type ProxiedCall = {
  methods: string[];
  status: number;
  hasRpcError: boolean;
};

// 프록시 핸들러를 거치는 요청 기록.
let proxiedCalls: ProxiedCall[] = [];

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function rpcMethodsOf(body: string): string[] {
  const payload = JSON.parse(body) as { method?: unknown } | { method?: unknown }[];
  const items = Array.isArray(payload) ? payload : [payload];
  return items.map((item) => String(item.method));
}

function containsRpcError(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some(
    (item) => typeof item !== "object" || item === null || "error" in item || !("result" in item),
  );
}

// viem의 모든 RPC 요청을 같은 사이트 `POST /api/rpc/1` 요청으로 만들어 프록시 핸들러에 넘긴다.
async function proxyFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === "string" ? init.body : "";
  const request = new Request(PROXY_URL, {
    method: "POST",
    headers: {
      ...headersToRecord(init?.headers),
      host: SAME_SITE_HOST,
      origin: SAME_SITE_ORIGIN,
    },
    body,
    signal: init?.signal,
  });

  const response = await handleRpcProxyRequest(request, "1");
  const hasRpcError = await response
    .clone()
    .json()
    .then(containsRpcError, () => true);
  proxiedCalls.push({ methods: rpcMethodsOf(body), status: response.status, hasRpcError });
  return response;
}

const proxiedClient = createPublicClient({
  chain: mainnet,
  transport: http(PROXY_URL, { fetchFn: proxyFetch, timeout: 25_000, retryCount: 0 }),
});

function sameAddress(a: Address, b: Address): boolean {
  return getAddress(a) === getAddress(b);
}

function findToken(address: Address) {
  const token = ETHEREUM_TOKENS.find((candidate) => sameAddress(candidate.address, address));
  if (!token) throw new Error(`Ethereum 토큰 목록에 ${address}가 없습니다.`);
  return token;
}

describe("토큰 목록 잔액 — Ethereum 포크에서 스냅샷 토큰 전체의 잔액을 프록시를 거쳐 한 번에 읽는다", () => {
  // 판정과 분리한 anvil 직접 사전 읽기. cold 포크에서 프록시 상류 시간 제한(5초)을 넘어
  // 공개 RPC로 넘어가지 않도록, 판정 계정의 484개 토큰 잔액 상태를 미리 포크에 올린다.
  beforeAll(async () => {
    await readTokenListBalances(anvilClient, { account: ACCOUNT, tokens: ETHEREUM_TOKENS });
  }, WARM_UP_TIMEOUT_MS);

  beforeEach(() => {
    vi.stubEnv("ETH_MAINNET_RPC_URL", ANVIL_URL);
    proxiedCalls = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("스냅샷 토큰 전체를 일괄로 읽을 때", () => {
    /**
     * @spec DoD-24
     * @given 프록시의 Ethereum 대상이 상수로 고정한 포크 블록의 anvil 포크로 맞춰져 있고, 일괄 읽기의 RPC 요청은 viem `http` transport의 `fetchFn`으로 같은 사이트 `POST /api/rpc/1` 요청이 되어 프록시 핸들러를 거친다
     * @when 한 계정에 대해 Ethereum 스냅샷 토큰 484개의 잔액을 일괄 읽기로 읽는다
     * @then 일괄 읽기가 실패 없이 끝난다
     * @then 스냅샷 토큰 484개 각각의 읽기 결과를 돌려준다
     * @then 일괄 읽기의 RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답한다
     * @then 응답이 고정한 포크 블록 기준이어서 공개 RPC로 넘어간 응답과 구분된다
     */
    it("[DoD-24] 스냅샷 토큰 484개의 잔액 일괄 읽기가 프록시를 거쳐 성공한다", async () => {
      const snapshotTokens = ETHEREUM_TOKENS.filter(
        (token) => token.address !== NATIVE_ETH_ADDRESS,
      );
      expect(snapshotTokens).toHaveLength(SNAPSHOT_TOKEN_COUNT);

      // 일괄 읽기가 실패 없이 끝난다(throw하지 않는다).
      const balances = await readTokenListBalances(proxiedClient, {
        account: ACCOUNT,
        tokens: ETHEREUM_TOKENS,
      });

      // 스냅샷 토큰 484개 각각의 읽기 결과(정수 잔액)가 있다.
      const withoutResult = snapshotTokens.filter(
        (token) => typeof balances.get(token.address) !== "bigint",
      );
      expect(withoutResult.map((token) => token.symbol)).toEqual([]);

      // RPC 요청이 모두 프록시 핸들러를 거쳐 정상 응답했다.
      expect(proxiedCalls.length).toBeGreaterThan(0);
      for (const call of proxiedCalls) {
        expect(call.status, call.methods.join(",")).toBe(200);
        expect(call.hasRpcError, call.methods.join(",")).toBe(false);
      }
      expect(proxiedCalls.flatMap((call) => call.methods)).toContain("eth_call");

      // 고정 포크 블록 기준의 값이다. 공개 RPC(메인넷 최신 블록)로 넘어갔다면 이 값과 다르다.
      expect(balances.get(findToken(USDC_ADDRESS).address)).toBe(ACCOUNT_USDC_AT_FORK_BLOCK);
    });
  });

  describe("토큰 하나의 잔액 읽기가 실패할 때", () => {
    const failingTokens = [findToken(LINK_ADDRESS), findToken(PEPE_ADDRESS)];
    let snapshotId: Hex | undefined;

    // 사용자 확정 경계: 실패 토큰 표본을 만드는 anvil 상태 변경. 끝에 snapshot/revert로 되돌린다.
    beforeEach(async () => {
      snapshotId = await anvilTestClient.snapshot();
      await anvilTestClient.setCode({ address: LINK_ADDRESS, bytecode: REVERT_BYTECODE });
      await anvilTestClient.setCode({ address: PEPE_ADDRESS, bytecode: EMPTY_BYTECODE });
    });

    afterEach(async () => {
      if (snapshotId !== undefined) {
        const id = snapshotId;
        snapshotId = undefined;
        await anvilTestClient.revert({ id });
      }
    });

    /**
     * @spec EC-14
     * @given 고정 토큰 5개가 아닌 스냅샷 토큰 중 T-1에서 확인한 포크 기준 `balanceOf` 실패 토큰(없으면 사용자 확정 경계에 따라 anvil 상태 변경으로 만든 실패 토큰, 테스트 끝에 snapshot/revert로 되돌림)이 있고, 일괄 읽기의 RPC 요청은 프록시 핸들러를 거친다
     * @when 그 토큰을 포함한 스냅샷 토큰 전체의 잔액을 일괄 읽기로 읽고, 그 결과로 연결 상태의 모달 목록 순서를 정한다
     * @then 실패 토큰의 행만 잔액이 없다
     * @then 읽기가 실패하지 않은 나머지 토큰은 잔액을 가진다
     * @then 실패 토큰은 나머지 그룹(DoD-9의 세 번째 그룹)에 놓인다
     */
    it("[EC-14] 잔액 읽기에 실패한 토큰만 잔액 없이 나머지 그룹에 놓인다", async () => {
      // 표본 전제: 실패 토큰은 고정 토큰이 아니다.
      for (const token of failingTokens) {
        expect(
          ETHEREUM_PINNED_TOKENS.some((pinned) => sameAddress(pinned.address, token.address)),
          token.symbol,
        ).toBe(false);
      }

      const balances = await readTokenListBalances(proxiedClient, {
        account: ACCOUNT,
        tokens: ETHEREUM_TOKENS,
      });
      const sorted = sortTokenList(ETHEREUM_TOKENS, ETHEREUM_PINNED_TOKENS, balances);

      // 일괄 읽기는 프록시를 거쳤다.
      expect(proxiedCalls.length).toBeGreaterThan(0);

      const failingAddresses = failingTokens.map((token) => token.address);
      const isFailing = (address: Address) =>
        failingAddresses.some((failing) => sameAddress(failing, address));

      // 실패 토큰의 행만 잔액이 없다.
      const withoutBalance = ETHEREUM_TOKENS.filter((token) => !balances.has(token.address));
      expect(withoutBalance.map((token) => token.address).sort()).toEqual(
        [...failingAddresses].sort(),
      );

      // 읽기가 실패하지 않은 나머지 토큰은 잔액(정수)을 가진다.
      const succeeded = ETHEREUM_TOKENS.filter((token) => !isFailing(token.address));
      const succeededWithoutBalance = succeeded.filter(
        (token) => typeof balances.get(token.address) !== "bigint",
      );
      expect(succeededWithoutBalance.map((token) => token.symbol)).toEqual([]);

      // 실패 토큰은 DoD-9의 세 번째 그룹(고정 토큰, 잔액이 0보다 큰 토큰 다음)에 놓인다.
      expect(sorted).toHaveLength(ETHEREUM_TOKENS.length);
      const pinnedCount = ETHEREUM_TOKENS.filter((token) =>
        ETHEREUM_PINNED_TOKENS.some((pinned) => sameAddress(pinned.address, token.address)),
      ).length;
      const positiveCount = ETHEREUM_TOKENS.filter((token) => {
        if (ETHEREUM_PINNED_TOKENS.some((pinned) => sameAddress(pinned.address, token.address))) {
          return false;
        }
        const balance = balances.get(token.address);
        return balance !== undefined && balance > 0n;
      }).length;
      const restGroupStart = pinnedCount + positiveCount;

      for (const token of failingTokens) {
        const index = sorted.findIndex((candidate) =>
          sameAddress(candidate.address, token.address),
        );
        expect(index, token.symbol).toBeGreaterThanOrEqual(restGroupStart);
      }
    });
  });
});
