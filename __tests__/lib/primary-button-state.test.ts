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
} from "@/lib/primary-button-state";

// 골격(T-6). 주 버튼 상태 판정의 순수 규칙만 다룬다(mock 없음, 정적 표본만).
// 스펙 DoD-5의 순서: `restoring` → `disconnected` → `awaiting-signature` → `approving` → `swapping` →
// `select-token` → `enter-amount` → `insufficient-balance` → `quoting` → `no-route` → `quote-error` →
// `quote-ready` → `price-impact-too-high` → `amount-too-small` → `allowance-error` → `checking-allowance` →
// `approve-required` → `swap-ready`
// 활성 여부·문구·화면 표시는 통합 테스트(T-8)가 다룬다.

// 스펙 DoD-5 순서 리터럴. 제품의 `PRIMARY_BUTTON_STATES`에서 가져오지 않는다.
const SPEC_ORDER = [
  "restoring",
  "disconnected",
  "awaiting-signature",
  "approving",
  "swapping",
  "select-token",
  "enter-amount",
  "insufficient-balance",
  "quoting",
  "no-route",
  "quote-error",
  "quote-ready",
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
// 토큰 미선택과 금액 빈 값처럼 함께 성립하는 조건을 그대로 표본에 담기 위해서다.

type Sample = {
  wallet: "restoring" | "disconnected" | "connected";
  phase: SwapExecutionPhase;
  // USDC·DAI는 ERC-20, ETH는 네이티브 ETH(Ethereum 고정 토큰).
  tokenIn: "USDC" | "ETH" | null;
  tokenOut: "DAI" | "ETH" | null;
  // empty: 빈 값, zero: 0, valid: 잔액 이하, over: 금액 정수 > 잔액 정수.
  amount: "empty" | "zero" | "valid" | "over";
  quote: "idle" | "loading" | "no-route" | "error" | "success";
  // 견적 `success`일 때만 값이 있다.
  severity: "normal" | "error" | null;
  // `useAmountOutMinimum()`. 견적 `success`일 때만 값이 있다.
  minimum: "positive" | "zero" | null;
  // error·loading: 현재 키에 성공 값 없이 읽기 실패·읽는 중. zero·below·equal·above: 성공 값과 `amountInRaw`의 대소.
  allowance: "idle" | "error" | "loading" | "zero" | "below" | "equal" | "above";
};

type LaterPart = Omit<Sample, "wallet" | "phase">;

function pinnedOf(chainId: SupportedChainId, symbol: string): Token {
  const token = PINNED_TOKENS_BY_CHAIN[chainId].find((candidate) => candidate.symbol === symbol);
  if (!token) throw new Error(`체인 ${chainId}의 고정 토큰 ${symbol}가 없다`);
  return token;
}

const TOKENS = {
  USDC: pinnedOf(1, "USDC"),
  DAI: pinnedOf(1, "DAI"),
  ETH: pinnedOf(1, "ETH"),
} as const;

const AMOUNT_IN_RAW = 1_000_000n;
const BALANCE_IN_RAW_ENOUGH = 5_000_000n;
const BALANCE_IN_RAW_SHORT = 999_999n;
const AMOUNT_OUT_RAW = 1_000_000_000_000_000_000n;
const AMOUNT_OUT_MINIMUM_POSITIVE = 995_000_000_000_000_000n;
// F3 DoD-17: 표시값 3% 이하 `normal`, 15% 초과 `error`.
const PRICE_IMPACT_BPS = { normal: 10, error: 2000 } as const;
const ALLOWANCE_RAW = {
  zero: 0n,
  below: AMOUNT_IN_RAW - 1n,
  equal: AMOUNT_IN_RAW,
  above: 2n ** 256n - 1n,
} as const;

function toSourceParams(sample: Sample): PrimaryButtonSourceParams {
  const amountInRaw =
    sample.amount === "empty" ? null : sample.amount === "zero" ? 0n : AMOUNT_IN_RAW;
  const balanceInRaw = sample.amount === "over" ? BALANCE_IN_RAW_SHORT : BALANCE_IN_RAW_ENOUGH;

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
    tokenIn: sample.tokenIn === null ? null : TOKENS[sample.tokenIn],
    tokenOut: sample.tokenOut === null ? null : TOKENS[sample.tokenOut],
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

/**
 * 표본이 스펙 계약상 함께 올 수 있는 값인지 확인한다.
 * 견적 `idle`은 토큰 미선택 또는 금액이 비었거나 0인 상태다(F3 §4). 가격 영향과 최소 수령량은 견적 `success`일 때만 있다(F3·F4 §4).
 * allowance는 보내는 토큰이 ERC-20일 때만 읽는 것으로 둔다. ERC-20↔ERC-20 페어 견적 `success`와 allowance `idle`은 쓰지 않는다(골자 @given).
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
  if (sample.allowance !== "idle") {
    expect(sample.tokenIn, `${label}: allowance는 ERC-20 보내는 토큰만`).toBe("USDC");
  }
  if (
    sample.quote === "success" &&
    bothSelected(sample) &&
    sample.tokenIn !== "ETH" &&
    sample.tokenOut !== "ETH"
  ) {
    expect(sample.allowance, `${label}: ERC-20 페어 견적 success에서 allowance idle 없음`).not.toBe(
      "idle",
    );
  }
}

// ─── 상태 조건(스펙 DoD-5~11, EC-14, F2·F3 입력·견적 상태) ──────────────────
// 각 조건은 부분 조건의 곱이다. 부분 조건의 group이 같으면 서로 배타적인 값이다
// (지갑 복원 중과 미연결, phase 값, 입력 상태 값, 견적 상태 값, ETH가 낀 페어와 ERC-20↔ERC-20 페어, allowance 상태 값과 대소).

type Group =
  | "wallet"
  | "phase"
  | "tokens"
  | "amount"
  | "quote"
  | "pair"
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
const INPUT_VALID: Requirement = {
  groups: ["tokens", "amount"],
  holds: (sample) => bothSelected(sample) && sample.amount === "valid",
};
const PAIR_ETH: Requirement = {
  groups: ["pair"],
  holds: (sample) =>
    bothSelected(sample) && (sample.tokenIn === "ETH" || sample.tokenOut === "ETH"),
};
const PAIR_ERC20: Requirement = {
  groups: ["pair"],
  holds: (sample) => bothSelected(sample) && sample.tokenIn !== "ETH" && sample.tokenOut !== "ETH",
};
const SEVERITY_ERROR: Requirement = {
  groups: ["severity"],
  holds: (sample) => sample.severity === "error",
};
const MINIMUM_ZERO: Requirement = {
  groups: ["minimum"],
  holds: (sample) => sample.minimum === "zero",
};
const hasAmountInRaw = (sample: Sample) => sample.amount === "valid" || sample.amount === "over";
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
const ERC20_QUOTE_SUCCESS = [INPUT_VALID, quoteIs("success"), PAIR_ERC20] as const;

const CONDITIONS: Record<State, readonly Requirement[]> = {
  restoring: [walletIs("restoring")],
  disconnected: [walletIs("disconnected")],
  "awaiting-signature": [phaseIs("awaiting-signature")],
  approving: [phaseIs("approving")],
  swapping: [phaseIs("swapping")],
  "select-token": [TOKENS_MISSING],
  "enter-amount": [AMOUNT_EMPTY],
  "insufficient-balance": [AMOUNT_OVER_BALANCE],
  quoting: [INPUT_VALID, quoteIs("loading")],
  "no-route": [INPUT_VALID, quoteIs("no-route")],
  "quote-error": [INPUT_VALID, quoteIs("error")],
  "quote-ready": [INPUT_VALID, quoteIs("success"), PAIR_ETH],
  "price-impact-too-high": [...ERC20_QUOTE_SUCCESS, SEVERITY_ERROR],
  "amount-too-small": [...ERC20_QUOTE_SUCCESS, MINIMUM_ZERO],
  "allowance-error": [...ERC20_QUOTE_SUCCESS, allowanceIn("error")],
  "checking-allowance": [...ERC20_QUOTE_SUCCESS, allowanceIn("loading")],
  "approve-required": [...ERC20_QUOTE_SUCCESS, ALLOWANCE_BELOW_AMOUNT],
  "swap-ready": [...ERC20_QUOTE_SUCCESS, ALLOWANCE_AT_LEAST_AMOUNT],
};

function holdsFully(state: State, sample: Sample): boolean {
  return CONDITIONS[state].every((requirement) => requirement.holds(sample));
}

/**
 * 앞 상태 `first`의 값을 둔 채 뒤 상태 `later`의 조건이 성립하는지 본다.
 * `later`의 부분 조건 중 `first`와 같은 group(배타적인 부분)은 `first`의 값을 두므로 건너뛰고, 나머지는 모두 성립해야 한다.
 */
function holdsAlongside(first: State, later: State, sample: Sample): boolean {
  const firstGroups = new Set(CONDITIONS[first].flatMap((requirement) => requirement.groups));
  return CONDITIONS[later]
    .filter((requirement) => !requirement.groups.some((group) => firstGroups.has(group)))
    .every((requirement) => requirement.holds(sample));
}

function sampleLabel(index: number, expected: State, sample: Sample): string {
  return `#${index} ${expected} ← ${JSON.stringify(sample)}`;
}

// ─── 한 상태의 조건만 성립하는 표본 ─────────────────────────────────
// 지갑·phase 상태(`restoring`~`swapping`)는 입력·견적·allowance가 계약상 늘 뒤 상태 하나에 해당하므로
// 단독 표본을 만들 수 없다. 골자가 `price-impact-too-high`·`amount-too-small`에 둔 방식대로 나머지를
// `swap-ready` 조건으로 두고, 함께 성립하는 뒤 상태를 세 번째 값에 적는다.

const CONNECTED = { wallet: "connected", phase: "idle" } as const;

const READY: LaterPart = {
  tokenIn: "USDC",
  tokenOut: "DAI",
  amount: "valid",
  quote: "success",
  severity: "normal",
  minimum: "positive",
  allowance: "above",
};

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
  [
    "select-token",
    {
      ...CONNECTED,
      tokenIn: null,
      tokenOut: "DAI",
      amount: "valid",
      quote: "idle",
      severity: null,
      minimum: null,
      allowance: "idle",
    },
    [],
  ],
  [
    "enter-amount",
    { ...CONNECTED, ...READY, amount: "empty", quote: "idle", severity: null, minimum: null },
    [],
  ],
  [
    "enter-amount",
    { ...CONNECTED, ...READY, amount: "zero", quote: "idle", severity: null, minimum: null },
    [],
  ],
  [
    "insufficient-balance",
    { ...CONNECTED, ...READY, amount: "over", quote: "loading", severity: null, minimum: null },
    [],
  ],
  ["quoting", { ...CONNECTED, ...READY, quote: "loading", severity: null, minimum: null }, []],
  ["no-route", { ...CONNECTED, ...READY, quote: "no-route", severity: null, minimum: null }, []],
  ["quote-error", { ...CONNECTED, ...READY, quote: "error", severity: null, minimum: null }, []],
  ["quote-ready", { ...CONNECTED, ...READY, tokenIn: "ETH", allowance: "idle" }, []],
  ["quote-ready", { ...CONNECTED, ...READY, tokenOut: "ETH" }, []],
  ["price-impact-too-high", { ...CONNECTED, ...READY, severity: "error" }, ["swap-ready"]],
  ["amount-too-small", { ...CONNECTED, ...READY, minimum: "zero" }, ["swap-ready"]],
  ["allowance-error", { ...CONNECTED, ...READY, allowance: "error" }, []],
  ["checking-allowance", { ...CONNECTED, ...READY, allowance: "loading" }, []],
  ["approve-required", { ...CONNECTED, ...READY, allowance: "zero" }, []],
  ["approve-required", { ...CONNECTED, ...READY, allowance: "below" }, []],
  ["swap-ready", { ...CONNECTED, ...READY, allowance: "equal" }, []],
  ["swap-ready", { ...CONNECTED, ...READY, allowance: "above" }, []],
];

// ─── 인접한 두 상태의 조건이 겹치는 표본 ───────────────────────────────
// 행은 [앞 상태 i, 표본]이다. 표본은 i의 조건과, i와 함께 성립할 수 있는 뒤 상태 조건을 모두 성립시킨다.
// 뒤 상태들끼리 배타적이면(phase 값, 견적 상태 값, 페어 종류, allowance 상태 값) 행을 나눈다.

// 토큰 미선택 + 금액 빈 값(견적 idle).
const INCOMPLETE: LaterPart = {
  tokenIn: null,
  tokenOut: null,
  amount: "empty",
  quote: "idle",
  severity: null,
  minimum: null,
  allowance: "idle",
};

// 금액 정수 > 잔액 정수 + 견적 loading·no-route·error.
function overBalanceQuote(quote: "loading" | "no-route" | "error"): LaterPart {
  return {
    tokenIn: "USDC",
    tokenOut: "DAI",
    amount: "over",
    quote,
    severity: null,
    minimum: null,
    allowance: "error",
  };
}

// 금액 정수 > 잔액 정수 + 받는 토큰이 ETH인 페어 견적 success + 가격 영향 error 등급 + 최소 수령량 0n.
const OVER_BALANCE_ETH_PAIR_SUCCESS: LaterPart = {
  tokenIn: "USDC",
  tokenOut: "ETH",
  amount: "over",
  quote: "success",
  severity: "error",
  minimum: "zero",
  allowance: "error",
};

// 금액 정수 > 잔액 정수 + ERC-20↔ERC-20 견적 success + 가격 영향 error 등급 + 최소 수령량 0n + allowance 상태.
function overBalanceErc20Success(allowance: Sample["allowance"]): LaterPart {
  return {
    tokenIn: "USDC",
    tokenOut: "DAI",
    amount: "over",
    quote: "success",
    severity: "error",
    minimum: "zero",
    allowance,
  };
}

// 입력 유효 + 견적 loading·no-route·error + 페어 종류 + allowance 상태.
function validQuote(
  quote: "loading" | "no-route" | "error",
  tokenOut: "DAI" | "ETH",
  allowance: Sample["allowance"],
): LaterPart {
  return {
    tokenIn: "USDC",
    tokenOut,
    amount: "valid",
    quote,
    severity: null,
    minimum: null,
    allowance,
  };
}

// 입력 유효 + 견적 success + 페어 종류 + 가격 영향 등급 + 최소 수령량 + allowance 상태.
function validSuccess(
  tokenOut: "DAI" | "ETH",
  severity: "normal" | "error",
  minimum: "positive" | "zero",
  allowance: Sample["allowance"],
): LaterPart {
  return {
    tokenIn: "USDC",
    tokenOut,
    amount: "valid",
    quote: "success",
    severity,
    minimum,
    allowance,
  };
}

const OVERLAP_SAMPLES: readonly (readonly [State, Sample])[] = [
  // restoring: phase 각각 + 토큰 미선택 + 금액 빈 값, 금액 초과, 입력 유효 + 견적 상태·페어·가격 영향·최소 수령량·allowance 각각
  ["restoring", { wallet: "restoring", phase: "awaiting-signature", ...INCOMPLETE }],
  ["restoring", { wallet: "restoring", phase: "approving", ...INCOMPLETE }],
  ["restoring", { wallet: "restoring", phase: "swapping", ...INCOMPLETE }],
  [
    "restoring",
    { wallet: "restoring", phase: "awaiting-signature", ...overBalanceQuote("loading") },
  ],
  [
    "restoring",
    { wallet: "restoring", phase: "approving", ...validQuote("loading", "DAI", "error") },
  ],
  [
    "restoring",
    { wallet: "restoring", phase: "swapping", ...validQuote("no-route", "DAI", "error") },
  ],
  [
    "restoring",
    { wallet: "restoring", phase: "awaiting-signature", ...validQuote("error", "DAI", "error") },
  ],
  [
    "restoring",
    { wallet: "restoring", phase: "approving", ...validSuccess("ETH", "error", "zero", "error") },
  ],
  [
    "restoring",
    { wallet: "restoring", phase: "swapping", ...validSuccess("DAI", "error", "zero", "error") },
  ],
  [
    "restoring",
    {
      wallet: "restoring",
      phase: "awaiting-signature",
      ...validSuccess("DAI", "error", "zero", "loading"),
    },
  ],
  [
    "restoring",
    { wallet: "restoring", phase: "approving", ...validSuccess("DAI", "error", "zero", "below") },
  ],
  [
    "restoring",
    { wallet: "restoring", phase: "swapping", ...validSuccess("DAI", "error", "zero", "above") },
  ],

  // disconnected
  ["disconnected", { wallet: "disconnected", phase: "awaiting-signature", ...INCOMPLETE }],
  ["disconnected", { wallet: "disconnected", phase: "approving", ...INCOMPLETE }],
  ["disconnected", { wallet: "disconnected", phase: "swapping", ...INCOMPLETE }],
  [
    "disconnected",
    { wallet: "disconnected", phase: "awaiting-signature", ...overBalanceQuote("loading") },
  ],
  [
    "disconnected",
    { wallet: "disconnected", phase: "approving", ...validQuote("loading", "DAI", "error") },
  ],
  [
    "disconnected",
    { wallet: "disconnected", phase: "swapping", ...validQuote("no-route", "DAI", "error") },
  ],
  [
    "disconnected",
    { wallet: "disconnected", phase: "awaiting-signature", ...validQuote("error", "DAI", "error") },
  ],
  [
    "disconnected",
    {
      wallet: "disconnected",
      phase: "approving",
      ...validSuccess("ETH", "error", "zero", "error"),
    },
  ],
  [
    "disconnected",
    { wallet: "disconnected", phase: "swapping", ...validSuccess("DAI", "error", "zero", "error") },
  ],
  [
    "disconnected",
    {
      wallet: "disconnected",
      phase: "awaiting-signature",
      ...validSuccess("DAI", "error", "zero", "loading"),
    },
  ],
  [
    "disconnected",
    {
      wallet: "disconnected",
      phase: "approving",
      ...validSuccess("DAI", "error", "zero", "below"),
    },
  ],
  [
    "disconnected",
    { wallet: "disconnected", phase: "swapping", ...validSuccess("DAI", "error", "zero", "above") },
  ],

  // awaiting-signature
  ["awaiting-signature", { wallet: "connected", phase: "awaiting-signature", ...INCOMPLETE }],
  [
    "awaiting-signature",
    { wallet: "connected", phase: "awaiting-signature", ...overBalanceQuote("loading") },
  ],
  [
    "awaiting-signature",
    { wallet: "connected", phase: "awaiting-signature", ...validQuote("loading", "DAI", "error") },
  ],
  [
    "awaiting-signature",
    { wallet: "connected", phase: "awaiting-signature", ...validQuote("no-route", "DAI", "error") },
  ],
  [
    "awaiting-signature",
    { wallet: "connected", phase: "awaiting-signature", ...validQuote("error", "DAI", "error") },
  ],
  [
    "awaiting-signature",
    {
      wallet: "connected",
      phase: "awaiting-signature",
      ...validSuccess("ETH", "error", "zero", "error"),
    },
  ],
  [
    "awaiting-signature",
    {
      wallet: "connected",
      phase: "awaiting-signature",
      ...validSuccess("DAI", "error", "zero", "error"),
    },
  ],
  [
    "awaiting-signature",
    {
      wallet: "connected",
      phase: "awaiting-signature",
      ...validSuccess("DAI", "error", "zero", "loading"),
    },
  ],
  [
    "awaiting-signature",
    {
      wallet: "connected",
      phase: "awaiting-signature",
      ...validSuccess("DAI", "error", "zero", "below"),
    },
  ],
  [
    "awaiting-signature",
    {
      wallet: "connected",
      phase: "awaiting-signature",
      ...validSuccess("DAI", "error", "zero", "above"),
    },
  ],

  // approving
  ["approving", { wallet: "connected", phase: "approving", ...INCOMPLETE }],
  ["approving", { wallet: "connected", phase: "approving", ...overBalanceQuote("loading") }],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validQuote("loading", "DAI", "error") },
  ],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validQuote("no-route", "DAI", "error") },
  ],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validQuote("error", "DAI", "error") },
  ],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validSuccess("ETH", "error", "zero", "error") },
  ],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validSuccess("DAI", "error", "zero", "error") },
  ],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validSuccess("DAI", "error", "zero", "loading") },
  ],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validSuccess("DAI", "error", "zero", "below") },
  ],
  [
    "approving",
    { wallet: "connected", phase: "approving", ...validSuccess("DAI", "error", "zero", "above") },
  ],

  // swapping
  ["swapping", { wallet: "connected", phase: "swapping", ...INCOMPLETE }],
  ["swapping", { wallet: "connected", phase: "swapping", ...overBalanceQuote("loading") }],
  [
    "swapping",
    { wallet: "connected", phase: "swapping", ...validQuote("loading", "DAI", "error") },
  ],
  [
    "swapping",
    { wallet: "connected", phase: "swapping", ...validQuote("no-route", "DAI", "error") },
  ],
  ["swapping", { wallet: "connected", phase: "swapping", ...validQuote("error", "DAI", "error") }],
  [
    "swapping",
    { wallet: "connected", phase: "swapping", ...validSuccess("ETH", "error", "zero", "error") },
  ],
  [
    "swapping",
    { wallet: "connected", phase: "swapping", ...validSuccess("DAI", "error", "zero", "error") },
  ],
  [
    "swapping",
    { wallet: "connected", phase: "swapping", ...validSuccess("DAI", "error", "zero", "loading") },
  ],
  [
    "swapping",
    { wallet: "connected", phase: "swapping", ...validSuccess("DAI", "error", "zero", "below") },
  ],
  [
    "swapping",
    { wallet: "connected", phase: "swapping", ...validSuccess("DAI", "error", "zero", "above") },
  ],

  // select-token: 금액 빈 값 또는 금액 초과(토큰 미선택이라 견적 idle)
  ["select-token", { ...CONNECTED, ...INCOMPLETE }],
  [
    "select-token",
    {
      ...CONNECTED,
      tokenIn: "USDC",
      tokenOut: null,
      amount: "over",
      quote: "idle",
      severity: null,
      minimum: null,
      allowance: "idle",
    },
  ],

  // enter-amount: 금액 0(견적 idle)
  [
    "enter-amount",
    {
      ...CONNECTED,
      tokenIn: "USDC",
      tokenOut: "DAI",
      amount: "zero",
      quote: "idle",
      severity: null,
      minimum: null,
      allowance: "above",
    },
  ],

  // insufficient-balance: 견적 loading·no-route·error·success(페어·가격 영향·최소 수령량·allowance) 각각
  ["insufficient-balance", { ...CONNECTED, ...overBalanceQuote("loading") }],
  ["insufficient-balance", { ...CONNECTED, ...overBalanceQuote("no-route") }],
  ["insufficient-balance", { ...CONNECTED, ...overBalanceQuote("error") }],
  ["insufficient-balance", { ...CONNECTED, ...OVER_BALANCE_ETH_PAIR_SUCCESS }],
  ["insufficient-balance", { ...CONNECTED, ...overBalanceErc20Success("error") }],
  ["insufficient-balance", { ...CONNECTED, ...overBalanceErc20Success("loading") }],
  ["insufficient-balance", { ...CONNECTED, ...overBalanceErc20Success("below") }],
  ["insufficient-balance", { ...CONNECTED, ...overBalanceErc20Success("above") }],

  // quoting: ETH가 낀 페어, ERC-20↔ERC-20 페어의 allowance 상태 각각
  ["quoting", { ...CONNECTED, ...validQuote("loading", "ETH", "error") }],
  ["quoting", { ...CONNECTED, ...validQuote("loading", "DAI", "error") }],
  ["quoting", { ...CONNECTED, ...validQuote("loading", "DAI", "loading") }],
  ["quoting", { ...CONNECTED, ...validQuote("loading", "DAI", "below") }],
  ["quoting", { ...CONNECTED, ...validQuote("loading", "DAI", "above") }],

  // no-route
  ["no-route", { ...CONNECTED, ...validQuote("no-route", "ETH", "error") }],
  ["no-route", { ...CONNECTED, ...validQuote("no-route", "DAI", "error") }],
  ["no-route", { ...CONNECTED, ...validQuote("no-route", "DAI", "loading") }],
  ["no-route", { ...CONNECTED, ...validQuote("no-route", "DAI", "below") }],
  ["no-route", { ...CONNECTED, ...validQuote("no-route", "DAI", "above") }],

  // quote-error
  ["quote-error", { ...CONNECTED, ...validQuote("error", "ETH", "error") }],
  ["quote-error", { ...CONNECTED, ...validQuote("error", "DAI", "error") }],
  ["quote-error", { ...CONNECTED, ...validQuote("error", "DAI", "loading") }],
  ["quote-error", { ...CONNECTED, ...validQuote("error", "DAI", "below") }],
  ["quote-error", { ...CONNECTED, ...validQuote("error", "DAI", "above") }],

  // quote-ready: 가격 영향 error 등급 + 최소 수령량 0n + allowance 상태 각각
  ["quote-ready", { ...CONNECTED, ...validSuccess("ETH", "error", "zero", "error") }],
  ["quote-ready", { ...CONNECTED, ...validSuccess("ETH", "error", "zero", "loading") }],
  ["quote-ready", { ...CONNECTED, ...validSuccess("ETH", "error", "zero", "below") }],
  ["quote-ready", { ...CONNECTED, ...validSuccess("ETH", "error", "zero", "above") }],

  // price-impact-too-high: 최소 수령량 0n + allowance 상태 각각
  ["price-impact-too-high", { ...CONNECTED, ...validSuccess("DAI", "error", "zero", "error") }],
  ["price-impact-too-high", { ...CONNECTED, ...validSuccess("DAI", "error", "zero", "loading") }],
  ["price-impact-too-high", { ...CONNECTED, ...validSuccess("DAI", "error", "zero", "below") }],
  ["price-impact-too-high", { ...CONNECTED, ...validSuccess("DAI", "error", "zero", "above") }],

  // amount-too-small: allowance 상태 각각
  ["amount-too-small", { ...CONNECTED, ...validSuccess("DAI", "normal", "zero", "error") }],
  ["amount-too-small", { ...CONNECTED, ...validSuccess("DAI", "normal", "zero", "loading") }],
  ["amount-too-small", { ...CONNECTED, ...validSuccess("DAI", "normal", "zero", "below") }],
  ["amount-too-small", { ...CONNECTED, ...validSuccess("DAI", "normal", "zero", "above") }],

  // allowance-error·checking-allowance·approve-required: allowance 상태가 배타적이라 앞 상태 조건만
  ["allowance-error", { ...CONNECTED, ...validSuccess("DAI", "normal", "positive", "error") }],
  ["checking-allowance", { ...CONNECTED, ...validSuccess("DAI", "normal", "positive", "loading") }],
  ["approve-required", { ...CONNECTED, ...validSuccess("DAI", "normal", "positive", "below") }],
];

// 앞 상태의 값을 두면 계약상 성립시킬 수 없는 뒤 상태(스펙 계약 근거). 이 쌍은 앞 상태 조건과 공존 가능한 뒤 상태 조건으로 본다.
const QUOTED_STATES = [
  "quoting",
  "no-route",
  "quote-error",
  "quote-ready",
  "price-impact-too-high",
  "amount-too-small",
  "allowance-error",
  "checking-allowance",
  "approve-required",
  "swap-ready",
] as const satisfies readonly State[];
const UNREACHABLE_AFTER: Partial<Record<State, readonly State[]>> = {
  // 토큰 미선택이거나 금액이 비었거나 0이면 견적은 `idle`이다(F3 §4).
  "select-token": QUOTED_STATES,
  "enter-amount": QUOTED_STATES,
  // 가격 영향 등급과 최소 수령량은 견적 `success`일 때만 있다(F3·F4 §4).
  quoting: ["price-impact-too-high", "amount-too-small"],
  "no-route": ["price-impact-too-high", "amount-too-small"],
  "quote-error": ["price-impact-too-high", "amount-too-small"],
};

describe("주 버튼 상태 — 위에서부터 먼저 해당하는 상태 하나로 정해진다", () => {
  describe("한 상태의 조건만 성립할 때", () => {
    /**
     * @spec DoD-5
     * @given 18개 상태 각각의 조건만 성립하는 표본을 하나씩 반복한다: 지갑 복원 중(`restoring`), 지갑 미연결(`disconnected`), 연결 상태에서 phase `awaiting-signature`·`approving`·`swapping`(각 상태), phase `idle`에서 토큰 미선택(`select-token`), 금액이 비었거나 0(`enter-amount`), 금액 정수가 보내는 토큰 잔액 정수보다 큼(`insufficient-balance`), 입력이 유효하고 견적 `loading`(`quoting`)·`no-route`(`no-route`)·`error`(`quote-error`), 보내는 토큰이 ETH인 페어와 받는 토큰이 ETH인 페어에서 견적 `success`(`quote-ready`), ERC-20↔ERC-20 페어에서 견적 `success`이고 가격 영향 `error` 등급(`price-impact-too-high`), 가격 영향이 `error` 등급이 아니고 최소 수령량 `0n`(`amount-too-small`), 최소 수령량이 0보다 크고 현재 키에 성공 값 없이 allowance 읽기 실패(`allowance-error`), 현재 키에 성공 값 없이 allowance 읽는 중(`checking-allowance`), allowance가 `amountInRaw`보다 작음(0과 0보다 큰 값 표본, `approve-required`), allowance가 `amountInRaw` 이상(같은 값과 큰 값 표본, `swap-ready`). ERC-20↔ERC-20 페어에서 견적이 `success`이면 allowance는 네 allowance 상태 중 하나에 해당하므로 `price-impact-too-high`·`amount-too-small` 표본의 allowance는 `success`이고 `amountInRaw` 이상으로 둔다(뒤 상태 중 `swap-ready` 조건만 함께 성립). ERC-20↔ERC-20 페어 견적 `success`와 allowance `idle`의 조합은 스펙상 발생하지 않아 표본에 쓰지 않는다(이 조합의 매핑은 구현 기록 몫이다)
     * @when 주 버튼 상태를 판정한다
     * @then 각 표본의 판정은 조건이 성립한 그 상태다
     */
    it("[DoD-5] 한 상태의 조건만 성립하면 그 상태로 판정한다", () => {
      expect(
        [...new Set(SOLE_SAMPLES.map(([expected]) => expected))],
        "18개 상태마다 표본이 있다",
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
  });

  describe("인접한 두 상태의 조건이 겹칠 때", () => {
    /**
     * @spec DoD-5
     * @given 순서상 인접한 경계 17개를 모두 덮도록, `swap-ready`를 뺀 앞 상태 i 각각과 그보다 뒤 상태 j 각각의 쌍마다 표본을 하나씩 두고 반복한다. 표본은 i의 조건, j의 조건, 그리고 i·j와 함께 성립할 수 있는 다른 뒤 상태 조건을 모두 성립시킨다. j의 조건 중 i와 배타적인 부분(지갑 복원 중과 미연결, phase 값, 입력 상태 값, 견적 상태 값, ETH가 낀 페어와 ERC-20↔ERC-20 페어, allowance 상태 값과 대소)은 i의 값을 두고 j 조건의 나머지 부분만 성립시키며, 뒤 상태들끼리 배타적이면 j를 바꿔 가며 각각 표본을 둔다. 그래서 두 조건이 함께 성립할 수 있는 인접 경계 6개(`disconnected`·`awaiting-signature`, `swapping`·`select-token`, `select-token`·`enter-amount`, `insufficient-balance`·`quoting`, `price-impact-too-high`·`amount-too-small`, `amount-too-small`·`allowance-error`)도 두 조건만이 아니라 공존 가능한 뒤 상태 조건을 함께 성립시키고, 두 조건이 배타적인 인접 경계 11개(`restoring`·`disconnected`, `awaiting-signature`·`approving`, `approving`·`swapping`, `enter-amount`·`insufficient-balance`, `quoting`·`no-route`, `no-route`·`quote-error`, `quote-error`·`quote-ready`, `quote-ready`·`price-impact-too-high`, `allowance-error`·`checking-allowance`, `checking-allowance`·`approve-required`, `approve-required`·`swap-ready`)는 앞 상태 조건과 그 뒤 상태들의 공존 가능한 조건으로 본다. 표본 예: 지갑 미연결이면서 phase `awaiting-signature`·`approving`·`swapping` 각각(토큰 미선택·금액 빈 값과 함께), 지갑 복원 중이면서 phase `approving`이고 토큰 미선택, phase `swapping`이면서 토큰 미선택·금액 빈 값, 금액 정수가 잔액 정수보다 크면서 견적 `loading`·`no-route`·`error`·`success`(ERC-20↔ERC-20 페어, 가격 영향 `error` 등급, 최소 수령량 `0n`, allowance 읽기 실패) 각각, ETH가 낀 페어에서 견적 `success`이면서 가격 영향 `error` 등급이고 최소 수령량 `0n`, 견적 `error`이면서 allowance가 `amountInRaw` 이상, 가격 영향 `error` 등급이면서 최소 수령량 `0n`이고 allowance 읽기 실패·읽는 중·`amountInRaw`보다 작음·`amountInRaw` 이상 각각, 최소 수령량 `0n`이면서 allowance 읽기 실패·읽는 중·`amountInRaw`보다 작음·`amountInRaw` 이상 각각, 현재 키에 성공 값 없이 allowance 읽기 실패·읽는 중(allowance 상태가 배타적이라 앞 상태 조건만)
     * @when 주 버튼 상태를 판정한다
     * @then 각 표본의 판정은 쌍의 앞선 상태 i다
     */
    it("[DoD-5] 인접한 두 상태의 조건이 함께 성립하면 앞선 상태로 판정한다", () => {
      // 표 점검: 앞 상태 i와 뒤 상태 j의 모든 쌍을 표본이 덮고, 인접 경계 17개는 계약상 성립시킬 수 없는 쌍으로 빼지 않는다.
      for (const [index, first] of SPEC_ORDER.entries()) {
        if (first === "swap-ready") continue;
        const rows = OVERLAP_SAMPLES.filter(([rowFirst]) => rowFirst === first);
        expect(rows.length, `${first}의 표본`).toBeGreaterThan(0);

        for (const [laterIndex, later] of SPEC_ORDER.entries()) {
          if (laterIndex <= index) continue;
          const covered = rows.some(([, sample]) => holdsAlongside(first, later, sample));
          if (laterIndex === index + 1) {
            expect(covered, `인접 경계 ${first} → ${later}의 표본`).toBe(true);
          } else {
            const unreachable = UNREACHABLE_AFTER[first]?.includes(later) ?? false;
            expect(covered || unreachable, `${first} → ${later}의 표본`).toBe(true);
          }
        }
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
  });
});
