import { type Address, createPublicClient, erc20Abi, http, numberToHex } from "viem";
import { mainnet } from "viem/chains";

import { E2E_ANVIL_PORT } from "../../config/e2e";

// 러너가 E2E용 Ethereum anvil 포크에 직접 보내는 상태 주입·조회 요청.
// 앱(브라우저)의 요청은 가로채지 않는다. 앱은 프록시(`/api/rpc/1`)를 거쳐 같은 anvil을 읽는다.
const ANVIL_URL = `http://127.0.0.1:${E2E_ANVIL_PORT}`;

// cold 포크의 스냅샷 토큰 일괄 읽기는 업체 RPC에서 상태를 가져와 수 분이 걸린다(T-1: 약 95~170초).
export const ANVIL_WARM_UP_TIMEOUT_MS = 300_000;

const anvilClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: 30_000, retryCount: 0 }),
});

const anvilWarmUpClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: ANVIL_WARM_UP_TIMEOUT_MS - 20_000, retryCount: 0 }),
});

type JsonRpcResponse = { result?: unknown; error?: { code: number; message: string } };

// viem 스키마에 없는 anvil 전용 메서드를 보낸다.
async function anvilRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`[e2e] anvil ${method} HTTP ${response.status}`);
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) throw new Error(`[e2e] anvil ${method} 실패: ${body.error.message}`);
  return body.result;
}

// 계정의 ERC-20 잔액을 절대값으로 바꾼다. 인자 순서는 (계정, 토큰, 양)이다(T-1 확인).
export async function setErc20Balance(
  account: Address,
  token: Address,
  amount: bigint,
): Promise<void> {
  await anvilRpc("anvil_dealERC20", [account, token, numberToHex(amount)]);
}

// 계정의 ERC-20 잔액 정수를 anvil에서 직접 읽는다.
export async function readErc20Balance(account: Address, token: Address): Promise<bigint> {
  return anvilClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

// 계정의 ETH 잔액 정수(wei)를 anvil에서 직접 읽는다.
export async function readEthBalance(account: Address): Promise<bigint> {
  return anvilClient.getBalance({ address: account });
}

// 앱의 모달 일괄 읽기가 프록시 상류 시간 제한 안에 끝나도록, 같은 계정의 토큰 잔액을 미리 읽어
// 포크 상태(토큰 코드·저장소 슬롯, Multicall3)를 데운다. 판정에는 쓰지 않는다.
export async function warmUpTokenBalances(
  account: Address,
  tokens: readonly Address[],
): Promise<void> {
  await Promise.all([
    anvilWarmUpClient.getBalance({ address: account }),
    anvilWarmUpClient.multicall({
      contracts: tokens.map((address) => ({
        address,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [account] as const,
      })),
      allowFailure: true,
      batchSize: 10_000,
    }),
  ]);
}
