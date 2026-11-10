# 계획: token-amount-input

- 상태: 승인
- 스펙: docs/specs/token-amount-input.md
- 기준 코드: fdc41f1 + 작업 트리
- 최종 갱신: 2026-11-10

## 1. 구현 전략

- 순서는 사전 확인, 순수 함수·config, 입력 상태·잔액 데이터 계층, 화면, 테스트 본문(단위·통합·포크·E2E·F1 회귀), 수동 확인과 전체 검사다. 근거: `docs/plans/wallet-chains.md` §4
- 판정 로직(금액 문자열 처리, 잔액 표시, `최대`, 정렬·검색, 주 버튼 입력 상태)은 `lib/` 순수 함수로 분리해 단위 테스트한다. 숫자 표시는 로캘 API 없이 bigint로 만든다. 근거: `lib/selected-chain.ts`, `__tests__/lib/selected-chain.test.ts`
- 입력 상태 Provider는 `providers/app-providers.tsx`의 `WalletRestoreBoundary` 안쪽에 둔다. `renderAppHook`(`__tests__/support/wagmi-harness.tsx`)으로 `useSwapForm()`을 관찰할 수 있고, SSR 초기값은 `useSelectedChain()`의 초기 체인에서 정해진다. 근거: `providers/selected-chain-provider.tsx`
- 체인 변경 리셋과 모달 닫힘은 key 리마운트가 아니라 상태에 chainId를 함께 두고 선택 체인과 비교해 파생한다. Provider가 페이지 전체를 감싸므로 리마운트하면 헤더와 연결 모달까지 다시 마운트된다.
- 모든 잔액 읽기는 `chainId`에 선택 체인을 명시하고, 계정은 `useWalletRestore()`의 연결 주소만 쓴다. wagmi는 `chainId`를 생략하면 지갑 체인을 쓴다. 근거: `node_modules/@wagmi/core/src/createConfig.ts`, `hooks/use-wallet-restore.ts`
- 카드 잔액은 wagmi 읽기 훅으로 읽고, react-query 자체 재시도는 끈다. react-query v5 focusManager는 `visibilitychange`만 들으므로 window `focus` 처리를 따로 둔다. 근거: `node_modules/@tanstack/query-core/src/focusManager.ts`
- 모달 잔액은 wagmi `readContracts`를 쓰지 않는다. multicall 실패 시 계약별 개별 호출로 fallback하기 때문이다. 대신 viem Client를 받는 `lib/` 비동기 함수가 `getBalance` 1회와 `multicall`(`allowFailure: true`, 명시 `batchSize`)을 실행한다. 포크 테스트가 같은 함수를 프록시 핸들러에 연결해 재사용한다. 근거: `node_modules/@wagmi/core/src/actions/readContracts.ts`, `node_modules/viem/actions/public/multicall.ts`, `__tests__/fork/fork.fork.test.ts`
- 화면은 `components/swap-card.tsx`를 서버 컴포넌트로 두고 클라이언트 하위 컴포넌트를 더한다. 모달은 제어형 Dialog, 로고는 img 요소와 글자 대체를 쓴다. SSR HTML에 `data-state="disconnected"` 요소를 새로 만들지 않는다. 근거: `components/connect-modal.tsx`, `e2e/wallet.spec.ts`
- mock 경계는 F1 관례를 따른다. 실제 wagmi·Provider에 지갑 자리만 mock 커넥터나 스텁 EIP-1193으로 바꾸고, RPC는 전역 fetch 스텁으로 바꾸며 `vi.mock`은 쓰지 않는다. E2E의 anvil 상태 주입은 새 경계라 테스트 설계 단계에서 사용자가 확정한다. 근거: `docs/plans/wallet-chains.md` 테스트 설계 증거

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: 스펙의 구현 전 확인 사실 2건과 테스트 기대값이 기대는 포크 사실을 실행으로 확인한다
- 선행: 없음
- 연결 항목: DoD-9, DoD-13, DoD-22, DoD-24, DoD-30, EC-14
- 수정 대상: 없음 — 저장소 밖 임시 위치에서 전용 포트(8546·8547 외)의 anvil 포크로 확인한다
- 따라야 할 패턴: 저장소 밖 확인, 결과는 구현 기록에 남김 — 근거: `docs/plans/wallet-chains.md` T-1
- 완료 조건: 다음 결과를 구현 기록에 남기고, 스펙 확인 사실 2건이 결정과 어긋나면 인터뷰로 되돌린다. (1) Ethereum 484개 `balanceOf` aggregate3의 요청 본문 바이트, 사용 가스, 포크·업체 RPC·공개 RPC에서의 성공 여부, Base·Arbitrum 공개 RPC 결과, 이를 근거로 정한 `batchSize` (2) mock 계정에 ERC-20 잔액 주입 가능 여부와 방법(로컬 anvil과 CI Foundry 기본 버전) (3) 포크 블록 기준 mock 계정의 기존 ERC-20 잔액 (4) 포크에서 개별 `balanceOf`가 실패하는 토큰 (5) cold 포크에서 일괄 읽기 지연과 프록시 상류 시간 제한 비교 — 검증: 확인 절차
- 실행 명령: `anvil --fork-block-number 26250000`, `cast call`, `cast rpc`, `cast estimate`
- 수정 금지: 저장소 파일
- 구현 기록: seongho:frontend-dev, 수정 파일 없음(저장소 밖, 포트 8555). 수정 0/3. 결과: (1) 484개 aggregate3 1회 본문 217,099 B·가스 4,811,423, 2회 각 ≤124,360 B·≤2.77M, 포크·업체·공개 RPC 모두 484/484 성공, Base 195·Arbitrum 227 공개·업체 성공. `batchSize` 10_000(호출 데이터 바이트 기준) → Ethereum 2회, Base·Arbitrum 1회 (2) `anvil_dealERC20`(인자 순서 계정·토큰·양)과 `anvil_setStorageAt` 주입 가능, anvil 1.5.1(stable)·1.8.1·1.9.0 확인 (3) 포크 블록 mock 계정 ERC-20 잔액 484개 모두 0, ETH 10000(anvil 설정) (4) 개별 `balanceOf` 실패 토큰 없음, `anvil_setCode`(LINK revert, PEPE 빈 코드)로 실패 표본 생성·revert 확인 (5) cold 포크 일괄 읽기 약 95초(2회 병렬)·174초(1회)로 프록시 상류 시간 제한 5초 초과 → 프록시는 공개 RPC로 fallback, warm 30~70 ms. 판정 구분 표본: USDC/WETH 풀 `0x88e6…5640`의 USDC 잔액이 포크 블록과 latest에서 다름. 스펙 확인 사실 2건 결정과 일치

### T-2 — 순수 함수와 config

- 사이드: 프론트
- 상태: 완료
- 목적: 금액 문자열 처리, 잔액 표시, `최대`, 주 버튼 입력 상태 판정, 목록 정렬·검색을 순수 함수로 만든다
- 선행: 없음
- 연결 항목: DoD-9, DoD-10, DoD-11, DoD-12, DoD-15, DoD-16, DoD-27, DoD-28, DoD-29, DoD-30, DoD-31, DoD-32, DoD-35, DoD-36, DoD-37, DoD-38, EC-5, EC-11, EC-14, EC-15, EC-17, EC-20, EC-21, EC-23, EC-24, EC-25, EC-26, EC-27, EC-28, EC-29
- 수정 대상: `config/gas-reserve.ts` — 신규, 가스 예약량 상수. `config/tokens.ts` — 네이티브 ETH `logoURI`(스펙 §4.4)만. `config/chain-icons.ts` — 신규, 체인 아이콘 URL(스펙 §4.4). `lib/token-amount.ts` — 신규, 표시·입력 정리·정수 변환·decimals 자르기·`최대` 문자열. `lib/token-list.ts` — 신규, 정렬과 검색. `lib/swap-input-state.ts` — 신규, 주 버튼 입력 상태 판정
- 따라야 할 패턴: 관심사별 config 파일, `lib/` 순수 함수, kebab-case 파일명과 named export — 근거: `config/contracts.ts`, `lib/selected-chain.ts`, `CLAUDE.md`
- 완료 조건: 연결 항목 충족, 로캘 API 미사용, 빈 값·`.`·`1.`·decimals 0 토큰 경로가 스펙 계약대로 동작 — 검증: T-5
- 실행 명령: `bun run typecheck`, `bun run test __tests__/lib`
- 수정 금지: `components/`, `providers/`, `hooks/`, 기존 `config/`·`lib/` 파일(`config/tokens.ts`의 네이티브 ETH `logoURI` 한 곳 제외)
- 구현 기록: seongho:frontend-dev, 작성 영역 `config/gas-reserve.ts`, `lib/token-amount.ts`, `lib/token-list.ts`, `lib/swap-input-state.ts`. 수정 0/3. export: `GAS_RESERVE_BY_CHAIN`, `formatTokenAmount`, `sanitizeAmountInput`, `parseAmountRaw`, `truncateAmountDecimals`, `isNativeToken`, `getMaxAmountRaw`, `formatMaxAmount`, `sortTokenList`, `filterTokenList`, `getSwapInputState` 8단계 사용자 수정 요청(2026-11-09, 예산 별도, seongho:frontend-dev, 수정 파일 `config/tokens.ts`): 네이티브 ETH `logoURI`(스펙 §4.4). 2026-11-10 사용자 요청(예산 별도): `config/chain-icons.ts` 체인 아이콘 URL.

### T-3 — 입력 상태와 잔액 데이터 계층

- 사이드: 프론트
- 상태: 완료
- 목적: `useSwapForm()` 컨텍스트, 카드·모달 잔액 훅, 일괄 잔액 읽기 함수를 만든다
- 선행: T-1, T-2
- 연결 항목: DoD-1, DoD-2, DoD-6, DoD-7, DoD-8, DoD-13, DoD-14, DoD-17, DoD-18, DoD-19, DoD-20, DoD-21, DoD-22, DoD-23, DoD-24, DoD-29, DoD-39, EC-1, EC-3, EC-6, EC-7, EC-8, EC-12, EC-13, EC-14, EC-30, EC-31, EC-32
- 수정 대상: `providers/swap-form-provider.tsx` — 신규, Provider·`useSwapForm()`·계약 밖 변경 함수 훅·체인 변경 파생 리셋. `providers/app-providers.tsx` — `WalletRestoreBoundary` 안쪽에 마운트. `hooks/use-token-balance.ts` — 신규, 카드 잔액. `hooks/use-token-list-balances.ts` — 신규, 모달 잔액. `lib/token-balances.ts` — 신규, ETH 1회와 ERC-20 multicall 일괄 읽기
- 따라야 할 패턴: Provider와 훅을 한 파일에 둠, 연결 판정은 `useWalletRestore`, 시간 값은 export 상수 — 근거: `providers/selected-chain-provider.tsx`, `hooks/use-wallet-restore.ts`
- 완료 조건: 연결 항목 충족, 모든 읽기에 `chainId` 명시, 미연결·복원 중 RPC 요청 0회, 모달 읽기 실패 시 계약별 fallback 요청 없음, `batchSize`는 T-1 결과를 따름 — 검증: T-6, T-7, `bun run typecheck`
- 실행 명령: `bun run typecheck`
- 수정 금지: `components/`, `config/wagmi.ts`, `config/rpc.ts`, `lib/rpc-proxy.ts`, `hooks/use-wallet-restore.ts`, T-2 파일
- 구현 기록: seongho:frontend-dev, 작성 영역 `providers/swap-form-provider.tsx`, `providers/app-providers.tsx`, `hooks/use-token-balance.ts`, `hooks/use-token-list-balances.ts`, `lib/token-balances.ts`. 수정 0/3. export: `SwapFormProvider`, `useSwapForm`, `useSwapFormActions`(`selectToken`, `flipTokens`, `setAmountInput`, `setMaxAmount`), `useSwapFormBalances`, `useTokenListBalances(open)`, `readTokenListBalances`, `TOKEN_LIST_MULTICALL_BATCH_SIZE`=10_000, `CARD_BALANCE_REFETCH_INTERVAL_MS`=15_000. 구현 판단: 잔액 읽기는 wagmi 클라이언트의 `batch.multicall`을 끈 사본 사용(DoD-23), 모달 일괄 읽기는 요청 하나라도 실패하면 전체 실패로 처리, 숨김 탭에서는 15초 주기 정지·포커스 복귀 시 재읽기

### T-4 — 화면

- 사이드: 프론트
- 상태: 완료
- 목적: 보내는 칸·받는 칸, 뒤집기, 토큰 모달, 로고 대체, 주 버튼 F2 상태를 만든다
- 선행: T-3
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-7, DoD-9, DoD-11, DoD-13, DoD-14, DoD-20, DoD-27, DoD-30, DoD-31, DoD-33, DoD-34, DoD-35, DoD-36, DoD-37, DoD-38, EC-2, EC-3, EC-4, EC-5, EC-7, EC-9, EC-10, EC-11, EC-13, EC-15, EC-16, EC-18, EC-19, EC-21, EC-22, EC-23, EC-25, EC-30, DoD-41, DoD-42, EC-33
- 수정 대상: `components/swap-card.tsx` — 칸 배치, 서버 컴포넌트 유지. `components/token-field.tsx` — 신규, 칸·토큰 버튼·금액·잔액·`최대`. `components/token-modal.tsx` — 신규, 모달·검색·행·빈 결과. `components/token-logo.tsx` — 신규, 로고와 글자 대체. `components/primary-button.tsx` — 상태 확장, `ready` 제거, 문구. `components/chain-select.tsx` — 체인 아이콘(스펙 §1.1, F1 컴포넌트, 접근성 이름·식별자 유지)
- 따라야 할 패턴: 제어형 Dialog와 글자 대체 아이콘, 주 버튼 분기·클래스, 디자인 기준 — 근거: `components/connect-modal.tsx`, `components/primary-button.tsx`, `docs/design/README.md`, `docs/design/wireframe/a-token.png`, `docs/design/wireframe/a-desktop.png`
- 완료 조건: 연결 항목 충족, 스펙 §4.1·§4.2 식별자·속성 값 일치, SSR HTML에 `data-state="disconnected"` 요소 추가 없음, 프로덕션 빌드 통과 — 검증: T-6, T-8, `bun run build`
- 실행 명령: `bun run build`, `bun run lint`
- 수정 금지: `config/`, `providers/`, `hooks/`, `lib/`, `app/`(`config/chain-icons.ts`는 읽기만)
- 구현 기록: seongho:frontend-dev, 작성 영역 `components/swap-card.tsx`, `components/primary-button.tsx`, `components/token-field.tsx`, `components/token-modal.tsx`, `components/token-logo.tsx`. 수정 1/3(원인: 7단계 재검증 EC-18 부분 충족 — SSR로 렌더된 초기 ETH 카드 로고가 하이드레이션 전에 로드 실패하면 `error`가 `onError`에 닿지 않아 글자 대체가 안 됨). 구현 판단: 문구는 시안(a-desktop·a-token)에서 가져옴, 토큰이 미선택인 칸은 연결 상태여도 잔액·`최대` 미표시, 모달을 닫으면 검색어 초기화, 글자 대체는 심볼 원문 첫 글자. 실제 `next start` SSR은 미확인(`renderToString`으로 대체 확인) 8단계 사용자 수정 요청(2026-11-09, 예산 별도, seongho:frontend-dev, 수정 파일 `components/token-modal.tsx`): 검색 입력을 알약형·크게(반경 100px, 높이 52px, 글자 16px, 아이콘 20px, 포커스 민트 테두리). 2026-11-10 사용자 요청(예산 별도): 검색 debounce 250ms(`TOKEN_SEARCH_DEBOUNCE_MS`), `token-list-skeleton`, 목록 영역 고정 높이. 2026-11-10 사용자 요청(예산 별도): 헤더 체인 드롭다운 아이콘, 스왑 카드 최대 폭 560px, 금액 글자 28px(30px에서 예시 20자 값이 9px 부족해 사용자 결정으로 조정).

### T-5 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 순수 함수와 config 값을 검증한다
- 선행: T-2
- 연결 항목: DoD-9, DoD-10, DoD-11, DoD-12, DoD-15, DoD-16, DoD-27, DoD-28, DoD-29, DoD-30, DoD-31, DoD-32, EC-17, EC-20, EC-21, EC-24, EC-25, EC-26, EC-27, EC-28, EC-29
- 수정 대상: `__tests__/lib/token-amount.test.ts`, `__tests__/lib/token-list.test.ts`, `__tests__/lib/swap-input-state.test.ts` — 신규
- 따라야 할 패턴: 순수 함수 단위 테스트 — 근거: `__tests__/lib/selected-chain.test.ts`
- 완료 조건: 연결 항목 판정, DoD-15는 기본 로캘이 아닌 환경에서도 같은 결과로 판정, EC-17은 전체 주소 표본 사용 — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib`
- 수정 금지: 제품 코드
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/lib/token-amount.test.ts`, `__tests__/lib/token-list.test.ts`, `__tests__/lib/swap-input-state.test.ts`. 수정 0/3. 완성 25 case, todo 0. DoD-15는 en-US·de-DE 모두 같은 로캘 기본값 스텁 방식으로 고정(호스트 로캘 비의존)
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: (사용자 확정) 없음. 예외로 DoD-15에 한해 `Intl.NumberFormat`과 Number·BigInt `toLocaleString`의 기본 로캘을 `de-DE`로 바꾸는 전역 스텁을 허용한다. 스텁이 잡지 못하는 로캘 의존은 7단계 코드 대조(로캘 API 미사용)로 확인한다
- 데이터 격리: 순수 함수와 정적 데이터만 사용, 로캘 스텁은 테스트마다 원복

### T-6 — 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 실제 Provider·wagmi 위에서 토큰 선택, 입력, 잔액, 주 버튼, 상태 계약을 검증한다
- 선행: T-3, T-4
- 연결 항목: DoD-1, DoD-3, DoD-4, DoD-5, DoD-6, DoD-7, DoD-8, DoD-11, DoD-14, DoD-17, DoD-18, DoD-19, DoD-20, DoD-21, DoD-22, DoD-23, DoD-27, DoD-29, DoD-33, DoD-34, DoD-35, DoD-36, DoD-37, DoD-38, DoD-39, EC-1, EC-2, EC-3, EC-4, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13, EC-14, EC-15, EC-16, EC-18, EC-19, EC-20, EC-21, EC-22, EC-23, EC-25, EC-30, EC-31, EC-32, DoD-41, DoD-42, EC-33
- 수정 대상: `__tests__/swap/token-select.test.tsx`, `__tests__/swap/amount-input.test.tsx`, `__tests__/swap/balances.test.tsx`, `__tests__/swap/primary-button.test.tsx`, `__tests__/swap/swap-form-state.test.tsx` — 신규. `__tests__/support/rpc-balance-stub.ts` — 신규, 잔액 RPC 응답기와 메서드별 요청 수 집계. `__tests__/support/stub-eip1193.ts` — 계정 변경 헬퍼 추가만. `__tests__/support/wagmi-harness.tsx` — 대기 헬퍼 추가만
- 따라야 할 패턴: 앱 전체 렌더 하네스와 fetch 스텁 — 근거: `__tests__/support/wagmi-harness.tsx`, `__tests__/support/rpc-fetch-stub.ts`, `__tests__/wallet/use-ensure-chain.test.tsx`
- 완료 조건: 연결 항목 판정, DoD-22·DoD-23은 모달을 연 뒤 메서드별 요청 수로 판정, DoD-17~21·EC-2·EC-12·EC-18의 판정 방식은 테스트 설계 단계에서 확정 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap`
- 수정 금지: 제품 코드, F1 테스트 파일
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/*.test.tsx`, `__tests__/support/rpc-balance-stub.ts`(신규), `__tests__/support/stub-eip1193.ts`(추가만), `__tests__/support/wagmi-harness.tsx`(추가만). 완성 51 case. 수정 1/3(원인: DoD-17·EC-12 실패 — 가짜 타이머 진행 중 응답이 처리되면 react-query 0ms 알림 타이머가 +1ms로 밀려 대기 헬퍼가 실행하지 못함. 진단 seongho:frontend-dev, 제품 결함 아님. 처리: 15초 판정 case만 setInterval 계열만 가짜로 두는 방식으로 테스트 본문 수정) 8단계 사용자 수정 요청(2026-11-09, 예산 별도, seongho:test-dev, 테스트 설계 update): EC-18 첫 case 표본을 logoURI 없는 ETH에서 logoURI 없는 Ethereum 토큰(CT)으로 교체. 2026-11-10 사용자 요청(예산 별도): DoD-41·DoD-42·EC-33 case 3개 본문, DoD-11·EC-16 본문을 검색 반영 대기에 맞춤.
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: (사용자 확정) wagmi·앱 Provider·화면은 실제 코드, 지갑은 mock 커넥터 또는 스텁 EIP-1193(EC-6·EC-8은 스텁), RPC는 전역 fetch URL 라우팅 스텁(aggregate3·`balanceOf`·`eth_getBalance` 응답과 메서드별 요청 수 집계), 가짜 타이머와 DOM 이벤트(`focus`, img `load`·`error`) 발생 허용, `vi.mock` 금지. 판정 예외: 스펙이 계약으로 정한 표시 기호(EC-9의 `—`, EC-18의 심볼 첫 글자)에 한해 해당 요소의 텍스트를 판정한다. 그 밖의 문구·오류 문구 판정은 금지한다
- 데이터 격리: 테스트마다 config 새로 생성과 스텁 초기화, `clearCookies`, QueryClient는 렌더마다 새로 생성

### T-7 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 실제 anvil 포크에서 프록시를 거친 일괄 읽기와 개별 실패 처리를 검증한다
- 선행: T-1, T-3
- 연결 항목: DoD-24, EC-14
- 수정 대상: `__tests__/fork/token-balances.fork.test.ts` — 신규
- 따라야 할 패턴: 프록시 핸들러 직접 호출과 고정 블록 판정 — 근거: `__tests__/fork/fork.fork.test.ts`
- 완료 조건: 연결 항목 판정, 일괄 읽기는 viem `http` transport의 `fetchFn`을 프록시 핸들러에 연결해 실행, EC-14 표본은 T-1 결과에서 선택 — 검증: 테스트
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드, `__tests__/fork/fork.fork.test.ts`, `__tests__/fork/global-setup.ts`
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/fork/token-balances.fork.test.ts`. 수정 0/3. 완성 2 case. 예열은 최상위 `beforeAll`(240초)에서 anvil 직접 읽기, 판정 계정은 USDC/WETH 풀(포크 블록 USDC 잔액 고정값 비교), EC-14는 snapshot 후 `anvil_setCode`(LINK·PEPE)와 revert
- 테스트 파일·runner: 수정 대상의 파일, `vitest.fork.config.mts`
- mock 허용 경계: (사용자 확정) 없음(실제 anvil 포크와 프록시 코드, `vi.stubEnv`만). T-1 결과로 필요할 때만 두 가지를 허용한다: 실패 토큰 표본을 만드는 anvil 상태 변경(테스트 끝에 snapshot/revert로 되돌림), 판정 대상 호출과 분리한 anvil 직접 사전 읽기
- 데이터 격리: 읽기 전용 호출, 전용 포트

### T-8 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 실제 브라우저·프록시·anvil에서 SSR 초기값, 잔액, 정렬, `최대`, 주 버튼 흐름을 검증한다
- 선행: T-4, T-9
- 연결 항목: DoD-2, DoD-7, DoD-9, DoD-13, DoD-30, DoD-31, DoD-35, DoD-36, DoD-37, DoD-38
- 수정 대상: `e2e/swap-form.spec.ts` — 신규. `e2e/support/anvil.ts` — 신규, 러너에서 anvil 잔액 주입·조회. `e2e/support/swap-form.ts` — 신규, 칸·모달·행 locator
- 따라야 할 패턴: mock 커넥터 연결, SSR 문서 검사, 감시만 하는 네트워크 — 근거: `e2e/support/app.ts`, `e2e/support/ssr.ts`, `e2e/support/network.ts`
- 완료 조건: 연결 항목 판정, DoD-2는 SSR 문서로 판정, DoD-9 기대 순서는 T-1의 기존 잔액 결과 반영, 잔액 기대값은 러너가 anvil에서 직접 읽은 정수와 비교 — 검증: 테스트
- 실행 명령: `bun run test:e2e e2e/swap-form.spec.ts`
- 수정 금지: 제품 코드, F1 E2E 파일
- 구현 기록: seongho:e2e-dev(골격 작성 에이전트, 살 모드), 작성 영역 `e2e/swap-form.spec.ts`, `e2e/support/anvil.ts`, `e2e/support/swap-form.ts`. 수정 0/3. 완성 10 case, fixme 0. 주입은 `anvil_dealERC20`(USDC 절대값, DoD-9는 LINK), 예열은 파일 단위 `beforeAll`(300초). 파일 안 실행은 `mode: "default"`(순차, 실패해도 이후 case 진행)
- 테스트 파일·runner: 수정 대상의 파일, Playwright chromium
- mock 허용 경계: (사용자 확정) mock 커넥터와 E2E 빌드 전용 제어값은 F1 그대로, 러너가 anvil(8546)에 보내는 상태 주입·조회 RPC 허용(사용자 확정: 모달 일괄 읽기 전에 러너가 스냅샷 토큰 잔액을 직접 읽어 포크를 예열한다. cold 포크 일괄 읽기가 약 95초로 프록시 상류 시간 제한 5초를 넘기 때문이며, 그 hook의 시간 제한만 늘린다), `page.route` 가로채기 금지, 앱 코드에 E2E 제어값 추가 금지(필요하면 `config/e2e-mock.ts`의 `installE2EControl` 안에만)
- 데이터 격리: (사용자 확정) 테스트별 브라우저 컨텍스트, 절대값 주입, F2 E2E 파일 안에서 순차 실행, 주입 토큰은 F1 테스트와 겹치지 않음, `evm_snapshot`/`evm_revert`는 도입하지 않음
- 실행 환경: 앱 `localhost:3100`, anvil `localhost:8546`, 포크 블록은 `config/e2e.ts` 상수, mock 계정은 `config/e2e-mock.ts` 상수, 로그인 없음, Base·Arbitrum은 대상 외

### T-9 — F1 회귀 갱신

- 사이드: 테스트
- 상태: 완료
- 목적: F1 테스트·헬퍼의 `ready` 기대를 F2 연결 상태 기대로 바꾸고 F2 잔액 읽기가 F1 jsdom 테스트에 주는 영향을 확인한다
- 선행: T-4
- 연결 항목: DoD-40
- 수정 대상: `__tests__/wallet/restore.test.tsx` — `ready` 기대. `e2e/wallet.spec.ts` — `ready` 기대. `e2e/support/app.ts` — 복원 대기 헬퍼의 상태 목록
- 따라야 할 패턴: F1 동결 골격의 describe·it·주석은 바꾸지 않고 assertion만 바꿈 — 근거: `docs/plans/wallet-chains.md` 테스트 설계 증거
- 완료 조건: 연결 항목 충족, `ready` 참조 0건, F1 jsdom 테스트가 3회 반복에서 결과 동일 — 검증: 명령
- 실행 명령: `bun run test __tests__/wallet`, `bun run test:e2e e2e/wallet.spec.ts e2e/chain.spec.ts e2e/rpc-network.spec.ts`
- 수정 금지: 제품 코드, F2 신규 테스트 파일
- 구현 기록: seongho:test-dev(새 인스턴스), 작성 영역 `__tests__/wallet/restore.test.tsx`, `e2e/wallet.spec.ts`, `e2e/support/app.ts`. 수정 0/3. `ready` 기대 4곳과 복원 대기 헬퍼를 F2 연결 상태 4종 판정으로 교체, F1 골자 digest `6afdf2fb5d08e92c` 유지. 남은 `ready`는 `__tests__/fork/global-setup.ts`의 anvil 준비 대기 지역 변수(상태 기대 아님)
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom과 Playwright chromium
- mock 허용 경계: F1에서 확정한 경계 그대로
- 데이터 격리: F1과 같음
- 실행 환경: T-8과 같음

### T-10 — 수동 확인과 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: Base·Arbitrum 수동 항목과 전체 명령을 마무리한다
- 선행: T-5, T-6, T-7, T-8, T-9
- 연결 항목: DoD-25, DoD-26, DoD-40
- 수정 대상: 없음 — 수동 확인 결과는 PR 본문에 기록
- 따라야 할 패턴: F1 수동 확인 기록 — 근거: `docs/plans/wallet-chains.md` T-13
- 완료 조건: Base·Arbitrum 메인넷에서 실제 지갑으로 연결 상태 잔액 표시와 모달 정렬을 확인해 날짜·블록·계정 축약을 기록, 전체 명령 통과 — 검증: 확인 절차와 명령
- 실행 명령: `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: 오케스트레이터 기록. DoD-25·DoD-26: 2026-11-10 사용자가 Base·Arbitrum 메인넷에서 실제 지갑으로 카드 잔액 표시와 모달 정렬을 확인했다고 보고(세부 기록 없음).

## 3. 항목 coverage

- DoD-1: T-3, T-4, T-6
- DoD-2: T-3, T-4, T-8
- DoD-3: T-4, T-6
- DoD-4: T-4, T-6
- DoD-5: T-4, T-6
- DoD-6: T-3, T-6
- DoD-7: T-3, T-4, T-6, T-8
- DoD-8: T-3, T-6
- DoD-9: T-1, T-2, T-4, T-5, T-8
- DoD-10: T-2, T-5
- DoD-11: T-2, T-4, T-5, T-6
- DoD-12: T-2, T-5
- DoD-13: T-1, T-3, T-4, T-8
- DoD-14: T-3, T-4, T-6
- DoD-15: T-2, T-5
- DoD-16: T-2, T-5
- DoD-17: T-3, T-6
- DoD-18: T-3, T-6
- DoD-19: T-3, T-6
- DoD-20: T-3, T-4, T-6
- DoD-21: T-3, T-6
- DoD-22: T-1, T-3, T-6
- DoD-23: T-3, T-6
- DoD-24: T-1, T-3, T-7
- DoD-25: T-10 — 수동 1회 기록
- DoD-26: T-10 — 수동 1회 기록
- DoD-27: T-2, T-4, T-5, T-6
- DoD-28: T-2, T-5
- DoD-29: T-2, T-3, T-5, T-6
- DoD-30: T-1, T-2, T-4, T-5, T-8
- DoD-31: T-2, T-4, T-5, T-8
- DoD-32: T-2, T-5
- DoD-33: T-4, T-6
- DoD-34: T-4, T-6
- DoD-35: T-2, T-4, T-6, T-8
- DoD-36: T-2, T-4, T-6, T-8
- DoD-37: T-2, T-4, T-6, T-8
- DoD-38: T-2, T-4, T-6, T-8
- DoD-39: T-3, T-6
- DoD-40: T-9, T-10 — 명령 실행 확인
- DoD-41: T-4, T-6
- DoD-42: T-4, T-6
- EC-1: T-3, T-6
- EC-2: T-4, T-6
- EC-3: T-3, T-4, T-6
- EC-4: T-4, T-6
- EC-5: T-2, T-4, T-6
- EC-6: T-3, T-6
- EC-7: T-3, T-4, T-6
- EC-8: T-3, T-6
- EC-9: T-4, T-6
- EC-10: T-4, T-6
- EC-11: T-2, T-4, T-6
- EC-12: T-3, T-6
- EC-13: T-3, T-4, T-6
- EC-14: T-1, T-2, T-3, T-6, T-7
- EC-15: T-2, T-4, T-6
- EC-16: T-4, T-6
- EC-17: T-2, T-5
- EC-18: T-4, T-6
- EC-19: T-4, T-6
- EC-20: T-2, T-5, T-6
- EC-21: T-2, T-4, T-5, T-6
- EC-22: T-4, T-6
- EC-23: T-2, T-4, T-6
- EC-24: T-2, T-5
- EC-25: T-2, T-4, T-5, T-6
- EC-26: T-2, T-5
- EC-27: T-2, T-5
- EC-28: T-2, T-5
- EC-29: T-2, T-5
- EC-30: T-3, T-4, T-6
- EC-31: T-3, T-6
- EC-32: T-3, T-6
- EC-33: T-4, T-6

## 4. 실행 순서

- 병렬: T-1, T-2. T-1은 저장소를 수정하지 않는다
- 병렬: T-3, T-5 (T-1·T-2 이후). T-3은 `providers/`·`hooks/`·`lib/token-balances.ts`, T-5는 `__tests__/lib/`만 수정한다
- 순차: T-4 (T-3 이후)
- 병렬: T-6, T-7, T-9 (T-4 이후). 수정 파일이 겹치지 않는다. T-9의 최종 실행은 T-6이 하네스에 추가한 뒤 다시 한다
- 순차: T-8 (T-9 이후). 갱신된 복원 대기 헬퍼를 쓴다. `test:e2e`는 포트 3100·8546을 독점하므로 T-9의 E2E 실행과 동시에 돌리지 않는다
- 순차: T-10

## 5. 차단 사항

- 없음

## 테스트 설계 증거

- 상태: 예외 동결 (사용자 승인, 2026-11-08). 전체 검토 3회 안에 수렴하지 못해 `REVIEW-BLOCKED`, 사용자 승인으로 한정 검토 1회 후 동결했다
- 기준 스펙: `docs/specs/token-amount-input.md` (상태 확정, 2026-11-08). 테스트 설계 중 스펙 보완: DoD-10·11·21·22·23·32·40, EC-9·10·11·13·21, §1.1 주 버튼 순서, §4.2 `data-selected`·`token-logo`, EC-28~32 추가
- 골자 digest: `20d4ec1b40c60752` (2026-11-10 update 2. 이전 `e25d733c076f6949`, 그 전 `62dcbaf1f36b57be`)
- 동결 확인 명령: `check-skeleton.py --spec docs/specs/token-amount-input.md --files (아래 골격 파일) --exempt DoD-25,DoD-26,DoD-40 --frozen 20d4ec1b40c60752`
- 골격 파일: `__tests__/lib/token-amount.test.ts`, `__tests__/lib/token-list.test.ts`, `__tests__/lib/swap-input-state.test.ts`, `__tests__/swap/token-select.test.tsx`, `__tests__/swap/amount-input.test.tsx`, `__tests__/swap/balances.test.tsx`, `__tests__/swap/primary-button.test.tsx`, `__tests__/swap/swap-form-state.test.tsx`, `__tests__/fork/token-balances.fork.test.ts`, `e2e/swap-form.spec.ts`
- 기계 검사: 통과. 항목 72개 중 case 연결 69개, 제외 3개, case 88개(단위 25, 통합 51, 포크 2, E2E 10). 모두 `it.todo`·`test.fixme`
- reviewer: 전체 검토 3회 모두 `NEEDS-FIX`(1회차 9건 High 1, 2회차 6건 Med 중 1건 `NEEDS-DECISION`, 3회차 4건 Med 2·Low 2). 매 회 새 general-purpose 에이전트, 검토 전후 내용 해시 일치
- update 1회 (2026-11-09, 사용자 결정 스펙 §4.4 네이티브 ETH `logoURI` 추가): EC-18 첫 case 표본을 logoURI 없는 ETH에서 CT로 교체(`@given` 1줄, `@then` 2줄). 바뀐 태그 3줄만 되돌리면 이전 digest가 재현됨을 확인. 새 general-purpose 한정 검토 PASS(finding 없음)
- update 2회 (2026-11-10, 사용자 결정 스펙 추가 DoD-41·DoD-42·EC-33, §4.2 `token-list-skeleton`, §1.1 목록 영역 고정 높이): `__tests__/swap/token-select.test.tsx`에 case 3개 추가(case 91개). 새 case를 빼면 이전 digest가 재현됨을 확인. 한정 검토 1차 `NEEDS-FIX`(F001 미반영 관찰 정의, F002 빈 목록 공허 참, F003 대기 중 비움의 잔존 타이머, F004 case 2 스켈레톤 판정) 반영 후 2차 새 reviewer PASS. 고정 높이는 레이아웃이라 자동 테스트 제외(7단계 코드 대조). mock 경계 변경 없음(T-6 가짜 타이머 허용)
- 한정 검토 1회: 3회차 반영 6곳 대상. 4곳 PASS, `NEEDS-FIX` 2건(EC-11 체인 변경 표본, EC-32 기준 시점)을 제안대로 고쳤고 이 수정은 재검토하지 않았다(기계 검사만)
- 제외 (사용자 확정): DoD-25·DoD-26(T-10 Base·Arbitrum 메인넷 수동 1회 기록), DoD-40(T-9·T-10 명령 실행 확인)
- mock 경계 (사용자 확정): T-5 없음, 단 DoD-15 한정 로캘 기본값 스텁(`de-DE`) 허용. T-6 실제 wagmi·Provider·화면에 mock 커넥터 또는 스텁 EIP-1193, 전역 fetch URL 라우팅 스텁, 가짜 타이머와 `focus`·img `load`·`error` 이벤트, `vi.mock` 금지, 표시 기호(`—`, 심볼 첫 글자)에 한해 텍스트 판정. T-7 없음, T-1 결과로 필요할 때만 상태 변경(snapshot/revert)과 분리된 사전 읽기. T-8 mock 커넥터와 E2E 전용 제어값, 러너→anvil 잔액 주입·조회, 절대값·F1과 겹치지 않는 토큰, snapshot/revert 미도입, `page.route` 금지
- 미검증 (경계의 한계): 실제 Multicall3·RPC 동작은 포크·E2E의 Ethereum에서만 확인, Base·Arbitrum은 수동(DoD-25·26), 실제 브라우저 포커스·이미지 로드, 실제 지갑(MetaMask 등), `—`·첫 글자 외 화면 문구
- 7단계 코드 대조: 로캘 API 미사용(DoD-15), 화면이 `formatTokenAmount` 결과 사용(DoD-14·15), 미연결·복원 중 RPC 요청 0회(T-3), 모달 잔액에 wagmi `readContracts` 미사용(T-3), 모든 잔액 읽기의 `chainId` 명시(EC-8)
- 본문 작성 지시: T-1 결과로 정하는 값(E2E DoD-9 기존 잔액 보유 집합, 포크 EC-14 실패 토큰, DoD-24 포크 기준 판정 근거, `batchSize`). 요청은 JSON-RPC 메서드 항목 수로 세고 카드 `balanceOf`와 모달 aggregate3는 대상 주소·calldata로 구분. aggregate3 스텁은 토큰마다 다른 잔액을 돌려준다. 15초 주기 기준점은 주기 시작 시점, 가짜 타이머는 비동기 진행 사용. EC-2는 모달이 열린 상태에서 Provider의 `setSelectedChainId`로 바꾼다. EC-13은 개별 `balanceOf` 성공 응답 고정. DoD-10 합성 표본은 비고정 토큰, 잔액 크기순과 심볼순을 다르게. E2E는 파일 안 순차 실행
- 주의: 모달 전체 목록 판정(DoD-4, EC-5, DoD-14)은 행이 모두 렌더링된다는 전제다. 구현에서 가상화가 필요하면 판정을 완화하지 않고 결정으로 되돌린다

### 검증 기록

- 코드 기준: `fdc41f1` + 커밋 전 작업 트리(내용 해시 `5e840d40c6c0645b3d9d0efdf11119f9a2a4c514`, 2026-11-09). 세 검증 모두 시작·끝 해시 일치, 검증 중 파일 변경 없음
- 실행(test-runner): format·lint·typecheck·build·check:build 통과, `bun run test` 122/122 3회 반복 동일, `bun run test:fork` 6/6. 포트·프로세스 잔존 없음
- 실행(e2e-runner): `bun run test:e2e` 20/20(F2 10, F1 회귀 10), 재시도 0
- 스펙 대조(verify): 72개 중 충족 66, 부분 충족 2(EC-12, EC-32), 검증 불가 4(DoD-24·40은 실행 근거로 해소, DoD-25·26 수동 대기). 골자 F2 `62dcbaf1f36b57be`·F1 `6afdf2fb5d08e92c` 유지, 스코프 초과 없음

| 스펙 항목                                      | 코드 대조                                                                         | 실행 확인                                     | 종합   |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- | ------ |
| DoD-1, 3~~8, 10~~12, 14~~23, 27~~29, 32~34, 39 | 충족                                                                              | 확인됨 (단위·통합)                            | 충족   |
| DoD-2, 9, 13, 30, 31, 35~38                    | 충족                                                                              | 확인됨 (단위·통합·E2E)                        | 충족   |
| DoD-24                                         | 검증 불가(실행 필요)                                                              | 확인됨 (`test:fork`)                          | 충족   |
| DoD-25, DoD-26                                 | 검증 불가                                                                         | 미실행 (T-10 수동)                            | 미검증 |
| DoD-40                                         | 검증 불가(실행 필요)                                                              | 확인됨 (`test` ×3, `test:e2e`)                | 충족   |
| EC-1~~11, 13~~31 (EC-12 제외)                  | 충족                                                                              | 확인됨 (단위·통합·포크)                       | 충족   |
| EC-12, EC-32                                   | 부분 충족 → 스펙 명시 후 충족 (다시 시도는 읽기 단위, transport 요청 재시도 제외) | 확인됨 (react-query 재시도 없음, 스텁 -32000) | 충족   |

- 8단계 사용자 결정(2026-11-09, 코드 변경 없이 스펙 문구로 명시): (1) EC-12·EC-32의 다시 시도는 읽기 단위, RPC transport 요청 재시도(F1 설정)는 제외(계획 단계 결정의 기록 누락) (2) 일괄 읽기 요청 중 하나라도 실패하면 EC-13·EC-31 경로, EC-14는 개별 `balanceOf` 호출 실패만 (3) DoD-17은 숨김 탭에서 주기 읽기 없음. 스펙 문구 보완 후 골자 digest 유지
- 정보: decimals 0 토큰으로 바꿀 때 `.5`는 빈 값이 된다(DoD-29·EC-29가 정하지 않음, 결과 상태는 `enter-amount`)

#### 재검증 (2026-11-10)

- 8단계 사용자 수정 요청 반영 후: 네이티브 ETH `logoURI`(T-2), 검색 입력 알약형(T-4), 검색 debounce·스켈레톤·목록 고정 높이(T-4, DoD-41·42·EC-33·§1.1·§4.2), EC-18 표본 교체와 새 case 3개(T-6), 7단계 1차 재검증 결함(EC-18 SSR 하이드레이션 전 로고 실패) 수정(T-4 수정 1/3)
- 코드 기준: 커밋 전 작업 트리, 내용 해시 `ee1d12e6c527cde53129161231de19783c37055c`. 세 검증 모두 시작·끝 해시 일치
- 실행(test-runner): format·lint·typecheck·build·check:build 통과, `bun run test` 125/125 3회 동일, `bun run test:fork` 6/6
- 실행(e2e-runner): `bun run test:e2e` 20/20, 재시도 0
- 스펙 대조(verify, 변경분): EC-18, DoD-41, DoD-42, EC-33, §1.1, §4.2 충족, 영향 항목(DoD-11·12, EC-2·16·28) 충족 유지, 스코프 초과·드리프트 없음. 골자 F2 `20d4ec1b40c60752`·F1 `6afdf2fb5d08e92c` 유지
- EC-18 하이드레이션 전 로드 실패 경로: jsdom이 이미지를 로드하지 않아 자동 테스트 없음. 실제 Chromium 수동 확인(오케스트레이터, 개발 서버, CoinGecko 요청 차단): 보내는 칸 ETH 로고 `data-fallback="true"`·글자 `E`, 차단하지 않으면 `data-fallback="false"`
- §1.1 목록 고정 높이: 레이아웃이라 자동 테스트 제외, 코드 대조로 단일 고정 높이 컨테이너 확인(실제 픽셀 높이 미측정)
- 남은 Low 관찰: 대기 중 "미반영" 판정은 스켈레톤과 전체 목록이 함께 그려지는 구현도 허용(현재 구현은 대체 방식)

| 스펙 항목                          | 코드 대조 | 실행 확인                                       | 종합   |
| ---------------------------------- | --------- | ----------------------------------------------- | ------ |
| DoD-1~~24, 27~~40 (DoD-25·26 제외) | 충족      | 확인됨                                          | 충족   |
| DoD-41, DoD-42                     | 충족      | 확인됨 (통합, 가짜 타이머)                      | 충족   |
| DoD-25, DoD-26                     | 검증 불가 | 미실행 (T-10 수동)                              | 미검증 |
| EC-1~33                            | 충족      | 확인됨 (EC-18 하이드레이션 전 경로는 수동 확인) | 충족   |

#### 재검증 2 (2026-11-10)

- 변경: 헤더 체인 드롭다운 아이콘(`config/chain-icons.ts`, `components/chain-select.tsx`), 로고 로딩·실패 처리를 `RemoteLogo`로 분리, 스왑 카드 최대 폭 560px, 금액 글자 28px(스펙 §1.1, §4.4 사용자 결정)
- 코드 기준: 커밋 전 작업 트리, 내용 해시 `c3b41e23f3aee7f6e76c81cc4563a468b4cdda0a`. 세 검증 모두 시작·끝 해시 일치
- 실행(test-runner): format·lint·typecheck·build·check:build 통과, `bun run test` 125/125 3회 동일, `bun run test:fork` 6/6
- 실행(e2e-runner): `bun run test:e2e` 20/20(F1 `chain.spec.ts` option 접근성 이름 선택 포함), 재시도 0
- 스펙 대조(verify, 변경분): §1.1 두 항목, §4.4 체인 아이콘, EC-18, §4.2, F1 DoD-10·11·12·EC-7 충족, 결함·스코프 초과·드리프트 없음. 골자 F2 `20d4ec1b40c60752`·F1 `6afdf2fb5d08e92c` 유지
- 수동 확인(오케스트레이터, 실제 Chromium, 개발 서버): 1280px에서 카드 560px·입력칸 351px·금액 28px, 예시 `0.000619108263649082` 폭 340px로 잘리지 않음. 체인 아이콘 로드 정상. llamao 요청 차단 시 헤더 버튼·목록이 `E`·`B`·`A`로 대체(`data-fallback="true"`)되고 option 접근성 이름은 체인 이름과 같음
- DoD-25·DoD-26: 사용자 수동 확인(2026-11-10, Base·Arbitrum 메인넷, 실제 지갑)
- 남은 검증 공백(Low): 체인 아이콘 URL 값과 대체를 고정하는 자동 테스트 없음(화면 표시라 수동 확인만)

#### 재검증 3 (2026-11-10)

- 변경: Base 체인 아이콘을 DefiLlama(마크 없는 파란 원)에서 TrustWallet으로 교체(스펙 §4.4 사용자 결정, `config/chain-icons.ts` 1줄)
- 코드 기준: 커밋 전 작업 트리, 내용 해시 `0e77e00c2032e5ba0ffdeb15efed951f40ee1065`. 두 실행 검증 모두 시작·끝 해시 일치
- 실행(test-runner): format·lint·typecheck·build·check:build 통과, `bun run test` 125/125 3회 동일, `bun run test:fork` 6/6
- 실행(e2e-runner): `bun run test:e2e` 20/20, 재시도 0
- 스펙 대조(오케스트레이터, 설정값 1줄): 스펙 §4.4의 8453 URL과 `config/chain-icons.ts` 값 문자열 일치. 실제 Chromium에서 선택 체인 Base 헤더 아이콘 로드(256px, `data-fallback="false"`) 확인
