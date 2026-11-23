import { type Locator, type Page, expect } from "@playwright/test";

// F10 network-fee E2E 보조.

// 주 버튼이 `approve-required`·`swap-ready`·`wrap-ready`가 된 뒤 추정(`eth_estimateGas`)과 가스 가격(`eth_gasPrice`)이
// 끝나 수수료 행이 `success`가 될 때까지. cold 첫 추정 최대 약 2.9초(F10 T-1 (6))와 브라우저·프록시 왕복을 넉넉하게 덮는다.
export const NETWORK_FEE_SETTLE_TIMEOUT_MS = 20_000;

// 수수료 행(F10 스펙 §4.4 식별자).
export function networkFee(page: Page): Locator {
  return page.getByTestId("network-fee");
}

// `network-fee[data-kind]` 값(F10 스펙 §4.4).
export type NetworkFeeKind = "approve" | "swap" | "wrap" | "unwrap";

// `data-fee-wei`는 `feeWei`의 10진 문자열이다(F10 DoD-13). 0보다 큰 값만 맞는다(앞자리 0 없음, "0" 불일치).
export const POSITIVE_FEE_WEI_PATTERN = /^[1-9]\d*$/;

type NetworkFeeAttributes = { kind: string | null; state: string | null; feeWei: string | null };

// 수수료 행의 `data-kind`·`data-state`·`data-fee-wei`를 한 번에 읽는다(세 속성이 같은 시점의 값이 되도록).
// 행이 없으면 null이다. 기다리지 않는다.
async function readNetworkFeeAttributes(page: Page): Promise<NetworkFeeAttributes | null> {
  const rows = await networkFee(page).evaluateAll((elements) =>
    elements.map((element) => ({
      kind: element.getAttribute("data-kind"),
      state: element.getAttribute("data-state"),
      feeWei: element.getAttribute("data-fee-wei"),
    })),
  );
  if (rows.length > 1) throw new Error(`[e2e] network-fee 행이 ${rows.length}개다`);
  return rows[0] ?? null;
}

// 수수료 행이 기대 종류(`data-kind`)이고 `data-state=success`이며 `data-fee-wei`가 0보다 큰 10진 정수가 될 때까지 기다린다.
// 세 속성을 같은 시점에 읽어 판정한다. 값은 러너 계산값과 비교하지 않는다(F10 T-14 사용자 확정: `--block-time 1`에서
// `eth_gasPrice`가 블록마다 바뀐다, T-1 (7)).
export async function expectNetworkFeeSuccess(
  page: Page,
  kind: NetworkFeeKind,
  timeout: number,
): Promise<void> {
  await expect
    .poll(() => readNetworkFeeAttributes(page), {
      message: `network-fee가 data-kind=${kind}·data-state=success이고 data-fee-wei > 0`,
      timeout,
    })
    .toMatchObject({
      kind,
      state: "success",
      feeWei: expect.stringMatching(POSITIVE_FEE_WEI_PATTERN),
    });
}
