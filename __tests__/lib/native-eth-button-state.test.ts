import { describe, expect, it } from "vitest";

import type { SupportedChainId } from "@/config/chains";
import type { SwapQuoteState } from "@/lib/swap-quote";

import { PINNED_TOKENS_BY_CHAIN, type Token } from "@/config/tokens";
import {
  type PrimaryButtonSourceParams,
  type PrimaryButtonState,
  type SwapExecutionPhase,
  getPrimaryButtonState,
  getPrimaryButtonStateParams,
  isPrimaryButtonEnabled,
} from "@/lib/primary-button-state";

// 골격(T-5). 주 버튼 상태 판정의 순수 규칙만 다룬다.
// 판정 방법: 표본마다 판정 입력(지갑, phase, 토큰, 금액·잔액, 견적, 가격 영향, 최소 수령량, allowance)을
// 정적 값으로 만들어 주 버튼 상태 판정 순수 함수에 넣고, 결과 상태와 활성 여부를 스펙 리터럴과 비교한다.
// 기대 상태 이름과 순서는 스펙 DoD-6 리터럴로 적고 제품 상태 목록에서 가져오지 않는다.
// mock 경계(D-3 사용자 확정, 2026-11-20): 없음. 순수 함수와 정적 표본만 쓰고 vi.mock·스텁·타이머를 쓰지 않는다.
// 데이터 격리: 정적 데이터만 쓰며 표본 사이에 공유 상태가 없다.
// 화면에서의 활성·문구·실제 견적·allowance 흐름은 통합 테스트(T-6·T-7)가 다룬다.

// 스펙 DoD-6 순서 리터럴. 제품의 `PRIMARY_BUTTON_STATES`에서 가져오지 않는다.
const SPEC_ORDER = [
  "restoring",
  "disconnected",
  "awaiting-signature",
  "approving",
  "swapping",
  "wrapping",
  "unwrapping",
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "wrap-ready",
  "unwrap-ready",
  "price-impact-too-high",
  "amount-too-small",
  "allowance-error",
  "checking-allowance",
  "approve-required",
  "swap-ready",
] as const satisfies readonly PrimaryButtonState[];

type State = (typeof SPEC_ORDER)[number];

// ─── 표본 ───────────────────────────────────────────────────────────
// 표본은 화면의 원래 값(지갑, phase, 토큰, 금액·잔액, 견적, 최소 수령량, allowance)을 이름으로 적고,
// `toSourceParams`가 정수 값으로 바꿔 `getPrimaryButtonStateParams` → `getPrimaryButtonState`로 판정한다.

type TokenName = "ETH" | "WETH" | "USDC" | "DAI";

type Sample = {
  wallet: "restoring" | "disconnected" | "connected";
  phase: SwapExecutionPhase;
  // 고정 토큰 심볼. ETH는 네이티브 ETH, WETH·USDC·DAI는 ERC-20.
  tokenIn: TokenName | null;
  tokenOut: TokenName | null;
  // empty: 빈 값, zero: 0, valid: 잔액보다 작음, equal: 잔액과 같음, over: 금액 정수 > 잔액 정수.
  amount: "empty" | "zero" | "valid" | "equal" | "over";
  quote: "idle" | "loading" | "no-route" | "error" | "success" | "wrap";
  // 견적 `success`의 가격 영향 등급.
  severity: "normal" | "warning" | "error" | null;
  // `useAmountOutMinimum()`.
  minimum: "positive" | "zero" | null;
  // error·loading: 현재 키에 성공 값 없이 읽기 실패·읽는 중. zero·below·equal·above: 성공 값과 `amountInRaw`의 대소.
  allowance: "idle" | "error" | "loading" | "zero" | "below" | "equal" | "above";
  // 토큰을 고를 체인. 없으면 Ethereum.
  chainId?: SupportedChainId;
};

type LaterPart = Omit<Sample, "wallet" | "phase">;

function pinnedOf(chainId: SupportedChainId, symbol: TokenName): Token {
  const token = PINNED_TOKENS_BY_CHAIN[chainId].find((candidate) => candidate.symbol === symbol);
  if (!token) throw new Error(`체인 ${chainId}의 고정 토큰 ${symbol}가 없다`);
  return token;
}

const CHAIN_IDS = [1, 8453, 42161] as const satisfies readonly SupportedChainId[];

const AMOUNT_IN_RAW = 1_000_000n;
const BALANCE_IN_RAW = { enough: 5_000_000n, equal: AMOUNT_IN_RAW, short: 999_999n } as const;
const AMOUNT_OUT_RAW = 1_000_000_000_000_000_000n;
const AMOUNT_OUT_MINIMUM_POSITIVE = 995_000_000_000_000_000n;
// F3 DoD-17: 표시값 3% 이하 `normal`, 3% 초과 15% 이하 `warning`, 15% 초과 `error`.
const PRICE_IMPACT_BPS = { normal: 10, warning: 500, error: 2000 } as const;
const ALLOWANCE_RAW = {
  zero: 0n,
  below: AMOUNT_IN_RAW - 1n,
  equal: AMOUNT_IN_RAW,
  above: 2n ** 256n - 1n,
} as const;

function toSourceParams(sample: Sample): PrimaryButtonSourceParams {
  const chainId = sample.chainId ?? 1;
  const amountInRaw =
    sample.amount === "empty" ? null : sample.amount === "zero" ? 0n : AMOUNT_IN_RAW;
  const balanceInRaw =
    sample.amount === "over"
      ? BALANCE_IN_RAW.short
      : sample.amount === "equal"
        ? BALANCE_IN_RAW.equal
        : BALANCE_IN_RAW.enough;

  const quote: SwapQuoteState =
    sample.quote === "success"
      ? {
          status: "success",
          quote: {
            amountOut: AMOUNT_OUT_RAW,
            fee: 500,
            priceImpactBps: PRICE_IMPACT_BPS[sample.severity ?? "normal"],
          },
        }
      : sample.quote === "wrap"
        ? { status: "wrap", quote: null, amountOut: amountInRaw ?? 0n }
        : { status: sample.quote, quote: null };

  const amountOutMinimum =
    sample.minimum === null ? null : sample.minimum === "zero" ? 0n : AMOUNT_OUT_MINIMUM_POSITIVE;

  const allowance =
    sample.allowance === "idle" || sample.allowance === "error" || sample.allowance === "loading"
      ? { status: sample.allowance, allowance: null }
      : { status: "success" as const, allowance: ALLOWANCE_RAW[sample.allowance] };

  return {
    walletStatus: sample.wallet,
    phase: sample.phase,
    tokenIn: sample.tokenIn === null ? null : pinnedOf(chainId, sample.tokenIn),
    tokenOut: sample.tokenOut === null ? null : pinnedOf(chainId, sample.tokenOut),
    amountInRaw,
    balanceInRaw,
    quote,
    amountOutMinimum,
    allowance,
  };
}

function judge(sample: Sample): PrimaryButtonState {
  return getPrimaryButtonState(getPrimaryButtonStateParams(toSourceParams(sample)));
}

function bothSelected(sample: Sample): boolean {
  return sample.tokenIn !== null && sample.tokenOut !== null;
}

// 두 토큰이 ETH와 WETH(어느 방향이든).
function isWrapPair(sample: Sample): boolean {
  return (
    (sample.tokenIn === "ETH" && sample.tokenOut === "WETH") ||
    (sample.tokenIn === "WETH" && sample.tokenOut === "ETH")
  );
}

function sendsErc20(sample: Sample): boolean {
  return sample.tokenIn !== null && sample.tokenIn !== "ETH";
}

/**
 * 판정 순서 표본이 스펙 계약상 함께 올 수 있는 값인지 확인한다.
 * 견적 `idle`은 토큰 미선택 또는 금액이 비었거나 0인 상태다(F3 §4). 가격 영향과 최소 수령량은 견적 `success`일 때만 있다(F3·F4 §4, DoD-17).
 * 견적 `wrap`은 두 토큰이 ETH와 WETH일 때만, 견적 `success`는 그 밖의 페어에서만 온다(§4.2, DoD-14).
 * allowance는 보내는 토큰이 ERC-20일 때만 읽는 것으로 두고(F5 DoD-12), ERC-20을 보내는 스왑 페어의 견적 `success`에서 allowance `idle`은 쓰지 않는다.
 */
function expectSampleContract(sample: Sample, label: string): void {
  const incomplete = !bothSelected(sample) || sample.amount === "empty" || sample.amount === "zero";
  expect(sample.quote === "idle", `${label}: 견적 idle ⇔ 입력 미완성`).toBe(incomplete);
  expect(sample.severity !== null, `${label}: 가격 영향은 견적 success일 때만`).toBe(
    sample.quote === "success",
  );
  expect(sample.minimum !== null, `${label}: 최소 수령량은 견적 success일 때만`).toBe(
    sample.quote === "success",
  );
  if (sample.quote === "wrap") {
    expect(isWrapPair(sample), `${label}: 견적 wrap은 ETH ↔ WETH에서만`).toBe(true);
  }
  if (sample.quote === "success") {
    expect(isWrapPair(sample), `${label}: 견적 success는 ETH ↔ WETH가 아닌 페어에서만`).toBe(false);
  }
  if (sample.allowance !== "idle") {
    expect(sendsErc20(sample), `${label}: allowance는 ERC-20 보내는 토큰만`).toBe(true);
  }
  if (sample.quote === "success" && sendsErc20(sample)) {
    expect(sample.allowance, `${label}: ERC-20 스왑 견적 success에서 allowance idle 없음`).not.toBe(
      "idle",
    );
  }
}

// ─── 상태 조건(스펙 DoD-1~4·6·18·19, F5 DoD-7~11·EC-14, F2·F3 입력·견적 상태) ─────────
// 각 상태의 조건은 부분 조건 곱의 대안 목록이다(`swap-ready`만 대안이 둘: DoD-1의 ETH 보내기, F5 DoD-11의 ERC-20 보내기).
// 부분 조건의 group이 같으면 서로 배타적인 값이다
// (지갑 복원 중과 미연결, phase 값, 입력 상태 값, 견적 상태 값, ETH ↔ WETH와 스왑 페어, ETH 보내기와 ERC-20 보내기,
// 가격 영향 등급, 최소 수령량, allowance 상태 값과 대소).

type Group =
  | "wallet"
  | "phase"
  | "tokens"
  | "amount"
  | "quote"
  | "pair"
  | "send"
  | "severity"
  | "minimum"
  | "allowance";

type Requirement = { groups: readonly Group[]; holds: (sample: Sample) => boolean };

const walletIs = (wallet: Sample["wallet"]): Requirement => ({
  groups: ["wallet"],
  holds: (sample) => sample.wallet === wallet,
});
const phaseIs = (phase: SwapExecutionPhase): Requirement => ({
  groups: ["phase"],
  holds: (sample) => sample.phase === phase,
});
const quoteIs = (quote: Sample["quote"]): Requirement => ({
  groups: ["quote"],
  holds: (sample) => sample.quote === quote,
});
const allowanceIn = (...values: Sample["allowance"][]): Requirement => ({
  groups: ["allowance"],
  holds: (sample) => values.includes(sample.allowance),
});
const TOKENS_MISSING: Requirement = {
  groups: ["tokens"],
  holds: (sample) => !bothSelected(sample),
};
const AMOUNT_EMPTY: Requirement = {
  groups: ["amount"],
  holds: (sample) => sample.amount === "empty" || sample.amount === "zero",
};
const AMOUNT_OVER_BALANCE: Requirement = {
  groups: ["amount"],
  holds: (sample) => sample.amount === "over",
};
const hasAmountInRaw = (sample: Sample) =>
  sample.amount === "valid" || sample.amount === "equal" || sample.amount === "over";
// 두 토큰이 정해지고 금액이 0보다 크다(견적을 읽는 입력, 잔액 부족이어도 견적은 읽는다).
const INPUT_POSITIVE: Requirement = {
  groups: ["tokens", "amount"],
  holds: (sample) => bothSelected(sample) && hasAmountInRaw(sample),
};
const PAIR_WRAP: Requirement = { groups: ["pair"], holds: isWrapPair };
const PAIR_SWAP: Requirement = {
  groups: ["pair"],
  holds: (sample) => bothSelected(sample) && !isWrapPair(sample),
};
const SEND_ETH: Requirement = { groups: ["send"], holds: (sample) => sample.tokenIn === "ETH" };
const SEND_ERC20: Requirement = { groups: ["send"], holds: sendsErc20 };
const SEVERITY_ERROR: Requirement = {
  groups: ["severity"],
  holds: (sample) => sample.severity === "error",
};
const SEVERITY_NOT_ERROR: Requirement = {
  groups: ["severity"],
  holds: (sample) => sample.severity === "normal" || sample.severity === "warning",
};
const MINIMUM_ZERO: Requirement = {
  groups: ["minimum"],
  holds: (sample) => sample.minimum === "zero",
};
const MINIMUM_POSITIVE: Requirement = {
  groups: ["minimum"],
  holds: (sample) => sample.minimum === "positive",
};
const ALLOWANCE_BELOW_AMOUNT: Requirement = {
  groups: ["allowance"],
  holds: (sample) =>
    hasAmountInRaw(sample) && (sample.allowance === "zero" || sample.allowance === "below"),
};
const ALLOWANCE_AT_LEAST_AMOUNT: Requirement = {
  groups: ["allowance"],
  holds: (sample) =>
    hasAmountInRaw(sample) && (sample.allowance === "equal" || sample.allowance === "above"),
};
const SWAP_SUCCESS = [INPUT_POSITIVE, quoteIs("success"), PAIR_SWAP] as const;
const ERC20_SWAP_SUCCESS = [...SWAP_SUCCESS, SEND_ERC20] as const;

const CONDITIONS: Record<State, readonly (readonly Requirement[])[]> = {
  restoring: [[walletIs("restoring")]],
  disconnected: [[walletIs("disconnected")]],
  "awaiting-signature": [[phaseIs("awaiting-signature")]],
  approving: [[phaseIs("approving")]],
  swapping: [[phaseIs("swapping")]],
  wrapping: [[phaseIs("wrapping")]],
  unwrapping: [[phaseIs("unwrapping")]],
  "select-token": [[TOKENS_MISSING]],
  "enter-amount": [[AMOUNT_EMPTY]],
  "insufficient-balance": [[AMOUNT_OVER_BALANCE]],
  quoting: [[INPUT_POSITIVE, quoteIs("loading")]],
  "no-route": [[INPUT_POSITIVE, quoteIs("no-route")]],
  "quote-error": [[INPUT_POSITIVE, quoteIs("error")]],
  // DoD-18: 보내는 ETH·받는 WETH, DoD-19: 보내는 WETH·받는 ETH.
  "wrap-ready": [[INPUT_POSITIVE, quoteIs("wrap"), PAIR_WRAP, SEND_ETH]],
  "unwrap-ready": [[INPUT_POSITIVE, quoteIs("wrap"), PAIR_WRAP, SEND_ERC20]],
  // DoD-2·3과 F5 DoD-7·8: 스왑 페어 전체.
  "price-impact-too-high": [[...SWAP_SUCCESS, SEVERITY_ERROR]],
  "amount-too-small": [[...SWAP_SUCCESS, MINIMUM_ZERO]],
  // DoD-4와 F5 EC-14·DoD-9·10: ERC-20을 보내는 스왑 페어.
  "allowance-error": [[...ERC20_SWAP_SUCCESS, allowanceIn("error")]],
  "checking-allowance": [[...ERC20_SWAP_SUCCESS, allowanceIn("loading")]],
  "approve-required": [[...ERC20_SWAP_SUCCESS, ALLOWANCE_BELOW_AMOUNT]],
  "swap-ready": [
    // DoD-1
    [...SWAP_SUCCESS, SEND_ETH, SEVERITY_NOT_ERROR, MINIMUM_POSITIVE],
    // DoD-4와 F5 DoD-11
    [...ERC20_SWAP_SUCCESS, ALLOWANCE_AT_LEAST_AMOUNT],
  ],
};

function holdsFully(state: State, sample: Sample): boolean {
  return CONDITIONS[state].some((alternative) =>
    alternative.every((requirement) => requirement.holds(sample)),
  );
}

/**
 * 앞 상태 `first`의 값을 둔 채 뒤 상태 `later`의 조건이 성립하는지 본다.
 * `later`의 부분 조건 중 `first`와 같은 group(배타적인 부분)은 `first`의 값을 두므로 건너뛰고, 나머지는 모두 성립해야 한다.
 */
function holdsAlongside(first: State, later: State, sample: Sample): boolean {
  const firstGroups = new Set(
    CONDITIONS[first].flatMap((alternative) =>
      alternative.flatMap((requirement) => requirement.groups),
    ),
  );
  return CONDITIONS[later].some((alternative) =>
    alternative
      .filter((requirement) => !requirement.groups.some((group) => firstGroups.has(group)))
      .every((requirement) => requirement.holds(sample)),
  );
}

function sampleLabel(index: number, expected: State, sample: Sample): string {
  return `#${index} ${expected} ← ${JSON.stringify(sample)}`;
}

function part(
  tokenIn: TokenName | null,
  tokenOut: TokenName | null,
  amount: Sample["amount"],
  quote: Sample["quote"],
  severity: Sample["severity"],
  minimum: Sample["minimum"],
  allowance: Sample["allowance"],
): LaterPart {
  return { tokenIn, tokenOut, amount, quote, severity, minimum, allowance };
}

const CONNECTED = { wallet: "connected", phase: "idle" } as const;

// ─── 한 상태의 조건만 성립하는 표본 ─────────────────────────────────
// 행은 [상태, 표본, 함께 성립하는 뒤 상태]다.
// 지갑·phase 상태는 입력·견적·allowance가 계약상 늘 뒤 상태 하나에 해당하므로 단독 표본을 만들 수 없다.
// 나머지를 `swap-ready` 조건(ERC-20↔ERC-20, allowance 이상)으로 두고 함께 성립하는 뒤 상태를 세 번째 값에 적는다.
// `insufficient-balance`도 두 토큰과 0보다 큰 금액이면 견적이 `idle`이 아니라 견적 상태 하나가 함께 성립한다(`quoting`).

const READY: LaterPart = part("USDC", "DAI", "valid", "success", "normal", "positive", "above");
const QUOTE_PENDING = { severity: null, minimum: null } as const;

const SOLE_SAMPLES: readonly (readonly [State, Sample, readonly State[]])[] = [
  ["restoring", { wallet: "restoring", phase: "idle", ...READY }, ["swap-ready"]],
  ["disconnected", { wallet: "disconnected", phase: "idle", ...READY }, ["swap-ready"]],
  [
    "awaiting-signature",
    { wallet: "connected", phase: "awaiting-signature", ...READY },
    ["swap-ready"],
  ],
  ["approving", { wallet: "connected", phase: "approving", ...READY }, ["swap-ready"]],
  ["swapping", { wallet: "connected", phase: "swapping", ...READY }, ["swap-ready"]],
  ["wrapping", { wallet: "connected", phase: "wrapping", ...READY }, ["swap-ready"]],
  ["unwrapping", { wallet: "connected", phase: "unwrapping", ...READY }, ["swap-ready"]],
  ["select-token", { ...CONNECTED, ...part(null, "DAI", "valid", "idle", null, null, "idle") }, []],
  [
    "enter-amount",
    { ...CONNECTED, ...READY, amount: "empty", quote: "idle", ...QUOTE_PENDING },
    [],
  ],
  ["enter-amount", { ...CONNECTED, ...READY, amount: "zero", quote: "idle", ...QUOTE_PENDING }, []],
  [
    "insufficient-balance",
    { ...CONNECTED, ...READY, amount: "over", quote: "loading", ...QUOTE_PENDING },
    ["quoting"],
  ],
  ["quoting", { ...CONNECTED, ...READY, quote: "loading", ...QUOTE_PENDING }, []],
  ["no-route", { ...CONNECTED, ...READY, quote: "no-route", ...QUOTE_PENDING }, []],
  ["quote-error", { ...CONNECTED, ...READY, quote: "error", ...QUOTE_PENDING }, []],
  ["wrap-ready", { ...CONNECTED, ...part("ETH", "WETH", "valid", "wrap", null, null, "idle") }, []],
  [
    "unwrap-ready",
    { ...CONNECTED, ...part("WETH", "ETH", "valid", "wrap", null, null, "idle") },
    [],
  ],
  [
    "price-impact-too-high",
    { ...CONNECTED, ...part("ETH", "USDC", "valid", "success", "error", "positive", "idle") },
    [],
  ],
  [
    "amount-too-small",
    { ...CONNECTED, ...part("ETH", "USDC", "valid", "success", "normal", "zero", "idle") },
    [],
  ],
  ["allowance-error", { ...CONNECTED, ...READY, tokenOut: "ETH", allowance: "error" }, []],
  ["allowance-error", { ...CONNECTED, ...READY, allowance: "error" }, []],
  ["checking-allowance", { ...CONNECTED, ...READY, tokenOut: "ETH", allowance: "loading" }, []],
  ["checking-allowance", { ...CONNECTED, ...READY, allowance: "loading" }, []],
  ["approve-required", { ...CONNECTED, ...READY, tokenOut: "ETH", allowance: "zero" }, []],
  ["approve-required", { ...CONNECTED, ...READY, tokenOut: "ETH", allowance: "below" }, []],
  ["approve-required", { ...CONNECTED, ...READY, allowance: "zero" }, []],
  ["approve-required", { ...CONNECTED, ...READY, allowance: "below" }, []],
  ["swap-ready", { ...CONNECTED, ...READY, tokenOut: "ETH", allowance: "equal" }, []],
  ["swap-ready", { ...CONNECTED, ...READY, tokenOut: "ETH", allowance: "above" }, []],
  ["swap-ready", { ...CONNECTED, ...READY, allowance: "equal" }, []],
  ["swap-ready", { ...CONNECTED, ...READY, allowance: "above" }, []],
  [
    "swap-ready",
    { ...CONNECTED, ...part("ETH", "USDC", "valid", "success", "normal", "positive", "idle") },
    [],
  ],
];

// ─── 인접한 경계의 표본 ─────────────────────────────────────────────
// 행은 [앞 상태 i, 표본]이다. 표본은 i의 조건과, i와 함께 성립할 수 있는 뒤 상태 조건을 모두 성립시킨다.
// 뒤 상태들끼리 배타적이면(phase 값, 견적 상태 값, 페어 종류, 보내는 토큰 종류, allowance 상태 값) 행을 나눈다.

// 골자 @given의 인접 경계 분류(스펙 DoD-6 순서의 인접 경계 20개).
const COEXISTING_BOUNDARIES: readonly (readonly [State, State])[] = [
  ["disconnected", "awaiting-signature"],
  ["unwrapping", "select-token"],
  ["select-token", "enter-amount"],
  ["insufficient-balance", "quoting"],
  ["price-impact-too-high", "amount-too-small"],
  ["amount-too-small", "allowance-error"],
];
const EXCLUSIVE_BOUNDARIES: readonly (readonly [State, State])[] = [
  ["restoring", "disconnected"],
  ["awaiting-signature", "approving"],
  ["approving", "swapping"],
  ["swapping", "wrapping"],
  ["wrapping", "unwrapping"],
  ["enter-amount", "insufficient-balance"],
  ["quoting", "no-route"],
  ["no-route", "quote-error"],
  ["quote-error", "wrap-ready"],
  ["wrap-ready", "unwrap-ready"],
  ["unwrap-ready", "price-impact-too-high"],
  ["allowance-error", "checking-allowance"],
  ["checking-allowance", "approve-required"],
  ["approve-required", "swap-ready"],
];

// 지갑·phase 앞 상태 뒤에 붙이는 나머지 값. 함께 놓으면 select-token부터 swap-ready까지 뒤 상태를 모두 덮는다.
const TAILS: readonly LaterPart[] = [
  // 토큰 미선택 + 금액 빈 값
  part(null, null, "empty", "idle", null, null, "idle"),
  // 토큰 미선택 + 금액 초과
  part("USDC", null, "over", "idle", null, null, "idle"),
  // 금액 초과 + 견적 loading
  part("USDC", "DAI", "over", "loading", null, null, "error"),
  part("USDC", "DAI", "valid", "no-route", null, null, "error"),
  part("USDC", "DAI", "valid", "error", null, null, "below"),
  // 금액 초과 + ETH → WETH 견적 wrap
  part("ETH", "WETH", "over", "wrap", null, null, "idle"),
  part("WETH", "ETH", "valid", "wrap", null, null, "error"),
  // 금액 초과 + USDC → ETH 견적 success + 가격 영향 error 등급 + 최소 수령량 0n + allowance 읽기 실패
  part("USDC", "ETH", "over", "success", "error", "zero", "error"),
  part("USDC", "DAI", "valid", "success", "error", "zero", "loading"),
  part("USDC", "DAI", "valid", "success", "error", "zero", "below"),
  part("USDC", "DAI", "valid", "success", "error", "zero", "above"),
  part("ETH", "USDC", "valid", "success", "normal", "positive", "idle"),
];

const ACTIVE_PHASES = [
  "awaiting-signature",
  "approving",
  "swapping",
  "wrapping",
  "unwrapping",
] as const satisfies readonly SwapExecutionPhase[];

type Row = readonly [State, Sample];

// 입력 유효 + 견적 loading·no-route·error + 페어·보내는 토큰·allowance 각각
function quotedRows(first: "quoting" | "no-route" | "quote-error"): Row[] {
  const quote = first === "quoting" ? "loading" : first === "no-route" ? "no-route" : "error";
  const parts = [
    part("USDC", "ETH", "valid", quote, null, null, "error"),
    part("USDC", "DAI", "valid", quote, null, null, "error"),
    part("USDC", "DAI", "valid", quote, null, null, "loading"),
    part("USDC", "DAI", "valid", quote, null, null, "below"),
    part("USDC", "DAI", "valid", quote, null, null, "above"),
    part("ETH", "USDC", "valid", quote, null, null, "idle"),
    part("ETH", "WETH", "valid", quote, null, null, "idle"),
    part("WETH", "ETH", "valid", quote, null, null, "error"),
  ];
  return parts.map((later) => [first, { ...CONNECTED, ...later }] as const);
}

// 견적 success + 가격 영향 등급 + 최소 수령량 + 페어·allowance 각각
function successRows(
  first: "price-impact-too-high" | "amount-too-small",
  severity: "normal" | "error",
): Row[] {
  const erc20Allowances = ["error", "loading", "below", "above"] as const;
  return [
    [
      first,
      { ...CONNECTED, ...part("ETH", "USDC", "valid", "success", severity, "zero", "idle") },
    ] as const,
    ...(["ETH", "DAI"] as const).flatMap((tokenOut) =>
      erc20Allowances.map(
        (allowance) =>
          [
            first,
            {
              ...CONNECTED,
              ...part("USDC", tokenOut, "valid", "success", severity, "zero", allowance),
            },
          ] as const,
      ),
    ),
  ];
}

const OVERLAP_SAMPLES: readonly Row[] = [
  // restoring·disconnected: phase 각각 × 나머지 값 각각
  ...(["restoring", "disconnected"] as const).flatMap((wallet) =>
    ACTIVE_PHASES.flatMap((phase) =>
      TAILS.map((later) => [wallet, { wallet, phase, ...later }] as const),
    ),
  ),
  // awaiting-signature ~ unwrapping: 나머지 값 각각
  ...ACTIVE_PHASES.flatMap((phase) =>
    TAILS.map((later) => [phase, { wallet: "connected", phase, ...later }] as const),
  ),

  // select-token: 금액 빈 값, 금액 초과(토큰 미선택이라 견적 idle)
  ["select-token", { ...CONNECTED, ...part(null, null, "empty", "idle", null, null, "idle") }],
  ["select-token", { ...CONNECTED, ...part("USDC", null, "over", "idle", null, null, "idle") }],

  // enter-amount: 금액 0(견적 idle)
  ["enter-amount", { ...CONNECTED, ...part("USDC", "DAI", "zero", "idle", null, null, "above") }],
  ["enter-amount", { ...CONNECTED, ...part("ETH", "WETH", "zero", "idle", null, null, "idle") }],

  // insufficient-balance: 견적 loading·no-route·error·wrap(두 방향)·success(페어·가격 영향·최소 수령량·allowance) 각각
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("USDC", "DAI", "over", "loading", null, null, "error") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("USDC", "DAI", "over", "no-route", null, null, "error") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("USDC", "DAI", "over", "error", null, null, "error") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("ETH", "WETH", "over", "wrap", null, null, "idle") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("WETH", "ETH", "over", "wrap", null, null, "error") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("USDC", "ETH", "over", "success", "error", "zero", "error") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("USDC", "DAI", "over", "success", "error", "zero", "loading") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("USDC", "DAI", "over", "success", "error", "zero", "below") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("USDC", "DAI", "over", "success", "error", "zero", "above") },
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...part("ETH", "USDC", "over", "success", "normal", "positive", "idle") },
  ],

  // quoting·no-route·quote-error
  ...quotedRows("quoting"),
  ...quotedRows("no-route"),
  ...quotedRows("quote-error"),

  // wrap-ready: 금액이 잔액보다 작음·같음
  ["wrap-ready", { ...CONNECTED, ...part("ETH", "WETH", "valid", "wrap", null, null, "idle") }],
  ["wrap-ready", { ...CONNECTED, ...part("ETH", "WETH", "equal", "wrap", null, null, "idle") }],

  // unwrap-ready: allowance 읽기 실패·읽는 중·amountInRaw보다 작음·이상 각각
  ...(["error", "loading", "zero", "below", "above"] as const).map(
    (allowance) =>
      [
        "unwrap-ready",
        { ...CONNECTED, ...part("WETH", "ETH", "valid", "wrap", null, null, allowance) },
      ] as const,
  ),

  // price-impact-too-high: 가격 영향 error 등급 + 최소 수령량 0n + 페어·allowance 각각
  ...successRows("price-impact-too-high", "error"),
  // amount-too-small: 가격 영향 normal 등급 + 최소 수령량 0n + 페어·allowance 각각
  ...successRows("amount-too-small", "normal"),

  // allowance-error·checking-allowance·approve-required: allowance 상태가 배타적이라 앞 상태 조건만
  ...(["ETH", "DAI"] as const).flatMap((tokenOut) => [
    [
      "allowance-error",
      {
        ...CONNECTED,
        ...part("USDC", tokenOut, "valid", "success", "normal", "positive", "error"),
      },
    ] as const,
    [
      "checking-allowance",
      {
        ...CONNECTED,
        ...part("USDC", tokenOut, "valid", "success", "normal", "positive", "loading"),
      },
    ] as const,
    [
      "approve-required",
      {
        ...CONNECTED,
        ...part("USDC", tokenOut, "valid", "success", "normal", "positive", "below"),
      },
    ] as const,
  ]),
];

// 앞 상태의 값을 두면 계약상 성립시킬 수 없는 뒤 상태(스펙 계약 근거). 이 쌍은 앞 상태 조건과 공존 가능한 뒤 상태 조건으로 본다.
const QUOTED_STATES = SPEC_ORDER.slice(SPEC_ORDER.indexOf("quoting"));
const SUCCESS_ONLY_STATES = ["price-impact-too-high", "amount-too-small"] as const;
const UNREACHABLE_AFTER: Partial<Record<State, readonly State[]>> = {
  // 토큰 미선택이거나 금액이 비었거나 0이면 견적은 `idle`이다(F3 §4).
  "select-token": QUOTED_STATES,
  "enter-amount": QUOTED_STATES,
  // 가격 영향 등급과 최소 수령량은 견적 `success`일 때만 있다(F3·F4 §4, DoD-17).
  quoting: SUCCESS_ONLY_STATES,
  "no-route": SUCCESS_ONLY_STATES,
  "quote-error": SUCCESS_ONLY_STATES,
  "unwrap-ready": SUCCESS_ONLY_STATES,
  // 보내는 토큰이 ETH이면 allowance는 `idle`이고(F5 DoD-12, §4.2), 견적 `wrap`에는 가격 영향과 최소 수령량이 없다.
  "wrap-ready": [
    ...SUCCESS_ONLY_STATES,
    "allowance-error",
    "checking-allowance",
    "approve-required",
    "swap-ready",
  ],
};

// ─── 판정 공간 전체(DoD-5) ──────────────────────────────────────────
const SPACE_WALLETS = ["restoring", "disconnected", "connected"] as const;
const SPACE_PHASES = ["idle", ...ACTIVE_PHASES] as const;
const SPACE_PAIRS = [
  [null, null],
  ["USDC", "DAI"],
  ["ETH", "USDC"],
  ["USDC", "ETH"],
  ["ETH", "WETH"],
  ["WETH", "ETH"],
] as const satisfies readonly (readonly [TokenName | null, TokenName | null])[];
const SPACE_AMOUNTS = ["empty", "zero", "valid", "equal", "over"] as const;
const SPACE_QUOTES = ["idle", "loading", "no-route", "error", "success", "wrap"] as const;
const SPACE_SEVERITIES = ["normal", "warning", "error"] as const;
const SPACE_MINIMUMS = [null, "zero", "positive"] as const;
const SPACE_ALLOWANCES = ["idle", "loading", "error", "below", "above"] as const;

function* judgementSpace(): Generator<Sample> {
  for (const wallet of SPACE_WALLETS) {
    for (const phase of SPACE_PHASES) {
      for (const [tokenIn, tokenOut] of SPACE_PAIRS) {
        for (const amount of SPACE_AMOUNTS) {
          for (const quote of SPACE_QUOTES) {
            const severities: readonly Sample["severity"][] =
              quote === "success" ? SPACE_SEVERITIES : [null];
            for (const severity of severities) {
              for (const minimum of SPACE_MINIMUMS) {
                for (const allowance of SPACE_ALLOWANCES) {
                  yield {
                    wallet,
                    phase,
                    tokenIn,
                    tokenOut,
                    amount,
                    quote,
                    severity,
                    minimum,
                    allowance,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
}

// ─── 보내는 ETH 금액 = 잔액(EC-4) ───────────────────────────────────
// F2 스펙: Ethereum ETH 가스 예약량 0.005 ETH.
const ETHEREUM_GAS_RESERVE_RAW = 5_000_000_000_000_000n;
const EC4_BALANCES_RAW = [
  1_000_000_000_000_000_000n,
  ETHEREUM_GAS_RESERVE_RAW,
  1_000_000_000_000_000n,
] as const;

function ethAllInSource(tokenOut: "USDC" | "WETH", balanceRaw: bigint): PrimaryButtonSourceParams {
  const quote: SwapQuoteState =
    tokenOut === "WETH"
      ? { status: "wrap", quote: null, amountOut: balanceRaw }
      : {
          status: "success",
          quote: { amountOut: AMOUNT_OUT_RAW, fee: 500, priceImpactBps: PRICE_IMPACT_BPS.normal },
        };
  return {
    walletStatus: "connected",
    phase: "idle",
    tokenIn: pinnedOf(1, "ETH"),
    tokenOut: pinnedOf(1, tokenOut),
    amountInRaw: balanceRaw,
    balanceInRaw: balanceRaw,
    quote,
    amountOutMinimum: tokenOut === "WETH" ? null : AMOUNT_OUT_MINIMUM_POSITIVE,
    allowance: { status: "idle", allowance: null },
  };
}

// DoD-4 비교 표본: 받는 토큰만 ERC-20으로 바꾼다(보내는 USDC면 DAI, 보내는 DAI면 USDC).
function expectSameAsErc20Pair(expected: State, samples: readonly Sample[]): void {
  for (const [index, sample] of samples.entries()) {
    const label = sampleLabel(index, expected, sample);
    const comparison: Sample = { ...sample, tokenOut: sample.tokenIn === "USDC" ? "DAI" : "USDC" };
    const state = judge(sample);
    expect(state, label).toBe(expected);
    expect(state, `${label}: 비교 ${JSON.stringify(comparison)}`).toBe(judge(comparison));
  }
}

function erc20ToEth(
  tokenIn: "USDC" | "DAI",
  severity: "normal" | "warning",
  allowance: Sample["allowance"],
): Sample {
  return {
    ...CONNECTED,
    ...part(tokenIn, "ETH", "valid", "success", severity, "positive", allowance),
  };
}

const ERC20_SENDERS = ["USDC", "DAI"] as const;
const NOT_ERROR_SEVERITIES = ["normal", "warning"] as const;

describe("주 버튼 상태 — ETH가 낀 페어와 ETH ↔ WETH에서도 위에서부터 먼저 해당하는 상태 하나로 정해진다", () => {
  describe("판정 순서", () => {
    /**
     * @spec DoD-6
     * @given 21개 상태 각각의 조건만 성립하는 표본을 하나씩 반복한다. 기대 상태는 스펙 DoD-6 리터럴 순서(`restoring` → `disconnected` → `awaiting-signature` → `approving` → `swapping` → `wrapping` → `unwrapping` → `select-token` → `enter-amount` → `insufficient-balance` → `quoting` → `no-route` → `quote-error` → `wrap-ready` → `unwrap-ready` → `price-impact-too-high` → `amount-too-small` → `allowance-error` → `checking-allowance` → `approve-required` → `swap-ready`)의 이름이다. 표본: 지갑 복원 중(`restoring`), 지갑 미연결(`disconnected`), 연결 상태에서 phase `awaiting-signature`·`approving`·`swapping`·`wrapping`·`unwrapping`(각 상태), phase `idle`에서 토큰 미선택(`select-token`), 금액이 비었거나 0(`enter-amount`), 금액 정수가 보내는 토큰 잔액 정수보다 큼(`insufficient-balance`), 입력이 유효하고 견적 `loading`(`quoting`)·`no-route`(`no-route`)·`error`(`quote-error`), 보내는 ETH·받는 WETH이고 견적 `wrap`(`wrap-ready`), 보내는 WETH·받는 ETH이고 견적 `wrap`(`unwrap-ready`), 보내는 ETH·받는 USDC에서 견적 `success`이고 가격 영향 `error` 등급이며 최소 수령량이 0보다 큼(`price-impact-too-high`), 보내는 ETH·받는 USDC에서 견적 `success`이고 가격 영향 `normal` 등급이며 최소 수령량 `0n`(`amount-too-small`), 보내는 ERC-20(USDC→ETH, USDC→DAI 각각)이고 견적 `success`·가격 영향이 `error` 등급이 아님·최소 수령량이 0보다 큰 상태에서 현재 키에 성공 값 없이 allowance 읽기 실패(`allowance-error`), 현재 키에 성공 값 없이 allowance 읽는 중(`checking-allowance`), allowance가 `amountInRaw`보다 작음(0과 0보다 큰 값 표본, `approve-required`), allowance가 `amountInRaw` 이상(같은 값과 큰 값 표본, `swap-ready`), 보내는 ETH·받는 USDC에서 견적 `success`·가격 영향 `normal` 등급·최소 수령량이 0보다 크고 allowance `idle`(`swap-ready`)
     * @when 주 버튼 상태를 판정한다
     * @then 각 표본의 판정은 조건이 성립한 그 상태다
     */
    it("[DoD-6] 한 상태의 조건만 성립하면 그 상태로 판정한다", () => {
      expect(
        [...new Set(SOLE_SAMPLES.map(([expected]) => expected))],
        "21개 상태마다 스펙 순서대로 표본이 있다",
      ).toEqual([...SPEC_ORDER]);

      for (const [index, [expected, sample, companions]] of SOLE_SAMPLES.entries()) {
        const label = sampleLabel(index, expected, sample);
        expectSampleContract(sample, label);
        expect(
          SPEC_ORDER.filter((state) => holdsFully(state, sample)),
          `${label}: 성립하는 상태 조건`,
        ).toEqual([expected, ...companions]);

        expect(judge(sample), label).toBe(expected);
      }
    });

    /**
     * @spec DoD-6
     * @given 순서상 인접한 경계 20개 각각에 표본을 둔다. 표본은 앞 상태 i의 조건과, i와 함께 성립할 수 있는 뒤 상태(i 바로 다음 상태 포함)의 조건을 모두 성립시키며, 뒤 상태들끼리 배타적이면 표본을 나눠 각각 둔다. 두 조건이 함께 성립할 수 있는 인접 경계(`disconnected`·`awaiting-signature`, `unwrapping`·`select-token`, `select-token`·`enter-amount`, `insufficient-balance`·`quoting`, `price-impact-too-high`·`amount-too-small`, `amount-too-small`·`allowance-error`)는 i와 다음 상태의 조건을 함께 성립시킨다. 두 조건이 배타적인 인접 경계(`restoring`·`disconnected`, `awaiting-signature`·`approving`, `approving`·`swapping`, `swapping`·`wrapping`, `wrapping`·`unwrapping`, `enter-amount`·`insufficient-balance`, `quoting`·`no-route`, `no-route`·`quote-error`, `quote-error`·`wrap-ready`, `wrap-ready`·`unwrap-ready`, `unwrap-ready`·`price-impact-too-high`, `allowance-error`·`checking-allowance`, `checking-allowance`·`approve-required`, `approve-required`·`swap-ready`)는 i의 조건과 그와 공존 가능한 뒤 상태 조건을 함께 성립시킨다. 표본 예: 지갑 미연결이면서 phase `awaiting-signature`·`approving`·`swapping`·`wrapping`·`unwrapping` 각각(토큰 미선택·금액 빈 값과 함께), 지갑 복원 중이면서 phase `wrapping`이고 토큰 미선택, phase `swapping`·`wrapping`·`unwrapping` 각각이면서 토큰 미선택·금액 빈 값, 금액 정수가 잔액 정수보다 크면서 견적 `loading`·`no-route`·`error`·`wrap`(보내는 ETH·받는 WETH, 보내는 WETH·받는 ETH 각각)·`success`(USDC→ETH, 가격 영향 `error` 등급, 최소 수령량 `0n`, allowance 읽기 실패) 각각, 견적 `error`이면서 보내는 USDC의 allowance가 `amountInRaw`보다 작음, 보내는 WETH·받는 ETH에서 견적 `wrap`이면서 allowance 읽기 실패·읽는 중·`amountInRaw`보다 작음 각각, 한쪽이 ETH인 페어(ETH→USDC, USDC→ETH)와 USDC→DAI에서 가격 영향 `error` 등급이면서 최소 수령량 `0n`(보내는 ERC-20은 allowance 읽기 실패·읽는 중·`amountInRaw`보다 작음·`amountInRaw` 이상 각각), 보내는 ERC-20에서 최소 수령량 `0n`이면서 allowance 읽기 실패·읽는 중·`amountInRaw`보다 작음·`amountInRaw` 이상 각각, 현재 키에 성공 값 없이 allowance 읽기 실패·읽는 중(allowance 상태가 배타적이라 앞 상태 조건만)
     * @when 주 버튼 상태를 판정한다
     * @then 각 표본의 판정은 경계의 앞 상태 i다
     */
    it("[DoD-6] 인접한 두 상태의 경계에서 함께 성립하는 조건이 있어도 앞선 상태로 판정한다", () => {
      // 표 점검 1: 인접 경계 20개가 공존·배타 목록으로 빠짐없이 나뉜다.
      const boundaryKey = ([first, next]: readonly [State, State]) => `${first}·${next}`;
      const adjacent = SPEC_ORDER.slice(0, -1).map((state, index) =>
        boundaryKey([state, SPEC_ORDER[index + 1]]),
      );
      expect(adjacent).toHaveLength(20);
      expect(
        [...COEXISTING_BOUNDARIES, ...EXCLUSIVE_BOUNDARIES].map(boundaryKey).sort(),
        "인접 경계 분류",
      ).toEqual([...adjacent].sort());

      // 표 점검 2: 공존 경계는 두 조건을 함께 성립시키는 표본이 있고, 배타 경계는 어느 표본에서도 함께 성립하지 않는다.
      for (const [first, next] of COEXISTING_BOUNDARIES) {
        expect(
          OVERLAP_SAMPLES.some(
            ([rowFirst, sample]) =>
              rowFirst === first && holdsFully(first, sample) && holdsFully(next, sample),
          ),
          `공존 경계 ${first}·${next}의 표본`,
        ).toBe(true);
      }
      const allSamples = [
        ...SOLE_SAMPLES.map(([, sample]) => sample),
        ...OVERLAP_SAMPLES.map(([, sample]) => sample),
      ];
      for (const [first, next] of EXCLUSIVE_BOUNDARIES) {
        expect(
          allSamples.filter((sample) => holdsFully(first, sample) && holdsFully(next, sample)),
          `배타 경계 ${first}·${next}`,
        ).toEqual([]);
      }

      // 표 점검 3: 앞 상태 i마다 표본이 있고, 뒤 상태 j를 모두 덮는다(계약상 성립시킬 수 없는 쌍만 뺀다).
      for (const [index, first] of SPEC_ORDER.entries()) {
        if (first === "swap-ready") continue;
        const rows = OVERLAP_SAMPLES.filter(([rowFirst]) => rowFirst === first);
        expect(rows.length, `${first}의 표본`).toBeGreaterThan(0);

        for (const [laterIndex, later] of SPEC_ORDER.entries()) {
          if (laterIndex <= index) continue;
          const covered = rows.some(([, sample]) => holdsAlongside(first, later, sample));
          const unreachable = UNREACHABLE_AFTER[first]?.includes(later) ?? false;
          expect(covered || unreachable, `${first} → ${later}의 표본`).toBe(true);
        }
      }
      for (const [first, next] of COEXISTING_BOUNDARIES) {
        expect(UNREACHABLE_AFTER[first]?.includes(next) ?? false, `${first}·${next}`).toBe(false);
      }

      for (const [index, [expected, sample]] of OVERLAP_SAMPLES.entries()) {
        const label = sampleLabel(index, expected, sample);
        expectSampleContract(sample, label);
        expect(holdsFully(expected, sample), `${label}: 앞 상태 조건 성립`).toBe(true);
        const earlier = SPEC_ORDER.slice(0, SPEC_ORDER.indexOf(expected));
        expect(
          earlier.filter((state) => holdsFully(state, sample)),
          `${label}: 더 앞선 상태 조건 없음`,
        ).toEqual([]);

        expect(judge(sample), label).toBe(expected);
      }
    });

    /**
     * @spec DoD-5
     * @given 판정 입력 차원의 곱 전체를 하나씩 반복한다: 지갑(복원 중, 미연결, 연결) × phase(`idle`, `awaiting-signature`, `approving`, `swapping`, `wrapping`, `unwrapping`) × 페어(토큰 미선택, USDC→DAI, ETH→USDC, USDC→ETH, ETH→WETH, WETH→ETH) × 금액(빈 값, 0, 잔액보다 작음, 잔액과 같음, 잔액보다 큼) × 견적 상태(`idle`, `loading`, `no-route`, `error`, `success`, `wrap`) × 견적 `success`의 가격 영향 등급(`normal`, `warning`, `error`) × 최소 수령량(`null`, `0n`, 0보다 큼) × allowance(`idle`, 성공 값 없이 `loading`, 성공 값 없이 `error`, `success`이고 `amountInRaw`보다 작음, `success`이고 `amountInRaw` 이상)
     * @when 표본마다 주 버튼 상태를 판정한다
     * @then 어떤 표본의 판정도 `quote-ready`가 아니다
     */
    it("[DoD-5] 어떤 입력에서도 quote-ready로 판정하지 않는다", () => {
      let count = 0;
      const quoteReady: string[] = [];
      for (const sample of judgementSpace()) {
        count += 1;
        const state: string = judge(sample);
        if (state === "quote-ready") quoteReady.push(JSON.stringify(sample));
      }

      // 3 지갑 × 6 phase × 6 페어 × 5 금액 × (견적 5 + success의 등급 3) × 3 최소 수령량 × 5 allowance
      expect(count, "판정 공간 표본 수").toBe(3 * 6 * 6 * 5 * (5 + 3) * 3 * 5);
      expect(quoteReady, "quote-ready로 판정된 표본").toEqual([]);
    });
  });

  describe("보내는 토큰이 ETH인 스왑 (ETH → ERC-20)", () => {
    /**
     * @spec DoD-1
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 보내는 토큰이 ETH, 받는 토큰이 WETH가 아닌 ERC-20이고 금액이 잔액 이하다. 견적이 `success`이고 최소 수령량이 0보다 크다. 표본: 받는 토큰(USDC, DAI) × 가격 영향 등급(`normal`, `warning`) × allowance 상태 네 가지(`idle`, 성공 값 없이 `loading`, 성공 값 없이 `error`, `success` — allowance `0`과 `amountInRaw` 이상 각각)를 하나씩 반복한다
     * @when 주 버튼 상태를 판정한다
     * @then 모든 표본의 판정이 `swap-ready`다
     * @then 모든 표본에서 주 버튼이 활성이다
     */
    it("[DoD-1] 견적 success·가격 영향 error 아님·최소 수령량 > 0이면 allowance와 무관하게 swap-ready이고 활성이다", () => {
      const allowances = ["idle", "loading", "error", "zero", "above"] as const;
      const samples: Sample[] = (["USDC", "DAI"] as const).flatMap((tokenOut) =>
        NOT_ERROR_SEVERITIES.flatMap((severity) =>
          allowances.map((allowance) => ({
            ...CONNECTED,
            ...part("ETH", tokenOut, "valid", "success", severity, "positive", allowance),
          })),
        ),
      );
      expect(samples).toHaveLength(2 * 2 * 5);

      for (const [index, sample] of samples.entries()) {
        const label = sampleLabel(index, "swap-ready", sample);
        const state = judge(sample);
        expect(state, label).toBe("swap-ready");
        expect(isPrimaryButtonEnabled(state), `${label}: 활성`).toBe(true);
      }
    });
  });

  describe("한쪽이 ETH인 스왑 페어의 견적 success 판정", () => {
    /**
     * @spec DoD-2
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 금액이 잔액 이하다. 견적이 `success`이고 가격 영향이 `error` 등급이다. 표본: 방향(보내는 ETH·받는 USDC, 보내는 USDC·받는 ETH) × 최소 수령량(0보다 큼, `0n`)을 하나씩 반복하며, 보내는 USDC 방향의 allowance는 `success`이고 `amountInRaw` 이상, 보내는 ETH 방향의 allowance는 `idle`이다(가격 영향만 아니면 `swap-ready`·`amount-too-small`이 될 입력)
     * @when 주 버튼 상태를 판정한다
     * @then 모든 표본의 판정이 `price-impact-too-high`다
     */
    it("[DoD-2] 가격 영향이 error 등급이면 두 방향 모두 price-impact-too-high다", () => {
      const samples: Sample[] = (["positive", "zero"] as const).flatMap((minimum) => [
        { ...CONNECTED, ...part("ETH", "USDC", "valid", "success", "error", minimum, "idle") },
        { ...CONNECTED, ...part("USDC", "ETH", "valid", "success", "error", minimum, "above") },
      ]);

      for (const [index, sample] of samples.entries()) {
        expect(judge(sample), sampleLabel(index, "price-impact-too-high", sample)).toBe(
          "price-impact-too-high",
        );
      }
    });

    /**
     * @spec DoD-3
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 금액이 잔액 이하다. 견적이 `success`이고 가격 영향이 `error` 등급이 아니며 최소 수령량이 `0n`이다. 표본: 방향(보내는 ETH·받는 USDC, 보내는 USDC·받는 ETH) × 가격 영향 등급(`normal`, `warning`)을 하나씩 반복하며, 보내는 ETH 방향의 allowance는 `idle`, 보내는 USDC 방향의 allowance는 성공 값 없이 `error`, 성공 값 없이 `loading`, `success`이고 `amountInRaw`보다 작음, `success`이고 `amountInRaw` 이상을 각각 둔다
     * @when 주 버튼 상태를 판정한다
     * @then 모든 표본의 판정이 `amount-too-small`이다
     */
    it("[DoD-3] 최소 수령량이 0이면 두 방향 모두 amount-too-small이다", () => {
      const erc20Allowances = ["error", "loading", "below", "above"] as const;
      const samples: Sample[] = NOT_ERROR_SEVERITIES.flatMap((severity) => [
        { ...CONNECTED, ...part("ETH", "USDC", "valid", "success", severity, "zero", "idle") },
        ...erc20Allowances.map((allowance) => ({
          ...CONNECTED,
          ...part("USDC", "ETH", "valid", "success", severity, "zero", allowance),
        })),
      ]);
      expect(samples).toHaveLength(2 * (1 + 4));

      for (const [index, sample] of samples.entries()) {
        expect(judge(sample), sampleLabel(index, "amount-too-small", sample)).toBe(
          "amount-too-small",
        );
      }
    });
  });

  describe("받는 토큰이 ETH인 스왑 (ERC-20 → ETH)의 allowance 판정", () => {
    /**
     * @spec DoD-4
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 보내는 토큰이 WETH가 아닌 ERC-20, 받는 토큰이 ETH이고 금액이 잔액 이하다. 견적이 `success`이고 가격 영향이 `error` 등급이 아니며 최소 수령량이 0보다 크고, 현재 키에 성공 값 없이 allowance 읽기가 실패했다. 표본: 보내는 토큰(USDC, DAI) × 가격 영향 등급(`normal`, `warning`)을 하나씩 반복하고, 비교 표본으로 같은 입력에서 받는 토큰만 ERC-20(보내는 USDC면 DAI, 보내는 DAI면 USDC)으로 바꾼 ERC-20↔ERC-20 페어를 둔다
     * @when 두 표본의 주 버튼 상태를 판정한다
     * @then 받는 토큰이 ETH인 표본의 판정이 `allowance-error`다
     * @then 받는 토큰이 ETH인 표본의 판정이 비교 ERC-20↔ERC-20 표본의 판정과 같다
     */
    it("[DoD-4] 성공 값 없이 allowance 읽기가 실패하면 ERC-20 페어와 같이 allowance-error다", () => {
      expectSameAsErc20Pair(
        "allowance-error",
        ERC20_SENDERS.flatMap((tokenIn) =>
          NOT_ERROR_SEVERITIES.map((severity) => erc20ToEth(tokenIn, severity, "error")),
        ),
      );
    });

    /**
     * @spec DoD-4
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 보내는 토큰이 WETH가 아닌 ERC-20, 받는 토큰이 ETH이고 금액이 잔액 이하다. 견적이 `success`이고 가격 영향이 `error` 등급이 아니며 최소 수령량이 0보다 크고, 현재 키에 성공 값 없이 allowance를 읽는 중이다. 표본: 보내는 토큰(USDC, DAI) × 가격 영향 등급(`normal`, `warning`)을 하나씩 반복하고, 비교 표본으로 같은 입력에서 받는 토큰만 ERC-20으로 바꾼 ERC-20↔ERC-20 페어를 둔다
     * @when 두 표본의 주 버튼 상태를 판정한다
     * @then 받는 토큰이 ETH인 표본의 판정이 `checking-allowance`다
     * @then 받는 토큰이 ETH인 표본의 판정이 비교 ERC-20↔ERC-20 표본의 판정과 같다
     */
    it("[DoD-4] 성공 값 없이 allowance를 읽는 중이면 ERC-20 페어와 같이 checking-allowance다", () => {
      expectSameAsErc20Pair(
        "checking-allowance",
        ERC20_SENDERS.flatMap((tokenIn) =>
          NOT_ERROR_SEVERITIES.map((severity) => erc20ToEth(tokenIn, severity, "loading")),
        ),
      );
    });

    /**
     * @spec DoD-4
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 보내는 토큰이 WETH가 아닌 ERC-20, 받는 토큰이 ETH이고 금액이 잔액 이하다. 견적이 `success`이고 가격 영향이 `error` 등급이 아니며 최소 수령량이 0보다 크고, allowance가 `success`이고 `amountInRaw`보다 작다. 표본: 보내는 토큰(USDC, DAI) × allowance(`0`, 0보다 크고 `amountInRaw`보다 작은 값)를 하나씩 반복하고, 비교 표본으로 같은 입력에서 받는 토큰만 ERC-20으로 바꾼 ERC-20↔ERC-20 페어를 둔다
     * @when 두 표본의 주 버튼 상태를 판정한다
     * @then 받는 토큰이 ETH인 표본의 판정이 `approve-required`다
     * @then 받는 토큰이 ETH인 표본의 판정이 비교 ERC-20↔ERC-20 표본의 판정과 같다
     */
    it("[DoD-4] allowance가 amountInRaw보다 작으면 ERC-20 페어와 같이 approve-required다", () => {
      expectSameAsErc20Pair(
        "approve-required",
        ERC20_SENDERS.flatMap((tokenIn) =>
          (["zero", "below"] as const).map((allowance) => erc20ToEth(tokenIn, "normal", allowance)),
        ),
      );
    });

    /**
     * @spec DoD-4
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 보내는 토큰이 WETH가 아닌 ERC-20, 받는 토큰이 ETH이고 금액이 잔액 이하다. 견적이 `success`이고 가격 영향이 `error` 등급이 아니며 최소 수령량이 0보다 크고, allowance가 `success`이고 `amountInRaw` 이상이다. 표본: 보내는 토큰(USDC, DAI) × allowance(`amountInRaw`와 같은 값, `amountInRaw`보다 큰 값)를 하나씩 반복하고, 비교 표본으로 같은 입력에서 받는 토큰만 ERC-20으로 바꾼 ERC-20↔ERC-20 페어를 둔다
     * @when 두 표본의 주 버튼 상태를 판정한다
     * @then 받는 토큰이 ETH인 표본의 판정이 `swap-ready`다
     * @then 받는 토큰이 ETH인 표본의 판정이 비교 ERC-20↔ERC-20 표본의 판정과 같다
     */
    it("[DoD-4] allowance가 amountInRaw 이상이면 ERC-20 페어와 같이 swap-ready다", () => {
      expectSameAsErc20Pair(
        "swap-ready",
        ERC20_SENDERS.flatMap((tokenIn) =>
          (["equal", "above"] as const).map((allowance) =>
            erc20ToEth(tokenIn, "normal", allowance),
          ),
        ),
      );
    });
  });

  describe("ETH ↔ WETH 전환", () => {
    /**
     * @spec DoD-18
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 보내는 토큰이 ETH, 받는 토큰이 WETH이고 금액이 잔액 이하이며 견적 상태가 `wrap`이다. 표본: 체인(Ethereum, Base, Arbitrum)마다 그 체인의 ETH·WETH를 하나씩 반복한다(allowance는 `idle`)
     * @when 주 버튼 상태를 판정한다
     * @then 모든 표본의 판정이 `wrap-ready`다
     * @then 모든 표본에서 주 버튼이 활성이다
     */
    it("[DoD-18] ETH → WETH 견적이 wrap이면 wrap-ready이고 활성이다", () => {
      for (const chainId of CHAIN_IDS) {
        const sample: Sample = {
          ...CONNECTED,
          ...part("ETH", "WETH", "valid", "wrap", null, null, "idle"),
          chainId,
        };
        const label = sampleLabel(chainId, "wrap-ready", sample);
        const state = judge(sample);
        expect(state, label).toBe("wrap-ready");
        expect(isPrimaryButtonEnabled(state), `${label}: 활성`).toBe(true);
      }
    });

    /**
     * @spec DoD-19
     * @given 지갑이 연결돼 있고 phase가 `idle`이며 보내는 토큰이 WETH, 받는 토큰이 ETH이고 금액이 잔액 이하이며 견적 상태가 `wrap`이다. 표본: 체인(Ethereum, Base, Arbitrum)마다 그 체인의 WETH·ETH × allowance(`idle`, 성공 값 없이 `loading`, 성공 값 없이 `error`, `success`이고 `amountInRaw`보다 작음, `success`이고 `amountInRaw` 이상)를 하나씩 반복한다
     * @when 주 버튼 상태를 판정한다
     * @then 모든 표본의 판정이 `unwrap-ready`다
     * @then 모든 표본에서 주 버튼이 활성이다
     */
    it("[DoD-19] WETH → ETH 견적이 wrap이면 unwrap-ready이고 활성이다", () => {
      const allowances = ["idle", "loading", "error", "below", "above"] as const;
      for (const chainId of CHAIN_IDS) {
        for (const allowance of allowances) {
          const sample: Sample = {
            ...CONNECTED,
            ...part("WETH", "ETH", "valid", "wrap", null, null, allowance),
            chainId,
          };
          const label = sampleLabel(chainId, "unwrap-ready", sample);
          const state = judge(sample);
          expect(state, label).toBe("unwrap-ready");
          expect(isPrimaryButtonEnabled(state), `${label}: 활성`).toBe(true);
        }
      }
    });
  });

  describe("보내는 ETH 금액이 잔액과 같은 경우 (가스 예약 경계)", () => {
    /**
     * @spec EC-4
     * @given 지갑이 Ethereum에 연결돼 있고 phase가 `idle`이며 보내는 ETH, 받는 USDC이고, 금액이 보내는 ETH 잔액과 정확히 같다. 견적이 `success`이고 가격 영향이 `normal` 등급이며 최소 수령량이 0보다 크고 allowance는 `idle`이다. 표본 잔액(= 금액): 1 ETH, Ethereum 가스 예약량과 같은 0.005 ETH, 가스 예약량보다 작은 0.001 ETH를 하나씩 반복한다
     * @when 주 버튼 상태를 판정한다
     * @then 모든 표본의 판정이 `swap-ready`다(`insufficient-balance`가 아니다)
     */
    it("[EC-4] ETH → USDC 금액이 잔액과 같아도 swap-ready다", () => {
      for (const balanceRaw of EC4_BALANCES_RAW) {
        const state = getPrimaryButtonState(
          getPrimaryButtonStateParams(ethAllInSource("USDC", balanceRaw)),
        );
        expect(state, `잔액 = 금액 = ${balanceRaw}`).toBe("swap-ready");
      }
    });

    /**
     * @spec EC-4
     * @given 지갑이 Ethereum에 연결돼 있고 phase가 `idle`이며 보내는 ETH, 받는 WETH이고, 금액이 보내는 ETH 잔액과 정확히 같으며 견적 상태가 `wrap`이다. allowance는 `idle`이다. 표본 잔액(= 금액): 1 ETH, Ethereum 가스 예약량과 같은 0.005 ETH, 가스 예약량보다 작은 0.001 ETH를 하나씩 반복한다
     * @when 주 버튼 상태를 판정한다
     * @then 모든 표본의 판정이 `wrap-ready`다(`insufficient-balance`가 아니다)
     */
    it("[EC-4] ETH → WETH 금액이 잔액과 같아도 wrap-ready다", () => {
      for (const balanceRaw of EC4_BALANCES_RAW) {
        const state = getPrimaryButtonState(
          getPrimaryButtonStateParams(ethAllInSource("WETH", balanceRaw)),
        );
        expect(state, `잔액 = 금액 = ${balanceRaw}`).toBe("wrap-ready");
      }
    });
  });
});
