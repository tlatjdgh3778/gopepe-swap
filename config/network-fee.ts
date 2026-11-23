import { arbitrum, base, mainnet } from "viem/chains";

import type { SupportedChainId } from "./chains";

// 수수료 ÷ 보내는 금액이 이 값(bps) 이상이면 수수료 경고다(F10 DoD-22). 500 bps = 5%.
export const NETWORK_FEE_WARNING_BPS = 500;

// `eth_gasPrice`를 다시 읽는 주기(밀리초, F10 DoD-37). F10이 읽는 ETH 잔액도 같은 주기다(F10 DoD-39).
export const GAS_PRICE_REFETCH_MS = 60_000;

// 체인별 L1 데이터 수수료(GasPriceOracle `getL1Fee`) 여부(F10 DoD-6·7·46).
// Base는 OP Stack이라 L1 데이터 수수료가 따로 붙고, Ethereum·Arbitrum은 없다.
export const HAS_L1_DATA_FEE_BY_CHAIN: Record<SupportedChainId, boolean> = {
  [mainnet.id]: false,
  [base.id]: true,
  [arbitrum.id]: false,
};
