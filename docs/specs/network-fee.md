# 스펙: network-fee (네트워크 수수료 표시·경고)

- 상태: 완료
- 최종 갱신: 2026-11-24

## 1. 목표

주 버튼이 다음에 보낼 트랜잭션(approve·swap·wrap·unwrap)의 예상 네트워크 수수료를 네이티브 ETH와 USD로 보여 주고, 수수료가 보내는 금액에 비해 크면 경고하고, ETH가 부족하면 지갑이 다른 토큰으로 수수료를 낼 수 있다고 안내한다. Ethereum·Base·Arbitrum 세 체인을 지원하고, 어느 표시도 트랜잭션을 막지 않는 정보로 다룬다. 2026-11-17 메인넷 사례(Ethereum 1 USDT 스왑의 approve 가스 0.702 USDT를 지갑이 USDT로 냄, Base에서 approve·swap 가스를 보내는·받는 토큰으로 냄)를 사전에 알리는 것이 목적이다. [사용자 결정]

### 1.1 화면

- 견적 정보(`quote-details`) 아래, 주 버튼 위에 독립된 수수료 행 하나를 둔다. 견적 정보 패널 안에 넣지 않으므로 wrap·unwrap에서도 같은 자리에 나온다 [제안 후 승인]

```text
│ 슬리피지 허용치                             0.5% │   ← 견적 정보 (wrap이면 없음)
├──────────────────────────────────────────────────┤
│ 네트워크 수수료(승인)     0.00042 ETH ($1.23)    │   ← network-fee
│ 수수료가 보내는 금액의 70%예요                   │   ← 경고일 때만
│ 스왑 수수료는 승인 후에 계산돼요                 │   ← approve 단계에서만
│ 수수료를 낼 ETH가 부족해요. …                    │   ← ETH 부족일 때만
├──────────────────────────────────────────────────┤
│ [                 USDC 승인                    ] │
```

- 라벨은 `네트워크 수수료(승인)`·`네트워크 수수료(스왑)`·`네트워크 수수료(전환)`이다. wrap·unwrap은 `전환`이다. 가운뎃점(`·`)을 쓰지 않는다 [사용자 결정]
- 값은 `formatEthFee` 결과와 ` ETH`, 그 뒤 괄호 안의 `formatUsd` 결과다(예: `0.00042 ETH ($1.23)`). ETH 단가가 없으면 괄호와 USD를 생략한다(`0.00042 ETH`) [사용자 결정]
- 경고 줄 문구는 `수수료가 보내는 금액의 N%예요`(N은 버림 정수), 100% 이상이거나 비율을 정할 수 없으면 `수수료가 보내는 금액보다 커요`다. 경고일 때 수수료 값과 경고 줄은 `--warning` 색이다 [제안 후 승인]
- ETH 부족 안내 문구는 `수수료를 낼 ETH가 부족해요. 지갑이 다른 토큰으로 수수료를 내면 그 토큰 잔액이 줄 수 있어요.`이고 `--warning` 색이다 [제안 후 승인]
- 로딩은 값 자리에 F9와 같은 스켈레톤, 추정 불가는 `—`(접근성 이름 `수수료를 추정할 수 없음`)이다 [제안 후 승인]

## 2. 비목표

- 가스 상한(`maxFeePerGas`) 표시와 `eth_feeHistory` 기반 단가 [제안 후 승인]
- OP Stack operator fee 반영 [제안 후 승인]
- 승인 전 스왑 수수료 근사(체인별 상수 가스, QuoterV2 `gasEstimate`)와 이를 위한 F3 코드 변경 [제안 후 승인]
- 수수료 경고·ETH 부족을 이유로 주 버튼을 막는 것. F5·F7의 "ETH 가스 부족 사전 판정 없음"과 F2의 `잔액 부족` 규칙은 그대로다 [제안 후 승인]
- 지갑이 실제로 어떤 토큰으로 수수료를 냈는지 감지, 스왑 뒤 받는 토큰 잔액 감소 안내, `최대` 금액 자동 재조정 [제안 후 승인]
- F6 `tx-balance-notice` 변경 [제안 후 승인]
- 지갑이 실제로 내는 수수료와 앱 추정의 일치 보장 [제안 후 승인]
- 지갑 미연결 상태의 수수료 추정 [제안 후 승인]
- RPC 프록시 허용 목록 변경, viem op-stack `estimateTotalFee`와 fee·gas를 채우는 `prepareTransactionRequest` 사용 [제안 후 승인]
- Base·Arbitrum 포크 자동 테스트와 메인넷 수동 확인 [사용자 결정]

## 3. 완료의 정의

### 3.1 추정 대상과 계산

- DoD-1: 주 버튼이 `approve-required`이면 버튼이 보낼 approve와 같은 `to`·`data`(USDT 초기화 단계는 `approve(0)`)와 `from`=연결 계정으로 `eth_estimateGas`를 보낸다 — 검증: 통합 테스트 (fetch stub, calldata 대조) [제안 후 승인]
- DoD-2: 주 버튼이 `swap-ready`이면 `buildSwapTransactionRequest`로 만든 요청과 같은 `to`·`value`·calldata(deadline 인자 제외)로 `eth_estimateGas`를 보낸다. ERC-20 입력, ETH 입력(`value`), ETH 출력(`unwrapWETH9`)을 모두 포함한다 — 검증: 통합 테스트 (fetch stub, calldata 대조) [제안 후 승인]
- DoD-3: 주 버튼이 `wrap-ready`이면 WETH `deposit` + `value`, `unwrap-ready`이면 WETH `withdraw`와 같은 요청으로 `eth_estimateGas`를 보낸다 — 검증: 통합 테스트 (fetch stub, calldata 대조) [제안 후 승인]
- DoD-4: 주 버튼이 `approve-required`이면 스왑 `eth_estimateGas`를 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- DoD-5: Ethereum·Arbitrum의 `feeWei`는 `eth_estimateGas` 결과 × `eth_gasPrice` 결과다 — 검증: 통합 테스트 (fetch stub) [제안 후 승인]
- DoD-6: Base의 `feeWei`는 `eth_estimateGas` 결과 × `eth_gasPrice` 결과 + GasPriceOracle `getL1Fee` 결과다 — 검증: 통합 테스트 (fetch stub) [제안 후 승인]
- DoD-7: Ethereum·Arbitrum에서는 `getL1Fee` 요청을 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- DoD-8: Ethereum 포크 고정 블록에서 approve, ERC-20 스왑, ETH 입력 스왑, ETH 출력 스왑, wrap, unwrap을 DoD-1~3과 같은 요청으로 추정하면 모두 성공한다 — 검증: 통합 테스트 (실제 anvil 포크, `test:fork`) [제안 후 승인]
- DoD-9: Ethereum 포크 고정 블록에서 allowance가 0인 계정의 ERC-20 스왑 추정은 revert한다 — 검증: 통합 테스트 (실제 anvil 포크, `test:fork`) [제안 후 승인]

### 3.2 표시

- DoD-10: `network-fee` 행은 DOM에서 `quote-details` 자리 뒤, 주 버튼 앞에 있다 — 검증: 코드 대조 [제안 후 승인]
- DoD-11: `wrap-ready`·`unwrap-ready`에서 `quote-details` 없이 `network-fee`가 표시된다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-12: `network-fee[data-kind]`는 `approve-required`에서 `approve`, `swap-ready`에서 `swap`, `wrap-ready`에서 `wrap`, `unwrap-ready`에서 `unwrap`이다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-13: 추정이 성공하면 `network-fee`는 `data-state=success`이고 `data-fee-wei`는 `feeWei`의 10진 문자열이다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-14: ETH 단가가 `success`이면 `network-fee[data-usd-micros]`는 `toUsdMicros(feeWei, useTokenUsdPrice(chainId, NATIVE_ETH_ADDRESS)의 price)`의 10진 문자열이다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-15: 첫 추정 중이면 `network-fee`는 `data-state=loading`이고 값 자리에 `network-fee-skeleton`이 있다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-16: `formatEthFee`는 1 ETH 미만 값을 첫 유효숫자부터 4자리까지 버림하고 소수는 최대 8자리로 표시한다(예: 0.000420987 ETH → `0.0004209`) — 검증: 단위 테스트 [제안 후 승인]
- DoD-17: `formatEthFee`는 0보다 크고 0.00000001 ETH보다 작은 값을 `<0.00000001`로 표시한다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-18: `formatEthFee`는 0을 `0`으로 표시한다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-19: 수수료 USD 표기는 F9 `formatUsd`를 쓴다 — 검증: 코드 대조 [제안 후 승인]
- DoD-50: `formatEthFee`는 소수 끝자리 0을 지운다(예: 0.00042 ETH → `0.00042`) — 검증: 단위 테스트 [제안 후 승인]
- DoD-51: `formatEthFee`는 1 ETH 이상 값을 F2 금액 규칙(소수 4자리 버림, 천 단위 쉼표)으로 표시한다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-20: `approve-required`이면 `network-fee-swap-pending`이 있다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-21: `swap-ready`·`wrap-ready`·`unwrap-ready`이면 `network-fee-swap-pending`이 없다 — 검증: 통합 테스트 [제안 후 승인]

### 3.3 경고

- DoD-22: `getNetworkFeeSeverity`는 수수료 ÷ 보내는 금액이 `NETWORK_FEE_WARNING_BPS`(500) 이상이면 `warning`을 돌려준다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-23: `getNetworkFeeSeverity`는 수수료 ÷ 보내는 금액이 500 bps 미만이면 `normal`을 돌려준다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-24: 보내는 토큰이 ETH·WETH이면 비율은 `feeWei`와 `amountInRaw`의 wei 비교로 정하고 USD 단가를 쓰지 않는다 — 검증: 단위 테스트, 통합 테스트 (단가 없음 stub) [제안 후 승인]
- DoD-25: 보내는 토큰이 ETH·WETH가 아니면 비율은 수수료 USD micros ÷ 보내는 금액 USD micros로 정한다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-26: `ratioPercent`는 비율(%)을 버림한 정수다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-27: `severity=warning`이면 `network-fee[data-severity=warning]`이고 `network-fee-warning`이 있다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-28: `severity=normal`이면 `network-fee[data-severity=normal]`이고 `network-fee-warning`이 없다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-29: 수수료 경고가 있어도 주 버튼의 `data-state`와 활성 여부는 경고가 없을 때와 같다 — 검증: 통합 테스트 [제안 후 승인]

### 3.4 ETH 부족 안내

- DoD-30: `isEthShortage`는 ETH 잔액 < `feeWei` + `valueWei`(ETH 입력·wrap이면 보내는 금액, 그 밖은 0)이면 `true`다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-31: `isEthShortage`는 ETH 잔액 ≥ `feeWei` + `valueWei`이면 `false`다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-32: `ethShortage=true`이면 `network-fee-eth-shortage`가 있다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-33: ETH 부족 안내가 있어도 주 버튼의 `data-state`와 활성 여부는 안내가 없을 때와 같다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-34: 보내는·받는 토큰 중 하나가 ETH이면 ETH 부족 판정을 위해 추가 `eth_getBalance`를 보내지 않는다(카드 잔액 쿼리 키 공유) — 검증: 통합 테스트 (요청 기록) [제안 후 승인]

### 3.5 갱신과 요청 수

- DoD-35: 견적의 15초 갱신으로 최소 수령량만 바뀌면 `eth_estimateGas`를 다시 보내지 않는다 — 검증: 통합 테스트 (fake clock, 요청 기록) [제안 후 승인]
- DoD-36: 추정 키(`chainId, account, kind, tokenIn, tokenOut, fee tier, amountInRaw, approve amount`) 중 하나가 바뀌면 `eth_estimateGas`를 다시 보낸다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- DoD-37: `eth_gasPrice`는 체인별 하나의 쿼리로 `GAS_PRICE_REFETCH_MS`(60초)마다 다시 읽는다 — 검증: 통합 테스트 (fake clock, 요청 기록) [제안 후 승인]
- DoD-38: 창 포커스로는 `eth_estimateGas`·`eth_gasPrice`를 다시 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- DoD-39: 양쪽 토큰이 모두 ETH가 아닐 때 F10을 위한 ETH 잔액은 카드 잔액 쿼리 키로 60초마다 읽는다 — 검증: 통합 테스트 (fake clock, 요청 기록) [제안 후 승인]
- DoD-40: F10이 더하는 평시 RPC 요청(입력 변경 없음, 탭 표시, 연결, `swap-ready`)은 60초당 4건 이하다 — 검증: 통합 테스트 (fake clock, 요청 수 계수) [제안 후 승인]
- DoD-41: ETH 단가 `useTokenUsdPrice(chainId, NATIVE_ETH_ADDRESS)`는 provider 한 곳에서만 호출한다 — 검증: 코드 대조 [제안 후 승인]
- DoD-49: Base `getL1Fee`는 추정 키가 바뀔 때 `eth_estimateGas`와 함께만 보내고, 60초 주기로 다시 보내지 않는다 — 검증: 통합 테스트 (fake clock, 요청 기록) [제안 후 승인]
- DoD-52: 추정 키가 이전에 추정한 키로 돌아오면(예: 금액 1 → 2 → 1) 캐시된 추정을 재사용하지 않고 `eth_estimateGas`를 다시 보낸다. 다시 추정하는 동안 그 키의 마지막 값을 표시하는 것은 허용한다 — 검증: 통합 테스트 (요청 기록) [사용자 결정]
- DoD-53: `network-fee`가 `idle`이면 F10을 위한 ETH 잔액·ETH 단가 요청을 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]

### 3.6 사용자 흐름

- DoD-42: USDC→WETH에서 `network-fee`가 `data-kind=approve`·`data-state=success`이고, 승인 뒤 `data-kind=swap`·`data-state=success`로 바뀌며 두 단계 모두 `data-fee-wei` > 0이다 — 검증: E2E (mock 커넥터 + anvil 포크). 러너 계산값과의 일치 비교 여부는 테스트 설계 단계에서 확정 [제안 후 승인]
- DoD-43: ETH→USDC에서 `network-fee`가 `data-kind=swap`·`data-state=success`이고 `data-fee-wei` > 0이다 — 검증: E2E (mock 커넥터 + anvil 포크) [제안 후 승인]
- DoD-44: ETH→WETH에서 `network-fee`가 `data-kind=wrap`·`data-state=success`이고 `data-fee-wei` > 0이다 — 검증: E2E (mock 커넥터 + anvil 포크) [제안 후 승인]

### 3.7 기존 계약과 문서

- DoD-45: F5·F6·F7의 hook 계약(`useSwapExecution`, `useTokenAllowance`, 견적 상태)은 바뀌지 않는다 — 검증: 코드 대조, 기존 테스트 통과 [제안 후 승인]
- DoD-46: L1 데이터 수수료 여부는 체인 설정 `hasL1DataFee`로 정하고 코드에 체인 ID를 하드코딩하지 않는다 — 검증: 코드 대조 [제안 후 승인]
- DoD-47: `docs/design/README.md`의 "가스 가격 배지를 제거했다" 줄을 수수료 행(§1.1)으로 대체한다고 고친다 — 검증: 코드 대조 [제안 후 승인]
- DoD-48: `README.md` 알려진 한계의 네트워크 수수료 표시 없음 항목을 이 기능에 맞게 고친다 — 검증: 코드 대조 [제안 후 승인]
- DoD-54: 수수료 행(라벨·값)과 F9 인라인 USD(카드 잔액, 모달 잔액, 견적 정보 예상·최소 수령량)는 가운뎃점(`·`) 없이 USD를 괄호로 표기하고, USD 로딩 스켈레톤도 괄호 자리 안에 둔다 — 검증: 코드 대조 [사용자 결정]

## 4. 인터페이스 계약

### 4.1 훅

- 상태 타입과 훅 [제안 후 승인]

```ts
type NetworkFeeKind = "approve" | "swap" | "wrap" | "unwrap";
type NetworkFeeSeverity = "normal" | "warning" | "unknown";

type NetworkFeeState =
  | { status: "idle" } // 미연결, 주 버튼이 approve-required·swap-ready·wrap-ready·unwrap-ready가 아님
  | { status: "loading"; kind: NetworkFeeKind; ethShortage: boolean }
  | { status: "error"; kind: NetworkFeeKind; ethShortage: boolean }
  | {
      status: "success"; // 같은 키로 다시 읽다 실패해도 마지막 값이면 success
      kind: NetworkFeeKind;
      feeWei: bigint; // gas × gasPrice (+ L1 데이터 수수료)
      usdMicros: bigint | null; // ETH 단가 없으면 null
      severity: NetworkFeeSeverity;
      ratioPercent: number | null; // 버림 정수, 비교 불가·보내는 금액 USD 0이면 null
      ethShortage: boolean;
    };

useNetworkFee(): NetworkFeeState;
```

- `NetworkFeeState`는 provider 하나에서 계산하고 화면은 `useNetworkFee()`만 읽는다 [제안 후 승인]

### 4.2 순수 함수 (`lib/`)

- `formatEthFee(wei: bigint): string` — `"0.0004209"` | `"<0.00000001"` | `"0"` | `"1,234.5678"`, 단위 기호 없음 [제안 후 승인]
- `getNetworkFeeSeverity(input: { feeWei: bigint; feeUsdMicros: bigint | null; amountInRaw: bigint; amountInUsdMicros: bigint | null; isEthLikeIn: boolean }): { severity: NetworkFeeSeverity; ratioPercent: number | null }` [제안 후 승인]
- `isEthShortage(input: { ethBalance: bigint | null; feeWei: bigint | null; valueWei: bigint }): boolean` — `ethBalance`가 null이면 `false`, 0이면 `true`, 그 밖에 `feeWei`가 null이면 `false` [제안 후 승인]
- 추정 요청은 기존 `buildApproveRequest`·`buildSwapTransactionRequest`·`buildWrapRequest`·`buildUnwrapRequest`로 조립한다 [제안 후 승인]

### 4.3 config

- `NETWORK_FEE_WARNING_BPS = 500` [제안 후 승인]
- `GAS_PRICE_REFETCH_MS = 60_000` [제안 후 승인]
- 체인 ID별 `hasL1DataFee: boolean`(Base `true`, Ethereum·Arbitrum `false`) [제안 후 승인]

### 4.4 DOM

- `network-fee[data-state=loading|success|error][data-kind=approve|swap|wrap|unwrap][data-severity=normal|warning|unknown]`: 수수료 행. `idle`이면 렌더하지 않는다. `data-fee-wei`는 `success`일 때만, `data-usd-micros`는 `usdMicros`가 있을 때만 있다. `data-severity`는 `success`일 때만 있다 [제안 후 승인]
- `network-fee-warning`: 경고 줄. `severity=warning`일 때만 있다 [제안 후 승인]
- `network-fee-swap-pending`: `kind=approve`일 때만 있다 [제안 후 승인]
- `network-fee-eth-shortage`: `ethShortage=true`일 때만 있다 [제안 후 승인]
- `network-fee-skeleton`: `loading`일 때 값 자리의 스켈레톤. F9 `usd-skeleton`을 쓰지 않는다 [제안 후 승인]

### 4.5 이전 스펙 개정

이 스펙은 다음 항목을 바꾼다. 이전 스펙 파일은 고치지 않는다 [제안 후 승인]

- F9 §2의 "네트워크 수수료 USD 표시" 비목표와 F9 §4.5·F6 §2·F7 §2의 "네트워크 수수료 표시" 비목표는 이 스펙으로 해제된다 [제안 후 승인]
- F5 §2·F7 §2의 "ETH 가스 부족 사전 판정 없음"은 차단 판정에 대한 것으로 유지된다. 이 스펙의 ETH 부족 안내는 차단하지 않는다 [제안 후 승인]
- 잔액이 아닌 JSON-RPC 요청을 모두 세는 동결 테스트 F3 `__tests__/swap/quote-read.test.tsx`의 `[EC-6]`·`[DoD-8]`, F7 `__tests__/swap/native-eth-wrap-quote.test.tsx`의 `[DoD-14]`는 집계에서 F10 요청(`eth_estimateGas`·`eth_gasPrice`·`getL1Fee`, F10이 읽는 ETH 잔액, ETH 단가)을 뺀다. 판정 의도(견적 요청 0건·2건 이하)와 `@then`·it 이름은 유지한다 [사용자 결정]
- 이 밖의 동결 테스트가 F10 요청 때문에 깨지면 고치기 전에 보고하고, 이 절에 추가하는 사용자 승인을 받은 뒤 같은 방식으로 고친다 [사용자 결정]
- F9 §1.1의 "카드 잔액은 `잔액 1.25 · $2,969.88`처럼 잔액 뒤에 `·`와 USD를 붙인다"와 "견적 행의 USD는 카드 잔액과 같이 `·` 뒤에 붙인다"는 USD를 괄호로 붙이는 것으로 바뀐다(`잔액 1.25 ($2,969.88)`, `2,950.12 USDC ($2,950.12)`, 모달 잔액 포함). F9 DOM 계약(§4.4 testid·`data-usd-micros`)은 바뀌지 않는다 [사용자 결정]
- F4 통합 `__tests__/swap/slippage-quote.test.tsx`의 값 조각 비교 보조(`rowValueParts`)는 USD 요소를 뺀 뒤 남는 `·` 대신 괄호 조각을 뺀다. 판정 의도(최소 수령량의 수량·심볼)와 `@then`·it 이름은 유지한다 [제안 후 승인]
- 화면에 보이지 않는 `app/layout.tsx` metadata 설명문과 코드 주석·테스트 이름의 `·`는 바꾸지 않는다 [제안 후 승인]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 추정 실패

- EC-1: `eth_estimateGas`가 revert하면(7702 계정 unwrap, 전송 제한 토큰 등) `network-fee`는 `data-state=error`이고 접근성 이름 `수수료를 추정할 수 없음`인 `—`를 보인다 — 검증: 통합 테스트 (fetch stub) [제안 후 승인]
- EC-2: `eth_gasPrice`가 실패하고 이전 값이 없으면 `network-fee`는 `data-state=error`다 — 검증: 통합 테스트 (fetch stub) [제안 후 승인]
- EC-3: Base에서 `getL1Fee`가 실패하면 `network-fee`는 `data-state=error`이고 L1 수수료를 뺀 값을 보이지 않는다 — 검증: 통합 테스트 (fetch stub) [제안 후 승인]
- EC-4: `network-fee`가 `error`여도 주 버튼의 `data-state`와 활성 여부는 추정 성공 때와 같다 — 검증: 통합 테스트 [제안 후 승인]
- EC-5: 추정·가스 가격 요청이 실패해도 같은 요청을 자동으로 다시 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- EC-6: 같은 키에서 `eth_gasPrice` 60초 갱신이 실패하면 `network-fee`는 마지막 `success` 값을 유지한다 — 검증: 통합 테스트 (fake clock, fetch stub) [제안 후 승인]

### 5.2 미표시

- EC-7: 지갑 미연결이면 `network-fee`가 없고 `eth_estimateGas`·`eth_gasPrice`·`getL1Fee` 요청이 0건이다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- EC-8: 주 버튼이 `approve-required`·`swap-ready`·`wrap-ready`·`unwrap-ready` 밖(잔액 부족, 견적 중, 가격 영향 초과 등)이면 `network-fee`가 없다 — 검증: 통합 테스트 [제안 후 승인]
- EC-9: 서명 대기·approve·swap·wrap·unwrap pending 중에는 `network-fee`가 없다 — 검증: 통합 테스트 [제안 후 승인]

### 5.3 전환과 경합

- EC-10: 선택 체인이 바뀌면 이전 체인의 `feeWei`를 표시하지 않는다 — 검증: 통합 테스트 [제안 후 승인]
- EC-11: 계정이 바뀌면 이전 계정의 `feeWei`와 `ethShortage`를 표시하지 않는다 — 검증: 통합 테스트 [제안 후 승인]
- EC-12: 키가 바뀐 뒤 이전 키의 추정 응답이 늦게 도착해도 표시하지 않는다 — 검증: 통합 테스트 (fetch stub 지연) [제안 후 승인]
- EC-13: approve 성공 뒤 `swap-ready`가 되면 `data-kind=swap`이고 approve 추정값을 스왑 값으로 표시하지 않는다 — 검증: 통합 테스트 [제안 후 승인]
- EC-14: Ethereum USDT `approve(0)`이 성공해 다시 `approve-required`가 되면 `approve(max)`로 새로 추정한다 — 검증: 통합 테스트 (fetch stub, calldata 대조) [제안 후 승인]
- EC-15: 지갑 체인이 선택 체인과 달라도 추정 요청은 선택 체인의 `/api/rpc/[chainId]`로 간다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]

### 5.4 계산 경계

- EC-16: 보내는 금액 USD micros가 0이고 수수료 USD micros가 0보다 크면 `severity=warning`, `ratioPercent=null`이다 — 검증: 단위 테스트 [제안 후 승인]
- EC-17: 수수료 USD micros가 0이면 보내는 금액 USD를 모르더라도 `severity=normal`이다 — 검증: 단위 테스트 [제안 후 승인]
- EC-18: 비율이 정확히 500 bps이면 `severity=warning`이다 — 검증: 단위 테스트 [제안 후 승인]
- EC-19: ETH 단가가 `no-price`·`error`이면 `usdMicros=null`이고 `network-fee`에 `data-usd-micros`가 없으며 ETH 값은 표시된다 — 검증: 통합 테스트 [제안 후 승인]
- EC-20: 보내는 토큰이 ETH·WETH가 아니고, 수수료 USD를 모르거나 수수료 USD가 0보다 크면서 보내는 금액 USD를 모르면 `severity=unknown`이고 `network-fee-warning`이 없다 — 검증: 단위 테스트, 통합 테스트 [제안 후 승인]

### 5.5 ETH 부족 경계

- EC-21: ETH 잔액이 0이면 추정이 `loading`·`error`여도 `ethShortage=true`다 — 검증: 단위 테스트, 통합 테스트 [제안 후 승인]
- EC-22: ETH 잔액을 모르면 `ethShortage=false`다 — 검증: 단위 테스트 [제안 후 승인]
- EC-23: ETH 입력 스왑·wrap에서 보내는 금액 + 수수료 > ETH 잔액이면 `ethShortage=true`다 — 검증: 단위 테스트, 통합 테스트 [제안 후 승인]
- EC-24: approve 성공 뒤 F6 `tx-balance-notice`와 `network-fee-eth-shortage`가 함께 있을 수 있다 — 검증: 통합 테스트 [제안 후 승인]
- EC-25: 수수료를 모르고(추정 `loading`·`error`) ETH 잔액이 0보다 크면 `ethShortage=false`다 — 검증: 단위 테스트 [제안 후 승인]

## 미결정 사항

없음
