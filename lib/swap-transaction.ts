import { type Address, type Hex, encodeFunctionData, erc20Abi, maxUint256 } from "viem";

import type { SupportedChainId } from "@/config/chains";
import type { Token } from "@/config/tokens";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { ALLOWANCE_RESET_TOKEN_ADDRESSES_BY_CHAIN } from "@/config/tokens";
import { type FeeTier, swapRouter02Abi } from "@/config/uniswap-v3";
import { resolveQuoteTokens } from "@/lib/swap-quote";

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
