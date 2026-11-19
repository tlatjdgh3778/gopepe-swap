import type { Hash } from "viem";

import { CHAINS_BY_ID, type SupportedChainId } from "@/config/chains";

/**
 * 트랜잭션을 보낸 체인의 블록 탐색기 tx URL(스펙 §4.2, DoD-6).
 * 새 config 없이 `CHAINS_BY_ID[chainId].blockExplorers.default.url`에 `/tx/{hash}`를 붙인다.
 */
export function getTxExplorerUrl(chainId: SupportedChainId, hash: Hash): string {
  return `${CHAINS_BY_ID[chainId].blockExplorers.default.url}/tx/${hash}`;
}
