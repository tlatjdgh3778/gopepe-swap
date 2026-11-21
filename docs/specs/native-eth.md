# 스펙: native-eth (ETH 입력·출력 스왑과 ETH ↔ WETH 전환)

- 상태: 완료
- 최종 갱신: 2026-11-21

## 1. 목표

ETH가 낀 페어를 실행할 수 있게 한다. 사용자가 ETH를 보내는 스왑(ETH→ERC-20)은 `value`를 붙여 approve 없이 보내고, ETH를 받는 스왑(ERC-20→ETH)은 SwapRouter02 `unwrapWETH9`로 ETH를 받는다. ETH ↔ WETH는 견적 없이 1:1로 보여 주고 WETH 컨트랙트의 `deposit`·`withdraw`를 직접 호출한다. 실행 결과는 F6 상태 메시지 영역에 kind `wrap`·`unwrap`으로 더한다. [사용자 결정]

### 1.1 화면

- ETH ↔ WETH에서는 받는 칸에 `amountInRaw`와 같은 수령량을 스왑 견적과 같은 표시 형식으로 채우고, 견적 정보 영역(환율 행과 예상 수령량·최소 수령량·가격 영향·수수료 티어·슬리피지 허용치 행)을 보이지 않는다 [사용자 결정]
- 새 주 버튼 상태와 문구 [사용자 결정]

| `data-state`   | 문구        | 동작   |
| -------------- | ----------- | ------ |
| `wrap-ready`   | WETH로 전환 | wrap   |
| `unwrap-ready` | ETH로 전환  | unwrap |
| `wrapping`     | 전환 중…    | 비활성 |
| `unwrapping`   | 전환 중…    | 비활성 |

- ETH가 낀 스왑의 주 버튼 문구는 ERC-20 페어와 같다(`스왑`, `스왑 중…`, `{symbol} 승인`) [제안 후 승인]
- 상태 메시지 영역의 wrap·unwrap 문구는 두 kind가 같다. 실패·교체 문구는 F6 §1.1의 status별 문구를 그대로 쓴다 [사용자 결정]

| `data-status` | wrap·unwrap                       | 링크 |
| ------------- | --------------------------------- | ---- |
| `pending`     | 전환 트랜잭션을 처리하는 중이에요 | 있음 |
| `success`     | 전환이 완료됐어요                 | 있음 |

## 2. 비목표

- 네트워크 수수료 표시·경고와 달러 환산(overview 미결정 12·13) [사용자 결정]
- ETH 가스 부족 사전 판정과 가스 추정으로 예약량을 정하는 것. ETH 금액이 잔액 이하이면 `잔액 부족`이 아니라는 F2 규칙을 유지한다 [사용자 결정]
- 배치 실행(EIP-5792), Permit2 (미결정 14) [사용자 결정]
- 멀티홉, exactOutput, `refundETH` [사용자 결정]
- unwrap을 SwapRouter02로 보내는 대체 경로와 EIP-7702 계정 전용 실패 안내. WETH9 `withdraw`는 ETH를 2300 가스 stipend로 보내므로, `receive`가 그 안에 끝나지 않는 위임 코드를 가진 계정은 unwrap이 실패한다. 이 실패는 F6 분류·문구(§5)로 보인다 [사용자 결정]
- ETH 입력 스왑·wrap·unwrap 뒤 잔액 감소 안내. 안내는 F6대로 approve 성공 뒤에만 한다 [사용자 결정]
- 메인넷 수동 확인. 실제 지갑(EIP-7702 스마트 계정 포함)의 unwrap 동작은 미검증으로 남긴다 [사용자 결정]
- Base·Arbitrum 포크 자동 테스트 [사용자 결정]
- 배포, RPC 운영 (F8) [사용자 결정]

## 3. 완료의 정의

### 3.1 ETH가 낀 스왑의 주 버튼

- DoD-1: 보내는 토큰이 ETH이고 받는 토큰이 WETH가 아닌 ERC-20일 때, 견적이 `success`이고 가격 영향이 `error` 등급이 아니며 최소 수령량이 0보다 크면 주 버튼은 allowance 상태와 무관하게 `swap-ready`이고 활성이다 — 검증: 단위 테스트, 통합 테스트 [사용자 결정]
- DoD-2: 한쪽이 ETH인 스왑 페어도 견적 `success`에서 가격 영향이 `error` 등급이면 주 버튼은 `price-impact-too-high`다 — 검증: 단위 테스트 [사용자 결정]
- DoD-3: 한쪽이 ETH인 스왑 페어도 견적 `success`에서 최소 수령량이 0이면 주 버튼은 `amount-too-small`이다 — 검증: 단위 테스트 [사용자 결정]
- DoD-4: 받는 토큰이 ETH이고 보내는 토큰이 WETH가 아닌 ERC-20이면, 견적 `success` 뒤 주 버튼은 ERC-20↔ERC-20 페어와 같은 allowance 판정(F5 DoD-7~11)을 따른다 — 검증: 단위 테스트, 통합 테스트 [사용자 결정]
- DoD-5: 주 버튼 상태는 어떤 입력에서도 `quote-ready`가 되지 않는다 — 검증: 단위 테스트 [사용자 결정]
- DoD-6: 주 버튼 상태는 위에서부터 먼저 해당하는 것으로 정한다: `restoring` → `disconnected` → `awaiting-signature` → `approving` → `swapping` → `wrapping` → `unwrapping` → `select-token` → `enter-amount` → `insufficient-balance` → `quoting` → `no-route` → `quote-error` → `wrap-ready` → `unwrap-ready` → `price-impact-too-high` → `amount-too-small` → `allowance-error` → `checking-allowance` → `approve-required` → `swap-ready` — 검증: 단위 테스트 [제안 후 승인]

### 3.2 ETH가 낀 스왑 트랜잭션

- DoD-7: 보내는 토큰이 ETH인 `swap-ready`에서 주 버튼을 누르면 `swapRouter02`에 `multicall(deadline, [exactInputSingle(params)])` 트랜잭션을 보내고, `params`·`deadline`은 F5 DoD-16·17과 같다(`tokenIn`은 WETH 치환 주소) — 검증: 통합 테스트 (지갑 스텁 요청 디코딩) [사용자 결정]
- DoD-8: 보내는 토큰이 ETH인 스왑 트랜잭션의 `value`는 클릭 시점 `amountInRaw`다 — 검증: 통합 테스트 (지갑 스텁 요청의 `value`) [사용자 결정]
- DoD-9: 받는 토큰이 ETH인 `swap-ready`에서 주 버튼을 누르면 `swapRouter02`에 `multicall(deadline, [exactInputSingle(params), unwrapWETH9(amountMinimum, recipient)])` 트랜잭션을 보낸다. `params.recipient`는 `ADDRESS_THIS`이고 나머지 `params`와 `deadline`은 F5 DoD-16·17과 같으며(`tokenOut`은 WETH 치환 주소), `amountMinimum`은 클릭 시점 `useAmountOutMinimum()`, `recipient`는 연결 계정이다 — 검증: 통합 테스트 (지갑 스텁 요청 디코딩) [사용자 결정]
- DoD-10: 보내는 토큰이 ETH가 아닌 스왑 트랜잭션의 지갑 요청에 `value`가 없거나 0이다 — 검증: 통합 테스트 (지갑 스텁 요청의 `value`) [사용자 결정]
- DoD-11: Ethereum 포크에서 DoD-7·8 인코딩의 ETH→USDC 스왑이 체결되고, USDC 잔액 증가량이 `amountOutMinimum` 이상이다 — 검증: 통합 테스트 (anvil 포크) [사용자 결정]
- DoD-12: Ethereum 포크에서 approve 뒤 DoD-9 인코딩의 USDC→ETH 스왑이 체결되고, 계정이 받은 ETH(잔액 변화에 가스 비용을 더한 값)가 `amountOutMinimum` 이상이다. 준비 단계에서 계정의 위임 코드를 지우고 테스트 뒤 스냅샷으로 되돌린다 — 검증: 통합 테스트 (anvil 포크) [사용자 결정]
- DoD-13: ETH가 낀 스왑의 `pendingTx.kind`와 `result.kind`는 `swap`이다 — 검증: 통합 테스트 [사용자 결정]

### 3.3 ETH ↔ WETH 견적과 주 버튼

- DoD-14: 두 토큰이 ETH와 WETH이고 금액이 0보다 크면 RPC 요청과 입력 반영 대기(300ms) 없이 즉시 `useSwapQuote().status`가 `wrap`이고 `amountOut`이 `amountInRaw`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-15: 견적 상태가 `wrap`이면 받는 칸 `amount-input[data-amount-out-raw]`는 `amountInRaw`의 10진 문자열이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-16: 견적 상태가 `wrap`이면 견적 정보 영역이 없다 — 검증: 통합 테스트 [사용자 결정]
- DoD-17: 견적 상태가 `wrap`이면 `useAmountOutMinimum()`은 `null`이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-18: 보내는 토큰이 ETH, 받는 토큰이 WETH이고 견적 상태가 `wrap`이면 주 버튼은 `wrap-ready`이고 활성이다 — 검증: 단위 테스트, 통합 테스트 [사용자 결정]
- DoD-19: 보내는 토큰이 WETH, 받는 토큰이 ETH이고 견적 상태가 `wrap`이면 주 버튼은 `unwrap-ready`이고 활성이다 — 검증: 단위 테스트, 통합 테스트 [사용자 결정]
- DoD-20: 두 토큰이 ETH와 WETH이면 보내는 토큰이 WETH여도 `useTokenAllowance().status`는 `idle`이고 allowance 읽기 요청을 보내지 않는다 — 검증: 통합 테스트 [제안 후 승인]

### 3.4 wrap·unwrap 트랜잭션

- DoD-21: `wrap-ready`에서 주 버튼을 누르면 선택 체인 WETH 주소에 `deposit()` 트랜잭션을 보내고 `value`는 클릭 시점 `amountInRaw`다 — 검증: 통합 테스트 (지갑 스텁 요청 디코딩) [사용자 결정]
- DoD-22: `unwrap-ready`에서 주 버튼을 누르면 선택 체인 WETH 주소에 `withdraw(클릭 시점 amountInRaw)` 트랜잭션을 보내고 지갑 요청에 `value`가 없거나 0이다 — 검증: 통합 테스트 (지갑 스텁 요청 디코딩) [사용자 결정]
- DoD-23: wrap·unwrap은 트랜잭션 전송 전에 `useEnsureChain()`을 호출하고 트랜잭션을 선택 체인으로 보낸다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-24: Ethereum 포크에서 DoD-21 인코딩의 wrap이 체결되고 WETH 잔액이 금액만큼 늘어난다 — 검증: 통합 테스트 (anvil 포크) [사용자 결정]
- DoD-25: Ethereum 포크에서 DoD-22 인코딩의 unwrap이 체결되고 WETH 잔액이 금액만큼 줄어든다. 준비 단계에서 계정의 위임 코드를 지우고 테스트 뒤 스냅샷으로 되돌린다 — 검증: 통합 테스트 (anvil 포크) [사용자 결정]

### 3.5 wrap·unwrap 진행과 결과

- DoD-26: wrap·unwrap 주 버튼을 누른 즉시부터 지갑 서명(체인 전환 요청 포함)이 끝날 때까지 주 버튼은 `awaiting-signature`이고 비활성이다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-27: wrap 트랜잭션 해시를 받은 뒤 영수증이 나올 때까지 `phase`와 주 버튼은 `wrapping`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-28: unwrap 트랜잭션 해시를 받은 뒤 영수증이 나올 때까지 `phase`와 주 버튼은 `unwrapping`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-29: `wrapping`·`unwrapping` 동안 `pendingTx`는 `{ kind: "wrap" | "unwrap", chainId, hash }`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-30: `wrapping`·`unwrapping` 동안 `tx-status`는 `data-status="pending"`이고 `data-kind`는 `pendingTx.kind`이며 `tx-link`가 있다 — 검증: 통합 테스트 [사용자 결정]
- DoD-31: wrap·unwrap 영수증이 성공이면 `result`는 `{ kind, status: "success", chainId, hash }`이고 `tx-status`는 `data-status="success"`·`data-kind`=`kind`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-32: wrap·unwrap 영수증이 성공이면 보내는 칸 금액이 빈 값이 되고 두 토큰 선택은 유지된다(F5 DoD-19와 같다) — 검증: 통합 테스트 [사용자 결정]
- DoD-33: wrap·unwrap 영수증이 성공이면 트랜잭션 체인·계정의 카드 잔액을 무효화해 다시 읽는다 — 검증: 통합 테스트 (RPC fetch 스텁 요청 확인) [사용자 결정]

### 3.6 사용자 흐름

- DoD-35: Ethereum 포크에서 mock 커넥터로 ETH→USDC를 `swap-ready` 클릭까지 진행하면 `tx-status`가 `success`·`data-kind="swap"`이 되고 USDC 잔액이 늘어난다 — 검증: E2E (anvil 포크 + mock 커넥터) [사용자 결정]
- DoD-36: Ethereum 포크에서 mock 커넥터로 USDC→ETH를 `approve-required` 클릭 → `swap-ready` 클릭까지 진행하면 `tx-status`가 `success`·`data-kind="swap"`이 되고 USDC 잔액이 `amountInRaw`만큼 줄어든다. 준비 단계에서 mock 계정의 위임 코드를 지우고 테스트 뒤 스냅샷으로 되돌린다 — 검증: E2E (anvil 포크 + mock 커넥터) [사용자 결정]
- DoD-37: Ethereum 포크에서 mock 커넥터로 ETH→WETH를 `wrap-ready` 클릭까지 진행하면 `tx-status`가 `success`·`data-kind="wrap"`이 되고 WETH 잔액이 금액만큼 늘어난다 — 검증: E2E (anvil 포크 + mock 커넥터) [사용자 결정]
- DoD-38: Ethereum 포크에서 mock 커넥터로 WETH→ETH를 `unwrap-ready` 클릭까지 진행하면 `tx-status`가 `success`·`data-kind="unwrap"`이 되고 WETH 잔액이 금액만큼 줄어든다. 준비 단계에서 mock 계정의 위임 코드를 지우고 테스트 뒤 스냅샷으로 되돌린다 — 검증: E2E (anvil 포크 + mock 커넥터) [사용자 결정]

## 4. 인터페이스 계약

### 4.1 config와 ABI

- SwapRouter02 로컬 ABI에 `unwrapWETH9(uint256 amountMinimum, address recipient)`를 더한다 [사용자 결정]
- WETH 로컬 ABI는 `deposit()`(payable)과 `withdraw(uint256 wad)`를 담는다. 대상 주소는 기존 `CONTRACTS_BY_CHAIN[chainId].weth`다 [사용자 결정]
- `ADDRESS_THIS` = `0x0000000000000000000000000000000000000002`(SwapRouter02가 자기 자신으로 해석하는 recipient)를 상수로 둔다 [제안 후 승인]
- wrap·unwrap 트랜잭션에는 deadline이 없다 [제안 후 승인]

### 4.2 훅

- `useSwapQuote().status`에 `wrap`을 더한다. `wrap`이면 `quote`는 `null`이고 `amountOut: bigint`(= `amountInRaw`)를 함께 돌려준다. `SwapQuote`와 수수료 티어 타입은 바꾸지 않는다 [사용자 결정]

```ts
type SwapQuoteState =
  | { status: "idle" | "loading" | "no-route" | "error"; quote: null }
  | { status: "success"; quote: SwapQuote }
  | { status: "wrap"; quote: null; amountOut: bigint };
```

- `useSwapExecution()` [사용자 결정]

```ts
useSwapExecution(): {
  phase: "idle" | "awaiting-signature" | "approving" | "swapping" | "wrapping" | "unwrapping";
  pendingTx: { kind: "approve" | "swap" | "wrap" | "unwrap"; chainId: SupportedChainId; hash: Hash } | null;
  result: TxResult | null;
  approve; swap; wrap; unwrap;
  dismissResult: () => void;
};
```

- `approve`·`swap`·`wrap`·`unwrap`은 인자 없는 비동기 함수이고 resolve 값은 `void`다. `wrap`·`unwrap`도 reject하지 않는다 [사용자 결정]
- `TxResult.kind`는 `"approve" | "swap" | "wrap" | "unwrap"`이다. 성공 결과의 `balanceDropped`는 지금처럼 approve에만 있다. 나머지 모양은 F6 §4.1 그대로다 [사용자 결정]
- `useTokenAllowance()`가 `idle`인 조건에 "두 토큰이 ETH와 WETH"를 더한다 [제안 후 승인]

### 4.3 DOM

- `primary-button[data-state]` 값(21개): `restoring` | `disconnected` | `awaiting-signature` | `approving` | `swapping` | `wrapping` | `unwrapping` | `select-token` | `enter-amount` | `insufficient-balance` | `quoting` | `no-route` | `quote-error` | `wrap-ready` | `unwrap-ready` | `price-impact-too-high` | `amount-too-small` | `allowance-error` | `checking-allowance` | `approve-required` | `swap-ready`. 활성은 `disconnected`·`wrap-ready`·`unwrap-ready`·`approve-required`·`swap-ready`다 [사용자 결정]
- `tx-status[data-kind]` 값: `approve` | `swap` | `wrap` | `unwrap` [사용자 결정]
- 받는 칸 `amount-input[data-amount-out-raw]`는 견적 상태가 `success`이면 `quote.amountOut`, `wrap`이면 `amountOut`의 10진 문자열이고, 그 밖에는 속성이 없다 [사용자 결정]
- 새 `data-testid`는 추가하지 않는다 [제안 후 승인]

### 4.4 이전 스펙 개정

이 스펙은 다음 항목을 바꾼다. 이전 스펙 파일은 고치지 않는다 [제안 후 승인]

- F3 EC-6과 §4.1의 "ETH ↔ WETH는 `no-route`"는 DoD-14를 따른다. F3 DoD-25의 "ETH ↔ WETH는 EC-6을 따른다"도 DoD-14를 따른다 [사용자 결정]
- F3 DoD-36과 F3 §4.2의 `quote-ready`는 없어진다(DoD-5) [사용자 결정]
- F3 EC-15의 "가격 영향이 `error` 등급이어도 `quote-ready`"는 DoD-2를 따른다 [사용자 결정]
- F3 §4.3의 "`quote`가 `null`이면 `data-amount-out-raw` 속성이 없다"는 §4.3을 따른다 [사용자 결정]
- F2 DoD-38의 "비활성"은 ETH가 낀 스왑 페어에서 DoD-1~4를 따른다 [사용자 결정]
- F5 DoD-5의 판정 순서는 DoD-6으로, F5 §4.3의 18개 값은 §4.3의 21개 값으로 바뀐다 [사용자 결정]
- F5 DoD-6("ETH가 낀 페어는 `quote-ready`이고 비활성")은 DoD-1~4를 따른다 [사용자 결정]
- F5 DoD-12의 `idle` 조건은 §4.2의 조건을 더한다 [제안 후 승인]
- F5 §4.1의 SwapRouter02 ABI 범위는 §4.1을 따른다 [사용자 결정]
- F5 §4.2와 F6 §4.1의 `phase`·`pendingTx.kind`·`TxResult.kind`는 §4.2로 넓어진다 [사용자 결정]
- F6 §1.1 문구 표에 §1.1의 wrap·unwrap 열을, F6 §4.3 `data-kind` 값에 §4.3의 값을 더한다 [사용자 결정]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 전송 전 실패

- EC-1: wrap·unwrap 서명 단계 오류의 원인 체인에 code 4001이 있으면 `result`는 `{ kind: "wrap" | "unwrap", status: "rejected" }`다 (F6 EC-1) — 검증: 통합 테스트 [사용자 결정]
- EC-2: wrap·unwrap 체인 전환이 4001이 아닌 이유로 실패하면 `result.status`는 `chain-switch-failed`다 (F6 EC-3) — 검증: 통합 테스트 [사용자 결정]
- EC-3: wrap·unwrap의 그 밖의 전송 오류(가스 추정 실패 포함)는 `result.status`가 `send-failed`다 (F6 EC-4) — 검증: 통합 테스트 [사용자 결정]
- EC-4: 보내는 토큰이 ETH이고 금액이 잔액과 같으면(가스를 남기지 않아도) `swap-ready`·`wrap-ready` 판정을 막지 않는다 (F2의 가스 예약 경계 규칙 유지) — 검증: 단위 테스트 [사용자 결정]

### 5.2 전송 뒤 실패와 교체

- EC-5: wrap·unwrap 영수증이 reverted이면 `result.status`는 `reverted`이고 `tx-link`가 있다 (F6 EC-7) — 검증: 통합 테스트 [사용자 결정]
- EC-6: wrap·unwrap 트랜잭션이 취소되거나 대체되면 `result.status`는 `replaced`이고 보내는 칸 금액을 비우지 않는다 (F6 EC-9·11) — 검증: 통합 테스트 [사용자 결정]

### 5.3 실행 함수 호출

- EC-7: `wrap`을 `wrap-ready`가 아닐 때, `unwrap`을 `unwrap-ready`가 아닐 때, 또는 진행 중에 호출하면 지갑 요청 없이 resolve하고 `result`를 바꾸지 않는다 (F5·F6의 실행 함수 호출 규칙과 같다) — 검증: 통합 테스트 [사용자 결정]

### 5.4 입력 변경과 동시성

- EC-8: wrap·unwrap 서명 대기 중 금액을 바꿔도 트랜잭션은 클릭 시점 `amountInRaw`로 보낸다 — 검증: 통합 테스트 [제안 후 승인]
- EC-9: 토큰을 바꿔 ETH ↔ WETH에서 다른 페어로 가면 견적 상태가 즉시 `wrap`이 아니게 되고, 다른 페어에서 ETH ↔ WETH로 오면 즉시 `wrap`이 된다 — 검증: 통합 테스트 [제안 후 승인]
- EC-10: 견적 상태가 `wrap`일 때 슬리피지를 바꿔도 견적 상태·`amountOut`·주 버튼이 바뀌지 않는다 — 검증: 통합 테스트 [제안 후 승인]
- EC-11: `wrapping`·`unwrapping` 중 선택 체인이 바뀐 뒤 영수증이 성공하면 보내는 칸 금액을 비우지 않는다 — 검증: 통합 테스트 [제안 후 승인]

## 미결정 사항

없음
