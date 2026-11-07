import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  expect,
} from "@playwright/test";

type CookieLike = { name: string; value: string };

export function toCookieHeader(cookies: readonly CookieLike[]): string | undefined {
  if (cookies.length === 0) return undefined;
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

// 앱 문서를 서버에 요청해 서버 렌더링 HTML을 받는다. 브라우저 JS는 관여하지 않는다.
export async function fetchServerRenderedHtml(
  request: APIRequestContext,
  cookieHeader: string | undefined,
): Promise<string> {
  const response = await request.get("/", {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  expect(response.status()).toBe(200);
  return response.text();
}

// 서버 렌더링 HTML을 JS를 끈 컨텍스트에 올려 hydration 없이 그대로 조회한다.
export async function openServerRenderedDocument(
  browser: Browser,
  html: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  return { context, page };
}
