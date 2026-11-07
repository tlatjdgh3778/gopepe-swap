import type { BrowserContext, Page, Request } from "@playwright/test";

import { E2E_ANVIL_PORT } from "../../config/e2e";

export type ObservedRpcCall = {
  // 업체 URL의 경로·쿼리에 키가 있을 수 있어 출처만 남긴다.
  origin: string;
  pathname: string;
  channel: "http" | "websocket";
};

function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isJsonRpcMessage(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      ("jsonrpc" in item || typeof (item as { method?: unknown }).method === "string"),
  );
}

export function jsonRpcMethods(request: Request): string[] {
  const body = parseJson(request.postData());
  const items = Array.isArray(body) ? body : [body];
  return items.flatMap((item) =>
    typeof item === "object" &&
    item !== null &&
    typeof (item as { method?: unknown }).method === "string"
      ? [(item as { method: string }).method]
      : [],
  );
}

// mock 커넥터의 Ethereum `chain.rpcUrls` 출처(`config/e2e-mock.ts`).
// E2E에서 프록시의 업체 대상은 `http://127.0.0.1:<anvil 포트>`이므로 그 출처는 허용하지 않는다.
const MOCK_CONNECTOR_RPC_ORIGIN = `http://localhost:${E2E_ANVIL_PORT}`;

// 허용 대상: 앱 출처의 `/api/rpc/*`, mock 커넥터가 쓰는 anvil 출처(정확히 일치할 때만).
export function isAllowedRpcTarget(url: string, appOrigin: string): boolean {
  const target = new URL(url);
  if (target.origin === appOrigin && target.pathname.startsWith("/api/rpc/")) return true;
  return target.origin === MOCK_CONNECTOR_RPC_ORIGIN;
}

// 브라우저 컨텍스트의 요청을 가로채지 않고 기록한다. 페이지 이동 전에 시작해야 전체 구간을 본다.
export function watchJsonRpcTraffic(context: BrowserContext, page: Page) {
  const calls: ObservedRpcCall[] = [];
  const record = (url: string, channel: ObservedRpcCall["channel"]) => {
    const target = new URL(url);
    calls.push({ origin: target.origin, pathname: target.pathname, channel });
  };

  context.on("request", (request) => {
    if (isJsonRpcMessage(parseJson(request.postData()))) record(request.url(), "http");
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && isJsonRpcMessage(parseJson(payload))) {
        record(socket.url(), "websocket");
      }
    });
  });

  return {
    calls,
    disallowed(appOrigin: string): ObservedRpcCall[] {
      return calls.filter(
        (call) => !isAllowedRpcTarget(`${call.origin}${call.pathname}`, appOrigin),
      );
    },
  };
}
