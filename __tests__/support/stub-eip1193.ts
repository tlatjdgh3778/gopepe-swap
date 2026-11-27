import { type Address, type Hash, type Hex, keccak256, numberToHex, toHex } from "viem";

// 지갑 통합 테스트(T-10)용 스텁 EIP-1193 provider.
// wagmi는 실제 코드를 쓰고, 지갑(브라우저 확장) 자리만 이 스텁이 맡는다.
// 받은 요청을 모두 기록하고, 메서드별 동작은 테스트가 handler로 바꿀 수 있다.

export type StubRequest = {
  method: string;
  params?: unknown;
};

export type StubHandler = (params: unknown) => unknown;

type Listener = (...args: unknown[]) => void;

export type StubEip1193Provider = {
  request(args: StubRequest): Promise<unknown>;
  on(event: string, listener: Listener): void;
  removeListener(event: string, listener: Listener): void;
};

export type StubEip1193Options = {
  // 지갑의 현재 체인
  chainId: number;
  // 지갑 계정
  accounts: readonly Address[];
  // 이 앱에 계정 접근을 이미 허용했는지. true면 `eth_accounts`가 계정을 돌려준다(새로고침 후 복원 대상).
  authorized?: boolean;
  // 지갑에 등록된 체인. 여기에 없는 체인으로 전환하면 4902(체인 없음)로 끝난다. 기본값은 `[chainId]`.
  knownChainIds?: readonly number[];
};

export type StubEip1193 = {
  provider: StubEip1193Provider;
  // 받은 요청 기록(받은 순서)
  requests: StubRequest[];
  readonly chainId: number;
  // 메서드 동작을 바꾼다. undefined를 주면 기본 동작으로 돌아간다.
  setHandler(method: string, handler: StubHandler | undefined): void;
  // 지갑 쪽에서 체인이 바뀐 것처럼 체인을 바꾸고 `chainChanged` 이벤트를 보낸다.
  changeChain(chainId: number): void;
  // 지갑 쪽에서 계정이 바뀐 것처럼 계정 목록을 바꾸고 `accountsChanged` 이벤트를 보낸다(T-6 추가).
  // 이후 `eth_accounts`·`eth_requestAccounts`는 바뀐 계정을 돌려준다.
  changeAccounts(accounts: readonly Address[]): void;
  // T-7(F5) 추가: 메서드의 기본 동작을 요청 기록 없이 실행한다(덮어쓴 handler에서 기본 동작으로 응답할 때 쓴다).
  callDefault(method: string, params: unknown): unknown;
};

// EIP-1193 오류 형태(`code`가 있는 Error)
export function providerRpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

export const USER_REJECTED_CODE = 4001;
export const UNRECOGNIZED_CHAIN_CODE = 4902;
const UNSUPPORTED_METHOD_CODE = 4200;

function readChainIdParam(params: unknown): number {
  const [first] = params as [{ chainId: string }];
  return Number(first.chainId);
}

export function createStubEip1193(options: StubEip1193Options): StubEip1193 {
  let chainId = options.chainId;
  let authorized = options.authorized ?? false;
  const knownChainIds = new Set<number>(options.knownChainIds ?? [options.chainId]);
  const listeners = new Map<string, Set<Listener>>();
  const overrides = new Map<string, StubHandler>();
  const requests: StubRequest[] = [];

  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of Array.from(listeners.get(event) ?? [])) listener(...args);
  };

  const setChain = (nextChainId: number) => {
    chainId = nextChainId;
    emit("chainChanged", numberToHex(nextChainId));
  };

  const defaults: Record<string, StubHandler> = {
    eth_chainId: () => numberToHex(chainId),
    eth_accounts: () => (authorized ? [...options.accounts] : []),
    eth_requestAccounts: () => {
      authorized = true;
      return [...options.accounts];
    },
    wallet_requestPermissions: () => {
      authorized = true;
      return [
        {
          parentCapability: "eth_accounts",
          caveats: [{ type: "restrictReturnedAccounts", value: [...options.accounts] }],
        },
      ];
    },
    wallet_revokePermissions: () => {
      authorized = false;
      return null;
    },
    wallet_switchEthereumChain: (params) => {
      const target = readChainIdParam(params);
      if (!knownChainIds.has(target)) {
        throw providerRpcError(UNRECOGNIZED_CHAIN_CODE, "Unrecognized chain ID.");
      }
      setChain(target);
      return null;
    },
    // 실제 지갑처럼 체인을 등록한 뒤 그 체인으로 전환한다.
    wallet_addEthereumChain: (params) => {
      const target = readChainIdParam(params);
      knownChainIds.add(target);
      setChain(target);
      return null;
    },
  };

  const provider: StubEip1193Provider = {
    async request(args) {
      requests.push({ method: args.method, params: args.params });
      const handler = overrides.get(args.method) ?? defaults[args.method];
      if (!handler) {
        throw providerRpcError(UNSUPPORTED_METHOD_CODE, `Unsupported method: ${args.method}`);
      }
      return handler(args.params);
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener);
    },
  };

  return {
    provider,
    requests,
    get chainId() {
      return chainId;
    },
    setHandler(method, handler) {
      if (handler) overrides.set(method, handler);
      else overrides.delete(method);
    },
    changeChain(nextChainId) {
      setChain(nextChainId);
    },
    callDefault(method, params) {
      const handler = defaults[method];
      if (!handler) {
        throw providerRpcError(UNSUPPORTED_METHOD_CODE, `Unsupported method: ${method}`);
      }
      return handler(params);
    },
    changeAccounts(nextAccounts) {
      const accounts = [...nextAccounts];
      overrides.set("eth_accounts", () => (authorized ? [...accounts] : []));
      overrides.set("eth_requestAccounts", () => {
        authorized = true;
        return [...accounts];
      });
      emit("accountsChanged", [...accounts]);
    },
  };
}

export type Eip6963Info = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

// EIP-6963으로 스텁 지갑을 알린다. 앱의 요청(`eip6963:requestProvider`)에도 응답한다. 반환값은 정리 함수다.
export function announceEip6963Provider(stub: StubEip1193, info: Eip6963Info): () => void {
  const detail = Object.freeze({ info, provider: stub.provider });
  const announce = () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  };
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  return () => window.removeEventListener("eip6963:requestProvider", announce);
}

// ─── T-7(F5) 추가: 트랜잭션 전송·체인 전환 응답 제어 ─────────────────────
// 지갑 자리의 `eth_sendTransaction`(가스 추정·서명·전송은 지갑이 맡는다)과 `wallet_switchEthereumChain` 응답을 테스트가 정한다.

// 전송 요청으로 세는 메서드. viem은 `eth_sendTransaction`이 입력 오류(-32000 등)로 끝나면 `wallet_sendTransaction`을 한 번 더 시도한다.
export const SEND_TRANSACTION_METHODS = ["eth_sendTransaction", "wallet_sendTransaction"];

// 지갑의 가스 추정 실패 등 4001이 아닌 JSON-RPC 오류(viem `InvalidInputRpcError`, 재시도하지 않는다)
export const RPC_INVALID_INPUT_CODE = -32000;
// 거부가 아닌 지갑 내부 오류
export const RPC_INTERNAL_ERROR_CODE = -32603;
const METHOD_NOT_FOUND_CODE = -32601;

export type WalletHoldGate = {
  // 붙잡은 요청을 모두 풀고, 이후 요청은 붙잡지 않는다. 풀 때의 응답 방식으로 응답한다.
  release(): void;
  // 지금까지 이 게이트가 붙잡은 요청 수
  readonly heldCount: number;
};

type WalletGate = { promise: Promise<void>; release(): void; held: number; released: boolean };

function createWalletGate(): WalletGate {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const gate: WalletGate = {
    promise,
    held: 0,
    released: false,
    release() {
      gate.released = true;
      resolve();
    },
  };
  return gate;
}

function toHoldGate(gate: WalletGate, onRelease: () => void): WalletHoldGate {
  return {
    release() {
      onRelease();
      gate.release();
    },
    get heldCount() {
      return gate.held;
    },
  };
}

// `hash`는 해시로 응답, `error`는 EIP-1193 오류(`code`)로 응답한다.
// T-9(F6) 추가: `cause`를 주면 응답 오류의 원인(`cause`)으로 싣는다(지갑이 원인 체인 안쪽에 4001을 두는 형태). 없으면 기존과 같다.
export type WalletReply =
  | { type: "hash" }
  | { type: "error"; code: number; message?: string; cause?: unknown };

export type SentTransaction = {
  // 지갑 요청 기록(`stub.requests`)에서의 위치
  requestIndex: number;
  // 요청을 받은 시점의 지갑 체인
  walletChainId: number;
  // 요청을 받은 시각(`Date.now()`, 가짜 타이머에서는 가짜 시계)
  at: number;
  from: Address | undefined;
  to: Address | undefined;
  data: Hex | undefined;
  value: Hex | undefined;
  // 요청 params에 `chainId`가 있으면 그 값(10진). 없으면 undefined
  chainId: number | undefined;
  // 지갑이 돌려준 해시. 아직 응답하지 않았거나 오류로 끝났으면 null
  hash: Hash | null;
  // 오류로 끝났으면 그 코드. 아니면 null
  errorCode: number | null;
};

export type WalletTransactionControl = {
  // 받은 `eth_sendTransaction` 요청(받은 순서)
  readonly sent: readonly SentTransaction[];
  // 이후 응답 방식을 바꾼다(기본 `hash`). 붙잡힌 요청은 풀 때의 방식으로 응답한다.
  reply(next: WalletReply): void;
  // 이후 `eth_sendTransaction` 요청을 `release()` 전까지 붙잡는다.
  hold(): WalletHoldGate;
  // 지금까지 돌려준 해시(받은 순서)
  hashes(): Hash[];
};

// n번째(1부터) 스텁 트랜잭션 해시
export function stubTransactionHash(n: number): Hash {
  return keccak256(toHex(`gopepe-stub-tx-${n}`));
}

type SendParams = [
  { from?: Address; to?: Address; data?: Hex; input?: Hex; value?: Hex; chainId?: Hex },
];

// 스텁 지갑의 `eth_sendTransaction`을 기록하고 응답 방식에 따라 해시·오류로 응답한다.
// `wallet_sendTransaction`은 지원하지 않는 메서드(-32601)로 응답해 viem이 원래 오류를 그대로 던지게 한다.
export function installWalletTransactions(stub: StubEip1193): WalletTransactionControl {
  const sent: SentTransaction[] = [];
  let mode: WalletReply = { type: "hash" };
  let gate: WalletGate | null = null;
  let counter = 0;

  stub.setHandler("eth_sendTransaction", async (params) => {
    const [request] = (params ?? [{}]) as SendParams;
    const record: SentTransaction = {
      requestIndex: stub.requests.length - 1,
      walletChainId: stub.chainId,
      at: Date.now(),
      from: request?.from,
      to: request?.to,
      data: request?.data ?? request?.input,
      value: request?.value,
      chainId: request?.chainId !== undefined ? Number(request.chainId) : undefined,
      hash: null,
      errorCode: null,
    };
    sent.push(record);
    const holding = gate && !gate.released ? gate : null;
    if (holding) {
      holding.held += 1;
      await holding.promise;
    }
    const reply = mode;
    if (reply.type === "error") {
      record.errorCode = reply.code;
      const error = providerRpcError(
        reply.code,
        reply.message ?? `stub: send failed (${reply.code})`,
      );
      if (reply.cause !== undefined) Object.assign(error, { cause: reply.cause });
      throw error;
    }
    counter += 1;
    record.hash = stubTransactionHash(counter);
    return record.hash;
  });
  stub.setHandler("wallet_sendTransaction", () => {
    throw providerRpcError(METHOD_NOT_FOUND_CODE, "Method not found");
  });

  return {
    sent,
    reply(next) {
      mode = next;
    },
    hold() {
      const next = createWalletGate();
      gate = next;
      return toHoldGate(next, () => {
        if (gate === next) gate = null;
      });
    },
    hashes() {
      return sent.flatMap((record) => (record.hash ? [record.hash] : []));
    },
  };
}

// `switch`는 기본 동작(등록된 체인이면 지갑 체인을 바꾸고 null, 없으면 4902), `error`는 EIP-1193 오류로 응답한다.
export type ChainSwitchReply =
  | { type: "switch" }
  | { type: "error"; code: number; message?: string };

export type ChainSwitchControl = {
  // 이후 `wallet_switchEthereumChain` 응답 방식을 바꾼다(기본 `switch`). 붙잡힌 요청은 풀 때의 방식으로 응답한다.
  reply(next: ChainSwitchReply): void;
  // 이후 `wallet_switchEthereumChain` 요청을 `release()` 전까지 붙잡는다.
  hold(): WalletHoldGate;
};

export function installChainSwitch(stub: StubEip1193): ChainSwitchControl {
  let mode: ChainSwitchReply = { type: "switch" };
  let gate: WalletGate | null = null;

  stub.setHandler("wallet_switchEthereumChain", async (params) => {
    const holding = gate && !gate.released ? gate : null;
    if (holding) {
      holding.held += 1;
      await holding.promise;
    }
    const reply = mode;
    if (reply.type === "error") {
      throw providerRpcError(reply.code, reply.message ?? `stub: switch failed (${reply.code})`);
    }
    return stub.callDefault("wallet_switchEthereumChain", params);
  });

  return {
    reply(next) {
      mode = next;
    },
    hold() {
      const next = createWalletGate();
      gate = next;
      return toHoldGate(next, () => {
        if (gate === next) gate = null;
      });
    },
  };
}

// ─── T-6(batch-calls) 추가: EIP-5792 `wallet_*` 세 메서드 응답 제어 ─────────────────────
// 지갑 자리의 `wallet_getCapabilities`·`wallet_sendCalls`·`wallet_getCallsStatus` 응답을 테스트가 정한다.
// 설치하지 않으면 세 메서드는 지금처럼 지원하지 않는 메서드(4200)로 끝난다. 설치해도 처음 응답 방식은
// `wallet_getCapabilities` 4200 오류(설치 전과 같음), `wallet_sendCalls` 배치 id, `wallet_getCallsStatus` 200·receipt 1개 success다.
// 응답 형태는 EIP-5792(version 2.0.0)와 viem `getCapabilities`·`sendCalls`·`getCallsStatus`가 받는 RPC 형태다.
// 실제 지갑의 capabilities·오류·상태 코드 형태는 이 스텁으로 증명하지 못한다.

export const WALLET_CALLS_METHODS = [
  "wallet_getCapabilities",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
] as const;

// EIP-5792 오류 code(배치 미지원 분류 표본)
export const UNSUPPORTED_NON_OPTIONAL_CAPABILITY_CODE = 5700;
export const UNSUPPORTED_CHAIN_ID_CODE = 5710;
export const DUPLICATE_ID_CODE = 5720;
export const BUNDLE_TOO_LARGE_CODE = 5740;
export const ATOMIC_READY_UPGRADE_REJECTED_CODE = 5750;
export const UNSUPPORTED_METHOD_RPC_CODE = UNSUPPORTED_METHOD_CODE;
export const METHOD_NOT_FOUND_RPC_CODE = METHOD_NOT_FOUND_CODE;

// 오류 응답. `cause`를 주면 응답 오류의 원인(`cause`)으로 싣는다.
export type WalletCallsErrorReply = {
  type: "error";
  code: number;
  message?: string;
  cause?: unknown;
};

function walletCallsError(reply: WalletCallsErrorReply, fallbackMessage: string): Error {
  const error = providerRpcError(reply.code, reply.message ?? fallbackMessage);
  if (reply.cause !== undefined) Object.assign(error, { cause: reply.cause });
  return error;
}

// 붙잡기 게이트를 쓰는 공통 대기. 게이트가 열려 있으면 풀릴 때까지 기다린다.
async function waitWalletGate(gate: WalletGate | null): Promise<void> {
  const holding = gate && !gate.released ? gate : null;
  if (!holding) return;
  holding.held += 1;
  await holding.promise;
}

// ── wallet_getCapabilities ──

// 체인 ID(10진) → 그 체인의 capabilities 객체. 응답에서는 키를 `0x` 16진 체인 ID로 바꾼다.
// 체인 항목을 빼면 "선택 체인 항목 없음", `atomic` 없는 객체를 주면 "`atomic` 항목 없음" 표본이다.
export type StubCapabilitiesByChain = Readonly<Record<number, Readonly<Record<string, unknown>>>>;

export type WalletCapabilitiesReply =
  | { type: "capabilities"; chains: StubCapabilitiesByChain }
  | WalletCallsErrorReply;

export type CapabilitiesRequestRecord = {
  // 지갑 요청 기록(`stub.requests`)에서의 위치
  requestIndex: number;
  // 요청을 받은 시각(`Date.now()`, 가짜 타이머에서는 가짜 시계)
  at: number;
  // 요청 params의 계정(첫 인자). 없으면 undefined
  account: Address | undefined;
  // 요청 params의 체인 ID 목록(둘째 인자, 10진). 없으면 빈 배열
  chainIds: number[];
  // 응답 결과. 응답 전 `pending`, capabilities로 응답하면 `ok`, 오류로 끝나면 `error`
  status: "pending" | "ok" | "error";
  // 오류로 끝났으면 그 code. 아니면 null
  errorCode: number | null;
};

// 응답 방식. 고정 응답 또는 요청마다 정하는 함수(계정·체인별 응답)
export type WalletCapabilitiesResponder =
  | WalletCapabilitiesReply
  | ((request: CapabilitiesRequestRecord) => WalletCapabilitiesReply);

export type WalletCapabilitiesControl = {
  // 받은 `wallet_getCapabilities` 요청(받은 순서)
  readonly requests: readonly CapabilitiesRequestRecord[];
  // 이후 응답 방식을 바꾼다. 붙잡힌 요청은 풀 때의 방식으로 응답한다.
  reply(next: WalletCapabilitiesResponder): void;
  // 이후 요청을 `release()` 전까지 붙잡는다.
  hold(): WalletHoldGate;
  // 계정·체인(10진)이 맞는 요청. 계정은 대소문자를 무시한다.
  requestsFor(account: Address, chainId: number): CapabilitiesRequestRecord[];
};

// 체인별 `atomic.status`만 담은 capabilities 응답(예: `{ 1: "supported" }`).
export function atomicCapabilities(
  statusByChain: Readonly<Record<number, string>>,
): WalletCapabilitiesReply {
  const chains: Record<number, Record<string, unknown>> = {};
  for (const [chainId, status] of Object.entries(statusByChain)) {
    chains[Number(chainId)] = { atomic: { status } };
  }
  return { type: "capabilities", chains };
}

function toCapabilitiesResponse(chains: StubCapabilitiesByChain): Record<Hex, unknown> {
  const response: Record<Hex, unknown> = {};
  for (const [chainId, capabilities] of Object.entries(chains)) {
    response[numberToHex(Number(chainId))] = capabilities;
  }
  return response;
}

// ── wallet_sendCalls ──

export type SentCallsCall = {
  to: Address | undefined;
  data: Hex | undefined;
  value: Hex | undefined;
};

export type SentCalls = {
  requestIndex: number;
  // 요청을 받은 시점의 지갑 체인
  walletChainId: number;
  at: number;
  // 요청 params 첫 원소 전체(원본)
  params: Readonly<Record<string, unknown>>;
  from: Address | undefined;
  // 요청 params의 `chainId`(10진). 없으면 undefined
  chainId: number | undefined;
  // 요청 params의 `atomicRequired`(원본 값)
  atomicRequired: unknown;
  version: unknown;
  capabilities: unknown;
  calls: SentCallsCall[];
  // 지갑이 돌려준 배치 id. 아직 응답하지 않았거나 오류로 끝났으면 null
  id: string | null;
  // 오류로 끝났으면 그 code. 아니면 null
  errorCode: number | null;
};

// `id`는 배치 id로 응답한다(`id`를 주지 않으면 `stubBatchId(n)`). `error`는 EIP-1193 오류로 응답한다.
export type WalletSendCallsReply = { type: "id"; id?: string } | WalletCallsErrorReply;

export type WalletSendCallsControl = {
  readonly sent: readonly SentCalls[];
  // 이후 응답 방식을 바꾼다(기본 `id`). 붙잡힌 요청은 풀 때의 방식으로 응답한다.
  reply(next: WalletSendCallsReply): void;
  hold(): WalletHoldGate;
  // 지금까지 돌려준 배치 id(받은 순서)
  ids(): string[];
};

// n번째(1부터) 스텁 배치 id
export function stubBatchId(n: number): Hex {
  return keccak256(toHex(`gopepe-stub-batch-${n}`));
}

type SendCallsParams = [
  {
    from?: Address;
    chainId?: Hex;
    atomicRequired?: unknown;
    version?: unknown;
    capabilities?: unknown;
    calls?: { to?: Address; data?: Hex; value?: Hex }[];
  },
];

// ── wallet_getCallsStatus ──

export type StubCallsReceipt = {
  status: "success" | "reverted";
  // 없으면 `stubBatchReceiptHash(배치 id, receipt 위치)`
  transactionHash?: Hash;
  blockHash?: Hash;
  blockNumber?: bigint;
  gasUsed?: bigint;
};

// `status`는 상태 코드(`statusCode`, 숫자가 아닌 값·null도 그대로 싣는다)와 receipt로 응답한다.
// `receipts`가 null이면 응답에서 `receipts` 필드를 뺀다. `chainId`가 없으면 그 배치를 보낸 요청의 체인(없으면 지갑 체인)이다.
// `error`는 EIP-1193 오류로 끝낸다(throw).
export type WalletCallsStatusReply =
  | {
      type: "status";
      statusCode: unknown;
      receipts?: readonly StubCallsReceipt[] | null;
      chainId?: number;
      atomic?: boolean;
    }
  | WalletCallsErrorReply;

export type CallsStatusRequestRecord = {
  requestIndex: number;
  at: number;
  // 조회한 배치 id
  id: string | undefined;
  // 이 요청에 쓴 응답(응답 순서열에서 고른 것). 응답 전이면 null
  reply: WalletCallsStatusReply | null;
  status: "pending" | "ok" | "error";
};

export type WalletCallsStatusControl = {
  readonly requests: readonly CallsStatusRequestRecord[];
  // 이후 응답 순서열을 바꾼다. 요청마다 다음 값으로 응답하고, 끝에 닿으면 마지막 값을 유지한다.
  // 값 하나를 주면 모든 요청에 그 값이다. 붙잡힌 요청은 풀 때의 순서열로 응답한다.
  reply(next: WalletCallsStatusReply | readonly WalletCallsStatusReply[]): void;
  hold(): WalletHoldGate;
};

// 배치 id의 index번째(0부터) 스텁 receipt 트랜잭션 해시
export function stubBatchReceiptHash(id: string, index: number): Hash {
  return keccak256(toHex(`gopepe-stub-batch-receipt-${id}-${index}`));
}

// 상태 응답을 만든다(`receipts` 생략 시 receipt 없음).
export function callsStatus(
  statusCode: unknown,
  receipts: readonly StubCallsReceipt[] | null = [],
): WalletCallsStatusReply {
  return { type: "status", statusCode, receipts };
}

// `times`번 오류(throw)로 끝낸 뒤 `then`으로 응답하는 순서열
export function throwCallsStatusThen(
  times: number,
  then: WalletCallsStatusReply,
  error: WalletCallsErrorReply = { type: "error", code: RPC_INTERNAL_ERROR_CODE },
): WalletCallsStatusReply[] {
  return [...Array.from({ length: times }, () => error), then];
}

const STUB_BATCH_RECEIPT_BLOCK = 20_000_000n;
const STUB_BATCH_RECEIPT_GAS = 100_000n;

function toRpcCallsReceipt(id: string, index: number, receipt: StubCallsReceipt) {
  const blockNumber = receipt.blockNumber ?? STUB_BATCH_RECEIPT_BLOCK;
  return {
    status: receipt.status === "success" ? "0x1" : "0x0",
    transactionHash: receipt.transactionHash ?? stubBatchReceiptHash(id, index),
    blockHash: receipt.blockHash ?? keccak256(toHex(`gopepe-stub-batch-block-${blockNumber}`)),
    blockNumber: numberToHex(blockNumber),
    gasUsed: numberToHex(receipt.gasUsed ?? STUB_BATCH_RECEIPT_GAS),
    logs: [],
  };
}

export type WalletCallsControl = {
  capabilities: WalletCapabilitiesControl;
  sendCalls: WalletSendCallsControl;
  callsStatus: WalletCallsStatusControl;
};

// 스텁 지갑의 `wallet_getCapabilities`·`wallet_sendCalls`·`wallet_getCallsStatus`를 기록하고 응답 방식에 따라 응답한다.
// 다른 메서드(`eth_sendTransaction` 등)의 동작은 바꾸지 않는다.
export function installWalletCalls(stub: StubEip1193): WalletCallsControl {
  // wallet_getCapabilities
  const capabilityRequests: CapabilitiesRequestRecord[] = [];
  let capabilityMode: WalletCapabilitiesResponder = {
    type: "error",
    code: UNSUPPORTED_METHOD_CODE,
    message: "Unsupported method: wallet_getCapabilities",
  };
  let capabilityGate: WalletGate | null = null;

  stub.setHandler("wallet_getCapabilities", async (params) => {
    const [account, chainIds] = (params ?? []) as [Address | undefined, Hex[] | undefined];
    const record: CapabilitiesRequestRecord = {
      requestIndex: stub.requests.length - 1,
      at: Date.now(),
      account,
      chainIds: (chainIds ?? []).map((chainId) => Number(chainId)),
      status: "pending",
      errorCode: null,
    };
    capabilityRequests.push(record);
    await waitWalletGate(capabilityGate);
    const reply = typeof capabilityMode === "function" ? capabilityMode(record) : capabilityMode;
    if (reply.type === "error") {
      record.status = "error";
      record.errorCode = reply.code;
      throw walletCallsError(reply, `stub: wallet_getCapabilities failed (${reply.code})`);
    }
    record.status = "ok";
    return toCapabilitiesResponse(reply.chains);
  });

  // wallet_sendCalls
  const sent: SentCalls[] = [];
  let sendMode: WalletSendCallsReply = { type: "id" };
  let sendGate: WalletGate | null = null;
  let batchCounter = 0;
  // 배치 id → 그 배치를 보낸 요청의 체인(10진)
  const batchChainIds = new Map<string, number>();

  stub.setHandler("wallet_sendCalls", async (params) => {
    const [request] = (params ?? [{}]) as SendCallsParams;
    const record: SentCalls = {
      requestIndex: stub.requests.length - 1,
      walletChainId: stub.chainId,
      at: Date.now(),
      params: { ...request },
      from: request?.from,
      chainId: request?.chainId !== undefined ? Number(request.chainId) : undefined,
      atomicRequired: request?.atomicRequired,
      version: request?.version,
      capabilities: request?.capabilities,
      calls: (request?.calls ?? []).map((call) => ({
        to: call.to,
        data: call.data,
        value: call.value,
      })),
      id: null,
      errorCode: null,
    };
    sent.push(record);
    await waitWalletGate(sendGate);
    const reply = sendMode;
    if (reply.type === "error") {
      record.errorCode = reply.code;
      throw walletCallsError(reply, `stub: wallet_sendCalls failed (${reply.code})`);
    }
    batchCounter += 1;
    const id = reply.id ?? stubBatchId(batchCounter);
    record.id = id;
    batchChainIds.set(id, record.chainId ?? record.walletChainId);
    return { id };
  });

  // wallet_getCallsStatus
  const statusRequests: CallsStatusRequestRecord[] = [];
  let statusSequence: readonly WalletCallsStatusReply[] = [
    callsStatus(200, [{ status: "success" }]),
  ];
  let statusCursor = 0;
  let statusGate: WalletGate | null = null;

  stub.setHandler("wallet_getCallsStatus", async (params) => {
    const [id] = (params ?? []) as [string | undefined];
    const record: CallsStatusRequestRecord = {
      requestIndex: stub.requests.length - 1,
      at: Date.now(),
      id,
      reply: null,
      status: "pending",
    };
    statusRequests.push(record);
    await waitWalletGate(statusGate);
    const index = Math.min(statusCursor, statusSequence.length - 1);
    statusCursor += 1;
    const reply = statusSequence[index]!;
    record.reply = reply;
    if (reply.type === "error") {
      record.status = "error";
      throw walletCallsError(reply, `stub: wallet_getCallsStatus failed (${reply.code})`);
    }
    record.status = "ok";
    const batchId = id ?? "";
    const chainId = reply.chainId ?? batchChainIds.get(batchId) ?? stub.chainId;
    const response: Record<string, unknown> = {
      version: "2.0.0",
      id: batchId,
      chainId: numberToHex(chainId),
      atomic: reply.atomic ?? true,
      status: reply.statusCode,
    };
    if (reply.receipts !== null) {
      response.receipts = (reply.receipts ?? []).map((receipt, receiptIndex) =>
        toRpcCallsReceipt(batchId, receiptIndex, receipt),
      );
    }
    return response;
  });

  return {
    capabilities: {
      requests: capabilityRequests,
      reply(next) {
        capabilityMode = next;
      },
      hold() {
        const next = createWalletGate();
        capabilityGate = next;
        return toHoldGate(next, () => {
          if (capabilityGate === next) capabilityGate = null;
        });
      },
      requestsFor(account, chainId) {
        return capabilityRequests.filter(
          (record) =>
            record.account?.toLowerCase() === account.toLowerCase() &&
            record.chainIds.includes(chainId),
        );
      },
    },
    sendCalls: {
      sent,
      reply(next) {
        sendMode = next;
      },
      hold() {
        const next = createWalletGate();
        sendGate = next;
        return toHoldGate(next, () => {
          if (sendGate === next) sendGate = null;
        });
      },
      ids() {
        return sent.flatMap((record) => (record.id ? [record.id] : []));
      },
    },
    callsStatus: {
      requests: statusRequests,
      reply(next) {
        statusSequence = Array.isArray(next)
          ? (next as readonly WalletCallsStatusReply[])
          : [next as WalletCallsStatusReply];
        if (statusSequence.length === 0) {
          throw new Error("wallet_getCallsStatus 응답 순서열이 비어 있다");
        }
        statusCursor = 0;
      },
      hold() {
        const next = createWalletGate();
        statusGate = next;
        return toHoldGate(next, () => {
          if (statusGate === next) statusGate = null;
        });
      },
    },
  };
}
