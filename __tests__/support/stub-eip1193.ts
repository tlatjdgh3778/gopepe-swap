import { type Address, numberToHex } from "viem";

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
