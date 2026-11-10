import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  multicall3Abi,
  numberToHex,
} from "viem";
import { arbitrum, base, mainnet } from "viem/chains";

import type { SupportedChainId } from "@/config/chains";
import { NATIVE_ETH_ADDRESS } from "@/config/tokens";
import { rpcProxyPath } from "@/config/wagmi";

import { type RpcFetchStub, type StubCall, installRpcFetchStub } from "./rpc-fetch-stub";

// 잔액 통합 테스트(T-6)의 RPC 경계.
// 앱의 RPC 프록시 경로(`/api/rpc/<체인>`)로 가는 전역 fetch만 스텁으로 바꾸고, JSON-RPC 항목 단위로 응답·집계한다.
// - `eth_getBalance`: 네이티브 ETH 잔액
// - 토큰 주소로 가는 `balanceOf` `eth_call`: 카드 ERC-20 잔액(또는 계약별 개별 호출)
// - Multicall3 aggregate3 `eth_call`: calldata를 디코드해 묶인 `balanceOf`마다 토큰별 잔액을 돌려준다
// 요청 수는 HTTP 요청이 아니라 JSON-RPC 항목 수로 센다(배치 배열도 항목마다 센다).

export const STUB_CHAIN_IDS: readonly SupportedChainId[] = [mainnet.id, base.id, arbitrum.id];

export type BalanceRpcKind = "eth_getBalance" | "balanceOf" | "aggregate3" | "other";

export type BalanceRpcRequest = {
  // 받은 순서(0부터)
  seq: number;
  chainId: SupportedChainId;
  method: string;
  kind: BalanceRpcKind;
  // 잔액을 읽는 계정. 잔액 요청이 아니면 undefined
  account: Address | undefined;
  // 읽는 토큰. `eth_getBalance`는 [NATIVE_ETH_ADDRESS], `balanceOf`는 [토큰], aggregate3는 묶인 토큰들
  tokens: Address[];
  // 받은 시각(`Date.now()`, 가짜 타이머에서는 가짜 시계)
  at: number;
  status: "pending" | "ok" | "failed";
};

export type BalanceQuery = {
  chainId: SupportedChainId;
  account: Address;
  token: Address;
};

export type BalanceFn = (query: BalanceQuery) => bigint;
export type RequestMatcher = (request: BalanceRpcRequest) => boolean;

export type HoldGate = {
  // 붙잡은 요청을 모두 풀고, 이후 요청은 붙잡지 않는다.
  release(): void;
  // 지금까지 이 게이트가 붙잡은 요청 수
  readonly heldCount: number;
};

export type BalanceRpcStub = {
  fetchStub: RpcFetchStub;
  // 잔액 규칙을 바꾼다. 응답 시점의 규칙으로 응답한다.
  setBalances(fn: BalanceFn): void;
  // 현재 규칙의 잔액
  balanceOf(query: BalanceQuery): bigint;
  // 조건에 맞는 요청을 JSON-RPC 오류(-32000, viem이 재시도하지 않는 코드)로 실패시킨다. null이면 해제한다.
  failWhen(matcher: RequestMatcher | null): void;
  // aggregate3 안의 개별 `balanceOf` 결과를 실패(`success: false`)로 만든다. null이면 해제한다.
  failTokenWhen(predicate: ((query: BalanceQuery) => boolean) | null): void;
  // 조건에 맞는 요청의 응답을 `release()` 전까지 붙잡는다.
  hold(matcher: RequestMatcher): HoldGate;
  // 받은 요청(받은 순서). 조건을 주면 맞는 요청만.
  requests(matcher?: RequestMatcher): BalanceRpcRequest[];
};

// 2^61 - 1 (소수). 토큰 주소마다 서로 다른 값이 나오도록 나머지를 쓴다.
const TOKEN_MODULUS = 2_305_843_009_213_693_951n;

// 기본 잔액 규칙: 체인·계정·토큰마다 다른 양의 값. 청크 매핑이 어긋나면 다른 토큰의 값이 드러난다.
export function defaultBalance({ chainId, account, token }: BalanceQuery): bigint {
  const tokenPart = BigInt(token.toLowerCase()) % TOKEN_MODULUS;
  const accountPart = BigInt(account.toLowerCase()) % 1_009n;
  return (BigInt(chainId) * 10_000n + accountPart + 1n) * 10n ** 19n + tokenPart + 1n;
}

// 일부 토큰(소문자 주소 키)만 지정하고 나머지는 `fallback` 규칙을 쓰는 잔액 규칙.
export function balancesWith(
  overrides: Readonly<Record<string, bigint>>,
  fallback: BalanceFn = defaultBalance,
): BalanceFn {
  const lowered = new Map(
    Object.entries(overrides).map(([token, value]) => [token.toLowerCase(), value]),
  );
  return (query) => lowered.get(query.token.toLowerCase()) ?? fallback(query);
}

// 요청 조건 모음
export const match = {
  kind:
    (...kinds: BalanceRpcKind[]): RequestMatcher =>
    (request) =>
      kinds.includes(request.kind),
  chain:
    (chainId: SupportedChainId, inner?: RequestMatcher): RequestMatcher =>
    (request) =>
      request.chainId === chainId && (inner ? inner(request) : true),
  // 토큰 주소로 가는 `balanceOf` `eth_call`
  balanceOfToken:
    (token: Address): RequestMatcher =>
    (request) =>
      request.kind === "balanceOf" && sameAddress(request.tokens[0], token),
  account:
    (account: Address, inner?: RequestMatcher): RequestMatcher =>
    (request) =>
      sameAddress(request.account, account) && (inner ? inner(request) : true),
  since:
    (seq: number, inner?: RequestMatcher): RequestMatcher =>
    (request) =>
      request.seq >= seq && (inner ? inner(request) : true),
};

export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

type JsonRpcItem = { jsonrpc?: string; id?: number | string; method: string; params?: unknown[] };

type Gate = {
  matcher: RequestMatcher;
  released: boolean;
  held: number;
  promise: Promise<void>;
  resolve: () => void;
};

const BALANCE_OF_SELECTOR = "0x70a08231";

function readCallObject(params: unknown[] | undefined): { to?: string; data?: Hex } {
  const first = (params?.[0] ?? {}) as { to?: string; data?: Hex; input?: Hex };
  return { to: first.to, data: first.data ?? first.input };
}

function decodeBalanceOfAccount(data: Hex): Address | undefined {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== "balanceOf") return undefined;
    return getAddress(decoded.args[0]);
  } catch {
    return undefined;
  }
}

function decodeAggregate3(
  data: Hex,
): { target: Address; account: Address | undefined }[] | undefined {
  try {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName !== "aggregate3") return undefined;
    return decoded.args[0].map((call) => ({
      target: getAddress(call.target),
      account: decodeBalanceOfAccount(call.callData),
    }));
  } catch {
    return undefined;
  }
}

function abortReason(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// 전역 fetch를 바꾼다. 테스트 끝에 `vi.unstubAllGlobals()`로 되돌린다.
export function installBalanceRpcStub(): BalanceRpcStub {
  const fetchStub = installRpcFetchStub();
  const recorded: BalanceRpcRequest[] = [];
  let balanceFn: BalanceFn = defaultBalance;
  let failMatcher: RequestMatcher | null = null;
  let tokenFailure: ((query: BalanceQuery) => boolean) | null = null;
  let gates: Gate[] = [];

  function classify(chainId: SupportedChainId, item: JsonRpcItem): BalanceRpcRequest {
    const common = {
      seq: recorded.length,
      chainId,
      method: item.method,
      at: Date.now(),
      status: "pending" as const,
    };
    if (item.method === "eth_getBalance") {
      const account = item.params?.[0];
      return {
        ...common,
        kind: "eth_getBalance",
        account: typeof account === "string" ? getAddress(account) : undefined,
        tokens: [NATIVE_ETH_ADDRESS],
      };
    }
    if (item.method === "eth_call") {
      const { to, data } = readCallObject(item.params);
      if (to && data?.toLowerCase().startsWith(BALANCE_OF_SELECTOR)) {
        return {
          ...common,
          kind: "balanceOf",
          account: decodeBalanceOfAccount(data),
          tokens: [getAddress(to)],
        };
      }
      const calls = data ? decodeAggregate3(data) : undefined;
      if (calls) {
        return {
          ...common,
          kind: "aggregate3",
          account: calls[0]?.account,
          tokens: calls.map((call) => call.target),
        };
      }
    }
    return { ...common, kind: "other", account: undefined, tokens: [] };
  }

  function result(request: BalanceRpcRequest, item: JsonRpcItem): unknown {
    const { chainId } = request;
    switch (request.kind) {
      case "eth_getBalance":
        return numberToHex(
          balanceFn({ chainId, account: request.account!, token: NATIVE_ETH_ADDRESS }),
        );
      case "balanceOf":
        return encodeFunctionResult({
          abi: erc20Abi,
          functionName: "balanceOf",
          result: balanceFn({ chainId, account: request.account!, token: request.tokens[0] }),
        });
      case "aggregate3": {
        const { data } = readCallObject(item.params);
        const calls = decodeAggregate3(data!)!;
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: calls.map(({ target, account }) => {
            if (!account) return { success: false, returnData: "0x" as Hex };
            const query = { chainId, account, token: target };
            if (tokenFailure?.(query)) return { success: false, returnData: "0x" as Hex };
            return {
              success: true,
              returnData: encodeFunctionResult({
                abi: erc20Abi,
                functionName: "balanceOf",
                result: balanceFn(query),
              }),
            };
          }),
        });
      }
      case "other":
        if (item.method === "eth_chainId") return numberToHex(chainId);
        return undefined;
    }
  }

  async function answer(chainId: SupportedChainId, item: JsonRpcItem, signal?: AbortSignal) {
    const request = classify(chainId, item);
    recorded.push(request);
    const id = item.id ?? null;

    const holding = gates.filter((gate) => !gate.released && gate.matcher(request));
    for (const gate of holding) gate.held += 1;
    if (holding.length > 0) {
      try {
        await Promise.race([Promise.all(holding.map((gate) => gate.promise)), abortReason(signal)]);
      } catch (error) {
        request.status = "failed";
        throw error;
      }
    }

    if (failMatcher?.(request)) {
      request.status = "failed";
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "stub: request failed" } };
    }
    const value = result(request, item);
    if (value === undefined) {
      request.status = "failed";
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "stub: method not found" } };
    }
    request.status = "ok";
    return { jsonrpc: "2.0", id, result: value };
  }

  async function handle(chainId: SupportedChainId, call: StubCall): Promise<Response> {
    const body = JSON.parse(call.body) as JsonRpcItem | JsonRpcItem[];
    const items = Array.isArray(body) ? body : [body];
    const responses = await Promise.all(items.map((item) => answer(chainId, item, call.signal)));
    return new Response(JSON.stringify(Array.isArray(body) ? responses : responses[0]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  for (const chainId of STUB_CHAIN_IDS) {
    fetchStub.route(rpcProxyPath(chainId), (call) => handle(chainId, call));
  }

  return {
    fetchStub,
    setBalances(fn) {
      balanceFn = fn;
    },
    balanceOf(query) {
      return balanceFn(query);
    },
    failWhen(matcher) {
      failMatcher = matcher;
    },
    failTokenWhen(predicate) {
      tokenFailure = predicate;
    },
    hold(matcher) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      const gate: Gate = { matcher, released: false, held: 0, promise, resolve };
      gates.push(gate);
      return {
        release() {
          gate.released = true;
          gates = gates.filter((candidate) => candidate !== gate);
          gate.resolve();
        },
        get heldCount() {
          return gate.held;
        },
      };
    },
    requests(matcher) {
      return matcher ? recorded.filter(matcher) : [...recorded];
    },
  };
}
