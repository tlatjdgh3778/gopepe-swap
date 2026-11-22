# 스펙: usd-price (달러 환산과 공유 가격 소스)

- 상태: 완료
- 최종 갱신: 2026-11-22

## 1. 목표

보내는·받는 금액, 카드 잔액, 토큰 모달 잔액, 견적 정보의 예상·최소 수령량을 USD로 함께 보여 준다. 가격 소스는 Uniswap V3 QuoterV2 온체인 조회이고, 세 체인(Ethereum·Base·Arbitrum) 모두 지원한다. 가격은 체인·토큰별 단가로 구하고 USD는 금액 × 단가로 계산한다. 이 단가 조회는 F10 `network-fee`의 수수료 USD 표시가 그대로 재사용하는 계약(§4)으로 둔다. [사용자 결정]

### 1.1 화면

- 보내는 칸과 받는 칸의 금액 아래에 USD 행을 새로 둔다 [사용자 결정]

```text
│ 보내는 토큰                  잔액 1.25 · $2,969.88 최대│
│ 0.5                                          [ETH ▾] │
│ $1,187.95                                            │
```

- 카드 잔액은 `잔액 1.25 · $2,969.88`처럼 잔액 뒤에 `·`와 USD를 붙인다 [사용자 결정]
- 토큰 모달은 잔액이 있는 토큰 행의 잔액에 USD를 함께 보인다 [사용자 결정]
- 견적 정보의 `예상 수령량`·`최소 수령량` 행 값에 USD를 덧붙인다 [사용자 결정]
- 견적 행의 USD는 카드 잔액과 같이 `·` 뒤에 붙인다(`2,950.12 USDC · $2,950.12`) [제안 후 승인]
- USD 표기는 기호 없이 `$1,187.95` 형식이다(`≈` 없음) [사용자 결정]
- USD는 보조 텍스트 색(`text-muted-foreground`)과 `font-mono tabular-nums`로 표시한다 [제안 후 승인]
- 가격 없음·조회 실패는 금액 아래 USD 행에 `—`로 보이고, 접근성 이름은 `USD 가격 없음`이다 [제안 후 승인]

## 2. 비목표

- 네트워크 수수료 USD 표시. F10이 맡고, 이 스펙은 F10이 쓸 계약(§4)만 제공한다 [제안 후 승인]
- USD로 금액 입력(달러 입력 모드·토큰/USD 전환) [제안 후 승인]
- 받는 쪽 USD 옆에 보내는 USD 대비 차이(%) 표시 [제안 후 승인]
- 토큰 모달을 USD 가치순으로 정렬. F2 정렬(고정 → 잔액 → 나머지)을 유지한다 [사용자 결정]
- USDC 직접·WETH 경유가 아닌 가격 경로(USDT·DAI 경유 등) [제안 후 승인]
- USDC 디페그 보정과 외부 가격 API 대체 [제안 후 승인]
- Base·Arbitrum 포크 자동 테스트 [제안 후 승인]

## 3. 완료의 정의

### 3.1 단가 산출

- DoD-1: USDC 직접 경로가 있는 토큰의 단가는 토큰 1개(10^decimals)를 체인 네이티브 USDC로 네 티어 견적해 기존 `selectFeeTier` 규칙으로 고른 티어 풀의 `slot0` 현물가다 — 검증: 단위 테스트 (현물가 계산), 통합 테스트 (fetch stub) [사용자 결정]
- DoD-2: USDC 직접 경로가 없고 토큰→WETH 경로가 있으면 단가는 토큰→WETH 현물가 × WETH→USDC 현물가다. 각 구간의 티어는 DoD-1과 같은 방법으로 고른다 — 검증: 단위 테스트, 통합 테스트 (fetch stub) [사용자 결정]
- DoD-3: 체인 네이티브 USDC의 단가는 정확히 $1이고, 그 단가를 구하려고 RPC 요청을 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- DoD-4: `NATIVE_ETH_ADDRESS`의 단가는 같은 체인 WETH의 단가와 같다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-5: Ethereum 포크 고정 블록에서 ETH와 USDC 직접 경로 토큰의 단가가, 포크에서 QuoterV2·`slot0`을 직접 읽어 계산한 값과 같다 — 검증: 통합 테스트 (실제 anvil 포크, `test:fork`) [제안 후 승인]
- DoD-6: Ethereum 포크 고정 블록에서 WETH 경유만 가능한 토큰의 단가가, 포크에서 두 구간을 직접 읽어 계산한 값과 같다. 토큰은 계획의 사전 확인에서 고른다 — 검증: 통합 테스트 (실제 anvil 포크, `test:fork`) [제안 후 승인]
- DoD-7: 가격 조회 요청은 모두 `/api/rpc/[chainId]` 프록시로만 나간다 — 검증: E2E (JSON-RPC 요청 관찰), 코드 대조 [사용자 결정]
- DoD-8: Base 메인넷에서 ETH·USDC·WETH 경유 토큰 하나의 USD가 표시된다 — 검증: 수동 1회, 결과 기록 [제안 후 승인]
- DoD-9: Arbitrum 메인넷에서 ETH·USDC·WETH 경유 토큰 하나의 USD가 표시된다 — 검증: 수동 1회, 결과 기록 [제안 후 승인]

### 3.2 환산과 표기

- DoD-10: `toUsdMicros(amountRaw, price)`는 `amountRaw × numerator / denominator`를 버림한 값이다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-11: `formatUsd`는 소수 2자리 버림과 천 단위 쉼표로 `$1,187.95` 형식을 만든다 — 검증: 단위 테스트 [사용자 결정]
- DoD-12: `formatUsd`는 0보다 크고 $0.01보다 작은 값을 `<$0.01`로 표시한다 — 검증: 단위 테스트 [사용자 결정]
- DoD-13: `formatUsd`는 0을 `$0.00`으로 표시한다 — 검증: 단위 테스트 [사용자 결정]
- DoD-14: `formatUsd`는 큰 값을 축약하지 않는다(`$1,234,567.89`) — 검증: 단위 테스트 [사용자 결정]
- DoD-15: 단가·USD 계산과 표기는 bigint 문자열 연산만 쓰고 `Intl`·`toLocaleString`을 쓰지 않는다 — 검증: 코드 대조 [제안 후 승인]

### 3.3 화면 표시

- DoD-16: 보내는 칸에 토큰과 0보다 큰 금액이 있고 단가가 `success`이면 `usd-value[data-side=in]`은 `data-state=success`이고 `data-usd-micros`는 `toUsdMicros(amountInRaw, 보내는 토큰 단가)`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-17: 견적이 `success`이고 받는 토큰 단가가 `success`이면 `usd-value[data-side=out]`은 `data-state=success`이고 `data-usd-micros`는 `toUsdMicros(amountOut, 받는 토큰 단가)`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-18: ETH ↔ WETH(`wrap`)에서는 보내는·받는 `usd-value`가 모두 WETH 단가로 계산한 같은 `data-usd-micros`다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-19: 연결 상태에서 카드 잔액이 0보다 크고 그 토큰 단가가 `success`이면 `balance-usd`의 `data-usd-micros`는 `toUsdMicros(잔액, 단가)`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-20: 토큰 모달에서 잔액이 0보다 크고 단가가 `success`인 행의 `token-option-usd`의 `data-usd-micros`는 `toUsdMicros(잔액, 단가)`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-21: 견적 `success`에서 `quote-amount-out-usd`의 `data-usd-micros`는 `toUsdMicros(amountOut, 받는 토큰 단가)`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-22: 견적 `success`에서 `quote-amount-out-minimum-usd`의 `data-usd-micros`는 `toUsdMicros(useAmountOutMinimum(), 받는 토큰 단가)`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-23: Ethereum 포크 E2E에서 ETH→USDC 금액을 입력하면 `usd-value[data-side=in]`이 `success`이고 `data-usd-micros`가 러너가 포크에서 직접 읽은 `slot0`로 계산한 값과 같다 — 검증: E2E [제안 후 승인]
- DoD-24: Ethereum 포크 E2E에서 ETH→USDC 견적이 나오면 `usd-value[data-side=out]`이 `success`이고 `data-usd-micros`가 러너 계산과 같다 — 검증: E2E [제안 후 승인]
- DoD-25: Ethereum 포크 E2E에서 잔액이 있는 토큰의 모달 행에 `token-option-usd`가 있다 — 검증: E2E [제안 후 승인]

### 3.4 갱신과 캐시

- DoD-26: 카드·견적 행이 쓰는 단가는 60초마다 다시 읽는다 — 검증: 통합 테스트 (fake timers) [사용자 결정]
- DoD-27: 창 포커스 때 단가를 다시 읽는다 — 검증: 통합 테스트 [사용자 결정]
- DoD-28: 숨김 탭에서는 단가 주기 갱신을 하지 않는다 — 검증: 통합 테스트 [사용자 결정]
- DoD-29: 같은 체인·토큰의 단가는 한 캐시를 공유한다. 카드와 견적 행은 서로 이미 `success`인 단가를, 모달 일괄 조회 결과는 카드와 견적 행이 추가 요청 없이 쓴다. 모달 일괄 조회는 카드에 이미 있는 단가도 다시 조회한다(EC-22) — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- DoD-30: 토큰 모달은 잔액 읽기가 끝난 뒤 잔액이 0보다 큰 토큰의 단가만 일괄 조회한다 — 검증: 통합 테스트 (요청 디코딩) [사용자 결정]
- DoD-31: 모달 일괄 조회는 USDC 직접 경로 조회 뒤, 직접 경로가 없는 토큰만 WETH 경유로 한 번 더 조회한다 — 검증: 통합 테스트 (요청 디코딩) [제안 후 승인]
- DoD-32: 모달이 열려 있는 동안 모달 일괄 조회 요청을 다시 보내지 않는다. 같은 토큰의 카드 쪽 주기 갱신(DoD-26)으로 공유 캐시 값이 바뀌어 모달 표시가 바뀌는 것은 허용한다 — 검증: 통합 테스트 (fake timers, 요청 기록) [제안 후 승인]

### 3.5 통합과 제약

- DoD-33: 새 패키지, 외부 HTTP 요청, 환경 변수를 추가하지 않는다 — 검증: 코드 대조 [제안 후 승인]
- DoD-34: `bun run check:build`가 변경 없이 통과한다 — 검증: 명령 실행 확인 [제안 후 승인]
- DoD-35: 계획 파일에 화면당 분당 추가 RPC 요청 수 산정이 있고, 그 값이 WAF 한도(IP당 60초 120건) 안이다 — 검증: 코드 대조 [제안 후 승인]
- DoD-36: F3 견적 동작은 바뀌지 않아, 기존 견적 테스트가 수정 없이 통과한다. 예외는 F3 E2E `[EC-6]`(ETH→WETH QuoterV2 0건)과 F3 통합 `quote-read`의 `[DoD-1][DoD-4][DoD-16][DoD-37]`(견적 요청의 선택 체인 경로)의 집계를 견적 요청으로 좁혀 단가 요청을 빼는 회귀 갱신, 그리고 F4 통합 `slippage-quote`의 최소 수령량 행 값 비교에서 USD 요소를 빼는 회귀 갱신뿐이다(§4.5) — 검증: 명령 실행 확인 (`bun run test`, `bun run test:fork`, `bun run test:e2e`) [사용자 결정]
- DoD-37: README 알려진 한계에서 "달러 환산을 표시하지 않는다." 문장을 뺀다 — 검증: 코드 대조 [제안 후 승인]
- DoD-38: `docs/design/README.md`의 제거 항목 문장에서 "달러 환산"을 뺀다 — 검증: 코드 대조 [제안 후 승인]

## 4. 인터페이스 계약

### 4.1 순수 함수 (`lib/token-usd-price.ts`)

- 타입 [제안 후 승인]

```ts
/** 토큰 raw 1단위당 USD. usdMicros = amountRaw × numerator / denominator (USDC raw 6자리 단위) */
type UsdPrice = { numerator: bigint; denominator: bigint };

type TokenUsdPriceState =
  | { status: "idle" } // 토큰 미선택, 선택 체인 밖 토큰, 모달 일괄 조회 전(이번 열기 잔액 읽기 성공 전)이고 캐시 없음
  | { status: "loading" } // 첫 조회 중
  | { status: "success"; price: UsdPrice } // 갱신 실패여도 이전 값이 있으면 success
  | { status: "no-price" } // 직접·WETH 경유 모두 경로 없음
  | { status: "error" }; // 조회 실패, 이전 값 없음
```

- `toUsdMicros(amountRaw: bigint, price: UsdPrice): bigint` — 버림 [제안 후 승인]
- `formatUsd(usdMicros: bigint): string` — `"$1,187.95"` | `"<$0.01"` | `"$0.00"` [제안 후 승인]

### 4.2 조회와 훅

- 조회 함수와 훅 시그니처 [제안 후 승인]

```ts
// lib/read-token-usd-price.ts — 맵 키는 넘겨받은 소문자 주소, null은 가격 없음(경로 없음·토큰 목록 밖 주소), RPC 조회 실패는 throw
readTokenUsdPrices(
  client: TokenBalanceClient,
  input: { chainId: SupportedChainId; tokens: Address[] },
): Promise<
  Map<
    Address,
    UsdPrice | null
  >
>;

// hooks/use-token-usd-price.ts — 일괄 훅의 맵 키는 소문자 주소
useTokenUsdPrice(chainId: SupportedChainId, token: Address | undefined): TokenUsdPriceState;
useTokenUsdPrices(
  chainId: SupportedChainId,
  tokens: Address[],
  enabled: boolean,
): ReadonlyMap<
  Address,
  TokenUsdPriceState
>;
```

- 쿼리 키는 `["token-usd-price", chainId, 소문자 토큰 주소]`이고 단건·일괄 훅이 공유한다. `NATIVE_ETH_ADDRESS`는 키에서 같은 체인 WETH 주소로 바꿔 ETH와 WETH가 한 캐시 항목을 쓴다 [제안 후 승인]
- `NATIVE_ETH_ADDRESS`를 넘기면 같은 체인 WETH 단가를 돌려준다. F10은 `toUsdMicros(가스비 wei, useTokenUsdPrice(chainId, NATIVE_ETH_ADDRESS)의 price)`로 수수료 USD를 구한다 [제안 후 승인]

### 4.3 config

- `config/tokens.ts`는 체인 네이티브 USDC 주소를 체인 ID별로 담은 `USDC_BY_CHAIN`(`Record` 타입, 키 `SupportedChainId`, 값 `Address`)을 export한다 [제안 후 승인]

### 4.4 DOM

- `usd-value[data-side=in|out][data-state=empty|loading|success|no-price|error]`: 금액 아래 USD 행. `data-usd-micros`는 `success`일 때만 있고 값은 `toUsdMicros` 결과의 10진 문자열이다 [제안 후 승인]
- `balance-usd[data-usd-micros]`: 카드 잔액의 USD. 표시할 때만 있다 [제안 후 승인]
- `token-option-usd[data-usd-micros]`: 모달 행의 잔액 USD. 표시할 때만 있다 [제안 후 승인]
- `quote-amount-out-usd[data-usd-micros]`, `quote-amount-out-minimum-usd[data-usd-micros]`: 견적 정보 행의 USD. 표시할 때만 있다 [제안 후 승인]
- `usd-skeleton`: USD 자리의 로딩 스켈레톤. 기존 `quote-skeleton`은 USD 자리에 쓰지 않는다 [제안 후 승인]

### 4.5 이전 스펙 개정

이 스펙은 다음 항목을 바꾼다. 이전 스펙 파일은 고치지 않는다 [제안 후 승인]

- F2 §2의 "달러 환산(`≈ $`) 표시", F3 §2의 "달러 환산", F7 §2의 "달러 환산" 비목표는 이 스펙으로 해제된다. 가스 비용·네트워크 수수료 표시는 여전히 비목표다 [제안 후 승인]
- F2 §4.2와 F3 §4.3의 DOM에 §4.4의 testid를 더한다 [제안 후 승인]
- F3 통합 `__tests__/swap/quote-read.test.tsx`의 `[DoD-1][DoD-4][DoD-16][DoD-37]`이 `quoteExactInputSingle` selector로 모으는 fetch 집계는 견적 요청만 센다. 이 스펙의 단가 요청(기본 ETH 단가가 체인 전환 전에 `/api/rpc/1`로 나간다)은 집계에서 뺀다. 판정 의도(견적은 선택 체인 경로로만 간다)는 유지한다 [사용자 결정]
- F4 통합 `__tests__/swap/slippage-quote.test.tsx`가 `quote-amount-out-minimum` 값 칸(dd) 텍스트 전체를 [수량, 심볼]로 비교하는 assertion(`[DoD-17][DoD-18][DoD-19][DoD-22][DoD-24]` 등)은 §4.4의 USD 요소(`quote-amount-out-minimum-usd`·`usd-skeleton`)를 뺀 값 조각만 비교한다. 판정 의도(최소 수령량의 수량·심볼)는 유지한다 [사용자 결정]
- F3 E2E `[EC-6]`의 QuoterV2 호출 집계는 견적 요청만 센다. 이 스펙의 단가 요청은 집계에서 뺀다. 판정 의도(ETH ↔ WETH는 견적을 호출하지 않는다)는 유지한다 [제안 후 승인]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 상태 표시

- EC-1: 보내는 금액이 비었거나 0이면 `usd-value[data-side=in]`은 `data-state=empty`이고 행 자리는 유지한다 — 검증: 통합 테스트 [제안 후 승인]
- EC-2: 금액이 있고 단가를 처음 조회하는 중이면 `usd-value`는 `data-state=loading`이고 안에 `usd-skeleton`이 있다 — 검증: 통합 테스트 [제안 후 승인]
- EC-3: 견적이 `loading`·`no-route`·`error`이면 `usd-value[data-side=out]`은 `data-state=empty`다 — 검증: 통합 테스트 [제안 후 승인]
- EC-4: 단가가 `no-price`이면 `usd-value`는 `data-state=no-price`이고 접근성 이름 `USD 가격 없음`인 `—`를 보인다 — 검증: 통합 테스트 [제안 후 승인]
- EC-5: 단가가 `error`이면 `usd-value`는 `data-state=error`이고 접근성 이름 `USD 가격 없음`인 `—`를 보인다 — 검증: 통합 테스트 [제안 후 승인]
- EC-6: 카드 잔액이 0이거나 알 수 없으면(`—`) `balance-usd`가 없다 — 검증: 통합 테스트 [제안 후 승인]
- EC-7: 단가가 `no-price`·`error`이면 `balance-usd`·`token-option-usd`·`quote-amount-out-usd`·`quote-amount-out-minimum-usd`가 없다 — 검증: 통합 테스트 [제안 후 승인]
- EC-8: 카드 잔액·모달·견적 행은 단가 첫 조회 중 USD 자리에 `usd-skeleton`을 보인다 — 검증: 통합 테스트 [제안 후 승인]
- EC-9: 단가 갱신이 실패해도 이전 값이 있으면 `success`와 이전 `data-usd-micros`를 유지한다 — 검증: 통합 테스트 [제안 후 승인]
- EC-10: 단가 조회가 실패하면 재시도하지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]

### 5.2 입력·선택 변화

- EC-11: 선택 체인이 바뀌면 이전 체인의 단가로 USD를 계산하지 않고, 새 체인 단가가 없으면 `loading`이다 — 검증: 통합 테스트 [제안 후 승인]
- EC-12: 토큰을 바꾸거나 뒤집으면 이전 토큰의 단가로 USD를 계산하지 않는다. 같은 체인·토큰의 캐시가 있으면 바로 쓰고, 없으면 `loading`이다 — 검증: 통합 테스트 [제안 후 승인]
- EC-13: 보내는 금액이 바뀌면 단가를 다시 조회하지 않고 `usd-value[data-side=in]`만 즉시 다시 계산한다 — 검증: 통합 테스트 (요청 기록) [사용자 결정]

### 5.3 가격 경로

- EC-14: USDC.e·USDbC 같은 브리지 USDC는 $1로 고정하지 않고 DoD-1·2로 단가를 구한다 — 검증: 통합 테스트 [제안 후 승인]
- EC-15: USDC 직접 경로가 없고 토큰→WETH 경로는 있지만 WETH→USDC 조회가 실패하면 `error`다 — 검증: 통합 테스트 [제안 후 승인]
- EC-16: 1개 견적이 0이거나 모든 티어가 revert·유동성 소진이어서 USDC 직접·WETH 경유 모두 티어를 고를 수 없으면 `no-price`다 — 검증: 단위 테스트, 통합 테스트 [제안 후 승인]
- EC-17: 선택된 티어의 `slot0` 읽기가 실패하면 `error`다 — 검증: 통합 테스트 [제안 후 승인]
- EC-18: Ethereum 포크 고정 블록에서 USDC·WETH 풀이 모두 없는 토큰의 결과는 `null`이다 — 검증: 통합 테스트 (실제 anvil 포크, `test:fork`) [제안 후 승인]
- EC-26: USDC 직접 경로가 없고 토큰→WETH 경로는 있지만 WETH→USDC 경로가 없으면(조회 실패가 아닌 경로 없음) 결과는 `null`(`no-price`)이다 — 검증: 통합 테스트 [제안 후 승인]
- EC-27: `readTokenUsdPrices`에 선택 체인 토큰 목록에 없는 주소를 넘기면 그 주소의 결과는 `null`(`no-price`)이다 — 검증: 통합 테스트 [제안 후 승인]

### 5.4 모달 일괄 조회

- EC-19: 잔액이 있는 토큰이 많으면 일괄 조회를 묶음으로 나눠 업체 RPC의 eth_call 가스 상한을 넘지 않게 한다. 묶음 크기는 계획의 사전 확인에서 세 체인을 실측해 정한다. 가스 상한이 더 낮은 공개 RPC(fallback·preview)에서 묶음이 실패하면 EC-20으로 처리한다 — 검증: 테스트 설계 단계에서 확정 [사용자 결정]
- EC-20: 묶음(EC-19의 토큰 묶음 하나. 그 묶음의 1차 직접 경로 요청과 2차 WETH 경유 요청을 함께 가리킨다) 하나가 실패하면 그 묶음 토큰만 USD를 생략하고 나머지 토큰은 표시한다 — 검증: 통합 테스트 [제안 후 승인]
- EC-21: 모달 잔액 읽기가 실패하면 단가를 조회하지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- EC-22: 모달을 닫았다가 다시 열면 단가를 다시 조회한다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]

### 5.5 요청 한도·SSR·숫자

- EC-23: 프록시가 429를 돌려주면 다른 RPC 실패와 같이 처리한다(EC-5·EC-9·EC-10) — 검증: 통합 테스트 [제안 후 승인]
- EC-24: 서버 렌더링에서는 단가를 조회하지 않고, SSR 마크업과 첫 클라이언트 렌더의 `usd-value` 상태가 같다 — 검증: 통합 테스트 [제안 후 승인]
- EC-25: uint256 상한에 가까운 금액도 `toUsdMicros`가 정확한 bigint 결과를 낸다 — 검증: 단위 테스트 [제안 후 승인]

## 미결정 사항

없음
