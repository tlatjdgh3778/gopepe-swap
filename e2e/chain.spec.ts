import { type APIRequestContext, type Browser, expect, test } from "@playwright/test";
import { arbitrum, base, mainnet } from "viem/chains";

import {
  WALLET_CHAIN_CHANGE_METHODS,
  chainSelect,
  connectWithMock,
  newIsolatedPage,
  openApp,
  readWalletRequestMethods,
  selectChain,
  waitForRestoreSettled,
  walletButton,
} from "./support/app";
import { fetchServerRenderedHtml, openServerRenderedDocument } from "./support/ssr";

const SELECTED_CHAIN_COOKIE = "gopepe-chain";

async function serverRenderedSelectedChainId(
  browser: Browser,
  request: APIRequestContext,
  cookieHeader: string | undefined,
): Promise<string | null> {
  const html = await fetchServerRenderedHtml(request, cookieHeader);
  const ssr = await openServerRenderedDocument(browser, html);
  try {
    const select = ssr.page.getByTestId("chain-select");
    await expect(select).toHaveCount(1);
    return await select.getAttribute("data-selected-chain-id");
  } finally {
    await ssr.context.close();
  }
}

test.describe("선택 체인 — 사용자가 고른 체인이 앱의 기준이 된다", () => {
  test.describe("드롭다운 선택과 유지", () => {
    /**
     * @spec DoD-10
     * @given mock 커넥터로 지갑이 Ethereum에 연결되어 있고 선택 체인이 Ethereum이다 (표본: Base, Arbitrum을 차례로 선택)
     * @when 사용자가 체인 드롭다운에서 표본 체인을 선택한다
     * @then 앱의 선택 체인이 고른 체인으로 바뀐다
     * @then 지갑에 체인 전환 요청이 가지 않는다
     * @then 앱에 연결된 체인은 Ethereum 그대로이고 연결 상태가 유지된다
     */
    test("[DoD-10] 체인을 선택하면 지갑 요청 없이 선택 체인이 바뀐다", async ({ page }) => {
      await openApp(page);
      await connectWithMock(page);
      await expect(chainSelect(page)).toHaveAttribute("data-selected-chain-id", String(mainnet.id));
      await expect(walletButton(page)).toHaveAttribute(
        "data-connected-chain-id",
        String(mainnet.id),
      );

      for (const chain of [base, arbitrum]) {
        await test.step(`표본: ${chain.name}`, async () => {
          await selectChain(page, chain);

          await expect(chainSelect(page)).toHaveAttribute(
            "data-selected-chain-id",
            String(chain.id),
          );
          const methods = await readWalletRequestMethods(page);
          expect(methods.filter((method) => WALLET_CHAIN_CHANGE_METHODS.includes(method))).toEqual(
            [],
          );
          await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
          await expect(walletButton(page)).toHaveAttribute(
            "data-connected-chain-id",
            String(mainnet.id),
          );
        });
      }
    });

    /**
     * @spec DoD-11
     * @given 사용자가 체인 드롭다운으로 체인을 선택했다 (표본: 미연결 상태에서 Base 선택, 미연결 상태에서 Arbitrum 선택, mock 커넥터로 Ethereum에 연결된 상태에서 Base 선택)
     * @when 사용자가 페이지를 새로고침한다
     * @then 앱의 선택 체인이 새로고침 전에 고른 체인으로 유지된다
     * @then `gopepe-chain` 쿠키 값이 고른 체인의 chainId다
     */
    test("[DoD-11] 선택 체인이 새로고침 후에도 유지된다", async ({ browser, baseURL }) => {
      const samples = [
        { name: "미연결, Base", connect: false, chain: base },
        { name: "미연결, Arbitrum", connect: false, chain: arbitrum },
        { name: "Ethereum 연결, Base", connect: true, chain: base },
      ];
      for (const sample of samples) {
        await test.step(`표본: ${sample.name}`, async () => {
          const { context, page } = await newIsolatedPage(browser, baseURL);
          try {
            await openApp(page);
            if (sample.connect) {
              await connectWithMock(page);
              await expect(walletButton(page)).toHaveAttribute(
                "data-connected-chain-id",
                String(mainnet.id),
              );
            } else {
              await expect(walletButton(page)).toHaveAttribute("data-state", "disconnected");
            }
            await selectChain(page, sample.chain);
            await expect(chainSelect(page)).toHaveAttribute(
              "data-selected-chain-id",
              String(sample.chain.id),
            );

            await page.reload();
            await waitForRestoreSettled(page);

            await expect(chainSelect(page)).toHaveAttribute(
              "data-selected-chain-id",
              String(sample.chain.id),
            );
            const cookies = await context.cookies();
            expect(cookies.find((cookie) => cookie.name === SELECTED_CHAIN_COOKIE)?.value).toBe(
              String(sample.chain.id),
            );
          } finally {
            await context.close();
          }
        });
      }
    });
  });

  test.describe("서버 렌더링", () => {
    /**
     * @spec DoD-12
     * @given 브라우저 컨텍스트에 `gopepe-chain` 쿠키가 있다 (표본: 8453, 42161)
     * @when 그 컨텍스트로 앱 문서를 서버에 요청해 서버 렌더링 결과를 받는다
     * @then 서버 렌더링 결과의 선택 체인이 쿠키 값의 체인이다
     */
    test("[DoD-12] 쿠키의 선택 체인이 서버 렌더링 결과에 반영된다", async ({
      browser,
      request,
    }) => {
      for (const chain of [base, arbitrum]) {
        await test.step(`표본: ${chain.id}`, async () => {
          const selected = await serverRenderedSelectedChainId(
            browser,
            request,
            `${SELECTED_CHAIN_COOKIE}=${chain.id}`,
          );
          expect(selected).toBe(String(chain.id));
        });
      }
    });

    /**
     * @spec EC-7
     * @given 브라우저 컨텍스트의 `gopepe-chain` 쿠키가 없거나 잘못되었다 (표본: 쿠키 없음, 지원하지 않는 chainId 값. 나머지 표본은 T-8 단위 테스트가 맡는다)
     * @when 그 컨텍스트로 앱 문서를 서버에 요청해 서버 렌더링 결과를 받는다
     * @then 서버 렌더링 결과의 선택 체인이 Ethereum이다
     */
    test("[EC-7] 체인 쿠키가 없거나 값이 잘못되면 Ethereum으로 처리한다", async ({
      browser,
      request,
    }) => {
      // 지원하지 않는 chainId 표본: Optimism(10).
      const samples = [
        { name: "쿠키 없음", cookieHeader: undefined },
        { name: "지원하지 않는 chainId", cookieHeader: `${SELECTED_CHAIN_COOKIE}=10` },
      ];
      for (const sample of samples) {
        await test.step(`표본: ${sample.name}`, async () => {
          const selected = await serverRenderedSelectedChainId(
            browser,
            request,
            sample.cookieHeader,
          );
          expect(selected).toBe(String(mainnet.id));
        });
      }
    });
  });
});
