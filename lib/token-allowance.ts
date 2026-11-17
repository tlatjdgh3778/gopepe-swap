import { type Address, erc20Abi } from "viem";
import { readContract } from "viem/actions";

import { type TokenBalanceClient, withoutMulticallBatching } from "@/lib/token-balances";

export type ReadTokenAllowanceParams = {
  // 토큰 소유자(연결 계정).
  owner: Address;
  // 승인 대상(선택 체인의 SwapRouter02).
  spender: Address;
  // ERC-20 토큰 주소. ETH 주소는 넘기지 않는다.
  token: Address;
};

/**
 * ERC-20 `allowance(owner, spender)`를 읽는다. 토큰 주소로 보내는 `eth_call` 1회다.
 * 클라이언트의 multicall 묶음 설정은 끈 사본을 쓴다(aggregate3로 묶지 않는다).
 */
export async function readTokenAllowance(
  client: TokenBalanceClient,
  { owner, spender, token }: ReadTokenAllowanceParams,
): Promise<bigint> {
  return await readContract(withoutMulticallBatching(client), {
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}
