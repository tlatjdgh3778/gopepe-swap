import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";

import { CHAINS_BY_ID, SUPPORTED_CHAIN_IDS } from "@/config/chains";
import { CONTRACTS_BY_CHAIN } from "@/config/contracts";
import { NATIVE_ETH_ADDRESS, PINNED_TOKENS_BY_CHAIN, TOKENS_BY_CHAIN } from "@/config/tokens";
import arbitrumSnapshot from "@/config/tokens-42161.json";
import baseSnapshot from "@/config/tokens-8453.json";
import mainnetSnapshot from "@/config/tokens-1.json";

// 스펙 §1: Ethereum(1), Base(8453), Arbitrum(42161)
const EXPECTED_CHAIN_IDS = [1, 8453, 42161] as const;

describe("체인별 config — 이후 기능이 세 체인의 컨트랙트 정보 위에 올라간다", () => {
  describe("체인 정보", () => {
    /**
     * @spec DoD-1
     * @given Ethereum(1), Base(8453), Arbitrum(42161) 세 체인의 config를 하나씩 확인한다
     * @when 체인의 config를 읽는다
     * @then 체인의 config에 체인 ID가 있고 값이 해당 체인의 ID와 같다
     * @then 체인의 config에 QuoterV2, Factory, WETH 주소가 있다
     */
    it("[DoD-1] 세 체인의 config에 체인 ID, QuoterV2, Factory, WETH가 있다", () => {
      expect([...SUPPORTED_CHAIN_IDS].sort((a, b) => a - b)).toEqual([...EXPECTED_CHAIN_IDS]);

      for (const chainId of EXPECTED_CHAIN_IDS) {
        expect(CHAINS_BY_ID[chainId]?.id, `체인 ${chainId}의 체인 config`).toBe(chainId);

        const contracts = CONTRACTS_BY_CHAIN[chainId];
        expect(contracts, `체인 ${chainId}의 컨트랙트 config`).toBeDefined();
        expect(contracts.chainId, `체인 ${chainId}의 컨트랙트 config 체인 ID`).toBe(chainId);
        for (const [name, address] of [
          ["QuoterV2", contracts.quoterV2],
          ["Factory", contracts.factory],
          ["WETH", contracts.weth],
        ] as const) {
          expect(isAddress(address, { strict: false }), `체인 ${chainId}의 ${name} 주소`).toBe(
            true,
          );
        }
      }
    });
  });

  describe("주소 형식", () => {
    /**
     * @spec DoD-2
     * @given 세 체인의 QuoterV2, Factory, WETH 주소와 세 체인 토큰 목록과 고정 토큰 목록의 모든 토큰 주소(네이티브 ETH 포함)를 하나씩 확인한다
     * @when 주소의 EIP-55 체크섬을 검사한다
     * @then 모든 주소가 EIP-55 체크섬을 통과한다
     */
    it("[DoD-2] config의 모든 주소가 EIP-55 체크섬을 통과한다", () => {
      const addresses: { label: string; address: string }[] = [
        { label: "네이티브 ETH", address: NATIVE_ETH_ADDRESS },
      ];
      const snapshots = { 1: mainnetSnapshot, 8453: baseSnapshot, 42161: arbitrumSnapshot };

      for (const chainId of EXPECTED_CHAIN_IDS) {
        const contracts = CONTRACTS_BY_CHAIN[chainId];
        addresses.push(
          { label: `${chainId} QuoterV2`, address: contracts.quoterV2 },
          { label: `${chainId} Factory`, address: contracts.factory },
          { label: `${chainId} WETH`, address: contracts.weth },
        );

        const tokens = TOKENS_BY_CHAIN[chainId];
        const pinned = PINNED_TOKENS_BY_CHAIN[chainId];
        expect(tokens.length, `체인 ${chainId}의 토큰 목록`).toBeGreaterThan(0);
        expect(pinned.length, `체인 ${chainId}의 고정 토큰 목록`).toBeGreaterThan(0);
        expect(
          tokens.some((token) => token.address === NATIVE_ETH_ADDRESS),
          `체인 ${chainId}의 토큰 목록에 네이티브 ETH 포함`,
        ).toBe(true);

        for (const token of tokens) {
          addresses.push({ label: `${chainId} 토큰 ${token.symbol}`, address: token.address });
        }
        for (const token of pinned) {
          addresses.push({ label: `${chainId} 고정 토큰 ${token.symbol}`, address: token.address });
        }
        for (const token of snapshots[chainId]) {
          addresses.push({ label: `${chainId} 스냅샷 ${token.symbol}`, address: token.address });
        }
      }

      for (const { label, address } of addresses) {
        expect(isAddress(address, { strict: true }), label).toBe(true);
        expect(address, label).toBe(getAddress(address));
      }
    });
  });
});
