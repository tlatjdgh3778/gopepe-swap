import { type Address, type Hex, encodeFunctionData, erc20Abi, maxUint256 } from "viem";

import type { SupportedChainId } from "@/config/chains";
import type { Token } from "@/config/tokens";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { ALLOWANCE_RESET_TOKEN_ADDRESSES_BY_CHAIN } from "@/config/tokens";
import { ADDRESS_THIS, type FeeTier, swapRouter02Abi } from "@/config/uniswap-v3";
import { wethAbi } from "@/config/weth";
import { resolveQuoteTokens } from "@/lib/swap-quote";
import { isNativeToken } from "@/lib/token-amount";

// ─── approve ───────────────────────────────────────────────────────

/**
 * 선택 체인에서 allowance를 0으로 초기화한 뒤에만 다시 승인할 수 있는 토큰이면 참이다(주소 대소문자 무관).
 */
export function requiresAllowanceReset(chainId: SupportedChainId, token: Address): boolean {
  const target = token.toLowerCase();
  return ALLOWANCE_RESET_TOKEN_ADDRESSES_BY_CHAIN[chainId].some(
    (address) => address.toLowerCase() === target,
  );
}

export type ApproveAmountParams = {
  chainId: SupportedChainId;
  // 보내는 토큰(ERC-20) 주소.
  token: Address;
  // 현재 SwapRouter02 allowance.
  allowance: bigint;
  amountInRaw: bigint;
};

/**
 * approve 금액. 초기화 대상 토큰에서 0 < allowance < `amountInRaw`이면 `0n`(EC-12),
 * 그 밖에는 `maxUint256`이다(DoD-13).
 */
export function getApproveAmount({
  chainId,
  token,
  allowance,
  amountInRaw,
}: ApproveAmountParams): bigint {
  if (requiresAllowanceReset(chainId, token) && allowance > 0n && allowance < amountInRaw) {
    return 0n;
  }
  return maxUint256;
}

export type ApproveRequest = {
  // approve를 보낼 보내는 토큰 컨트랙트.
  to: Address;
  // 선택 체인의 SwapRouter02.
  spender: Address;
  amount: bigint;
};

/**
 * 보내는 토큰 컨트랙트에 보낼 `approve(swapRouter02, amount)`의 대상·인자다. 금액은 `getApproveAmount`로 고른다.
 */
export function buildApproveRequest(params: ApproveAmountParams): ApproveRequest {
  return {
    to: params.token,
    spender: CONTRACTS_BY_CHAIN[params.chainId].swapRouter02,
    amount: getApproveAmount(params),
  };
}

/**
 * ERC-20 `approve(spender, amount)` calldata. ABI는 viem `erc20Abi`다.
 */
export function encodeApproveCalldata({
  spender,
  amount,
}: Pick<ApproveRequest, "spender" | "amount">): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}

// ─── swap ──────────────────────────────────────────────────────────

// `multicall` deadline의 여유 시간(초). deadline은 전송 직전 클라이언트 시각(초) + 이 값이다(DoD-17).
export const SWAP_DEADLINE_SECONDS = 1800n;

/**
 * `multicall` deadline(유닉스 초). `nowMs`(밀리초, `Date.now()` 값)를 1000으로 나눠 소수부를 버린 초에
 * `SWAP_DEADLINE_SECONDS`를 더한다.
 */
export function getSwapDeadline(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000)) + SWAP_DEADLINE_SECONDS;
}

// SwapRouter02 `IV3SwapRouter.ExactInputSingleParams`.
export type ExactInputSingleParams = {
  tokenIn: Address;
  tokenOut: Address;
  fee: FeeTier;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
};

export type BuildExactInputSingleParamsInput = {
  chainId: SupportedChainId;
  tokenIn: Pick<Token, "address">;
  tokenOut: Pick<Token, "address">;
  // `quote.fee`.
  fee: FeeTier;
  // 연결 계정.
  recipient: Address;
  amountInRaw: bigint;
  // `useAmountOutMinimum()`.
  amountOutMinimum: bigint;
};

/**
 * `exactInputSingle` 인자(DoD-16). 토큰 주소는 견적과 같이 ETH를 선택 체인의 WETH로 바꾸고,
 * `sqrtPriceLimitX96`는 0이다.
 */
export function buildExactInputSingleParams({
  chainId,
  tokenIn,
  tokenOut,
  fee,
  recipient,
  amountInRaw,
  amountOutMinimum,
}: BuildExactInputSingleParamsInput): ExactInputSingleParams {
  const tokens = resolveQuoteTokens({ chainId, tokenIn, tokenOut });
  return {
    tokenIn: tokens.tokenIn,
    tokenOut: tokens.tokenOut,
    fee,
    recipient,
    amountIn: amountInRaw,
    amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  };
}

/**
 * SwapRouter02 `exactInputSingle(params)` calldata.
 */
export function encodeExactInputSingleCalldata(params: ExactInputSingleParams): Hex {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [params],
  });
}

export type SwapMulticallParams = {
  deadline: bigint;
  params: ExactInputSingleParams;
};

/**
 * SwapRouter02 `multicall(uint256 deadline, bytes[] data)`의 인자 `[deadline, [exactInputSingle(params)]]`다(DoD-15).
 * `writeContract`에 `swapRouter02Abi`·`functionName: "multicall"`과 함께 넘긴다.
 */
export function buildSwapMulticallArgs({
  deadline,
  params,
}: SwapMulticallParams): readonly [bigint, readonly Hex[]] {
  return [deadline, [encodeExactInputSingleCalldata(params)]];
}

/**
 * SwapRouter02 `multicall(deadline, [exactInputSingle(params)])` calldata(DoD-15).
 */
export function encodeSwapMulticallCalldata(input: SwapMulticallParams): Hex {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "multicall",
    args: buildSwapMulticallArgs(input),
  });
}

// ─── ETH가 낀 swap (F7) ────────────────────────────────────────────

export type UnwrapWeth9Params = {
  // 라우터가 가진 WETH가 이보다 적으면 revert한다. 클릭 시점 `useAmountOutMinimum()`이다.
  amountMinimum: bigint;
  // ETH를 받을 연결 계정.
  recipient: Address;
};

/**
 * SwapRouter02 `unwrapWETH9(amountMinimum, recipient)` calldata(F7 DoD-9).
 */
export function encodeUnwrapWeth9Calldata({ amountMinimum, recipient }: UnwrapWeth9Params): Hex {
  return encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "unwrapWETH9",
    args: [amountMinimum, recipient],
  });
}

export type SwapTransactionParams = {
  chainId: SupportedChainId;
  tokenIn: Pick<Token, "address">;
  tokenOut: Pick<Token, "address">;
  // `quote.fee`.
  fee: FeeTier;
  // 연결 계정. 받는 토큰이 ETH이면 `unwrapWETH9`의 recipient, 아니면 `exactInputSingle`의 recipient다.
  account: Address;
  amountInRaw: bigint;
  // `useAmountOutMinimum()`.
  amountOutMinimum: bigint;
  // `getSwapDeadline`으로 전송 직전에 정한 값.
  deadline: bigint;
};

export type SwapTransactionRequest = {
  // 선택 체인의 SwapRouter02.
  to: Address;
  // `multicall(uint256 deadline, bytes[] data)`의 인자.
  args: readonly [bigint, readonly Hex[]];
  // 보내는 토큰이 ETH이면 `amountInRaw`, 아니면 `undefined`(지갑 요청에 `value`를 싣지 않는다).
  value: bigint | undefined;
};

/**
 * swap 트랜잭션 요청. 토큰 주소는 ETH를 선택 체인의 WETH로 바꾼다.
 * - 보내는 토큰이 ETH: `multicall(deadline, [exactInputSingle(params)])`, `value`는 `amountInRaw`(F7 DoD-7·8).
 * - 받는 토큰이 ETH: `params.recipient`를 `ADDRESS_THIS`로 두고
 *   `multicall(deadline, [exactInputSingle(params), unwrapWETH9(amountOutMinimum, account)])`, `value` 없음(F7 DoD-9·10).
 * - ERC-20 ↔ ERC-20: `buildSwapMulticallArgs`와 같은 인자, `value` 없음(F5 DoD-15~17, F7 DoD-10).
 * `refundETH`는 넣지 않는다(exactInput이라 보낸 ETH를 모두 쓴다).
 */
export function buildSwapTransactionRequest({
  chainId,
  tokenIn,
  tokenOut,
  fee,
  account,
  amountInRaw,
  amountOutMinimum,
  deadline,
}: SwapTransactionParams): SwapTransactionRequest {
  const ethIn = isNativeToken(tokenIn);
  const ethOut = isNativeToken(tokenOut);
  const params = buildExactInputSingleParams({
    chainId,
    tokenIn,
    tokenOut,
    fee,
    recipient: ethOut ? ADDRESS_THIS : account,
    amountInRaw,
    amountOutMinimum,
  });
  const calls: Hex[] = [encodeExactInputSingleCalldata(params)];
  if (ethOut) {
    calls.push(encodeUnwrapWeth9Calldata({ amountMinimum: amountOutMinimum, recipient: account }));
  }
  return {
    to: CONTRACTS_BY_CHAIN[chainId].swapRouter02,
    args: [deadline, calls],
    value: ethIn ? amountInRaw : undefined,
  };
}

/**
 * swap 트랜잭션 요청의 SwapRouter02 `multicall(deadline, data)` calldata.
 */
export function encodeSwapTransactionCalldata({ args }: Pick<SwapTransactionRequest, "args">): Hex {
  return encodeFunctionData({ abi: swapRouter02Abi, functionName: "multicall", args });
}

// ─── wrap·unwrap (F7) ──────────────────────────────────────────────

export type WethTransactionParams = {
  chainId: SupportedChainId;
  amountInRaw: bigint;
};

// 선택 체인 WETH 컨트랙트의 `deposit()`. deadline이 없다(F7 §4.1).
export type WrapRequest = {
  to: Address;
  functionName: "deposit";
  args: readonly [];
  value: bigint;
};

// 선택 체인 WETH 컨트랙트의 `withdraw(wad)`. deadline이 없고 `value`를 싣지 않는다(F7 §4.1, DoD-22).
export type UnwrapRequest = {
  to: Address;
  functionName: "withdraw";
  args: readonly [bigint];
  value: undefined;
};

/**
 * wrap 요청. 선택 체인 WETH 주소에 `deposit()`, `value`는 `amountInRaw`다(F7 DoD-21).
 */
export function buildWrapRequest({ chainId, amountInRaw }: WethTransactionParams): WrapRequest {
  return {
    to: CONTRACTS_BY_CHAIN[chainId].weth,
    functionName: "deposit",
    args: [],
    value: amountInRaw,
  };
}

/**
 * unwrap 요청. 선택 체인 WETH 주소에 `withdraw(amountInRaw)`, `value` 없음이다(F7 DoD-22).
 */
export function buildUnwrapRequest({ chainId, amountInRaw }: WethTransactionParams): UnwrapRequest {
  return {
    to: CONTRACTS_BY_CHAIN[chainId].weth,
    functionName: "withdraw",
    args: [amountInRaw],
    value: undefined,
  };
}

/**
 * wrap·unwrap 요청의 WETH calldata(`deposit()` 또는 `withdraw(wad)`).
 */
export function encodeWethCalldata(request: WrapRequest | UnwrapRequest): Hex {
  return request.functionName === "deposit"
    ? encodeFunctionData({ abi: wethAbi, functionName: "deposit" })
    : encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: request.args });
}
