"use client";
import { formatUnits } from "viem";
import { useBalance, useConnection } from "wagmi";

export function ConnectionInfo() {
    const connection = useConnection();
    const balance = useBalance({ address: connection.address });

    if (!connection.isConnected) {
        return <p>지갑이 연결되지 않음</p>;
    }
    if (connection.isConnecting) {
        return <p>지갑에 연결중...</p>;
    }
    if (connection.isDisconnected) {
        return <p>지갑 연결 해제됨</p>;
    }
    return (
        <div>
            <p>연결된 주소: {connection.address}</p>
            <p>
                체인: {connection.chain?.name}, {connection.chainId}
            </p>
            <div>
                네이티브 잔액:
                {balance.isPending ? (
                    <p>불러오는 중...</p>
                ) : (
                    <p>
                        {formatUnits(
                            balance.data?.value,
                            balance.data?.decimals,
                        )}
                        {balance.data?.symbol}
                    </p>
                )}
            </div>
        </div>
    );
}
