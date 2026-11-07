import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    // Playwright의 e2e/*.spec.ts와 겹치지 않도록 *.test.*만 수집한다.
    include: ["**/*.test.{ts,tsx}"],
    // 실제 anvil 포크가 필요한 테스트는 `bun run test:fork`(vitest.fork.config.mts)에서만 실행한다.
    exclude: [...configDefaults.exclude, "__tests__/fork/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
