// 표시 문자열은 로캘 API(Intl, toLocaleString) 없이 bigint와 문자열 연산으로만 만든다.

export type SlippageBps = 10 | 50 | 100;

export const SLIPPAGE_PRESETS_BPS = [10, 50, 100] as const satisfies readonly SlippageBps[];

export const DEFAULT_SLIPPAGE_BPS = 50 satisfies SlippageBps;

const BPS_DENOMINATOR = 10_000n;
// 1% = 100 bps. 소수 1자리 표기는 10 bps 단위다.
const BPS_PER_PERCENT = 100n;
const BPS_PER_TENTH_PERCENT = 10n;

/**
 * 프리셋 값인지 확인한다. Base UI RadioGroup `onValueChange`처럼 `unknown`으로 받은 값을 `SlippageBps`로 좁힌다.
 */
export function isSlippageBps(value: unknown): value is SlippageBps {
  return (SLIPPAGE_PRESETS_BPS as readonly unknown[]).includes(value);
}

/**
 * 최소 수령량. `amountOut * (10000n - bps) / 10000n`이며 bigint 나눗셈이라 내림이다(DoD-15, EC-1, EC-3).
 */
export function getAmountOutMinimum(amountOut: bigint, slippageBps: SlippageBps): bigint {
  return (amountOut * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

/**
 * 슬리피지 허용치 표기 문자열. 소수 1자리 고정 퍼센트다(10 → `0.1%`, 50 → `0.5%`, 100 → `1.0%`, DoD-16).
 */
export function formatSlippageBps(slippageBps: SlippageBps): string {
  const value = BigInt(slippageBps);
  const integer = (value / BPS_PER_PERCENT).toString();
  const fraction = ((value % BPS_PER_PERCENT) / BPS_PER_TENTH_PERCENT).toString();
  return `${integer}.${fraction}%`;
}
