# 스펙: batch-calls (배치 실행, EIP-5792)

- 상태: 완료
- 최종 갱신: 2026-11-26

## 1. 목표

EIP-5792 원자 배치를 지원하는 지갑(연결 계정·선택 체인의 `atomic` capability가 `supported` 또는 `ready`)에서는 ERC-20 입력 스왑의 approve와 swap을 `wallet_sendCalls` 한 번, 지갑 확인 한 번으로 보낸다. 지원하지 않는 지갑은 지금의 approve → swap 두 단계로 동작한다. overview 미결정 14는 "배치를 먼저 하고, Permit2를 할지는 Permit2 차례의 인터뷰에서 정한다"로 닫는다. [사용자 결정]

### 1.1 화면

- 배치를 쓸 수 있는 승인 필요 상태의 주 버튼 문구는 `${symbol} 승인 후 스왑`이다(symbol은 보내는 토큰 심볼) [사용자 결정]
- 배치 처리 중 주 버튼 문구는 `스왑 중…`이다 [사용자 결정]
- 상태 메시지 문구 [사용자 결정]

| `data-status`                                  | batch                           | 링크                |
| ---------------------------------------------- | ------------------------------- | ------------------- |
| `pending`                                      | 승인과 스왑을 처리하는 중이에요 | 없음                |
| `success`                                      | 스왑이 완료됐어요               | receipt가 있을 때만 |
| `reverted`·`receipt-failed`                    | F6 §1.1 실패 문구와 같음        | receipt가 있을 때만 |
| `rejected`·`chain-switch-failed`·`send-failed` | F6 §1.1 실패 문구와 같음        | 없음                |

- 배치를 쓸 수 있는 승인 필요 상태의 수수료 행은 `네트워크 수수료(승인)` 값 아래에 안내 줄 `스왑 수수료는 지갑에서 확인해 주세요`를 둔다. F10의 `스왑 수수료는 승인 후에 계산돼요` 줄은 이 상태에서 없다 [사용자 결정]

## 2. 비목표

- Permit2와 Universal Router 경로 [사용자 결정]
- `atomic`이 `unsupported`이거나 없는 지갑의 비원자 배치 [사용자 결정]
- 배치 전체(approve + swap) 수수료 추정, state override 합산 [사용자 결정]
- 배치 안 approve 금액을 보내는 금액으로 제한하기. 배치도 `maxUint256`을 승인한다 [사용자 결정]
- `swap-ready`·`wrap-ready`·`unwrap-ready`·ETH 입력 스왑의 배치화. 이 상태들은 지금처럼 단일 트랜잭션을 보낸다 [제안 후 승인]
- 배치의 취소·대체(`replaced`) 감지 [제안 후 승인]
- 배치 미지원으로 강등된 상태의 새로고침 후 유지 [제안 후 승인]

## 3. 완료의 정의

### 3.1 배치 판정

- DoD-1: 연결 계정·선택 체인의 capabilities가 `atomic.status = "supported"`이고 F5 규칙상 주 버튼이 `approve-required`인 경우 주 버튼은 `batch-ready`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- DoD-2: capabilities가 `atomic.status = "ready"`이고 F5 규칙상 `approve-required`인 경우 주 버튼은 `batch-ready`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- DoD-3: capabilities가 `atomic.status = "unsupported"`이거나 선택 체인 항목·`atomic` 항목이 없으면 주 버튼은 `approve-required`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- DoD-4: capabilities를 읽는 중이면 주 버튼은 `approve-required`이고 활성이다 — 검증: 통합 테스트 (stub 지갑, 응답 보류) [사용자 결정]
- DoD-5: `batch-ready` 주 버튼은 활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-6: `batch-ready` 주 버튼 문구는 §1.1과 같다 — 검증: 코드 대조 [사용자 결정]

### 3.2 전송

- DoD-7: `batch-ready`에서 주 버튼을 누르면 `wallet_sendCalls`를 한 번 보내고, `calls`는 [보내는 토큰 `approve(SwapRouter02, maxUint256)`, SwapRouter02 `multicall(deadline, …)`] 순서다. swap 호출의 `to`·`value`·calldata(deadline 인자 제외)는 F5·F7 `buildSwapTransactionRequest`와 같다 — 검증: 통합 테스트 (stub 지갑, calldata 디코드) [사용자 결정]
- DoD-8: 보내는 토큰이 0 초기화 대상이고 0 < allowance < 보내는 금액이면 `calls`는 [`approve(SwapRouter02, 0)`, `approve(SwapRouter02, maxUint256)`, `multicall(deadline, …)`] 순서다 — 검증: 통합 테스트 (stub 지갑, calldata 디코드) [사용자 결정]
- DoD-9: `wallet_sendCalls` 요청은 원자 실행을 요구한다(`atomicRequired: true`) — 검증: 통합 테스트 (요청 기록) [사용자 결정]
- DoD-10: `batch-ready` 클릭으로는 `eth_sendTransaction`을 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- DoD-11: `wallet_sendCalls` 전에 `useEnsureChain()`을 호출하고 배치는 선택 체인으로 보낸다 — 검증: 통합 테스트 [제안 후 승인]

### 3.3 진행과 결과

- DoD-12: `wallet_sendCalls`가 배치 id를 돌려주기 전에는 phase가 `awaiting-signature`다 — 검증: 통합 테스트 (stub 지갑, 응답 보류) [제안 후 승인]
- DoD-13: 배치 id를 받은 뒤 최종 상태 전까지 phase와 주 버튼 상태는 `batching`이고 주 버튼은 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-14: `batching` 동안 `tx-status`는 `data-status=pending`·`data-kind=batch`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-15: `batching` 동안 `tx-link`가 없다 — 검증: 통합 테스트 [사용자 결정]
- DoD-16: 최종 상태 코드가 2xx이고 receipt가 모두 `success`이면 `result`는 `success`·`batch`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-17: 배치 결과의 `tx-link` href는 마지막 receipt `transactionHash`의 탐색기 URL이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-18: 배치 성공 뒤 선택 체인·계정이 클릭 시점과 같으면 보내는 금액을 비운다 — 검증: 통합 테스트 [사용자 결정]
- DoD-19: 배치 성공 뒤 allowance를 다시 읽어, 같은 페어·금액을 다시 입력하면 주 버튼이 `swap-ready`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-20: 배치 결과에는 `tx-balance-notice`가 없다 — 검증: 통합 테스트 [제안 후 승인]

### 3.4 수수료 행

- DoD-21: `batch-ready`에서 `network-fee`는 `data-kind=approve`이고 F10 DoD-1과 같은 approve 요청으로 추정한다 — 검증: 통합 테스트 (fetch stub, calldata 대조) [사용자 결정]
- DoD-22: `batch-ready`에서 `network-fee-batch-note`가 있다 — 검증: 통합 테스트 [사용자 결정]
- DoD-23: `batch-ready`에서 `network-fee-swap-pending`이 없다 — 검증: 통합 테스트 [사용자 결정]
- DoD-24: `batch-ready`의 경고(`data-severity`)와 ETH 부족 안내는 F10 규칙을 approve 수수료에 적용한 결과와 같다 — 검증: 통합 테스트 (fetch stub) [사용자 결정]
- DoD-25: `batch-ready`에서 스왑 `eth_estimateGas`를 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [사용자 결정]

### 3.5 두 단계 흐름 유지

- DoD-26: 배치를 쓰지 않는 지갑에서 기존 Vitest·`test:fork`·`test:e2e` 테스트가 §4.5에 적은 개정 밖에서는 수정 없이 통과한다 — 검증: 명령 실행 확인 (`bun run test`, `bun run test:fork`, `bun run test:e2e`) [제안 후 승인]

### 3.6 실제 실행

- DoD-27: E2E에서 배치 지원을 켠 mock 지갑으로 ERC-20 입력 스왑의 `batch-ready` 주 버튼을 한 번 누르면 `tx-status`가 `success`·`batch`가 된다 — 검증: E2E (mock 커넥터 + anvil 포크, 구현 방식은 테스트 설계 단계에서 확정) [사용자 결정]
- DoD-28: DoD-27 뒤 anvil에서 읽은 보내는 토큰 잔액은 줄고 받는 토큰 잔액은 늘었다 — 검증: E2E [사용자 결정]
- DoD-29: DoD-27에서 앱이 보낸 지갑 전송 요청은 `wallet_sendCalls` 1건이고 `eth_sendTransaction`·`wallet_sendTransaction`은 0건이다 — 검증: E2E (지갑 요청 기록) [제안 후 승인]
- DoD-30: Ethereum 포크 고정 블록에서 앱이 만든 `calls`를 7702 배치 실행 컨트랙트로 실행하면 트랜잭션 하나로 체결되고 받는 토큰 잔액이 는다 — 검증: 통합 테스트 (실제 anvil 포크, `test:fork`). 쓸 수 있는 실행 컨트랙트가 없으면 계획에 사유를 기록하고 제외한다 [사용자 결정]
- DoD-31: 같은 포크에서 swap이 revert하는 `calls`(최소 수령량을 견적보다 크게 둔 경우)를 실행하면 approve도 되돌려져 allowance가 실행 전과 같다 — 검증: 통합 테스트 (실제 anvil 포크, `test:fork`). 제외 조건은 DoD-30과 같다 [사용자 결정]
- DoD-32: 실제 MetaMask로 메인넷 소액 ERC-20 스왑을 지갑 확인 한 번으로 체결한다 — 검증: 수동 1회 (사용자) [사용자 결정]

## 4. 인터페이스 계약

### 4.1 상태와 phase

- `PrimaryButtonState`에 `batch-ready`와 `batching`을 더한다. `batching`은 진행 상태 묶음(`approving`·`swapping` 등)에, `batch-ready`는 `approve-required` 자리에 둔다 [사용자 결정]
- `SwapExecutionPhase`에 `batching`을 더한다 [사용자 결정]
- `TxKind`에 `batch`를 더한다 [사용자 결정]
- `TxResult`는 단일 트랜잭션 결과(kind `approve`·`swap`·`wrap`·`unwrap`, 기존 타입 그대로)와 batch 결과로 나눈다. batch 결과의 `success`·`reverted`·`receipt-failed`는 `chainId`와 선택 필드 `hash`를 가지며, `hash`는 마지막 receipt의 `transactionHash`이고 receipt가 없으면 없다. batch 결과에는 `balanceDropped`와 `replaced`가 없다 [사용자 결정]

### 4.2 실행 계약

```ts
type PendingTx =
  | { kind: "approve" | "swap" | "wrap" | "unwrap"; chainId: number; hash: Hash }
  | { kind: "batch"; chainId: number; batchId: string; hash?: undefined };
```

- `useSwapExecution()`은 기존 필드에 `batch()`를 더한다. `approve()`·`swap()`과 같은 반환 형태(void로 resolve, reject하지 않음)이고 결과는 `result`로 노출한다 [사용자 결정]
- `batch()`는 주 버튼이 `batch-ready`일 때만 동작한다 [사용자 결정]

### 4.3 DOM

- `primary-button[data-state=batch-ready|batching]` [사용자 결정]
- `tx-status[data-kind=batch]` [사용자 결정]
- `network-fee-batch-note`: 주 버튼이 `batch-ready`일 때만 있다 [사용자 결정]

### 4.4 E2E 빌드

- `NEXT_PUBLIC_E2E_MOCK=1` 빌드의 mock 지갑은 테스트가 켤 때만 체인 1의 `atomic.status = "supported"`를 보고한다. 기본값은 꺼짐이다 [사용자 결정]

### 4.5 이전 스펙 개정

이 스펙은 다음 항목을 바꾼다. 이전 스펙 파일은 고치지 않는다 [제안 후 승인]

- F6 §2·F7 §2의 "배치 실행(EIP-5792)" 비목표는 이 스펙으로 해제된다. "Permit2"는 비목표로 남는다 [사용자 결정]
- F5 DoD-14("approve 뒤 스왑은 다시 누르기 전까지 보내지 않는다")와 EC-6("연달아 눌러도 전송 요청은 한 번")은 두 단계 흐름에 그대로 적용된다. `batch-ready` 클릭은 approve와 swap을 `wallet_sendCalls` 한 번으로 보낸다 [제안 후 승인]
- F10 DoD-12의 kind 매핑에 `batch-ready → approve`를 더한다 [사용자 결정]
- F10 §4.4 `network-fee-swap-pending`의 "`kind=approve`일 때만 있다"는 "주 버튼이 `approve-required`일 때만 있다"로 바뀐다 [사용자 결정]
- `PendingTx`의 batch 분기에 `hash?: undefined`를 두어 동결 테스트의 `pendingTx.hash` 접근이 그대로 컴파일된다 [사용자 결정]
- 이 기능 때문에 동결 테스트가 깨지면 고치기 전에 보고하고, 이 절에 추가하는 사용자 승인을 받은 뒤 고친다 [제안 후 승인]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 capabilities 조회

- EC-1: `wallet_getCapabilities`가 실패하면(4200·-32601·그 밖의 오류) 주 버튼은 `approve-required`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-2: 조회가 실패해도 같은 계정·체인이 유지되는 동안 `wallet_getCapabilities`를 다시 보내지 않는다. 다른 계정·체인을 거쳐 돌아오거나 지갑을 다시 연결하는 것은 EC-3의 바뀜으로 본다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- EC-3: 연결 계정이나 선택 체인이 바뀌면 바뀐 계정·체인으로 `wallet_getCapabilities`를 보낸다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- EC-4: `batch-ready` 클릭은 `wallet_getCapabilities`를 보내지 않는다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]

### 5.2 전송 실패

- EC-5: `wallet_sendCalls`가 4001로 거부되면 `result`는 `rejected`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-6: 4001 거부 뒤 주 버튼은 `batch-ready`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-7: `wallet_sendCalls`가 -32601·4200·5700·5740·5750으로 실패하면 `result`는 `send-failed`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- EC-8: EC-7 뒤 같은 계정·체인에서 주 버튼은 새로고침 전까지 `approve-required`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- EC-9: EC-7 뒤 approve를 자동으로 보내지 않는다(`eth_sendTransaction` 0건) — 검증: 통합 테스트 (요청 기록) [사용자 결정]
- EC-10: `wallet_sendCalls`가 EC-5·EC-7 밖의 오류로 실패하면 `result`는 `send-failed`이고 주 버튼은 `batch-ready`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-11: 전송 전 체인 전환이 실패하면 F6 규칙대로 `rejected` 또는 `chain-switch-failed`이고 `wallet_sendCalls`를 보내지 않는다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]

### 5.3 상태 대기와 결과

- EC-12: 최종 상태 코드가 2xx여도 receipt 중 하나라도 `reverted`이면 `result`는 `reverted`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-13: 최종 상태 코드가 5xx이면 `result`는 `reverted`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-14: 최종 상태 코드가 6xx이면 `result`는 `reverted`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-15: 최종 상태 코드가 4xx이면 `result`는 `send-failed`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-16: `wallet_getCallsStatus`가 재시도(viem 기본) 뒤에도 throw하면 `result`는 `receipt-failed`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-17: receipt 없이 끝난 배치 결과에는 `tx-link`가 없다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]
- EC-22: 최종 상태 코드가 2xx이고 receipt가 0개이면 `result`는 `success`·`batch`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- EC-23: 최종 상태 코드가 3xx이거나 700 이상이면 `result`는 `receipt-failed`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- EC-24: 상태 코드가 100 미만이거나 숫자가 아니면 `result`는 `receipt-failed`다 — 검증: 통합 테스트 (stub 지갑) [사용자 결정]
- EC-18: 상태 코드가 1xx로 남아 있는 동안에는 시간 제한 없이 `batching`을 유지한다 — 검증: 통합 테스트 (fake clock) [제안 후 승인]

### 5.4 동시성과 후처리

- EC-19: `batch-ready`를 연달아 눌러도 `wallet_sendCalls`는 한 번이다 — 검증: 통합 테스트 (요청 기록) [제안 후 승인]
- EC-20: `batching` 중 연결 계정이 바뀌면 그 배치의 결과를 `result`에 반영하지 않는다 — 검증: 통합 테스트 [제안 후 승인]
- EC-21: 배치가 `reverted`이면 다시 읽은 allowance로 주 버튼은 `batch-ready`다 — 검증: 통합 테스트 (stub 지갑) [제안 후 승인]

## 미결정 사항

없음. E2E 구현 방식(DoD-27)과 포크 실행 컨트랙트(DoD-30·31)는 계획의 조사 Task에서 정한다.
