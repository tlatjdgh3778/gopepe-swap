import {
  type Address,
  type Hash,
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  numberToHex,
  parseAbi,
  zeroAddress,
} from "viem";
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

// Ethereum QuoterV2 주소(리터럴). 기대값 읽기는 제품 config를 거치지 않는다.
// 출처: Uniswap v3 Ethereum 배포 문서.
export const QUOTER_V2_ADDRESS: Address = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

// 스펙 DoD-1의 네 수수료 티어. 낮은 수수료 순.
export const DIRECT_QUOTE_FEE_TIERS = [100, 500, 3000, 10000] as const;
export type DirectQuoteFeeTier = (typeof DIRECT_QUOTE_FEE_TIERS)[number];

export type DirectTierQuote =
  | { status: "revert" }
  | { status: "ok"; amountOut: bigint; sqrtPriceX96After: bigint };

export type DirectTierQuotes = Record<DirectQuoteFeeTier, DirectTierQuote>;

// 출처: Uniswap v3-periphery `IQuoterV2.quoteExactInputSingle`.
const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

// cold 포크의 첫 견적은 업체 RPC에서 풀 상태를 가져와 6~7초가 걸려 프록시 상류 제한(5초)을 넘는다(T-1).
// 예열 hook의 시간 제한만 이만큼 늘린다.
export const QUOTE_WARM_UP_TIMEOUT_MS = 120_000;

const anvilQuoteWarmUpClient = createPublicClient({
  chain: mainnet,
  transport: http(ANVIL_URL, { timeout: QUOTE_WARM_UP_TIMEOUT_MS - 20_000, retryCount: 0 }),
});

function isRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError || cause instanceof ExecutionRevertedError,
    ) !== null
  );
}

async function quoteEachTierWith(
  client: typeof anvilClient,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<DirectTierQuotes> {
  const entries = await Promise.all(
    DIRECT_QUOTE_FEE_TIERS.map(async (fee): Promise<[DirectQuoteFeeTier, DirectTierQuote]> => {
      try {
        const { result } = await client.simulateContract({
          address: QUOTER_V2_ADDRESS,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        const [amountOut, sqrtPriceX96After] = result;
        return [fee, { status: "ok", amountOut, sqrtPriceX96After }];
      } catch (error) {
        if (isRevert(error)) return [fee, { status: "revert" }];
        throw error;
      }
    }),
  );
  return Object.fromEntries(entries) as DirectTierQuotes;
}

// 러너가 anvil의 QuoterV2를 수수료 티어마다 따로 직접 호출한다(앱 요청과 분리, 판정의 기대값용).
// revert는 그 티어의 결과로 남기고, 그 밖의 실패(연결·시간 초과)는 그대로 던진다.
export async function quoteEachTierDirectly(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<DirectTierQuotes> {
  return quoteEachTierWith(anvilClient, tokenIn, tokenOut, amountIn);
}

// 앱의 견적 aggregate3가 프록시 상류 시간 제한 안에 끝나도록, 같은 입력의 티어별 견적을 미리 불러
// 포크에 풀 상태(slot0·tick·유동성)를 올린다. 판정에는 쓰지 않는다.
export async function warmUpSwapQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<void> {
  await quoteEachTierWith(anvilQuoteWarmUpClient, tokenIn, tokenOut, amountIn);
}

// 계정이 spender에게 준 ERC-20 allowance 정수를 anvil에서 직접 읽는다.
export async function readErc20Allowance(
  owner: Address,
  token: Address,
  spender: Address,
): Promise<bigint> {
  return anvilClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}

// 쓰기 테스트의 anvil 상태 격리. 테스트마다 `takeAnvilSnapshot`으로 새로 잡고 끝에 `revertAnvilSnapshot`으로 되돌린다.
// revert한 id는 다시 쓰지 않는다.
export async function takeAnvilSnapshot(): Promise<string> {
  const id = await anvilRpc("evm_snapshot", []);
  if (typeof id !== "string") throw new Error("[e2e] anvil evm_snapshot 응답이 id 문자열이 아니다");
  return id;
}

// anvil은 없는 id로 revert해도 오류 없이 `false`를 돌려준다(T-1). 결과를 그대로 돌려 호출자가 `true`를 단정한다.
export async function revertAnvilSnapshot(id: string): Promise<boolean> {
  return (await anvilRpc("evm_revert", [id])) === true;
}

// 계정의 nonce(`latest` 블록 기준 트랜잭션 수)를 anvil에서 직접 읽는다.
// `--block-time 1`에서 전송 전에는 latest와 pending이 같고, mock 커넥터 전송에는 nonce 필드가 없어
// 클릭 전에 읽은 값이 그 클릭으로 체결되는 트랜잭션의 nonce다(tx-status T-1). snapshot 뒤, 앞선 tx 채굴 뒤에 읽는다.
export async function readAccountNonce(account: Address): Promise<number> {
  return anvilClient.getTransactionCount({ address: account, blockTag: "latest" });
}

// 보낸 계정·nonce로 anvil에서 트랜잭션 해시를 직접 찾는다(앱 프록시를 거치지 않는다, 판정의 기대값용).
// anvil `eth_getTransactionBySenderAndNonce`는 pending·채굴 뒤 모두 응답한다(tx-status T-1).
// 해당 트랜잭션이 없으면 던진다.
export async function readTransactionHashBySenderAndNonce(
  sender: Address,
  nonce: number,
): Promise<Hash> {
  const transaction = await anvilRpc("eth_getTransactionBySenderAndNonce", [
    sender,
    numberToHex(nonce),
  ]);
  const hash =
    typeof transaction === "object" && transaction !== null && "hash" in transaction
      ? transaction.hash
      : undefined;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`[e2e] anvil에서 (${sender}, nonce ${nonce}) 트랜잭션을 찾지 못했다`);
  }
  return hash as Hash;
}

// 계정 코드를 anvil에서 직접 읽는다. 코드가 없으면 `undefined`다(viem `getCode`).
// mock 계정(anvil 0번)은 포크 블록에서 EIP-7702 위임 표식(`0xef0100` + 위임 대상 주소)을 가진다(native-eth T-1).
export async function readAccountCode(account: Address): Promise<Hex | undefined> {
  return anvilClient.getCode({ address: account });
}

// 계정 코드를 `anvil_setCode`로 지운다(빈 코드 `0x`). snapshot을 잡은 뒤 준비 단계에서만 쓰고, revert로 되돌린다.
export async function clearAccountCode(account: Address): Promise<void> {
  await anvilRpc("anvil_setCode", [account, "0x"]);
}

// Ethereum Uniswap V3 Factory 주소(리터럴). 풀 주소는 제품 config·함수를 거치지 않고 Factory `getPool`로 anvil에서 직접 찾는다.
// 출처: Uniswap v3 Ethereum 배포 문서, v3-core `IUniswapV3Factory.getPool`.
export const UNISWAP_V3_FACTORY_ADDRESS: Address = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

const uniswapV3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

// 출처: Uniswap v3-core `IUniswapV3PoolState.slot0`.
const uniswapV3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

export type DirectTierSlot0 =
  | { status: "no-pool" }
  | { status: "ok"; pool: Address; sqrtPriceX96: bigint };

export type DirectTierSlot0s = Record<DirectQuoteFeeTier, DirectTierSlot0>;

async function readEachTierSlot0With(
  client: typeof anvilClient,
  tokenA: Address,
  tokenB: Address,
): Promise<DirectTierSlot0s> {
  const entries = await Promise.all(
    DIRECT_QUOTE_FEE_TIERS.map(async (fee): Promise<[DirectQuoteFeeTier, DirectTierSlot0]> => {
      const pool = await client.readContract({
        address: UNISWAP_V3_FACTORY_ADDRESS,
        abi: uniswapV3FactoryAbi,
        functionName: "getPool",
        args: [tokenA, tokenB, fee],
      });
      if (pool === zeroAddress) return [fee, { status: "no-pool" }];
      const [sqrtPriceX96] = await client.readContract({
        address: pool,
        abi: uniswapV3PoolAbi,
        functionName: "slot0",
      });
      return [fee, { status: "ok", pool, sqrtPriceX96 }];
    }),
  );
  return Object.fromEntries(entries) as DirectTierSlot0s;
}

// 러너가 두 토큰의 수수료 티어별 풀을 Factory에서 찾고 그 풀의 `slot0`를 anvil에서 직접 읽는다(앱 요청과 분리, 판정의 기대값용).
// 풀이 없는 티어는 `no-pool`이고, 그 밖의 실패(연결·시간 초과·revert)는 그대로 던진다.
export async function readEachTierPoolSlot0Directly(
  tokenA: Address,
  tokenB: Address,
): Promise<DirectTierSlot0s> {
  return readEachTierSlot0With(anvilClient, tokenA, tokenB);
}

// 앱의 단가 aggregate3(토큰 1개 기준 티어별 견적 + 티어별 풀 `slot0`)가 프록시 상류 시간 제한(5초) 안에 끝나도록,
// 같은 쌍의 티어별 견적과 풀 `slot0`를 미리 읽어 포크에 풀 상태를 올린다(F9 T-1 (9): cold ETH 단가 7.1초). 판정에는 쓰지 않는다.
export async function warmUpUsdPricePath(
  token: Address,
  quoteToken: Address,
  oneTokenRaw: bigint,
): Promise<void> {
  await Promise.all([
    quoteEachTierWith(anvilQuoteWarmUpClient, token, quoteToken, oneTokenRaw),
    readEachTierSlot0With(anvilQuoteWarmUpClient, token, quoteToken),
  ]);
}

// ─── 네트워크 수수료 추정 경로 예열 (F10 T-14) ─────────────────────

// 출처: Uniswap swap-router-contracts `IV3SwapRouter.exactInputSingle`(SwapRouter02, deadline 없음), WETH9 `deposit`.
const swapRouter02ExactInputSingleAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const weth9DepositAbi = parseAbi(["function deposit() payable"]);

export type EstimateWarmUpRequest = { to: Address; data: Hex; value?: bigint };

// 앱의 `eth_estimateGas`가 프록시 상류 시간 제한(5초) 안에 끝나도록, 러너가 같은 계약을 거치는 추정을 anvil에 미리 보내
// 포크에 계약 코드·저장소 슬롯을 올린다(F10 T-1 (6): cold 첫 추정 최대 약 2.9초, CI는 캐시 없음). 판정에는 쓰지 않는다.
// revert(예: allowance가 없는 스왑의 `STF`)도 그 지점까지의 상태를 올리므로 무시하고, 그 밖의 실패(연결·시간 초과)는 던진다.
export async function warmUpEstimateGas(
  account: Address,
  request: EstimateWarmUpRequest,
): Promise<void> {
  try {
    await anvilQuoteWarmUpClient.estimateGas({
      account,
      to: request.to,
      data: request.data,
      value: request.value,
    });
  } catch (error) {
    if (isRevert(error)) return;
    throw error;
  }
}

// ERC-20 `approve(spender, amount)` 추정 예열 요청.
export function approveWarmUpRequest(
  token: Address,
  spender: Address,
  amount: bigint,
): EstimateWarmUpRequest {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  };
}

// SwapRouter02 `exactInputSingle` 추정 예열 요청. ETH 입력이면 `tokenIn`을 WETH로 두고 `value`에 금액을 넣는다.
// 최소 수령량은 0이다(예열은 같은 풀·라우터 상태를 올리는 것만 목적이다).
export function exactInputSingleWarmUpRequest(params: {
  router: Address;
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  value?: bigint;
}): EstimateWarmUpRequest {
  return {
    to: params.router,
    data: encodeFunctionData({
      abi: swapRouter02ExactInputSingleAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.fee,
          recipient: params.recipient,
          amountIn: params.amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
    value: params.value,
  };
}

// WETH9 `deposit` + `value` 추정 예열 요청.
export function wrapWarmUpRequest(weth: Address, amount: bigint): EstimateWarmUpRequest {
  return {
    to: weth,
    data: encodeFunctionData({ abi: weth9DepositAbi, functionName: "deposit" }),
    value: amount,
  };
}
