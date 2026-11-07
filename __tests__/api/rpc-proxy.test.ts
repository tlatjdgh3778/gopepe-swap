// @vitest-environment node
import { inspect } from "node:util";

import { NextRequest } from "next/server";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/rpc/[chainId]/route";

import {
  installRpcFetchStub,
  reply,
  type RpcFetchStub,
  type StubHandler,
} from "../support/rpc-fetch-stub";

// 스펙 §4.1의 값
const TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_BATCH_SIZE = 50;

const SITE_HOST = "app.example.com";
const SITE_ORIGIN = "https://app.example.com";

type ChainFixture = {
  chainId: 1 | 8453 | 42161;
  envName: "ETH_MAINNET_RPC_URL" | "BASE_MAINNET_RPC_URL" | "ARB_MAINNET_RPC_URL";
  key: string;
  providerUrl: string;
  publicUrl: string;
};

// 업체 키는 현실적인 길이(32자)의 가짜 값이다.
function chainFixture(
  chainId: ChainFixture["chainId"],
  envName: ChainFixture["envName"],
  host: string,
  key: string,
  publicUrl: string,
): ChainFixture {
  return { chainId, envName, key, providerUrl: `https://${host}/v2/${key}`, publicUrl };
}

// 공개 RPC는 체인별 viem 기본 RPC 1개다(§4.1).
const CHAINS: ChainFixture[] = [
  chainFixture(
    1,
    "ETH_MAINNET_RPC_URL",
    "eth-mainnet.rpc-provider.test",
    "ethKey0123456789abcdefghijklmnop",
    mainnet.rpcUrls.default.http[0],
  ),
  chainFixture(
    8453,
    "BASE_MAINNET_RPC_URL",
    "base-mainnet.rpc-provider.test",
    "baseKey123456789abcdefghijklmnop",
    base.rpcUrls.default.http[0],
  ),
  chainFixture(
    42161,
    "ARB_MAINNET_RPC_URL",
    "arb-mainnet.rpc-provider.test",
    "arbKey0123456789abcdefghijklmnop",
    arbitrum.rpcUrls.default.http[0],
  ),
];
const ETH = CHAINS[0];
const PUBLIC_URLS = CHAINS.map((chain) => chain.publicUrl);

const ADDRESS = "0x0000000000000000000000000000000000000001";
const TX_HASH = `0x${"ab".repeat(32)}`;

const ALLOWED_METHOD_SAMPLES: [string, unknown[]][] = [
  ["eth_chainId", []],
  ["eth_blockNumber", []],
  ["eth_getBlockByNumber", ["latest", false]],
  ["eth_call", [{ to: ADDRESS, data: "0x" }, "latest"]],
  ["eth_getBalance", [ADDRESS, "latest"]],
  ["eth_getCode", [ADDRESS, "latest"]],
  ["eth_estimateGas", [{ from: ADDRESS, to: ADDRESS, value: "0x0" }]],
  ["eth_gasPrice", []],
  ["eth_maxPriorityFeePerGas", []],
  ["eth_feeHistory", ["0x4", "latest", [25, 75]]],
  ["eth_getTransactionByHash", [TX_HASH]],
  ["eth_getTransactionReceipt", [TX_HASH]],
  ["eth_getTransactionCount", [ADDRESS, "latest"]],
];

type JsonRpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params: unknown[] };

function rpc(method: string, id: number | string = 1, params: unknown[] = []): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

function allowedBatch(size: number): JsonRpcRequest[] {
  return Array.from({ length: size }, (_, index) => {
    const [method, params] = ALLOWED_METHOD_SAMPLES[index % ALLOWED_METHOD_SAMPLES.length];
    return rpc(method, index + 1, params);
  });
}

function batchResult(batch: JsonRpcRequest[]) {
  return batch.map((item, index) => ({
    jsonrpc: "2.0",
    id: item.id,
    result: `0x${index.toString(16)}`,
  }));
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// 다중 바이트 문자(3바이트)로 채운 유효한 허용 메서드 요청 본문을 정확히 target 바이트로 만든다.
// 문자 수가 바이트 수보다 훨씬 적어서, 문자 수로 크기를 재는 구현은 판정이 어긋난다.
function jsonRpcBodyOfBytes(target: number): string {
  const build = (id: string) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "eth_blockNumber", params: [] });
  const room = target - utf8Bytes(build(""));
  const body = build("가".repeat(Math.floor(room / 3)) + "a".repeat(room % 3));
  expect(utf8Bytes(body)).toBe(target);
  expect(body.length).toBeLessThan(MAX_BODY_BYTES);
  return body;
}

function sameSiteHeaders(): Record<string, string> {
  return { host: SITE_HOST, origin: SITE_ORIGIN, "content-type": "application/json" };
}

function callProxy(
  chainId: string | number,
  body: string,
  headers: Record<string, string> = sameSiteHeaders(),
): Promise<Response> {
  const id = String(chainId);
  const request = new NextRequest(`${SITE_ORIGIN}/api/rpc/${id}`, {
    method: "POST",
    headers,
    body,
  });
  return POST(request, { params: Promise.resolve({ chainId: id }) });
}

// console은 출력 기록만 한다(mock 경계). 원래 출력은 그대로 둔다.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

function recordConsole() {
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method);
  }
}

function clearConsoleRecord() {
  for (const method of CONSOLE_METHODS) {
    vi.mocked(console[method]).mockClear();
  }
}

function loggedText(): string {
  return CONSOLE_METHODS.flatMap((method) =>
    vi
      .mocked(console[method])
      .mock.calls.flat()
      .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 20 }))),
  ).join("\n");
}

function warnCount(): number {
  return vi.mocked(console.warn).mock.calls.length;
}

function stubProviderEnv() {
  for (const chain of CHAINS) {
    vi.stubEnv(chain.envName, chain.providerUrl);
  }
}

let stub: RpcFetchStub;

// 표본 반복 사이에도 스텁, 환경 변수, console 기록을 초기화한다.
function resetSample() {
  vi.useRealTimers();
  stub.reset();
  clearConsoleRecord();
  vi.unstubAllEnvs();
  stubProviderEnv();
}

function publicCalls() {
  return stub.calls().filter((call) => PUBLIC_URLS.includes(call.url));
}

// waitUrl로 호출이 들어온 뒤 가짜 시간을 5초 직전까지, 이어서 5초까지 진행한다.
async function callAcrossTimeout(
  waitUrl: string,
  start: () => Promise<Response>,
  beforeDeadline?: () => void,
): Promise<Response> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const called = stub.nextCallTo(waitUrl);
    const pending = start();
    await called;
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    beforeDeadline?.();
    await vi.advanceTimersByTimeAsync(1);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

function expectNoProviderSecret(text: string, label: string) {
  for (const chain of CHAINS) {
    expect(text, label).not.toContain(chain.providerUrl);
    expect(text, label).not.toContain(chain.key);
  }
}

function headersText(response: Response): string {
  return [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
}

// 가린 응답의 원문 보존 판정용 표본. 2^53을 넘는 정수 리터럴은 파싱 후 다시 직렬화하면
// 원문 표기가 바뀌므로 원문 텍스트에서 찾는다.
const BIG_INT_LITERAL = "123456789012345678901234567890";
// `"__proto__"` 자체 키의 값. 객체 리터럴의 `__proto__`는 prototype 설정이 되므로
// 업체 응답 본문은 JSON 텍스트로 직접 쓴다.
const PROTO_VALUE_TEXT = '{"kept":"proto-value","n":7}';

function ownValue(target: unknown, key: string): unknown {
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

// 원문에 있던 `"__proto__"` 자체 키가 응답에서도 자체 속성으로 남고 값이 같은지 본다.
function expectOwnProtoPreserved(returned: unknown, original: unknown, label: string) {
  expect(Object.hasOwn(original as object, "__proto__"), `${label} (표본)`).toBe(true);
  expect(Object.hasOwn(returned as object, "__proto__"), label).toBe(true);
  expect(ownValue(returned, "__proto__"), label).toEqual(ownValue(original, "__proto__"));
}

beforeEach(() => {
  stub = installRpcFetchStub();
  stubProviderEnv();
  recordConsole();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("RPC 프록시 — 허용 요청을 체인별 RPC에서 처리하고 업체 URL과 키를 노출하지 않는다", () => {
  describe("허용 요청을 전달한다", () => {
    /**
     * @spec DoD-16
     * @given 세 체인(1, 8453, 42161)의 서버 전용 RPC 변수(ETH_MAINNET_RPC_URL, BASE_MAINNET_RPC_URL, ARB_MAINNET_RPC_URL)가 있고, 체인을 하나씩 반복해 허용 메서드 단일 요청을 같은 사이트에서 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then 요청한 체인의 RPC로 같은 JSON-RPC 요청을 전달한다
     * @then 다른 체인의 RPC는 호출하지 않는다
     * @then 해당 체인 RPC의 응답을 돌려준다
     */
    it("[DoD-16] 지원 체인의 요청을 그 체인의 RPC로 전달하고 응답을 돌려준다", async () => {
      for (const chain of CHAINS) {
        resetSample();
        const label = `chain ${chain.chainId}`;
        const request = rpc("eth_blockNumber", 1);
        const upstream = { jsonrpc: "2.0", id: 1, result: `0x${chain.chainId.toString(16)}` };
        stub.route(chain.providerUrl, reply.json(upstream));

        const response = await callProxy(chain.chainId, JSON.stringify(request));

        expect(
          stub.calls().map((call) => call.url),
          label,
        ).toEqual([chain.providerUrl]);
        expect(JSON.parse(stub.callsTo(chain.providerUrl)[0].body), label).toEqual(request);
        expect(await response.json(), label).toEqual(upstream);
      }
    });

    /**
     * @spec DoD-16
     * @given 허용 메서드 13개(eth_chainId, eth_blockNumber, eth_getBlockByNumber, eth_call, eth_getBalance, eth_getCode, eth_estimateGas, eth_gasPrice, eth_maxPriorityFeePerGas, eth_feeHistory, eth_getTransactionByHash, eth_getTransactionReceipt, eth_getTransactionCount)를 하나씩 반복해 단일 요청으로 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then 해당 체인의 RPC로 요청을 전달한다
     * @then RPC의 응답을 돌려준다
     */
    it("[DoD-16] 허용 메서드 전체를 전달하고 응답을 돌려준다", async () => {
      expect(ALLOWED_METHOD_SAMPLES).toHaveLength(13);
      for (const [method, params] of ALLOWED_METHOD_SAMPLES) {
        resetSample();
        const request = rpc(method, 1, params);
        const upstream = { jsonrpc: "2.0", id: 1, result: `result-of-${method}` };
        stub.route(ETH.providerUrl, reply.json(upstream));

        const response = await callProxy(ETH.chainId, JSON.stringify(request));

        expect(
          stub.calls().map((call) => call.url),
          method,
        ).toEqual([ETH.providerUrl]);
        expect(JSON.parse(stub.callsTo(ETH.providerUrl)[0].body), method).toEqual(request);
        expect(await response.json(), method).toEqual(upstream);
      }
    });

    /**
     * @spec DoD-16
     * @given 허용 메서드로만 이루어진 배치를 표본(2개, 상한인 50개)별로 하나씩 반복해 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then 배치를 해당 체인의 RPC로 전달한다
     * @then RPC의 배치 응답을 돌려준다
     */
    it("[DoD-16] 50개 이하의 허용 메서드 배치를 전달하고 응답을 돌려준다", async () => {
      for (const size of [2, MAX_BATCH_SIZE]) {
        resetSample();
        const label = `batch ${size}`;
        const batch = allowedBatch(size);
        const upstream = batchResult(batch);
        stub.route(ETH.providerUrl, reply.json(upstream));

        const response = await callProxy(ETH.chainId, JSON.stringify(batch));

        expect(
          stub.calls().map((call) => call.url),
          label,
        ).toEqual([ETH.providerUrl]);
        expect(JSON.parse(stub.callsTo(ETH.providerUrl)[0].body), label).toEqual(batch);
        expect(await response.json(), label).toEqual(upstream);
      }
    });

    /**
     * @spec DoD-16 EC-8
     * @given 정확히 1,048,576바이트인 유효한 허용 메서드 요청 본문을 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then 해당 체인의 RPC로 요청을 전달한다
     * @then RPC의 응답을 돌려준다
     */
    it("[DoD-16][EC-8] 본문이 정확히 1,048,576바이트면 거절하지 않고 전달한다", async () => {
      const body = jsonRpcBodyOfBytes(MAX_BODY_BYTES);
      const upstream = { jsonrpc: "2.0", id: JSON.parse(body).id, result: "0x10" };
      stub.route(ETH.providerUrl, reply.json(upstream));

      const response = await callProxy(ETH.chainId, body);

      expect(stub.calls().map((call) => call.url)).toEqual([ETH.providerUrl]);
      expect(stub.callsTo(ETH.providerUrl)[0].body).toBe(body);
      expect(await response.json()).toEqual(upstream);
    });

    /**
     * @spec DoD-16
     * @given 같은 사이트 표본(Origin이 Host와 일치, Host는 다르지만 Origin이 X-Forwarded-Host와 일치)을 하나씩 반복해 허용 메서드 요청을 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then 해당 체인의 RPC로 요청을 전달한다
     * @then RPC의 응답을 돌려준다
     */
    it("[DoD-16] Origin이 Host 또는 X-Forwarded-Host와 일치하면 같은 사이트로 보고 전달한다", async () => {
      const samples: [string, Record<string, string>][] = [
        ["Origin = Host", sameSiteHeaders()],
        [
          "Origin = X-Forwarded-Host",
          {
            host: "10.0.0.5:3000",
            "x-forwarded-host": SITE_HOST,
            origin: SITE_ORIGIN,
            "content-type": "application/json",
          },
        ],
      ];
      for (const [label, headers] of samples) {
        resetSample();
        const request = rpc("eth_chainId", 1);
        const upstream = { jsonrpc: "2.0", id: 1, result: "0x1" };
        stub.route(ETH.providerUrl, reply.json(upstream));

        const response = await callProxy(ETH.chainId, JSON.stringify(request), headers);

        expect(
          stub.calls().map((call) => call.url),
          label,
        ).toEqual([ETH.providerUrl]);
        expect(JSON.parse(stub.callsTo(ETH.providerUrl)[0].body), label).toEqual(request);
        expect(await response.json(), label).toEqual(upstream);
      }
    });
  });

  describe("거절 조건에 해당하는 요청은 업체로 전달하지 않는다", () => {
    /**
     * @spec EC-8
     * @given 지원하지 않는 chainId 표본(11155111, 84532, abc, 1abc, 0x1)을 하나씩 반복해 그 외에는 유효한 요청을 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 404를 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 지원하지 않는 chainId는 404를 돌려주고 업체로 전달하지 않는다", async () => {
      for (const chainId of ["11155111", "84532", "abc", "1abc", "0x1"]) {
        resetSample();

        const response = await callProxy(chainId, JSON.stringify(rpc("eth_blockNumber")));

        expect(response.status, chainId).toBe(404);
        expect(stub.calls(), chainId).toHaveLength(0);
      }
    });

    /**
     * @spec EC-8
     * @given Origin 표본(Origin 없음, Host·X-Forwarded-Host와 모두 다른 사이트의 Origin, 같은 사이트 호스트를 부분 문자열로 포함한 Origin(https://app.example.com.evil.test 형태), 같은 사이트 호스트로 끝나는 다른 도메인 Origin(https://evilapp.example.com 형태), 포트가 다른 Origin, null Origin, 형식 오류 Origin)을 하나씩 반복해 그 외에는 유효한 요청을 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 403을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 다른 사이트의 요청과 Origin 없는 요청은 403을 돌려주고 업체로 전달하지 않는다", async () => {
      const origins: (string | undefined)[] = [
        undefined,
        "https://other-site.test",
        "https://app.example.com.evil.test",
        "https://evilapp.example.com",
        "https://app.example.com:8443",
        "null",
        "app.example.com",
      ];
      for (const origin of origins) {
        resetSample();
        const label = `origin ${String(origin)}`;
        const headers: Record<string, string> = {
          host: SITE_HOST,
          "x-forwarded-host": SITE_HOST,
          "content-type": "application/json",
        };
        if (origin !== undefined) {
          headers.origin = origin;
        }

        const response = await callProxy(
          ETH.chainId,
          JSON.stringify(rpc("eth_blockNumber")),
          headers,
        );

        expect(response.status, label).toBe(403);
        expect(stub.calls(), label).toHaveLength(0);
      }
    });

    /**
     * @spec EC-8
     * @given 1,048,577바이트 본문 표본(Content-Length가 초과를 신고, Content-Length 없음, Content-Length를 1,048,576 이하로 신고했지만 실제 본문이 초과)을 하나씩 반복해 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 413을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 본문이 1MB를 초과하면 413을 돌려주고 업체로 전달하지 않는다", async () => {
      const body = jsonRpcBodyOfBytes(MAX_BODY_BYTES + 1);
      const declaredLengths: (string | undefined)[] = [
        String(MAX_BODY_BYTES + 1),
        undefined,
        String(MAX_BODY_BYTES),
      ];
      for (const declared of declaredLengths) {
        resetSample();
        const label = `content-length ${String(declared)}`;
        const headers = sameSiteHeaders();
        if (declared !== undefined) {
          headers["content-length"] = declared;
        }

        const response = await callProxy(ETH.chainId, body, headers);

        expect(response.status, label).toBe(413);
        expect(stub.calls(), label).toHaveLength(0);
      }
    });

    /**
     * @spec EC-8
     * @given 허용 메서드로만 이루어진 51개 배치를 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 400을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 배치가 50개를 초과하면 400을 돌려주고 업체로 전달하지 않는다", async () => {
      const response = await callProxy(
        ETH.chainId,
        JSON.stringify(allowedBatch(MAX_BATCH_SIZE + 1)),
      );

      expect(response.status).toBe(400);
      expect(stub.calls()).toHaveLength(0);
    });

    /**
     * @spec EC-8
     * @given JSON 입력 표본(JSON 형식 오류, {}, [], method 없는 객체, null, 123, [1], [null], [{"id":1}], [{}], [유효 요청, {}], [허용 외 메서드 요청, {}])을 하나씩 반복해 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 400을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] JSON 형식 오류와 JSON-RPC가 아닌 입력은 400을 돌려주고 업체로 전달하지 않는다", async () => {
      const bodies = [
        '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"',
        "{}",
        "[]",
        JSON.stringify({ jsonrpc: "2.0", id: 1, params: [] }),
        "null",
        "123",
        "[1]",
        "[null]",
        '[{"id":1}]',
        "[{}]",
        JSON.stringify([rpc("eth_blockNumber", 1), {}]),
        JSON.stringify([rpc("eth_sendRawTransaction", 1, ["0x00"]), {}]),
      ];
      for (const body of bodies) {
        resetSample();

        const response = await callProxy(ETH.chainId, body);

        expect(response.status, body).toBe(400);
        expect(stub.calls(), body).toHaveLength(0);
      }
    });

    /**
     * @spec EC-8
     * @given 허용 외 메서드 표본(eth_sendRawTransaction, eth_sendTransaction, eth_getLogs, debug_traceTransaction)을 하나씩 반복해 단일 요청으로 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 200을 돌려준다
     * @then JSON-RPC 오류 코드 -32601을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 허용 외 메서드 단일 요청은 200과 -32601을 돌려주고 업체로 전달하지 않는다", async () => {
      const samples: [string, unknown[]][] = [
        ["eth_sendRawTransaction", ["0x00"]],
        ["eth_sendTransaction", [{ from: ADDRESS, to: ADDRESS, value: "0x0" }]],
        ["eth_getLogs", [{ fromBlock: "latest", toBlock: "latest" }]],
        ["debug_traceTransaction", [TX_HASH]],
      ];
      for (const [method, params] of samples) {
        resetSample();

        const response = await callProxy(ETH.chainId, JSON.stringify(rpc(method, 1, params)));

        expect(response.status, method).toBe(200);
        const json = await response.json();
        expect(Array.isArray(json), method).toBe(false);
        expect(json.error?.code, method).toBe(-32601);
        expect(stub.calls(), method).toHaveLength(0);
      }
    });

    /**
     * @spec EC-8
     * @given 허용 외 메서드가 하나 포함된 배치를 표본(맨 앞, 중간, 맨 뒤에 포함)별로 하나씩 반복해 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 200을 돌려준다
     * @then 배치 전체를 거절하고 코드 -32601의 JSON-RPC 오류 객체 하나를 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 허용 외 메서드가 포함된 배치는 전체를 거절하고 오류 객체 하나를 돌려준다", async () => {
      const disallowed = rpc("eth_sendRawTransaction", 99, ["0x00"]);
      const allowed = [rpc("eth_blockNumber", 1), rpc("eth_chainId", 2)];
      const samples: [string, JsonRpcRequest[]][] = [
        ["맨 앞", [disallowed, ...allowed]],
        ["중간", [allowed[0], disallowed, allowed[1]]],
        ["맨 뒤", [...allowed, disallowed]],
      ];
      for (const [label, batch] of samples) {
        resetSample();

        const response = await callProxy(ETH.chainId, JSON.stringify(batch));

        expect(response.status, label).toBe(200);
        const json = await response.json();
        expect(Array.isArray(json), label).toBe(false);
        expect(typeof json, label).toBe("object");
        expect(json.error?.code, label).toBe(-32601);
        expect(stub.calls(), label).toHaveLength(0);
      }
    });
  });

  describe("거절 조건이 겹치면 chainId, Origin, 크기, JSON 형식, 배치 개수, 메서드 순서로 판정한다", () => {
    const noOriginHeaders = () => ({ host: SITE_HOST, "content-type": "application/json" });

    /**
     * @spec EC-8
     * @given 지원하지 않는 chainId에 Origin 없음과 1MB 초과 본문을 함께 담아 요청한다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 404를 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] chainId 판정이 Origin 판정보다 먼저다", async () => {
      const response = await callProxy(
        "11155111",
        jsonRpcBodyOfBytes(MAX_BODY_BYTES + 1),
        noOriginHeaders(),
      );

      expect(response.status).toBe(404);
      expect(stub.calls()).toHaveLength(0);
    });

    /**
     * @spec EC-8
     * @given 지원 chainId에 Origin 없음과 1MB 초과 본문을 함께 담아 요청한다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 403을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] Origin 판정이 크기 판정보다 먼저다", async () => {
      const response = await callProxy(
        ETH.chainId,
        jsonRpcBodyOfBytes(MAX_BODY_BYTES + 1),
        noOriginHeaders(),
      );

      expect(response.status).toBe(403);
      expect(stub.calls()).toHaveLength(0);
    });

    /**
     * @spec EC-8
     * @given 같은 사이트에서 JSON 형식이 잘못된 1MB 초과 본문을 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 413을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 크기 판정이 JSON 형식 판정보다 먼저다", async () => {
      const malformed = `{"jsonrpc":"2.0","id":"${"a".repeat(MAX_BODY_BYTES)}`;
      expect(utf8Bytes(malformed)).toBeGreaterThan(MAX_BODY_BYTES);

      const response = await callProxy(ETH.chainId, malformed);

      expect(response.status).toBe(413);
      expect(stub.calls()).toHaveLength(0);
    });

    /**
     * @spec EC-8
     * @given 같은 사이트에서 허용 외 메서드가 포함된 51개 배치를 보낸다
     * @when POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 400을 돌려준다
     * @then 외부 RPC 호출이 0회다
     */
    it("[EC-8] 배치 개수 판정이 메서드 판정보다 먼저다", async () => {
      const batch = [...allowedBatch(MAX_BATCH_SIZE), rpc("eth_sendRawTransaction", 999, ["0x00"])];
      expect(batch).toHaveLength(MAX_BATCH_SIZE + 1);

      const response = await callProxy(ETH.chainId, JSON.stringify(batch));

      expect(response.status).toBe(400);
      expect(stub.calls()).toHaveLength(0);
    });
  });

  describe("업체 RPC를 쓸 수 없으면 공개 RPC로 넘긴다", () => {
    /**
     * @spec EC-9 EC-13
     * @given 세 체인(1, 8453, 42161)마다 업체 RPC 실패 표본(네트워크 오류, 시간 초과(5초 제한 안에 응답 없음, 응답 헤더 후 본문이 5초 제한 안에 오지 않음), HTTP 4xx, HTTP 5xx, JSON-RPC 오류 본문을 담은 HTTP 4xx·5xx, JSON이 아닌 응답)을 하나씩 반복하고 해당 체인의 공개 RPC는 정상 응답한다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then 시간 초과 표본에서는 5초가 되기 전에는 공개 RPC 호출이 0회다
     * @then 시간 초과 표본에서는 5초가 지나면 해당 체인의 공개 RPC로 넘긴다
     * @then 해당 체인의 공개 RPC로 같은 JSON-RPC 요청을 보낸다
     * @then 해당 체인의 공개 RPC의 응답을 돌려준다
     * @then 서버 로그에 경고를 남긴다
     */
    it("[EC-9][EC-13] 업체 RPC가 실패하면 해당 체인의 공개 RPC로 넘겨 응답을 돌려주고 경고를 남긴다", async () => {
      const failures: { label: string; handler: StubHandler; timeout?: true }[] = [
        { label: "네트워크 오류", handler: reply.networkError() },
        { label: "시간 초과: 응답 없음", handler: reply.hang(), timeout: true },
        { label: "시간 초과: 본문 지연", handler: reply.stallBody(), timeout: true },
        { label: "HTTP 4xx", handler: reply.text("Too Many Requests", 429) },
        { label: "HTTP 5xx", handler: reply.text("Service Unavailable", 503) },
        {
          label: "JSON-RPC 오류 본문 HTTP 4xx",
          handler: reply.json(
            { jsonrpc: "2.0", id: 7, error: { code: -32005, message: "limit exceeded" } },
            { status: 429 },
          ),
        },
        {
          label: "JSON-RPC 오류 본문 HTTP 5xx",
          handler: reply.json(
            { jsonrpc: "2.0", id: 7, error: { code: -32603, message: "internal error" } },
            { status: 500 },
          ),
        },
        {
          label: "JSON이 아닌 응답",
          handler: reply.text("<html>bad gateway</html>", 200, "text/html"),
        },
      ];
      for (const chain of CHAINS) {
        for (const failure of failures) {
          resetSample();
          const label = `chain ${chain.chainId} / ${failure.label}`;
          const request = rpc("eth_blockNumber", 7);
          const publicPayload = { jsonrpc: "2.0", id: 7, result: "0x1234" };
          stub.route(chain.providerUrl, failure.handler);
          stub.route(chain.publicUrl, reply.json(publicPayload));
          const start = () => callProxy(chain.chainId, JSON.stringify(request));

          const response = failure.timeout
            ? await callAcrossTimeout(chain.providerUrl, start, () => {
                expect(publicCalls(), label).toHaveLength(0);
              })
            : await start();

          expect(
            publicCalls().map((call) => call.url),
            label,
          ).toEqual([chain.publicUrl]);
          expect(JSON.parse(stub.callsTo(chain.publicUrl)[0].body), label).toEqual(request);
          expect(await response.json(), label).toEqual(publicPayload);
          expect(warnCount(), label).toBeGreaterThan(0);
        }
      }
    });

    /**
     * @spec EC-9 EC-13
     * @given 세 체인(1, 8453, 42161)마다 해당 체인의 서버 전용 RPC 변수 표본(없음, 빈 문자열)을 하나씩 반복하고 공개 RPC는 정상 응답한다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then 해당 체인의 viem 기본 RPC로 요청을 보낸다
     * @then 공개 RPC의 응답을 돌려준다
     * @then 서버 로그에 경고를 남기지 않는다
     */
    it("[EC-9][EC-13] 환경 변수가 없거나 비어 있으면 해당 체인의 공개 RPC로 넘기고 경고를 남기지 않는다", async () => {
      for (const chain of CHAINS) {
        for (const value of [undefined, ""]) {
          resetSample();
          const label = `chain ${chain.chainId} / env ${value === undefined ? "없음" : "빈 문자열"}`;
          vi.stubEnv(chain.envName, value);
          const request = rpc("eth_blockNumber", 3);
          const publicPayload = { jsonrpc: "2.0", id: 3, result: "0xabc" };
          stub.route(chain.publicUrl, reply.json(publicPayload));

          const response = await callProxy(chain.chainId, JSON.stringify(request));

          expect(
            stub.calls().map((call) => call.url),
            label,
          ).toEqual([chain.publicUrl]);
          expect(JSON.parse(stub.callsTo(chain.publicUrl)[0].body), label).toEqual(request);
          expect(await response.json(), label).toEqual(publicPayload);
          expect(warnCount(), label).toBe(0);
        }
      }
    });
  });

  describe("JSON-RPC 오류는 RPC의 정상 응답으로 돌려준다", () => {
    /**
     * @spec EC-10
     * @given 업체 RPC가 업체 URL·키가 없는 revert 같은 JSON-RPC 오류를 표본(단일 응답, 일부 항목만 오류인 배치 응답)별로 하나씩 반복해 돌려준다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then 업체 RPC의 JSON-RPC 오류를 그대로 돌려준다
     * @then 공개 RPC 호출이 0회다
     */
    it("[EC-10] JSON-RPC 오류는 fallback 없이 그대로 돌려준다", async () => {
      const revert = {
        code: 3,
        message: "execution reverted: Too little received",
        data: "0x08c379a0",
      };
      const callRequest = rpc("eth_call", 1, [{ to: ADDRESS, data: "0x" }, "latest"]);
      const samples: [string, unknown, unknown][] = [
        ["단일 응답", callRequest, { jsonrpc: "2.0", id: 1, error: revert }],
        [
          "일부 항목만 오류인 배치 응답",
          [callRequest, rpc("eth_blockNumber", 2)],
          [
            { jsonrpc: "2.0", id: 1, error: revert },
            { jsonrpc: "2.0", id: 2, result: "0x10" },
          ],
        ],
      ];
      for (const [label, request, upstream] of samples) {
        resetSample();
        stub.route(ETH.providerUrl, reply.json(upstream));
        stub.route(ETH.publicUrl, reply.json({ jsonrpc: "2.0", id: 1, result: "0xpublic" }));

        const response = await callProxy(ETH.chainId, JSON.stringify(request));

        expect(await response.json(), label).toEqual(upstream);
        expect(publicCalls(), label).toHaveLength(0);
      }
    });

    /**
     * @spec EC-10 EC-12
     * @given 업체 RPC가 위치 표본(error.message, error.data)에 값 표본(업체 URL 전체, 키만)을 담은 JSON-RPC 오류를 응답 표본(단일 응답, 일부 항목만 오류인 배치 응답)별로 하나씩 반복해 돌려준다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then 응답에 업체 URL과 키가 나오지 않는다
     * @then 오류 코드와 가린 값을 뺀 나머지 내용은 그대로 돌려준다
     * @then 공개 RPC 호출이 0회다
     * @then 서버 로그에 업체 URL과 키가 나오지 않는다
     */
    it("[EC-10][EC-12] JSON-RPC 오류의 업체 URL과 키만 가리고 fallback 없이 돌려준다", async () => {
      const prefix = "upstream rejected request via ";
      const suffix = " (see provider docs)";
      const baseError = { code: 3, message: "execution reverted", data: "0x08c379a0" };
      const okItem = { jsonrpc: "2.0", id: 2, result: "0x10" };
      const callRequest = rpc("eth_call", 1, [{ to: ADDRESS, data: "0x" }, "latest"]);

      for (const position of ["message", "data"] as const) {
        for (const [valueLabel, secret] of [
          ["URL 전체", ETH.providerUrl],
          ["키만", ETH.key],
        ] as const) {
          for (const shape of ["single", "batch"] as const) {
            resetSample();
            const label = `${position} / ${valueLabel} / ${shape}`;
            const error = { ...baseError, [position]: `${prefix}${secret}${suffix}` };
            // 가릴 값과 함께 `"__proto__"` 자체 키와 2^53을 넘는 정수 리터럴을 담은 원문 텍스트다.
            const errorText =
              `{"code":${error.code},"message":${JSON.stringify(error.message)},` +
              `"data":${JSON.stringify(error.data)},"__proto__":${PROTO_VALUE_TEXT},` +
              `"gasUsed":${BIG_INT_LITERAL}}`;
            const errorItemText = `{"jsonrpc":"2.0","id":1,"error":${errorText}}`;
            const upstreamText =
              shape === "single" ? errorItemText : `[${errorItemText},${JSON.stringify(okItem)}]`;
            const upstreamError = JSON.parse(errorItemText).error;
            const request =
              shape === "single" ? callRequest : [callRequest, rpc("eth_blockNumber", 2)];
            stub.route(ETH.providerUrl, reply.text(upstreamText, 200, "application/json"));
            stub.route(ETH.publicUrl, reply.json({ jsonrpc: "2.0", id: 1, result: "0xpublic" }));

            const response = await callProxy(ETH.chainId, JSON.stringify(request));
            const text = await response.text();

            expectNoProviderSecret(text, label);
            expect(text, label).toContain(BIG_INT_LITERAL);
            const json = JSON.parse(text);
            const returnedError = shape === "single" ? json : json[0];
            if (shape === "batch") {
              expect(json, label).toHaveLength(2);
              expect(json[1], label).toEqual(okItem);
            }
            expect(returnedError.jsonrpc, label).toBe("2.0");
            expect(returnedError.id, label).toBe(1);
            expect(Object.keys(returnedError.error).sort(), label).toEqual(
              Object.keys(upstreamError).sort(),
            );
            expect(returnedError.error.code, label).toBe(baseError.code);
            const untouched = position === "message" ? "data" : "message";
            expect(returnedError.error[untouched], label).toBe(baseError[untouched]);
            const masked: unknown = returnedError.error[position];
            expect(typeof masked, label).toBe("string");
            expect(masked as string, label).toMatch(
              new RegExp(`^${escapeRegExp(prefix)}.*${escapeRegExp(suffix)}$`),
            );
            expectOwnProtoPreserved(returnedError.error, upstreamError, label);
            expect(returnedError.error.gasUsed, label).toBe(upstreamError.gasUsed);
            expect(publicCalls(), label).toHaveLength(0);
            expectNoProviderSecret(loggedText(), label);
          }
        }
      }
    });

    /**
     * @spec EC-10
     * @given 업체 실패 또는 환경 변수 없음으로 공개 RPC로 넘어갔고 공개 RPC가 JSON-RPC 오류를 돌려준다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then 공개 RPC의 JSON-RPC 오류를 그대로 돌려준다
     * @then HTTP 502를 돌려주지 않는다
     */
    it("[EC-10] 공개 RPC의 JSON-RPC 오류도 그대로 돌려주고 502로 바꾸지 않는다", async () => {
      const publicError = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: 3, message: "execution reverted", data: "0x" },
      };
      for (const mode of ["업체 실패", "환경 변수 없음"] as const) {
        resetSample();
        if (mode === "업체 실패") {
          stub.route(ETH.providerUrl, reply.text("Service Unavailable", 503));
        } else {
          vi.stubEnv(ETH.envName, undefined);
        }
        stub.route(ETH.publicUrl, reply.json(publicError));

        const response = await callProxy(
          ETH.chainId,
          JSON.stringify(rpc("eth_call", 1, [{ to: ADDRESS, data: "0x" }, "latest"])),
        );

        expect(stub.callsTo(ETH.publicUrl), mode).toHaveLength(1);
        expect(response.status, mode).not.toBe(502);
        expect(await response.json(), mode).toEqual(publicError);
      }
    });
  });

  describe("모든 RPC가 실패하면 실패를 알린다", () => {
    /**
     * @spec EC-11
     * @given 업체 RPC 실패 또는 환경 변수 없음에 더해 공개 RPC 실패 표본(네트워크 오류, 5초 시간 제한 안에 응답 없음, HTTP 4xx, HTTP 5xx, JSON이 아닌 응답)을 하나씩 반복한다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then HTTP 502를 돌려준다
     * @then 시간 초과 표본에서는 공개 RPC 시간 제한 5초가 지나면 502를 돌려준다
     */
    it("[EC-11] 업체 RPC와 공개 RPC가 모두 실패하면 502를 돌려준다", async () => {
      const publicFailures: { label: string; handler: StubHandler; timeout?: true }[] = [
        { label: "네트워크 오류", handler: reply.networkError() },
        { label: "시간 초과: 응답 없음", handler: reply.hang(), timeout: true },
        { label: "시간 초과: 본문 지연", handler: reply.stallBody(), timeout: true },
        { label: "HTTP 4xx", handler: reply.text("Too Many Requests", 429) },
        { label: "HTTP 5xx", handler: reply.text("Service Unavailable", 503) },
        {
          label: "JSON이 아닌 응답",
          handler: reply.text("<html>bad gateway</html>", 200, "text/html"),
        },
      ];
      for (const mode of ["업체 실패", "환경 변수 없음"] as const) {
        for (const failure of publicFailures) {
          resetSample();
          const label = `${mode} / 공개 RPC ${failure.label}`;
          if (mode === "업체 실패") {
            stub.route(ETH.providerUrl, reply.text("Internal Server Error", 500));
          } else {
            vi.stubEnv(ETH.envName, undefined);
          }
          stub.route(ETH.publicUrl, failure.handler);
          const start = () => callProxy(ETH.chainId, JSON.stringify(rpc("eth_blockNumber")));

          const response = failure.timeout
            ? await callAcrossTimeout(ETH.publicUrl, start)
            : await start();

          expect(stub.callsTo(ETH.publicUrl), label).toHaveLength(1);
          expect(response.status, label).toBe(502);
        }
      }
    });
  });

  describe("업체 URL과 키를 노출하지 않는다", () => {
    /**
     * @spec EC-12
     * @given 키가 포함된 식별 가능한 업체 URL을 환경 변수로 두고 경로 표본(전달 성공, 업체 URL·키를 메시지에 담은 네트워크 오류 후 fallback, 업체 URL·키를 본문에 담은 HTTP 5xx 후 fallback, 시간 초과 후 fallback, 모든 RPC 실패)을 하나씩 반복한다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then 응답 본문과 헤더에 업체 URL과 키가 나오지 않는다
     * @then 오류 메시지에 업체 URL과 키가 나오지 않는다
     * @then 서버 로그에 업체 URL과 키가 나오지 않는다
     */
    it("[EC-12] 응답, 오류 메시지, 로그에 업체 URL과 키가 나오지 않는다", async () => {
      const okPayload = { jsonrpc: "2.0", id: 1, result: "0x10" };
      // 업체 URL 모양 표본. secretForms는 응답·오류 메시지·로그에 나오면 안 되는 형태다.
      const subdomainKey = "subdomainkey0123456789abcdefghij";
      const urlShapes: { label: string; url: string; key: string; hostForm: string }[] = [
        {
          label: "경로에 키",
          url: ETH.providerUrl,
          key: ETH.key,
          hostForm: ETH.providerUrl.replace(/^https:\/\//, ""),
        },
        {
          label: "서브도메인에 키",
          url: `https://${subdomainKey}.provider.test/`,
          key: subdomainKey,
          hostForm: `${subdomainKey}.provider.test`,
        },
      ];
      for (const shape of urlShapes) {
        const secretForms = [shape.url, shape.key, shape.hostForm];
        const expectNoShapeSecret = (text: string, label: string) => {
          expectNoProviderSecret(text, label);
          for (const secret of secretForms) {
            expect(text, label).not.toContain(secret);
          }
        };
        const networkErrorWithSecret = reply.networkError(
          `request to ${shape.url} failed`,
          new Error(
            `connect ECONNREFUSED ${shape.url} (key ${shape.key}); getaddrinfo ENOTFOUND ${shape.hostForm}`,
          ),
        );
        const paths: {
          label: string;
          provider: StubHandler;
          publicHandler: StubHandler;
          timeout?: true;
        }[] = [
          {
            label: "전달 성공",
            provider: reply.json(okPayload, {
              headers: {
                "x-upstream-endpoint": shape.url,
                "x-upstream-host": shape.hostForm,
                "x-api-key": shape.key,
              },
            }),
            publicHandler: reply.json(okPayload),
          },
          {
            // 업체 응답 result 안에 업체 URL과 scheme 없는 호스트 형태가 들어 있다.
            label: "전달 성공: result에 업체 URL과 호스트 형태",
            provider: reply.json({
              jsonrpc: "2.0",
              id: 1,
              result: { endpoint: shape.url, note: `served by ${shape.hostForm}` },
            }),
            publicHandler: reply.json(okPayload),
          },
          {
            // 업체 응답 result 안에 URL 전체가 아닌 키만 들어 있다(문자열 값).
            label: "전달 성공: result 문자열에 키만",
            provider: reply.json({ jsonrpc: "2.0", id: 1, result: `session ${shape.key} active` }),
            publicHandler: reply.json(okPayload),
          },
          {
            // 업체 응답 result 안에 URL 전체가 아닌 키만 들어 있다(중첩 객체·배열 값).
            label: "전달 성공: result 중첩 값에 키만",
            provider: reply.json({
              jsonrpc: "2.0",
              id: 1,
              result: { number: "0x10", extra: { token: shape.key, tags: [`k:${shape.key}`] } },
            }),
            publicHandler: reply.json(okPayload),
          },
          {
            label: "네트워크 오류 후 fallback",
            provider: networkErrorWithSecret,
            publicHandler: reply.json(okPayload),
          },
          {
            label: "HTTP 5xx 후 fallback",
            provider: reply.text(
              `upstream error at ${shape.url} (${shape.hostForm}) for key ${shape.key}`,
              502,
            ),
            publicHandler: reply.json(okPayload),
          },
          {
            label: "시간 초과 후 fallback",
            provider: reply.hang(),
            publicHandler: reply.json(okPayload),
            timeout: true,
          },
          {
            label: "모든 RPC 실패",
            provider: networkErrorWithSecret,
            publicHandler: reply.text("Service Unavailable", 503),
          },
        ];
        for (const path of paths) {
          resetSample();
          vi.stubEnv(ETH.envName, shape.url);
          const label = `${shape.label} / ${path.label}`;
          stub.route(shape.url, path.provider);
          stub.route(ETH.publicUrl, path.publicHandler);
          const start = () => callProxy(ETH.chainId, JSON.stringify(rpc("eth_blockNumber")));

          const response = path.timeout ? await callAcrossTimeout(shape.url, start) : await start();
          const text = await response.text();

          expect(stub.callsTo(shape.url), label).toHaveLength(1);
          expectNoShapeSecret(text, label);
          expectNoShapeSecret(headersText(response), label);
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
          const errorMessage =
            typeof parsed === "object" && parsed !== null && "error" in parsed
              ? JSON.stringify((parsed as { error: unknown }).error)
              : "";
          expectNoShapeSecret(errorMessage, label);
          expectNoShapeSecret(loggedText(), label);
        }
      }
    });

    /**
     * @spec EC-12
     * @given 업체가 HTTP 200으로 업체 URL과 키를 담은 JSON-RPC가 아닌 JSON을 준다
     * @when 허용 요청으로 POST /api/rpc/[chainId]를 호출한다
     * @then 그 JSON에서 업체 URL과 키만 가려 돌려준다
     * @then 공개 RPC 호출이 0회다
     * @then 응답과 서버 로그에 업체 URL과 키가 없다
     */
    it("[EC-12] 업체의 HTTP 200 비 JSON-RPC JSON은 업체 URL과 키만 가려 돌려준다", async () => {
      // 가릴 값과 함께 `"__proto__"` 자체 키와 2^53을 넘는 정수 리터럴을 담은 원문 텍스트다.
      const upstreamText =
        `{"status":"degraded","endpoint":${JSON.stringify(ETH.providerUrl)},` +
        `"notice":${JSON.stringify(`rotate key ${ETH.key} soon`)},` +
        `"details":{"hint":${JSON.stringify(`see ${ETH.providerUrl}/status`)},"region":"us-east"},` +
        `"__proto__":${PROTO_VALUE_TEXT},"supply":${BIG_INT_LITERAL},"retry":3}`;
      const upstream = JSON.parse(upstreamText);
      stub.route(ETH.providerUrl, reply.text(upstreamText, 200, "application/json"));
      stub.route(ETH.publicUrl, reply.json({ jsonrpc: "2.0", id: 1, result: "0xpublic" }));

      const response = await callProxy(ETH.chainId, JSON.stringify(rpc("eth_blockNumber")));
      const text = await response.text();

      expectNoProviderSecret(text, "응답");
      expect(text).toContain(BIG_INT_LITERAL);
      const json = JSON.parse(text);
      expect(Object.keys(json).sort()).toEqual(Object.keys(upstream).sort());
      expect(json.status).toBe(upstream.status);
      expect(json.retry).toBe(upstream.retry);
      expect(json.supply).toBe(upstream.supply);
      expectOwnProtoPreserved(json, upstream, "응답");
      expect(typeof json.endpoint).toBe("string");
      expect(json.notice).toMatch(/^rotate key .* soon$/);
      expect(Object.keys(json.details).sort()).toEqual(Object.keys(upstream.details).sort());
      expect(json.details.region).toBe(upstream.details.region);
      expect(json.details.hint).toMatch(/^see .*\/status$/);
      expect(publicCalls()).toHaveLength(0);
      expectNoProviderSecret(loggedText(), "로그");

      // 원문 텍스트 치환만으로는 가려지지 않을 수 있는 응답 원문 표본이다.
      // 원문 보존(큰 정수 리터럴, `__proto__` 자체 키)은 `\/` 표본에서만 판정한다.
      // 나머지 표본은 다시 직렬화해 가려도 된다.
      const escapedSlashUrl = JSON.stringify(ETH.providerUrl).slice(1, -1).replaceAll("/", "\\/");
      const keyCharCode = ETH.key.charCodeAt(3).toString(16).padStart(4, "0");
      const unicodeKey = `${ETH.key.slice(0, 3)}\\u${keyCharCode}${ETH.key.slice(4)}`;
      const hardSamples: {
        label: string;
        text: string;
        rawForms: string[];
        kept: Record<string, unknown>;
        preserve?: true;
      }[] = [
        {
          label: "같은 키가 두 번 나오고 앞의 값에 키",
          text:
            `{"status":"degraded","note":${JSON.stringify(`rotate key ${ETH.key} soon`)},` +
            `"note":"ok","endpoint":${JSON.stringify(ETH.providerUrl)},` +
            `"endpoint":"https://status.example.test/"}`,
          rawForms: [],
          kept: { status: "degraded", note: "ok", endpoint: "https://status.example.test/" },
        },
        {
          label: "\\u 이스케이프로 섞인 키",
          text:
            `{"status":"degraded","notice":"rotate key ${unicodeKey} soon",` +
            `"endpoint":"${ETH.providerUrl.replace(ETH.key, unicodeKey)}"}`,
          rawForms: [unicodeKey],
          kept: { status: "degraded" },
        },
        {
          label: "\\/ 이스케이프 형태의 업체 URL",
          text:
            `{"status":"degraded","endpoint":"${escapedSlashUrl}",` +
            `"hint":"see ${escapedSlashUrl}\\/status","__proto__":${PROTO_VALUE_TEXT},` +
            `"supply":${BIG_INT_LITERAL}}`,
          rawForms: [escapedSlashUrl],
          kept: { status: "degraded" },
          preserve: true,
        },
        {
          label: "객체 키 이름에 키",
          text:
            `{"status":"degraded",${JSON.stringify(ETH.key)}:"session",` +
            `"endpoints":{${JSON.stringify(ETH.providerUrl)}:1}}`,
          rawForms: [],
          kept: { status: "degraded" },
        },
      ];
      for (const sample of hardSamples) {
        resetSample();
        const label = sample.label;
        const original = JSON.parse(sample.text);
        const originalStrings = jsonStringsAndKeys(original).join("\n");
        expect(
          sample.text.includes(ETH.key) || originalStrings.includes(ETH.key),
          `${label} (표본)`,
        ).toBe(true);
        stub.route(ETH.providerUrl, reply.text(sample.text, 200, "application/json"));
        stub.route(ETH.publicUrl, reply.json({ jsonrpc: "2.0", id: 1, result: "0xpublic" }));

        const sampleResponse = await callProxy(ETH.chainId, JSON.stringify(rpc("eth_blockNumber")));
        const sampleText = await sampleResponse.text();

        expectNoProviderSecret(sampleText, label);
        for (const form of sample.rawForms) {
          expect(sampleText, label).not.toContain(form);
        }
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(sampleText);
        }, label).not.toThrow();
        expectNoProviderSecret(jsonStringsAndKeys(parsed).join("\n"), label);
        for (const [key, value] of Object.entries(sample.kept)) {
          expect(ownValue(parsed, key), `${label} / ${key}`).toEqual(value);
        }
        if (sample.preserve) {
          expect(sampleText, label).toContain(BIG_INT_LITERAL);
          expectOwnProtoPreserved(parsed, original, label);
        }
        expect(publicCalls(), label).toHaveLength(0);
        expectNoProviderSecret(loggedText(), label);
      }
    });
  });
});

// 파싱한 JSON의 모든 문자열 값과 객체 키 이름을 모은다(`__proto__` 자체 키 포함).
function jsonStringsAndKeys(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(jsonStringsAndKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [key, ...jsonStringsAndKeys(item)]);
  }
  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
