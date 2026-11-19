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
