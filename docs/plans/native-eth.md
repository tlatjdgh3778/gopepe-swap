# 계획: native-eth

- 상태: 승인
- 스펙: docs/specs/native-eth.md
- 기준 코드: ec1a894 + 작업 트리
- 최종 갱신: 2026-11-20

## 1. 구현 전략

- 순서는 사전 확인, config·lib 순수 함수, provider, 컴포넌트, 테스트(단위, 통합, 포크), 이전 기능 회귀 갱신(기능별), E2E, 전체 검사다. 근거: `docs/plans/tx-status.md:10`, `docs/plans/approve-swap.md:10`
- 견적 `wrap`은 순수 함수 `planSwapQuote`가 ETH↔WETH에서 `no-route` 대신 돌려준다. 상태 타입은 스펙 §4.2 유니언을 따르고 `isEthWethPair` export는 유지한다. provider는 이미 ETH↔WETH에서 서명·반영 대기 없이 정해지므로 분기만 더하고, 상태 객체는 `amountOut` 기준으로 메모해 참조를 안정시킨다. 슬리피지 provider는 참조하지 않는다. 근거: `lib/swap-quote.ts:24,34-36,142-145,174`, `providers/swap-quote-provider.tsx:13-14,86-89,100`
- `lib/swap-input-state.ts:67-98`의 `getSwapButtonState`·`QUOTE_BUTTON_STATES`는 제품·테스트 어디서도 import하지 않는다. `wrap` 상태를 더하면 typecheck가 깨지고 `quote-ready`를 남기므로 삭제한다. `getSwapInputState`·`isSwapInputIdle`은 바꾸지 않는다. 근거: grep 결과 import 0건
- 주 버튼 판정은 `lib/primary-button-state.ts`에서 상태 목록을 21개로 바꾸고, 판정 입력 `isEthPair`를 보내는 토큰이 ETH인지로 바꾼다. 원천 입력 형태 `PrimaryButtonSourceParams`는 유지한다. 근거: `lib/primary-button-state.ts:10-29,37,49,87-114,131-142`, `__tests__/lib/primary-button-state.test.ts:7-12,134-136`
- 전송 인자 조립은 `lib/swap-transaction.ts`에 추가만 한다. 기존 export는 F5 포크 테스트가 import하므로 그대로 둔다. ETH 입력·출력·ERC-20 세 경우의 multicall 인자와 `value`, wrap·unwrap 요청을 만드는 함수와 포크용 calldata 인코더를 더한다. WETH 치환은 `resolveQuoteTokens`를 쓴다. 근거: `lib/swap-transaction.ts:118-164`, `__tests__/fork/approve-swap.fork.test.ts:24-30`
- config는 `config/uniswap-v3.ts`의 SwapRouter02 ABI에 `unwrapWETH9`와 `ADDRESS_THIS` 상수를 추가만 하고, WETH ABI는 관심사별 신규 `config/weth.ts`에 둔다. 주소는 기존 `CONTRACTS_BY_CHAIN[chainId].weth`를 쓴다. 근거: `config/uniswap-v3.ts:72-108,128-161`, `config/contracts.ts:25,32,39`, `docs/plans/approve-swap.md:12`
- 실행 provider는 F5·F6 구조(잠금, 세대, 클릭 시점 스냅샷, `finish` 한 번)를 유지한다. kind 타입은 `lib/tx-result.ts`의 `TxKind` 하나로 합치고, 하드코딩된 phase 대응을 kind→phase 표로 바꾼다. 스왑 성공 분기를 swap·wrap·unwrap 공통으로 만들고 approve 분기는 그대로 둔다. `wrap`·`unwrap`은 기존 `execute()`를 재사용해 체인 확인·서명 대기·F6 분류를 그대로 얻는다. 근거: `providers/swap-execution-provider.tsx:62-82,238-358,398-453`
- allowance provider는 `isEthWethPair`이면 읽기 대상을 비워 `idle`로 둔다. 근거: `providers/token-allowance-provider.tsx:36-51`
- 받는 칸은 기존 `formatTokenAmount` 표시와 `data-amount-out-raw`를 `wrap`의 `amountOut`에도 적용한다. 견적 정보 영역과 최소 수령량 훅은 `success`에서만 값이 있으므로 바꾸지 않는다. 근거: `components/token-field.tsx:49-50,112-119`, `components/quote-details.tsx:74`, `hooks/use-amount-out-minimum.ts:15`
- 테스트 지원 확장은 그것을 쓰는 살 모드 Task에 "추가만"으로 병합한다. 기존 `decodeSwapCalldata`는 그대로 두고 unwrapWETH9·WETH 디코더를 테스트 쪽 ABI 리터럴로 새로 더한다. 스텁 지갑은 이미 `value`를 기록한다. 근거: `docs/plans/approve-swap.md:119`, `docs/plans/tx-status.md:17`, `__tests__/support/wagmi-harness.tsx:341-393`, `__tests__/support/stub-eip1193.ts:252,298`
- `tsconfig.json`이 테스트 파일도 검사하므로 T-2 이후 F5 단위 테스트(`quote-ready`를 담은 상태 순서 리터럴)가 typecheck를 깨뜨린다. T-2~T-4의 typecheck 완료 조건은 "그 파일과 다음 Task 대상만 오류"로 두고 T-15에서 해소한다. 근거: `__tests__/lib/primary-button-state.test.ts:23-42`
- 이전 기능 회귀 갱신은 기능별 Task로 나눠 digest 전후 기록을 분리한다. 동결 골격은 assertion만 바꾸고, `@then`·it 이름은 사용자 결정이 있을 때만 바꾼다. 이전 스펙 파일은 고치지 않는다. 근거: `docs/plans/approve-swap.md:208-212`, `docs/plans/tx-status.md:18`
- 쓰기 격리는 F5·F6 관례(E2E `workers: 1`·snapshot/revert·`--block-time 1`, 포크 파일 순차·snapshot/revert, `check:build`는 `test:e2e` 뒤 단독)를 따른다. 위임 코드 지우기는 snapshot을 잡은 뒤 `anvil_setCode`로 하고 revert로 되돌린다. 근거: `docs/plans/approve-swap.md:174,195,293`, `__tests__/fork/token-balances.fork.test.ts:184-196`
- mock 경계는 F5 T-9·T-10·T-11·T-13, F6 T-6·T-9·T-12 경계를 기준으로 하고, 새 경계(`anvil_setCode`, WETH 주입)는 테스트 설계 단계에서 사용자가 확정한다

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: 이번 세션에서 아직 실행하지 않은 체인 사실을 저장소 밖 anvil 포크로 확인한다
- 선행: 없음
- 연결 항목: DoD-7, DoD-8, DoD-9, DoD-11, DoD-12, DoD-24, DoD-25, DoD-35, DoD-36, DoD-37, DoD-38
- 수정 대상: 없음. 저장소 밖에서 전용 포트 8555 anvil 포크(블록 26250000)와 읽기 RPC로 확인한다
- 따라야 할 패턴: 저장소 밖에서 확인하고 결과는 구현 기록에 남긴다 — 근거: `docs/plans/tx-status.md:30-35`, `docs/plans/approve-swap.md:35-40`
- 완료 조건: 아래 결과를 구현 기록에 남기고, 스펙과 어긋나면 인터뷰로 되돌린다. (1) mock 계정에서 `anvil_setCode(계정, 0x)` 뒤 `WETH.withdraw`가 성공하고 `evm_revert` 뒤 위임 코드가 복원되는지 (2) 프로젝트 인코딩과 같은 ETH→USDC multicall + value가 체결되고 수령량이 최소 수령량 이상인지 (3) USDC approve 뒤 `ADDRESS_THIS` recipient + `unwrapWETH9` multicall이 체결되고 받은 ETH(잔액 변화 + 가스 비용)가 최소 수령량 이상인지 (4) `unwrapWETH9(uint256,address)` selector와 세 체인 라우터 코드에 그 selector가 있는지 (5) Base·Arbitrum WETH에 `deposit()`·`withdraw(uint256)`가 있는지(Arbitrum은 프록시 구현 코드로) (6) wagmi mock 커넥터·스텁 지갑 요청에 `value`가 그대로 실리고 미지정이면 필드가 생략되는지 (7) `anvil_dealERC20`으로 넣은 WETH로 withdraw가 성공하는지 (8) 위임 코드가 있는 계정의 unwrap 가스 추정이 어떻게 실패하는지 (9) E2E·포크 표본 금액의 티어, 가격 영향 등급, 최소 수령량이 0보다 큰지. 이번 세션 확인분(위임 코드 대상 주소, 일반 ETH 수신 성공, withdraw OutOfGas, 라우터 unwrapWETH9 수신 성공, cast `--legacy` 필요)도 함께 기록한다 — 검증: 확인 절차
- 실행 명령: `anvil --fork-url $ETH_MAINNET_RPC_URL --fork-block-number 26250000 --port 8555`, `cast code`, `cast sig`, `cast call`, `cast rpc`, `cast send --unlocked --legacy`
- 수정 금지: 저장소 파일
- 구현 기록: general-purpose(조사 전용 에이전트 없음, F6 T-1 선례), 저장소 수정 없음, anvil 1.8.1 8555·8556(종료 확인), viem 2.57.16·wagmi 3.7.11. 2026-11-21. 스크립트 `/root/study/.pipeline-scratch/native-eth/t1/`. 보고 NEEDS-DECISION. (1) mock 계정 코드 `0xef0100`+`0x8a67…408a`(717바이트). 코드가 있으면 withdraw status 0(OOG), snapshot 뒤 `anvil_setCode(A,0x)`면 성공(WETH·ETH 변화 = 금액), `evm_revert` true로 코드·WETH 복원 (2) ETH→USDC 1 ETH, 티어 100, multicall `0x5ae401dc` + value 1e18 체결, USDC +2375903197 ≥ 최소 2364023681, 라우터 잔여 0 (3) USDC→ETH 1000 USDC, 티어 100, 위임 코드를 지우면 체결·받은 ETH(잔액 변화+가스) 420740162332425437 ≥ 최소. 위임 코드가 있으면 status success여도 받은 ETH 0(위임 코드가 2300 stipend CALL로 `0xcc04506d439d338bde8ebbb074f17a54b7673b95`에 전액 전달), 추정 gas 180857이면 OOG revert (4) `unwrapWETH9(uint256,address)` `0x49404b7c`가 세 체인 라우터(24497바이트)에 있고 `WETH9()`가 config와 같다 (5) `deposit()` `0xd0e30db0`·`withdraw(uint256)` `0x2e1a7d4d`: Ethereum·Base(비프록시) WETH에 있음, Arbitrum은 EIP-1967 구현 `0x8b19…a668`에 있음 (6) mock 커넥터·스텁 지갑 모두 value 지정 시 그대로, 미지정 시 `value` 키 없음, `0n`이면 `0x0` (7) `anvil_dealERC20`([account, token, amount] 순서)로 넣은 WETH로 withdraw 성공 (8) 위임 코드 계정 unwrap: `eth_estimateGas` code 3 `execution reverted` data `0x`. mock 커넥터 + anvil은 추정 실패 시 블록 가스 한도로 채워 전송되어 status 0 또는 pending(EC-3 send-failed는 스텁 통합으로만 재현) (9) 표본(QuoterV2, 50bps): ETH→USDC 0.01·0.1·1 ETH, USDC→ETH 10·100·1000 USDC 모두 티어 100·가격 영향 normal·최소 수령량 > 0. 정정: 이번 세션 앞선 확인의 "일반 ETH 수신 성공"·"라우터 unwrapWETH9 수신 성공"은 tx status만 성공이고 ETH는 계정에 남지 않았다. 스펙과 어긋난 점: DoD-12(포크)는 위임 코드가 남으면 성립하지 않고, DoD-36(E2E)은 gas 추정에 따라 OOG revert할 수 있다(사용자 결정 대기)

### T-2 — config와 lib 순수 함수

- 사이드: 프론트
- 상태: 완료
- 목적: ABI·상수, 견적 `wrap`, 21개 상태 판정, 전송 인자 조립, kind 확장을 만든다
- 선행: 없음
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-6, DoD-7, DoD-8, DoD-9, DoD-10, DoD-14, DoD-18, DoD-19, DoD-21, DoD-22, EC-4
- 수정 대상: `config/uniswap-v3.ts` — unwrapWETH9 ABI 항목과 ADDRESS_THIS 추가만. `config/weth.ts` — 신규, WETH ABI. `lib/swap-quote.ts` — 상태 타입과 planSwapQuote의 wrap, 주석. `lib/swap-input-state.ts` — 미사용 getSwapButtonState 계열 삭제. `lib/primary-button-state.ts` — 상태 목록, phase, 판정, 활성 집합. `lib/swap-transaction.ts` — 신규 함수 추가만. `lib/tx-result.ts` — TxKind
- 따라야 할 패턴: 출처 주석이 있는 config, React·wagmi를 import하지 않는 `lib/` 순수 함수, kebab-case 파일과 named export — 근거: `config/uniswap-v3.ts:72`, `lib/swap-transaction.ts:127`, `CLAUDE.md`
- 완료 조건: 연결 항목에 필요한 판정·조립 제공. 기존 export와 기존 함수의 ERC-20 페어 동작이 바뀌지 않는다. `lib/`에 `quote-ready` 문자열이 없다. typecheck 오류는 T-3·T-4 대상 파일과 F5 단위 테스트 파일에만 있고 목록을 기록한다. `__tests__/lib` 실패는 F3 ETH↔WETH case와 F5 단위 case로 한정한다 — 검증: T-5, T-6, T-7, T-11
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/lib __tests__/config`
- 수정 금지: `providers/`, `components/`, `hooks/`, `config/contracts.ts`, `config/tokens.ts`, `docs/specs/*`
- 구현 기록: seongho:frontend-dev, 작성 영역 `config/uniswap-v3.ts`·`config/weth.ts`(신규)·`lib/swap-quote.ts`·`lib/swap-input-state.ts`·`lib/primary-button-state.ts`·`lib/swap-transaction.ts`·`lib/tx-result.ts`. 수정 0/3. 새 export: `ADDRESS_THIS`, `wethAbi`, `isWethToken`, `encodeUnwrapWeth9Calldata`, `buildSwapTransactionRequest`(to·args·value), `encodeSwapTransactionCalldata`, `buildWrapRequest`, `buildUnwrapRequest`, `encodeWethCalldata`. `PrimaryButtonStateParams.isEthPair` → `isEthIn`, `SwapQuotePlan`의 `no-route` 변형 제거(T-3에서 provider 분기 교체). 견적 `wrap`인데 보내는 토큰이 ETH가 아니면 `unwrap-ready`(스펙상 오지 않는 조합, 주석). 오케스트레이터 확인: 수정 범위 일치, typecheck 오류는 F5 단위 테스트·`components/primary-button.tsx`·`components/tx-status.tsx`·`providers/swap-quote-provider.tsx`만, lint 통과, `test __tests__/lib __tests__/config` 실패 3건(F5 DoD-5 두 case, F3 EC-6, 예상 범위)·56 통과·14 todo. 8단계 사용자 결정(2026-11-21)으로 재개: 검증 보고의 위생 항목 — 제품에서 쓰지 않는 `isEthPair` export 제거(수정 1/3). 수정 결과: `isEthPair` 정의 삭제(남은 참조 0건), typecheck·lint 통과. 재검증 통과

### T-3 — provider

- 사이드: 프론트
- 상태: 완료
- 목적: 견적 `wrap` 상태, allowance `idle` 조건, 스왑 `value`·unwrap 경로, `wrap`·`unwrap` 실행을 넣는다
- 선행: T-2
- 연결 항목: DoD-7, DoD-8, DoD-9, DoD-10, DoD-13, DoD-14, DoD-17, DoD-20, DoD-21, DoD-22, DoD-23, DoD-26, DoD-27, DoD-28, DoD-29, DoD-31, DoD-32, DoD-33, EC-1, EC-2, EC-3, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11
- 수정 대상: `providers/swap-quote-provider.tsx` — wrap 분기, 메모, 주석. `providers/token-allowance-provider.tsx` — idle 조건. `providers/swap-execution-provider.tsx` — kind 타입 통합, kind→phase 표, 공통 성공 분기, swap()의 인자·value, wrap·unwrap, 공개 값, 문서 주석
- 따라야 할 패턴: 세대 가드, `latestRef` 클릭 시점 스냅샷, `finish` 한 번, 성공 후처리 — 근거: `providers/swap-execution-provider.tsx:161-174,238-358,327-339,398-448`
- 완료 조건: 연결 항목 충족. approve 경로는 바뀌지 않는다. wrap·unwrap 성공 결과에 `balanceDropped`가 없다. wrap·unwrap 요청에 deadline이 없다. 슬리피지 provider를 참조하지 않는다. typecheck 오류는 T-4 대상과 F5 단위 테스트 파일에만 있다. 기존 F5·F6 통합 테스트 중 ERC-20 페어 case가 통과한다 — 검증: T-6, T-7, T-8, T-9, T-10
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap/tx-status-pending.test.tsx __tests__/swap/tx-status-success.test.tsx __tests__/swap/tx-status-failure.test.tsx __tests__/swap/tx-status-replacement.test.tsx __tests__/swap/tx-status-lifetime.test.tsx __tests__/swap/swap-execution-progress.test.tsx __tests__/swap/swap-execution-failure.test.tsx __tests__/swap/approve-execute.test.tsx`
- 수정 금지: `lib/`, `config/`, `components/`, `hooks/use-ensure-chain.ts`, `hooks/use-token-allowance-read.ts`, `providers/swap-form-provider.tsx`, `providers/slippage-provider.tsx`
- 구현 기록: seongho:frontend-dev(T-2 작성 에이전트 이어서), 작성 영역 `providers/swap-quote-provider.tsx`·`providers/token-allowance-provider.tsx`·`providers/swap-execution-provider.tsx`. 수정 0/3. `SwapExecutionTxKind` 제거·`TxKind` 통합, kind→phase 표 `PENDING_PHASE_BY_KIND`, 공통 성공 분기(swap·wrap·unwrap), swap()은 `buildSwapTransactionRequest`, wrap()·unwrap() 추가(잠금 공유), 견적 provider wrap 분기(`amountOut` 메모), allowance provider ETH↔WETH idle. `value`는 ETH 입력만 지정(그 밖은 키 없음). 오케스트레이터 확인: 수정 범위 일치, typecheck 오류는 F5 단위 테스트·`components/primary-button.tsx`·`components/tx-status.tsx`만, lint 통과, 지정 F5·F6 통합 8파일 59/59 통과

### T-4 — 컴포넌트

- 사이드: 프론트
- 상태: 완료
- 목적: 주 버튼 라벨·클릭, 상태 메시지 문구, 받는 칸 값을 고친다
- 선행: T-3
- 연결 항목: DoD-1, DoD-5, DoD-15, DoD-16, DoD-18, DoD-19, DoD-26, DoD-27, DoD-28, DoD-30, DoD-31, EC-5
- 수정 대상: `components/primary-button.tsx` — 라벨 표, onClick 분기. `components/tx-status.tsx` — kind별 문구 표, pending 조건. `components/token-field.tsx` — 받는 칸 값과 data-amount-out-raw
- 따라야 할 패턴: 상태별 라벨 표와 클릭 분기, kind별 문구 표, 받는 칸 표시 — 근거: `components/primary-button.tsx:23-42,102-111`, `components/tx-status.tsx:24-32,77-85`, `components/token-field.tsx:49-50,112-119`
- 완료 조건: 연결 항목 충족. 새 `data-testid`가 없다. 문구는 스펙 §1.1 표를 따른다. SSR 첫 렌더와 `restoring`·`disconnected` 분기가 바뀌지 않는다. typecheck 오류는 F5 단위 테스트 파일에만 있다. 프로덕션 빌드는 컴파일 성공과, 타입 검사 실패가 F5 단위 테스트 파일 하나뿐임을 확인한다(빌드 통과는 T-15 뒤 T-17에서 확인) — 검증: T-6, T-7, T-8, T-9, T-10, `bun run build`
- 실행 명령: `bun run build`, `bun run lint`, `bun run typecheck`
- 수정 금지: `providers/`, `lib/`, `config/`, `hooks/`, `components/swap-card.tsx`, `components/quote-details.tsx`
- 구현 기록: seongho:frontend-dev(T-2·T-3 작성 에이전트 이어서), 작성 영역 `components/primary-button.tsx`·`components/tx-status.tsx`·`components/token-field.tsx`. 수정 0/3. 1차 보고 BLOCKED: `next build`의 타입 검사가 F5 단위 테스트(`quote-ready` 리터럴) 오류로 실패해 "빌드 통과" 완료 조건과 계획의 허용 오류가 모순 → 완료 조건을 컴파일 성공 + 실패 원인 확인으로 고쳤다(빌드 통과는 T-17). 오케스트레이터 확인: 수정 범위 일치, typecheck 오류는 F5 단위 테스트 1건뿐, lint 통과, `bun run build` 컴파일 성공·타입 검사 실패 원인은 그 1건, 빌드 뒤 추적 파일 변경 없음, `quote-ready` 문자열 0건

### T-5 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 21개 상태 순서, ETH 페어 판정, wrap 판정, 가스 예약 경계를 검증한다
- 선행: T-2
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-6, DoD-18, DoD-19, EC-4
- 수정 대상: `__tests__/lib/native-eth-button-state.test.ts` — 신규
- 따라야 할 패턴: 스펙 리터럴 순서와 조건 곱 표본 — 근거: `__tests__/lib/primary-button-state.test.ts:22-42,160-260`
- 완료 조건: 연결 항목 판정. 기대 순서는 스펙 리터럴이고 제품 상태 목록을 쓰지 않는다. DoD-6은 인접 경계마다 공존 표본을 둔다. DoD-1은 allowance 상태 네 가지 각각이다. DoD-2·3은 보내는 ETH·받는 ETH 두 방향이다. EC-4는 금액 = 잔액인 ETH→USDC·ETH→WETH 표본이다. DoD-5는 판정 공간 전체 표본에서 본다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib`
- 수정 금지: 제품 코드, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/lib/native-eth-button-state.test.ts`(14 case). 수정 0/3. 본문 판단: 스펙 리터럴 21개 순서, 원천 입력 → 제품 판정 함수, DoD-6 인접 경계 20개를 공존 6·배타 14로 확인, DoD-5 판정 공간 64,800개 전수(견적 success에서만 가격 영향 축), 가격 영향 표본 10·500·2000bps. 오케스트레이터 확인: 골자 동결 유지(`e2e59233fbb43395`), `bun run test __tests__/lib` 이 파일 14/14 통과(전체 실패 3건은 F3 EC-6·F5 DoD-5 두 case, T-13·T-15 대상), oxlint 통과
- 테스트 파일·runner: `__tests__/lib/native-eth-button-state.test.ts`, Vitest
- mock 허용 경계: 후보는 없음(순수 함수). 테스트 설계 단계에서 사용자 확정
- 데이터 격리: 정적 데이터만 사용

### T-6 — 통합 테스트: ETH↔WETH 견적·주 버튼·allowance

- 사이드: 테스트
- 상태: 완료
- 목적: wrap 견적의 즉시 판정, 받는 칸, 정보 영역, 최소 수령량, 주 버튼, allowance 무요청, 페어 전환, 슬리피지 무영향을 검증한다
- 선행: T-4
- 연결 항목: DoD-14, DoD-15, DoD-16, DoD-17, DoD-18, DoD-19, DoD-20, EC-9, EC-10
- 수정 대상: `__tests__/swap/native-eth-wrap-quote.test.tsx` — 신규
- 따라야 할 패턴: 가짜 타이머를 진행하지 않는 즉시 판정과 QuoterV2 요청 0건, allowance 요청 0건, 슬리피지 팝오버 조작 — 근거: `__tests__/swap/quote-read.test.tsx:466-520`, `__tests__/swap/token-allowance.test.tsx:302-330`, `__tests__/swap/slippage-state.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-14는 두 방향과 Ethereum 외 체인 표본을 포함하고 견적 RPC 0건이다. DoD-15는 받는 칸 raw 속성을 리터럴과 비교한다. DoD-20은 WETH→ETH에서 포커스 이후에도 allowance 요청 0건이다. EC-9는 들어오는 방향과 나가는 방향 둘 다다. EC-10은 슬리피지 변경 전후 비교다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/native-eth-wrap-quote.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/native-eth-wrap-quote.test.tsx`(7 case). 수정 1/3: 오케스트레이터 실행에서 DoD-14~17 case가 전제 확인 `tokenAddressOf("out")`의 미선택 표현(빈 문자열)으로 실패 → 본문 헬퍼 수정(판정 불변). 본문 판단: 기준 시점은 받는 칸 WETH 행을 누르기 직전, 비잔액 요청은 `matchQuote.notBalance`, allowance는 `matchAllowance.any`, 선택 체인은 `setSelectedChainId`. 오케스트레이터 확인: 골자 동결 유지, `bun run test __tests__/swap/native-eth-wrap-quote.test.tsx` 2회 7/7 통과
- 테스트 파일·runner: `__tests__/swap/native-eth-wrap-quote.test.tsx`, Vitest jsdom
- mock 허용 경계: 후보는 F3·F4 경계(mock 커넥터, 전역 fetch URL 라우팅 스텁, 가짜 타이머, `vi.mock` 금지). 테스트 설계 단계에서 사용자 확정
- 데이터 격리: 테스트마다 config·스텁·QueryClient 새로 생성, `clearCookies`

### T-7 — 통합 테스트: ETH 스왑 주 버튼·트랜잭션과 디코드 지원 확장

- 사이드: 테스트
- 상태: 완료
- 목적: 디코드 지원을 추가만 하고, 같은 위임에서 ETH 입력·출력 스왑의 주 버튼, 요청 인자, `value`, kind를 검증한다
- 선행: T-4
- 연결 항목: DoD-1, DoD-4, DoD-7, DoD-8, DoD-9, DoD-10, DoD-13
- 수정 대상: `__tests__/support/wagmi-harness.tsx` — 추가만, unwrapWETH9·WETH deposit·withdraw 테스트 ABI 리터럴과 multicall 내부 호출 종류별 디코드·WETH calldata 디코드 함수. `__tests__/support/stub-eip1193.ts` — 필요할 때만 추가만, value를 bigint로 읽는 보조 함수. `__tests__/swap/native-eth-swap.test.tsx` — 신규
- 따라야 할 패턴: 요청 디코딩과 deadline 가짜 `Date`, 전송 핸들러 — 근거: `__tests__/swap/swap-execute.test.tsx`, `__tests__/support/stub-eip1193.ts:283`, `docs/plans/approve-swap.md:115-128`(지원 확장 병합 선례)
- 완료 조건: 연결 항목 판정. 라우터·WETH·`ADDRESS_THIS` 주소는 테스트 리터럴이다. DoD-8·9는 서명 대기 중 금액·견적을 바꾼 표본으로 클릭 시점 값을 본다. DoD-10은 ERC-20 페어와 USDC→ETH 두 표본이다. DoD-4는 allowance 0·max 두 표본이다. DoD-13은 두 방향이다. 기존 `decodeSwapCalldata`의 동작과 기존 export가 바뀌지 않고 기존 F5 통합 테스트가 통과한다 — 검증: 테스트
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap/native-eth-swap.test.tsx __tests__/swap/swap-execute.test.tsx`
- 수정 금지: 제품 코드, 기존 테스트 파일, 지원 모듈의 기존 export·동작, `__tests__/support/rpc-balance-stub.ts`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/support/wagmi-harness.tsx`(추가 71줄, 삭제 0)·`__tests__/swap/native-eth-swap.test.tsx`(9 case). `stub-eip1193.ts` 무수정. 추가 지원 API: `STUB_SWAP_ROUTER02_ETH_ABI`, `STUB_WETH_ABI`, `decodeRouterMulticall`(내부 호출 종류별), `decodeWethCalldata`. 수정 0/3. 본문 판단: USDC·DAI→ETH 표본은 `parityQuoteRule` 또는 테스트 쪽 `bestTierRule`(가격 영향 0 이하), 클릭 시점 case는 체인 전환 붙잡기로 T0·T1 구분. 오케스트레이터 확인: 골자 동결 유지, lint 통과, `test native-eth-swap·swap-execute` 14건 중 13 통과·실패 1건은 F5 EC-19(ETH→USDC 표본이 이제 swap-ready, T-15 회귀 갱신 대상)
- 테스트 파일·runner: `__tests__/swap/native-eth-swap.test.tsx`(지원 모듈 `__tests__/support/wagmi-harness.tsx`), Vitest jsdom
- mock 허용 경계: 후보는 F5 T-9 경계(스텁 EIP-1193 전송 핸들러, 영수증 스텁, 체인 전환 붙잡기, `Date` 가짜 시계). 테스트 설계 단계에서 사용자 확정
- 데이터 격리: T-6과 같음

### T-8 — 통합 테스트: wrap·unwrap 전송과 호출 규칙

- 사이드: 테스트
- 상태: 완료
- 목적: wrap·unwrap 요청 인자, 체인 확인 순서, 서명 대기, 상태 밖 호출, 클릭 시점 값을 검증한다
- 선행: T-7
- 연결 항목: DoD-21, DoD-22, DoD-23, DoD-26, EC-7, EC-8
- 수정 대상: `__tests__/swap/wrap-execute.test.tsx` — 신규
- 따라야 할 패턴: 체인 전환이 전송보다 앞서는지와 커밋 기록, 상태 밖 호출 — 근거: `__tests__/swap/swap-execution-progress.test.tsx`, `__tests__/swap/swap-execute.test.tsx:686-780`
- 완료 조건: 연결 항목 판정. DoD-21·22는 선택 체인 WETH 리터럴이고 Ethereum 외 체인 표본을 포함한다. DoD-23은 지갑 체인이 다른 표본이다. DoD-26은 클릭 직후 첫 커밋부터 기록한다. EC-7은 상태가 아닐 때 두 가지 이상, 진행 중, 리렌더 전 연타 표본이고 지갑 요청 0건과 `result` 불변을 본다. EC-8은 서명 대기 중 금액을 바꾼다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/wrap-execute.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(T-7 작성 에이전트 이어서, 살 모드), 작성 영역 `__tests__/swap/wrap-execute.test.tsx`(8 case). 수정 0/3. 기존 지원 API만 사용(`decodeWethCalldata` 등). 본문 판단: EC-7 연타는 한 번 클릭 대조 실행의 지갑 요청 순서와 비교, 결과 표본은 실제 클릭으로 만든다. 오케스트레이터 확인: 골자 동결 유지, `bun run test __tests__/swap/wrap-execute.test.tsx` 8/8 통과
- 테스트 파일·runner: `__tests__/swap/wrap-execute.test.tsx`, Vitest jsdom
- mock 허용 경계: 후보는 F5 T-9·T-10 경계. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: T-6과 같음

### T-9 — 통합 테스트: wrap·unwrap 진행과 결과

- 사이드: 테스트
- 상태: 완료
- 목적: wrapping·unwrapping 진행 상태, pending 메시지, 성공 결과와 후처리, 진행 중 체인 변경을 검증한다
- 선행: T-7
- 연결 항목: DoD-27, DoD-28, DoD-29, DoD-30, DoD-31, DoD-32, DoD-33, EC-11
- 수정 대상: `__tests__/swap/wrap-progress.test.tsx` — 신규
- 따라야 할 패턴: `holdReceipt`, 잔액 요청 집계, `chooseChainFromDropdown`, 커밋 기록 — 근거: `__tests__/swap/tx-status-pending.test.tsx`, `__tests__/swap/tx-status-success.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-29·31은 객체 전체를 리터럴과 비교한다(`balanceDropped` 키 없음). DoD-30은 링크 href가 리터럴이다. DoD-33은 영수증 뒤 새로 생긴 잔액 요청으로 본다. EC-11은 진행 중 드롭다운으로 선택 체인을 바꾼다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/wrap-progress.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/wrap-progress.test.tsx`(3 case). 수정 0/3. 오케스트레이터 확인: 골자 동결 유지, T-9·T-10 합동 실행 8/8 통과
- 테스트 파일·runner: `__tests__/swap/wrap-progress.test.tsx`, Vitest jsdom
- mock 허용 경계: 후보는 F5 T-10 경계와 F6 T-8의 잔액 붙잡기. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: T-6과 같음

### T-10 — 통합 테스트: wrap·unwrap 실패와 교체

- 사이드: 테스트
- 상태: 완료
- 목적: wrap·unwrap의 거부, 체인 전환 실패, 전송 실패, revert, 교체를 검증한다
- 선행: T-7
- 연결 항목: EC-1, EC-2, EC-3, EC-5, EC-6
- 수정 대상: `__tests__/swap/wrap-failure.test.tsx` — 신규
- 따라야 할 패턴: 원인 체인 주입과 -32000 재시도, 교체 주입 API — 근거: `__tests__/swap/tx-status-failure.test.tsx`, `__tests__/swap/tx-status-replacement.test.tsx`
- 완료 조건: 연결 항목 판정. 모든 항목을 wrap·unwrap 두 kind로 본다. EC-1은 4001, 5000, 최상위 -32603 + cause 4001 표본이다. EC-3은 -32000·-32603 표본이다. EC-6은 cancelled·replaced 두 사유이고 금액이 그대로다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/wrap-failure.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(T-9와 같은 에이전트, 살 모드), 작성 영역 `__tests__/swap/wrap-failure.test.tsx`(5 case). 수정 0/3. 본문 판단: EC-2 code -32603, EC-3 -32000·-32603(viem 재시도는 기존 스텁 동작 -32601). 오케스트레이터 확인: 골자 동결 유지, T-9·T-10 합동 실행 8/8 통과
- 테스트 파일·runner: `__tests__/swap/wrap-failure.test.tsx`, Vitest jsdom
- mock 허용 경계: 후보는 F6 T-9 경계(cause 주입)와 F6 T-6 경계(교체 주입, 가짜 타이머). 테스트 설계 단계에서 사용자 확정
- 데이터 격리: T-6과 같음

### T-11 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: Ethereum 포크에서 ETH→USDC, USDC→ETH, wrap, unwrap을 제품 인코딩으로 체결해 잔액으로 판정한다
- 선행: T-1, T-2
- 연결 항목: DoD-11, DoD-12, DoD-24, DoD-25
- 수정 대상: `__tests__/fork/native-eth.fork.test.ts` — 신규. value를 받는 전송 헬퍼는 이 파일 안에 둔다
- 따라야 할 패턴: 프록시 경유 판정 읽기, 영수증 직접 폴링, `anvil_setBalance`·`anvil_dealERC20`, snapshot/revert, setCode — 근거: `__tests__/fork/approve-swap.fork.test.ts:199-272`, `__tests__/fork/token-balances.fork.test.ts:184-196`
- 완료 조건: 연결 항목 판정. calldata는 제품 `lib/swap-transaction.ts` 함수로 만든다. ETH 판정은 프록시를 거친 잔액 읽기로 한다. DoD-12의 가스 비용은 영수증에서 계산한다. DoD-12·DoD-25는 snapshot 뒤 위임 코드를 지우고(사용자 결정 2026-11-21), DoD-25는 revert 뒤 복원을 보조 확인한다. 표본은 T-1 결과를 쓴다. 기존 포크 테스트가 통과한다 — 검증: 테스트
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드, 기존 `__tests__/fork/*`, `vitest.fork.config.mts`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: T-1 결과로 차단했다가 해제(사용자 결정 2026-11-21: 스펙 DoD-12 준비 단계에 위임 코드 제거·snapshot 복원 추가, 골격 update 재동결). seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/fork/native-eth.fork.test.ts`(5 case). 수정 2/3: (1) DoD-11 영수증 reverted — 저장소 밖 8555 재현·trace로 OutOfGas 확인. 포크 직후·snapshot revert 뒤 latest가 포크 블록(약 30일 전) timestamp라 anvil 가스 추정이 풀 오라클 관측값 기록(약 2만 가스)을 빠뜨린다(위임 코드 무관, 테스트 환경 결함) → DoD-11·24에 지갑 역할 gas 상한(추정 ×1.2) (2) DoD-12 간헐 reverted(6회 중 2회) — 같은 원인, 첫 지시 범위가 좁았던 오케스트레이터 착오 → 파일의 쓰기 전송 5곳 모두 같은 헬퍼. 진단 스크립트 `/root/study/.pipeline-scratch/native-eth/diag/`. 오케스트레이터 확인: 골자 동결 유지, 이 파일 8회 연속 5/5, `bun run test:fork` 18/18
- 테스트 파일·runner: `__tests__/fork/native-eth.fork.test.ts`, Vitest(`vitest.fork.config.mts`, anvil 8547)
- mock 허용 경계: 후보는 없음. 준비 단계에서만 anvil 직접 상태 변경(F5 T-11 경계 + `anvil_setCode`). 테스트 설계 단계에서 사용자 확정
- 데이터 격리: 파일 순차 실행, 테스트마다 snapshot/revert(revert 반환 true 단정)

### T-12 — F2 회귀 갱신

- 사이드: 테스트·E2E
- 상태: 완료
- 목적: ETH가 낀 페어를 비활성으로 단정하던 F2 테스트와 E2E 상태 정규식을 F7 판정에 맞춘다
- 선행: T-6, T-7, T-8, T-9, T-10
- 연결 항목: DoD-1, DoD-4, DoD-5
- 수정 대상: `__tests__/swap/primary-button.test.tsx` — ETH 표본의 quote-ready 단정. `e2e/swap-form.spec.ts` — USDC→ETH 비활성 단정. `e2e/support/app.ts` — 주 버튼 상태 정규식(quote-ready 제거, 새 상태 추가). `__tests__/swap/balances.test.tsx`, `__tests__/wallet/restore.test.tsx` — 실패할 때만 상태 목록
- 따라야 할 패턴: 동결 골격은 assertion만, `@then`·이름은 사용자 결정 — 근거: `docs/plans/approve-swap.md:208-212`
- 완료 조건: 연결 항목에 맞게 갱신. F2 digest `12a88df2f0bb1e2a` 전후와 F1 `6afdf2fb5d08e92c` 유지를 기록한다 — 검증: 테스트, 동결 확인 명령
- 실행 명령: `bun run test __tests__/swap/primary-button.test.tsx __tests__/swap/balances.test.tsx __tests__/wallet`, `bun run test:e2e e2e/wallet.spec.ts e2e/swap-form.spec.ts`
- 수정 금지: 제품 코드, F7 신규 테스트, `__tests__/support/*`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: Vitest 부분 seongho:test-dev(새 인스턴스 A — 원 작성 에이전트는 이전 세션이라 재개 불가), E2E 부분 seongho:e2e-dev(새 인스턴스, 같은 사유). 작성 영역 `__tests__/swap/primary-button.test.tsx`(DoD-38 `@then`·이름 swap-ready·활성, EC-25 두 case swap-ready, EC-11 `@given` 스텁 조건 추가·`parityQuoteRule`, 상태 목록), `__tests__/swap/balances.test.tsx`·`__tests__/wallet/restore.test.tsx`(상태 목록), `e2e/swap-form.spec.ts`(DoD-38 `@then` "견적 뒤 상태 중 하나", 비활성 `@then` 삭제, 이름), `e2e/support/app.ts`(정규식 두 개). 수정 0/3. `waitForRestoreSettled` 지역 정규식(:68)의 `quote-ready`는 결정 범위 밖이라 유지(동작 영향 없음). F2 골자 digest `12a88df2f0bb1e2a` → `a8d00ddb8b88e8f7`(F2 동결 확인 명령의 `--frozen` 값을 이 값으로 읽는다), F1 `6afdf2fb5d08e92c` 유지. E2E 실행(오케스트레이터): `bun run test:e2e` wallet·swap-form·quote·slippage·approve-swap·tx-status 24/24 통과. 8단계 사용자 결정(2026-11-21)으로 재개: 검증 보고의 Low 테스트 결함 — `e2e/support/app.ts:67-68` `waitForRestoreSettled` 지역 정규식을 §4.3 21개 상태에 맞춤(수정 1/3). 수정 결과: `waitForRestoreSettled` 정규식에서 `quote-ready` 제거·`wrap-ready`·`unwrap-ready` 추가(§4.3의 끝난 상태 14개), 주석 일시 상태에 `wrapping`·`unwrapping`. 재검증 통과
- 테스트 파일·runner: 수정 대상의 기존 파일, Vitest jsdom·Playwright
- mock 허용 경계: 기존 파일의 경계 그대로
- 데이터 격리: 기존 파일의 격리 그대로
- 실행 환경: `bun run test:e2e` 기본 환경(앱 3100, anvil 8546)

### T-13 — F3 회귀 갱신

- 사이드: 테스트·E2E
- 상태: 완료
- 목적: ETH↔WETH `no-route`와 ETH 페어 `quote-ready`를 단정하던 F3 테스트를 F7 판정에 맞춘다
- 선행: T-6, T-7, T-8, T-9, T-10
- 연결 항목: DoD-2, DoD-5, DoD-14, DoD-15
- 수정 대상: `__tests__/lib/swap-quote.test.ts` — ETH↔WETH 계획 결과. `__tests__/swap/quote-read.test.tsx`, `__tests__/swap/quote-display.test.tsx`, `__tests__/swap/quote-refresh.test.tsx`, `__tests__/swap/quote-button.test.tsx` — no-route·quote-ready 단정. `e2e/quote.spec.ts` — ETH→USDC와 ETH→WETH 단정
- 따라야 할 패턴: T-12와 같음 — 근거: `docs/plans/approve-swap.md:208-212`
- 완료 조건: 연결 항목에 맞게 갱신. ETH→WETH E2E는 QuoterV2 요청 0건 단정을 유지한다. F3 digest `8acf896e2a4dffdd` 전후를 기록한다 — 검증: 테스트, 동결 확인 명령
- 실행 명령: `bun run test __tests__/lib/swap-quote.test.ts __tests__/swap/quote-read.test.tsx __tests__/swap/quote-display.test.tsx __tests__/swap/quote-refresh.test.tsx __tests__/swap/quote-button.test.tsx`, `bun run test:e2e e2e/quote.spec.ts`
- 수정 금지: 제품 코드, F7 신규 테스트, `__tests__/support/*`, `e2e/support/*`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: Vitest 부분 seongho:test-dev(새 인스턴스 B, 같은 사유), E2E 부분 seongho:e2e-dev(T-12와 같은 새 인스턴스). 작성 영역 `__tests__/lib/swap-quote.test.ts`(EC-6 wrap), `__tests__/swap/quote-read.test.tsx`(DoD-6·7 괄호, EC-6 wrap·wrap-ready/unwrap-ready, EC-16 swap-ready), `__tests__/swap/quote-display.test.tsx`(DoD-11 등 price-impact-too-high·이름, EC-15), `__tests__/swap/quote-refresh.test.tsx`(DoD-30·EC-9), `__tests__/swap/quote-button.test.tsx`(DoD-31), 상태 목록 4곳, `e2e/quote.spec.ts`(DoD-11 등 swap-ready·활성, EC-6 wrap-ready·활성, QuoterV2 0건 유지). 수정 0/3. quote-display DoD-11 it 이름은 확정 `@then`과 맞추려고 오케스트레이터 지시로 함께 바꿨다(이름은 digest 밖). F3 골자 digest `8acf896e2a4dffdd` → `6a48e7cea8e0d4ed`(F3 동결 확인 명령의 `--frozen` 값을 이 값으로 읽는다). E2E 실행(오케스트레이터): `bun run test:e2e` wallet·swap-form·quote·slippage·approve-swap·tx-status 24/24 통과
- 테스트 파일·runner: 수정 대상의 기존 파일, Vitest jsdom·Playwright
- mock 허용 경계: 기존 파일의 경계 그대로
- 데이터 격리: 기존 파일의 격리 그대로
- 실행 환경: `bun run test:e2e` 기본 환경(앱 3100, anvil 8546)

### T-14 — F4 회귀 갱신

- 사이드: 테스트·E2E
- 상태: 완료
- 목적: ETH→USDC `quote-ready`를 단정하던 F4 테스트를 F7 판정에 맞춘다
- 선행: T-6, T-7, T-8, T-9, T-10
- 연결 항목: DoD-5
- 수정 대상: `e2e/slippage.spec.ts` — ETH→USDC 상태 단정. `__tests__/swap/slippage-quote.test.tsx`, `__tests__/swap/slippage-popover.test.tsx`, `__tests__/swap/slippage-state.test.tsx` — 실패할 때만 상태 목록
- 따라야 할 패턴: T-12와 같음 — 근거: `docs/plans/approve-swap.md:208-212`
- 완료 조건: 연결 항목에 맞게 갱신. F4 digest `3af643e844b77259` 전후(변경이 없으면 유지)를 기록한다 — 검증: 테스트, 동결 확인 명령
- 실행 명령: `bun run test __tests__/swap/slippage-quote.test.tsx __tests__/swap/slippage-popover.test.tsx __tests__/swap/slippage-state.test.tsx`, `bun run test:e2e e2e/slippage.spec.ts`
- 수정 금지: 제품 코드, F7 신규 테스트, `__tests__/support/*`, `e2e/support/*`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: Vitest 부분 seongho:test-dev(새 인스턴스 A), E2E 부분 seongho:e2e-dev(T-12와 같은 새 인스턴스). 작성 영역 `__tests__/swap/slippage-quote.test.tsx`·`slippage-popover.test.tsx`·`slippage-state.test.tsx`(상태 목록), `e2e/slippage.spec.ts`(:114 대기 상태 swap-ready). 태그 변경 없음. 수정 0/3. F4 골자 digest `3af643e844b77259` 유지. E2E 실행(오케스트레이터): `bun run test:e2e` wallet·swap-form·quote·slippage·approve-swap·tx-status 24/24 통과
- 테스트 파일·runner: 수정 대상의 기존 파일, Vitest jsdom·Playwright
- mock 허용 경계: 기존 파일의 경계 그대로
- 데이터 격리: 기존 파일의 격리 그대로
- 실행 환경: `bun run test:e2e` 기본 환경(앱 3100, anvil 8546)

### T-15 — F5 회귀 갱신과 F6 확인

- 사이드: 테스트
- 상태: 완료
- 목적: F5 단위·통합 테스트의 상태 순서와 ETH 표본을 F7 판정에 맞추고 typecheck 차단을 해소한다. F6 테스트는 무수정 통과를 확인한다
- 선행: T-6, T-7, T-8, T-9, T-10
- 연결 항목: DoD-1, DoD-4, DoD-5, DoD-6
- 수정 대상: `__tests__/lib/primary-button-state.test.ts` — 상태 순서 리터럴, 조건 표, 단독·쌍 표본, 계약 가드. `__tests__/swap/approve-swap-button.test.tsx` — ETH 페어 단정. `__tests__/swap/swap-execute.test.tsx` — 상태 밖 호출의 ETH 표본 교체
- 따라야 할 패턴: T-12와 같음. 상태 순서를 21개로 다시 쓸지 `quote-ready` 행만 지울지, 상태 밖 호출의 대체 표본은 테스트 설계 단계에서 사용자 결정 — 근거: `docs/plans/approve-swap.md:208-212`
- 완료 조건: 연결 항목에 맞게 갱신. `bun run typecheck` 오류 0. F5 digest `74b2bc4d3dfcc0aa` 전후와 F6 `8a07e4e0f647896f` 유지를 기록한다. `__tests__/swap/token-allowance.test.tsx`와 F6 `tx-status-*` 테스트는 수정 없이 통과한다 — 검증: 테스트, 동결 확인 명령
- 실행 명령: `bun run typecheck`, `bun run test __tests__/lib/primary-button-state.test.ts __tests__/swap`, `bun run test:e2e e2e/approve-swap.spec.ts e2e/tx-status.spec.ts`
- 수정 금지: 제품 코드, F7 신규 테스트, `__tests__/support/*`, `e2e/support/*`, F6 테스트 파일, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(새 인스턴스 A). 작성 영역 `__tests__/lib/primary-button-state.test.ts`(DoD-5 두 case와 전용 표본·헬퍼·타입 삭제 → case가 남지 않아 Vitest가 "No test suite found"로 실패 → 결정의 귀결로 파일 삭제, F7 `native-eth-button-state.test.ts`가 대체), `__tests__/swap/approve-swap-button.test.tsx`(DoD-6 case·describe 삭제), `__tests__/swap/swap-execute.test.tsx`(EC-19 `@given` 표본 approve swap-ready·swap wrap-ready, 본문 표본·실패 라벨 index). 수정 0/3. F5 동결 확인 명령은 파일 목록에서 `__tests__/lib/primary-button-state.test.ts`를 빼고 `--exempt`에 DoD-5·DoD-6을 더한다(`--exempt DoD-3,DoD-4,DoD-5,DoD-6,DoD-27,DoD-28,DoD-29,DoD-31`). F5 골자 digest `74b2bc4d3dfcc0aa` → `b17ea048db48454a`(case 50 → 47, 이 명령의 `--frozen` 값으로 읽는다), F6 `8a07e4e0f647896f` 유지. 오케스트레이터 확인(T-12부터 T-15까지 공통): `bun run typecheck` 오류 0, lint 통과, `bun run test` 45 파일 324/324 통과, F1부터 F7까지 동결 확인 스크립트 7건 모두 일치(`/root/study/.pipeline-scratch/native-eth/frozen-all.sh`). E2E 실행(오케스트레이터): `bun run test:e2e` wallet·swap-form·quote·slippage·approve-swap·tx-status 24/24 통과
- 테스트 파일·runner: 수정 대상의 기존 파일, Vitest
- mock 허용 경계: 기존 파일의 경계 그대로
- 데이터 격리: 기존 파일의 격리 그대로

### T-16 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: mock 커넥터 + anvil 포크로 ETH→USDC, USDC→ETH, wrap, unwrap의 화면 흐름을 검증한다
- 선행: T-1, T-12, T-13, T-14, T-15
- 연결 항목: DoD-35, DoD-36, DoD-37, DoD-38
- 수정 대상: `e2e/native-eth.spec.ts` — 신규. `e2e/support/native-eth.ts` — 신규, 흐름 헬퍼. `e2e/support/anvil.ts` — 추가만, 위임 코드 지우기와 코드 읽기. `e2e/support/tx-status.ts` — expectTxStatus kind 타입에 wrap·unwrap 추가만
- 따라야 할 패턴: ERC-20 페어 입력·활성 상태 대기, snapshot/revert, 잔액 읽기·주입, `beforeAll` 견적 예열 — 근거: `e2e/approve-swap.spec.ts`, `e2e/tx-status.spec.ts`, `e2e/support/approve-swap.ts:27-51`, `e2e/support/anvil.ts:50-69,179-206`
- 완료 조건: 연결 항목 판정. 잔액 기대는 러너가 anvil에서 직접 읽은 값과 입력 정수로 만든다. DoD-36은 snapshot → 위임 코드 지우기 → USDC 주입, DoD-38은 snapshot → 위임 코드 지우기 → WETH 주입 순서이고(DoD-36은 사용자 결정 2026-11-21), 둘 다 revert 뒤 위임 코드 복원을 보조 확인한다. `config/e2e-mock.ts`를 포함한 제품 코드는 바꾸지 않는다. E2E 전체가 통과한다 — 검증: E2E
- 실행 명령: `bun run test:e2e e2e/native-eth.spec.ts`, `bun run test:e2e`
- 수정 금지: 제품 코드, 기존 `e2e/*.spec.ts`, `e2e/support/app.ts`, `e2e/support/approve-swap.ts`
- 구현 기록: T-1 결과로 차단했다가 해제(사용자 결정 2026-11-21: 스펙 DoD-36 준비 단계에 위임 코드 제거·snapshot 복원 추가, 골격 update 재동결). seongho:e2e-dev(골격 작성 에이전트, 살 모드), 작성 영역 `e2e/native-eth.spec.ts`(4 case), `e2e/support/native-eth.ts`(신규: `DELEGATION_DESIGNATOR_PATTERN`, `expectEnabledNativeEthPrimaryState`, `readDelegationCode`, `clearDelegationCode`, `expectDelegationCodeRestored`), `e2e/support/anvil.ts`(추가 12줄: `readAccountCode`, `clearAccountCode`), `e2e/support/tx-status.ts`(kind 타입에 wrap·unwrap). 수정 0/3. 본문 판단: 표본 ETH→USDC 1 ETH, USDC→ETH 1000 USDC(2000 주입), wrap 1 ETH, unwrap 0.5 WETH(1 WETH 주입). snapshot은 beforeEach, revert·true 단정과 위임 코드 복원 보조 확인은 afterEach. DoD-38의 위임 표식 확인은 snapshot 뒤 읽기(읽기만이라 상태 동일). 오케스트레이터 확인: 골자 동결 유지, lint·tsc 통과, `bun run test:e2e e2e/native-eth.spec.ts` 4/4 통과
- 테스트 파일·runner: `e2e/native-eth.spec.ts`, Playwright chromium
- mock 허용 경계: 후보는 F5 T-13·F6 T-12 경계에 러너→anvil 위임 코드 지우기·WETH 주입(준비 단계만)을 더한 것, `page.route` 금지. 테스트 설계 단계에서 사용자 확정
- 데이터 격리: 테스트별 브라우저 컨텍스트, 쓰기 테스트마다 snapshot/revert(revert 반환 true 단정), `workers: 1`
- 실행 환경: 앱 3100(`NEXT_PUBLIC_E2E_MOCK=1`, `.next-e2e`), anvil 8546(`--block-time 1`), 포크 블록·포트 `config/e2e.ts`, 계정 `config/e2e-mock.ts`의 mock 계정, Ethereum만. `check:build`와 동시에 실행하지 않는다

### T-17 — 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 전체 정합성 명령과 이전 기능 동결 골격을 확인한다
- 선행: T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, T-10, T-11, T-12, T-13, T-14, T-15, T-16
- 연결 항목: DoD-11, DoD-12, DoD-24, DoD-25, DoD-35, DoD-36, DoD-37, DoD-38
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 명령을 하나씩 순서대로, `check:build`는 `test:e2e` 뒤 단독 — 근거: `docs/plans/tx-status.md`의 전체 검사 Task, `CLAUDE.md`
- 완료 조건: 실행 명령이 모두 통과한다. `bun run test`는 3회 같은 결과다. F1~F6 digest를 각 계획의 동결 확인 명령으로 확인한다. 7단계 코드 대조 항목을 기록한다: wrap·unwrap에 deadline·`refundETH`가 없다, `ADDRESS_THIS` 값, ABI 범위, 새 testid 없음, `balanceDropped`는 approve에만, 이전 스펙 파일 무변경, 프록시 허용 메서드 무변경 — 검증: 명령 실행 확인
- 실행 명령: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`(3회), `bun run build`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`
- 수정 금지: 저장소 파일
- 구현 기록: 오케스트레이터가 순서대로 실행(스크립트 `/root/study/.pipeline-scratch/native-eth/t17.sh`, 로그 `t17-*.log`, 2026-11-21). `format:check`·`lint`·`typecheck` 통과, `bun run test` 3회 모두 45 파일 324/324, `build` 통과, `test:fork` 5 파일 18/18, `test:e2e` 33/33(1 worker), `check:build` 통과(`test:e2e` 뒤 단독). F1~F7 동결 확인 7건 일치(F1 `6afdf2fb5d08e92c`, F2 `a8d00ddb8b88e8f7`, F3 `6a48e7cea8e0d4ed`, F4 `3af643e844b77259`, F5 `b17ea048db48454a`, F6 `8a07e4e0f647896f`, F7 `ded5093c9ac9e1a2`). 실행 뒤 추적 파일 변경은 Task 수정 대상뿐. 7단계 코드 대조 항목은 독립 검증이 확인한다

## 3. 항목 coverage

- DoD-1: T-2, T-4, T-5, T-7, T-12, T-15
- DoD-2: T-2, T-5, T-13
- DoD-3: T-2, T-5
- DoD-4: T-2, T-5, T-7, T-12, T-15
- DoD-5: T-2, T-4, T-5, T-12, T-13, T-14, T-15
- DoD-6: T-2, T-5, T-15
- DoD-7: T-1, T-2, T-3, T-7
- DoD-8: T-1, T-2, T-3, T-7
- DoD-9: T-1, T-2, T-3, T-7
- DoD-10: T-2, T-3, T-7
- DoD-11: T-1, T-11, T-17
- DoD-12: T-1, T-11, T-17
- DoD-13: T-3, T-7
- DoD-14: T-2, T-3, T-6, T-13
- DoD-15: T-4, T-6, T-13
- DoD-16: T-4, T-6
- DoD-17: T-3, T-6
- DoD-18: T-2, T-4, T-5, T-6
- DoD-19: T-2, T-4, T-5, T-6
- DoD-20: T-3, T-6
- DoD-21: T-2, T-3, T-8
- DoD-22: T-2, T-3, T-8
- DoD-23: T-3, T-8
- DoD-24: T-1, T-11, T-17
- DoD-25: T-1, T-11, T-17
- DoD-26: T-3, T-4, T-8
- DoD-27: T-3, T-4, T-9
- DoD-28: T-3, T-4, T-9
- DoD-29: T-3, T-9
- DoD-30: T-4, T-9
- DoD-31: T-3, T-4, T-9
- DoD-32: T-3, T-9
- DoD-33: T-3, T-9
- DoD-35: T-1, T-16, T-17
- DoD-36: T-1, T-16, T-17
- DoD-37: T-1, T-16, T-17
- DoD-38: T-1, T-16, T-17
- EC-1: T-3, T-10
- EC-2: T-3, T-10
- EC-3: T-3, T-10
- EC-4: T-2, T-5
- EC-5: T-3, T-4, T-10
- EC-6: T-3, T-10
- EC-7: T-3, T-8
- EC-8: T-3, T-8
- EC-9: T-3, T-6
- EC-10: T-3, T-6
- EC-11: T-3, T-9

## 4. 실행 순서

- 1구간(병렬): T-1(저장소 밖, 8555) / T-2
- 2구간(병렬): T-3 / T-5 / T-11(T-1 완료 뒤, 8547 독점)
- 3구간: T-4
- 4구간(단독): T-7. 공용 지원 모듈 `__tests__/support/wagmi-harness.tsx`를 고치므로 단독으로 실행한다
- 5구간(병렬): T-6 / T-8 / T-9 / T-10. 각자 신규 파일 하나만 고친다(T-6은 T-4 뒤 어디서든 가능)
- 6구간: T-12 / T-13 / T-14 / T-15. 편집과 Vitest는 병렬, E2E 명령은 T-12 → T-13 → T-14 → T-15 순서로 실행한다(포트 독점, `e2e/support/app.ts` 정규식이 먼저)
- 7구간: T-16
- 8구간: T-17
- 테스트 설계(골격 동결)는 구현 전에 T-5부터 T-11까지와 T-16의 골격, T-12부터 T-15까지의 `@then` 변경 결정을 먼저 고정한다

## 5. 차단 사항

- 없음

## 테스트 설계 증거

- 상태: 예외 동결 (reviewer 3라운드 후 자동 반복 한도 도달. 3라운드 NEEDS-FIX Low 1건(포크 DoD-11·12 `amountOutMinimum` > 0 전제) 반영분은 독립 재검토 없이 기계 검사만 통과, 사용자 확정 2026-11-21)
- 기준 스펙: `docs/specs/native-eth.md` (확정, 2026-11-20 갱신본: 계획 단계 D-1~D-4 반영으로 §1.1·DoD-10·15·22·33·§4.3·§4.4 보완과 DoD-34 삭제, 테스트 설계 단계 D-1 반영으로 DoD-9에 deadline 규칙 추가)
- 골자 digest: `ded5093c9ac9e1a2` (재동결 2026-11-21. 이전 `e2e59233fbb43395`에서 스펙 DoD-12·36 변경으로 포크 DoD-12·E2E DoD-36의 `@given`만 바뀜)
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/native-eth.md --files __tests__/lib/native-eth-button-state.test.ts __tests__/swap/native-eth-wrap-quote.test.tsx __tests__/swap/native-eth-swap.test.tsx __tests__/swap/wrap-execute.test.tsx __tests__/swap/wrap-progress.test.tsx __tests__/swap/wrap-failure.test.tsx __tests__/fork/native-eth.fork.test.ts e2e/native-eth.spec.ts --frozen ded5093c9ac9e1a2`
- 골격 파일: `__tests__/lib/native-eth-button-state.test.ts`(T-5, 14 case), `__tests__/swap/native-eth-wrap-quote.test.tsx`(T-6, 7), `__tests__/swap/native-eth-swap.test.tsx`(T-7, 9), `__tests__/swap/wrap-execute.test.tsx`(T-8, 8), `__tests__/swap/wrap-progress.test.tsx`(T-9, 3), `__tests__/swap/wrap-failure.test.tsx`(T-10, 5), `__tests__/fork/native-eth.fork.test.ts`(T-11, 5), `e2e/native-eth.spec.ts`(T-16, 4). T-12~T-15는 F7 골격 파일이 없다(이전 기능 동결 골격을 아래 회귀 갱신 결정대로 고친다)
- 기계 검사: 통과. 항목 48개 중 case 연결 48개, 제외 0개, case 55개(단위 14, 통합 32, 포크 5, E2E 4). 전부 `it.todo`/`test.fixme`. 포맷·린트 통과
- 작성 에이전트: seongho:test-dev 4개(T-5·T-6 / T-7·T-8 / T-9·T-10 / T-11), seongho:e2e-dev 1개(T-16). 살 모드는 같은 에이전트가 이어서 맡는다. 세션이 바뀌면 같은 타입의 새 인스턴스에 지시 전문을 다시 주고 구현 기록에 남긴다
- reviewer 라운드: 3회(매번 새 `general-purpose`, 매 라운드 "서술 취향은 관찰로만"·"새 case 요구에는 틀린 구현 예" 지시, 검토 전후 파일 변경 없음 확인)
  - 1라운드 NEEDS-DECISION(Med 1·Low 1, 결정 3, digest `ddc4034b01f268f4`): ETH 입력 클릭 시점 deadline(T0·T1 구분), 포크 위임 코드 복원 확인의 빈 코드 전제. 결정 D-1(DoD-9 deadline 스펙 추가)·D-2(EC-6 잔액 다시 읽기)·D-3(mock 경계 확정). 작성자 해석 8건 중 7건 OK
  - 2라운드 NEEDS-FIX(Med 2·Low 1, digest `cd0606ed9588e0b5`): wrap 상태 환율 행(`quote-rate`) 미판정, EC-7 다른 kind 진행 중 표본 누락, DoD-14·20 RPC 0건 판정 구간 시작
  - 3라운드 NEEDS-FIX(Low 1, digest `676be871742d185d`): 포크 DoD-11·12 `amountOutMinimum` > 0 전제. 반영 후 예외 동결
- 골격 update (2026-11-21, 구현 단계 T-1 결과): 위임 코드가 받은 ETH를 `0xcc04506d439d338bde8ebbb074f17a54b7673b95`로 넘겨 USDC→ETH 포크·E2E가 성립하지 않거나 흔들림 → 사용자 결정으로 스펙 DoD-12·36에 준비 단계 위임 코드 제거·snapshot 복원을 추가하고 두 case `@given`만 갱신. 재검토 방식(사용자 결정): 바뀐 case 한정 새 reviewer 1라운드 → NEEDS-FIX Low 2건(계획 T-11·T-16 기록·완료 조건 미반영), 골자 수정 불요. 계획 반영 후 재동결. 나머지 53개 case는 3라운드 검토 결과를 유지(본문이 채워진 파일은 `--frozen`으로 digest 확인)
- 제외 (사용자 확정): 없음
- mock 경계 (사용자 확정 2026-11-20): T-5 없음(순수 함수). T-6 F3·F4 경계(mock 커넥터, 전역 fetch URL 라우팅 스텁, 가짜 타이머). T-7·T-8 F5 T-9·T-10 경계(스텁 EIP-1193 전송 핸들러, 영수증 스텁, 체인 전환 붙잡기, `Date` 가짜 시계). T-9 F5 T-10 경계 + F6 T-8 잔액 붙잡기. T-10 F6 T-9 경계(cause 주입) + F6 T-6 경계(교체 주입, 가짜 타이머). 통합 공통 `vi.mock` 금지. T-11 mock 없음, 준비 단계에서만 anvil 직접 상태 변경(`anvil_setBalance`·`anvil_dealERC20`·`anvil_setCode` 위임 코드 제거·snapshot/revert). T-16 F5 T-13·F6 T-12 경계 + 준비 단계에서만 러너→anvil 위임 코드 제거·WETH 절대값 주입, `page.route` 금지, 제품 코드 무변경
- 해석 결정 (사용자 확정): EC-1 표본에 체인 전환 4001 포함. EC-6 표본에 대체 영수증 status(success·reverted) 포함, replaced 뒤 phase idle과 카드 잔액(ETH·WETH) 다시 읽기 판정(D-2). 포크 DoD-25는 unwrap case와 "revert 뒤 위임 코드 복원" 보조 case로 나누고 지우기 전 코드가 위임 표식(`0xef0100`)임을 전제. DoD-4에 `allowance-error` 포함. DoD-6 인접 경계 공존 6·배타 14. wrap 견적 DoD-18·19는 Ethereum 표본(다른 체인은 DoD-14·단위·T-8 전제가 덮음). E2E는 스펙이 이름을 댄 토큰 잔액만 판정(받은 ETH는 포크 DoD-12). DoD-14·20의 RPC 수는 두 토큰이 ETH·WETH가 된 시점부터 센다
- 미검증 (경계의 한계): 실제 지갑(MetaMask·EIP-7702 스마트 계정)의 unwrap 동작과 위임 코드가 남은 계정의 실패 형태(스펙 비목표). Base·Arbitrum 실제 체결(통합 스텁만). 가스 추정 실패는 지갑 `eth_sendTransaction` -32000으로만 표현(제품이 별도 `estimateGas`를 부르는 경로는 미검증). DoD-33 "트랜잭션 체인 기준 무효화"는 표본이 선택 체인 = tx 체인이라 구분 못 함. E2E DoD-36·38의 위임 코드 복원은 본문 전제 확인(골자 밖). 3라운드 반영분 1건은 독립 재검토를 받지 않았다
- 7단계 코드 대조 항목: wrap·unwrap 요청에 deadline·`refundETH` 없음, `ADDRESS_THIS` 값, SwapRouter02 ABI 추가가 `unwrapWETH9(uint256,address)` 하나, WETH ABI 두 함수, 새 `data-testid` 없음, `balanceDropped`는 approve 성공에만, `wrap`·`unwrap` reject 없음(§4.2, 실패 경로 resolve 판정 case 없음), 이전 스펙 파일 무변경, RPC 프록시 허용 메서드 무변경
- 본문 작성 주의: T-7이 `__tests__/support/wagmi-harness.tsx`(필요하면 `stub-eip1193.ts`)를 추가만으로 먼저 확장한다. 표본 금액·티어·가격 영향 등급은 T-1 결과를 따른다(기본 스텁의 가격 영향은 토큰 주소 순서에 따라 `normal`·`error`로 갈린다). T-6 DoD-14의 "잔액 읽기가 아닌 JSON-RPC"는 F3 EC-6 본문(`__tests__/swap/quote-read.test.tsx:466-520`)의 분류 기준을 확인해 쓴다. EC-2의 체인 전환 실패 code는 본문에서 리터럴로 고정한다. DoD-5 단위 표본 공간이 커서 실행 시간을 확인한다. `vitest list --json` 등 파일을 쓰는 옵션 금지. `check:build`와 `test:e2e`는 동시에 실행하지 않는다
- 범위 밖 메모(reviewer 관찰): wrap·unwrap 진행 중에 `approve`·`swap`을 호출하는 경우(F5 EC-19의 "진행 중")는 F7 항목이 없다. F5 EC-19 기존 case가 그대로 통과하는지 T-15에서 확인한다
- 회귀 갱신 결정 (사용자 확정 2026-11-20, 구현 T-12~T-15에서 수행. 동결 골격의 `@then`·이름·`@given`을 아래대로 바꾸고 digest 전후를 기록한다)
  - 공통: 기본 견적 스텁의 가격 영향은 토큰 주소 순서에 따라 달라진다(Ethereum ETH→USDC·ETH→DAI는 `normal`, USDC→ETH·DAI→ETH와 Base·Arbitrum ETH→USDC는 `error`). 상태 기대가 `swap-ready`인 표본은 이 등급을 확인하고, 필요하면 `parityQuoteRule`을 쓴다
  - F2 (T-12): `__tests__/swap/primary-button.test.tsx` DoD-38(:375) `quote-ready`·비활성 → `swap-ready`·활성(이름도), EC-25 두 case(:411, :438) `quote-ready` → `swap-ready`, EC-11(:491) → `swap-ready`이고 `@given`에 "스텁은 견적을 가격 영향 `error` 등급이 아니고 최소 수령량이 0보다 크게 응답한다" 추가(본문 `parityQuoteRule`). `e2e/swap-form.spec.ts` DoD-38(:404) → `@then 주 버튼 상태가 select-token·enter-amount·insufficient-balance가 아닌 견적 뒤 상태 중 하나다`, 비활성 `@then` 삭제, 이름에서 "quote-ready … 비활성" 제거. 상태 목록 상수(`primary-button`·`balances`·`restore`)와 `e2e/support/app.ts` 정규식 두 개에서 `quote-ready` 제거·새 상태 추가
  - F3 (T-13): `__tests__/lib/swap-quote.test.ts` EC-6(:358) → 견적 상태 `wrap`이고 수령량이 보내는 정수량과 같다(이름 "…wrap이다"). `__tests__/swap/quote-read.test.tsx` DoD-6·DoD-7 괄호 문구(:378, :419) `quote-ready` → `swap-ready`, EC-6(:467) → status `wrap`·quote null·amountOut = amountInRaw, 주 버튼 ETH→WETH `wrap-ready`·WETH→ETH `unwrap-ready`이고 활성, RPC 0건 `@then` 유지(이름 "…즉시 wrap이고 wrap-ready·unwrap-ready다"), EC-16(:643) → `swap-ready`. `__tests__/swap/quote-display.test.tsx` DoD-11 등(:243) → `price-impact-too-high`이고 비활성(스텁 유지), EC-15(:616) → `price-impact-too-high`(이름도). `__tests__/swap/quote-refresh.test.tsx` DoD-30(:475)·EC-9(:555) → `swap-ready`. `__tests__/swap/quote-button.test.tsx` DoD-31(:303) `quote-ready` → `swap-ready`. `e2e/quote.spec.ts` DoD-11 등(:223) → `swap-ready`·활성(이름도), EC-6(:315) → `wrap-ready`·활성, QuoterV2 0건 유지(이름도). 상태 목록 상수 4곳 정리
  - F4 (T-14): 태그 변경 없음. `e2e/slippage.spec.ts:114` 대기 상태 `quote-ready` → `swap-ready`, 상태 목록 상수 3곳 정리. digest 유지
  - F5 (T-15): `__tests__/lib/primary-button-state.test.ts`의 DoD-5 두 case(:786, :812)와 `__tests__/swap/approve-swap-button.test.tsx` DoD-6 case(:258)를 삭제하고 F5 동결 확인 명령의 `--exempt`에 DoD-5·DoD-6을 더한다(사유: F7 DoD-6·DoD-1~4로 대체, F7 T-5가 검증). `__tests__/swap/swap-execute.test.tsx` EC-19(:684) `@given` 표본: approve는 `swap-ready`(보내는 ETH, 받는 USDC, 금액 `1`), swap은 `wrap-ready`(보내는 ETH, 받는 WETH, 금액 `1`)
  - F6: 변경 없음, digest 유지
  - 수행 결과(구현 단계): F2 `12a88df2f0bb1e2a` → `a8d00ddb8b88e8f7`, F3 `8acf896e2a4dffdd` → `6a48e7cea8e0d4ed`, F5 `74b2bc4d3dfcc0aa` → `b17ea048db48454a`(파일 `__tests__/lib/primary-button-state.test.ts` 삭제, `--exempt` DoD-5·DoD-6 추가). F1 `6afdf2fb5d08e92c`·F4 `3af643e844b77259`·F6 `8a07e4e0f647896f` 유지

### 검증 기록

- 코드 기준: `ec1a894` + 커밋 전 작업 트리(2026-11-21). 세 검증 모두 실행 전후 작업 트리 동일(오케스트레이터 스냅샷 비교: HEAD·`git status --porcelain`·`git diff` 해시·미추적 파일 해시, 각 실행 에이전트 `git status` 비교). 검증 중 파일 변경 없음
- 스펙 대조(새 general-purpose + `seongho:verify`, 실행 없음): 48개 항목 코드 대조 충족 40·검증 불가 8(DoD-11·12·24·25·35·36·37·38, 체결·잔액 결과는 실행 근거 필요, 코드 경로는 일치)·부분 0·미충족 0. 스코프 초과 0, 스펙 드리프트 0, 엣지 케이스 누락 0, 제품 결함 0. §4 계약 전부 충족. F1~F7 골자 동결 일치, F7 todo·fixme·skip·only 0건. 이전 기능 테스트 변경은 회귀 결정 범위 안. 7단계 코드 대조 항목 9개 모두 충족
- 테스트 실행(`seongho:test-runner`): `format:check`·`lint`·`typecheck`·`build` 통과, `bun run test` 3회 모두 45 파일 324/324, `test:fork` 5 파일 18/18, Task별 T-5 14/14·T-6 7/7·T-7 9/9·T-8 8/8·T-9 3/3·T-10 5/5·T-11 5/5, F1~F7 동결 확인 일치, 미구현·건너뜀 표기 0건. `check:build`는 E2E 실행 뒤 단독 실행으로 통과(키 노출·mock 표식 음성·양성 검사)
- E2E 실행(`seongho:e2e-runner`): `test:e2e e2e/native-eth.spec.ts` 4/4(S1 DoD-35, S2 DoD-36, S3 DoD-37, S4 DoD-38, 위임 코드 복원 보조 확인 포함), `test:e2e` 전체 33/33(1 worker, 재시도 0, flaky 0). 실행 뒤 남은 대기 셸 루프 1개는 오케스트레이터가 종료(포트·파일 영향 없음)

| 스펙 항목           | 코드 대조 | 실행 확인 (근거 case)                                                                                                   | 종합 |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- | ---- |
| DoD-1·4             | 충족      | 확인됨 (`native-eth-button-state` DoD-1·DoD-4×4, `native-eth-swap` DoD-1·DoD-4×2, 회귀 `primary-button`·`swap-execute`) | 충족 |
| DoD-2·3·5·6         | 충족      | 확인됨 (`native-eth-button-state` DoD-2·3·5·6×2, 회귀 `quote-display` DoD-11·EC-15)                                     | 충족 |
| DoD-7·8·9·10·13     | 충족      | 확인됨 (`native-eth-swap` DoD-7/8×2, DoD-9×2, DoD-10, DoD-13)                                                           | 충족 |
| DoD-11·12·24·25     | 충족      | 확인됨 (`native-eth.fork` 5 case, 포크 18/18)                                                                           | 충족 |
| DoD-14·15·16·17·20  | 충족      | 확인됨 (`native-eth-wrap-quote` DoD-14~17·DoD-20, 회귀 `swap-quote`·`quote-read` EC-6)                                  | 충족 |
| DoD-18·19           | 충족      | 확인됨 (`native-eth-button-state` DoD-18·19, `native-eth-wrap-quote` DoD-18·19, E2E `quote` EC-6)                       | 충족 |
| DoD-21·22·23·26     | 충족      | 확인됨 (`wrap-execute` DoD-21·22·23·26)                                                                                 | 충족 |
| DoD-27~33 (34 삭제) | 충족      | 확인됨 (`wrap-progress` DoD-27·28·29·30, DoD-31·32·33)                                                                  | 충족 |
| DoD-35·36·37·38     | 충족      | 확인됨 (E2E `native-eth` S1~S4, 단독·전체 2회)                                                                          | 충족 |
| EC-1·2·3·5·6        | 충족      | 확인됨 (`wrap-failure` EC-1·2·3·5·6)                                                                                    | 충족 |
| EC-4                | 충족      | 확인됨 (`native-eth-button-state` EC-4×2)                                                                               | 충족 |
| EC-7·8              | 충족      | 확인됨 (`wrap-execute` EC-7×3·EC-8)                                                                                     | 충족 |
| EC-9·10             | 충족      | 확인됨 (`native-eth-wrap-quote` EC-9×2·EC-10)                                                                           | 충족 |
| EC-11               | 충족      | 확인됨 (`wrap-progress` EC-11)                                                                                          | 충족 |

- 미검증(경계의 한계, 스펙 비목표): 실제 지갑(MetaMask·EIP-7702 스마트 계정)의 unwrap과 위임 코드가 남은 계정의 실패 형태, Base·Arbitrum 실제 체결(통합 스텁만), 가스 추정 실패는 지갑 -32000 응답으로만 표현, DoD-33의 tx 체인과 선택 체인 구분, §4.2 wrap·unwrap 실패 경로 resolve 판정 case 없음(코드 대조로 try/catch 확인). 포크 테스트는 지갑 역할로 gas 상한(추정 ×1.2)을 지정하므로 지갑 가스 추정 경로는 E2E mock 커넥터 경로가 대표
- verify가 보고한 결함·위생(스펙 항목 영향 없음): (1) [Low, 테스트 결함] `e2e/support/app.ts:67-68` `waitForRestoreSettled` 지역 정규식에 `quote-ready`가 남고 `wrap-ready`·`unwrap-ready`가 없다(복원 직후 ETH↔WETH로 끝나는 E2E가 생기면 대기 초과, 현재 해당 시나리오 없음. 회귀 결정의 "정규식 두 개" 범위 밖) (2) [위생] `lib/primary-button-state.ts`의 `isEthPair` export를 제품에서 쓰지 않는다
- 스펙 모호(Low, 결함 아님): DoD-1의 "받는 토큰이 WETH가 아닌 ERC-20" 조건을 코드는 따로 검사하지 않는다. ETH→WETH는 견적이 `wrap`이라 `success` 분기에 오지 않아 결과는 같다
- 재검증(8단계 사용자 결정 2026-11-21, 위 결함 (1)·위생 (2) 수정 뒤): 코드 기준 변경 범위는 `lib/primary-button-state.ts`(`isEthPair` 삭제)와 `e2e/support/app.ts`(`waitForRestoreSettled` 정규식) 두 곳. 새 인스턴스 셋으로 다시 실행: 스펙 대조(general-purpose, 범위 한정, 실행 없음) PASS — 참조 0건, 정규식이 §4.3 끝난 상태 14개와 일치, DoD-1·5·6·§4.3 충족 유지, F1부터 F7까지 동결 일치. `seongho:test-runner`: `format:check`·`lint`·`typecheck`·`build` 통과, `bun run test` 45 파일 324/324, 동결 확인 일치, 이어서 단독 `check:build` 통과. `seongho:e2e-runner`: `test:e2e` 전체 33/33(native-eth 4/4, 재시도·flaky 0). 세 실행 모두 전후 작업 트리 동일. 결함·위생 2건 해소
