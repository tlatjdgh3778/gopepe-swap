import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  getContractAddress,
  keccak256,
  multicall3Abi,
  numberToHex,
  parseAbi,
  parseAbiParameters,
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

// `quote`(T-6 F3 추가): QuoterV2 `quoteExactInputSingle` 하위 호출을 담은 견적 aggregate3 `eth_call`.
// 잔액 aggregate3(`aggregate3`)와 따로 분류하며, 기존 `failWhen`·`hold`는 견적 요청에 적용되지 않는다.
export type BalanceRpcKind = "eth_getBalance" | "balanceOf" | "aggregate3" | "other" | "quote";

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
  // 견적 요청(`kind: "quote"`)이면 디코드한 하위 호출. 그 밖에는 undefined
  quote?: QuoteRpcCall;
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

  // --- T-6(F3) 추가: 견적 aggregate3 ---
  // 견적 규칙을 바꾼다. 응답 시점의 규칙으로 응답한다. 기본은 `defaultQuoteRule`(모든 티어 성공).
  setQuoteRule(rule: QuoteRule): void;
  // 현재 견적 규칙
  quoteRule(): QuoteRule;
  // 조건에 맞는 견적 요청을 JSON-RPC 오류(-32000, viem이 재시도하지 않는 코드)로 실패시킨다. null이면 해제한다.
  failQuoteWhen(matcher: RequestMatcher | null): void;
  // 조건에 맞는 견적 요청의 응답을 `release()` 전까지 붙잡는다. 조건을 생략하면 모든 견적 요청이다.
  holdQuote(matcher?: RequestMatcher): HoldGate;
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

// ─── T-6(F3) 추가: 견적 aggregate3 스텁 ───────────────────────────────
// 앱은 견적 1회에 Multicall3 aggregate3 `eth_call` 하나로 네 티어 풀의 `slot0`과 QuoterV2 `quoteExactInputSingle`을 묶어 보낸다.
// 스텁은 하위 호출을 디코드해 견적 규칙(`QuoteRule`)으로 응답한다. `slot0` 대상(풀 주소)은 제품 함수를 쓰지 않고
// 아래 리터럴(팩토리, 풀 생성 코드 해시)로 테스트 쪽에서 CREATE2 계산한 주소와 맞춰 티어를 정한다.
// 맞는 풀이 없는 `slot0`과 알 수 없는 하위 호출은 실패(`success: false`)로 응답한다.

export type StubFeeTier = 100 | 500 | 3000 | 10000;
export const STUB_FEE_TIERS: readonly StubFeeTier[] = [100, 500, 3000, 10000];

// Uniswap V3 공식 배포 주소(리터럴)
const STUB_V3_FACTORY: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  [base.id]: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  [arbitrum.id]: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
};
// Uniswap v3-periphery `PoolAddress.POOL_INIT_CODE_HASH`
const STUB_POOL_INIT_CODE_HASH: Hex =
  "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

export const stubQuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export const stubPoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

// 주소를 수치로 비교해 [token0, token1]로 정렬한다.
export function stubSortTokens(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

// 테스트 쪽 CREATE2 풀 주소 계산(제품 `getPoolAddress`를 쓰지 않는다).
export function stubPoolAddress(
  chainId: SupportedChainId,
  tokenA: Address,
  tokenB: Address,
  fee: StubFeeTier,
): Address {
  const [token0, token1] = stubSortTokens(tokenA, tokenB);
  return getContractAddress({
    opcode: "CREATE2",
    from: STUB_V3_FACTORY[chainId],
    salt: keccak256(
      encodeAbiParameters(parseAbiParameters("address, address, uint24"), [token0, token1, fee]),
    ),
    bytecodeHash: STUB_POOL_INIT_CODE_HASH,
  });
}

export type QuoteSubcall = {
  target: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee: number;
};

export type Slot0Subcall = {
  target: Address;
  // 대상 주소와 맞는 풀의 티어. 맞는 풀이 없으면 null
  fee: StubFeeTier | null;
};

export type QuoteRpcCall = {
  quotes: QuoteSubcall[];
  slot0s: Slot0Subcall[];
  // aggregate3에 묶인 하위 호출 수
  subcallCount: number;
};

export type QuoteQuery = {
  chainId: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  fee: StubFeeTier;
};

export type QuoteTierResponse =
  | { status: "ok"; amountOut: bigint; sqrtPriceX96After: bigint }
  | { status: "revert" };

export type Slot0Query = {
  chainId: SupportedChainId;
  fee: StubFeeTier;
  token0: Address;
  token1: Address;
};

// `empty`는 `success: true`에 빈 반환값(`0x`), `revert`는 `success: false`다.
export type Slot0Response =
  | { status: "ok"; sqrtPriceX96: bigint }
  | { status: "revert" }
  | { status: "empty" };

export type QuoteRule = {
  quote(query: QuoteQuery): QuoteTierResponse;
  slot0(query: Slot0Query): Slot0Response;
};

export const STUB_Q96 = 2n ** 96n;

// 기본 규칙의 견적 후 가격. 방향별 한계값(유동성 소진)과 다르다.
export const DEFAULT_SQRT_PRICE_X96_AFTER = STUB_Q96 * 2n;

// 기본 규칙의 티어별 수령량 배율(천분율). 500 티어의 수령량이 가장 많다.
const DEFAULT_TIER_PERMILLE: Record<StubFeeTier, bigint> = {
  100: 970n,
  500: 1_000n,
  3000: 990n,
  10000: 950n,
};

// 기본 규칙의 티어별 slot0 가격. 모두 1이 아니고(sqrtPriceX96 ≠ 2^96) 티어마다 다르다.
const DEFAULT_SLOT0_MULTIPLIER: Record<StubFeeTier, bigint> = {
  100: 2n,
  500: 3n,
  3000: 5n,
  10000: 7n,
};

// 기본 수령량: 체인·두 토큰·금액마다 다른 양의 값. 500 티어가 가장 많다.
export function defaultQuoteAmountOut(query: QuoteQuery): bigint {
  const inputPart =
    query.amountIn * 3n +
    (BigInt(query.chainId) % 1_000n) * 1_000n +
    (BigInt(query.tokenIn.toLowerCase()) % 1_000n) * 10n +
    (BigInt(query.tokenOut.toLowerCase()) % 1_000n) +
    1n;
  return (inputPart * DEFAULT_TIER_PERMILLE[query.fee]) / 1_000n;
}

export function defaultSlot0SqrtPriceX96(fee: StubFeeTier): bigint {
  return STUB_Q96 * DEFAULT_SLOT0_MULTIPLIER[fee];
}

// 기본 견적 규칙: 네 티어 모두 성공, slot0도 모두 성공.
export const defaultQuoteRule: QuoteRule = {
  quote: (query) => ({
    status: "ok",
    amountOut: defaultQuoteAmountOut(query),
    sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
  }),
  slot0: (query) => ({ status: "ok", sqrtPriceX96: defaultSlot0SqrtPriceX96(query.fee) }),
};

// 성공한 티어의 수령량에 `delta`를 더한 규칙. 같은 입력의 다시 읽기에서 값이 바뀌었음을 드러낸다.
export function shiftQuoteAmounts(rule: QuoteRule, delta: bigint): QuoteRule {
  return {
    quote: (query) => {
      const response = rule.quote(query);
      return response.status === "ok"
        ? { ...response, amountOut: response.amountOut + delta }
        : response;
    },
    slot0: (query) => rule.slot0(query),
  };
}

// 규칙이 낼 견적(테스트 쪽 기대값): revert·수령량 0 티어를 빼고 수령량이 가장 많은 티어, 같으면 수수료가 낮은 티어.
export function bestStubQuote(
  rule: QuoteRule,
  input: Omit<QuoteQuery, "fee">,
): { fee: StubFeeTier; amountOut: bigint } | null {
  let best: { fee: StubFeeTier; amountOut: bigint } | null = null;
  for (const fee of STUB_FEE_TIERS) {
    const response = rule.quote({ ...input, fee });
    if (response.status !== "ok" || response.amountOut <= 0n) continue;
    if (best === null || response.amountOut > best.amountOut) {
      best = { fee, amountOut: response.amountOut };
    }
  }
  return best;
}

export type QuoteInputFilter = {
  chainId?: SupportedChainId;
  tokenIn?: Address;
  tokenOut?: Address;
  amountIn?: bigint;
};

// 견적 요청 조건 모음
export const matchQuote = {
  // 견적 요청. 조건을 주면 모든 `quoteExactInputSingle` 하위 호출이 조건에 맞는 요청만.
  input:
    (filter: QuoteInputFilter = {}): RequestMatcher =>
    (request) => {
      if (request.kind !== "quote" || !request.quote) return false;
      if (filter.chainId !== undefined && request.chainId !== filter.chainId) return false;
      return request.quote.quotes.every(
        (call) =>
          (filter.tokenIn === undefined || sameAddress(call.tokenIn, filter.tokenIn)) &&
          (filter.tokenOut === undefined || sameAddress(call.tokenOut, filter.tokenOut)) &&
          (filter.amountIn === undefined || call.amountIn === filter.amountIn),
      );
    },
  // 카드 잔액 읽기(`eth_getBalance`·`balanceOf`·잔액 aggregate3)로 분류되지 않는 모든 JSON-RPC 항목(메서드 무관).
  notBalance: ((request) =>
    request.kind !== "eth_getBalance" &&
    request.kind !== "balanceOf" &&
    request.kind !== "aggregate3") as RequestMatcher,
};

type QuoteEntry =
  | { type: "quote"; call: QuoteSubcall }
  | { type: "slot0"; call: Slot0Subcall }
  | { type: "unknown" };

function decodeQuoteSubcall(target: Address, callData: Hex): QuoteSubcall | undefined {
  try {
    const decoded = decodeFunctionData({ abi: stubQuoterAbi, data: callData });
    const params = decoded.args[0];
    return {
      target,
      tokenIn: getAddress(params.tokenIn),
      tokenOut: getAddress(params.tokenOut),
      amountIn: params.amountIn,
      fee: params.fee,
    };
  } catch {
    return undefined;
  }
}

function isSlot0Call(callData: Hex): boolean {
  try {
    return decodeFunctionData({ abi: stubPoolAbi, data: callData }).functionName === "slot0";
  } catch {
    return false;
  }
}

// QuoterV2 하위 호출이 하나라도 있는 aggregate3면 하위 호출을 순서대로 디코드한다. 아니면 undefined.
function decodeQuoteAggregate3(
  chainId: SupportedChainId,
  data: Hex,
): { call: QuoteRpcCall; entries: QuoteEntry[] } | undefined {
  let calls: readonly { target: Address; callData: Hex }[];
  try {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName !== "aggregate3") return undefined;
    calls = decoded.args[0];
  } catch {
    return undefined;
  }

  const quotes = calls.flatMap(({ target, callData }) => {
    const quote = decodeQuoteSubcall(getAddress(target), callData);
    return quote ? [quote] : [];
  });
  if (quotes.length === 0) return undefined;

  const pair = quotes[0];
  const poolFee = (target: Address): StubFeeTier | null =>
    STUB_FEE_TIERS.find((fee) =>
      sameAddress(stubPoolAddress(chainId, pair.tokenIn, pair.tokenOut, fee), target),
    ) ?? null;

  const slot0s: Slot0Subcall[] = [];
  const entries = calls.map(({ target, callData }): QuoteEntry => {
    const address = getAddress(target);
    const quote = decodeQuoteSubcall(address, callData);
    if (quote) return { type: "quote", call: quote };
    if (isSlot0Call(callData)) {
      const slot0 = { target: address, fee: poolFee(address) };
      slot0s.push(slot0);
      return { type: "slot0", call: slot0 };
    }
    return { type: "unknown" };
  });

  return { call: { quotes, slot0s, subcallCount: calls.length }, entries };
}

const FAILED_SUBCALL = { success: false, returnData: "0x" as Hex };

function answerQuoteEntry(
  chainId: SupportedChainId,
  entry: QuoteEntry,
  pair: QuoteSubcall,
  rule: QuoteRule,
): { success: boolean; returnData: Hex } {
  if (entry.type === "quote") {
    const { tokenIn, tokenOut, amountIn, fee } = entry.call;
    if (!STUB_FEE_TIERS.includes(fee as StubFeeTier)) return FAILED_SUBCALL;
    const response = rule.quote({ chainId, tokenIn, tokenOut, amountIn, fee: fee as StubFeeTier });
    if (response.status !== "ok") return FAILED_SUBCALL;
    return {
      success: true,
      returnData: encodeFunctionResult({
        abi: stubQuoterAbi,
        functionName: "quoteExactInputSingle",
        result: [response.amountOut, response.sqrtPriceX96After, 1, 100_000n],
      }),
    };
  }
  if (entry.type === "slot0") {
    if (entry.call.fee === null) return FAILED_SUBCALL;
    const [token0, token1] = stubSortTokens(pair.tokenIn, pair.tokenOut);
    const response = rule.slot0({ chainId, fee: entry.call.fee, token0, token1 });
    if (response.status === "revert") return FAILED_SUBCALL;
    if (response.status === "empty") return { success: true, returnData: "0x" };
    return {
      success: true,
      returnData: encodeFunctionResult({
        abi: stubPoolAbi,
        functionName: "slot0",
        result: [response.sqrtPriceX96, 0, 0, 1, 1, 0, true],
      }),
    };
  }
  return FAILED_SUBCALL;
}

type JsonRpcItem = { jsonrpc?: string; id?: number | string; method: string; params?: unknown[] };

type Gate = {
  // T-6(F3) 추가: 기존 `hold`는 잔액 쪽(`balance`), `holdQuote`는 견적 요청(`quote`)에만 적용된다.
  scope: "balance" | "quote";
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
  let quoteRule: QuoteRule = defaultQuoteRule;
  let quoteFailMatcher: RequestMatcher | null = null;

  function addGate(scope: Gate["scope"], matcher: RequestMatcher): HoldGate {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const gate: Gate = { scope, matcher, released: false, held: 0, promise, resolve };
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
  }

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
      // T-6(F3) 추가: QuoterV2 하위 호출을 담은 aggregate3는 견적 요청으로 따로 분류한다.
      const quote = data ? decodeQuoteAggregate3(chainId, data) : undefined;
      if (quote) {
        return { ...common, kind: "quote", account: undefined, tokens: [], quote: quote.call };
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
      case "quote": {
        const { data } = readCallObject(item.params);
        const decoded = decodeQuoteAggregate3(chainId, data!)!;
        const pair = decoded.call.quotes[0];
        const rule = quoteRule;
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: decoded.entries.map((entry) => answerQuoteEntry(chainId, entry, pair, rule)),
        });
      }
    }
  }

  async function answer(chainId: SupportedChainId, item: JsonRpcItem, signal?: AbortSignal) {
    const request = classify(chainId, item);
    recorded.push(request);
    const id = item.id ?? null;

    // 견적 요청은 견적 쪽 붙잡기·실패 규칙만, 그 밖의 요청은 기존 규칙만 적용한다(T-6 F3).
    const scope: Gate["scope"] = request.kind === "quote" ? "quote" : "balance";
    const holding = gates.filter(
      (gate) => gate.scope === scope && !gate.released && gate.matcher(request),
    );
    for (const gate of holding) gate.held += 1;
    if (holding.length > 0) {
      try {
        await Promise.race([Promise.all(holding.map((gate) => gate.promise)), abortReason(signal)]);
      } catch (error) {
        request.status = "failed";
        throw error;
      }
    }

    const activeFailMatcher = scope === "quote" ? quoteFailMatcher : failMatcher;
    if (activeFailMatcher?.(request)) {
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
      return addGate("balance", matcher);
    },
    requests(matcher) {
      return matcher ? recorded.filter(matcher) : [...recorded];
    },
    setQuoteRule(rule) {
      quoteRule = rule;
    },
    quoteRule() {
      return quoteRule;
    },
    failQuoteWhen(matcher) {
      quoteFailMatcher = matcher;
    },
    holdQuote(matcher) {
      return addGate("quote", matcher ?? (() => true));
    },
  };
}
