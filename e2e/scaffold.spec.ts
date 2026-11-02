import { expect, test } from "@playwright/test";

test("스캐폴드 페이지를 연다", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("To get started");
});
