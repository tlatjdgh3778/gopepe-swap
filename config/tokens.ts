import type { Address } from "viem";

import { arbitrum, base, mainnet } from "viem/chains";

import type { SupportedChainId } from "./chains";

import { CONTRACTS_BY_CHAIN } from "./contracts";
import arbitrumSnapshot from "./tokens-42161.json";
import baseSnapshot from "./tokens-8453.json";
import mainnetSnapshot from "./tokens-1.json";

export type Token = {
  chainId: SupportedChainId;
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
};

export const NATIVE_ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// 리스트의 USDT0를 앱에서는 USDT로 표시한다. 스냅샷 JSON의 심볼은 원본 그대로 둔다.
const ARBITRUM_USDT_ADDRESS: Address = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";

const PINNED_STABLECOIN_ADDRESSES: Record<
  SupportedChainId,
  { usdc: Address; usdt: Address; dai: Address }
> = {
  [mainnet.id]: {
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  },
  [base.id]: {
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdt: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    dai: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  },
  [arbitrum.id]: {
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdt: ARBITRUM_USDT_ADDRESS,
    dai: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  },
};

function buildTokens(chainId: SupportedChainId, snapshot: readonly Token[]): readonly Token[] {
  const nativeEth: Token = {
    chainId,
    address: NATIVE_ETH_ADDRESS,
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
    logoURI: "https://assets.coingecko.com/coins/images/279/large/ethereum.png",
  };

  return [
    nativeEth,
    ...snapshot.map((token) =>
      token.chainId === arbitrum.id && token.address === ARBITRUM_USDT_ADDRESS
        ? { ...token, symbol: "USDT" }
        : token,
    ),
  ];
}

export const TOKENS_BY_CHAIN: Record<SupportedChainId, readonly Token[]> = {
  [mainnet.id]: buildTokens(mainnet.id, mainnetSnapshot as readonly Token[]),
  [base.id]: buildTokens(base.id, baseSnapshot as readonly Token[]),
  [arbitrum.id]: buildTokens(arbitrum.id, arbitrumSnapshot as readonly Token[]),
};

function buildPinnedTokens(chainId: SupportedChainId): readonly Token[] {
  const { usdc, usdt, dai } = PINNED_STABLECOIN_ADDRESSES[chainId];
  const addresses = [NATIVE_ETH_ADDRESS, CONTRACTS_BY_CHAIN[chainId].weth, usdc, usdt, dai];

  return addresses.map((address) => {
    const token = TOKENS_BY_CHAIN[chainId].find((candidate) => candidate.address === address);
    if (!token) {
      throw new Error(`체인 ${chainId}의 토큰 목록에 고정 토큰 ${address}가 없습니다.`);
    }
    return token;
  });
}

export const PINNED_TOKENS_BY_CHAIN: Record<SupportedChainId, readonly Token[]> = {
  [mainnet.id]: buildPinnedTokens(mainnet.id),
  [base.id]: buildPinnedTokens(base.id),
  [arbitrum.id]: buildPinnedTokens(arbitrum.id),
};
