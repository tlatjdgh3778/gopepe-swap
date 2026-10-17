import { Dispatch, SetStateAction, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { SlippagePresets } from "./slippage-presets";

/**
 * ### 얼마나 토큰을 변환할지 입력하는 곳
 *
 * 1. 문자열 → bigint 변환
 * 2. bigint → 표시용 문자열 (반대 방향)
 * 3. MAX 버튼
 * 4. 잔액 초과 검증
 */
export const AmountInput = ({
  decimals,
  bigIntValue,
  setBigIntValue,
  slippageBps,
  setSlippageBps,
  balance,
}: {
  decimals: number;
  bigIntValue: bigint | "";
  setBigIntValue: Dispatch<SetStateAction<bigint | "">>;
  slippageBps: number;
  setSlippageBps: Dispatch<SetStateAction<number>>;
  balance: bigint | undefined;
}) => {
  const [value, setValue] = useState("");

  const isOverBalance =
    bigIntValue !== "" && balance !== undefined && bigIntValue > balance;

  const onChangeAmount = (value: string) => {
    setValue(value);
    try {
      const bigIntValue = parseUnits(value, decimals);
      setBigIntValue(bigIntValue);
    } catch {
      if (value === "") setBigIntValue(0n);
    }
  };

  const onClickMaxButton = (_e: React.MouseEvent<HTMLElement, MouseEvent>) => {
    // balance 값 (bigint)을 표시용 데이터 (string) 으로 변경한다.
    if (balance !== undefined) {
      const value = formatUnits(balance, decimals);
      setValue(value);
      setBigIntValue(balance);
    } else {
      setValue("");
    }
  };

  return (
    <>
      <button
        name="max-button"
        type="button"
        aria-label="max-button"
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
        onClick={onClickMaxButton}
      >
        MAX
      </button>
      <SlippagePresets
        slippageBps={slippageBps}
        setSlippageBps={setSlippageBps}
      />
      <input
        type="number"
        className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1"
        onChange={(e) => onChangeAmount(e.target.value)}
        value={value}
      />
      {isOverBalance && <p>잔액 초과됨 !</p>}
    </>
  );
};
