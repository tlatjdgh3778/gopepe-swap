import { vi } from "vitest";

// 프록시 통합 테스트(T-9)의 mock 경계: 전역 fetch만 URL 라우팅 스텁으로 바꾼다.
// 라우트가 없는 URL은 호출을 기록한 뒤 네트워크 오류로 실패한다.

export type StubCall = {
  url: string;
  body: string;
  signal: AbortSignal | undefined;
};

export type StubHandler = (call: StubCall) => Response | Promise<Response>;

export type RpcFetchStub = {
  route(url: string, handler: StubHandler): void;
  calls(): StubCall[];
  callsTo(url: string): StubCall[];
  // 해당 URL로 다음 호출이 들어오면 resolve한다. 이미 들어온 호출은 기다리지 않는다.
  nextCallTo(url: string): Promise<StubCall>;
  reset(): void;
};

function toUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

async function readBody(input: string | URL | Request, init: RequestInit | undefined) {
  if (init?.body !== undefined && init.body !== null) {
    return typeof init.body === "string" ? init.body : await new Response(init.body).text();
  }
  if (input instanceof Request) {
    return await input.clone().text();
  }
  return "";
}

export function installRpcFetchStub(): RpcFetchStub {
  const routes = new Map<string, StubHandler>();
  let recorded: StubCall[] = [];
  let waiters: { url: string; resolve: (call: StubCall) => void }[] = [];

  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: StubCall = {
      url: toUrl(input),
      body: await readBody(input, init),
      signal: init?.signal ?? undefined,
    };
    recorded.push(call);
    const matched = waiters.filter((waiter) => waiter.url === call.url);
    waiters = waiters.filter((waiter) => waiter.url !== call.url);
    for (const waiter of matched) {
      waiter.resolve(call);
    }

    const handler = routes.get(call.url);
    if (!handler) {
      throw new TypeError("fetch failed (unrouted test URL)");
    }
    return await handler(call);
  });

  vi.stubGlobal("fetch", fetchStub);

  return {
    route(url, handler) {
      routes.set(url, handler);
    },
    calls() {
      return [...recorded];
    },
    callsTo(url) {
      return recorded.filter((call) => call.url === url);
    },
    nextCallTo(url) {
      return new Promise((resolve) => {
        waiters.push({ url, resolve });
      });
    },
    reset() {
      routes.clear();
      recorded = [];
      waiters = [];
      fetchStub.mockClear();
    },
  };
}

// 스텁 응답 모음. 각 함수는 라우트에 넣을 handler를 돌려준다.
export const reply = {
  json(body: unknown, init?: { status?: number; headers?: Record<string, string> }): StubHandler {
    return () =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json", ...init?.headers },
      });
  },

  text(text: string, status = 200, contentType = "text/plain"): StubHandler {
    return () => new Response(text, { status, headers: { "content-type": contentType } });
  },

  networkError(message = "fetch failed", cause?: unknown): StubHandler {
    return () =>
      Promise.reject(new TypeError(message, cause === undefined ? undefined : { cause }));
  },

  // 응답 헤더도 오지 않는다. abort되면 그 사유로 실패한다.
  hang(): StubHandler {
    return ({ signal }) =>
      new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
  },

  // 응답 헤더는 오지만 본문이 끝나지 않는다.
  stallBody(status = 200): StubHandler {
    return () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status,
        headers: { "content-type": "application/json" },
      });
  },
};
