import type { Hash } from "viem";
import { describe, expect, it } from "vitest";

import { getTxExplorerUrl } from "@/lib/tx-explorer";

// 기대 URL은 스펙 DoD-6의 리터럴로 두고 제품 상수에서 가져오지 않는다.
const SAMPLE_HASH: Hash = "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060";

// 스펙 DoD-6: Ethereum `https://etherscan.io/tx/{hash}`, Base `https://basescan.org/tx/{hash}`, Arbitrum `https://arbiscan.io/tx/{hash}`
const EXPECTED_TX_URL_BY_CHAIN = [
  [1, `https://etherscan.io/tx/${SAMPLE_HASH}`],
  [8453, `https://basescan.org/tx/${SAMPLE_HASH}`],
  [42161, `https://arbiscan.io/tx/${SAMPLE_HASH}`],
] as const;

describe("블록 탐색기 링크 — 사용자가 세 체인의 트랜잭션을 탐색기에서 확인할 수 있다", () => {
  describe("트랜잭션 URL 만들기", () => {
    /**
     * @spec DoD-6
     * @given 트랜잭션 해시 표본 하나와 Ethereum(1), Base(8453), Arbitrum(42161) 세 체인을 하나씩 반복한다
     * @when 체인과 해시로 탐색기 tx URL을 만든다
     * @then Ethereum은 `https://etherscan.io/tx/{hash}`다
     * @then Base는 `https://basescan.org/tx/{hash}`다
     * @then Arbitrum은 `https://arbiscan.io/tx/{hash}`다
     */
    it("[DoD-6] 세 체인의 tx URL이 각 체인 탐색기의 /tx/{hash}다", () => {
      for (const [chainId, expected] of EXPECTED_TX_URL_BY_CHAIN) {
        expect(getTxExplorerUrl(chainId, SAMPLE_HASH), `체인 ${chainId}의 tx URL`).toBe(expected);
      }
    });
  });
});
