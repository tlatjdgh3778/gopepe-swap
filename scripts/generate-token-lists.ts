import { writeFile } from "node:fs/promises";

import { getAddress } from "viem";

import { SUPPORTED_CHAIN_IDS, isSupportedChainId, type SupportedChainId } from "../config/chains";

const TOKEN_LIST_URL = "https://tokens.uniswap.org";
const FETCH_TIMEOUT_MS = 30_000;

type SnapshotToken = {
  chainId: SupportedChainId;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`토큰 리스트의 ${label} 값이 올바르지 않습니다.`);
  }
  return value;
}

// 출력 JSON의 키 순서를 고정하고, 허용한 필드만 남긴다.
function toSnapshotToken(chainId: SupportedChainId, raw: Record<string, unknown>): SnapshotToken {
  const address = getAddress(requireString(raw.address, "address"));
  const label = `${chainId}:${address}`;

  const { decimals } = raw;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`토큰 리스트의 ${label} decimals 값이 올바르지 않습니다.`);
  }

  return {
    chainId,
    address,
    name: requireString(raw.name, `${label} name`),
    symbol: requireString(raw.symbol, `${label} symbol`),
    decimals,
    ...(raw.logoURI === undefined
      ? {}
      : { logoURI: requireString(raw.logoURI, `${label} logoURI`) }),
  };
}

function buildSnapshots(rawTokens: unknown[]): Map<SupportedChainId, SnapshotToken[]> {
  const snapshots = new Map<SupportedChainId, SnapshotToken[]>(
    SUPPORTED_CHAIN_IDS.map((chainId) => [chainId, []]),
  );

  for (const raw of rawTokens) {
    if (!isRecord(raw)) {
      throw new Error("토큰 리스트에 객체가 아닌 항목이 있습니다.");
    }
    if (typeof raw.chainId !== "number" || !isSupportedChainId(raw.chainId)) {
      continue;
    }
    snapshots.get(raw.chainId)?.push(toSnapshotToken(raw.chainId, raw));
  }

  for (const [chainId, tokens] of snapshots) {
    if (tokens.length === 0) {
      throw new Error(`토큰 리스트에 체인 ${chainId}의 토큰이 없습니다.`);
    }

    const addresses = new Set<string>();
    for (const { address } of tokens) {
      if (addresses.has(address)) {
        throw new Error(`토큰 리스트에 중복 키 ${chainId}:${address}가 있습니다.`);
      }
      addresses.add(address);
    }

    // 실행 환경의 로캘에 영향받지 않도록 코드 단위로 비교한다.
    const sortKey = (token: SnapshotToken) => token.address.toLowerCase();
    tokens.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  }

  return snapshots;
}

const response = await fetch(TOKEN_LIST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
if (!response.ok) {
  throw new Error(`토큰 리스트를 받지 못했습니다: HTTP ${response.status}`);
}

const list: unknown = await response.json();
if (!isRecord(list) || !Array.isArray(list.tokens)) {
  throw new Error("토큰 리스트 형식이 올바르지 않습니다.");
}

// 검증이 모두 끝난 뒤에 써서 일부 체인만 갱신되는 일을 막는다.
for (const [chainId, tokens] of buildSnapshots(list.tokens)) {
  const url = new URL(`../config/tokens-${chainId}.json`, import.meta.url);
  await writeFile(url, `${JSON.stringify(tokens, null, 2)}\n`);
  console.log(`config/tokens-${chainId}.json: 토큰 ${tokens.length}개`);
}
