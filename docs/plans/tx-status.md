# 계획: tx-status

- 상태: 승인
- 스펙: docs/specs/tx-status.md
- 기준 코드: 7df1342 + 작업 트리
- 최종 갱신: 2026-11-19

## 1. 구현 전략

- 순서는 사전 확인, lib 순수 함수, 실행 provider·폼 변경 신호, 메시지 컴포넌트·카드 배치, 테스트(단위, 교체 지원 확장 병합, 통합 4파일), F5 회귀 갱신, E2E, 전체 검사다. 근거: `docs/plans/approve-swap.md:10`
- 순수 함수는 `lib/` 신규 두 파일에 둔다. `lib/tx-explorer.ts`는 `CHAINS_BY_ID[chainId].blockExplorers`로 tx URL을 만들고 새 config를 두지 않는다. `lib/tx-result.ts`는 `TxResult` 타입, 오류 원인 체인(`cause` 순회, 순환 방지)의 code 4001 판정, 단계별 분류(체인 확인 단계는 `rejected`/`chain-switch-failed`, 전송 단계는 `rejected`/`send-failed`), 영수증 대기 결과(`onReplaced` 사유 cancelled·replaced → `replaced`, 사유 없음·repriced → 영수증 status, reject → `receipt-failed`)의 변환, `balanceDropped` 판정을 맡는다. React·wagmi를 import하지 않는다. 근거: `lib/primary-button-state.ts`, `lib/swap-transaction.ts`, `node_modules/viem/actions/public/waitForTransactionReceipt.ts:445-448,519-522,555-573`
- 실행 provider는 F5 구조(세대 ref, 잠금, 클릭 시점 스냅샷, `isCurrent` 가드)를 유지한다. `ExecutionState`에 `result`를 더해 결과 기록과 idle 전환을 `setExecution` 한 번으로 하고 `finish`가 결과를 받는다. 현재 하나인 전송 전 try를 체인 확인과 전송 두 단계로 나눠 각 단계 오류를 분류하고, 두 단계 사이의 선택 체인 비교(F5 EC-21)는 결과 없이 끝낸다. 근거: `providers/swap-execution-provider.tsx:64-71,164-238`
- 영수증 대기는 `waitForTransactionReceipt`에 `onReplaced`를 넘기고 `timeout: 0`과 트랜잭션 체인 클라이언트를 유지한다. `replacement` 인자와 전송 전 nonce 조회는 쓰지 않는다. `pendingTx`는 결과가 나올 때까지 원 해시를 유지한다. 근거: `providers/swap-execution-provider.tsx:206-215`, `config/rpc.ts:5-19`
- approve 성공 후처리는 allowance 무효화와 보내는 토큰 카드 잔액 다시 읽기를 함께 await한다. 잔액은 트랜잭션 체인·계정·클릭 시점 토큰의 카드 잔액 키로, 영수증 뒤 새로 보낸 요청의 응답을 비교값으로 쓴다(진행 중이던 15초 주기 읽기 재사용 금지). 쿼리가 비활성이어도 트랜잭션 체인 클라이언트로 읽는다. 키를 맞추기 위해 카드 잔액 키 생성 함수를 export한다. 근거: `hooks/use-token-balance.ts:24-62`, `hooks/use-token-allowance-read.ts:45-53`, `node_modules/@tanstack/query-core/src/queryClient.ts:619-620`
- 결과를 지우는 경로는 `dismissResult`, 실행 시작, 계정 변경·해제 effect, 렌더 시점 계정 마스킹, 사용자 변경 신호와 선택 체인 값 변경이다. 실행 provider는 폼 provider 안쪽이라 폼 동작을 가로챌 수 없으므로, `providers/swap-form-provider.tsx`에 사용자 변경 횟수 훅과 변경 신호를 내지 않는 앱 전용 금액 비우기 동작을 추가만 한다. 횟수는 금액·토큰 값이 실제로 바뀐 사용자 동작만 올린다. F2 계약 `SwapFormValue`는 바꾸지 않는다. 선택 체인은 드롭다운만 바꾸므로 값 변경 effect로 충분하다. 근거: `providers/swap-form-provider.tsx:31-42,120,141-152,202-206`, `components/chain-select.tsx:34`
- 메시지 컴포넌트는 `"use client"` 신규 파일로 루트 요소 하나를 항상 마운트하고 상태가 바뀌어도 같은 노드를 유지한다(F5 EC-2 jsdom·E2E의 role 요소 관찰과 낭독 안정성). 표시 우선순위는 진행 phase(`approving`·`swapping`)의 pending, 그다음 `result`, 그 밖은 `none`이다. 닫기·외부 링크·색은 기존 패턴과 토큰 범위에서 고르고 role `alert`는 쓰지 않는다. 카드는 서버 컴포넌트 그대로 두고 주 버튼 다음 줄에 추가한다. 근거: `components/swap-card.tsx:27-28`, `components/slippage-settings.tsx:44-47`, `components/connect-modal.tsx:119-127`, `app/globals.css:32-33,87-88,113`
- 교체 주입 스텁은 그것을 쓰는 교체 통합 Task의 살 모드 위임에 병합한다. 다른 통합 Task는 기존 스텁만 쓴다. 근거: `docs/plans/approve-swap.md:119,127`(F5 T-7 병합 선례)
- F5 회귀 갱신은 동결 골격의 assertion만 바꾸고, 사용자 결정이 있을 때만 `@then`과 it 이름을 바꾼 뒤 F5 골자 digest를 기록한다. `docs/specs/approve-swap.md`는 고치지 않는다. 근거: `docs/plans/approve-swap.md:208-212,337`
- 쓰기 격리와 실행 순서는 F5 관례(E2E `workers: 1`·snapshot/revert, `check:build`는 `test:e2e` 뒤 단독)를 따른다. mock 경계는 F5 T-9·T-10·T-13 경계를 기준으로 하고, 새 경계는 테스트 설계 단계에서 사용자가 확정한다. 근거: `docs/plans/approve-swap.md:174,195,293`

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: E2E 체결 해시를 얻는 수단, 교체 탐지 경로의 RPC 메서드, 지갑 오류의 원인 체인 형태를 실행으로 확인한다
- 선행: 없음
- 연결 항목: DoD-9, EC-1, EC-4, EC-9, EC-29
- 수정 대상: 없음. 저장소 밖에서 전용 포트(8546·8547 외, 예: 8555) anvil 포크와 Node 스크립트로 확인한다
- 따라야 할 패턴: 저장소 밖에서 확인하고 결과는 구현 기록에 남긴다 — 근거: `docs/plans/approve-swap.md:30-38`
- 완료 조건: 아래 결과를 구현 기록에 남기고, 스펙과 어긋나면 인터뷰로 되돌린다. (1) 고정 포크 블록 anvil에서 `eth_getTransactionBySenderAndNonce`·`ots_getTransactionBySenderAndNonce` 응답 여부와 블록 조회로 계정·nonce의 해시를 찾을 수 있는지 (2) `--block-time 1` 아래 mock 계정 tx의 nonce를 클릭 전에 읽을 수 있는지 (3) wagmi injected·mock 커넥터에서 4001·5000·-32000·-32603 응답이 `writeContract`·`switchChain` 오류의 원인 체인에 어떤 code로 남는지 (4) viem 교체 탐지 경로가 보내는 메서드가 프록시 허용 목록 안인지, 허용 밖 메서드에 대한 프록시 응답 code — 검증: 확인 절차
- 실행 명령: `anvil --fork-url $ETH_MAINNET_RPC_URL --fork-block-number 26250000 --port 8555`, `cast rpc`, `cast send --unlocked`
- 수정 금지: 저장소 파일
- 구현 기록: general-purpose(조사 전용 에이전트 없음), 저장소 수정 없음, anvil 1.8.1 8555(`--block-time 1`)·프록시 핸들러 8556(종료 확인). 2026-11-18. 스크립트 scratchpad `t1/`. (1) mock 계정 `0xf39F…2266`(포크 nonce 0x2d0d)의 체결 해시를 `eth_getTransactionBySenderAndNonce`(pending·채굴 뒤), `ots_getTransactionBySenderAndNonce`(채굴 뒤만), 스냅샷 이후 `eth_getBlockByNumber(n,true)` 순회 세 방법 모두 `writeContract` 반환 해시와 일치. `evm_revert` 뒤 되돌린 tx는 세 조회에서 사라짐 (2) `--block-time 1`에서 전송 전 `eth_getTransactionCount` latest = pending, mock 커넥터 전송에 nonce 필드 없음, 체결 nonce = 클릭 전 값. nonce는 스냅샷 뒤·앞선 tx 채굴 뒤에 읽는다 (3) `writeContract`(viem custom·wagmi injected·e2e mock 커넥터 동일): 4001·5000·제어값 `true`·최상위 -32603 + cause 4001 → walk(code 4001) true. -32000(`InsufficientFundsError`/`InvalidInputRpcError`)·-32603 "User denied"(viem이 `ContractFunctionRevertedError`로 감쌈)·`Object.assign(new Error,{code:-32000})` → false. -32000은 viem이 `wallet_sendTransaction`으로 1회 재시도(지갑 요청 2건). `switchChain`(injected): 4001 → `UserRejectedRequestError`, 5000·-32000·-32603 → `SwitchChainError(4902) > 원 오류`(walk false), 지갑 4902 뒤 `wallet_addEthereumChain` 실패는 원인과 무관하게 `UserRejectedRequestError(4001)`로 감쌈. mock 커넥터: 4001·5000 → walk true. `config/e2e-mock.ts`에 체인 전환 오류 제어값 없음 (4) 프록시 허용: `eth_getTransactionByHash`·`eth_getTransactionReceipt`·`eth_getBlockByNumber`·`eth_blockNumber`. 비허용(`eth_/ots_getTransactionBySenderAndNonce` 등)은 HTTP 200 `-32601`(viem `MethodNotFoundRpcError`). `replacement` 없이 `onReplaced`만 넘기면 프록시 경유 교체 시나리오에서 reason `cancelled`·`replaced`·`repriced`와 대체/새 해시 확인(허용 메서드만 사용). EC-29 시나리오(원 tx 미조회 상태 교체)는 62초 동안 pending 유지, `onReplaced` 없음. 스펙과 직접 어긋난 점 없음. 참고(스펙 문구 그대로 적용한 결과): injected 체인 전환 5000은 4001로 정규화되지 않아 `chain-switch-failed`, 4902 뒤 체인 추가 실패는 wagmi가 4001로 감싸 `rejected`

### T-2 — lib 순수 함수

- 사이드: 프론트
- 상태: 완료
- 목적: 탐색기 tx URL 생성과 결과 분류·변환·잔액 감소 판정 순수 함수를 만든다
- 선행: 없음
- 연결 항목: DoD-4, DoD-6, DoD-9, DoD-11, DoD-12, EC-1, EC-2, EC-3, EC-4, EC-7, EC-8, EC-9, EC-10, EC-12, EC-15, EC-16
- 수정 대상: `lib/tx-explorer.ts` — 신규, tx URL 생성. `lib/tx-result.ts` — 신규, 결과 타입·오류 분류·영수증 결과 변환·`balanceDropped` 판정
- 따라야 할 패턴: `lib/` 순수 함수, kebab-case 파일명과 named export — 근거: `lib/primary-button-state.ts`, `lib/swap-transaction.ts`, `CLAUDE.md`
- 완료 조건: 연결 항목에 필요한 판정 제공. React·wagmi import 없음. URL은 config 값으로 만들고 새 상수가 없다. 4001 판정은 오류 메시지 문구를 보지 않는다. 비교값 중 하나라도 없으면 잔액 감소가 아니다 — 검증: T-5, T-6, T-8, T-9
- 실행 명령: `bun run typecheck`, `bun run lint`
- 수정 금지: `config/`, `providers/`, `hooks/`, `components/`, 기존 `lib/` 파일
- 구현 기록: seongho:frontend-dev, 작성 영역 `lib/tx-explorer.ts`·`lib/tx-result.ts`(신규). 수정 0/3. export: `getTxExplorerUrl`, `TxResult`·`TxKind`·`ReceiptOutcome`·`ReceiptLike` 타입, `hasUserRejectedCode`(cause 순회·순환 방지, code === 4001만), `classifyChainSwitchError`, `classifySendError`, `getReceiptOutcome(receipt, replacementReason?)`, `getReceiptFailedOutcome`, `isBalanceDropped`. 오케스트레이터 확인: 수정 범위 일치, `typecheck`·`lint` exit 0, React·wagmi import 없음

### T-3 — 실행 provider와 사용자 변경 신호

- 사이드: 프론트
- 상태: 완료
- 목적: `useSwapExecution()`에 결과와 지우기를 더하고, 단계별 분류·교체 처리·approve 잔액 다시 읽기·결과 수명을 구현한다
- 선행: T-2
- 연결 항목: DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-12, DoD-13, DoD-14, DoD-15, EC-1, EC-2, EC-3, EC-4, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13, EC-15, EC-16, EC-17, EC-18, EC-19, EC-20, EC-22, EC-23, EC-24, EC-25, EC-27, EC-28, EC-29
- 수정 대상: `providers/swap-execution-provider.tsx` — 결과 state·`dismissResult`, 전송 전 단계 분리, `onReplaced`, approve 성공 잔액 다시 읽기, 결과 지우기 경로, 계정 마스킹, 문서 주석. `providers/swap-form-provider.tsx` — 추가만, 사용자 변경 횟수 훅과 앱 전용 금액 비우기 동작. `hooks/use-token-balance.ts` — 카드 잔액 키 생성 함수 export만, 훅 동작 불변
- 따라야 할 패턴: 호출 시점 값은 ref로 읽기, 세대 가드, Provider·훅 한 파일, 무효화 헬퍼 — 근거: `providers/swap-execution-provider.tsx:125-142,176-216`, `hooks/use-token-allowance-read.ts:45-53`
- 완료 조건: 연결 항목 충족. phase 집합과 `pendingTx` 의미 불변. 결과 기록과 idle 전환이 같은 커밋. 결과 기록은 모두 세대 가드 뒤. tx 없이 끝나면 다시 읽기 요청 0건(F5 유지). 앱의 금액 비우기는 변경 신호를 내지 않는다. 슬리피지 provider를 참조하지 않는다. 결과에 시간 기반 소멸이 없다. 전송 전 nonce 조회와 `replacement` 인자가 없다. 기존 F5 통합 테스트가 통과한다(컴포넌트가 없으므로 F5 EC-2 case도 통과) — 검증: T-6, T-7, T-8, T-9, T-10, T-11
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap __tests__/wallet`
- 수정 금지: `config/`, `lib/`, `components/`, `hooks/use-ensure-chain.ts`, `hooks/use-token-allowance-read.ts`, `providers/token-allowance-provider.tsx`, `providers/swap-quote-provider.tsx`, `docs/specs/approve-swap.md`
- 구현 기록: seongho:frontend-dev(T-2 작성 에이전트 이어서), 작성 영역 `providers/swap-execution-provider.tsx`, `providers/swap-form-provider.tsx`, `hooks/use-token-balance.ts`. 수정 0/3. 구현 판단: 결과 기록과 idle 전환은 `finish(result)`의 `setExecution` 한 번. 전송 전 단계를 체인 확인·전송으로 분리. `waitForTransactionReceipt({hash, timeout: 0, onReplaced})`, `replacement` 없음. approve 성공은 allowance 무효화와 클릭 시점 토큰·tx 체인·계정 카드 잔액 키의 `cancelQueries` 후 `fetchQuery(staleTime 0, retry false)`를 함께 await, 비교 기준은 클릭 시점 `balanceInRaw` 스냅샷, 실패는 null(false). 계정 effect가 결과 state를 실제로 지우고 세대를 올림(렌더 마스킹도 결과에 적용). 계획과 다른 점: `swap-form-provider.tsx`는 "추가만"이 아니라 내부 `SwapFormState`에 `userChangeCount`를 넣고 `defaultState`·체인 복귀 줄·`update`를 고쳤다(값 변경 판정과 횟수 증가를 한 state updater에서 원자적으로 하기 위해). 공개 계약 `SwapFormValue`·`SwapFormActions` 불변, 새 export `useSwapFormUserChangeCount`·`useSwapFormAppActions`(`clearAmountInput`)·`getCardBalanceQueryKey`(키 값 불변). 오케스트레이터 확인: 수정 범위 일치(공개 계약 불변 diff 확인), `typecheck`·`lint` exit 0, `test __tests__/swap __tests__/wallet` 22 파일 통과·5 skipped, 161 passed·37 todo

### T-4 — 메시지 컴포넌트와 카드 배치

- 사이드: 프론트
- 상태: 완료
- 목적: 주 버튼 아래 상태 메시지 영역을 만들어 카드에 배치한다
- 선행: T-3
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-7, DoD-8, DoD-9, DoD-11, DoD-12, DoD-13, EC-5, EC-7, EC-8, EC-9, EC-13, EC-14, EC-21, EC-23, EC-24, EC-26, EC-29
- 수정 대상: `components/tx-status.tsx` — 신규. `components/swap-card.tsx` — 주 버튼 다음 줄에 추가만
- 따라야 할 패턴: 닫기 버튼(XIcon `aria-hidden` + sr-only 텍스트), 외부 링크, lucide 아이콘, JSX 리터럴 testid, 디자인 토큰 — 근거: `components/slippage-settings.tsx:44-47`, `components/connect-modal.tsx:119-127`, `docs/design/README.md`
- 완료 조건: 연결 항목 충족. 루트 요소 하나가 항상 마운트되고 상태가 바뀌어도 같은 노드다. 새 testid는 스펙 §4.3의 네 개뿐이다. SSR 첫 렌더는 `none`이다. 문구는 스펙 §1.1 표를 따른다. 카드는 서버 컴포넌트 그대로다. 프로덕션 빌드 통과 — 검증: T-7~T-12, `bun run build`
- 실행 명령: `bun run build`, `bun run lint`, `bun run test __tests__/swap`
- 수정 금지: `providers/`, `hooks/`, `lib/`, `config/`, `components/primary-button.tsx`, 그 밖의 기존 컴포넌트
- 구현 기록: seongho:frontend-dev(T-2·T-3 작성 에이전트 이어서), 작성 영역 `components/tx-status.tsx`(신규), `components/swap-card.tsx`(import와 `<TxStatus />` 한 줄 추가). 수정 0/3. 구현 판단: 루트 div 하나(`role=status`) 상시 렌더, 표시 우선순위 진행 phase → result → none. 레이아웃은 루트 `-mt-6`으로 카드 `gap-6` 상쇄(none일 때 높이 0), 메시지 상자 `mt-3`. 색·아이콘 재량: pending 로더·success 체크(`text-primary`), rejected·chain-switch-failed·send-failed·reverted `CircleAlertIcon`·`text-error`, receipt-failed·replaced `InfoIcon`·`text-warning`, 잔액 안내 `text-warning`. 닫기 접근성 이름 `닫기`. 오케스트레이터 확인: 수정 범위 일치, 새 testid 네 개뿐, `lint`·`build` exit 0, `test __tests__/swap` 18 파일 통과·5 skipped, 146 passed·37 todo(F5 EC-2 통과)

### T-5 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 세 체인 탐색기 tx URL을 검증한다
- 선행: T-2
- 연결 항목: DoD-6
- 수정 대상: `__tests__/lib/tx-explorer.test.ts` — 신규
- 따라야 할 패턴: config 값 리터럴 대조 — 근거: `__tests__/config/chains.test.ts`, `__tests__/config/swap-router.test.ts`
- 완료 조건: 연결 항목 판정. 기대 URL은 스펙 리터럴로 두고 제품 상수를 쓰지 않는다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib`
- 수정 금지: 제품 코드, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/lib/tx-explorer.test.ts`(1 case, 세 체인 스펙 리터럴 대조). 수정 0/3. 오케스트레이터 확인: 골자 동결 유지(`8a07e4e0f647896f`), `bun run test __tests__/lib` 9 파일 53/53 통과
- 테스트 파일·runner: `__tests__/lib/tx-explorer.test.ts`, Vitest jsdom
- mock 허용 경계: 없음(순수 함수와 정적 config만). 테스트 설계 단계에서 사용자 확정
- 데이터 격리: 정적 데이터만 사용

### T-6 — 통합 테스트: 교체·가속과 교체 주입 스텁

- 사이드: 테스트
- 상태: 완료
- 목적: 교체 주입 스텁을 추가만 하고, 같은 위임에서 교체·가속·미감지 case를 검증한다
- 선행: T-4
- 연결 항목: EC-9, EC-10, EC-11, EC-12, EC-13, EC-29
- 수정 대상: `__tests__/support/rpc-balance-stub.ts` — 추가만, 해시별 트랜잭션 필드 응답, 지정 블록 이후 블록 트랜잭션 목록에 대체 tx 싣기, 대체 해시 영수증, 사유별 필드 보조 함수. `__tests__/swap/tx-status-replacement.test.tsx` — 신규
- 따라야 할 패턴: F5 T-7 추가 방식(기존 분류·export·기본 응답 불변), `renderAppHook` probe, `stubTransactionHash` — 근거: `__tests__/support/rpc-balance-stub.ts:555-632,816-870`, `docs/plans/approve-swap.md:115-128`
- 완료 조건: 연결 항목 판정. EC-9는 cancelled·replaced 두 사유 표본이고 결과 해시가 원 해시와 다르다. EC-12는 success·reverted 두 표본. EC-13은 대체가 드러나기 전 링크를 관찰한다. EC-29는 원 tx 조회가 처음부터 not found인 표본이다. 기본 응답(빈 블록 트랜잭션, 고정 pending tx)을 쓰는 기존 F5 통합 테스트가 그대로 통과한다 — 검증: 테스트
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap/tx-status-replacement.test.tsx __tests__/swap/swap-execution-failure.test.tsx __tests__/swap/swap-execution-progress.test.tsx`
- 수정 금지: 제품 코드, 기존 테스트 파일, `__tests__/support/stub-eip1193.ts`, `__tests__/support/wagmi-harness.tsx`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/support/rpc-balance-stub.ts`(추가 157줄, `eth_getBlockByNumber`의 `transactions: []` 한 줄을 실린 트랜잭션 목록으로 교체 — 없으면 `[]` 그대로), `__tests__/swap/tx-status-replacement.test.tsx`(5 case). 수정 0/3. 추가 지원 API: `StubTransaction`, `setTransactionFields`, `addBlockTransaction(chainId, tx, fromBlock)`, `stubTransaction`, `stubReplacementHash`, `stubReplacementTransaction(reason, original, hash)`, `STUB_REPLACED_TO`, `receiptRuleByHash`. 본문 판단: 원 tx 필드는 스텁 지갑이 받은 요청에서, nonce 7. EC-13은 원 tx 첫 조회만 pending·이후 not-found, 새 tx는 현재 블록+1,000,000부터 실어 20초 관찰. EC-29는 31분 진행, 클릭 뒤 `eth_getTransactionCount` 0건. 긴 case 시간 한도 240초. 오케스트레이터 확인: 골자 동결 유지, `typecheck`·`lint` exit 0, `test tx-status-replacement·swap-execution-failure·swap-execution-progress` 3 파일 23/23 통과(82초)
- 테스트 파일·runner: `__tests__/swap/tx-status-replacement.test.tsx`(지원 모듈 `__tests__/support/rpc-balance-stub.ts`), Vitest jsdom
- mock 허용 경계: 후보는 F5 T-10 경계에 교체 주입(트랜잭션 필드, 블록 트랜잭션 목록, 대체 영수증)과 viem 폴링을 진행시킬 가짜 타이머를 더하는 것. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: 테스트마다 config·스텁·QueryClient 새로 생성, `clearCookies`

### T-7 — 통합 테스트: 메시지 영역과 pending

- 사이드: 테스트
- 상태: 완료
- 목적: 영역의 상시 마운트, pending 표시와 링크, 진행 중 변경·해제를 검증한다
- 선행: T-6
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, EC-14, EC-21, EC-24, EC-26
- 수정 대상: `__tests__/swap/tx-status-pending.test.tsx` — 신규
- 따라야 할 패턴: 커밋 기록, `holdReceipt`, `advanceFakeClockInSteps`, `changeAccounts`, `disconnect(config)`, `chooseChainFromDropdown` — 근거: `__tests__/support/wagmi-harness.tsx:189-221,298,321`, `__tests__/swap/swap-execution-progress.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-1은 연결 전·후·진행 중 같은 요소다. DoD-4는 Ethereum 외 체인 표본을 포함하고 href 기대값은 리터럴이다. EC-14는 F5 EC-18 표본 길이 이상 진행한다. EC-21은 금액·토큰·선택 체인 세 변경. EC-24는 해제·계정 변경 × approving·swapping이고 응답을 푼 뒤에도 결과가 없다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/tx-status-pending.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/tx-status-pending.test.tsx`(7 case). 수정 0/3. 본문 판단: DoD-1은 연결 전 노드와 같은 노드·`queryAllByRole("alert")` 0개·`compareDocumentPosition` FOLLOWING, EC-14 31분, EC-24 되돌림·재연결 표본 포함. 오케스트레이터 확인: 골자 동결 유지, T-7·T-8 합동 실행에서 T-7 7/7 통과
- 테스트 파일·runner: `__tests__/swap/tx-status-pending.test.tsx`, Vitest jsdom
- mock 허용 경계: 후보는 F5 T-10 경계 그대로. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: T-6과 같음

### T-8 — 통합 테스트: 성공과 잔액 감소 안내

- 사이드: 테스트
- 상태: 완료
- 목적: 성공 결과, 링크, approve 성공 뒤 대기와 잔액 감소 판정을 검증한다
- 선행: T-6
- 연결 항목: DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-12, EC-15, EC-16, EC-17
- 수정 대상: `__tests__/swap/tx-status-success.test.tsx` — 신규
- 따라야 할 패턴: 잔액 값 바꾸기·붙잡기·실패, allowance 규칙, probe — 근거: `__tests__/swap/approve-execute.test.tsx`, `__tests__/swap/swap-execution-progress.test.tsx:446-500`
- 완료 조건: 연결 항목 판정. DoD-7·8은 result 객체 전체를 리터럴과 비교한다. DoD-10은 allowance·잔액 다시 읽기 중 하나만 붙잡은 표본 각각과 둘 다 풀린 뒤 같은 커밋을 본다. DoD-11은 영수증 뒤 새로 생긴 잔액 요청의 응답으로 판정한다. DoD-12는 같은 값·큰 값 두 표본. EC-17은 Ethereum USDT `approve(0)` 표본 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/tx-status-success.test.tsx`
- 수정 금지: T-7과 같음
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/tx-status-success.test.tsx`(7 case). 수정 1/3 — 원인: DoD-10 "하나만 붙잡기" case의 전제 확인이 영수증 요청을 붙잡은 뒤 잡은 `seq` 이후 범위에서 영수증 ok를 찾아 실패(본문 요청 범위 결함, 제품은 영수증 성공 처리). 같은 에이전트가 영수증 성공 전제의 범위를 지갑 해시의 영수증 조회 전체로 고침(판정 불변), 다른 case의 같은 패턴 점검 결과 없음. 오케스트레이터 확인: 골자 동결 유지, 첫 실행 7 중 6 통과 → 수정 뒤 7/7 통과
- 테스트 파일·runner: `__tests__/swap/tx-status-success.test.tsx`, Vitest jsdom
- mock 허용 경계: 후보는 F5 T-9 경계에 잔액 값 바꾸기·붙잡기·실패를 더하는 것. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: T-6과 같음

### T-9 — 통합 테스트: 전송 전·후 실패

- 사이드: 테스트
- 상태: 완료
- 목적: 단계별 오류 분류와 실패 결과의 링크 유무를 검증한다
- 선행: T-6
- 연결 항목: EC-1, EC-2, EC-3, EC-4, EC-5, EC-6, EC-7, EC-8
- 수정 대상: `__tests__/swap/tx-status-failure.test.tsx` — 신규. `__tests__/support/stub-eip1193.ts` — 추가만, 지갑 오류 응답에 원인(cause) 싣기(살 모드에서 이 Task 본문보다 먼저)
- 따라야 할 패턴: 지갑 전송·체인 전환 응답 제어, 영수증 대기 reject 유도(영수증 미발견 + 조회 지속 실패, 가짜 타이머) — 근거: `__tests__/support/stub-eip1193.ts:237-378`, `__tests__/swap/swap-execution-failure.test.tsx:237-240`
- 완료 조건: 연결 항목 판정. EC-1은 approve·swap 두 표본. EC-3은 4001·4902가 아닌 code. EC-4는 -32000·-32603 두 표본과 같은 code에 메시지만 다른 표본. EC-6은 체인 전환을 붙잡은 동안 드롭다운을 바꾼다. EC-7·8은 링크가 tx 체인 탐색기와 원 해시다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/tx-status-failure.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/stub-eip1193.ts`의 기존 export·동작, 그 밖의 `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/support/stub-eip1193.ts`(`WalletReply` error에 선택 필드 `cause` 추가, 있으면 오류에 싣기 — 기존 동작 불변), `__tests__/swap/tx-status-failure.test.tsx`(7 case). 수정 0/3. 본문 판단: EC-1 표본 4001·5000·최상위 -32603 + cause 4001 × approve·swap, EC-4 표본 -32000·-32603·각 code에 "User rejected the request." 문구 × approve·swap, EC-3 전환 오류 -32603, -32000의 `wallet_sendTransaction` 재시도는 기존 스텁 -32601로 원 오류 유지(해시 0건 전제 확인). 오케스트레이터 확인: 골자 동결 유지, `test tx-status-failure` 7/7 통과
- 테스트 파일·runner: `__tests__/swap/tx-status-failure.test.tsx`, Vitest jsdom
- mock 허용 경계: (사용자 확정) F5 T-10 경계 그대로에 스텁 지갑 오류 응답의 원인(cause) 주입을 더한다. EC-1 표본에 code 5000과 최상위 -32603 + 원인 4001 포함
- 데이터 격리: T-6과 같음

### T-10 — 통합 테스트: 메시지 수명과 동시성

- 사이드: 테스트
- 상태: 완료
- 목적: 닫기, 입력 변경, 새 실행, 시간, 진행 중 변경, 체인 차이, 계정 변경에 따른 결과 수명을 검증한다
- 선행: T-6
- 연결 항목: DoD-13, DoD-14, DoD-15, EC-18, EC-19, EC-20, EC-22, EC-23, EC-25, EC-27, EC-28
- 수정 대상: `__tests__/swap/tx-status-lifetime.test.tsx` — 신규
- 따라야 할 패턴: 실제 UI 조작(금액 입력, 모달 토큰 선택, 뒤집기, `최대`, 드롭다운, 슬리피지 팝오버) — 근거: `__tests__/swap/slippage-state.test.tsx`, `__tests__/swap/swap-execution-progress.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-14는 다섯 조작을 하나씩 표본으로 한다. DoD-15는 approve 결과 뒤 swap 클릭과 rejected 뒤 재클릭. EC-23은 진행 중 선택 체인을 바꾼 뒤 결과와 tx 체인 href. EC-27은 네 조작 각각. EC-28은 `renderAppHook`으로 상태 밖 호출 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/tx-status-lifetime.test.tsx`
- 수정 금지: T-7과 같음
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/tx-status-lifetime.test.tsx`(11 case). 수정 0/3. 본문 판단: DoD-14 조작 6개(금액, 보내는 칸 WETH, 받는 칸 USDT, 뒤집기, `최대`, 드롭다운 Base), EC-27 형식 검사 표본 `1.1234567`, EC-25 재연결은 `connect(config, { connector })`, EC-20 31분 진행. 알려진 한계(작성자 보고): 제품이 앱 금액 비우기를 결과 기록 전에 하므로 EC-18 case는 "앱 비우기를 사용자 변경으로 세는" 틀린 구현을 잡지 못한다 — 7단계 코드 대조에서 `clearAmountInput`이 변경 횟수를 올리지 않는지 확인. 오케스트레이터 확인: 골자 동결 유지, `test tx-status-lifetime` 11/11 통과
- 테스트 파일·runner: `__tests__/swap/tx-status-lifetime.test.tsx`, Vitest jsdom
- mock 허용 경계: 후보는 F5 T-10 경계와 가짜 시계. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: T-6과 같음

### T-11 — F5 회귀 갱신

- 사이드: 테스트
- 상태: 완료
- 목적: F5 EC-2의 메시지 판정을 F6 결과로 바꾸고, F5 계약 변경이 기존 테스트에 영향 없음을 확인한다
- 선행: T-7, T-8, T-9, T-10
- 연결 항목: EC-1
- 수정 대상: `__tests__/swap/swap-execution-failure.test.tsx` — F5 EC-2 case의 `@then`·it 이름·assertion. `e2e/approve-swap.spec.ts` — F5 EC-2 test의 `@then`·이름·판정
- 따라야 할 패턴: 동결 골격은 assertion만 바꾸고 사용자 결정이 있을 때만 `@then`과 이름을 바꾼 뒤 골자 digest를 기록 — 근거: `docs/plans/approve-swap.md:208-212,337`
- 완료 조건: 연결 항목 충족. 바꿀 `@then` 문구는 테스트 설계 단계에서 사용자 결정. F5 골자 digest `a169e441a57a3a96`의 변경 전후를 기록하고 F2 `12a88df2f0bb1e2a`·F3 `8acf896e2a4dffdd`·F4 `3af643e844b77259`는 유지. F5 DoD-25·DoD-30·EC-5·EC-8·EC-10, F2 balances EC-12, F5 E2E DoD-26이 무수정으로 통과함을 전체 실행으로 확인해 기록하고, 실패하면 파일을 추가하기 전에 결정으로 되돌린다. jsdom 전체 3회 결과가 같다 — 검증: 명령
- 실행 명령: `bun run test`(3회), `bun run test:e2e e2e/approve-swap.spec.ts e2e/wallet.spec.ts e2e/swap-form.spec.ts e2e/quote.spec.ts e2e/slippage.spec.ts`
- 수정 금지: 제품 코드, F6 신규 테스트, `__tests__/support/*`, `e2e/support/*`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: Vitest 부분 seongho:test-dev(새 인스턴스 — 세션이 바뀌어 기존 작성 에이전트 재개 불가), E2E 부분 seongho:e2e-dev(새 인스턴스, 같은 사유). 작성 영역 `__tests__/swap/swap-execution-failure.test.tsx`(F5 EC-2 메시지 `@then` 삭제, it 이름에서 메시지 조항 삭제, role 메시지 판정과 `messageElements` 삭제), `e2e/approve-swap.spec.ts`(F5 EC-2 메시지 `@then` 삭제, role 관찰 판정과 쓰지 않는 import 삭제, `e2e/support/*` 헬퍼는 유지). 수정 0/3. 오케스트레이터 확인: F5 골자 digest `a169e441a57a3a96` → `74b2bc4d3dfcc0aa`(F5 EC-2 `@then` 삭제만, F5 동결 확인 명령의 `--frozen` 값을 이 값으로 읽는다). F2 `12a88df2f0bb1e2a`·F3 `8acf896e2a4dffdd`·F4 `3af643e844b77259` 유지 확인. `bun run test` 3회 모두 40 파일 281/281 통과(F5 DoD-25·DoD-30·EC-5·EC-8·EC-10, F2 balances EC-12 무수정 통과). `bun run test:e2e` F1~F5 5 spec 21/21 통과(1 worker, F5 DoD-26·EC-2 포함)
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom과 Playwright chromium
- mock 허용 경계: F5에서 확정한 경계 그대로. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: F5와 같음
- 실행 환경: T-12와 같음. 다른 E2E 실행·`check:build`와 겹치지 않게 한다

### T-12 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 실제 브라우저·프록시·anvil에서 approve·swap 성공 메시지와 링크, 거부, 전송 실패를 검증한다
- 선행: T-1, T-11
- 연결 항목: DoD-7, DoD-8, DoD-9, EC-1, EC-4
- 수정 대상: `e2e/tx-status.spec.ts` — 신규. `e2e/support/tx-status.ts` — 신규, locator와 -32000 오류 주입 헬퍼. `e2e/support/anvil.ts` — 추가만, 체결 해시 조회(T-1 결과에 따름)
- 따라야 할 패턴: `enterErc20Swap`, `rejectWalletTransactions`, 테스트마다 snapshot/revert, `beforeAll` 예열 — 근거: `e2e/approve-swap.spec.ts:78-102`, `e2e/support/approve-swap.ts`, `e2e/support/anvil.ts:179-205`
- 완료 조건: 연결 항목 판정. 링크 기대값은 러너가 anvil에서 얻은 체결 해시로 만들고 화면 값을 기대값으로 쓰지 않는다. EC-1은 기존 제어값, EC-4는 기존 제어값에 Error 객체 주입이며 두 경우 anvil 상태가 그대로다. 제품 코드(`config/e2e-mock.ts` 포함)를 바꾸지 않는다. E2E 전체 통과 — 검증: 테스트, 명령
- 실행 명령: `bun run test:e2e e2e/tx-status.spec.ts`, `bun run test:e2e`
- 수정 금지: 제품 코드, 기존 `e2e/*.spec.ts`, `e2e/support/app.ts`, `e2e/support/approve-swap.ts`, 채굴 제어, `page.route`, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:e2e-dev(새 인스턴스, 살 모드 — 골격 작성 에이전트는 세션 변경으로 재개 불가), 작성 영역 `e2e/tx-status.spec.ts`(3 case), `e2e/support/tx-status.ts`(신규: `txStatus`, `txLink`, `expectTxStatus`, `etherscanTxUrl`, `failWalletTransactionsWith`), `e2e/support/anvil.ts`(추가 29줄: `readAccountNonce`, `readTransactionHashBySenderAndNonce`). 수정 0/3. 본문 판단: 체결 해시는 snapshot 뒤 클릭 전 nonce n을 읽고 `eth_getTransactionBySenderAndNonce`로 조회(approve n, swap n+1, swap 클릭 직전 nonce n+1 전제 확인), EC-1·EC-4는 전송 요청 수가 클릭 전보다 커질 때까지 대기(-32000은 2건), EC-4 오류 문구 `insufficient funds for gas * price + value`. 오케스트레이터 확인: 골자 동결 유지, `test:e2e e2e/tx-status.spec.ts` 3/3 통과(DoD-7·8·9 19.9s), E2E 전체는 T-13에서 29/29
- 테스트 파일·runner: `e2e/tx-status.spec.ts`, Playwright chromium
- mock 허용 경계: 후보는 F5 T-13 경계에 기존 제어값의 Error 객체 주입과 러너→anvil 해시 조회를 더하는 것. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: 테스트별 브라우저 컨텍스트, 쓰기 테스트마다 snapshot/revert, 절대값 주입, `workers: 1`
- 실행 환경: 앱 `localhost:3100`(`NEXT_PUBLIC_E2E_MOCK=1` 빌드), anvil `localhost:8546`(`--block-time 1`), 포크 블록과 mock 계정은 `config/e2e.ts`·`config/e2e-mock.ts` 상수, 로그인 없음, Ethereum만. `check:build`와 동시에 실행하지 않는다

### T-13 — 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 전체 정합성 명령을 순차로 통과시킨다
- 선행: T-5, T-11, T-12
- 연결 항목: DoD-1, DoD-6
- 수정 대상: 없음. 결과는 이 계획의 구현 기록에 남긴다
- 따라야 할 패턴: F5 T-14 순차 실행 — 근거: `docs/plans/approve-swap.md:301-310`
- 완료 조건: 명령을 하나씩 실행해 전부 통과한다. `check:build`는 `test:e2e`가 끝난 뒤 단독으로 실행한다 — 검증: 명령
- 실행 명령: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: 오케스트레이터(명령 실행·기록, 제품·테스트 수정 없음). 2026-11-19. 순차 실행: `format:check` 통과, `lint` 통과, `typecheck` 통과, `test` 40 파일 281/281, `build` 통과, `test:fork` 13/13, `test:e2e` 29/29(1 worker, F1~F5 26 + F6 3), `check:build` 통과(`test:e2e` 종료 뒤 단독 실행, mock 표식 양성 대조 포함)

## 3. 항목 coverage

- DoD-1: T-4, T-7, T-13
- DoD-2: T-4, T-7
- DoD-3: T-4, T-7
- DoD-4: T-2, T-4, T-7
- DoD-5: T-4, T-7
- DoD-6: T-2, T-5, T-13
- DoD-7: T-3, T-4, T-8, T-12
- DoD-8: T-3, T-4, T-8, T-12
- DoD-9: T-1, T-2, T-3, T-4, T-8, T-12
- DoD-10: T-3, T-8
- DoD-11: T-2, T-3, T-4, T-8
- DoD-12: T-2, T-3, T-4, T-8
- DoD-13: T-3, T-4, T-10
- DoD-14: T-3, T-10
- DoD-15: T-3, T-10
- EC-1: T-1, T-2, T-3, T-9, T-11, T-12
- EC-2: T-2, T-3, T-9
- EC-3: T-2, T-3, T-9
- EC-4: T-1, T-2, T-3, T-9, T-12
- EC-5: T-4, T-9
- EC-6: T-3, T-9
- EC-7: T-2, T-3, T-4, T-9
- EC-8: T-2, T-3, T-4, T-9
- EC-9: T-1, T-2, T-3, T-4, T-6
- EC-10: T-2, T-3, T-6
- EC-11: T-3, T-6
- EC-12: T-2, T-3, T-6
- EC-13: T-3, T-4, T-6
- EC-14: T-4, T-7
- EC-15: T-2, T-3, T-8
- EC-16: T-2, T-3, T-8
- EC-17: T-3, T-8
- EC-18: T-3, T-10
- EC-19: T-3, T-10
- EC-20: T-3, T-10
- EC-21: T-4, T-7
- EC-22: T-3, T-10
- EC-23: T-3, T-4, T-10
- EC-24: T-3, T-4, T-7
- EC-25: T-3, T-10
- EC-26: T-4, T-7
- EC-27: T-3, T-10
- EC-28: T-3, T-10
- EC-29: T-1, T-3, T-4, T-6

## 4. 실행 순서

- 1구간(병렬): T-1(저장소 수정 없음, anvil 8555) / T-2(`lib/tx-explorer.ts`, `lib/tx-result.ts`)
- 2구간(병렬): T-3(`providers/swap-execution-provider.tsx`, `providers/swap-form-provider.tsx`, `hooks/use-token-balance.ts`) / T-5(`__tests__/lib/tx-explorer.test.ts`)
- 3구간(순차): T-4(`components/tx-status.tsx`, `components/swap-card.tsx`)
- 4구간(순차): T-6(`__tests__/support/rpc-balance-stub.ts`, `__tests__/swap/tx-status-replacement.test.tsx`). 공용 지원 모듈을 바꾸므로 단독으로 실행한다
- 5구간(병렬): T-7 / T-8 / T-9 / T-10. 각자 신규 파일 하나만 고치고 `__tests__/support/*`는 고치지 않는다
- 6구간(순차): T-11
- 7구간(순차): T-12(포트 3100·8546 독점)
- 8구간(순차): T-13
- 테스트 설계(골격 동결)는 구현 전에 T-5~T-12 골격을 먼저 고정한다
- 사용자 확정(2026-11-18): T-3의 `providers/swap-form-provider.tsx` 추가 변경 허용, approve 성공 뒤 잔액 쿼리가 비활성이어도 tx 체인 클라이언트로 읽기, 상태별 색·아이콘은 기존 토큰 범위의 구현 재량

## 5. 차단 사항

- 없음

## 테스트 설계 증거

- 상태: 예외 동결 (reviewer 3라운드 후 자동 반복 한도 도달. 3라운드 NEEDS-FIX 5건(Med 3·Low 2, 결정 없음) 반영분은 독립 재검토 없이 기계 검사만 통과, 사용자 확정 2026-11-18)
- 기준 스펙: `docs/specs/tx-status.md` (확정, 2026-11-18 갱신본: 계획 단계 공백 S-1~S-3 반영으로 DoD-14·15 보완과 EC-27·28·29 추가, 테스트 설계 단계 D-1 반영으로 §4.2 링크 체인·해시 규칙 추가)
- 골자 digest: `8a07e4e0f647896f`
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/tx-status.md --files __tests__/lib/tx-explorer.test.ts __tests__/swap/tx-status-replacement.test.tsx __tests__/swap/tx-status-pending.test.tsx __tests__/swap/tx-status-success.test.tsx __tests__/swap/tx-status-failure.test.tsx __tests__/swap/tx-status-lifetime.test.tsx e2e/tx-status.spec.ts --frozen 8a07e4e0f647896f`
- 골격 파일: `__tests__/lib/tx-explorer.test.ts`(T-5, 1 case), `__tests__/swap/tx-status-replacement.test.tsx`(T-6, 5), `__tests__/swap/tx-status-pending.test.tsx`(T-7, 7), `__tests__/swap/tx-status-success.test.tsx`(T-8, 7), `__tests__/swap/tx-status-failure.test.tsx`(T-9, 7), `__tests__/swap/tx-status-lifetime.test.tsx`(T-10, 11), `e2e/tx-status.spec.ts`(T-12, 3). T-11은 F6 골격 파일이 없다(F5 파일의 `@then` 삭제)
- 기계 검사: 통과. 항목 44개 중 case 연결 44개, 제외 0개, case 41개(단위 1, 통합 37, E2E 3). 전부 `it.todo`/`test.fixme`. 포맷·린트 통과
- 작성 에이전트: seongho:test-dev 4개(T-5·T-9 / T-6 / T-7·T-8 / T-10), seongho:e2e-dev 1개(T-12). 살 모드는 같은 에이전트가 이어서 맡는다
- reviewer 라운드: 3회(매번 새 `general-purpose`, 매 라운드 "서술 취향은 관찰로만"·"새 case 요구에는 틀린 구현 예" 지시, 검토 전후 md5 동일 확인)
  - 1라운드 NEEDS-DECISION(High 1·Med 6·Low 7, 결정 3): 결과 상태의 role 미확인, EC-11 대체 영수증 status, pending 링크·잔액 다시 읽기의 체인 기준, EC-4 문구 표본, DoD-14 받는 칸, EC-25 되돌림, EC-5·10·13·17 중복 병합. 결정 D-1~D-3
  - 2라운드 NEEDS-DECISION(Med 2·Low 3, 결정 1): 클릭 시점 대 캐시 기준, EC-24 되돌림, DoD-2 닫은 뒤, DoD-1 표본 순서, E2E EC-1 중복. 결정 D1
  - 3라운드 NEEDS-FIX(Med 3·Low 2): DoD-11 진행 중 토큰 변경, EC-16 캐시 표본, EC-12 결과 리터럴, DoD-7·8·9 병합, EC-9·10·11 병합. 반영 후 예외 동결
- 제외 (사용자 확정): ID 단위 제외 없음. EC-29의 "RPC 프록시 허용 메서드 변경 없음" 조항만 테스트 대신 7단계 코드 대조(`config/rpc.ts` 무변경)로 검증(D-3)
- mock 경계 (사용자 확정): 각 테스트 Task의 `mock 허용 경계` 참조. T-5 없음, T-7·T-10 F5 T-10 경계, T-8 F5 T-9 경계 + 잔액 값 바꾸기·붙잡기·실패, T-6 + 교체 주입(트랜잭션 필드·블록 트랜잭션 목록·대체 영수증)과 가짜 타이머, T-9 + 스텁 지갑 오류 응답의 원인(cause) 주입(D1, `__tests__/support/stub-eip1193.ts` 추가만), T-12 F5 T-13 경계 + 기존 `sendTransactionError`의 Error 객체 주입과 러너→anvil 해시 조회(제품 코드 무변경)
- 해석 결정 (사용자 확정): EC-1 표본에 code 5000과 최상위 -32603 + 원인 4001 포함. D-1 링크 체인·해시는 스펙 §4.2(pending은 pendingTx, 결과는 result). D-2 E2E 체결 해시는 러너가 클릭 전 mock 계정 nonce를 읽고 스냅샷 이후 블록에서 (계정, nonce) tx를 찾는다(`*_getTransactionBySenderAndNonce` 대체 가능, T-1 확인). "입력 변경"은 값이 실제로 바뀐 사용자 조작만, "새로 누르면"은 실행을 시작한 호출만. 결과를 지우거나 유지하는 항목은 `result` 판정만(화면은 DoD-13·DoD-2가 본다). E2E EC-1의 anvil 상태 불변은 F5 E2E EC-2와 같은 판정이라 본문 전제 확인으로 둔다
- F5 회귀 (사용자 확정, T-11에서 수행): F5 EC-2의 메시지 `@then`(통합 `__tests__/swap/swap-execution-failure.test.tsx`, E2E `e2e/approve-swap.spec.ts`)을 삭제한다. 거부 메시지는 F6 EC-1이 맡는다. F5 골자 digest `a169e441a57a3a96` → `74b2bc4d3dfcc0aa`(T-11 수행, F5 동결 확인 명령의 `--frozen` 값을 이 값으로 읽는다). F2 `12a88df2f0bb1e2a`·F3 `8acf896e2a4dffdd`·F4 `3af643e844b77259`는 유지
- 미검증 (경계의 한계): 실제 지갑(MetaMask·EIP-7702 스마트 계정)의 오류 형태(4001·cause 체인·-32000·체인 전환 실패)는 스텁으로만 증명. 실제 노드의 교체·가속 탐지는 스텁 블록 응답으로만 증명. revert·확인 실패·교체의 실제 브라우저 흐름은 비목표(통합만). Base·Arbitrum 링크는 통합으로만(E2E는 Ethereum 포크). 메인넷 수동 확인 없음(비목표). 3라운드 반영분 5건은 독립 재검토를 받지 않았다
- 7단계 코드 대조 항목: §4.2 `tx-link`의 `target`·`rel`, §4.3 `none`일 때 `data-kind` 없음과 하위 요소 role `alert` 없음, 모든 결과 상태의 닫기 버튼(§1.1), `balanceDropped`는 approve 성공 결과에만(§4.1), 메시지 영역이 카드 안 주 버튼 바로 다음, 결과에 시간 기반 소멸 없음, `config/rpc.ts`·explorer config 신설 없음, 전송 전 nonce 조회·`replacement` 인자 없음, phase 집합·`pendingTx` 의미 불변, `approve`·`swap` reject 없음, `docs/specs/approve-swap.md` 무변경
- 본문 작성 주의: T-6이 `__tests__/support/rpc-balance-stub.ts`(추가만)를, T-9가 `__tests__/support/stub-eip1193.ts`(추가만)를 각 Task 본문보다 먼저 확장한다. T-12의 해시 조회 방법과 -32000 Error 형태는 T-1 결과를 따른다. viem은 -32000에 `wallet_sendTransaction`으로 재시도하므로 스텁·E2E 제어값이 두 메서드에 같은 오류를 준다. DoD-10 커밋 기록은 영수증을 푸는 시점부터 센다. `vitest list --json` 등 파일을 쓰는 옵션 금지. `check:build`와 `test:e2e`는 동시에 실행하지 않는다

### 검증 기록

- 코드 기준: `7df1342` + 커밋 전 작업 트리(2026-11-19). 세 검증 모두 실행 전후 작업 트리 동일(오케스트레이터 스냅샷 비교: `git status --porcelain`·`git diff` 해시·미추적 파일 해시, 각 실행 에이전트 `git status` 비교). 검증 중 파일 변경 없음
- 스펙 대조(새 general-purpose + `seongho:verify`, 실행 없음): 44개 항목 코드 대조 충족 44·부분 0·미충족 0·검증 불가 0. 스코프 초과 0, 스펙 드리프트 0, 제품 결함 0. F6 골자 `8a07e4e0f647896f` 유지, F5 골자 `74b2bc4d3dfcc0aa` 유지, todo·fixme·skip·only 0건. 7단계 코드 대조 항목 13개 모두 맞음(`clearAmountInput`이 변경 횟수를 올리지 않음 포함)
- 테스트 실행(`seongho:test-runner`): `format:check`·`lint`·`typecheck`·`build`·`check:build` 통과, Task별 Vitest(T-5 53/53, T-6 23/23, T-7 7/7, T-8 7/7, T-9 7/7, T-10 11/11), `bun run test` 3회 모두 40 파일 281/281, `test:fork` 13/13, todo·skip·fixme 0
- E2E 실행(`seongho:e2e-runner`): `test:e2e e2e/tx-status.spec.ts` 3/3(S1 DoD-7·8·9, S2 EC-1, S3 EC-4), `test:e2e` 전체 29/29(1 worker, 재시도 0, flaky 0)

| 스펙 항목               | 코드 대조 | 실행 확인 (근거 case)                                                                                                                                          | 종합 |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| DoD-1                   | 충족      | 확인됨 (`tx-status-pending` DoD-1. "바로 다음"은 코드 대조 `swap-card.tsx:29-30`, 테스트는 "뒤에 있다"만)                                                      | 충족 |
| DoD-2·3·4·5             | 충족      | 확인됨 (`tx-status-pending` DoD-2, DoD-3·4·5, EC-21+DoD-4, EC-24·26+DoD-2, `tx-status-lifetime` DoD-13+DoD-2)                                                  | 충족 |
| DoD-6                   | 충족      | 확인됨 (`tx-explorer` DoD-6)                                                                                                                                   | 충족 |
| DoD-7·8·9               | 충족      | 확인됨 (`tx-status-success` DoD-7·8·9, E2E S1)                                                                                                                 | 충족 |
| DoD-10·11·12            | 충족      | 확인됨 (`tx-status-success` DoD-10×2, DoD-11+EC-17, DoD-12+EC-17)                                                                                              | 충족 |
| DoD-13·14·15            | 충족      | 확인됨 (`tx-status-lifetime` DoD-13+DoD-2, DoD-14, DoD-15)                                                                                                     | 충족 |
| EC-1·2·3·4·5            | 충족      | 확인됨 (`tx-status-failure` EC-1~4+EC-5, E2E S2·S3)                                                                                                            | 충족 |
| EC-6·7·8                | 충족      | 확인됨 (`tx-status-failure` EC-6·7·8)                                                                                                                          | 충족 |
| EC-9·10·11·12·13        | 충족      | 확인됨 (`tx-status-replacement` EC-9·10·11, EC-12×2, EC-13)                                                                                                    | 충족 |
| EC-14                   | 충족      | 확인됨 (`tx-status-pending` EC-14, 31분)                                                                                                                       | 충족 |
| EC-15·16·17             | 충족      | 확인됨 (`tx-status-success` EC-15, EC-16, DoD-11·12의 USDT approve(0) 표본)                                                                                    | 충족 |
| EC-18                   | 충족      | 확인됨 (`tx-status-lifetime` EC-18. 판정력 한계: 제품이 금액을 결과 기록 전에 비워 "앱 비우기를 사용자 변경으로 세는" 구현을 구분하지 못함 — 코드 대조로 보완) | 충족 |
| EC-19·20·22·23·25·27·28 | 충족      | 확인됨 (`tx-status-lifetime` 각 case)                                                                                                                          | 충족 |
| EC-21·24·26             | 충족      | 확인됨 (`tx-status-pending` 각 case)                                                                                                                           | 충족 |
| EC-29                   | 충족      | 확인됨 (`tx-status-replacement` EC-29, nonce 조회 0건). 프록시 허용 메서드 불변은 D-3대로 코드 대조(`config/` diff 없음)                                       | 충족 |

- 미검증(경계의 한계, 스펙 비목표): 실제 지갑(MetaMask·EIP-7702 스마트 계정)의 오류 형태와 실제 노드의 교체·가속 탐지는 스텁·T-1 기록으로만 증명. Base·Arbitrum 링크의 실제 브라우저 흐름 없음(통합만)
- verify가 보고한 스펙 모호(Low, 제품 결함 아님): (1) injected 커넥터에서 체인 전환 5000은 `chain-switch-failed`, 4902 뒤 체인 추가 실패는 원인과 무관하게 `rejected`(EC-2·3이 code 기준인지 의미 기준인지 미정, 구현은 code 문구 그대로) (2) `awaiting-signature` 중 선택 체인을 바꾼 뒤 체인 전환이 거부·실패하면 결과가 기록된다(EC-6은 이 순서를 정하지 않음)
- 위생 메모: `e2e/support/approve-swap.ts`의 `roleMessages`·`startRoleMessageObserver`·`readObservedRoleMessages`는 이제 쓰이지 않는다(T-11 수정 금지 범위라 유지)
