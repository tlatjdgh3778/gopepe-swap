import { arbitrum, base, mainnet } from "viem/chains";

import type { SupportedChainId } from "./chains";

// 헤더 체인 드롭다운에 표시하는 체인 아이콘.
export const CHAIN_ICON_URLS: Record<SupportedChainId, string> = {
  [mainnet.id]: "https://icons.llamao.fi/icons/chains/rsz_ethereum.jpg",
  [base.id]:
    "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/base/info/logo.png",
  [arbitrum.id]: "https://icons.llamao.fi/icons/chains/rsz_arbitrum.jpg",
};
