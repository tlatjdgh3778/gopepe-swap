import { arbitrum, base, mainnet } from "viem/chains";

export const SUPPORTED_CHAINS = [mainnet, base, arbitrum] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];
export type SupportedChainId = SupportedChain["id"];

export const SUPPORTED_CHAIN_IDS = [mainnet.id, base.id, arbitrum.id] as const;

export const DEFAULT_CHAIN = mainnet;
export const DEFAULT_CHAIN_ID = mainnet.id;

export const CHAINS_BY_ID = {
  [mainnet.id]: mainnet,
  [base.id]: base,
  [arbitrum.id]: arbitrum,
} as const satisfies Record<SupportedChainId, SupportedChain>;

export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return SUPPORTED_CHAIN_IDS.some((supportedChainId) => supportedChainId === chainId);
}
