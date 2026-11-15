# 스펙: slippage (슬리피지 허용치·최소 수령량)

- 상태: 완료
- 최종 갱신: 2026-11-15

## 1. 목표

사용자가 스왑에서 허용할 수령량 하락폭(슬리피지 허용치)을 프리셋에서 고르게 하고, F3 견적의 예상 수령량에 이를 반영한 `amountOutMinimum`을 계산해 최소 수령량으로 보여 준다. 슬리피지 값과 `amountOutMinimum`은 F5(스왑)가 읽는 계약(§4)이 된다. [사용자 결정]

### 1.1 화면

- 스왑 카드 헤더 오른쪽에 슬리피지 설정 버튼을 둔다. 아이콘은 시안 A처럼 조절(sliders) 모양이다 [제안 후 승인]
- 버튼을 누르면 버튼 아래 오른쪽 정렬로 팝오버가 열린다. 팝오버에는 제목 `슬리피지 허용치`, 닫기 버튼(✕), 프리셋 `0.1%`·`0.5%`·`1.0%` 세 개, 안내 문구 `최소 수령량에 바로 반영`을 둔다 [사용자 결정]
- 선택된 프리셋은 `--accent` 테두리로 표시한다 [사용자 결정]
- `견적 정보` 행 순서는 예상 수령량, 최소 수령량, 가격 영향, 수수료 티어, 슬리피지 허용치다 [사용자 결정]
- 시안은 `docs/design/wireframe/a-slippage.png`, 디자인 토큰은 `docs/design/README.md`를 따른다 [사용자 결정]

## 2. 비목표

- 슬리피지 직접 입력. 프리셋 0.1%·0.5%·1.0%만 쓴다 [사용자 결정]
- 트랜잭션 deadline의 값, 설정 UI, 전달 방식 (라우터와 함께 F5) [사용자 결정]
- 새로고침 후 슬리피지 복원(쿠키·localStorage 저장) [사용자 결정]
- 슬리피지 허용치 행의 팝오버 진입 아이콘 [사용자 결정]
- 최소 수령량 행의 `?` 정보 아이콘과 툴팁 [사용자 결정]
- 최소 수령량이 0일 때 스왑 차단 (F5에서 정한다) [사용자 결정]
- 슬리피지가 낮거나 높을 때의 경고 표시 [제안 후 승인]
- 스왑 실행과 주 버튼 상태 변경. 주 버튼 상태(`primary-button[data-state]`)는 F3과 같다 [제안 후 승인]

## 3. 완료의 정의

### 3.1 슬리피지 값

- DoD-1: 앱을 처음 열면 슬리피지는 50 bps(0.5%)다 — 검증: 통합 테스트 [사용자 결정]
- DoD-2: 서버 렌더링과 하이드레이션 직후의 슬리피지 초기값이 같은 50 bps다. 상태 초기값은 `DEFAULT_SLIPPAGE_BPS`이고 쿠키·브라우저 저장소·`window`를 읽지 않는다 — 검증: 코드 대조 [사용자 결정]
- DoD-3: 프리셋을 고르면 `useSlippage().slippageBps`가 그 프리셋 값이 된다 — 검증: 통합 테스트 [사용자 결정]
- DoD-4: 선택 체인을 바꿔도 슬리피지 값이 유지된다 — 검증: 통합 테스트 [사용자 결정]
- DoD-5: 지갑 연결 해제와 계정 변경 뒤에도 슬리피지 값이 유지된다 — 검증: 통합 테스트 [제안 후 승인]

### 3.2 팝오버

- DoD-6: `slippage-button`은 견적 상태와 지갑 연결 상태에 관계없이 렌더링된다 — 검증: 통합 테스트 [사용자 결정]
- DoD-7: `slippage-button`을 누르면 `slippage-popover`가 열리고 버튼의 `aria-expanded`가 `true`가 된다 — 검증: 통합 테스트 [사용자 결정]
- DoD-8: 프리셋은 `radiogroup` 안의 `radio` 세 개이고, 현재 값의 `slippage-option`만 `aria-checked="true"`다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-9: 프리셋을 골라도 팝오버는 열린 채로 남는다 — 검증: 통합 테스트 [사용자 결정]
- DoD-10: 닫기 버튼(✕)을 누르면 팝오버가 닫힌다 — 검증: 통합 테스트 [사용자 결정]
- DoD-11: Esc를 누르면 팝오버가 닫힌다 — 검증: 통합 테스트 [사용자 결정]
- DoD-12: 팝오버 바깥을 클릭하면 팝오버가 닫힌다 — 검증: 통합 테스트 [사용자 결정]
- DoD-13: 닫기 버튼(✕)이나 Esc로 팝오버가 닫히면 포커스가 `slippage-button`으로 돌아간다 — 검증: 통합 테스트 [사용자 결정]
- DoD-29: 포커스를 받지 않는 팝오버 바깥 영역을 클릭해 팝오버가 닫히면 포커스가 `slippage-button`으로 돌아간다 — 검증: 통합 테스트(가상 클릭 경로), 수동 1회(실제 Chrome 마우스 클릭), 결과 기록 [사용자 결정]
- DoD-14: 팝오버와 설정 버튼이 시안 A(`a-slippage.png`)와 같은 배치이고 선택 프리셋이 `--accent` 테두리다 — 검증: 수동 1회 화면 대조, 결과 기록 [제안 후 승인]

### 3.3 최소 수령량과 슬리피지 행

- DoD-15: `getAmountOutMinimum(amountOut, bps)`는 `amountOut * (10000n - bps) / 10000n`(bigint 나눗셈, 내림)이다 — 검증: 단위 테스트 [사용자 결정]
- DoD-16: 슬리피지 표기는 소수 1자리 고정 퍼센트(`10`→`0.1%`, `50`→`0.5%`, `100`→`1.0%`)이며 로캘 API를 쓰지 않는다 — 검증: 단위 테스트 [제안 후 승인]
- DoD-17: 견적이 `success`이면 `quote-amount-out-minimum`의 `data-amount-out-minimum-raw`가 `getAmountOutMinimum(quote.amountOut, slippageBps)`의 10진 문자열이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-18: 견적이 `success`이면 최소 수령량 값은 `formatTokenAmount(amountOutMinimum, tokenOut.decimals)`와 받는 토큰 심볼로 표시한다 — 검증: 통합 테스트 [사용자 결정]
- DoD-19: 견적 정보가 렌더링되는 동안 `quote-slippage`의 `data-slippage-bps`는 현재 슬리피지 값이다 — 검증: 통합 테스트 [사용자 결정]
- DoD-20: 견적이 `loading`이면 최소 수령량 값 자리는 `quote-skeleton`이고 `data-amount-out-minimum-raw` 속성이 없다 — 검증: 통합 테스트 [사용자 결정]
- DoD-21: 견적이 `loading`이어도 슬리피지 허용치 행은 스켈레톤 없이 값을 표시한다 — 검증: 통합 테스트 [사용자 결정]
- DoD-22: 견적 정보 영역의 렌더링 여부는 F3(`docs/specs/quote.md` §4.3)과 같다. 최소 수령량과 슬리피지 허용치 행도 그 영역 안에 있다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-23: 슬리피지를 바꾸면 새 견적 RPC 요청 없이 `data-amount-out-minimum-raw`가 새 값으로 바뀐다 — 검증: 통합 테스트 (RPC fetch 스텁 요청 수 확인) [사용자 결정]
- DoD-24: `useAmountOutMinimum()`은 견적이 `success`일 때 `getAmountOutMinimum(quote.amountOut, slippageBps)`를 돌려준다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-25: `useAmountOutMinimum()`은 견적이 `idle`, `loading`, `no-route`, `error`이면 `null`을 돌려준다 — 검증: 통합 테스트 [제안 후 승인]
- DoD-26: Ethereum 포크 고정 블록에서 실제 견적 후 `1.0%`를 고르면 `data-amount-out-minimum-raw`가 화면의 `data-amount-out-raw × 9900 / 10000`(내림)과 같다 — 검증: E2E (anvil 포크 + mock 커넥터) [사용자 결정]
- DoD-27: Base 메인넷에서 ETH→USDC 견적의 최소 수령량과 슬리피지 행이 표시되고 프리셋 변경이 반영된다 — 검증: 수동 1회, 결과 기록 [사용자 결정]
- DoD-28: Arbitrum 메인넷에서 ETH→USDC 견적의 최소 수령량과 슬리피지 행이 표시되고 프리셋 변경이 반영된다 — 검증: 수동 1회, 결과 기록 [사용자 결정]

## 4. 인터페이스 계약

### 4.1 값과 계산

- `SlippageBps = 10 | 50 | 100` [사용자 결정]
- `SLIPPAGE_PRESETS_BPS = [10, 50, 100]`, `DEFAULT_SLIPPAGE_BPS = 50` [사용자 결정]
- `getAmountOutMinimum(amountOut: bigint, slippageBps: SlippageBps): bigint` [사용자 결정]

### 4.2 훅

- `useSlippage(): { slippageBps: SlippageBps; setSlippageBps: (bps: SlippageBps) => void }`. 값은 클라이언트 메모리 상태이며 선택 체인, 지갑 연결, 계정과 무관하다 [사용자 결정]
- `useAmountOutMinimum(): bigint | null`. 견적 `status`가 `success`일 때만 `null`이 아니다 [제안 후 승인]

### 4.3 테스트 식별자

- `slippage-button[aria-expanded]`: 스왑 카드 헤더의 팝오버 트리거. 접근성 이름은 `슬리피지 설정` [제안 후 승인]
- `slippage-popover`: 팝오버 [제안 후 승인]
- `slippage-option[data-slippage-bps][aria-checked]`: 프리셋 `radio`. `data-slippage-bps` 값은 `10` | `50` | `100` [제안 후 승인]
- `quote-amount-out-minimum[data-amount-out-minimum-raw]`: 최소 수령량 행. 값은 정수 최소 수령량의 10진 문자열이며, 견적 `quote`가 `null`이면 속성이 없다 [제안 후 승인]
- `quote-slippage[data-slippage-bps]`: 슬리피지 허용치 행 [제안 후 승인]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 값 경계

- EC-1: `amountOut`이 1이면 `getAmountOutMinimum`은 세 프리셋 모두 `0n`이다 — 검증: 단위 테스트 [사용자 결정]
- EC-2: 최소 수령량이 `0n`이면 `data-amount-out-minimum-raw="0"`이고 값은 `0`과 받는 토큰 심볼로 표시한다 — 검증: 통합 테스트 [사용자 결정]
- EC-3: `amountOut`이 `2n ** 256n - 1n`이어도 정밀도 손실 없이 내림 결과를 돌려준다 — 검증: 단위 테스트 [제안 후 승인]

### 5.2 팝오버가 열린 동안의 상태 변화

- EC-4: 팝오버가 열린 채 선택 체인을 바꾸면 팝오버는 열린 채로 남는다 — 검증: 통합 테스트 [제안 후 승인]
- EC-5: 팝오버가 열린 채 15초 자동 갱신으로 `amountOut`이 바뀌면 팝오버는 열린 채로 남고 `data-amount-out-minimum-raw`가 새 `amountOut` 기준으로 바뀐다 — 검증: 통합 테스트 (가짜 타이머) [제안 후 승인]
- EC-6: 팝오버가 열린 채 견적이 `no-route` 또는 `error`가 되면 팝오버는 열린 채로 남는다 — 검증: 통합 테스트 [제안 후 승인]

### 5.3 포커스

- EC-8: 포커스를 받는 요소(예: 금액 입력칸)를 클릭해 팝오버가 닫히면 포커스는 그 요소에 남는다 — 검증: 통합 테스트 [사용자 결정]

### 5.4 연속 입력

- EC-7: 프리셋을 연달아 누르면 마지막으로 누른 값이 남는다 — 검증: 통합 테스트 [제안 후 승인]

## 미결정 사항

없음

F5 인계: `amountOutMinimum`이 `0n`일 때 스왑을 막을지, deadline 처리는 F5 인터뷰에서 정한다.
