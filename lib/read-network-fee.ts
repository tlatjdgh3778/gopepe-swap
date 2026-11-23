import type { Address } from "viem";

import { estimateGas, getGasPrice } from "viem/actions";
import { estimateL1Fee } from "viem/op-stack";

import type { SupportedChainId } from "@/config/chains";
import type { NetworkFeeTxRequest } from "@/lib/network-fee";
import type { TokenBalanceClient } from "@/lib/token-balances";

import { HAS_L1_DATA_FEE_BY_CHAIN } from "@/config/network-fee";
import { withoutRetry } from "@/lib/read-token-usd-price";

// 수수료 읽기는 요청 1회가 HTTP 요청 1건이다. 재시도(retryCount 0)와 multicall 묶음을 끈 사본으로 보낸다(F10 EC-5).
// 묶음이 켜져 있으면 `getL1Fee` `eth_call`이 Multicall3 aggregate3로 바뀐다.
// 추정 요청에는 fee·gas·nonce 필드를 싣지 않는다. 계정은 주소 문자열이라 viem이 서명 준비 요청을 더 보내지 않는다.

export type EstimateNetworkFeeParams = {
  // 선택 체인. `client`는 이 체인의 클라이언트(`config.getClient({ chainId })`)다.
  chainId: SupportedChainId;
  // 연결 계정(`from`).
  account: Address;
  // `buildNetworkFeeTxRequest` 결과. 추정과 L1 수수료에 같은 객체를 쓴다.
  request: NetworkFeeTxRequest;
};

export type NetworkFeeEstimate = {
  // `eth_estimateGas` 결과.
  gas: bigint;
  // GasPriceOracle `getL1Fee` 결과(wei). L1 데이터 수수료가 없는 체인은 `null`이다.
  l1Fee: bigint | null;
};

/**
 * 트랜잭션 하나의 가스와 L1 데이터 수수료를 읽는다.
 * `eth_estimateGas` 1회(params `{ from, to, data, value? }`) 뒤, 체인 설정 `HAS_L1_DATA_FEE_BY_CHAIN`이 참일 때만
 * 같은 요청으로 GasPriceOracle `getL1Fee` `eth_call` 1회를 순서대로 보낸다(F10 DoD-5·6·7·46).
 * 추정이 실패하면 L1 요청을 보내지 않고, 둘 중 하나라도 실패하면 throw한다(F10 EC-1, EC-3).
 */
export async function estimateNetworkFee(
  client: TokenBalanceClient,
  { chainId, account, request }: EstimateNetworkFeeParams,
): Promise<NetworkFeeEstimate> {
  const feeClient = withoutRetry(client);
  const { to, data, value } = request;

  const gas = await estimateGas(feeClient, { account, to, data, value });
  if (!HAS_L1_DATA_FEE_BY_CHAIN[chainId]) return { gas, l1Fee: null };

  const l1Fee = await estimateL1Fee(feeClient, { account, to, data, value });
  return { gas, l1Fee };
}

/**
 * 선택 체인의 가스 가격을 `eth_gasPrice` 1회로 읽는다(F10 DoD-5·6). 실패하면 다시 보내지 않고 throw한다(F10 EC-5).
 */
export async function readGasPrice(client: TokenBalanceClient): Promise<bigint> {
  return await getGasPrice(withoutRetry(client));
}
