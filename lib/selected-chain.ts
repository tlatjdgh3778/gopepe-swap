import { DEFAULT_CHAIN_ID, SUPPORTED_CHAIN_IDS, type SupportedChainId } from "@/config/chains";

export const SELECTED_CHAIN_COOKIE = "gopepe-chain";

// 스펙에 만료 기간이 없어 1년으로 둔다.
export const SELECTED_CHAIN_COOKIE_MAX_AGE_SECONDS = 31_536_000;

// 서버(쿠키 헤더)와 클라이언트가 함께 쓰는 파서다.
// 지원 chainId의 10진 문자열과 정확히 같을 때만 인정하고, 그 외에는 Ethereum으로 처리한다.
export function parseSelectedChainId(value: string | null | undefined): SupportedChainId {
  if (typeof value !== "string") return DEFAULT_CHAIN_ID;
  const matched = SUPPORTED_CHAIN_IDS.find((chainId) => String(chainId) === value);
  return matched ?? DEFAULT_CHAIN_ID;
}

export function serializeSelectedChainCookie(chainId: SupportedChainId): string {
  return `${SELECTED_CHAIN_COOKIE}=${chainId}; path=/; max-age=${SELECTED_CHAIN_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
