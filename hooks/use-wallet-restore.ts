"use client";

import type { Address } from "viem";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useConfig, useConnection } from "wagmi";

// 복원 제한 시간. 이 시간이 지나도 복원이 끝나지 않으면 미연결로 표시한다.
export const RESTORE_TIMEOUT_MS = 5000;

// 주 버튼·지갑 버튼이 쓰는 단일 지갑 상태.
export type WalletStatus = "restoring" | "disconnected" | "connected";

export type WalletRestoreState = {
  status: WalletStatus;
  // status가 "connected"일 때만 값이 있다.
  address: Address | undefined;
};

// 복원이 끝났는지(성공·실패·시간 초과) 여부. AppProviders가 제공한다.
export const WalletRestoreSettledContext = createContext<boolean | null>(null);

type WagmiStatus = "connected" | "connecting" | "disconnected" | "reconnecting";

function isAttemptStatus(status: WagmiStatus) {
  return status === "reconnecting" || status === "connecting";
}

// 앱 수명 동안 한 번만 쓰는 복원 추적기. WagmiProvider 안쪽에서 호출해야 한다.
// 자식 effect가 부모(WagmiProvider의 Hydrate) effect보다 먼저 실행되므로, 마운트 시 시작되는 reconnect 전에 구독한다.
// wagmi의 첫 `disconnected`는 reconnect 시도 전 값이므로 복원 종료로 보지 않는다.
// 복원 종료: 시도(reconnecting/connecting)를 본 뒤 connected·disconnected가 됨, connected가 됨, 또는 제한 시간 경과.
export function useWalletRestoreTracker(): boolean {
  const config = useConfig();
  const [settled, setSettled] = useState(false);
  const settledRef = useRef(false);
  const sawAttemptRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (settledRef.current) return;

    const settle = () => {
      if (settledRef.current) return;
      settledRef.current = true;
      setSettled(true);
    };

    const observe = (status: WagmiStatus) => {
      if (isAttemptStatus(status)) {
        sawAttemptRef.current = true;
        return;
      }
      if (status === "connected" || sawAttemptRef.current) settle();
    };

    // 구독 전에 이미 바뀐 상태(예: initialState로 시작한 reconnecting)도 반영한다.
    observe(config.state.status);
    const unsubscribe = config.subscribe((state) => state.status, observe);

    startedAtRef.current ??= Date.now();
    const remaining = Math.max(0, RESTORE_TIMEOUT_MS - (Date.now() - startedAtRef.current));
    const timer = setTimeout(settle, remaining);

    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [config]);

  return settled;
}

// 복원 중 → 연결·미연결. 시간 제한 뒤에 복원이 늦게 성공하면 연결로 바뀐다.
export function useWalletRestore(): WalletRestoreState {
  const settled = useContext(WalletRestoreSettledContext);
  if (settled === null) throw new Error("useWalletRestore must be used within AppProviders");
  const connection = useConnection();

  if (connection.status === "connected")
    return { status: "connected", address: connection.address };
  if (!settled) return { status: "restoring", address: undefined };
  return { status: "disconnected", address: undefined };
}
