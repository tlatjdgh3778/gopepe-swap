# 스펙: approve-swap (allowance 확인·approve → swap)

- 상태: 완료
- 최종 갱신: 2026-11-17

## 1. 목표

연결된 사용자가 ERC-20 토큰을 다른 ERC-20 토큰으로 바꿀 수 있게 한다. 입력 토큰의 SwapRouter02 allowance를 확인하고, 부족하면 approve 트랜잭션을, 충분하면 F3 견적(`useSwapQuote()`)과 F4 최소 수령량(`useAmountOutMinimum()`)으로 단일 홉 스왑 트랜잭션을 보낸다. 실행 상태(`useSwapExecution()`)와 allowance(`useTokenAllowance()`)는 F6(tx 상태 메시지)와 F7(ETH 분기)이 읽는 계약(§4)이 된다. [사용자 결정]

### 1.1 화면

- 새 화면 요소는 없다. 주 버튼의 상태와 동작만 늘어난다 [제안 후 승인]
- 주 버튼 문구: `awaiting-signature`는 `지갑에서 확인`, `approving`은 `승인 중…`, `swapping`은 `스왑 중…`, `price-impact-too-high`는 `가격 영향이 너무 큼`, `amount-too-small`은 `금액이 너무 적음`, `allowance-error`는 `승인 상태를 확인할 수 없음`, `checking-allowance`는 `승인 확인 중…`, `approve-required`는 보내는 토큰 심볼 뒤에 ` 승인`(예: `USDC 승인`), `swap-ready`는 `스왑` [제안 후 승인]
- `approve-required`와 `swap-ready`만 활성이고 나머지 신규 상태는 비활성이다 [사용자 결정]

## 2. 비목표

- ETH가 낀 페어(보내는 토큰이나 받는 토큰이 ETH)의 스왑 실행. ETH 입력의 `value` 첨부와 ETH 출력의 unwrap은 F7이 맡는다 [사용자 결정]
- 상태 메시지 영역(성공·거부·revert 문구, tx 링크). F6가 맡는다 [사용자 결정]
- deadline 설정 UI. F4 슬리피지 팝오버는 바꾸지 않는다 [사용자 결정]
- 정확한 금액 승인과 승인 금액 선택 UI [사용자 결정]
- ETH 가스 부족 사전 판정 [사용자 결정]
- 가격 영향이 크거나 최소 수령량이 0일 때 확인 후 스왑을 허용하는 단계 [사용자 결정]
- 새로고침 후 진행 중인 트랜잭션 상태 복원 [사용자 결정]
- approve 영수증 확인 후 스왑 자동 연속 실행 [사용자 결정]
- 서명·pending 동안 입력(금액·토큰·뒤집기·슬리피지) 잠금과 견적 갱신 중지 [사용자 결정]
- allowance 주기 갱신 [사용자 결정]
- `@uniswap/v3-sdk`·`@uniswap/sdk-core` 도입 [제안 후 승인]
- Permit2 [사용자 결정]
- Ethereum 메인넷 실제 쓰기 확인 (F8) [사용자 결정]

## 3. 완료의 정의

### 3.1 라우터 config

- DoD-1: 세 체인(Ethereum, Base, Arbitrum)의 `ChainContracts.swapRouter02`가 EIP-55 체크섬 주소다 — 검증: 단위 테스트 [사용자 결정]
- DoD-2: Ethereum 포크 고정 블록에서 `swapRouter02` 주소에 컨트랙트 코드가 있다 — 검증: 통합 테스트 (anvil 포크) [제안 후 승인]
- DoD-3: Base 메인넷의 `swapRouter02` 주소에 SwapRouter02가 배포되어 있다 — 검증: 수동 1회, 결과 기록 [제안 후 승인]
- DoD-4: Arbitrum 메인넷의 `swapRouter02` 주소에 SwapRouter02가 배포되어 있다 — 검증: 수동 1회, 결과 기록 [제안 후 승인]

### 3.2 주 버튼 상태 판정

- DoD-5: 주 버튼 상태는 위에서부터 먼저 해당하는 것으로 정한다: `restoring` → `disconnected` → `awaiting-signature` → `approving` → `swapping` → `select-token` → `enter-amount` → `insufficient-balance` → `quoting` → `no-route` → `quote-error` → `quote-ready` → `price-impact-too-high` → `amount-too-small` → `allowance-error` → `checking-allowance` → `approve-required` → `swap-ready` — 검증: 단위 테스트 [제안 후 승인]
- DoD-6: 견적이 `success`이고 보내는 토큰이나 받는 토큰이 ETH이면 주 버튼은 `quote-ready`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-7: ERC-20↔ERC-20 페어(WETH 포함)에서 견적이 `success`이고 가격 영향이 `error` 등급이면 주 버튼은 `price-impact-too-high`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-8: ERC-20↔ERC-20 페어에서 견적이 `success`이고 `useAmountOutMinimum()`이 `0n`이면 주 버튼은 `amount-too-small`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-9: ERC-20↔ERC-20 페어에서 견적이 `success`이고 현재 키(계정·체인·보내는 토큰)의 성공 값 없이 allowance를 읽는 중이면 주 버튼은 `checking-allowance`이고 비활성이다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-10: ERC-20↔ERC-20 페어에서 견적이 `success`이고 allowance가 `amountInRaw`보다 작으면 주 버튼은 `approve-required`이고 활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-11: ERC-20↔ERC-20 페어에서 견적이 `success`이고 allowance가 `amountInRaw` 이상이면 주 버튼은 `swap-ready`이고 활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-12: 보내는 토큰이 ETH이거나 지갑이 연결되지 않았으면 `useTokenAllowance().status`는 `idle`이고 allowance 읽기 요청을 보내지 않는다 — 검증: 통합 테스트 [제안 후 승인]

### 3.3 approve

- DoD-13: `approve-required`에서 주 버튼을 누르면 보내는 토큰 컨트랙트에 `approve(swapRouter02, maxUint256)` 트랜잭션을 보낸다 — 검증: 통합 테스트 (지갑 스텁 요청 확인), 통합 테스트 (anvil 포크 체결 후 allowance 확인) [사용자 결정]
- DoD-14: approve 영수증이 성공이면 allowance를 다시 읽고 주 버튼이 `swap-ready`가 된다. 스왑 트랜잭션은 사용자가 다시 누르기 전까지 보내지 않는다 — 검증: 통합 테스트 [사용자 결정]

### 3.4 swap

- DoD-15: `swap-ready`에서 주 버튼을 누르면 `swapRouter02`에 `multicall(deadline, [exactInputSingle(params)])` 트랜잭션을 보낸다 — 검증: 통합 테스트 (지갑 스텁 요청 디코딩) [사용자 결정]
- DoD-16: `exactInputSingle` 인자는 클릭 시점 값으로 `tokenIn`·`tokenOut`(견적과 같은 WETH 치환 주소), `fee` = `quote.fee`, `recipient` = 연결 계정, `amountIn` = `amountInRaw`, `amountOutMinimum` = `useAmountOutMinimum()`, `sqrtPriceLimitX96` = 0이다 — 검증: 통합 테스트 (지갑 스텁 요청 디코딩) [사용자 결정]
- DoD-17: `deadline`은 전송 직전 클라이언트 시각(초) + 1800이다 — 검증: 통합 테스트 (가짜 타이머) [사용자 결정]
- DoD-18: Ethereum 포크에서 DoD-15·16 인코딩의 스왑이 체결되고, 받는 토큰 잔액 증가량이 `amountOutMinimum` 이상이다 — 검증: 통합 테스트 (anvil 포크) [제안 후 승인]
- DoD-19: 스왑 영수증이 성공이면 보내는 칸 금액이 빈 값이 되고 보내는 토큰과 받는 토큰 선택은 유지된다 — 검증: 통합 테스트 [사용자 결정]
- DoD-20: 스왑 영수증이 성공이면 트랜잭션 체인·계정의 카드 잔액과 allowance를 무효화해, 화면의 보내는 토큰·받는 토큰 잔액과 allowance를 15초 주기를 기다리지 않고 다시 읽는다 — 검증: 통합 테스트 (RPC fetch 스텁 요청 확인) [사용자 결정]

### 3.5 체인 확인과 진행 상태

- DoD-21: approve와 swap 모두 트랜잭션 전송 전에 `useEnsureChain()`을 호출하고, 트랜잭션은 선택 체인으로 보낸다 — 검증: 통합 테스트 [사용자 결정]
- DoD-22: 주 버튼을 누른 즉시부터 지갑 서명(체인 전환 요청 포함)이 끝날 때까지 주 버튼은 `awaiting-signature`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-23: approve 트랜잭션 해시를 받은 뒤 영수증이 나올 때까지 주 버튼은 `approving`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-24: swap 트랜잭션 해시를 받은 뒤 영수증이 나올 때까지 주 버튼은 `swapping`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-30: approve·swap 영수증이 성공이면 allowance 다시 읽기가 끝날 때까지 `phase`는 `approving`·`swapping`을 유지한다 — 검증: 통합 테스트 [사용자 결정]
- DoD-25: `useSwapExecution().pendingTx`는 `approving`·`swapping` 동안 `{ kind, chainId, hash }`이고, 그 밖의 `phase`에서는 `null`이다 — 검증: 통합 테스트 [제안 후 승인]

### 3.6 사용자 흐름과 실제 체인

- DoD-26: Ethereum 포크에서 mock 커넥터로 ERC-20 페어(예: USDC→DAI)를 `approve-required` 클릭 → `swap-ready` 클릭까지 진행하면 보내는 토큰 잔액이 `amountInRaw`만큼 줄고 받는 토큰 잔액이 늘어난다 — 검증: E2E (anvil 포크 + mock 커넥터) [제안 후 승인]
- DoD-27: E2E는 파일을 순차 실행(`workers: 1`)하고, 쓰기 트랜잭션을 보내는 테스트는 테스트마다 anvil 상태를 스냅샷으로 되돌린다. 쓰기 spec을 포함한 `bun run test:e2e` 전체가 통과한다 — 검증: 명령 실행 확인 [사용자 결정]
- DoD-31: 포크 통합 테스트는 파일을 순차 실행하고, 쓰기 트랜잭션을 보내는 테스트는 테스트마다 anvil 상태를 스냅샷으로 되돌린다. 쓰기 테스트를 포함한 `bun run test:fork` 전체가 통과한다 — 검증: 명령 실행 확인 [사용자 결정]
- DoD-28: Base 메인넷에서 ERC-20 페어 소액 approve → swap을 1회 체결한다 — 검증: 수동 1회, tx 해시 기록 [사용자 결정]
- DoD-29: Arbitrum 메인넷에서 ERC-20 페어 소액 approve → swap을 1회 체결한다 — 검증: 수동 1회, tx 해시 기록 [사용자 결정]

## 4. 인터페이스 계약

### 4.1 config와 ABI

- `ChainContracts`에 `swapRouter02: Address`를 추가한다 [사용자 결정]
- `swapRouter02` 값: Ethereum·Arbitrum `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, Base `0x2626664c2603336E57B271c5C0b26F421741e481` [제안 후 승인]
- 토큰 config에 allowance를 0으로 초기화한 뒤에만 다시 승인할 수 있는 토큰의 체인별 주소 목록을 둔다. 초기 목록은 Ethereum USDT 하나다 [사용자 결정]
- SwapRouter02 로컬 ABI는 `exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))`와 `multicall(uint256 deadline, bytes[] data)`를 담는다. ERC-20은 viem `erc20Abi`를 쓴다 [제안 후 승인]

### 4.2 훅

- `useTokenAllowance(): { status: "idle" | "loading" | "success" | "error"; allowance: bigint | null }`. 대상은 연결 계정, 선택 체인, 보내는 토큰이고 spender는 선택 체인의 `swapRouter02`다. `allowance`는 `status`가 `success`일 때만 `null`이 아니다 [제안 후 승인]
- `useTokenAllowance()`의 `loading`·`error`는 현재 키에 성공 값이 없을 때만 쓴다. 성공 값이 있으면 다시 읽는 중이거나 다시 읽기가 실패해도 `success`와 그 값을 유지한다 [사용자 결정]
- 현재 키에 성공 값 없이 읽기가 실패한 뒤 그 키를 다시 읽는 동안(포커스, 키 복귀, 트랜잭션 종료)에는 `error`를 유지한다. DoD-9의 `checking-allowance`는 현재 키에 실패 기록도 없을 때다 [사용자 결정]
- `useSwapExecution(): { phase: "idle" | "awaiting-signature" | "approving" | "swapping"; pendingTx: { kind: "approve" | "swap"; chainId: SupportedChainId; hash: Hash } | null; approve; swap }`. `approve`와 `swap`은 인자 없는 비동기 함수이고 resolve 값은 `void`다 [제안 후 승인]
- `approve`·`swap`은 reject하지 않는다. 결과는 `phase`로만 드러난다 [사용자 결정]

### 4.3 주 버튼

- `primary-button[data-state]` 값: `restoring` | `disconnected` | `awaiting-signature` | `approving` | `swapping` | `select-token` | `enter-amount` | `insufficient-balance` | `quoting` | `no-route` | `quote-error` | `quote-ready` | `price-impact-too-high` | `amount-too-small` | `allowance-error` | `checking-allowance` | `approve-required` | `swap-ready` [제안 후 승인]
- `quote-ready`는 ETH가 낀 페어의 견적 완료 상태로 좁혀지고 비활성을 유지한다(F3 DoD-36 유지). ERC-20↔ERC-20 페어에서는 F3 EC-15(가격 영향 `error` 등급이어도 `quote-ready`) 대신 DoD-7을 따른다 [사용자 결정]
- 새 `data-testid`는 추가하지 않는다 [제안 후 승인]

### 4.4 RPC

- allowance 읽기와 영수증 조회는 기존 RPC 프록시(`/api/rpc/[chainId]`)를 거친다. 트랜잭션 전송은 지갑이 처리한다 [제안 후 승인]
- RPC 프록시의 허용 메서드는 바꾸지 않는다 [제안 후 승인]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 지갑·트랜잭션 실패

- EC-1: 체인 전환을 거부하거나 전환에 실패하면 트랜잭션을 보내지 않고 주 버튼이 클릭 전 상태로 돌아간다 — 검증: 통합 테스트 [사용자 결정]
- EC-2: 지갑 서명을 거부하면 주 버튼이 클릭 전 상태로 돌아가고 메시지를 표시하지 않는다 — 검증: 통합 테스트, E2E (거부 주입 방식은 테스트 설계 단계에서 확정) [사용자 결정]
- EC-3: 지갑의 가스 추정이 실패해 전송되지 않으면 주 버튼이 클릭 전 상태로 돌아간다 — 검증: 통합 테스트 [사용자 결정]
- EC-4: approve 또는 swap 영수증이 revert이면 `phase`가 `idle`로 돌아가 주 버튼을 현재 입력·견적·allowance로 다시 판정하고 allowance와 잔액을 다시 읽는다 — 검증: 통합 테스트 [사용자 결정]
- EC-5: 영수증 대기가 reject되면(viem 내부 재시도 소진, 트랜잭션 교체·취소) `phase`가 `idle`로 돌아가 주 버튼을 현재 입력·견적·allowance로 다시 판정하고 allowance와 잔액을 다시 읽는다 — 검증: 통합 테스트 [사용자 결정]

- EC-18: 영수증이 오래 나오지 않아도 시간 제한으로 실패 처리하지 않고 `approving`·`swapping`을 유지한다 — 검증: 통합 테스트 (가짜 타이머) [사용자 결정]

### 5.2 중복 실행과 동시성

- EC-6: 주 버튼을 연달아 눌러도 트랜잭션 전송 요청은 한 번이다 — 검증: 통합 테스트 [사용자 결정]
- EC-7: `approving`·`swapping` 중에 금액이나 토큰을 바꿔도 영수증이 나올 때까지 주 버튼 상태가 유지된다 — 검증: 통합 테스트 [사용자 결정]
- EC-8: `approving`·`swapping` 중에 드롭다운으로 선택 체인을 바꿔도 트랜잭션을 보낸 체인에서 영수증을 기다리고 그동안 주 버튼 상태가 유지된다 — 검증: 통합 테스트 [사용자 결정]
- EC-9: 스왑 영수증이 성공으로 나온 시점에 선택 체인이 트랜잭션 체인과 다르면 보내는 칸 금액을 비우지 않는다 — 검증: 통합 테스트 [사용자 결정]
- EC-10: 진행 중에 지갑 연결이 해제되거나 계정이 바뀌면 `phase`가 `idle`로 돌아가고 그 트랜잭션의 영수증 후처리(금액 비우기, 잔액·allowance 다시 읽기)를 하지 않는다 — 검증: 통합 테스트 [사용자 결정]
- EC-21: `awaiting-signature` 중에 선택 체인이 바뀌어 체인 확인 뒤 선택 체인이 클릭 시점 체인과 다르면 트랜잭션을 보내지 않고 `phase`가 `idle`로 돌아간다 — 검증: 통합 테스트 [사용자 결정]
- EC-11: 서명이나 pending 중에 견적이 갱신되어 `amountOut`이 바뀌어도 전송된 트랜잭션 인자는 클릭 시점 값이다 — 검증: 통합 테스트 (가짜 타이머) [사용자 결정]

### 5.3 allowance

- EC-12: allowance 초기화 대상 토큰에서 0 < allowance < `amountInRaw`이면 `approve-required` 클릭이 `approve(swapRouter02, 0)`을 보낸다 — 검증: 통합 테스트, 통합 테스트 (anvil 포크, Ethereum USDT) [사용자 결정]
- EC-13: EC-12의 `approve(0)` 영수증이 성공하면 주 버튼이 다시 `approve-required`가 되고, 다음 클릭이 `approve(swapRouter02, maxUint256)`을 보낸다 — 검증: 통합 테스트 [사용자 결정]
- EC-14: allowance 읽기가 실패하고 현재 키에 성공 값이 없으면 주 버튼은 `allowance-error`이고 비활성이다 — 검증: 통합 테스트 [사용자 결정]
- EC-15: allowance는 연결 계정·선택 체인·보내는 토큰이 바뀔 때, approve·swap 트랜잭션이 끝난 뒤, 창 포커스가 돌아올 때만 다시 읽는다 — 검증: 통합 테스트 [사용자 결정]
- EC-16: 지갑에 SwapRouter02에 대한 기존 allowance가 `amountInRaw` 이상 있으면 approve 없이 `swap-ready`다 — 검증: 통합 테스트 [사용자 결정]
- EC-17: 현재 키에 성공 값이 있는 상태에서 allowance를 다시 읽는 중이거나 다시 읽기가 실패하면 `useTokenAllowance()`는 `success`와 이전 값을 유지한다 — 검증: 통합 테스트 [사용자 결정]

### 5.4 실행 함수 호출

- EC-19: `approve`를 `approve-required`가 아닐 때, `swap`을 `swap-ready`가 아닐 때, 또는 진행 중에 호출하면 지갑 요청 없이 resolve한다 — 검증: 통합 테스트 [사용자 결정]
- EC-20: 체인 전환 거부, 서명 거부, revert, 영수증 대기 reject에서도 `approve`·`swap`이 돌려준 Promise는 resolve한다 — 검증: 통합 테스트 [사용자 결정]

## 미결정 사항

없음

구현 전에 확인할 사실(결정 아님):

- 세 체인 `swapRouter02` 주소의 배포 여부와 `multicall(uint256,bytes[])` 오버로드 selector
- Ethereum USDT `approve`는 bool을 반환하지 않으므로 viem `erc20Abi`로 `simulateContract`하면 반환값 디코딩이 실패할 수 있다
- 기존 테스트 중 ERC-20 페어로 `quote-ready`를 단정하는 F2·F3 테스트와 `e2e/support/app.ts`의 주 버튼 상태 정규식은 F5 상태 집합에 맞춰 회귀 수정한다
