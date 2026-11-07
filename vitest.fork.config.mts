import { defineConfig } from "vitest/config";

// 실제 anvil 포크(Ethereum)에 붙는 통합 테스트 전용 설정. `bun run test:fork`로 실행한다.
// anvil 기동·정리는 globalSetup이 맡는다.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["__tests__/fork/**/*.test.ts"],
    globalSetup: ["./__tests__/fork/global-setup.ts"],
    // 포크는 처음 읽는 상태를 업체 RPC에서 가져오므로 기본 5초보다 넉넉하게 둔다.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
