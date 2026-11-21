// WETH 컨트랙트의 `deposit()`(ETH → WETH)과 `withdraw(uint256 wad)`(WETH → ETH).
// 대상 주소는 `CONTRACTS_BY_CHAIN[chainId].weth`다.
// 출처: WETH9 (Ethereum `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` 검증 소스)
// https://etherscan.io/address/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2#code
export const wethAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256", internalType: "uint256" }],
    outputs: [],
  },
] as const;
