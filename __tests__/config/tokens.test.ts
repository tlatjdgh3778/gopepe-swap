import { describe, expect, it } from "vitest";

import { PINNED_TOKENS_BY_CHAIN, TOKENS_BY_CHAIN } from "@/config/tokens";
import arbitrumSnapshot from "@/config/tokens-42161.json";
import baseSnapshot from "@/config/tokens-8453.json";
import mainnetSnapshot from "@/config/tokens-1.json";

// 스펙 §1: Ethereum(1), Base(8453), Arbitrum(42161)
const EXPECTED_CHAIN_IDS = [1, 8453, 42161] as const;
// 스펙 §4.3: 고정 토큰, 네이티브 ETH, Arbitrum USDT
const PINNED_SYMBOLS = ["ETH", "WETH", "USDC", "USDT", "DAI"] as const;
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const NATIVE_ETH_DECIMALS = 18;
const ARBITRUM_USDT0 = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";

// 심볼을 덮어쓰기 전의 스냅샷
const SNAPSHOTS = { 1: mainnetSnapshot, 8453: baseSnapshot, 42161: arbitrumSnapshot };

const tokenKey = (token: { chainId: number; address: string }) =>
  `${token.chainId}:${token.address.toLowerCase()}`;

describe("체인별 토큰 목록 — 세 체인에서 같은 토큰이 겹치지 않고 고정 토큰을 쓸 수 있다", () => {
  describe("토큰 키", () => {
    /**
     * @spec DoD-3
     * @given Ethereum(1), Base(8453), Arbitrum(42161)의 토큰 목록을 하나씩 확인한다
     * @when 목록의 토큰을 `chainId` + `address` 키로 모은다
     * @then 키가 중복되지 않는다
     * @then 각 목록의 토큰 chainId가 모두 그 체인이다
     */
    it("[DoD-3] 체인별 토큰 목록에 chainId + address 키 중복이 없다", () => {
      for (const chainId of EXPECTED_CHAIN_IDS) {
        const tokens = TOKENS_BY_CHAIN[chainId];
        expect(tokens.length, `체인 ${chainId}의 토큰 목록`).toBeGreaterThan(0);

        const keys = tokens.map(tokenKey);
        const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
        expect(duplicates, `체인 ${chainId}의 중복 키`).toEqual([]);

        const otherChain = tokens.filter((token) => token.chainId !== chainId);
        expect(otherChain, `체인 ${chainId} 목록의 다른 체인 토큰`).toEqual([]);
      }
    });
  });

  describe("고정 토큰", () => {
    /**
     * @spec DoD-4
     * @given Ethereum(1), Base(8453), Arbitrum(42161)의 고정 토큰 목록을 하나씩 확인한다
     * @when 고정 토큰 목록을 읽는다
     * @then 고정 토큰 목록에 ETH, WETH, USDC, USDT, DAI가 있다
     * @then 각 고정 토큰이 같은 체인의 토큰 목록에 chainId + address 키로 있다
     * @then ETH를 뺀 각 고정 토큰의 symbol·decimals가 같은 키의 스냅샷 항목과 같다. 비교 기준은 심볼을 덮어쓰기 전의 스냅샷이다. 단 Arbitrum USDT의 심볼은 별도 case의 규칙을 따른다
     * @then ETH의 주소는 네이티브 ETH 주소 `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE`다
     * @then 각 체인 ETH의 decimals는 18이다
     */
    it("[DoD-4] 체인별 고정 토큰 목록에 ETH, WETH, USDC, USDT, DAI가 있다", () => {
      for (const chainId of EXPECTED_CHAIN_IDS) {
        const pinned = PINNED_TOKENS_BY_CHAIN[chainId];
        const tokenKeys = new Set(TOKENS_BY_CHAIN[chainId].map(tokenKey));
        const snapshotByKey = new Map(SNAPSHOTS[chainId].map((token) => [tokenKey(token), token]));

        expect(
          pinned.map((token) => token.symbol),
          `체인 ${chainId}의 고정 토큰 심볼`,
        ).toEqual(expect.arrayContaining([...PINNED_SYMBOLS]));

        for (const token of pinned) {
          const label = `체인 ${chainId}의 고정 토큰 ${token.symbol}`;
          expect(token.chainId, label).toBe(chainId);
          expect(tokenKeys.has(tokenKey(token)), `${label}이 토큰 목록에 있음`).toBe(true);

          if (token.symbol === "ETH") continue;

          const snapshotToken = snapshotByKey.get(tokenKey(token));
          expect(snapshotToken, `${label}의 스냅샷 항목`).toBeDefined();
          expect(token.decimals, `${label}의 decimals`).toBe(snapshotToken?.decimals);
          const isArbitrumUsdt =
            chainId === 42161 && token.address.toLowerCase() === ARBITRUM_USDT0.toLowerCase();
          if (!isArbitrumUsdt) {
            expect(token.symbol, `${label}의 symbol`).toBe(snapshotToken?.symbol);
          }
        }

        const eth = pinned.filter((token) => token.symbol === "ETH");
        expect(eth, `체인 ${chainId}의 고정 ETH`).toHaveLength(1);
        expect(eth[0]?.address, `체인 ${chainId}의 ETH 주소`).toBe(NATIVE_ETH);
        expect(eth[0]?.decimals, `체인 ${chainId}의 ETH decimals`).toBe(NATIVE_ETH_DECIMALS);
      }
    });

    /**
     * @spec DoD-4
     * @given Arbitrum(42161)의 고정 토큰 목록을 확인한다
     * @when 고정 토큰 USDT를 찾는다
     * @then 주소는 리스트의 `USDT0` 주소 `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`다
     * @then 심볼 값은 `USDT`다
     */
    it("[DoD-4] Arbitrum의 고정 토큰 USDT는 USDT0 주소를 쓰고 심볼 값은 USDT다", () => {
      const usdt = PINNED_TOKENS_BY_CHAIN[42161].filter((token) => token.symbol === "USDT");
      expect(usdt).toHaveLength(1);
      expect(usdt[0]?.address).toBe(ARBITRUM_USDT0);
      expect(usdt[0]?.symbol).toBe("USDT");

      const listed = SNAPSHOTS[42161].find((token) => token.address === ARBITRUM_USDT0);
      expect(listed?.symbol, "리스트의 원래 심볼").toBe("USDT0");
    });
  });
});
