import { Address } from "viem";
import { TokenInfo } from "@/config/tokens";

// 토큰 하나를 라디오 버튼으로 선택하는 그룹 (tokenIn/tokenOut 양쪽에서 재사용)
export const TokenRadioGroup = ({
  name,
  tokenList,
  selectedAddress,
  onSelect,
}: {
  name: string;
  tokenList: TokenInfo[];
  selectedAddress: Address | null;
  onSelect: (address: Address) => void;
}) => {
  return (
    <div>
      {tokenList.map((token) => {
        const inputId = `${name}-${token.address}`;
        return (
          <div key={token.address}>
            <input
              type="radio"
              id={inputId}
              name={name}
              value={token.address}
              checked={selectedAddress === token.address}
              onChange={(e) => onSelect(e.target.value as Address)}
            />
            <label htmlFor={inputId}>{token.symbol}</label>
          </div>
        );
      })}
    </div>
  );
};
