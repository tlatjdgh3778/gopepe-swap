import {
  type Address,
  type Chain,
  type Client,
  ContractFunctionExecutionError,
  type Transport,
  erc20Abi,
} from "viem";
import { getBalance, multicall, readContract } from "viem/actions";

import type { Token } from "@/config/tokens";
import { isNativeToken } from "@/lib/token-amount";

// 모달 잔액 일괄 읽기의 multicall 묶음 크기(호출 데이터 바이트 합). `balanceOf` 1건은 36바이트다.
// Ethereum 스냅샷 484개는 aggregate3 2회, Base·Arbitrum은 1회가 된다(T-1 확인: 요청 본문·가스 한도 안).
export const TOKEN_LIST_MULTICALL_BATCH_SIZE = 10_000;

export type TokenBalanceClient = Client<Transport, Chain>;

// 클라이언트의 multicall 묶음 설정(wagmi 기본값 `batch.multicall: true`)을 끈 사본.
// 묶음이 켜져 있으면 viem이 `eth_getBalance`를 Multicall3 `getEthBalance`로, 개별 `eth_call`을 aggregate3로 바꾸고
// 타이머로 모아 보낸다. 잔액 읽기는 이 함수가 정한 요청(`eth_getBalance`, 토큰 `balanceOf`, 명시한 aggregate3)만 보낸다.
export function withoutMulticallBatching(client: TokenBalanceClient): TokenBalanceClient {
  if (!client.batch?.multicall) return client;
  return { ...client, batch: { ...client.batch, multicall: false } };
}

export type ReadTokenBalanceParams = {
  account: Address;
  token: Pick<Token, "address">;
};

/**
 * 카드 잔액 한 건을 읽는다. ETH는 `eth_getBalance` 1회, ERC-20은 토큰 주소로 보내는 `balanceOf` `eth_call` 1회다.
 */
export async function readTokenBalance(
  client: TokenBalanceClient,
  { account, token }: ReadTokenBalanceParams,
): Promise<bigint> {
  const unbatched = withoutMulticallBatching(client);
  if (isNativeToken(token)) {
    return await getBalance(unbatched, { address: account });
  }
  return await readContract(unbatched, {
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

export type ReadTokenListBalancesParams = {
  account: Address;
  tokens: readonly Token[];
};

// multicall 결과의 실패가 토큰 하나의 `balanceOf` 실패인지 구분한다.
// 요청 자체(aggregate3 `eth_call`)가 실패하면 viem은 그 묶음의 모든 결과에 aggregate3 호출 오류를 넣는다.
function isSingleTokenFailure(error: unknown): boolean {
  return error instanceof ContractFunctionExecutionError && error.functionName === "balanceOf";
}

/**
 * 모달 목록 전체의 잔액을 일괄로 읽는다.
 * 네이티브 ETH는 `eth_getBalance` 1회, ERC-20은 multicall(aggregate3, `allowFailure: true`)로 읽는다.
 * 결과는 토큰 목록의 `address`를 키로 하며, `balanceOf`가 실패한 토큰은 키가 없다.
 * 요청 자체가 실패하면(`eth_getBalance` 또는 aggregate3 요청) 전체가 실패한다. 계약별 개별 호출로 다시 읽지 않는다.
 */
export async function readTokenListBalances(
  client: TokenBalanceClient,
  { account, tokens }: ReadTokenListBalancesParams,
): Promise<Map<Address, bigint>> {
  const unbatched = withoutMulticallBatching(client);
  const nativeTokens = tokens.filter((token) => isNativeToken(token));
  const erc20Tokens = tokens.filter((token) => !isNativeToken(token));

  const [nativeBalance, erc20Results] = await Promise.all([
    nativeTokens.length > 0 ? getBalance(unbatched, { address: account }) : Promise.resolve(null),
    erc20Tokens.length > 0
      ? multicall(unbatched, {
          contracts: erc20Tokens.map((token) => ({
            address: token.address,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [account] as const,
          })),
          allowFailure: true,
          batchSize: TOKEN_LIST_MULTICALL_BATCH_SIZE,
        })
      : Promise.resolve([]),
  ]);

  const balances = new Map<Address, bigint>();

  if (nativeBalance !== null) {
    for (const token of nativeTokens) balances.set(token.address, nativeBalance);
  }

  erc20Results.forEach((result, index) => {
    const token = erc20Tokens[index];
    if (result.status === "success") {
      balances.set(token.address, result.result);
      return;
    }
    if (!isSingleTokenFailure(result.error)) throw result.error;
  });

  return balances;
}
