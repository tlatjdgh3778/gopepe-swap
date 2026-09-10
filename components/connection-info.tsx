"use client";
import { formatUnits } from "viem";
import { useBalance, useConnection } from "wagmi";

export function ConnectionInfo() {
    const connection = useConnection();
    const balance = useBalance({ address: connection.address });

    switch (connection.status) {
        case "disconnected":
            return <p>지갑이 연결되지 않음</p>;
        case "connecting":
            return <p>지갑에 연결중...</p>;
        case "reconnecting":
            return <p>지갑에 재연결중...</p>;
        case "connected":
            return (
                <div>
                    <p>연결된 주소: {connection.address}</p>
                    <p>
                        체인: {connection.chain?.name}, {connection.chainId}
                    </p>
                    <div>
                        네이티브 잔액:
                        {(() => {
                            switch (balance.status) {
                                case "pending":
                                    return <p>불러오는 중...</p>;
                                case "error":
                                    return <p>에러: {balance.error.message}</p>;
                                case "success":
                                    return (
                                        <p>
                                            {formatUnits(
                                                balance.data.value,
                                                balance.data.decimals,
                                            )}
                                            {balance.data.symbol}
                                        </p>
                                    );
                            }
                        })()}
                    </div>
                </div>
            );
    }
}
