import type { Address } from "viem";

import { arbitrum, base, mainnet } from "viem/chains";

import type { SupportedChainId } from "./chains";

export type ChainContracts = {
  chainId: SupportedChainId;
  quoterV2: Address;
  factory: Address;
  weth: Address;
};

// 출처: Uniswap 공식 배포 문서
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-base-deployments
// https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments
export const CONTRACTS_BY_CHAIN = {
  [mainnet.id]: {
    chainId: mainnet.id,
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
  [base.id]: {
    chainId: base.id,
    quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    weth: "0x4200000000000000000000000000000000000006",
  },
  [arbitrum.id]: {
    chainId: arbitrum.id,
    quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  },
} as const satisfies Record<SupportedChainId, ChainContracts>;
