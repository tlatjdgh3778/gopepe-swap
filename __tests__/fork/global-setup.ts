import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";

import { processEnv, resetEnv } from "@next/env";

import { FORK_BLOCK_NUMBER, FORK_TEST_ANVIL_PORT } from "@/config/e2e";

const PROJECT_DIR = resolve(import.meta.dirname, "../..");
const FORK_URL_ENV = "ETH_MAINNET_RPC_URL";
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

// 값·호스트·키가 어떤 출력에도 남지 않도록 @next/env 로그를 끈다.
const silentLog = { info: () => {}, error: () => {} };

/**
 * 포크 대상 RPC URL을 process.env, 없으면 `.env.local`에서 읽는다.
 * Vitest는 NODE_ENV=test라서 `loadEnvConfig`가 `.env.local`을 건너뛰므로 `.env.local`을 직접 넘긴다.
 * 읽은 뒤 process.env를 원래대로 되돌려 테스트 worker에 `.env.local` 값이 새지 않게 한다.
 */
function readForkUrl(): string | undefined {
  const fromProcess = process.env[FORK_URL_ENV]?.trim();
  if (fromProcess) return fromProcess;

  const envLocalPath = resolve(PROJECT_DIR, ".env.local");
  if (!existsSync(envLocalPath)) return undefined;

  const [, parsed] = processEnv(
    [{ path: ".env.local", contents: readFileSync(envLocalPath, "utf8"), env: {} }],
    PROJECT_DIR,
    silentLog,
    true,
  );
  const value = parsed?.[FORK_URL_ENV]?.trim();
  resetEnv();
  return value || undefined;
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

async function stopAnvil(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  await waitForExit(child, STOP_TIMEOUT_MS);
}

export default async function setup(): Promise<() => Promise<void>> {
  const forkUrl = readForkUrl();
  if (!forkUrl) {
    throw new Error(
      `[fork] ${FORK_URL_ENV} 값이 없거나 비어 있어 Ethereum 포크를 띄울 수 없습니다. ` +
        `.env.local 또는 환경 변수에 Ethereum 메인넷 RPC URL을 설정하세요(CI는 같은 이름의 시크릿).`,
    );
  }

  if (await isPortListening(FORK_TEST_ANVIL_PORT)) {
    throw new Error(
      `[fork] 포트 ${FORK_TEST_ANVIL_PORT}를 이미 다른 프로세스가 쓰고 있습니다. 해당 프로세스를 종료한 뒤 다시 실행하세요.`,
    );
  }

  // URL은 셸 문자열에 넣지 않고 환경 변수로만 넘긴다. anvil 출력은 버린다.
  const anvil = spawn(
    "sh",
    [
      "-c",
      `exec anvil --port ${FORK_TEST_ANVIL_PORT} --fork-url "$${FORK_URL_ENV}" --fork-block-number ${FORK_BLOCK_NUMBER} --silent`,
    ],
    {
      cwd: PROJECT_DIR,
      env: { ...process.env, [FORK_URL_ENV]: forkUrl },
      stdio: "ignore",
    },
  );

  // teardown이 불리지 않고 프로세스가 끝나도 anvil을 남기지 않는다.
  const killOnExit = () => {
    if (anvil.exitCode === null && anvil.signalCode === null) anvil.kill("SIGKILL");
  };
  process.once("exit", killOnExit);

  const teardown = async () => {
    process.off("exit", killOnExit);
    await stopAnvil(anvil);
  };

  try {
    const exited = new Promise<never>((_, reject) => {
      anvil.once("error", () => reject(new Error("[fork] anvil 프로세스를 시작하지 못했습니다.")));
      anvil.once("exit", (code, signal) => {
        const hint =
          code === 127
            ? "anvil이 설치되어 있는지 확인하세요(Foundry)."
            : `${FORK_URL_ENV} 값이 올바른지, RPC가 ${FORK_BLOCK_NUMBER}번 블록을 조회할 수 있는지 확인하세요.`;
        reject(
          new Error(
            `[fork] anvil이 준비되기 전에 종료되었습니다(code=${code}, signal=${signal}). ${hint}`,
          ),
        );
      });
    });
    exited.catch(() => {});

    const deadline = Date.now() + READY_TIMEOUT_MS;
    const ready = (async () => {
      while (Date.now() < deadline && anvil.exitCode === null && anvil.signalCode === null) {
        if (await isPortListening(FORK_TEST_ANVIL_PORT)) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(
        `[fork] ${READY_TIMEOUT_MS}ms 안에 anvil이 포트 ${FORK_TEST_ANVIL_PORT}에서 준비되지 않았습니다.`,
      );
    })();

    await Promise.race([ready, exited]);
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
