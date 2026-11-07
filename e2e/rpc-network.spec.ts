import { expect, test } from "@playwright/test";
import { mainnet } from "viem/chains";

import { chainSelect, connectWithMock, openApp, requireBaseURL } from "./support/app";
import { jsonRpcMethods, watchJsonRpcTraffic } from "./support/network";

test.describe("RPC 네트워크 경로 — 브라우저의 RPC 요청은 프록시로만 나간다", () => {
  /**
   * @spec DoD-18
   * @given 브라우저 컨텍스트의 모든 요청을 가로채지 않고 감시하는 상태에서 앱을 열고 mock 커넥터로 연결했으며 선택 체인이 Ethereum이다
   * @when 앱이 RPC 읽기에 쓰는 것과 같은 클라이언트(transport)로 보내는 E2E 빌드 전용 테스트 호출을 Ethereum에서 1회 실행한다
   * @then 테스트 호출이 `POST /api/rpc/1` 요청으로 감시에 기록된다
   * @then 감시한 전체 구간에서 앱 출처의 `/api/rpc/*`와 mock 커넥터용 anvil 외의 JSON-RPC 요청이 없다
   */
  test("[DoD-18] 브라우저 요청이 업체 RPC로 직접 나가지 않는다", async ({
    context,
    page,
    baseURL,
  }) => {
    const appOrigin = new URL(requireBaseURL(baseURL)).origin;
    const traffic = watchJsonRpcTraffic(context, page);

    await openApp(page);
    await connectWithMock(page);
    await expect(chainSelect(page)).toHaveAttribute("data-selected-chain-id", String(mainnet.id));
    await page.waitForFunction(
      () => typeof window.__GOPEPE_E2E__?.requestBlockNumber === "function",
    );

    const testCallRequest = page.waitForRequest(
      (request) =>
        new URL(request.url()).origin === appOrigin &&
        new URL(request.url()).pathname === `/api/rpc/${mainnet.id}` &&
        jsonRpcMethods(request).includes("eth_blockNumber"),
    );
    const blockNumber = await page.evaluate(() => window.__GOPEPE_E2E__!.requestBlockNumber!());
    const request = await testCallRequest;

    expect(request.method()).toBe("POST");
    expect((await request.response())?.status()).toBe(200);
    expect(blockNumber).toMatch(/^0x[0-9a-f]+$/i);

    expect(traffic.calls.length).toBeGreaterThan(0);
    expect(traffic.disallowed(appOrigin)).toEqual([]);
  });
});
