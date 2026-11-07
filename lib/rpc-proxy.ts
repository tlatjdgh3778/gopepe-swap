import { SUPPORTED_CHAIN_IDS, type SupportedChainId } from "@/config/chains";
import {
  ALLOWED_RPC_METHODS,
  RPC_MAX_BATCH_SIZE,
  RPC_MAX_BODY_BYTES,
  RPC_TIMEOUT_MS,
  getProviderRpcUrl,
  getPublicRpcUrl,
} from "@/config/rpc";

const LOG_PREFIX = "[rpc-proxy]";
const REDACTED = "[redacted]";
// 업체 URL의 경로 조각·쿼리 값 중 이 길이 이상을 키 후보로 보고 가린다.
// `v2`, `rpc` 같은 짧은 경로 조각은 키가 아니므로 남긴다.
const MIN_SECRET_PART_LENGTH = 6;

type UpstreamFailureKind =
  | "network"
  | "timeout"
  | "http_4xx"
  | "http_5xx"
  | "http_other"
  | "invalid_json";

type UpstreamResult =
  | { ok: true; text: string; json: unknown }
  | { ok: false; kind: UpstreamFailureKind };

type ParsedBody = { ok: true; text: string } | { ok: false; response: Response };

/**
 * `POST /api/rpc/[chainId]` 처리.
 * 거절 판정 순서: chainId, Origin, 크기, JSON 형식, 배치 개수, 메서드.
 */
export async function handleRpcProxyRequest(
  request: Request,
  chainIdParam: string,
): Promise<Response> {
  const chainId = parseChainId(chainIdParam);
  if (chainId === undefined) {
    return errorResponse(404, "Unsupported chain");
  }

  if (!isSameSiteRequest(request.headers)) {
    return errorResponse(403, "Forbidden");
  }

  const body = await readBodyWithLimit(request);
  if (!body.ok) {
    return body.response;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return errorResponse(400, "Invalid JSON");
  }

  let requests: Record<string, unknown>[];
  let isBatch: boolean;
  if (Array.isArray(payload)) {
    if (payload.length === 0 || !payload.every(isJsonRpcRequest)) {
      return errorResponse(400, "Invalid JSON-RPC request");
    }
    if (payload.length > RPC_MAX_BATCH_SIZE) {
      return errorResponse(400, "Batch too large");
    }
    requests = payload;
    isBatch = true;
  } else if (isJsonRpcRequest(payload)) {
    requests = [payload];
    isBatch = false;
  } else {
    return errorResponse(400, "Invalid JSON-RPC request");
  }

  if (requests.some((item) => !ALLOWED_RPC_METHODS.has(item.method as string))) {
    return Response.json({
      jsonrpc: "2.0",
      id: isBatch ? null : toJsonRpcId(requests[0].id),
      error: { code: -32601, message: "Method not found" },
    });
  }

  return forwardToUpstream(chainId, body.text);
}

function parseChainId(value: string): SupportedChainId | undefined {
  return SUPPORTED_CHAIN_IDS.find((id) => String(id) === value);
}

// Origin을 URL로 파싱해 host·port가 요청의 Host 또는 X-Forwarded-Host와 같을 때만 허용한다.
// Host에 포트가 없으면 Origin scheme의 기본 포트로 본다. 부분 문자열·접미 일치는 쓰지 않는다.
function isSameSiteRequest(headers: Headers): boolean {
  const originHeader = headers.get("origin");
  if (originHeader === null) {
    return false;
  }

  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    return false;
  }
  // Origin 헤더는 `scheme://host[:port]` 형태만 인정한다(경로·쿼리·사용자 정보가 붙으면 형식 오류).
  if (origin.origin !== originHeader) {
    return false;
  }

  const candidates = [headers.get("host"), firstHeaderValue(headers.get("x-forwarded-host"))];
  return candidates.some((hostValue) => {
    if (!hostValue) {
      return false;
    }
    const target = parseHostAsOrigin(origin.protocol, hostValue);
    return target !== undefined && target === origin.origin;
  });
}

function firstHeaderValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const first = value.split(",")[0]?.trim();
  return first ? first : null;
}

// Host 헤더 값(`host[:port]`)을 Origin과 같은 scheme의 origin 문자열로 만든다.
// 경로·사용자 정보 등 host 외의 값이 섞이면 거절한다.
function parseHostAsOrigin(protocol: string, hostValue: string): string | undefined {
  const trimmed = hostValue.trim();
  if (!trimmed || /[/?#@\\\s]/.test(trimmed)) {
    return undefined;
  }
  try {
    return new URL(`${protocol}//${trimmed}`).origin;
  } catch {
    return undefined;
  }
}

// Content-Length 신고값과 실제 읽은 바이트 수 모두로 크기 상한을 판정한다.
async function readBodyWithLimit(request: Request): Promise<ParsedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > RPC_MAX_BODY_BYTES) {
      return { ok: false, response: errorResponse(413, "Payload too large") };
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        total += value.byteLength;
        if (total > RPC_MAX_BODY_BYTES) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, response: errorResponse(413, "Payload too large") };
        }
        chunks.push(value);
      }
    } catch {
      return { ok: false, response: errorResponse(400, "Invalid request body") };
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, response: errorResponse(400, "Invalid JSON") };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcRequest(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value.method === "string";
}

function toJsonRpcId(id: unknown): string | number | null {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

async function forwardToUpstream(chainId: SupportedChainId, body: string): Promise<Response> {
  const providerUrl = getProviderRpcUrl(chainId);
  const secrets = providerUrl ? collectSecrets(providerUrl) : [];

  if (providerUrl) {
    const result = await callUpstream(providerUrl, body);
    if (result.ok) {
      return upstreamResponse(result, secrets);
    }
    console.warn(
      `${LOG_PREFIX} chain ${chainId}: provider RPC failed (${result.kind}), falling back to public RPC`,
    );
  }

  const result = await callUpstream(getPublicRpcUrl(chainId), body);
  if (result.ok) {
    return upstreamResponse(result, secrets);
  }
  console.error(`${LOG_PREFIX} chain ${chainId}: public RPC failed (${result.kind})`);
  return errorResponse(502, "All RPC endpoints failed");
}

// 시간 제한은 응답 헤더 이후 본문 수신까지 포함한다.
// 가짜 타이머로 진행할 수 있도록 setTimeout 기반으로 끊고, fetch가 abort를 무시해도 시간 제한으로 끝낸다.
async function callUpstream(url: string, body: string): Promise<UpstreamResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UpstreamResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ ok: false, kind: "timeout" });
      controller.abort();
    }, RPC_TIMEOUT_MS);
  });

  const attempt = (async (): Promise<UpstreamResult> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        signal: controller.signal,
      });
    } catch {
      return { ok: false, kind: "network" };
    }

    if (response.status < 200 || response.status >= 300) {
      response.body?.cancel().catch(() => undefined);
      return { ok: false, kind: httpFailureKind(response.status) };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, kind: "network" };
    }

    try {
      return { ok: true, text, json: JSON.parse(text) };
    } catch {
      return { ok: false, kind: "invalid_json" };
    }
  })();

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function httpFailureKind(status: number): UpstreamFailureKind {
  if (status >= 400 && status < 500) {
    return "http_4xx";
  }
  if (status >= 500 && status < 600) {
    return "http_5xx";
  }
  return "http_other";
}

// 업체 응답 헤더는 복사하지 않는다. 본문은 가릴 값이 없으면 원문 그대로 돌려준다.
// 가릴지는 파싱 결과가 아니라 원문 텍스트의 모든 문자열 리터럴(중복 키로 가려진 값 포함)로 판단한다.
// 가릴 값이 있으면 원문 텍스트에서 비밀의 JSON 문자열 형태만 바꿔 키 이름·숫자 리터럴·순서를 보존한다.
// 그 결과를 검증하지 못하면(유니코드 이스케이프 등) 파싱 결과를 가려 다시 직렬화한다(중복 키는 사라진다).
function upstreamResponse(result: { text: string; json: unknown }, secrets: string[]): Response {
  let text = result.text;
  if (secrets.length > 0 && jsonTextContainsSecret(result.text, secrets)) {
    text =
      redactJsonText(result.text, result.json, secrets) ??
      JSON.stringify(redactDeep(result.json, secrets));
  }
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// 유효한 JSON 텍스트의 모든 문자열 리터럴(값과 키, 중복 키로 가려진 값 포함)을 해석해 비밀이 있는지 본다.
// 해석한 값으로 비교하므로 원문 형태, `\/`, `\uXXXX` 같은 이스케이프 형태를 모두 잡는다.
// JSON 문자열 밖에는 `"`가 없으므로 따옴표 단위로 리터럴을 나눌 수 있다.
function jsonTextContainsSecret(text: string, secrets: string[]): boolean {
  let index = text.indexOf('"');
  while (index !== -1) {
    let end = index + 1;
    let escaped = false;
    while (end < text.length && text[end] !== '"') {
      if (text[end] === "\\") {
        escaped = true;
        end += 2;
      } else {
        end += 1;
      }
    }
    let value: string;
    if (escaped) {
      try {
        value = JSON.parse(text.slice(index, end + 1)) as string;
      } catch {
        // 해석하지 못하면 비밀이 있다고 보고 가리는 경로로 보낸다.
        return true;
      }
    } else {
      value = text.slice(index + 1, end);
    }
    if (secrets.some((secret) => value.includes(secret))) {
      return true;
    }
    index = text.indexOf('"', end + 1);
  }
  return false;
}

// 원문 텍스트에서 비밀의 JSON 문자열 이스케이프 형태(`/`를 `\/`로 쓴 형태 포함)를 직접 바꾼다.
// 결과가 유효한 JSON이고, 파싱 결과가 원문 파싱 결과를 문자열 단위로 가린 값과 같으며,
// 결과 텍스트의 문자열 리터럴(중복 키로 가려진 값 포함) 어디에도 비밀이 남지 않을 때만 돌려준다. 아니면 undefined다.
function redactJsonText(text: string, parsed: unknown, secrets: string[]): string | undefined {
  const patterns = new Set<string>();
  for (const secret of secrets) {
    const escaped = JSON.stringify(secret).slice(1, -1);
    patterns.add(escaped);
    patterns.add(escaped.replaceAll("/", "\\/"));
  }

  let out = text;
  for (const pattern of [...patterns].sort((x, y) => y.length - x.length)) {
    if (out.includes(pattern)) {
      out = out.split(pattern).join(REDACTED);
    }
  }

  let reparsed: unknown;
  try {
    reparsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (!matchesRedacted(parsed, reparsed, secrets) || jsonTextContainsSecret(out, secrets)) {
    return undefined;
  }
  return out;
}

// `actual`이 `original`의 문자열 값·키만 가린 결과와 구조·값·키 순서까지 같은지 본다.
function matchesRedacted(original: unknown, actual: unknown, secrets: string[]): boolean {
  if (typeof original === "string") {
    return actual === redactString(original, secrets);
  }
  if (Array.isArray(original)) {
    return (
      Array.isArray(actual) &&
      actual.length === original.length &&
      original.every((item, index) => matchesRedacted(item, actual[index], secrets))
    );
  }
  if (isPlainObject(original)) {
    if (!isPlainObject(actual)) {
      return false;
    }
    const originalEntries = Object.entries(original);
    const actualEntries = Object.entries(actual);
    return (
      originalEntries.length === actualEntries.length &&
      originalEntries.every(
        ([key, item], index) =>
          actualEntries[index][0] === redactString(key, secrets) &&
          matchesRedacted(item, actualEntries[index][1], secrets),
      )
    );
  }
  return Object.is(original, actual);
}

// 재직렬화 경로. `__proto__` 같은 키도 자체 속성으로 남도록 defineProperty로 만든다.
function redactDeep(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, redactString(key, secrets), {
        value: redactDeep(item, secrets),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

function redactString(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

// 업체 URL 전체(원문·정규화 형태)와 그 안의 비밀 부분(호스트, 서브도메인 라벨, 사용자 정보, 경로 조각, 쿼리 값)을 모은다.
// 긴 값부터 바꾸도록 길이 내림차순으로 정렬한다.
function collectSecrets(rawUrl: string): string[] {
  const secrets = new Set<string>();
  const add = (value: string | undefined, minLength = 1) => {
    if (!value || value.length < minLength) {
      return;
    }
    secrets.add(value);
    const decoded = safeDecode(value);
    if (decoded && decoded.length >= minLength) {
      secrets.add(decoded);
    }
  };

  add(rawUrl);
  add(rawUrl.replace(/\/+$/, ""));

  let url: URL | undefined;
  try {
    url = new URL(rawUrl);
  } catch {
    url = undefined;
  }

  if (url) {
    add(url.href);
    add(url.href.replace(/\/+$/, ""));
    if (url.pathname !== "/" || url.search) {
      // scheme 없이 출력된 URL(`host/path?query`)도 가린다.
      add(`${url.host}${url.pathname}${url.search}`.replace(/\/+$/, ""));
    }
    // 서브도메인에 키를 둔 업체(`https://<키>.provider.example/`)도 있으므로 호스트 형태도 가린다.
    // URL 파서는 호스트를 소문자로 바꾸므로 원문 대소문자의 호스트도 함께 모은다.
    const rawHost = rawUrlHost(rawUrl);
    // 짧은 호스트(`cafe` 등)가 정상 응답 값을 훼손하지 않도록 경로 조각과 같은 하한을 둔다.
    for (const host of [url.host, rawHost]) {
      add(host, MIN_SECRET_PART_LENGTH);
    }
    for (const hostname of [url.hostname, rawHost?.replace(/:\d*$/, "")]) {
      add(hostname, MIN_SECRET_PART_LENGTH);
      if (hostname) {
        add(subdomainSecretLabel(hostname), MIN_SECRET_PART_LENGTH);
      }
    }
    add(url.username, MIN_SECRET_PART_LENGTH);
    add(url.password, MIN_SECRET_PART_LENGTH);
    for (const segment of url.pathname.split("/")) {
      add(segment, MIN_SECRET_PART_LENGTH);
    }
    add(url.search.replace(/^\?/, ""), MIN_SECRET_PART_LENGTH);
    for (const [, value] of url.searchParams) {
      add(value, MIN_SECRET_PART_LENGTH);
    }
  }

  return [...secrets].sort((x, y) => y.length - x.length);
}

// 원문 URL의 `host[:port]` 부분(사용자 정보 제외)을 대소문자 그대로 꺼낸다.
function rawUrlHost(rawUrl: string): string | undefined {
  const match = /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#]*@)?([^/?#]+)/i.exec(rawUrl);
  return match?.[1];
}

// 라벨이 3개 이상인 도메인 이름의 가장 왼쪽 라벨(서브도메인)을 키 후보로 본다.
// 등록 도메인(`provider.example`)의 라벨과 IP 주소는 키가 아니므로 제외한다.
function subdomainSecretLabel(hostname: string): string | undefined {
  if (hostname.startsWith("[") || /^\d+(\.\d+){3}$/.test(hostname)) {
    return undefined;
  }
  const labels = hostname.split(".");
  return labels.length >= 3 ? labels[0] : undefined;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}
