import { Address, formatUnits } from "viem";
import { useBalance } from "wagmi";

// native 토큰 잔액을 보여주는 컴포넌트
export const NativeTokenInfo = ({ address }: { address: Address }) => {
  return (
    <div>
      토큰 잔액 :
      <NativeBalance address={address} />
    </div>
  );
};

const NativeBalance = ({ address }: { address: Address }) => {
  const tokenBalance = useBalance({
    address: address,
  });

  switch (tokenBalance.status) {
    case "success":
      // BigInt
      const balance = tokenBalance.data.value;
      const decimals = tokenBalance.data.decimals;
      const symbol = tokenBalance.data.symbol;
      return (
        <span>
          {formatUnits(balance, decimals)} {symbol}
        </span>
      );
    case "pending":
      return <span>토큰 잔액을 불러오는 중...</span>;
    default:
      return <span>토큰 잔액 불러오기 오류</span>;
  }
};
