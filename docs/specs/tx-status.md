# 스펙: tx-status (트랜잭션 상태 메시지·tx 링크)

- 상태: 완료
- 최종 갱신: 2026-11-19

## 1. 목표

approve·swap을 실행한 사용자가 진행 상태와 결과(성공·사용자 거부·네트워크 전환 실패·전송 실패·revert·확인 실패·취소·대체)를 주 버튼 아래 상태 메시지 영역에서 구분해 보고, 블록 탐색기 링크로 트랜잭션을 확인할 수 있게 한다. approve가 성공한 뒤 보내는 토큰 잔액이 줄었으면, 수수료가 그 토큰으로 지불됐을 수 있다고 안내한다. 결과는 F5 실행 계약 `useSwapExecution()`에 더한 `result`(§4.1)로 노출한다. [사용자 결정]

### 1.1 화면

- 주 버튼 바로 아래에 상태 메시지 영역을 둔다 [사용자 결정]
- 메시지는 status·kind별로 고정된 문구이고 금액·토큰 심볼을 넣지 않는다 [사용자 결정]
- 문구 [제안 후 승인]

| `data-status`         | approve                                                                   | swap                              | 링크 |
| --------------------- | ------------------------------------------------------------------------- | --------------------------------- | ---- |
| `pending`             | 승인 트랜잭션을 처리하는 중이에요                                         | 스왑 트랜잭션을 처리하는 중이에요 | 있음 |
| `success`             | 승인이 완료됐어요                                                         | 스왑이 완료됐어요                 | 있음 |
| `rejected`            | 지갑에서 요청을 거절했어요                                                | 같음                              | 없음 |
| `chain-switch-failed` | 네트워크를 전환하지 못했어요. 지갑에서 직접 전환한 뒤 다시 시도해 주세요. | 같음                              | 없음 |
| `send-failed`         | 트랜잭션을 보내지 못했어요. 잔액과 네트워크 수수료를 확인해 주세요.       | 같음                              | 없음 |
| `reverted`            | 트랜잭션이 실패했어요                                                     | 같음                              | 있음 |
| `receipt-failed`      | 결과를 확인하지 못했어요. 탐색기에서 확인해 주세요.                       | 같음                              | 있음 |
| `replaced`            | 트랜잭션이 취소되거나 다른 트랜잭션으로 대체됐어요                        | 같음                              | 있음 |

- 링크 문구는 `탐색기에서 보기`다 [제안 후 승인]
- 잔액 감소 안내 문구: `네트워크 수수료가 보내는 토큰으로 지불돼 잔액이 줄었을 수 있어요. 금액을 확인해 주세요.` [제안 후 승인]
- 결과 메시지에는 닫기(✕) 버튼이 있고, pending 메시지에는 없다 [사용자 결정]

## 2. 비목표

- 네트워크 수수료 표시·경고와 달러 환산(overview 미결정 12·13의 나머지). F6는 approve 뒤 잔액 감소 안내만 맡는다 [사용자 결정]
- 메시지에 금액·토큰 심볼·실제 수령량(영수증 Transfer 로그) 표시 [사용자 결정]
- revert 사유(reason) 표시 [제안 후 승인]
- 시간 경과에 따른 메시지 자동 소멸, 토스트, 여러 트랜잭션 기록 목록 [사용자 결정]
- 새로고침 후 결과·pending 상태 복원 [제안 후 승인]
- ETH가 낀 페어의 실행 결과 (F7) [제안 후 승인]
- 배치 실행(EIP-5792), Permit2 (개선 단계) [제안 후 승인]
- 배포, RPC 운영 (F8) [제안 후 승인]
- E2E로 revert·확인 실패·취소·대체를 검증하는 것, 이를 위한 새 E2E 제어값과 anvil 채굴 제어 [사용자 결정]
- 메인넷 수동 확인. 실제 지갑의 오류 형태는 미검증으로 남긴다 [사용자 결정]
- 시안의 주 버튼 아래 안내 줄(ShieldCheck 아이콘과 `토큰은 언제나 내 지갑에…`) [제안 후 승인]

## 3. 완료의 정의

### 3.1 메시지 영역과 pending

- DoD-1: `tx-status` 요소는 주 버튼 다음에 항상 마운트되어 있고 role이 `status`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-2: 표시할 pending이나 결과가 없으면 `tx-status[data-status]`는 `none`이고 `tx-link`·`tx-status-dismiss`·`tx-balance-notice`가 없다 — 검증: 통합 테스트 [사용자 결정]
- DoD-3: `approving`·`swapping` 동안 `tx-status[data-status]`는 `pending`이고 `data-kind`는 `pendingTx.kind`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-4: `approving`·`swapping` 동안 `tx-link`의 `href`는 `pendingTx.chainId` 체인 탐색기의 `/tx/{pendingTx.hash}`다 — 검증: 통합 테스트 [사용자 결정]
- DoD-5: `approving`·`swapping` 동안 `tx-status-dismiss`가 없다 — 검증: 통합 테스트 [사용자 결정]
- DoD-6: 탐색기 tx URL은 Ethereum `https://etherscan.io/tx/{hash}`, Base `https://basescan.org/tx/{hash}`, Arbitrum `https://arbiscan.io/tx/{hash}`다 — 검증: 단위 테스트 [사용자 결정]

### 3.2 성공

- DoD-7: approve 영수증이 성공이면 `result`는 `{ kind: "approve", status: "success", chainId, hash, balanceDropped }`이고 `tx-status`는 `data-status="success"`·`data-kind="approve"`다 — 검증: 통합 테스트, E2E (anvil 포크 + mock 커넥터) [사용자 결정]
- DoD-8: swap 영수증이 성공이면 `result`는 `{ kind: "swap", status: "success", chainId, hash }`이고 `tx-status`는 `data-status="success"`·`data-kind="swap"`이다 — 검증: 통합 테스트, E2E (anvil 포크 + mock 커넥터) [사용자 결정]
- DoD-9: 성공 결과의 `tx-link` `href`는 tx 체인 탐색기의 `/tx/{체결된 트랜잭션 해시}`다 — 검증: 통합 테스트, E2E (체결 해시를 얻는 방법은 테스트 설계 단계에서 확정) [사용자 결정]
- DoD-10: approve 영수증이 성공이면 allowance와 보내는 토큰 잔액을 모두 다시 읽을 때까지 `phase`가 `approving`을 유지하고, 그 뒤 `result`를 한 번에 기록한다 (F5 DoD-30 확장) — 검증: 통합 테스트 [사용자 결정]
- DoD-11: approve 성공 뒤 다시 읽은 보내는 토큰 잔액(tx 체인·계정)이 클릭 시점 잔액보다 작으면 `balanceDropped`가 `true`이고 `tx-balance-notice`가 보인다 — 검증: 통합 테스트 [사용자 결정]
- DoD-12: approve 성공 뒤 다시 읽은 잔액이 클릭 시점 잔액 이상이면 `balanceDropped`가 `false`이고 `tx-balance-notice`가 없다 — 검증: 통합 테스트 [사용자 결정]

### 3.3 메시지 수명

- DoD-13: 결과 메시지의 `tx-status-dismiss`를 누르면 `result`가 `null`이 되고 `tx-status[data-status]`가 `none`이 된다 — 검증: 통합 테스트 [사용자 결정]
- DoD-14: 결과 메시지가 보이는 동안 사용자의 금액 입력·토큰 선택·뒤집기·`최대`·선택 체인 변경으로 금액·토큰·선택 체인 값이 실제로 바뀌면 `result`가 `null`이 된다 — 검증: 통합 테스트 [사용자 결정]
- DoD-15: 결과 메시지가 보이는 동안 실행을 시작하는(`awaiting-signature`로 넘어가는) approve 또는 swap 호출이 있으면 이전 `result`가 `null`이 된다 — 검증: 통합 테스트 [사용자 결정]

## 4. 인터페이스 계약

### 4.1 훅

- `useSwapExecution()`에 `result: TxResult | null`과 `dismissResult: () => void`를 더한다. `phase`·`pendingTx`·`approve`·`swap`의 모양과 의미는 F5 그대로다. `approve`·`swap`은 reject하지 않고 `void`로 resolve한다 [사용자 결정]

```ts
type TxResult = { kind: "approve" | "swap" } & (
  | { status: "success"; chainId: SupportedChainId; hash: Hash; balanceDropped: boolean } // kind "approve"
  | { status: "success"; chainId: SupportedChainId; hash: Hash } // kind "swap"
  | { status: "reverted" | "receipt-failed" | "replaced"; chainId: SupportedChainId; hash: Hash }
  | { status: "rejected" | "chain-switch-failed" | "send-failed" }
);
```

- `balanceDropped`는 approve 성공 결과에만 있다 [사용자 결정]
- `chainId`는 트랜잭션을 보낸 체인이다. `replaced`의 `hash`는 대체 트랜잭션의 해시다 [사용자 결정]

### 4.2 탐색기 링크

- 새 config를 두지 않고 `CHAINS_BY_ID[chainId].blockExplorers.default.url`에 `/tx/{hash}`를 붙인다 [사용자 결정]
- `tx-link`는 `target="_blank"`, `rel="noopener noreferrer"`다 [제안 후 승인]
- `tx-link`의 체인·해시는 pending이면 `pendingTx.chainId`·`pendingTx.hash`, 결과면 `result.chainId`·`result.hash`다 [사용자 결정]

### 4.3 DOM

- `tx-status`: `data-status` = `none` | `pending` | `success` | `rejected` | `chain-switch-failed` | `send-failed` | `reverted` | `receipt-failed` | `replaced`. `data-kind` = `approve` | `swap`이고 `none`일 때는 없다. role은 `status`다 [제안 후 승인]
- `tx-link`: 탐색기 링크 [제안 후 승인]
- `tx-status-dismiss`: 결과 메시지의 닫기 버튼 [제안 후 승인]
- `tx-balance-notice`: 잔액 감소 안내 [제안 후 승인]
- role `alert`는 쓰지 않는다. F2 EC-12(`alert` 0개)를 유지한다 [제안 후 승인]

### 4.4 F5 개정

이 스펙은 F5(`docs/specs/approve-swap.md`)의 다음 항목을 바꾼다. F5 스펙 파일은 고치지 않는다 [사용자 결정]

- F5 EC-2의 "메시지를 표시하지 않는다"는 EC-1을 따른다 [사용자 결정]
- F5 EC-5의 "트랜잭션 교체·취소"는 영수증 대기 reject가 아니다. 교체·취소는 §5.2를 따른다 [사용자 결정]
- F5 DoD-30의 approve 성공 후 대기는 DoD-10을 따른다 [사용자 결정]
- F5 §4.2의 "결과는 `phase`로만 드러난다"는 §4.1의 `result`로 바뀐다 [사용자 결정]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 전송 전 실패

- EC-1: 서명 단계 오류의 원인 체인에 code 4001이 있으면 `result.status`는 `rejected`다 — 검증: 통합 테스트, E2E (기존 `sendTransactionError` 제어값) [사용자 결정]
- EC-2: 체인 전환을 거부하면(4001) `result.status`는 `rejected`다 — 검증: 통합 테스트 [사용자 결정]
- EC-3: 체인 전환이 4001이 아닌 이유로 실패하면 `result.status`는 `chain-switch-failed`다 — 검증: 통합 테스트 [사용자 결정]
- EC-4: 그 밖의 전송 오류(-32000, -32603 포함, 메시지 문구와 무관)는 `result.status`가 `send-failed`다 — 검증: 통합 테스트, E2E (기존 `sendTransactionError` 제어값에 -32000 오류 주입) [사용자 결정]
- EC-5: `rejected`·`chain-switch-failed`·`send-failed` 결과에는 `tx-link`가 없다 — 검증: 통합 테스트 [사용자 결정]
- EC-6: `awaiting-signature` 중 선택 체인이 바뀌어 전송하지 않으면(F5 EC-21) `result`는 `null`이다 — 검증: 통합 테스트 [사용자 결정]

### 5.2 전송 뒤 실패와 교체

- EC-7: 영수증이 reverted이면 `result.status`는 `reverted`이고 `tx-link`가 있다 — 검증: 통합 테스트 [사용자 결정]
- EC-8: 영수증 대기가 reject되면 `result.status`는 `receipt-failed`이고 `tx-link`가 있다 — 검증: 통합 테스트 [사용자 결정]
- EC-9: 트랜잭션이 취소(cancelled)되거나 다른 트랜잭션으로 대체(replaced)되면 `result.status`는 `replaced`이고 `hash`는 대체 트랜잭션 해시다 — 검증: 통합 테스트 (교체 트랜잭션 주입 스텁의 형태는 테스트 설계 단계에서 확정) [사용자 결정]
- EC-10: 대체 트랜잭션의 영수증이 reverted여도 `result.status`는 `replaced`다 — 검증: 통합 테스트 [사용자 결정]
- EC-11: swap이 `replaced`로 끝나면 보내는 칸 금액을 비우지 않고, `phase`가 `idle`로 돌아가 잔액과 allowance를 다시 읽는다 — 검증: 통합 테스트 [사용자 결정]
- EC-12: 가속(repriced)되면 새 트랜잭션 영수증의 결과(`success` 또는 `reverted`)를 새 해시로 기록한다 — 검증: 통합 테스트 [사용자 결정]
- EC-13: 가속되기 전 pending 동안 `tx-link`는 원래 해시를 가리킨다 — 검증: 통합 테스트 [사용자 결정]
- EC-14: 영수증이 오래 나오지 않아도 `pending`과 `tx-link`를 유지한다 (F5 EC-18) — 검증: 통합 테스트 (가짜 타이머) [사용자 결정]
- EC-29: 원 트랜잭션을 한 번도 pending으로 조회하지 못한 채 교체되어 노드에서 사라지면 교체를 감지하지 않고 EC-14처럼 `pending`과 원 해시 `tx-link`를 유지한다. 전송 전 nonce 조회와 RPC 프록시 허용 메서드 변경은 하지 않는다 — 검증: 통합 테스트 [사용자 결정]

### 5.3 잔액 감소 안내

- EC-15: 클릭 시점의 보내는 토큰 잔액을 몰랐으면 approve 성공 결과의 `balanceDropped`는 `false`다 — 검증: 통합 테스트 [제안 후 승인]
- EC-16: approve 성공 뒤 잔액 다시 읽기가 실패하면 `balanceDropped`는 `false`다 — 검증: 통합 테스트 [제안 후 승인]
- EC-17: allowance 초기화 대상 토큰의 `approve(swapRouter02, 0)` 성공에도 DoD-11·12의 규칙을 적용한다 — 검증: 통합 테스트 [제안 후 승인]

### 5.4 메시지 수명

- EC-18: 스왑 성공 뒤 앱이 보내는 칸 금액을 비우는 것으로는 `result`가 지워지지 않는다 — 검증: 통합 테스트 [사용자 결정]
- EC-19: 슬리피지를 바꿔도 `result`가 지워지지 않는다 — 검증: 통합 테스트 [사용자 결정]
- EC-20: 시간이 지나도 `result`가 지워지지 않는다 — 검증: 통합 테스트 (가짜 타이머) [사용자 결정]
- EC-27: 값을 바꾸지 않는 사용자 조작(형식 검사에 걸린 금액 입력, 같은 토큰·같은 체인 재선택, 이미 같은 값에서 `최대`)으로는 `result`가 지워지지 않는다 — 검증: 통합 테스트 [사용자 결정]
- EC-28: 실행을 시작하지 않고 끝나는 approve·swap 호출(F5 EC-19)로는 `result`가 지워지지 않는다 — 검증: 통합 테스트 [사용자 결정]

### 5.5 동시성

- EC-21: `approving`·`swapping` 중에 사용자가 금액·토큰·선택 체인을 바꿔도 `tx-status[data-status]`는 `pending`을 유지한다 — 검증: 통합 테스트 [사용자 결정]
- EC-22: `approving`·`swapping` 중에 입력을 바꾼 뒤 나온 결과는 표시된다 — 검증: 통합 테스트 [사용자 결정]
- EC-23: 결과가 나온 시점에 선택 체인이 tx 체인과 달라도 결과를 표시하고, `tx-link`는 tx 체인 탐색기를 가리킨다 — 검증: 통합 테스트 [사용자 결정]
- EC-24: `approving`·`swapping` 중에 지갑 연결이 해제되거나 계정이 바뀌면 `tx-status[data-status]`가 `none`이 되고 그 트랜잭션의 `result`를 기록하지 않는다 — 검증: 통합 테스트 [사용자 결정]
- EC-25: 결과 메시지가 보이는 동안 지갑 연결이 해제되거나 계정이 바뀌면 `result`가 `null`이 된다 — 검증: 통합 테스트 [사용자 결정]
- EC-26: `awaiting-signature` 동안 `tx-status[data-status]`는 `none`이다 — 검증: 통합 테스트 [사용자 결정]

## 미결정 사항

없음
