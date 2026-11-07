import { arbitrum, base, mainnet } from "viem/chains";
import {
  type CreateConnectorFn,
  type State,
  type Storage,
  cookieStorage,
  cookieToInitialState,
  createConfig,
  createStorage,
  http,
} from "wagmi";

import { SUPPORTED_CHAINS, type SupportedChainId } from "./chains";

type E2EMockModule = typeof import("./e2e-mock");

// `NEXT_PUBLIC_E2E_MOCK`은 빌드 시점에 문자열로 치환된다.
// 플래그 없는 빌드에서는 조건이 상수 false가 되어 분기와 require가 제거되고, e2e-mock 모듈이 번들에 들어가지 않는다.
function loadE2EMock(): E2EMockModule | undefined {
  if (process.env.NEXT_PUBLIC_E2E_MOCK === "1") {
    return require("./e2e-mock") as E2EMockModule;
  }
  return undefined;
}

// 브라우저의 RPC 읽기는 같은 출처의 프록시로만 보낸다.
export function rpcProxyPath(chainId: SupportedChainId): string {
  return `/api/rpc/${chainId}`;
}

export type CreateWagmiConfigOptions = {
  // 테스트가 mock 커넥터나 스텁 provider 커넥터를 주입할 때 쓴다. 생략하면 앱 기본 커넥터를 쓴다.
  connectors?: readonly CreateConnectorFn[];
  // 테스트가 저장소를 바꿀 때 쓴다. 생략하면 cookieStorage를 쓴다.
  // `ssr: true`에서 wagmi가 마운트 시 persist rehydrate를 호출하므로 null(저장소 없음)은 받지 않는다.
  storage?: Storage;
  // EIP-6963 브라우저 지갑 감지. 기본값 true.
  multiInjectedProviderDiscovery?: boolean;
};

// 요청 간 상태가 섞이지 않도록 호출마다 새 config를 만든다.
export function createWagmiConfig(options: CreateWagmiConfigOptions = {}) {
  const e2eMock = loadE2EMock();
  // 운영에서는 viem 기본 `chain.rpcUrls`를 유지한다(체인 추가 요청이 이 값을 지갑에 넘긴다).
  const chains = e2eMock ? e2eMock.withE2EChains(SUPPORTED_CHAINS) : SUPPORTED_CHAINS;
  const connectors = options.connectors ?? (e2eMock ? [e2eMock.createE2EMockConnector()] : []);

  return createConfig({
    chains,
    connectors,
    multiInjectedProviderDiscovery: options.multiInjectedProviderDiscovery ?? true,
    ssr: true,
    storage: options.storage ?? createStorage({ storage: cookieStorage }),
    transports: {
      [mainnet.id]: http(rpcProxyPath(mainnet.id)),
      [base.id]: http(rpcProxyPath(base.id)),
      [arbitrum.id]: http(rpcProxyPath(arbitrum.id)),
    },
  });
}

export type WagmiConfig = ReturnType<typeof createWagmiConfig>;

// 서버에서 요청의 Cookie 헤더로 wagmi 초기 상태를 만든다. `AppProviders`의 `initialState`에 넘긴다.
export function getWagmiInitialState(cookieHeader: string | null | undefined): State | undefined {
  return cookieToInitialState(createWagmiConfig(), cookieHeader);
}

// E2E 빌드에서만 테스트 제어값을 붙인다(정의는 e2e-mock 모듈). 그 외에는 아무것도 하지 않는다.
export function attachE2EControl(config: WagmiConfig): (() => void) | undefined {
  return loadE2EMock()?.installE2EControl(config);
}

declare module "wagmi" {
  interface Register {
    config: WagmiConfig;
  }
}
