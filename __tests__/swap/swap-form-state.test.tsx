import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { arbitrum, base, mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupportedChainId } from "@/config/chains";
import { PINNED_TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { createWagmiConfig } from "@/config/wagmi";
import { useSelectedChain } from "@/providers/selected-chain-provider";
import { useSwapForm } from "@/providers/swap-form-provider";

import { installBalanceRpcStub, sameAddress } from "../support/rpc-balance-stub";
import {
  clearCookies,
  createNoopWagmiStorage,
  renderAppHook,
  waitUntil,
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 화면 식별자(스펙 §4.2)와 useSwapForm()(§4.3)을 함께 관찰한다.
// 이 파일의 표본은 모두 미연결이라 잔액 RPC 요청이 없다. 그래도 잘못된 요청이 실제 네트워크로 나가지 않도록 RPC 스텁을 둔다.

const CASE_TIMEOUT_MS = 30_000;

beforeEach(() => {
  installBalanceRpcStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
});

type Side = "in" | "out";

const ETHEREUM_PINNED = PINNED_TOKENS_BY_CHAIN[mainnet.id];
const USDC = ETHEREUM_PINNED[2];
const DAI = ETHEREUM_PINNED[4];

function nativeEth(chainId: SupportedChainId): Token {
  const eth = PINNED_TOKENS_BY_CHAIN[chainId][0];
  expect(eth.symbol).toBe("ETH");
  return eth;
}

function field(side: Side): HTMLElement {
  const found = screen
    .getAllByTestId("token-field")
    .find((element) => element.getAttribute("data-side") === side);
  if (!found) throw new Error(`token-field[data-side="${side}"]가 없다`);
  return found;
}

function tokenAddress(side: Side): string | null {
  return within(field(side)).getByTestId("token-button").getAttribute("data-token-address");
}

function amountInput(side: Side): HTMLInputElement {
  return within(field(side)).getByTestId("amount-input") as HTMLInputElement;
}

function tokenModal(): HTMLElement | null {
  return screen.queryByTestId("token-modal");
}

function optionRow(address: string): HTMLElement {
  const modal = tokenModal();
  const row = modal
    ? within(modal)
        .queryAllByTestId("token-option")
        .find((element) =>
          sameAddress(element.getAttribute("data-token-address") ?? undefined, address),
        )
    : undefined;
  if (!row) throw new Error(`token-option ${address}가 없다`);
  return row;
}

async function chooseToken(side: Side, token: Token) {
  fireEvent.click(within(field(side)).getByTestId("token-button"));
  await waitUntil(() => expect(tokenModal()?.getAttribute("data-side")).toBe(side));
  fireEvent.click(optionRow(token.address));
  await waitUntil(() => expect(tokenModal()).toBeNull());
  expect(tokenAddress(side)).toBe(token.address);
}

function typeAmount(value: string) {
  fireEvent.change(amountInput("in"), { target: { value } });
}

function useProbe() {
  return { form: useSwapForm(), selected: useSelectedChain() };
}

// 저장된 연결이 없는 앱. 커넥터가 없어 복원 시도가 곧 끝나고 미연결이 된다.
async function renderDisconnectedApp(initialChainId: SupportedChainId) {
  const config = createWagmiConfig({
    connectors: [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderAppHook(useProbe, { config, initialChainId });
  await waitUntil(() =>
    expect(screen.getByTestId("primary-button").getAttribute("data-state")).toBe("disconnected"),
  );
  return view;
}

describe("입력 상태 — 페이지가 정한 토큰·금액을 견적 단계가 그대로 읽는다", () => {
  describe("페이지를 처음 여는 경우", () => {
    /**
     * @spec DoD-1 DoD-39
     * @given 저장된 연결이 없다. 표본: 선택 체인 Ethereum, Base, Arbitrum을 하나씩 반복한다
     * @when 앱을 렌더링하고 앱 Provider 안에서 useSwapForm()을 읽는다
     * @then 보내는 칸 token-button의 data-token-address가 선택 체인 ETH 주소다
     * @then 받는 칸 token-button의 data-token-address가 빈 문자열이다
     * @then 보내는 칸 amount-input 값이 빈 값이다
     * @then useSwapForm()의 chainId가 선택 체인 ID다
     * @then useSwapForm()의 tokenIn이 선택 체인 토큰 목록의 ETH 토큰이다
     * @then useSwapForm()의 tokenOut이 null이다
     * @then useSwapForm()의 amountIn이 빈 문자열이다
     * @then useSwapForm()의 amountInRaw가 null이다
     */
    it(
      "[DoD-1][DoD-39] 보내는 토큰은 선택 체인의 ETH, 받는 토큰은 미선택, 금액은 빈 값으로 시작한다",
      async () => {
        for (const chainId of [mainnet.id, base.id, arbitrum.id] as const) {
          const label = `선택 체인 ${chainId}`;
          const { result } = await renderDisconnectedApp(chainId);
          const eth = nativeEth(chainId);

          expect(tokenAddress("in"), label).toBe(eth.address);
          expect(tokenAddress("out"), label).toBe("");
          expect(amountInput("in").value, label).toBe("");

          const form = result.current.form;
          expect(form.chainId, label).toBe(chainId);
          expect(form.tokenIn, label).toEqual(eth);
          expect(form.tokenOut, label).toBeNull();
          expect(form.amountIn, label).toBe("");
          expect(form.amountInRaw, label).toBeNull();

          cleanup();
          clearCookies();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("토큰과 금액을 정한 경우", () => {
    /**
     * @spec DoD-39
     * @given 선택 체인이 Ethereum이다. 표본(대표만): 보내는 USDC(decimals 6)·받는 DAI·금액 `1.5`, 보내는 ETH(decimals 18)·받는 USDC·금액 `0.000000000000000001`, `1.`, `.5`를 하나씩 반복한다
     * @when 화면에서 표본 토큰을 고르고 금액을 입력한 뒤 useSwapForm()을 읽는다
     * @then tokenIn·tokenOut이 고른 토큰(체인 ID·주소·decimals가 같음)이다
     * @then amountIn이 입력한 문자열 그대로다
     * @then amountInRaw가 금액을 tokenIn.decimals로 변환한 정수(`1.5`는 `1500000n`, `0.000000000000000001`은 `1n`, `1.`은 `1000000000000000000n`, `.5`는 `500000000000000000n`)다
     */
    it(
      "[DoD-39] 고른 토큰과 입력 금액, decimals로 변환한 정수를 돌려준다",
      async () => {
        const eth = nativeEth(mainnet.id);
        const samples = [
          { tokenIn: USDC, tokenOut: DAI, amount: "1.5", raw: 1_500_000n },
          { tokenIn: eth, tokenOut: USDC, amount: "0.000000000000000001", raw: 1n },
          { tokenIn: eth, tokenOut: USDC, amount: "1.", raw: 1_000_000_000_000_000_000n },
          { tokenIn: eth, tokenOut: USDC, amount: ".5", raw: 500_000_000_000_000_000n },
        ];
        expect(USDC.decimals).toBe(6);
        expect(eth.decimals).toBe(18);

        for (const sample of samples) {
          const label = `${sample.tokenIn.symbol}→${sample.tokenOut.symbol} ${sample.amount}`;
          const { result } = await renderDisconnectedApp(mainnet.id);
          if (sample.tokenIn.address !== eth.address) await chooseToken("in", sample.tokenIn);
          await chooseToken("out", sample.tokenOut);
          typeAmount(sample.amount);
          await waitUntil(() => expect(result.current.form.amountIn).toBe(sample.amount));

          const form = result.current.form;
          for (const [actual, expected] of [
            [form.tokenIn, sample.tokenIn],
            [form.tokenOut, sample.tokenOut],
          ] as const) {
            expect(actual?.chainId, label).toBe(expected.chainId);
            expect(actual?.address, label).toBe(expected.address);
            expect(actual?.decimals, label).toBe(expected.decimals);
          }
          expect(form.amountIn, label).toBe(sample.amount);
          expect(form.amountInRaw, label).toBe(sample.raw);

          cleanup();
          clearCookies();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("선택 체인이 바뀌는 경우", () => {
    /**
     * @spec EC-1
     * @given 선택 체인이 Ethereum이고 보내는 USDC, 받는 DAI, 금액 `1.5`가 정해져 있다
     * @when 선택 체인을 Base로 바꾼다
     * @then 보내는 칸 token-button의 data-token-address가 Base ETH 주소다
     * @then 받는 칸 token-button의 data-token-address가 빈 문자열이다
     * @then 보내는 칸 amount-input 값이 빈 값이다
     * @then useSwapForm()이 chainId 8453, tokenIn Base ETH 토큰, tokenOut null, amountIn 빈 문자열, amountInRaw null을 돌려준다
     */
    it(
      "[EC-1] 선택 체인을 바꾸면 토큰과 금액이 처음 연 상태의 기본값으로 돌아간다",
      async () => {
        const { result } = await renderDisconnectedApp(mainnet.id);
        await chooseToken("in", USDC);
        await chooseToken("out", DAI);
        typeAmount("1.5");
        await waitUntil(() => expect(amountInput("in").value).toBe("1.5"));

        act(() => result.current.selected.setSelectedChainId(base.id));

        const baseEth = nativeEth(base.id);
        await waitUntil(() => expect(tokenAddress("in")).toBe(baseEth.address));
        expect(tokenAddress("out")).toBe("");
        expect(amountInput("in").value).toBe("");

        const form = result.current.form;
        expect(form.chainId).toBe(base.id);
        expect(form.tokenIn).toEqual(baseEth);
        expect(form.tokenOut).toBeNull();
        expect(form.amountIn).toBe("");
        expect(form.amountInRaw).toBeNull();
      },
      CASE_TIMEOUT_MS,
    );
  });
});
