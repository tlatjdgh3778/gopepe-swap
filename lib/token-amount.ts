import { formatUnits } from "viem";

import type { SupportedChainId } from "@/config/chains";

import { GAS_RESERVE_BY_CHAIN } from "@/config/gas-reserve";
import { NATIVE_ETH_ADDRESS, type Token } from "@/config/tokens";

// 숫자 표시는 로캘 API(Intl, toLocaleString) 없이 bigint와 문자열 연산으로만 만든다.

const DISPLAY_FRACTION_DIGITS = 4;
const DISPLAY_MIN_LABEL = "<0.0001";

// 숫자와 소수점 하나. 빈 문자열, `.`, `1.`, `.5`도 형식에 맞는다.
const AMOUNT_PATTERN = /^\d*\.?\d*$/;

function groupThousands(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function splitAmount(amount: string): { integer: string; fraction: string | null } {
  const dotIndex = amount.indexOf(".");
  if (dotIndex === -1) return { integer: amount, fraction: null };
  return { integer: amount.slice(0, dotIndex), fraction: amount.slice(dotIndex + 1) };
}

/**
 * 잔액 표시 문자열. 소수는 최대 4자리까지 버리고 끝의 0을 지우며, 천 단위는 쉼표, 소수점은 마침표다.
 * 0이면 `0`, 0보다 크고 0.0001보다 작으면 `<0.0001`이다. `raw`는 0 이상의 정수 잔액이다.
 */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";

  const unit = 10n ** BigInt(decimals);
  const integer = raw / unit;
  const fraction = (raw % unit)
    .toString()
    .padStart(decimals, "0")
    .slice(0, DISPLAY_FRACTION_DIGITS)
    .replace(/0+$/, "");

  if (integer === 0n && fraction === "") return DISPLAY_MIN_LABEL;

  const integerText = groupThousands(integer.toString());
  return fraction === "" ? integerText : `${integerText}.${fraction}`;
}

/**
 * 금액 입력을 정리한다. 쉼표는 소수점으로 바꾼다.
 * 숫자·소수점·쉼표 외의 문자, 두 번째 소수점, decimals를 넘는 소수 자릿수가 있으면 `null`(거부)이다.
 * 반영할 문자열은 정규화하지 않는다(`007`, `1.`, `.`, `0.00`은 그대로).
 */
export function sanitizeAmountInput(input: string, decimals: number): string | null {
  const normalized = input.replaceAll(",", ".");
  if (!AMOUNT_PATTERN.test(normalized)) return null;

  const { fraction } = splitAmount(normalized);
  if (fraction !== null && fraction.length > decimals) return null;

  return normalized;
}

/**
 * 금액 문자열을 decimals 기준 정수로 바꾼다(§4.3 `amountInRaw`).
 * 빈 값이나 `.`이면 `null`, 값이 0이면 `0n`이다.
 * 형식에 맞지 않거나 decimals를 넘는 소수 자릿수가 있으면 반올림하지 않고 `null`이다.
 */
export function parseAmountRaw(amount: string, decimals: number): bigint | null {
  if (amount === "" || amount === ".") return null;
  if (!AMOUNT_PATTERN.test(amount)) return null;

  const { integer, fraction } = splitAmount(amount);
  const fractionDigits = fraction ?? "";
  if (fractionDigits.length > decimals) return null;

  return BigInt(`${integer}${fractionDigits.padEnd(decimals, "0")}` || "0");
}

/**
 * 보내는 토큰을 바꿀 때 금액을 새 decimals에 맞춘다.
 * decimals를 넘는 소수 자릿수만 반올림 없이 잘라내고, 넘지 않으면 그대로 돌려준다(`1.`도 유지).
 * 소수부가 모두 잘리면(decimals 0) 소수점도 지운다.
 */
export function truncateAmountDecimals(amount: string, decimals: number): string {
  const { integer, fraction } = splitAmount(amount);
  if (fraction === null || fraction.length <= decimals) return amount;
  if (decimals === 0) return integer;
  return `${integer}.${fraction.slice(0, decimals)}`;
}

export function isNativeToken(token: Pick<Token, "address">): boolean {
  return token.address.toLowerCase() === NATIVE_ETH_ADDRESS.toLowerCase();
}

/**
 * `최대`가 넣을 정수 금액. ERC-20은 잔액 전체, ETH는 잔액에서 선택 체인의 가스 예약량을 뺀 값이다.
 * ETH 잔액이 가스 예약량 이하이면 `0n`이다.
 */
export function getMaxAmountRaw(
  balance: bigint,
  token: Pick<Token, "address">,
  chainId: SupportedChainId,
): bigint {
  if (!isNativeToken(token)) return balance;
  const reserve = GAS_RESERVE_BY_CHAIN[chainId];
  return balance > reserve ? balance - reserve : 0n;
}

/**
 * `최대`가 금액에 넣는 문자열. 천 단위 쉼표가 없고, 소수부 끝의 0을 지우며,
 * 소수부가 모두 0이면 소수점도 지운다. 같은 decimals로 정수로 바꾸면 `getMaxAmountRaw`와 같다.
 */
export function formatMaxAmount(
  balance: bigint,
  token: Pick<Token, "address" | "decimals">,
  chainId: SupportedChainId,
): string {
  return formatUnits(getMaxAmountRaw(balance, token, chainId), token.decimals);
}
