import { loadEnvConfig, resetEnv } from "@next/env";
import { defineConfig, devices } from "@playwright/test";

import { E2E_ANVIL_PORT, E2E_APP_PORT, FORK_BLOCK_NUMBER } from "./config/e2e";

const FORK_URL_ENV = "ETH_MAINNET_RPC_URL";
const baseURL = `http://localhost:${E2E_APP_PORT}`;

// 값·호스트·키가 어떤 출력에도 남지 않도록 @next/env 로그를 끈다.
const silentLog = { info: () => {}, error: () => {} };

/**
 * anvil 포크 대상 RPC URL을 process.env, 없으면 `.env.local`에서 읽는다.
 * 읽은 뒤 process.env를 원래대로 되돌려 다른 `.env.local` 값이 하위 프로세스에 새지 않게 한다.
 */
function readForkUrl(): string {
  const fromProcess = process.env[FORK_URL_ENV]?.trim();
  if (fromProcess) return fromProcess;

  const { combinedEnv } = loadEnvConfig(__dirname, false, silentLog, true);
  const fromFile = combinedEnv[FORK_URL_ENV]?.trim();
  resetEnv();
  if (fromFile) return fromFile;

  throw new Error(
    `[e2e] ${FORK_URL_ENV} 값이 없거나 비어 있어 Ethereum 포크(anvil)를 띄울 수 없습니다. ` +
      `.env.local 또는 환경 변수에 Ethereum 메인넷 RPC URL을 설정하세요(CI는 같은 이름의 시크릿).`,
  );
}

const forkUrl = readForkUrl();

export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  // 포크는 처음 읽는 상태를 업체 RPC에서 가져오므로 기본 30초보다 넉넉하게 둔다.
  timeout: 60_000,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      name: "anvil",
      // URL은 셸 문자열에 넣지 않고 환경 변수로만 넘긴다. anvil 출력은 버린다.
      command: `anvil --port ${E2E_ANVIL_PORT} --fork-url "$${FORK_URL_ENV}" --fork-block-number ${FORK_BLOCK_NUMBER} --silent`,
      port: E2E_ANVIL_PORT,
      env: { [FORK_URL_ENV]: forkUrl },
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "ignore",
      timeout: 60_000,
    },
    {
      name: "app",
      // NEXT_PUBLIC_E2E_MOCK=1이면 next.config.ts가 distDir을 .next-e2e로 바꾼다.
      command: `bun run build && bun run start -p ${E2E_APP_PORT}`,
      url: baseURL,
      env: {
        NEXT_PUBLIC_E2E_MOCK: "1",
        // 프록시의 Ethereum 대상을 E2E용 anvil 포크로 맞춘다.
        [FORK_URL_ENV]: `http://127.0.0.1:${E2E_ANVIL_PORT}`,
      },
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
