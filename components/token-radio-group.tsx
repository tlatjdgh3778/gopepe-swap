import { TokenInfo } from "@/config/tokens";

// 토큰 하나를 라디오 버튼으로 선택하는 그룹 (tokenIn/tokenOut 양쪽에서 재사용)
export const TokenRadioGroup = ({
  name,
  tokenList,
  selectedSymbol,
  onSelect,
}: {
  name: string;
  tokenList: TokenInfo[];
  selectedSymbol: TokenInfo["symbol"] | null;
  onSelect: (symbol: TokenInfo["symbol"]) => void;
}) => {
  return (
    <div>
      {tokenList.map((token) => {
        const inputId = `${name}-${token.symbol}`;
        return (
          <div key={token.symbol}>
            <input
              type="radio"
              id={inputId}
              name={name}
              value={token.symbol}
              checked={selectedSymbol === token.symbol}
              onChange={(e) => onSelect(e.target.value as TokenInfo["symbol"])}
            />
            <label htmlFor={inputId}>{token.symbol}</label>
          </div>
        );
      })}
    </div>
  );
};
