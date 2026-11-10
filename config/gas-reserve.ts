import { arbitrum, base, mainnet } from "viem/chains";

import type { SupportedChainId } from "./chains";

// ETH `최대`가 잔액에서 빼 두는 체인별 가스 예약량(wei).
// Ethereum 0.005 ETH, Base 0.0005 ETH, Arbitrum 0.0005 ETH.
export const GAS_RESERVE_BY_CHAIN: Record<SupportedChainId, bigint> = {
  [mainnet.id]: 5_000_000_000_000_000n,
  [base.id]: 500_000_000_000_000n,
  [arbitrum.id]: 500_000_000_000_000n,
};
