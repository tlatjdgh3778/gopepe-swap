import { act, render, renderHook, waitFor } from "@testing-library/react";
import { Profiler, type ReactNode } from "react";
import type { Address } from "viem";
import { expect, vi } from "vitest";
import {
  type CreateConnectorFn,
  type State,
  createStorage,
  injected,
  mock,
  noopStorage,
} from "wagmi";
import { getConnection } from "wagmi/actions";

import Home from "@/app/page";
import type { SupportedChainId } from "@/config/chains";
import type { WagmiConfig } from "@/config/wagmi";
import { AppProviders } from "@/providers/app-providers";

import type { StubEip1193 } from "./stub-eip1193";

// 지갑 통합 테스트(T-10) 공용 하네스.
// wagmi와 앱 Provider·화면은 실제 코드를 쓴다. 지갑 자리에는 wagmi mock 커넥터나 스텁 EIP-1193 provider만 둔다.
// 테스트마다 `createWagmiConfig`로 config를 새로 만든다(복원 잠금도 config 단위라 테스트 간에 섞이지 않는다).

export const TEST_ACCOUNT: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

// 스펙의 지원 체인(1, 8453, 42161) 밖의 체인 ID 표본(Polygon).
export const UNSUPPORTED_CHAIN_ID = 137;

export const STUB_CONNECTOR_ID = "stub-wallet";

// 저장소가 필요 없는 테스트용. 저장된 연결이 없는 상태로 시작한다.
export function createNoopWagmiStorage() {
  return createStorage({ storage: noopStorage });
}

// 스텁 provider를 붙인 wagmi injected 커넥터(EIP-6963으로 감지된 지갑과 같은 형태).
export function stubConnector(stub: StubEip1193): CreateConnectorFn {
  return injected({
    target: { id: STUB_CONNECTOR_ID, name: "Stub Wallet", provider: () => stub.provider as never },
  });
}

export type MockFeatures = NonNullable<Parameters<typeof mock>[0]["features"]>;

export function mockConnector(features: MockFeatures): CreateConnectorFn {
  return mock({ accounts: [TEST_ACCOUNT], features });
}

type AppRenderOptions = {
  config: WagmiConfig;
  initialChainId: SupportedChainId;
  initialState?: State;
  // 커밋마다 호출된다(`createButtonStateRecorder().onCommit`).
  onCommit?: () => void;
};

const noop = () => {};

function AppTree({
  config,
  initialChainId,
  initialState,
  onCommit,
  children,
}: AppRenderOptions & { children?: ReactNode }) {
  // Profiler는 Provider 전체를 감싼다. Provider 안쪽에 두면 바깥(복원 추적기 등)에서 시작된 Context 변경 커밋에서
  // onRender가 호출되지 않아 상태 변화가 기록되지 않는다.
  return (
    <Profiler id="gopepe-app" onRender={onCommit ?? noop}>
      <AppProviders config={config} initialChainId={initialChainId} initialState={initialState}>
        <Home />
        {children}
      </AppProviders>
    </Profiler>
  );
}

// 앱 화면 전체(헤더, 스왑 카드, 연결 모달)를 실제 Provider로 렌더링한다.
export function renderApp(options: AppRenderOptions) {
  return render(<AppTree {...options} />);
}

// 앱 화면과 함께 훅을 렌더링한다. 화면 쪽 동작(드롭다운 등)도 실제로 붙어 있는 상태에서 훅을 관찰한다.
export function renderAppHook<T>(hook: () => T, options: AppRenderOptions) {
  return renderHook(hook, {
    wrapper: ({ children }: { children: ReactNode }) => <AppTree {...options}>{children}</AppTree>,
  });
}

// 앱에 연결된 체인은 커넥션의 chainId로 읽는다(wagmi state의 chainId는 비지원 체인에서 갱신되지 않는다).
export function connectedChainId(config: WagmiConfig): number | undefined {
  return getConnection(config).chainId;
}

export async function waitForConnectedOn(config: WagmiConfig, chainId: number) {
  await waitFor(() => {
    const connection = getConnection(config);
    expect(connection.status).toBe("connected");
    expect(connection.chainId).toBe(chainId);
  });
}

export type EnsureChainOutcome =
  | { status: "resolved"; connectedChainIdAtSettle: number | undefined }
  | { status: "rejected"; error: unknown; connectedChainIdAtSettle: number | undefined };

// ensureChain을 호출하고, resolve·reject한 그 시점의 연결 체인을 함께 기록한다.
export async function callEnsureChain(
  ensureChain: () => Promise<void>,
  config: WagmiConfig,
): Promise<EnsureChainOutcome> {
  let outcome: EnsureChainOutcome | undefined;
  await act(async () => {
    try {
      await ensureChain();
      outcome = { status: "resolved", connectedChainIdAtSettle: connectedChainId(config) };
    } catch (error) {
      outcome = { status: "rejected", error, connectedChainIdAtSettle: connectedChainId(config) };
    }
  });
  if (!outcome) throw new Error("ensureChain outcome was not recorded");
  return outcome;
}

// 지정한 시점 이후 지갑이 받은 요청 중 해당 메서드만 고른다.
export function requestsSince(stub: StubEip1193, fromIndex: number, methods: readonly string[]) {
  return stub.requests.slice(fromIndex).filter((request) => methods.includes(request.method));
}

export const CHAIN_SWITCH_METHODS = ["wallet_switchEthereumChain", "wallet_addEthereumChain"];

// 실제 타이머에서 대기 중인 비동기 작업(이벤트에 반응한 effect, mutation 등)이 진행되도록 잠깐 양보한다.
export async function yieldToPendingWork(ms = 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

// jsdom 문서의 쿠키를 모두 지운다(선택 체인 쿠키, wagmi cookieStorage).
export function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const key = part.trim().split("=")[0];
    if (key) document.cookie = `${key}=; max-age=-1; path=/`;
  }
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export type TrackedButton = "primary-button" | "wallet-button";

export type ButtonSnapshot = {
  // `data-state` 값. 버튼이 없으면 null
  state: string | null;
  disabled: boolean;
  // 로딩 표시(aria-busy)
  busy: boolean;
};

function snapshotButton(button: TrackedButton): ButtonSnapshot {
  const element = document.querySelector<HTMLButtonElement>(`[data-testid="${button}"]`);
  return {
    state: element?.getAttribute("data-state") ?? null,
    disabled: element?.disabled ?? false,
    busy: element?.getAttribute("aria-busy") === "true",
  };
}

// 주 버튼·지갑 버튼이 커밋마다 표시한 상태를 첫 커밋부터 빠짐없이 기록한다.
// `renderApp`의 `onCommit`에 넘기면 React Profiler가 커밋 직후(DOM 반영 후) 동기로 호출한다.
export function createButtonStateRecorder() {
  const snapshots: Record<TrackedButton, ButtonSnapshot[]> = {
    "primary-button": [],
    "wallet-button": [],
  };
  const record = () => {
    for (const button of Object.keys(snapshots) as TrackedButton[]) {
      const next = snapshotButton(button);
      const list = snapshots[button];
      const last = list.at(-1);
      if (
        !last ||
        last.state !== next.state ||
        last.disabled !== next.disabled ||
        last.busy !== next.busy
      ) {
        list.push(next);
      }
    }
  };
  return {
    onCommit: record,
    // 첫 커밋부터 지금까지 바뀐 상태의 순서
    snapshots(button: TrackedButton): ButtonSnapshot[] {
      return snapshots[button];
    },
    states(button: TrackedButton): (string | null)[] {
      return snapshots[button].map((snapshot) => snapshot.state);
    },
  };
}

export function currentButton(button: TrackedButton): ButtonSnapshot {
  return snapshotButton(button);
}

// --- T-6 추가: 가짜 타이머에서도 쓰는 대기 헬퍼 ---
// 모듈을 불러온 시점(가짜 타이머를 켜기 전)의 실제 타이머·시계를 잡아 둔다.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realDateNow = Date.now.bind(Date);

// 대기 중인 비동기 작업(응답 처리, 0ms 타이머로 예약된 알림, 렌더링)을 진행시킨다.
// 가짜 타이머에서는 0ms 타이머만 실행하고 가짜 시계는 움직이지 않는다.
async function stepPendingWork() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  });
}

// 조건이 맞을 때까지 기다린다. 실제 시간으로 `timeoutMs`가 지나도 맞지 않으면 마지막 실패를 던진다.
// testing-library `waitFor`와 달리 가짜 타이머에서도 멈추지 않고, 가짜 시계를 움직이지 않는다.
export async function waitUntil(assertion: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = realDateNow() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (realDateNow() > deadline) throw error;
    }
    await stepPendingWork();
  }
}

// 대기 중인 작업을 몇 차례 진행시킨다. 어떤 일이 일어나지 않았음을 판정하기 전에 쓴다.
export async function settlePendingWork(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await stepPendingWork();
}

// --- T-6(F3) 추가: setTimeout까지 가짜로 둔 상태의 대기 헬퍼 ---
// setTimeout이 가짜이면 타이머 진행 도중 처리된 응답의 0ms 알림(react-query notifyManager)이 현재+1ms로 밀려
// `waitUntil`(가짜 시계를 움직이지 않음)로는 실행되지 않는다. 이 헬퍼는 확인 사이마다 가짜 시계를 `stepMs`만큼 진행한다.
// 시각 경계를 판정하지 않는 대기(응답 반영)에만 쓴다. 실제 시간으로 `timeoutMs`가 지나면 마지막 실패를 던진다.
export async function waitUntilAdvancingFakeClock(
  assertion: () => void,
  stepMs = 1,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = realDateNow() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (realDateNow() > deadline) throw error;
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
      await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
    });
  }
}

// 가짜 시계를 지정한 시각(`Date.now()` 기준)까지 진행한다. 그 사이에 예약된 타이머가 실행된다.
export async function advanceFakeTimeTo(time: number): Promise<void> {
  const now = Date.now();
  if (time < now) throw new Error(`가짜 시계를 되돌릴 수 없다: ${now} → ${time}`);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(time - now);
  });
}
