/**
 * 빌드 결과 검사 (`bun run check:build`).
 *
 * 1. DoD-19: 업체 RPC 변수 3개에 가짜 URL·키(카나리아)를 넣고 플래그 없이 빌드한 뒤,
 *    클라이언트 산출물(`.next/static`)에 카나리아가 없는지 검사한다.
 * 2. DoD-20: 같은 플래그 없는 빌드(`.next/static`, `.next/server`)에 mock 표식이 없고,
 *    `NEXT_PUBLIC_E2E_MOCK=1` 빌드(`.next-e2e`)에는 모든 표식이 있는지(양성 대조) 검사한다.
 *
 * 실제 RPC 키 없이 돌도록 카나리아 값만 쓴다. 일치하는 파일은 파일명만 출력한다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PROD_DIST_DIR = ".next";
const E2E_DIST_DIR = ".next-e2e";

/** 업체 RPC 서버 전용 변수와 가짜 값. 호스트·키·전체 URL을 각각 검색한다. */
const CANARIES = [
  {
    name: "ETH_MAINNET_RPC_URL",
    host: "gopepe-canary-eth.invalid",
    key: "GpCanaryKeyEth7f3a9c1d5e",
  },
  {
    name: "BASE_MAINNET_RPC_URL",
    host: "gopepe-canary-base.invalid",
    key: "GpCanaryKeyBase2b8e4f6a0c",
  },
  {
    name: "ARB_MAINNET_RPC_URL",
    host: "gopepe-canary-arb.invalid",
    key: "GpCanaryKeyArb9d1c3e5b7f",
  },
].map((canary) => ({ ...canary, url: `https://${canary.host}/v2/${canary.key}` }));

/**
 * mock 코드 표식. 플래그 없는 빌드에는 하나도 없어야 하고, E2E 빌드에는 모두 있어야 한다.
 * - `Mock Connector`: wagmi `mock` 커넥터의 고유 이름(`@wagmi/core` connectors/mock)
 * - `__GOPEPE_E2E__`: E2E 빌드 전용 제어값(`window.__GOPEPE_E2E__`)
 */
const MOCK_MARKERS = ["Mock Connector", "__GOPEPE_E2E__"];

const failures: string[] = [];

function canaryEnv(): Record<string, string> {
  return Object.fromEntries(CANARIES.map(({ name, url }) => [name, url]));
}

function build(label: string, extraEnv: Record<string, string>, distDir: string): boolean {
  const env: NodeJS.ProcessEnv = { ...process.env, ...canaryEnv(), ...extraEnv };
  if (!("NEXT_PUBLIC_E2E_MOCK" in extraEnv)) delete env.NEXT_PUBLIC_E2E_MOCK;

  console.log(`\n[check:build] ${label} 빌드 시작 (distDir=${distDir})`);
  const result = spawnSync("bun", ["run", "build"], { cwd: ROOT, env, stdio: "inherit" });
  if (result.status !== 0) {
    failures.push(`${label} 빌드 실패 (exit ${result.status ?? result.signal})`);
    return false;
  }
  if (!existsSync(join(ROOT, distDir, "BUILD_ID"))) {
    failures.push(`${label} 빌드 산출물이 ${distDir}에 없음`);
    return false;
  }
  return true;
}

function listFiles(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) {
    failures.push(`검사 대상 디렉터리 없음: ${dir}`);
    return [];
  }
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** needle별로 needle을 포함한 파일(프로젝트 상대 경로) 목록을 돌려준다. */
function findMatches(dirs: string[], needles: string[]): Map<string, string[]> {
  const matches = new Map<string, string[]>(needles.map((needle) => [needle, []]));
  for (const file of dirs.flatMap(listFiles)) {
    const content = readFileSync(file);
    for (const needle of needles) {
      if (content.includes(needle)) matches.get(needle)?.push(relative(ROOT, file));
    }
  }
  return matches;
}

function checkNoCanaryInClientBundle(): void {
  const dirs = [`${PROD_DIST_DIR}/static`];
  const needles = CANARIES.flatMap(({ url, host, key }) => [url, host, key]);
  const files = new Set([...findMatches(dirs, needles).values()].flat());

  if (files.size === 0) {
    console.log(`[check:build] DoD-19 통과: ${dirs.join(", ")}에 업체 RPC URL·키(카나리아)가 없음`);
    return;
  }
  // 카나리아 값이라도 값은 출력하지 않고 파일명만 남긴다.
  failures.push(
    `DoD-19 실패: 클라이언트 산출물에 업체 RPC URL·키(카나리아)가 있음\n` +
      [...files].map((file) => `  - ${file}`).join("\n"),
  );
}

function checkNoMockInProdBuild(): void {
  const dirs = [`${PROD_DIST_DIR}/static`, `${PROD_DIST_DIR}/server`];
  const found = [...findMatches(dirs, MOCK_MARKERS)].filter(([, files]) => files.length > 0);

  if (found.length === 0) {
    console.log(`[check:build] DoD-20 음성 통과: ${dirs.join(", ")}에 mock 표식이 없음`);
    return;
  }
  failures.push(
    `DoD-20 실패: 플래그 없는 빌드에 mock 표식이 있음\n` +
      found
        .map(([marker, files]) => `  - "${marker}": ${files.map((f) => `\n      ${f}`).join("")}`)
        .join("\n"),
  );
}

function checkMockInE2eBuild(): void {
  const dirs = [`${E2E_DIST_DIR}/static`, `${E2E_DIST_DIR}/server`];
  const missing = [...findMatches(dirs, MOCK_MARKERS)]
    .filter(([, files]) => files.length === 0)
    .map(([marker]) => marker);

  if (missing.length === 0) {
    console.log(`[check:build] DoD-20 양성 대조 통과: ${dirs.join(", ")}에 모든 mock 표식이 있음`);
    return;
  }
  failures.push(
    `DoD-20 양성 대조 실패: E2E 빌드(NEXT_PUBLIC_E2E_MOCK=1)에 없는 mock 표식이 있음 — ` +
      `표식 목록이나 E2E 빌드 구성을 확인하세요\n` +
      missing.map((marker) => `  - "${marker}"`).join("\n"),
  );
}

if (build("플래그 없는 프로덕션", {}, PROD_DIST_DIR)) {
  checkNoCanaryInClientBundle();
  checkNoMockInProdBuild();
}

if (build("E2E(NEXT_PUBLIC_E2E_MOCK=1)", { NEXT_PUBLIC_E2E_MOCK: "1" }, E2E_DIST_DIR)) {
  checkMockInE2eBuild();
}

if (failures.length > 0) {
  console.error(`\n[check:build] 실패 ${failures.length}건`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("\n[check:build] 모든 빌드 결과 검사 통과");
