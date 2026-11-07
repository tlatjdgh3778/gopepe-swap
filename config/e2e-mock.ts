// E2E 빌드(`NEXT_PUBLIC_E2E_MOCK=1`) 전용 모듈이다.
// `config/wagmi.ts`가 정적 플래그 분기 안에서만 가져오므로 플래그 없는 빌드에는 포함되지 않는다.
// 이 파일 밖에서 이 모듈을 정적으로 import하지 않는다.
import type { Address, Hex } from "viem";

import { mainnet } from "viem/chains";
import { type Config, type CreateConnectorFn, createConnector, mock } from "wagmi";

import type { SUPPORTED_CHAINS } from "./chains";

import { E2E_ANVIL_PORT } from "./e2e";

// anvil 기본 계정 0
export const E2E_MOCK_ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// 새로고침 후에도 mock의 연결 여부를 유지하는 키. 연결 시 기록하고 해제 시 지운다.
export const E2E_MOCK_CONNECTED_STORAGE_KEY = "gopepe-e2e-mock-connected";

export type GopepeE2EWalletRequest = {
  method: string;
  params?: unknown;
};

export type GopepeE2EControl = {
  // mock 커넥터 `connectError`. `true`는 연결 요청 거부(UserRejectedRequestError), Error는 그 오류로 실패한다.
  // 연결 시점마다 읽으므로 페이지 로드 전(addInitScript)이나 후에 바꿀 수 있다.
  connectError?: boolean | Error;
  // mock 커넥터가 지갑 provider로 받은 요청 기록(연결, 체인 전환 등).
  walletRequests: GopepeE2EWalletRequest[];
  // mock 커넥터의 계정 주소.
  mockAccount: Address;
  // 앱의 wagmi config가 RPC 읽기에 쓰는 것과 같은 클라이언트(transport)로 Ethereum `eth_blockNumber`를 보낸다.
  // 앱이 마운트된 뒤에 생긴다.
  requestBlockNumber?: () => Promise<Hex>;
};

declare global {
  interface Window {
    __GOPEPE_E2E__?: Partial<GopepeE2EControl>;
  }
}

function getControl(): GopepeE2EControl {
  const existing = window.__GOPEPE_E2E__ ?? {};
  existing.walletRequests ??= [];
  existing.mockAccount = E2E_MOCK_ACCOUNT;
  window.__GOPEPE_E2E__ = existing;
  return existing as GopepeE2EControl;
}

function readConnectedFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(E2E_MOCK_CONNECTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeConnectedFlag(connected: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (connected) window.sessionStorage.setItem(E2E_MOCK_CONNECTED_STORAGE_KEY, "1");
    else window.sessionStorage.removeItem(E2E_MOCK_CONNECTED_STORAGE_KEY);
  } catch {}
}

// mock 커넥터가 쓰는 Ethereum `chain.rpcUrls`를 anvil로 바꾼다. 다른 체인은 그대로 둔다.
export function withE2EChains(chains: typeof SUPPORTED_CHAINS): typeof SUPPORTED_CHAINS {
  const anvilUrl = `http://localhost:${E2E_ANVIL_PORT}`;
  return chains.map((chain) =>
    chain.id === mainnet.id
      ? { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [anvilUrl] } } }
      : chain,
  ) as unknown as typeof SUPPORTED_CHAINS;
}

export function createE2EMockConnector(): CreateConnectorFn {
  const features = {
    // 새로고침 전에 연결돼 있었으면 연결된 상태로 시작해 복원(reconnect)되게 한다.
    defaultConnected: readConnectedFlag(),
    reconnect: true,
    get connectError() {
      return typeof window === "undefined" ? undefined : window.__GOPEPE_E2E__?.connectError;
    },
  };
  const baseConnector = mock({ accounts: [E2E_MOCK_ACCOUNT], features });

  // mock 커넥터에 연결 여부 기록과 지갑 요청 기록을 덧붙인다. `this`는 wagmi가 만든 최종 커넥터 객체다.
  const wrappedConnector: typeof baseConnector = (config) => {
    const inner = baseConnector(config);
    return {
      ...inner,
      async connect(parameters) {
        const result = await inner.connect.call(this, parameters);
        writeConnectedFlag(true);
        return result as never;
      },
      async disconnect() {
        await inner.disconnect.call(this);
        writeConnectedFlag(false);
      },
      async getProvider(parameters) {
        const provider = await inner.getProvider.call(this, parameters);
        const request = (async (args: GopepeE2EWalletRequest, options?: unknown) => {
          if (typeof window !== "undefined") {
            getControl().walletRequests.push({ method: args.method, params: args.params });
          }
          return provider.request(args as never, options as never);
        }) as typeof provider.request;
        return { ...provider, request };
      },
    };
  };
  return createConnector(wrappedConnector);
}

// 테스트 호출 함수를 `window.__GOPEPE_E2E__`에 붙인다. 반환값은 정리 함수다.
export function installE2EControl(config: Config): () => void {
  const control = getControl();
  const requestBlockNumber = () =>
    config.getClient({ chainId: mainnet.id }).request({ method: "eth_blockNumber" });
  control.requestBlockNumber = requestBlockNumber;
  return () => {
    if (control.requestBlockNumber === requestBlockNumber) delete control.requestBlockNumber;
  };
}
