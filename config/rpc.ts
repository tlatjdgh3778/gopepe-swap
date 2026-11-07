import { CHAINS_BY_ID, type SupportedChainId } from "./chains";
import { E2E_ANVIL_PORT } from "./e2e";

// 프록시가 업체 RPC로 전달하는 읽기 메서드. 트랜잭션 전송은 사용자 지갑이 처리하므로 없다.
export const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
]);

// 요청 본문 상한(바이트). 이 값을 넘으면 413이다.
export const RPC_MAX_BODY_BYTES = 1_048_576;

// 배치 요청 항목 상한. 이 값을 넘으면 400이다.
export const RPC_MAX_BATCH_SIZE = 50;

// 업체 RPC와 공개 RPC 각각의 시간 제한(응답 본문 수신까지 포함).
export const RPC_TIMEOUT_MS = 5_000;

// 서버 전용 업체 RPC 환경 변수를 요청 시점에 읽는다. 없거나 빈 값이면 undefined다.
// 정적 접근으로 읽어 번들러가 이름을 추적할 수 있게 둔다.
export function getProviderRpcUrl(chainId: SupportedChainId): string | undefined {
  let value: string | undefined;
  switch (chainId) {
    case 1:
      value = process.env.ETH_MAINNET_RPC_URL;
      break;
    case 8453:
      value = process.env.BASE_MAINNET_RPC_URL;
      break;
    case 42161:
      value = process.env.ARB_MAINNET_RPC_URL;
      break;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// 공개 RPC는 체인별 viem 기본 RPC 1개다.
// E2E 빌드에서는 Ethereum 공개 RPC도 업체 대상과 같은 anvil로 맞춰 실제 메인넷으로 나가지 않게 한다.
// `NEXT_PUBLIC_E2E_MOCK`은 빌드 시점에 치환되므로 플래그 없는 빌드에서는 이 분기가 제거된다.
export function getPublicRpcUrl(chainId: SupportedChainId): string {
  if (process.env.NEXT_PUBLIC_E2E_MOCK === "1" && chainId === 1) {
    return `http://127.0.0.1:${E2E_ANVIL_PORT}`;
  }
  return CHAINS_BY_ID[chainId].rpcUrls.default.http[0];
}
