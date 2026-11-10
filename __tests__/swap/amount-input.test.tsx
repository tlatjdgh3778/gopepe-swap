import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { mainnet } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PINNED_TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import { createWagmiConfig } from "@/config/wagmi";

import { installBalanceRpcStub, sameAddress } from "../support/rpc-balance-stub";
import {
  clearCookies,
  createNoopWagmiStorage,
  renderApp,
  settlePendingWork,
  waitUntil,
} from "../support/wagmi-harness";

// 앱 전체(실제 wagmi·Provider·화면)를 렌더링하고 금액 칸(`amount-input`)의 값으로 판정한다.
// 금액 입력은 연결 여부와 관계없이 같으므로(EC-3) 미연결 앱으로 확인한다. RPC는 전역 fetch 스텁이 받는다.

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
const ETH = ETHEREUM_PINNED[0];
const USDC = ETHEREUM_PINNED[2];

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

function typeInto(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

// 입력 칸 전체가 선택된 상태에서 붙여넣으면 브라우저는 paste 이벤트 뒤에 칸 값을 붙여넣은 문자열로 바꾸는 입력 이벤트를 보낸다.
function pasteReplacingAll(input: HTMLInputElement, text: string) {
  input.focus();
  input.select();
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
  fireEvent.change(input, { target: { value: text } });
}

// 저장된 연결이 없는 앱. 커넥터가 없어 복원 시도가 곧 끝나고 미연결이 된다.
async function renderDisconnectedApp() {
  const config = createWagmiConfig({
    connectors: [],
    storage: createNoopWagmiStorage(),
    multiInjectedProviderDiscovery: false,
  });
  const view = renderApp({ config, initialChainId: mainnet.id });
  await waitUntil(() =>
    expect(screen.getByTestId("primary-button").getAttribute("data-state")).toBe("disconnected"),
  );
  expect(tokenAddress("in")).toBe(ETH.address);
  return view;
}

function resetSample() {
  cleanup();
  clearCookies();
}

describe("금액 입력 — 사용자가 보낼 금액을 형식에 맞게 입력한다", () => {
  describe("보내는 칸에 직접 입력하는 경우", () => {
    /**
     * @spec DoD-27
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰이 ETH, 금액이 빈 값이다. 표본(대표만, 규칙 전체 표본은 단위 테스트가 맡는다): `12`, `0.5`를 하나씩 반복한다
     * @when 보내는 칸 amount-input에 표본을 입력한다
     * @then 보내는 칸 amount-input 값이 표본 문자열 그대로다
     */
    it(
      "[DoD-27] 숫자와 소수점 하나로 된 입력을 금액에 반영한다",
      async () => {
        for (const sample of ["12", "0.5"]) {
          await renderDisconnectedApp();
          expect(amountInput("in").value, sample).toBe("");

          typeInto(amountInput("in"), sample);

          await waitUntil(() => expect(amountInput("in").value, sample).toBe(sample));
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-20 EC-21
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰이 USDC(decimals 6)이며 금액 `1.123456`이 입력돼 있다. 표본(대표만, 규칙 전체 표본은 단위 테스트가 맡는다): `7`(decimals를 넘는 소수 자릿수, EC-20), `a`(숫자·소수점·쉼표 외의 문자, EC-21), `.`(두 번째 소수점, EC-21)을 하나씩 반복한다
     * @when 보내는 칸 amount-input 끝에 표본 문자를 이어 입력한다
     * @then 보내는 칸 amount-input 값이 `1.123456` 그대로다
     */
    it(
      "[EC-20][EC-21] decimals를 넘는 소수 자릿수나 허용 외 문자·두 번째 소수점이 든 입력은 반영하지 않고 이전 값을 유지한다",
      async () => {
        expect(USDC.decimals).toBe(6);
        await renderDisconnectedApp();
        await chooseToken("in", USDC);
        typeInto(amountInput("in"), "1.123456");
        await waitUntil(() => expect(amountInput("in").value).toBe("1.123456"));

        for (const sample of ["7", "a", "."]) {
          typeInto(amountInput("in"), `1.123456${sample}`);
          await settlePendingWork();
          expect(amountInput("in").value, sample).toBe("1.123456");
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-19
     * @given 앱이 Ethereum으로 렌더링됐고 flip-button을 눌러 보내는 칸 토큰이 미선택이다
     * @when 보내는 칸 amount-input에 `1`을 입력하려 한다
     * @then 보내는 칸 amount-input이 비활성(disabled)이다
     * @then 보내는 칸 amount-input 값이 빈 값 그대로다
     */
    it(
      "[EC-19] 보내는 토큰이 미선택이면 금액 입력을 비활성화한다",
      async () => {
        await renderDisconnectedApp();
        fireEvent.click(screen.getByTestId("flip-button"));
        await waitUntil(() => expect(tokenAddress("in")).toBe(""));

        typeInto(amountInput("in"), "1");

        expect(amountInput("in").disabled).toBe(true);
        await settlePendingWork();
        expect(amountInput("in").value).toBe("");
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("보내는 칸에 붙여넣는 경우", () => {
    /**
     * @spec EC-22
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰이 ETH, 금액 `1`이 입력돼 있고 입력 칸 전체가 선택돼 있다. 표본: `2.5`, `2,5`(쉼표는 소수점으로 바뀐다)를 하나씩 반복한다
     * @when 표본 문자열을 붙여넣는다
     * @then 보내는 칸 amount-input 값이 `2.5`다
     */
    it(
      "[EC-22] 전체가 형식에 맞는 붙여넣기는 반영한다",
      async () => {
        for (const sample of ["2.5", "2,5"]) {
          await renderDisconnectedApp();
          typeInto(amountInput("in"), "1");
          await waitUntil(() => expect(amountInput("in").value, sample).toBe("1"));

          pasteReplacingAll(amountInput("in"), sample);

          await waitUntil(() => expect(amountInput("in").value, sample).toBe("2.5"));
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );

    /**
     * @spec EC-22
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰이 ETH, 금액 `1`이 입력돼 있고 입력 칸 전체가 선택돼 있다. 표본: `1,000.50`(소수점이 둘), `12abc`, `1.5 ETH`를 하나씩 반복한다
     * @when 표본 문자열을 붙여넣는다
     * @then 보내는 칸 amount-input 값이 `1` 그대로다
     */
    it(
      "[EC-22] 일부라도 형식에 맞지 않는 붙여넣기는 반영하지 않고 이전 값을 유지한다",
      async () => {
        for (const sample of ["1,000.50", "12abc", "1.5 ETH"]) {
          await renderDisconnectedApp();
          typeInto(amountInput("in"), "1");
          await waitUntil(() => expect(amountInput("in").value, sample).toBe("1"));

          pasteReplacingAll(amountInput("in"), sample);

          await settlePendingWork();
          expect(amountInput("in").value, sample).toBe("1");
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("보내는 토큰을 모달에서 바꾸는 경우", () => {
    /**
     * @spec DoD-29
     * @given 앱이 Ethereum으로 렌더링됐고 보내는 칸 토큰이 ETH(decimals 18), 받는 칸은 미선택이다. 표본: 금액 `1.1234569`(USDC decimals 6을 넘는다, 반올림하면 `1.123457`), `2.5`(넘지 않는다)를 하나씩 반복한다
     * @when 보내는 칸 모달에서 USDC를 고른다
     * @then 보내는 칸 token-button의 data-token-address가 USDC다
     * @then 보내는 칸 amount-input 값이 `1.1234569` 표본에서는 `1.123456`, `2.5` 표본에서는 `2.5`다
     */
    it(
      "[DoD-29] 보내는 토큰을 바꾸면 금액을 유지하고 새 decimals를 넘는 자릿수를 반올림 없이 자른다",
      async () => {
        expect(ETH.decimals).toBe(18);
        expect(USDC.decimals).toBe(6);
        const samples = [
          { amount: "1.1234569", expected: "1.123456" },
          { amount: "2.5", expected: "2.5" },
        ];

        for (const sample of samples) {
          await renderDisconnectedApp();
          expect(tokenAddress("out"), sample.amount).toBe("");
          typeInto(amountInput("in"), sample.amount);
          await waitUntil(() => expect(amountInput("in").value, sample.amount).toBe(sample.amount));

          await chooseToken("in", USDC);

          expect(tokenAddress("in"), sample.amount).toBe(USDC.address);
          expect(amountInput("in").value, sample.amount).toBe(sample.expected);
          resetSample();
        }
      },
      CASE_TIMEOUT_MS,
    );
  });

  describe("받는 칸 금액 칸", () => {
    /**
     * @spec DoD-33
     * @given 앱이 Ethereum으로 렌더링됐고 받는 칸에 USDC가 선택돼 있다
     * @when 받는 칸 amount-input에 `1`을 입력하려 한다
     * @then 받는 칸 amount-input이 읽기 전용(readonly)이다
     * @then 받는 칸 amount-input 값이 입력 전 값 그대로다
     */
    it(
      "[DoD-33] 받는 칸 금액 칸은 사용자 입력을 받지 않는다",
      async () => {
        await renderDisconnectedApp();
        await chooseToken("out", USDC);
        const before = amountInput("out").value;

        typeInto(amountInput("out"), "1");

        expect(amountInput("out").readOnly).toBe(true);
        await settlePendingWork();
        expect(amountInput("out").value).toBe(before);
      },
      CASE_TIMEOUT_MS,
    );
  });
});
