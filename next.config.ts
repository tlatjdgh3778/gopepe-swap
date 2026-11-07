import type { NextConfig } from "next";

// E2E 빌드(NEXT_PUBLIC_E2E_MOCK=1)는 일반 빌드 산출물(.next)과 섞이지 않도록 전용 distDir을 쓴다.
const isE2eBuild = process.env.NEXT_PUBLIC_E2E_MOCK === "1";

// 플래그가 없으면 Turbopack이 `process.env.NEXT_PUBLIC_E2E_MOCK`을 치환하지 않아 E2E 분기가 번들에 남는다.
// E2E가 아닌 빌드에서는 빈 문자열로 정의해 조건을 상수 false로 만들고 mock 코드를 제거한다.
const nextConfig: NextConfig = isE2eBuild
  ? { distDir: ".next-e2e" }
  : { env: { NEXT_PUBLIC_E2E_MOCK: "" } };

export default nextConfig;
