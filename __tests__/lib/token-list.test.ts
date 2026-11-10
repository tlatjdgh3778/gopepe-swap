import type { Address } from "viem";

import { describe, expect, it } from "vitest";

import { SUPPORTED_CHAIN_IDS } from "@/config/chains";
import { PINNED_TOKENS_BY_CHAIN, TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { filterTokenList, sortTokenList, type TokenBalances } from "@/lib/token-list";

// 스펙 DoD-9: 고정 토큰 순서
const PINNED_SYMBOLS = ["ETH", "WETH", "USDC", "USDT", "DAI"];

const tokenKey = (token: Pick<Token, "chainId" | "address">) =>
  `${token.chainId}:${token.address.toLowerCase()}`;

// 스펙 DoD-11: 앞뒤 공백을 지운 검색어가 심볼이나 이름에 대소문자 무시로 부분 일치한다.
function matchesQuery(token: Token, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return token.symbol.toLowerCase().includes(needle) || token.name.toLowerCase().includes(needle);
}

// 스펙 DoD-10: 대소문자 무시 심볼, 같으면 소문자 주소 문자열. 0 이하이면 a가 b보다 앞에 올 수 있다.
function compareByDoD10(a: Token, b: Token): number {
  const symbolA = a.symbol.toLowerCase();
  const symbolB = b.symbol.toLowerCase();
  if (symbolA !== symbolB) return symbolA < symbolB ? -1 : 1;
  const addressA = a.address.toLowerCase();
  const addressB = b.address.toLowerCase();
  if (addressA === addressB) return 0;
  return addressA < addressB ? -1 : 1;
}

function expectDoD10Order(tokens: readonly Token[], label: string) {
  for (let index = 1; index < tokens.length; index += 1) {
    const previous = tokens[index - 1];
    const current = tokens[index];
    expect(
      compareByDoD10(previous, current),
      `${label}: ${previous.symbol}(${previous.address}) 다음 ${current.symbol}(${current.address})`,
    ).toBeLessThanOrEqual(0);
  }
}

const isPinned = (chainId: keyof typeof PINNED_TOKENS_BY_CHAIN, token: Token) =>
  PINNED_TOKENS_BY_CHAIN[chainId].some((pinned) => tokenKey(pinned) === tokenKey(token));

/**
 * 고정 토큰이 아닌 토큰은 순서 번호로 나눠 잔액을 준다: 5개 중 1개는 0보다 큰 잔액(크기는 심볼 순서와 무관),
 * 1개는 잔액 0, 나머지는 잔액 정보 없음. 고정 토큰은 WETH·DAI에 0보다 큰 잔액, USDC에 0, 나머지는 정보 없음.
 */
function buildBalances(chainId: keyof typeof PINNED_TOKENS_BY_CHAIN): Map<Address, bigint> {
  const balances = new Map<Address, bigint>();
  const nonPinned = TOKENS_BY_CHAIN[chainId].filter((token) => !isPinned(chainId, token));
  nonPinned.forEach((token, index) => {
    if (index % 5 === 0) balances.set(token.address, BigInt(((index * 7919) % 1000) + 1));
    else if (index % 5 === 1) balances.set(token.address, 0n);
  });

  const pinned = PINNED_TOKENS_BY_CHAIN[chainId];
  const bySymbol = (symbol: string) => pinned.find((token) => token.symbol === symbol);
  const weth = bySymbol("WETH");
  const usdc = bySymbol("USDC");
  const dai = bySymbol("DAI");
  if (weth) balances.set(weth.address, 10n ** 18n);
  if (usdc) balances.set(usdc.address, 0n);
  if (dai) balances.set(dai.address, 5n);
  return balances;
}

const hasPositiveBalance = (balances: TokenBalances, token: Token) =>
  (balances.get(token.address) ?? 0n) > 0n;

// DoD-10 합성 표본. 모두 고정 토큰이 아니며 Ethereum(1)의 유효한 hex 주소를 쓴다.
const synthetic = (symbol: string, address: Address): Token => ({
  chainId: 1,
  address,
  name: `Synthetic ${symbol}`,
  symbol,
  decimals: 18,
});

// 이 파일은 모달 목록의 정렬·검색 규칙만 다룬다.
// 화면에서의 검색 결과와 결과 없음 표시는 통합 테스트(T-6), 실제 잔액을 주입한 순서는 E2E(T-8)가 다룬다.
describe("토큰 목록 — 자주 쓰는 토큰과 가진 토큰을 먼저 보이고 심볼·이름으로 찾는다", () => {
  describe("목록 순서", () => {
    /**
     * @spec DoD-9
     * @given 연결 상태라 잔액을 아는 Ethereum(1), Base(8453), Arbitrum(42161) 토큰 목록을 하나씩 확인한다. 고정 토큰 일부와 고정 토큰이 아닌 토큰 여럿은 잔액이 0보다 크고, 일부는 잔액이 0이며, 일부는 잔액 정보가 없다
     * @when 모달 목록 순서를 정한다
     * @then 앞의 5개는 ETH, WETH, USDC, USDT, DAI 순서의 고정 토큰이며 고정 토큰의 잔액과 무관하다
     * @then 그다음에 잔액이 0보다 큰 고정 토큰 외 토큰이 모두 놓인다
     * @then 그 뒤에 잔액이 0이거나 잔액 정보가 없는 나머지 토큰이 모두 놓인다
     * @then 결과 목록은 입력 목록의 토큰을 빠짐없이 한 번씩 담는다
     */
    it("[DoD-9] 고정 토큰 5개, 잔액이 0보다 큰 토큰, 나머지 토큰 순으로 놓는다", () => {
      for (const chainId of SUPPORTED_CHAIN_IDS) {
        const tokens = TOKENS_BY_CHAIN[chainId];
        const pinned = PINNED_TOKENS_BY_CHAIN[chainId];
        const balances = buildBalances(chainId);
        const label = `체인 ${chainId}`;

        const nonPinned = tokens.filter((token) => !isPinned(chainId, token));
        const withBalanceKeys = nonPinned
          .filter((token) => hasPositiveBalance(balances, token))
          .map(tokenKey)
          .sort();
        const restKeys = nonPinned
          .filter((token) => !hasPositiveBalance(balances, token))
          .map(tokenKey)
          .sort();
        // 전제: 잔액 > 0, 잔액 0, 잔액 정보 없음이 모두 있다.
        expect(withBalanceKeys.length, `${label} 잔액 그룹`).toBeGreaterThan(0);
        expect(
          nonPinned.some((token) => balances.get(token.address) === 0n),
          `${label} 잔액 0 토큰`,
        ).toBe(true);
        expect(
          nonPinned.some((token) => !balances.has(token.address)),
          `${label} 잔액 정보 없는 토큰`,
        ).toBe(true);

        const result = sortTokenList(tokens, pinned, balances);

        const head = result.slice(0, 5);
        expect(
          head.map((token) => token.symbol),
          `${label} 앞 5개 심볼`,
        ).toEqual(PINNED_SYMBOLS);
        expect(head.map(tokenKey), `${label} 앞 5개는 고정 토큰`).toEqual(pinned.map(tokenKey));

        const middle = result.slice(5, 5 + withBalanceKeys.length);
        expect(middle.map(tokenKey).sort(), `${label} 잔액 그룹`).toEqual(withBalanceKeys);

        const tail = result.slice(5 + withBalanceKeys.length);
        expect(tail.map(tokenKey).sort(), `${label} 나머지 그룹`).toEqual(restKeys);

        const resultKeys = result.map(tokenKey);
        expect(new Set(resultKeys).size, `${label} 중복 없음`).toBe(resultKeys.length);
        expect([...resultKeys].sort(), `${label} 빠짐 없음`).toEqual(tokens.map(tokenKey).sort());
      }
    });

    /**
     * @spec DoD-10
     * @given 잔액이 0보다 큰 그룹과 나머지 그룹 각각에 대소문자에 따라 순서가 달라지는 심볼(예: `cbETH`·`DAI`처럼 소문자로 시작하는 심볼과 대문자 심볼), 대소문자를 무시하면 같은 심볼에 주소의 대소문자 표기가 섞인 토큰들을 둔 목록이 있다. 같은 심볼 토큰에는 원문 문자열 순서와 소문자 문자열 순서가 반대인 주소 쌍(예: `0xB…`와 `0xa…`)이 들어 있다
     * @when 모달 목록 순서를 정한다
     * @then 각 그룹 안에서는 대소문자를 무시한 심볼순이다
     * @then 심볼이 같은 토큰끼리는 소문자로 바꾼 주소 문자열순이다
     */
    it("[DoD-10] 잔액 그룹과 나머지 그룹 안에서는 대소문자 무시 심볼순, 같은 심볼은 소문자 주소순이다", () => {
      // 잔액 그룹. 잔액 크기 순서는 심볼 순서와 다르다.
      const cbBTC = synthetic("cbBTC", "0x1000000000000000000000000000000000000001");
      const crv = synthetic("CRV", "0x1000000000000000000000000000000000000002");
      const aave = synthetic("aave", "0x1000000000000000000000000000000000000003");
      const bal = synthetic("BAL", "0x1000000000000000000000000000000000000004");
      const usdxB = synthetic("USDX", "0xB000000000000000000000000000000000000005");
      const usdxA6 = synthetic("usdx", "0xa000000000000000000000000000000000000006");
      const usdxA7 = synthetic("USDX", "0xA000000000000000000000000000000000000007");
      // 나머지 그룹(잔액 0 또는 잔액 정보 없음).
      const zrx = synthetic("zrx", "0x2000000000000000000000000000000000000001");
      const yfi = synthetic("Yfi", "0x2000000000000000000000000000000000000002");
      const mkr = synthetic("mkr", "0x2000000000000000000000000000000000000003");
      const ldo2 = synthetic("LDO", "0x2000000000000000000000000000000000000004");
      const ldoD = synthetic("ldo", "0xD000000000000000000000000000000000000005");
      const ldoC = synthetic("LDO", "0xc000000000000000000000000000000000000006");

      const balances = new Map<Address, bigint>([
        [cbBTC.address, 1n],
        [crv.address, 900n],
        [aave.address, 50n],
        [bal.address, 700n],
        [usdxB.address, 3n],
        [usdxA6.address, 1000n],
        [usdxA7.address, 20n],
        [zrx.address, 0n],
        [ldo2.address, 0n],
      ]);

      // 전제: 원문 표기 순서와 대소문자 무시 순서가 다르다.
      expect(crv.symbol < cbBTC.symbol).toBe(true);
      expect(cbBTC.symbol.toLowerCase() < crv.symbol.toLowerCase()).toBe(true);
      expect(bal.symbol < aave.symbol).toBe(true);
      expect(aave.symbol.toLowerCase() < bal.symbol.toLowerCase()).toBe(true);
      expect(usdxB.address < usdxA6.address).toBe(true);
      expect(usdxB.address.toLowerCase() > usdxA6.address.toLowerCase()).toBe(true);
      expect(ldoD.address < ldoC.address).toBe(true);
      expect(ldoD.address.toLowerCase() > ldoC.address.toLowerCase()).toBe(true);

      const pinned = PINNED_TOKENS_BY_CHAIN[1];
      const syntheticTokens = [
        cbBTC,
        crv,
        aave,
        bal,
        usdxB,
        usdxA6,
        usdxA7,
        zrx,
        yfi,
        mkr,
        ldo2,
        ldoD,
        ldoC,
      ];
      for (const token of syntheticTokens) {
        expect(isPinned(1, token), `${token.symbol}는 고정 토큰이 아니다`).toBe(false);
      }
      const tokens = [...syntheticTokens].reverse().concat(pinned);

      const result = sortTokenList(tokens, pinned, balances);
      const withBalance = result.slice(5, 12);
      const rest = result.slice(12);

      expect(withBalance.map((token) => token.address)).toEqual(
        [aave, bal, cbBTC, crv, usdxA6, usdxA7, usdxB].map((token) => token.address),
      );
      expect(rest.map((token) => token.address)).toEqual(
        [ldo2, ldoC, ldoD, mkr, yfi, zrx].map((token) => token.address),
      );
      expectDoD10Order(withBalance, "잔액 그룹");
      expectDoD10Order(rest, "나머지 그룹");
    });
  });

  describe("검색", () => {
    /**
     * @spec DoD-11
     * @given Ethereum(1) 토큰 목록에서 검색어 표본 `usd`, `USD`, `  usd  `(심볼 부분 일치), `stablecoin`, `rapped eth`(이름에만 부분 일치), `UsDc`를 하나씩 반복한다
     * @when 목록을 검색어로 거른다
     * @then 결과에는 앞뒤 공백을 지운 검색어가 심볼이나 이름에 대소문자를 무시하고 부분 일치하는 토큰만 있다
     * @then 그런 토큰이 목록에 있으면 하나도 빠지지 않는다
     * @then 앞뒤 공백·대소문자만 다른 검색어(`usd`, `USD`, `  usd  `)의 결과는 같다
     */
    it("[DoD-11] 앞뒤 공백을 지운 검색어로 심볼과 이름에 대소문자 무시 부분 일치로 거른다", () => {
      const tokens = TOKENS_BY_CHAIN[1];
      const queries = ["usd", "USD", "  usd  ", "stablecoin", "rapped eth", "UsDc"];
      const nameOnlyQueries = new Set(["stablecoin", "rapped eth"]);
      const resultsByQuery = new Map<string, string[]>();

      for (const query of queries) {
        const label = JSON.stringify(query);
        const result = filterTokenList(tokens, query);
        const expectedKeys = tokens.filter((token) => matchesQuery(token, query)).map(tokenKey);
        expect(expectedKeys.length, `${label} 일치 토큰이 목록에 있다`).toBeGreaterThan(0);

        for (const token of result) {
          expect(matchesQuery(token, query), `${label} 결과 ${token.symbol}`).toBe(true);
        }
        expect(result.map(tokenKey).sort(), `${label} 빠짐 없음`).toEqual([...expectedKeys].sort());

        if (nameOnlyQueries.has(query)) {
          const needle = query.trim().toLowerCase();
          expect(
            result.some((token) => !token.symbol.toLowerCase().includes(needle)),
            `${label} 이름으로만 일치한 토큰`,
          ).toBe(true);
        }
        resultsByQuery.set(query, result.map(tokenKey));
      }

      expect(resultsByQuery.get("USD")).toEqual(resultsByQuery.get("usd"));
      expect(resultsByQuery.get("  usd  ")).toEqual(resultsByQuery.get("usd"));
    });

    /**
     * @spec DoD-12
     * @given 연결 상태라 잔액을 아는 Ethereum(1) 토큰 목록에서 고정 토큰, 잔액이 0보다 큰 토큰, 나머지 토큰이 함께 걸리는 검색어(예: `usd`)를 넣는다
     * @when 같은 잔액으로 목록을 정렬하고 검색어로 거른다
     * @then 결과 순서는 같은 잔액으로 정렬한 전체 목록에서 일치하는 토큰만 남긴 순서와 같다
     * @then 결과는 고정 토큰, 잔액이 0보다 큰 토큰, 나머지 토큰 순이고 각 그룹 안은 DoD-10의 순서다
     */
    it("[DoD-12] 검색 중에도 DoD-9·DoD-10의 순서를 유지한다", () => {
      const tokens = TOKENS_BY_CHAIN[1];
      const pinned = PINNED_TOKENS_BY_CHAIN[1];
      const query = "usd";
      const balances = new Map<Address, bigint>();
      // 검색어에 걸리는 고정 토큰 외 토큰은 하나 걸러 잔액을 주고(크기는 심볼 순서와 무관), 걸리지 않는 토큰에도 일부 잔액을 준다.
      tokens
        .filter((token) => !isPinned(1, token))
        .forEach((token, index) => {
          if (matchesQuery(token, query)) {
            if (index % 2 === 0) balances.set(token.address, BigInt(((index * 7919) % 1000) + 1));
          } else if (index % 3 === 0) {
            balances.set(token.address, 1n);
          }
        });

      const sorted = sortTokenList(tokens, pinned, balances);
      const result = filterTokenList(sorted, query);

      expect(result.map(tokenKey)).toEqual(
        sorted.filter((token) => matchesQuery(token, query)).map(tokenKey),
      );

      const groupOf = (token: Token) =>
        isPinned(1, token) ? 0 : hasPositiveBalance(balances, token) ? 1 : 2;
      const groups = result.map(groupOf);
      // 전제: 세 그룹이 모두 걸린다.
      expect(new Set(groups)).toEqual(new Set([0, 1, 2]));
      for (let index = 1; index < groups.length; index += 1) {
        expect(groups[index - 1], `${index}번째 그룹 순서`).toBeLessThanOrEqual(groups[index]);
      }

      const pinnedPart = result.filter((token) => groupOf(token) === 0);
      expect(pinnedPart.map(tokenKey)).toEqual(
        pinned.filter((token) => matchesQuery(token, query)).map(tokenKey),
      );
      expectDoD10Order(
        result.filter((token) => groupOf(token) === 1),
        "검색 결과의 잔액 그룹",
      );
      expectDoD10Order(
        result.filter((token) => groupOf(token) === 2),
        "검색 결과의 나머지 그룹",
      );
    });

    /**
     * @spec EC-17
     * @given Ethereum(1), Base(8453), Arbitrum(42161) 토큰 목록 각각에서 그 목록의 전체 토큰 주소(네이티브 ETH 주소 포함)를 원래 표기와 소문자 표기로 하나씩 검색어로 넣는다
     * @when 목록을 검색어로 거른다
     * @then 결과가 없다
     */
    it("[EC-17] 토큰 주소를 검색어로 넣으면 결과가 없다", () => {
      for (const chainId of SUPPORTED_CHAIN_IDS) {
        const tokens = TOKENS_BY_CHAIN[chainId];
        expect(
          tokens.some((token) => token.symbol === "ETH"),
          `체인 ${chainId} 목록에 네이티브 ETH가 있다`,
        ).toBe(true);

        for (const token of tokens) {
          for (const query of [token.address, token.address.toLowerCase()]) {
            expect(
              filterTokenList(tokens, query).map((found) => found.symbol),
              `체인 ${chainId} 검색어 ${query}`,
            ).toEqual([]);
          }
        }
      }
    });

    /**
     * @spec EC-28
     * @given 연결 상태라 잔액을 아는 Ethereum(1) 토큰 목록에서 검색어 표본 ``(빈 문자열), ` `, `   `, `\t `처럼 공백뿐인 검색어를 하나씩 반복한다
     * @when 목록을 검색어로 거른다
     * @then 결과는 같은 잔액으로 정렬한 전체 목록과 순서까지 같다
     */
    it("[EC-28] 검색어가 공백뿐이면 전체 목록을 표시한다", () => {
      const balances = buildBalances(1);
      const sorted = sortTokenList(TOKENS_BY_CHAIN[1], PINNED_TOKENS_BY_CHAIN[1], balances);
      expect(sorted).toHaveLength(TOKENS_BY_CHAIN[1].length);

      for (const query of ["", " ", "   ", "\t "]) {
        expect(filterTokenList(sorted, query).map(tokenKey), JSON.stringify(query)).toEqual(
          sorted.map(tokenKey),
        );
      }
    });
  });
});
