import { expect, test } from "@playwright/test";

import {
  CONNECTED_PRIMARY_STATE,
  RESTORE_SETTLE_TIMEOUT_MS,
  connectModal,
  connectWithMock,
  mockConnectorOption,
  newIsolatedPage,
  openApp,
  primaryButton,
  readMockAccount,
  sameAddressPattern,
  waitForRestoreSettled,
  walletButton,
} from "./support/app";
import { fetchServerRenderedHtml, openServerRenderedDocument, toCookieHeader } from "./support/ssr";

// EC-2 표본: 연결 요청 거부(`connectError: true`), 연결 오류(`connectError: Error`).
const CONNECT_FAILURE_SAMPLES = ["rejected", "error"] as const;

test.describe("지갑 연결 — 사용자가 브라우저 지갑을 연결하고 해제한다", () => {
  test.describe("연결과 해제", () => {
    /**
     * @spec DoD-8
     * @given 복원이 끝나 미연결 상태인 앱에 mock 커넥터가 준비되어 있다
     * @when 사용자가 연결 모달을 열어 mock 커넥터로 지갑을 연결한다
     * @then 앱 상태가 연결이 되고 계정 주소가 mock 커넥터의 계정 주소와 같다
     * @then 지갑 버튼이 연결 상태다
     * @then 주 버튼이 미연결 상태에서 벗어나 비활성이 된다
     */
    test("[DoD-8] 지갑을 연결하면 계정 주소가 앱 상태에 반영된다", async ({ page }) => {
      await openApp(page);
      await expect(primaryButton(page)).toHaveAttribute("data-state", "disconnected");
      const mockAccount = await readMockAccount(page);

      await connectWithMock(page);

      await expect(walletButton(page)).toHaveAttribute("data-state", "connected");
      await expect(walletButton(page)).toHaveAttribute(
        "data-connected-address",
        sameAddressPattern(mockAccount),
      );
      await expect(primaryButton(page)).toHaveAttribute("data-state", CONNECTED_PRIMARY_STATE);
      await expect(primaryButton(page)).toBeDisabled();
    });

    /**
     * @spec DoD-9
     * @given mock 커넥터로 지갑이 연결된 상태다
     * @when 사용자가 지갑 버튼 메뉴에서 연결을 해제한다
     * @then 앱 상태가 미연결이 되고 계정 주소가 앱 상태에 남지 않는다
     * @then 주 버튼이 미연결 상태로 돌아와 활성이 되고 누르면 연결 모달이 열린다
     * @then 새로고침 후에도 미연결이다
     */
    test("[DoD-9] 연결을 해제하면 미연결 상태로 돌아간다", async ({ page }) => {
      await openApp(page);
      await connectWithMock(page);

      await walletButton(page).click();
      await page.getByTestId("disconnect-button").click();

      await expect(walletButton(page)).toHaveAttribute("data-state", "disconnected");
      await expect(walletButton(page)).not.toHaveAttribute("data-connected-address");
      await expect(primaryButton(page)).toHaveAttribute("data-state", "disconnected");
      await expect(primaryButton(page)).toBeEnabled();
      await primaryButton(page).click();
      await expect(connectModal(page)).toBeVisible();

      await page.reload();
      await waitForRestoreSettled(page);
      await expect(walletButton(page)).toHaveAttribute("data-state", "disconnected");
      await expect(walletButton(page)).not.toHaveAttribute("data-connected-address");
      await expect(primaryButton(page)).toHaveAttribute("data-state", "disconnected");
    });
  });

  test.describe("연결 실패", () => {
    /**
     * @spec EC-2
     * @given mock 커넥터 connectError를 E2E 제어값으로 켠 미연결 상태다 (표본: 연결 요청 거부, 연결 오류)
     * @when 사용자가 연결 모달에서 mock 커넥터로 연결을 시도한다
     * @then 앱 상태가 미연결로 유지되고 계정 주소가 앱 상태에 반영되지 않는다
     * @then 주 버튼이 미연결 상태로 유지된다
     */
    test("[EC-2] 연결 요청 거부나 연결 오류가 나면 미연결 상태를 유지한다", async ({
      browser,
      baseURL,
    }) => {
      for (const sample of CONNECT_FAILURE_SAMPLES) {
        await test.step(`표본: ${sample}`, async () => {
          const { context, page } = await newIsolatedPage(browser, baseURL);
          try {
            await context.addInitScript((kind) => {
              const control = window.__GOPEPE_E2E__ ?? {};
              control.connectError = kind === "rejected" ? true : new Error("E2E 연결 오류");
              window.__GOPEPE_E2E__ = control;
            }, sample);
            await openApp(page);
            await expect(primaryButton(page)).toHaveAttribute("data-state", "disconnected");

            await primaryButton(page).click();
            await mockConnectorOption(page).click();
            // 연결 시도가 실패로 끝났음을 확인한 뒤 상태를 판정한다.
            await expect(page.getByTestId("connect-error")).toBeVisible();

            await expect(walletButton(page)).toHaveAttribute("data-state", "disconnected");
            await expect(walletButton(page)).not.toHaveAttribute("data-connected-address");
            await expect(primaryButton(page)).toHaveAttribute("data-state", "disconnected");
          } finally {
            await context.close();
          }
        });
      }
    });
  });

  test.describe("연결 복원", () => {
    /**
     * @spec DoD-14
     * @given mock 커넥터로 지갑이 연결된 상태다
     * @when 사용자가 페이지를 새로고침한다
     * @then 사용자가 다시 연결하지 않아도 복원이 끝나면 앱 상태가 연결이 된다
     * @then 복원된 계정 주소가 새로고침 전 계정 주소와 같다
     */
    test("[DoD-14] 연결 후 새로고침하면 연결이 복원된다", async ({ page }) => {
      await openApp(page);
      await connectWithMock(page);
      const addressBefore = await walletButton(page).getAttribute("data-connected-address");
      expect(addressBefore).toBeTruthy();

      await page.reload();

      await expect(walletButton(page)).toHaveAttribute("data-state", "connected", {
        timeout: RESTORE_SETTLE_TIMEOUT_MS,
      });
      await expect(walletButton(page)).toHaveAttribute(
        "data-connected-address",
        sameAddressPattern(addressBefore!),
      );
      await expect(primaryButton(page)).toHaveAttribute("data-state", CONNECTED_PRIMARY_STATE);
    });

    /**
     * @spec DoD-15
     * @given 브라우저 컨텍스트의 연결 저장 상태가 있다 (표본: 저장된 연결 없음, mock 커넥터로 연결해 저장된 연결 있음)
     * @when 그 컨텍스트로 앱 문서를 서버에 요청해 서버 렌더링 결과를 받는다
     * @then 서버 렌더링 결과의 주 버튼이 복원 중 상태(로딩 표시, 비활성)다
     * @then 서버 렌더링 결과의 지갑 버튼이 복원 중 상태(로딩 표시, 비활성)다
     * @then 서버 렌더링 결과에 미연결 상태가 없다
     */
    test("[DoD-15] 저장된 연결 유무와 상관없이 서버 렌더링 결과는 복원 중 상태이고 미연결 상태가 표시되지 않는다", async ({
      browser,
      baseURL,
      request,
    }) => {
      const samples = [
        { name: "저장된 연결 없음", storeConnection: false },
        { name: "저장된 연결 있음", storeConnection: true },
      ];
      for (const sample of samples) {
        await test.step(`표본: ${sample.name}`, async () => {
          const { context, page } = await newIsolatedPage(browser, baseURL);
          try {
            if (sample.storeConnection) {
              await openApp(page);
              const mockAccount = await readMockAccount(page);
              await connectWithMock(page);
              // 표본 전제: wagmi 저장 쿠키에 mock 계정의 연결이 기록되었다.
              await expect
                .poll(async () => {
                  const cookies = await context.cookies();
                  const stored = cookies.find((cookie) => cookie.name === "wagmi.store");
                  return decodeURIComponent(stored?.value ?? "").toLowerCase();
                })
                .toContain(mockAccount.toLowerCase());
            }
            const html = await fetchServerRenderedHtml(
              request,
              toCookieHeader(await context.cookies()),
            );

            const ssr = await openServerRenderedDocument(browser, html);
            try {
              const ssrPrimary = primaryButton(ssr.page);
              const ssrWallet = walletButton(ssr.page);
              await expect(ssrPrimary).toHaveAttribute("data-state", "restoring");
              await expect(ssrPrimary).toHaveAttribute("aria-busy", "true");
              await expect(ssrPrimary).toBeDisabled();
              await expect(ssrWallet).toHaveAttribute("data-state", "restoring");
              await expect(ssrWallet).toHaveAttribute("aria-busy", "true");
              await expect(ssrWallet).toBeDisabled();
              await expect(
                ssr.page.locator('[data-testid][data-state="disconnected"]'),
              ).toHaveCount(0);
            } finally {
              await ssr.context.close();
            }
          } finally {
            await context.close();
          }
        });
      }
    });
  });
});
