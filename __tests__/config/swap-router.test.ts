import { getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";

import { CONTRACTS_BY_CHAIN } from "@/config/contracts";

// 골격(T-6). 기대 주소는 스펙 §4.1의 리터럴로 두고 제품 상수에서 가져오지 않는다.
// 스펙 §4.1: Ethereum(1)·Arbitrum(42161) `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, Base(8453) `0x2626664c2603336E57B271c5C0b26F421741e481`
const EXPECTED_SWAP_ROUTER02_BY_CHAIN = [
  [1, "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
  [8453, "0x2626664c2603336E57B271c5C0b26F421741e481"],
  [42161, "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"],
] as const;

describe("스왑 라우터 config — 세 체인에서 approve·swap이 보낼 SwapRouter02 주소를 안다", () => {
  describe("주소 형식", () => {
    /**
     * @spec DoD-1
     * @given Ethereum(1), Base(8453), Arbitrum(42161) 세 체인의 `ChainContracts.swapRouter02`를 하나씩 반복하고, 기대 주소는 스펙 §4.1의 리터럴(Ethereum·Arbitrum `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, Base `0x2626664c2603336E57B271c5C0b26F421741e481`)이다
     * @when 체인의 컨트랙트 config에서 `swapRouter02`를 읽는다
     * @then 세 체인 모두 `swapRouter02` 값이 있고 스펙 §4.1의 해당 체인 리터럴과 같다
     * @then 세 체인의 `swapRouter02`가 모두 EIP-55 체크섬 주소다
     */
    it("[DoD-1] 세 체인의 swapRouter02가 스펙 주소이고 EIP-55 체크섬 주소다", () => {
      for (const [chainId, expected] of EXPECTED_SWAP_ROUTER02_BY_CHAIN) {
        const contracts = CONTRACTS_BY_CHAIN[chainId];
        expect(contracts, `체인 ${chainId}의 컨트랙트 config`).toBeDefined();

        const swapRouter02: string | undefined = contracts.swapRouter02;
        expect(typeof swapRouter02, `체인 ${chainId}의 swapRouter02 값`).toBe("string");
        expect(swapRouter02, `체인 ${chainId}의 swapRouter02 주소`).toBe(expected);

        const address = swapRouter02 ?? "";
        expect(isAddress(address, { strict: true }), `체인 ${chainId}의 swapRouter02 체크섬`).toBe(
          true,
        );
        expect(address, `체인 ${chainId}의 swapRouter02 EIP-55 형식`).toBe(getAddress(address));
      }
    });
  });
});
