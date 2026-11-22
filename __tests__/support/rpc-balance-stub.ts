import {
  type Address,
  type Hash,
  type Hex,
  type ReplacementReason,
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
  toHex,
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
// `allowance`·`receipt`(T-7 F5 추가): 아래 "T-7(F5) 추가" 절을 본다. 두 분류도 기존 `failWhen`·`hold`가 적용되지 않는다.
export type BalanceRpcKind =
  | "eth_getBalance"
  | "balanceOf"
  | "aggregate3"
  | "other"
  | "quote"
  | "allowance"
  | "receipt"
  // T-8(F9) 추가: 첫 하위 호출이 QuoterV2 `quoteExactInputSingle`인 단가 aggregate3 `eth_call`.
  // 견적 aggregate3(첫 하위 호출이 `slot0`)보다 먼저 판정하며, 기존 `failWhen`·`hold`·견적 규칙이 적용되지 않는다.
  | "usd-price";

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
  // T-7(F5) 추가: allowance 요청(`kind: "allowance"`)이면 디코드한 호출. 그 밖에는 undefined
  allowance?: AllowanceRpcCall;
  // T-7(F5) 추가: 영수증 계열(`kind: "receipt"`) 중 해시로 조회하는 요청의 해시. 그 밖에는 undefined
  txHash?: Hash;
  // T-8(F9) 추가: 단가 요청(`kind: "usd-price"`)이면 디코드한 쌍들. 그 밖에는 undefined
  usdPrice?: UsdPriceRpcCall;
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

  // --- T-7(F5) 추가: allowance `eth_call` ---
  // allowance 규칙을 바꾼다. 응답 시점의 규칙으로 응답한다. 기본은 `defaultAllowance`(0, 사용자 확정).
  setAllowances(fn: AllowanceFn): void;
  // 현재 규칙의 allowance
  allowanceOf(query: AllowanceQuery): bigint;
  // 조건에 맞는 allowance 요청을 JSON-RPC 오류(-32000, viem이 재시도하지 않는 코드)로 실패시킨다. null이면 해제한다.
  failAllowanceWhen(matcher: RequestMatcher | null): void;
  // 조건에 맞는 allowance 요청의 응답을 `release()` 전까지 붙잡는다. 조건을 생략하면 모든 allowance 요청이다.
  holdAllowance(matcher?: RequestMatcher): HoldGate;

  // --- T-7(F5) 추가: 영수증 계열(`eth_getTransactionReceipt`·`eth_getTransactionByHash`·`eth_blockNumber`·`eth_getBlockByNumber`) ---
  // 영수증 규칙을 바꾼다. 응답 시점의 규칙으로 응답한다. 기본은 `defaultReceiptRule`(영수증 성공).
  setReceiptRule(rule: ReceiptRule): void;
  // 현재 영수증 규칙
  receiptRule(): ReceiptRule;
  // 조건에 맞는 영수증 계열 요청을 JSON-RPC 오류(-32000, viem이 재시도하지 않는 코드)로 실패시킨다. null이면 해제한다.
  failReceiptWhen(matcher: RequestMatcher | null): void;
  // 조건에 맞는 영수증 계열 요청의 응답을 `release()` 전까지 붙잡는다. 조건을 생략하면 영수증 조회(`eth_getTransactionReceipt`)다.
  holdReceipt(matcher?: RequestMatcher): HoldGate;
  // 체인의 마지막으로 응답한 블록 번호
  blockNumber(chainId: SupportedChainId): bigint;

  // --- T-6(F6) 추가: 교체 주입 ---
  // `eth_getTransactionByHash`가 트랜잭션을 돌려줄 때(영수증 규칙의 `transaction`이 `pending`) 쓸 해시별 필드.
  // 함수가 undefined를 돌려주거나 null이면 기존 고정 필드로 응답한다. 응답 시점의 함수로 응답한다.
  setTransactionFields(fn: TransactionFieldsFn | null): void;
  // `fromBlock` 이상인 모든 블록의 `eth_getBlockByNumber` 트랜잭션 목록에 트랜잭션을 싣는다(블록에 들어간 형태).
  // 기본 블록 트랜잭션 목록은 비어 있다.
  addBlockTransaction(
    chainId: SupportedChainId,
    transaction: StubTransaction,
    fromBlock: bigint,
  ): void;

  // --- T-8(F9) 추가: 단가 aggregate3 ---
  // 단가 규칙을 바꾼다. 응답 시점의 규칙으로 응답한다. 기본은 `defaultUsdPriceRule`(모든 쌍·티어 성공).
  // 견적 규칙(`setQuoteRule`)과 따로 둔다.
  setUsdPriceRule(rule: QuoteRule): void;
  // 현재 단가 규칙
  usdPriceRule(): QuoteRule;
  // 조건에 맞는 단가 요청을 JSON-RPC 오류(-32000, viem이 재시도하지 않는 코드)로 실패시킨다. null이면 해제한다.
  failUsdPriceWhen(matcher: RequestMatcher | null): void;
  // 조건에 맞는 단가 요청이 담긴 HTTP 요청에 HTTP 429(프록시 요청 한도 초과)로 응답한다. null이면 해제한다.
  // 같은 HTTP 배치에 담긴 다른 항목도 함께 429를 받는다(HTTP 응답 단위).
  respondUsdPriceHttp429When(matcher: RequestMatcher | null): void;
  // 조건에 맞는 단가 요청의 응답을 `release()` 전까지 붙잡는다. 조건을 생략하면 모든 단가 요청이다.
  holdUsdPrice(matcher?: RequestMatcher): HoldGate;
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

// ─── T-8(F9) 추가: 단가 aggregate3 스텁 ───────────────────────────────
// 앱은 단가 요청 1회에 Multicall3 aggregate3 `eth_call` 하나로 쌍 여러 개를 묶어 보낸다. 쌍마다 QuoterV2
// `quoteExactInputSingle` 4건(토큰 1개 견적)을 앞에, 네 티어 풀의 `slot0` 4건을 뒤에 둔다(F9 계획 §1).
// 스텁은 첫 하위 호출이 `quoteExactInputSingle`인 aggregate3를 단가 요청(`usd-price`)으로 분류해 견적 요청
// (첫 하위 호출이 `slot0`)과 구분하고, 단가 규칙(`QuoteRule` 형태, 견적 규칙과 별도 상태)으로 응답한다.
// `slot0` 대상(풀 주소)은 묶인 쌍마다 테스트 쪽 CREATE2 계산 주소와 맞춰 쌍·티어를 정한다. 맞는 풀이 없으면 실패로 응답한다.
// 아래 기대값 함수(현물가, 티어 선택, 단가)는 제품 함수를 쓰지 않는 테스트 쪽 계산이다.

// 체인 네이티브 USDC·WETH 공식 주소(리터럴, 제품 config를 쓰지 않는다)
export const STUB_USDC_BY_CHAIN: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  [base.id]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [arbitrum.id]: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};
export const STUB_WETH_BY_CHAIN: Record<SupportedChainId, Address> = {
  [mainnet.id]: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  [base.id]: "0x4200000000000000000000000000000000000006",
  [arbitrum.id]: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};
// 네이티브 ETH 표기 주소(리터럴)
export const STUB_ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// Uniswap V3 TickMath MIN_SQRT_RATIO + 1, MAX_SQRT_RATIO − 1(리터럴). `sqrtPriceLimitX96` 0 견적의 방향별 한계값이다.
export const STUB_SQRT_PRICE_LIMIT_ZERO_FOR_ONE = 4_295_128_740n;
export const STUB_SQRT_PRICE_LIMIT_ONE_FOR_ZERO =
  1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n;

// 견적 후 가격이 방향별 한계값에 닿은 값(유동성 소진). 방향은 두 주소의 수치 순서로 정한다.
export function stubExhaustedSqrtPriceX96After(tokenIn: Address, tokenOut: Address): bigint {
  return BigInt(tokenIn) < BigInt(tokenOut)
    ? STUB_SQRT_PRICE_LIMIT_ZERO_FOR_ONE
    : STUB_SQRT_PRICE_LIMIT_ONE_FOR_ZERO;
}

// 단가 요청에 묶인 쌍 하나. `tokenIn` 1개(`amountIn`)를 `tokenOut`으로 견적한다.
export type UsdPricePairCall = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  // 이 쌍의 `quoteExactInputSingle` 하위 호출(받은 순서)
  quotes: QuoteSubcall[];
  // 대상 주소가 이 쌍의 풀과 맞는 `slot0` 하위 호출(받은 순서)
  slot0s: Slot0Subcall[];
};

export type UsdPriceRpcCall = {
  // 묶인 쌍(첫 `quoteExactInputSingle`이 나온 순서)
  pairs: UsdPricePairCall[];
  // 어느 쌍의 풀과도 맞지 않은 `slot0` 하위 호출 수
  unmatchedSlot0Count: number;
  // aggregate3에 묶인 하위 호출 수
  subcallCount: number;
};

// QuoterV2 `quoteExactInputSingle((address,address,uint256,uint24,uint160))` 셀렉터(소문자, `0x` 없음)
const QUOTE_EXACT_INPUT_SINGLE_SELECTOR = "c6a5026a";

type UsdPriceEntry =
  | { type: "quote"; call: QuoteSubcall }
  | { type: "slot0"; call: Slot0Subcall; pair: UsdPricePairCall | null }
  | { type: "unknown" };

// 첫 하위 호출이 QuoterV2 `quoteExactInputSingle`인 aggregate3면 하위 호출을 쌍별로 디코드한다. 아니면 undefined.
function decodeUsdPriceAggregate3(
  chainId: SupportedChainId,
  data: Hex,
): { call: UsdPriceRpcCall; entries: UsdPriceEntry[] } | undefined {
  // QuoterV2 `quoteExactInputSingle` 셀렉터가 없는 calldata(잔액 aggregate3 등)는 디코드하지 않는다.
  if (!data.toLowerCase().includes(QUOTE_EXACT_INPUT_SINGLE_SELECTOR)) return undefined;
  let calls: readonly { target: Address; callData: Hex }[];
  try {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName !== "aggregate3") return undefined;
    calls = decoded.args[0];
  } catch {
    return undefined;
  }
  if (calls.length === 0) return undefined;
  if (!decodeQuoteSubcall(getAddress(calls[0].target), calls[0].callData)) return undefined;

  const pairs: UsdPricePairCall[] = [];
  const pairByKey = new Map<string, UsdPricePairCall>();
  const decodedQuotes = calls.map(({ target, callData }) =>
    decodeQuoteSubcall(getAddress(target), callData),
  );
  for (const quote of decodedQuotes) {
    if (!quote) continue;
    const key = `${quote.tokenIn.toLowerCase()}:${quote.tokenOut.toLowerCase()}:${quote.amountIn}`;
    let pair = pairByKey.get(key);
    if (!pair) {
      pair = {
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountIn: quote.amountIn,
        quotes: [],
        slot0s: [],
      };
      pairByKey.set(key, pair);
      pairs.push(pair);
    }
    pair.quotes.push(quote);
  }

  // 풀 주소(소문자) → 쌍·티어. 같은 풀을 쓰는 쌍이 여럿이면 먼저 나온 쌍이다.
  const poolOwners = new Map<string, { pair: UsdPricePairCall; fee: StubFeeTier }>();
  for (const pair of pairs) {
    for (const fee of STUB_FEE_TIERS) {
      const pool = stubPoolAddress(chainId, pair.tokenIn, pair.tokenOut, fee).toLowerCase();
      if (!poolOwners.has(pool)) poolOwners.set(pool, { pair, fee });
    }
  }

  let unmatchedSlot0Count = 0;
  const entries = calls.map(({ target, callData }, index): UsdPriceEntry => {
    const quote = decodedQuotes[index];
    if (quote) return { type: "quote", call: quote };
    if (isSlot0Call(callData)) {
      const address = getAddress(target);
      const owner = poolOwners.get(address.toLowerCase());
      const slot0: Slot0Subcall = { target: address, fee: owner?.fee ?? null };
      if (owner) owner.pair.slot0s.push(slot0);
      else unmatchedSlot0Count += 1;
      return { type: "slot0", call: slot0, pair: owner?.pair ?? null };
    }
    return { type: "unknown" };
  });

  return { call: { pairs, unmatchedSlot0Count, subcallCount: calls.length }, entries };
}

function answerUsdPriceEntry(
  chainId: SupportedChainId,
  entry: UsdPriceEntry,
  rule: QuoteRule,
): { success: boolean; returnData: Hex } {
  if (entry.type === "quote") {
    return answerQuoteEntry(chainId, entry, entry.call, rule);
  }
  if (entry.type === "slot0") {
    if (!entry.pair) return FAILED_SUBCALL;
    const { tokenIn, tokenOut, amountIn } = entry.pair;
    return answerQuoteEntry(
      chainId,
      { type: "slot0", call: entry.call },
      { target: entry.call.target, tokenIn, tokenOut, amountIn, fee: entry.call.fee ?? 0 },
      rule,
    );
  }
  return FAILED_SUBCALL;
}

// 기본 단가 규칙: 모든 쌍의 네 티어 견적과 slot0이 성공한다(기본 견적 규칙과 같은 응답 형태, 500 티어 수령량이 가장 많다).
export const defaultUsdPriceRule: QuoteRule = defaultQuoteRule;

// 모든 티어를 revert로 응답하는 견적 응답(경로 없음 표본용)
export const stubRevertQuote = (): QuoteTierResponse => ({ status: "revert" });

// 쌍 하나의 단가 규칙 덮어쓰기. `quote`는 `tokenIn → tokenOut` 방향의 견적에만, `slot0`은 두 토큰의 풀에만 적용된다.
export type UsdPricePairRule = {
  // 생략하면 모든 체인
  chainId?: SupportedChainId;
  tokenIn: Address;
  tokenOut: Address;
  quote?: (query: QuoteQuery) => QuoteTierResponse;
  slot0?: (query: Slot0Query) => Slot0Response;
};

// 지정한 쌍만 덮어쓰고 나머지는 `fallback` 규칙을 쓰는 단가 규칙. 같은 쌍을 여럿 주면 앞의 것이 적용된다.
export function usdPriceRuleWith(
  pairs: readonly UsdPricePairRule[],
  fallback: QuoteRule = defaultUsdPriceRule,
): QuoteRule {
  const chainMatches = (pair: UsdPricePairRule, chainId: SupportedChainId) =>
    pair.chainId === undefined || pair.chainId === chainId;
  return {
    quote: (query) => {
      const pair = pairs.find(
        (candidate) =>
          candidate.quote !== undefined &&
          chainMatches(candidate, query.chainId) &&
          sameAddress(candidate.tokenIn, query.tokenIn) &&
          sameAddress(candidate.tokenOut, query.tokenOut),
      );
      return pair?.quote ? pair.quote(query) : fallback.quote(query);
    },
    slot0: (query) => {
      const pair = pairs.find((candidate) => {
        if (candidate.slot0 === undefined || !chainMatches(candidate, query.chainId)) return false;
        const [token0, token1] = stubSortTokens(candidate.tokenIn, candidate.tokenOut);
        return sameAddress(token0, query.token0) && sameAddress(token1, query.token1);
      });
      return pair?.slot0 ? pair.slot0(query) : fallback.slot0(query);
    },
  };
}

// 단가 유리수(토큰 raw 1단위당 기준 토큰 raw). 제품 `UsdPrice`와 같은 형태다.
export type StubPrice = { numerator: bigint; denominator: bigint };

const STUB_Q192 = 2n ** 192n;

// slot0 현물가(테스트 쪽 계산): 기준 토큰 raw / 대상 토큰 raw.
// slot0 가격은 token1/token0 = sqrtPriceX96² / 2^192 이므로, 대상 토큰이 token0이면 그대로, token1이면 역수다.
export function stubSpotPrice(
  token: Address,
  quoteToken: Address,
  sqrtPriceX96: bigint,
): StubPrice {
  const squared = sqrtPriceX96 * sqrtPriceX96;
  return BigInt(token) < BigInt(quoteToken)
    ? { numerator: squared, denominator: STUB_Q192 }
    : { numerator: STUB_Q192, denominator: squared };
}

export function stubMultiplyPrices(a: StubPrice, b: StubPrice): StubPrice {
  return { numerator: a.numerator * b.numerator, denominator: a.denominator * b.denominator };
}

// 두 유리수가 같은 값인지(교차곱)
export function stubPricesEqual(a: StubPrice, b: StubPrice): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

// USD micros(테스트 쪽 계산): amountRaw × numerator / denominator 버림
export function stubUsdMicros(amountRaw: bigint, price: StubPrice): bigint {
  return (amountRaw * price.numerator) / price.denominator;
}

// 규칙이 고를 티어(테스트 쪽 기대값): revert·수령량 0·유동성 소진 티어를 빼고 수령량이 가장 많은 티어, 같으면 수수료가 낮은 티어.
export function stubSelectFeeTier(
  rule: QuoteRule,
  input: Omit<QuoteQuery, "fee">,
): { fee: StubFeeTier; amountOut: bigint } | null {
  const exhausted = stubExhaustedSqrtPriceX96After(input.tokenIn, input.tokenOut);
  let best: { fee: StubFeeTier; amountOut: bigint } | null = null;
  for (const fee of STUB_FEE_TIERS) {
    const response = rule.quote({ ...input, fee });
    if (response.status !== "ok" || response.amountOut <= 0n) continue;
    if (response.sqrtPriceX96After === exhausted) continue;
    if (best === null || response.amountOut > best.amountOut) {
      best = { fee, amountOut: response.amountOut };
    }
  }
  return best;
}

// 쌍 하나의 현물가(테스트 쪽 기대값). 고를 티어가 없으면 `none`, 고른 티어의 slot0이 성공이 아니면 `error`다.
export type StubPairPrice =
  | { status: "ok"; fee: StubFeeTier; price: StubPrice }
  | { status: "none" }
  | { status: "error"; fee: StubFeeTier };

export function stubPairPrice(
  rule: QuoteRule,
  input: { chainId: SupportedChainId; token: Address; quoteToken: Address; amountIn: bigint },
): StubPairPrice {
  const selected = stubSelectFeeTier(rule, {
    chainId: input.chainId,
    tokenIn: input.token,
    tokenOut: input.quoteToken,
    amountIn: input.amountIn,
  });
  if (!selected) return { status: "none" };
  const [token0, token1] = stubSortTokens(input.token, input.quoteToken);
  const slot0 = rule.slot0({ chainId: input.chainId, fee: selected.fee, token0, token1 });
  if (slot0.status !== "ok") return { status: "error", fee: selected.fee };
  return {
    status: "ok",
    fee: selected.fee,
    price: stubSpotPrice(input.token, input.quoteToken, slot0.sqrtPriceX96),
  };
}

// 토큰 단가(테스트 쪽 기대값, F9 DoD-1·2·3·4, EC-15·16·17·26).
// ETH는 같은 체인 WETH, 체인 네이티브 USDC는 정확히 1, USDC 직접 경로가 있으면 그 현물가, 없으면 WETH 경유 곱이다.
// 고른 티어의 slot0이 실패한 구간이 있으면 `error`, 고를 티어가 없는 구간이 있으면 `no-price`다.
export type StubExpectedUsdPrice =
  | { status: "success"; price: StubPrice }
  | { status: "no-price" }
  | { status: "error" };

export function expectedStubUsdPrice(
  rule: QuoteRule,
  input: { chainId: SupportedChainId; token: Address; decimals: number },
): StubExpectedUsdPrice {
  const { chainId } = input;
  const usdc = STUB_USDC_BY_CHAIN[chainId];
  const weth = STUB_WETH_BY_CHAIN[chainId];
  const token = sameAddress(input.token, STUB_ETH_ADDRESS) ? weth : input.token;
  const decimals = sameAddress(input.token, STUB_ETH_ADDRESS) ? 18 : input.decimals;
  if (sameAddress(token, usdc))
    return { status: "success", price: { numerator: 1n, denominator: 1n } };

  const amountIn = 10n ** BigInt(decimals);
  const direct = stubPairPrice(rule, { chainId, token, quoteToken: usdc, amountIn });
  if (direct.status === "ok") return { status: "success", price: direct.price };
  if (direct.status === "error") return { status: "error" };
  if (sameAddress(token, weth)) return { status: "no-price" };

  const toWeth = stubPairPrice(rule, { chainId, token, quoteToken: weth, amountIn });
  const wethToUsdc = stubPairPrice(rule, {
    chainId,
    token: weth,
    quoteToken: usdc,
    amountIn: 10n ** 18n,
  });
  if (toWeth.status === "error" || wethToUsdc.status === "error") return { status: "error" };
  if (toWeth.status === "none" || wethToUsdc.status === "none") return { status: "no-price" };
  return { status: "success", price: stubMultiplyPrices(toWeth.price, wethToUsdc.price) };
}

// 단가 요청의 단계. 쌍 중 하나라도 기준 토큰이 그 체인 WETH면 WETH 경유(2차), 아니면 USDC 직접(1차)이다.
export function usdPriceStage(request: BalanceRpcRequest): "direct" | "routed" | undefined {
  if (request.kind !== "usd-price" || !request.usdPrice) return undefined;
  const weth = STUB_WETH_BY_CHAIN[request.chainId];
  return request.usdPrice.pairs.some((pair) => sameAddress(pair.tokenOut, weth))
    ? "routed"
    : "direct";
}

// 단가 요청의 대상 토큰. 1차는 모든 쌍의 `tokenIn`, 2차는 (토큰, WETH) 쌍의 토큰이다((WETH, USDC) 구간 쌍은 뺀다).
export function usdPriceTargets(request: BalanceRpcRequest): Address[] {
  const stage = usdPriceStage(request);
  if (!stage) return [];
  const weth = STUB_WETH_BY_CHAIN[request.chainId];
  return request
    .usdPrice!.pairs.filter((pair) => stage === "direct" || sameAddress(pair.tokenOut, weth))
    .map((pair) => pair.tokenIn);
}

// 단가 요청 조건 모음
export const matchUsdPrice = {
  // 모든 단가 요청
  any: ((request) => request.kind === "usd-price") as RequestMatcher,
  // 단계(1차 USDC 직접, 2차 WETH 경유)가 맞는 단가 요청
  stage:
    (stage: "direct" | "routed"): RequestMatcher =>
    (request) =>
      usdPriceStage(request) === stage,
  // 대상 토큰에 `token`이 있는 단가 요청. ETH는 WETH 주소로 넘긴다.
  target:
    (token: Address): RequestMatcher =>
    (request) =>
      usdPriceTargets(request).some((candidate) => sameAddress(candidate, token)),
  // (`tokenIn`, `tokenOut`) 쌍을 담은 단가 요청. `tokenOut`을 생략하면 `tokenIn`만 본다.
  pair:
    (tokenIn: Address, tokenOut?: Address): RequestMatcher =>
    (request) =>
      request.kind === "usd-price" &&
      (request.usdPrice?.pairs ?? []).some(
        (pair) =>
          sameAddress(pair.tokenIn, tokenIn) &&
          (tokenOut === undefined || sameAddress(pair.tokenOut, tokenOut)),
      ),
};

// ─── T-7(F5) 추가: allowance `eth_call` 스텁 ──────────────────────────
// 앱은 allowance를 토큰 주소로 보내는 ERC-20 `allowance(owner, spender)` `eth_call` 1회로 읽는다(multicall 묶음 없음).
// 스텁은 calldata를 디코드해 allowance 규칙(`AllowanceFn`)으로 응답한다. 기본 규칙은 0이다(사용자 확정).

export type AllowanceRpcCall = {
  owner: Address;
  spender: Address;
  // 호출 대상(토큰) 주소
  token: Address;
};

export type AllowanceQuery = AllowanceRpcCall & { chainId: SupportedChainId };
export type AllowanceFn = (query: AllowanceQuery) => bigint;

// 기본 allowance 규칙: 모든 키에 0
export const DEFAULT_STUB_ALLOWANCE = 0n;
export const defaultAllowance: AllowanceFn = () => DEFAULT_STUB_ALLOWANCE;

export const STUB_MAX_UINT256 = 2n ** 256n - 1n;

export type AllowanceFilter = Partial<AllowanceQuery>;

function allowanceFilterMatches(filter: AllowanceFilter, query: AllowanceQuery): boolean {
  return (
    (filter.chainId === undefined || filter.chainId === query.chainId) &&
    (filter.owner === undefined || sameAddress(filter.owner, query.owner)) &&
    (filter.spender === undefined || sameAddress(filter.spender, query.spender)) &&
    (filter.token === undefined || sameAddress(filter.token, query.token))
  );
}

// 조건(체인·owner·spender·토큰 중 준 것)에 맞는 키만 `value`로, 나머지는 `fallback` 규칙으로 응답하는 규칙.
export function allowanceWhen(
  filter: AllowanceFilter,
  value: bigint,
  fallback: AllowanceFn = defaultAllowance,
): AllowanceFn {
  return (query) => (allowanceFilterMatches(filter, query) ? value : fallback(query));
}

// 모든 키에 같은 값으로 응답하는 규칙
export function allowanceAlways(value: bigint): AllowanceFn {
  return () => value;
}

// allowance 요청 조건 모음
export const matchAllowance = {
  // 모든 allowance 요청(분류 양성 대조에도 쓴다)
  any: ((request) => request.kind === "allowance") as RequestMatcher,
  // 조건(체인·owner·spender·토큰 중 준 것)에 맞는 allowance 요청
  query:
    (filter: AllowanceFilter): RequestMatcher =>
    (request) =>
      request.kind === "allowance" &&
      request.allowance !== undefined &&
      allowanceFilterMatches(filter, { chainId: request.chainId, ...request.allowance }),
};

// ─── T-7(F5) 추가: 영수증 계열 스텁 ───────────────────────────────────
// 앱은 트랜잭션 체인의 RPC 프록시로 viem `waitForTransactionReceipt`(시간 제한 없음)를 쓴다.
// viem은 먼저 `eth_getTransactionReceipt`를 한 번 보내고, 영수증이 없으면 `eth_blockNumber`를 폴링하며
// 새 블록마다 `eth_getTransactionByHash`(처음 한 번, 실패하면 viem 내부 재시도)·`eth_getTransactionReceipt`를 보내고,
// 영수증이 없고 트랜잭션이 대기 중이면 교체 확인용 `eth_getBlockByNumber`를 보낸다.
// - `eth_blockNumber`는 요청마다 블록 번호를 1씩 올려 응답한다. viem은 교체 확인 중에 온 블록 이벤트를 건너뛰므로,
//   번호가 그대로면 대기가 멈춘다. 폴링마다 번호가 진행되어 다음 폴링에서 영수증을 다시 조회한다.
// - 영수증·트랜잭션·블록 응답은 viem 포매터(formatTransactionReceipt·formatTransaction·formatBlock)가 받는 RPC 형태다.
// - 실패(`failReceiptWhen`)는 transport 재시도 대상이 아닌 JSON-RPC 오류(-32000)다.
//   영수증 미발견과 `eth_getTransactionByHash` 지속 실패를 함께 주면 viem 내부 재시도(6회, 지수 대기 합계 12.6초)가 소진되어 대기가 reject된다.

export type ReceiptQuery = { chainId: SupportedChainId; hash: Hash };

// `not-found`는 `result: null`(viem `TransactionReceiptNotFoundError`)이다.
export type ReceiptStatus = "success" | "reverted" | "not-found";
// `pending`은 블록에 들어가지 않은 트랜잭션(blockNumber null), `not-found`는 `result: null`이다.
export type TransactionLookup = "pending" | "not-found";

export type ReceiptRule = {
  receipt(query: ReceiptQuery): ReceiptStatus;
  transaction(query: ReceiptQuery): TransactionLookup;
};

// 기본 영수증 규칙: 영수증 성공(트랜잭션 조회는 대기 중)
export const defaultReceiptRule: ReceiptRule = {
  receipt: () => "success",
  transaction: () => "pending",
};

// 모든 해시에 같은 영수증 상태(와 트랜잭션 조회 결과)로 응답하는 규칙
export function makeReceiptRule(
  receipt: ReceiptStatus,
  transaction: TransactionLookup = "pending",
): ReceiptRule {
  return { receipt: () => receipt, transaction: () => transaction };
}

export const RECEIPT_METHODS = [
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_blockNumber",
  "eth_getBlockByNumber",
] as const;
export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];

// 첫 `eth_blockNumber` 응답 직전의 블록 번호
export const STUB_START_BLOCK = 20_000_000n;

const STUB_TX_PARTY: Address = "0x0000000000000000000000000000000000000001";
const ZERO_BLOOM: Hex = `0x${"00".repeat(256)}`;
const ZERO_WORD: Hex = `0x${"00".repeat(32)}`;

function stubBlockHash(chainId: SupportedChainId, blockNumber: bigint): Hash {
  return keccak256(toHex(`gopepe-stub-block-${chainId}-${blockNumber}`));
}

// 영수증 계열 요청 조건 모음
export const matchReceipt = {
  // 모든 영수증 계열 요청(분류 양성 대조에도 쓴다)
  any: ((request) => request.kind === "receipt") as RequestMatcher,
  method:
    (...methods: ReceiptMethod[]): RequestMatcher =>
    (request) =>
      request.kind === "receipt" && (methods as string[]).includes(request.method),
  // 해시로 조회하는 요청(`eth_getTransactionReceipt`·`eth_getTransactionByHash`) 중 해당 해시
  hash:
    (hash: Hash, inner?: RequestMatcher): RequestMatcher =>
    (request) =>
      request.kind === "receipt" &&
      request.txHash !== undefined &&
      request.txHash.toLowerCase() === hash.toLowerCase() &&
      (inner ? inner(request) : true),
};

// 견적 규칙 보조(T-7 F5 추가): 모든 티어가 수령량 = 입력 금액, slot0 가격 1(sqrtPriceX96 = 2^96)로 응답한다.
// 가격 영향이 0 이하(`normal` 등급)이고, 입력 금액이 충분하면 최소 수령량이 0보다 크다. 수령량이 같으므로 가장 낮은 티어가 고른 티어다.
export const parityQuoteRule: QuoteRule = {
  quote: (query) => ({
    status: "ok",
    amountOut: query.amountIn,
    sqrtPriceX96After: DEFAULT_SQRT_PRICE_X96_AFTER,
  }),
  slot0: () => ({ status: "ok", sqrtPriceX96: STUB_Q96 }),
};

// ─── T-6(F6) 추가: 교체 주입 ──────────────────────────────────────────
// viem `waitForTransactionReceipt`는 원 트랜잭션을 `eth_getTransactionByHash`로 한 번 대기 중으로 조회해 두고,
// 영수증이 없으면 블록마다 `eth_getBlockByNumber(n, true)`에서 같은 보낸 계정·nonce의 다른 해시를 찾아 그 영수증으로 끝낸다.
// 사유는 대체 트랜잭션의 받는 주소·값·데이터가 원과 같으면 `repriced`, 대체가 자기 주소로 값 0이면 `cancelled`, 그 밖은 `replaced`다.
// - 원 트랜잭션 필드: `setTransactionFields`로 해시별로 준다(보낸 계정·nonce·받는 주소·값·데이터).
// - 대체 트랜잭션: `addBlockTransaction`으로 지정 블록 이후 모든 블록에 싣는다(스텁 블록 번호는 요청마다 오르고 viem이 블록을 건너뛸 수 있다).
// - 대체 영수증: 영수증 규칙(`receiptRuleByHash`)으로 대체 해시에 응답한다. 원 해시 영수증은 미발견으로 둔다.
// 기본 응답(빈 블록 트랜잭션, 고정 대기 트랜잭션)은 바꾸지 않는다.

export type StubTransaction = {
  hash: Hash;
  from: Address;
  to: Address | null;
  nonce: number;
  value: bigint;
  input: Hex;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type TransactionFieldsFn = (query: ReceiptQuery) => StubTransaction | undefined;

const STUB_MAX_FEE_PER_GAS = 1_000_000_000n;
const STUB_MAX_PRIORITY_FEE_PER_GAS = 1n;
// `replaced` 사유 대체 트랜잭션의 받는 주소(원 트랜잭션·보낸 계정과 다르다)
export const STUB_REPLACED_TO: Address = "0x000000000000000000000000000000000000dEaD";

// 지정하지 않은 필드는 기본값(받는 주소 0x…01, 값 0, 데이터 0x, 수수료 1 gwei·1 wei)인 스텁 트랜잭션
export function stubTransaction(
  fields: Pick<StubTransaction, "hash" | "from" | "nonce"> & Partial<StubTransaction>,
): StubTransaction {
  return {
    to: STUB_TX_PARTY,
    value: 0n,
    input: "0x",
    maxFeePerGas: STUB_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: STUB_MAX_PRIORITY_FEE_PER_GAS,
    ...fields,
  };
}

// n번째(1부터) 스텁 대체 트랜잭션 해시. 지갑의 `stubTransactionHash`와 겹치지 않는다.
export function stubReplacementHash(n: number): Hash {
  return keccak256(toHex(`gopepe-stub-replacement-${n}`));
}

// 원 트랜잭션과 같은 보낸 계정·nonce로, viem이 `reason`으로 분류할 필드를 가진 대체 트랜잭션. 수수료는 원의 2배다.
// - `repriced`: 받는 주소·값·데이터가 원과 같다
// - `cancelled`: 자기 주소(보낸 계정)로 값 0, 데이터 0x
// - `replaced`: 받는 주소(`STUB_REPLACED_TO`)·값(1 wei)이 원과 다르다
export function stubReplacementTransaction(
  reason: ReplacementReason,
  original: StubTransaction,
  hash: Hash,
): StubTransaction {
  const repriced: StubTransaction = {
    ...original,
    hash,
    maxFeePerGas: original.maxFeePerGas * 2n,
    maxPriorityFeePerGas: original.maxPriorityFeePerGas * 2n,
  };
  switch (reason) {
    case "repriced":
      return repriced;
    case "cancelled":
      return { ...repriced, to: original.from, value: 0n, input: "0x" };
    case "replaced":
      return { ...repriced, to: STUB_REPLACED_TO, value: 1n, input: "0x" };
  }
}

// 해시별 영수증 상태 규칙. 목록에 없는 해시는 `fallback`(기본 미발견)이다. 트랜잭션 조회는 `transaction`(기본 대기 중)이다.
export function receiptRuleByHash(
  receipts: Readonly<Record<string, ReceiptStatus>>,
  {
    fallback = "not-found",
    transaction = () => "pending",
  }: { fallback?: ReceiptStatus; transaction?: ReceiptRule["transaction"] } = {},
): ReceiptRule {
  const lowered = new Map(
    Object.entries(receipts).map(([hash, status]) => [hash.toLowerCase(), status]),
  );
  return {
    receipt: ({ hash }) => lowered.get(hash.toLowerCase()) ?? fallback,
    transaction,
  };
}

// viem 포매터가 받는 RPC 트랜잭션 형태. `block`이 있으면 블록에 들어간 트랜잭션이다.
function rpcTransaction(
  chainId: SupportedChainId,
  transaction: StubTransaction,
  block: { number: bigint; index: number } | null,
) {
  return {
    hash: transaction.hash,
    nonce: numberToHex(transaction.nonce),
    blockHash: block ? stubBlockHash(chainId, block.number) : null,
    blockNumber: block ? numberToHex(block.number) : null,
    transactionIndex: block ? numberToHex(block.index) : null,
    from: transaction.from,
    to: transaction.to,
    value: numberToHex(transaction.value),
    gas: numberToHex(300_000n),
    maxFeePerGas: numberToHex(transaction.maxFeePerGas),
    maxPriorityFeePerGas: numberToHex(transaction.maxPriorityFeePerGas),
    input: transaction.input,
    type: "0x2",
    chainId: numberToHex(chainId),
    accessList: [],
    v: "0x0",
    r: ZERO_WORD,
    s: ZERO_WORD,
    yParity: "0x0",
  };
}

type JsonRpcItem = { jsonrpc?: string; id?: number | string; method: string; params?: unknown[] };

type Gate = {
  // T-6(F3) 추가: 기존 `hold`는 잔액 쪽(`balance`), `holdQuote`는 견적 요청(`quote`)에만 적용된다.
  // T-7(F5) 추가: `holdAllowance`는 allowance 요청(`allowance`), `holdReceipt`는 영수증 계열(`receipt`)에만 적용된다.
  // T-8(F9) 추가: `holdUsdPrice`는 단가 요청(`usd-price`)에만 적용된다.
  scope: "balance" | "quote" | "allowance" | "receipt" | "usd-price";
  matcher: RequestMatcher;
  released: boolean;
  held: number;
  promise: Promise<void>;
  resolve: () => void;
};

const BALANCE_OF_SELECTOR = "0x70a08231";
// T-7(F5) 추가: ERC-20 `allowance(address,address)`
const ALLOWANCE_SELECTOR = "0xdd62ed3e";

function decodeAllowanceCall(to: string, data: Hex): AllowanceRpcCall | undefined {
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName !== "allowance") return undefined;
    return {
      owner: getAddress(decoded.args[0]),
      spender: getAddress(decoded.args[1]),
      token: getAddress(to),
    };
  } catch {
    return undefined;
  }
}

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

// T-8(F9) 추가: `answer`가 HTTP 429 응답을 요청할 때 돌려주는 표지
const HTTP_429 = Symbol("http-429");

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
  // T-7(F5) 추가
  let allowanceFn: AllowanceFn = defaultAllowance;
  let allowanceFailMatcher: RequestMatcher | null = null;
  let currentReceiptRule: ReceiptRule = defaultReceiptRule;
  let receiptFailMatcher: RequestMatcher | null = null;
  const blockNumbers = new Map<SupportedChainId, bigint>();
  const currentBlock = (chainId: SupportedChainId) => blockNumbers.get(chainId) ?? STUB_START_BLOCK;
  // T-6(F6) 추가
  let transactionFieldsFn: TransactionFieldsFn | null = null;
  const blockTransactions: {
    chainId: SupportedChainId;
    transaction: StubTransaction;
    fromBlock: bigint;
  }[] = [];
  // T-8(F9) 추가
  let usdPriceRule: QuoteRule = defaultUsdPriceRule;
  let usdPriceFailMatcher: RequestMatcher | null = null;
  let usdPriceHttp429Matcher: RequestMatcher | null = null;

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
      // T-7(F5) 추가: 토큰 주소로 가는 ERC-20 `allowance` 호출은 allowance 요청으로 따로 분류한다.
      if (to && data?.toLowerCase().startsWith(ALLOWANCE_SELECTOR)) {
        const allowance = decodeAllowanceCall(to, data);
        if (allowance) {
          return { ...common, kind: "allowance", account: undefined, tokens: [], allowance };
        }
      }
      // T-8(F9) 추가: 첫 하위 호출이 QuoterV2 호출인 aggregate3는 단가 요청으로 따로 분류한다(견적 판정보다 먼저).
      const usdPrice = data ? decodeUsdPriceAggregate3(chainId, data) : undefined;
      if (usdPrice) {
        return {
          ...common,
          kind: "usd-price",
          account: undefined,
          tokens: [],
          usdPrice: usdPrice.call,
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
    // T-7(F5) 추가: 영수증 계열 메서드
    if ((RECEIPT_METHODS as readonly string[]).includes(item.method)) {
      const first = item.params?.[0];
      const byHash =
        item.method === "eth_getTransactionReceipt" || item.method === "eth_getTransactionByHash";
      return {
        ...common,
        kind: "receipt",
        account: undefined,
        tokens: [],
        txHash: byHash && typeof first === "string" ? (first as Hash) : undefined,
      };
    }
    return { ...common, kind: "other", account: undefined, tokens: [] };
  }

  // T-7(F5) 추가: 영수증 계열 응답(viem 포매터가 받는 RPC 형태). `null`은 미발견이다.
  function receiptResult(request: BalanceRpcRequest, item: JsonRpcItem): unknown {
    const { chainId } = request;
    switch (item.method) {
      case "eth_blockNumber": {
        const next = currentBlock(chainId) + 1n;
        blockNumbers.set(chainId, next);
        return numberToHex(next);
      }
      case "eth_getBlockByNumber": {
        const tag = item.params?.[0];
        const number =
          typeof tag === "string" && tag.startsWith("0x") ? BigInt(tag) : currentBlock(chainId);
        // T-6(F6) 추가: 지정 블록 이후에 실은 트랜잭션. 두 번째 인자가 true면 트랜잭션 객체, 아니면 해시 목록이다.
        const included = blockTransactions
          .filter((entry) => entry.chainId === chainId && number >= entry.fromBlock)
          .map((entry) => entry.transaction);
        const includeTransactions = item.params?.[1] === true;
        return {
          hash: stubBlockHash(chainId, number),
          parentHash: stubBlockHash(chainId, number - 1n),
          number: numberToHex(number),
          timestamp: numberToHex(1_700_000_000n + number),
          nonce: "0x0000000000000000",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          gasLimit: numberToHex(30_000_000n),
          gasUsed: "0x0",
          baseFeePerGas: "0x1",
          miner: STUB_TX_PARTY,
          extraData: "0x",
          logsBloom: ZERO_BLOOM,
          mixHash: ZERO_WORD,
          receiptsRoot: ZERO_WORD,
          stateRoot: ZERO_WORD,
          transactionsRoot: ZERO_WORD,
          sha3Uncles: ZERO_WORD,
          size: "0x0",
          uncles: [],
          transactions: includeTransactions
            ? included.map((transaction, index) =>
                rpcTransaction(chainId, transaction, { number, index }),
              )
            : included.map((transaction) => transaction.hash),
        };
      }
      case "eth_getTransactionByHash": {
        const hash = request.txHash!;
        if (currentReceiptRule.transaction({ chainId, hash }) === "not-found") return null;
        // T-6(F6) 추가: 해시별 필드가 있으면 그 필드로 대기 중 트랜잭션을 돌려준다.
        const fields = transactionFieldsFn?.({ chainId, hash });
        if (fields) return rpcTransaction(chainId, { ...fields, hash }, null);
        return {
          hash,
          nonce: "0x0",
          blockHash: null,
          blockNumber: null,
          transactionIndex: null,
          from: STUB_TX_PARTY,
          to: STUB_TX_PARTY,
          value: "0x0",
          gas: "0x5208",
          maxFeePerGas: "0x3b9aca00",
          maxPriorityFeePerGas: "0x1",
          input: "0x",
          type: "0x2",
          chainId: numberToHex(chainId),
          accessList: [],
          v: "0x0",
          r: ZERO_WORD,
          s: ZERO_WORD,
          yParity: "0x0",
        };
      }
      case "eth_getTransactionReceipt": {
        const hash = request.txHash!;
        const status = currentReceiptRule.receipt({ chainId, hash });
        if (status === "not-found") return null;
        const blockNumber = currentBlock(chainId);
        return {
          blockHash: stubBlockHash(chainId, blockNumber),
          blockNumber: numberToHex(blockNumber),
          contractAddress: null,
          cumulativeGasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          from: STUB_TX_PARTY,
          gasUsed: "0x5208",
          logs: [],
          logsBloom: ZERO_BLOOM,
          status: status === "success" ? "0x1" : "0x0",
          to: STUB_TX_PARTY,
          transactionHash: hash,
          transactionIndex: "0x0",
          type: "0x2",
        };
      }
      default:
        return undefined;
    }
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
      // T-7(F5) 추가
      case "allowance": {
        const call = request.allowance!;
        return encodeFunctionResult({
          abi: erc20Abi,
          functionName: "allowance",
          result: allowanceFn({ chainId, ...call }),
        });
      }
      case "receipt":
        return receiptResult(request, item);
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
      // T-8(F9) 추가
      case "usd-price": {
        const { data } = readCallObject(item.params);
        const decoded = decodeUsdPriceAggregate3(chainId, data!)!;
        const rule = usdPriceRule;
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: "aggregate3",
          result: decoded.entries.map((entry) => answerUsdPriceEntry(chainId, entry, rule)),
        });
      }
    }
  }

  async function answer(chainId: SupportedChainId, item: JsonRpcItem, signal?: AbortSignal) {
    const request = classify(chainId, item);
    recorded.push(request);
    const id = item.id ?? null;

    // 견적 요청은 견적 쪽 붙잡기·실패 규칙만, 그 밖의 요청은 기존 규칙만 적용한다(T-6 F3).
    // T-7(F5) 추가: allowance 요청과 영수증 계열도 각자의 붙잡기·실패 규칙만 적용한다.
    // T-8(F9) 추가: 단가 요청은 단가 쪽 붙잡기·실패·HTTP 429 규칙만 적용한다.
    const scope: Gate["scope"] =
      request.kind === "quote" ||
      request.kind === "allowance" ||
      request.kind === "receipt" ||
      request.kind === "usd-price"
        ? request.kind
        : "balance";
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

    if (scope === "usd-price" && usdPriceHttp429Matcher?.(request)) {
      request.status = "failed";
      return HTTP_429;
    }
    const activeFailMatcher =
      scope === "quote"
        ? quoteFailMatcher
        : scope === "allowance"
          ? allowanceFailMatcher
          : scope === "receipt"
            ? receiptFailMatcher
            : scope === "usd-price"
              ? usdPriceFailMatcher
              : failMatcher;
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
    // T-8(F9) 추가: 단가 요청에 HTTP 429 규칙이 맞으면 HTTP 응답 전체를 429로 돌려준다.
    if (responses.some((response) => response === HTTP_429)) {
      return new Response(JSON.stringify({ error: "stub: too many requests" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
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
    // T-7(F5) 추가
    setAllowances(fn) {
      allowanceFn = fn;
    },
    allowanceOf(query) {
      return allowanceFn(query);
    },
    failAllowanceWhen(matcher) {
      allowanceFailMatcher = matcher;
    },
    holdAllowance(matcher) {
      return addGate("allowance", matcher ?? (() => true));
    },
    setReceiptRule(rule) {
      currentReceiptRule = rule;
    },
    receiptRule() {
      return currentReceiptRule;
    },
    failReceiptWhen(matcher) {
      receiptFailMatcher = matcher;
    },
    holdReceipt(matcher) {
      return addGate("receipt", matcher ?? matchReceipt.method("eth_getTransactionReceipt"));
    },
    blockNumber(chainId) {
      return currentBlock(chainId);
    },
    // T-6(F6) 추가
    setTransactionFields(fn) {
      transactionFieldsFn = fn;
    },
    addBlockTransaction(chainId, transaction, fromBlock) {
      blockTransactions.push({ chainId, transaction, fromBlock });
    },
    // T-8(F9) 추가
    setUsdPriceRule(rule) {
      usdPriceRule = rule;
    },
    usdPriceRule() {
      return usdPriceRule;
    },
    failUsdPriceWhen(matcher) {
      usdPriceFailMatcher = matcher;
    },
    respondUsdPriceHttp429When(matcher) {
      usdPriceHttp429Matcher = matcher;
    },
    holdUsdPrice(matcher) {
      return addGate("usd-price", matcher ?? (() => true));
    },
  };
}
