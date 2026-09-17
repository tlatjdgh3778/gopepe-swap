import { Dispatch, SetStateAction, useState } from "react";

// 0.1%, 0.5%, 1.0%
const Presets = [10, 50, 100];

export const SlippagePresets = ({
    slippageBps,
    setSlippageBps,
}: {
    slippageBps: number;
    setSlippageBps: Dispatch<SetStateAction<number>>;
}) => {
    const [bps, setBps] = useState<string>(String(slippageBps / 100));
    const onClickSplippageBps = (value: string) => {
        setSlippageBps(Number(value));
        setBps(String(Number(value) / 100));
    };
    //
    const onChangeSplippageBps = (value: string) => {
        // const debouncedBigIntValue = useDebounce(bigIntValue);
        const bps = Number(value);
        if (bps < 0) return;
        if (bps > 5000) return;
        if (Number.isNaN(bps)) return;
        setSlippageBps(Number(value) * 100);
        setBps(value);
    };

    return (
        <div>
            <p>슬리피지 설정 ({slippageBps / 100}%)</p>
            <div style={{ display: "flex" }}>
                {Presets.map((preset) => {
                    return (
                        <button
                            className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1 hover:bg-foreground/10"
                            key={preset}
                            onClick={(e) => {
                                const value = e.currentTarget.value;
                                onClickSplippageBps(value);
                            }}
                            value={preset}
                            name={`splippage-${preset}`}
                        >
                            {preset}
                        </button>
                    );
                })}
            </div>
            <input
                type="number"
                className="bg-background text-foreground border border-foreground/20 rounded px-2 py-1"
                onChange={(e) => onChangeSplippageBps(e.target.value)}
                value={bps}
            />
            {slippageBps === 0 && (
                <p>
                    슬리피지가 0% 로 설정되어 있으면 가격 손해를 볼 수 있습니다.
                </p>
            )}
        </div>
    );
};
