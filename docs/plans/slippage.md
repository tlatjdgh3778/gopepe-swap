# 계획: slippage

- 상태: 승인
- 스펙: docs/specs/slippage.md
- 기준 코드: 877d4e3 + 작업 트리
- 최종 갱신: 2026-11-15

## 1. 구현 전략

- 순서는 순수 함수, 상태 계층(Provider·훅), 화면 두 갈래(팝오버, 견적 행), 테스트(단위·통합·E2E), 수동 확인과 전체 검사다. 새 RPC·체인 사실에 기대지 않으므로 사전 조사 Task를 두지 않는다. 근거: `docs/plans/quote.md` §4
- 순수 함수와 상수는 신규 `lib/slippage.ts` 하나에 둔다. 표기는 로캘 API 없이 정수 연산과 문자열로 만든다. F3의 `lib/quote-format.ts`는 건드리지 않는다. 근거: `lib/quote-format.ts:6,51-66`, `lib/token-amount.ts:30-45`
- 슬리피지 상태는 신규 `providers/slippage-provider.tsx`에 Provider와 `useSlippage()`를 한 파일로 두고, Provider 밖 호출은 throw한다. 초기값은 `useState(DEFAULT_SLIPPAGE_BPS)`이고 쿠키·저장소를 읽지 않는다. 근거: `providers/swap-quote-provider.tsx:105-109`, `providers/swap-form-provider.tsx:253-257`, `app/layout.tsx:41-43`
- Provider는 `AppProviders`에서 `QueryClientProvider` 안쪽, `SelectedChainProvider` 바깥에 둔다. 체인·지갑 훅을 읽지 않으므로 체인 전환·계정 변경으로 초기화되지 않는다. 체인 리셋은 `SwapFormProvider`가 자기 상태 안에서 하고 Provider를 다시 마운트하는 `key`는 없다. 근거: `providers/app-providers.tsx:49-55`, `providers/swap-form-provider.tsx:138-151`
- `useAmountOutMinimum()`은 신규 `hooks/use-amount-out-minimum.ts`가 `useSwapQuote()`와 `useSlippage()`로 파생한다. 화면과 F5가 같은 훅을 읽는다. 견적 queryKey·입력 시그니처에 슬리피지를 넣지 않아 재견적이 생기지 않는다. 근거: `lib/swap-quote.ts:33-36`, `providers/swap-quote-provider.tsx:48-55`
- 팝오버 프리미티브는 `bunx shadcn add popover`로 `components/ui/popover.tsx`를 만들고 기존 ui 래퍼의 import 형태에 맞춘다. 생성이 불가하면 `dropdown-menu.tsx`의 Portal·Positioner·Popup 구조로 Base UI Popover 래퍼를 쓴다. 새 의존성은 없다. 근거: `components.json`, `components/ui/dropdown-menu.tsx:20-49`
- 팝오버 동작은 Base UI 기본값(`modal` false)을 쓴다. 트리거 `aria-expanded`, Esc·바깥 클릭 닫힘(`useDismiss`), `Popover.Close`, 닫힘 시 포커스 복귀(포커스를 받는 요소로 옮겨 간 바깥 클릭은 복귀하지 않음)가 기본 동작이다. 근거: `node_modules/@base-ui/react/popover/trigger/PopoverTrigger.js:121-123`, `popover/root/PopoverRoot.js:119-126`, `floating-ui-react/components/FloatingFocusManager.js:487-547`
- 프리셋은 Base UI `RadioGroup`·`Radio`를 직접 쓴다. shadcn radio-group은 원형 표시라 시안의 테두리형 버튼과 맞지 않는다. 선택 표시는 `data-checked` 상태의 accent 테두리다. 근거: `CLAUDE.md` UI 프리미티브, `node_modules/@base-ui/react/radio/root/RadioRoot.js:115-116`
- 설정 버튼과 팝오버는 신규 클라이언트 컴포넌트 `components/slippage-settings.tsx`에 두고, 서버 컴포넌트인 `swap-card.tsx` 헤더를 좌우 배치로 바꿔 넣는다. 트리거 스타일은 `FlipButton`, 아이콘은 lucide `SlidersHorizontalIcon`이다. 헤더에 있으므로 견적 영역이 사라져도 팝오버가 언마운트되지 않는다. 근거: `components/swap-card.tsx`, `components/token-field.tsx:163-178`
- 견적 행은 `components/quote-details.tsx`의 `QuoteRow` 속성 타입을 넓히고 예상 수령량 행 패턴(값이 없으면 속성 생략과 스켈레톤)을 따른다. 영역 표시 조건은 바꾸지 않는다. 근거: `components/quote-details.tsx:25-56,96-106`
- 기존 F2·F3 테스트는 행 수·버튼 수를 세지 않고 loading 스켈레톤을 이름 붙은 행에서만 확인하므로 행 추가로 깨지지 않는다. F2·F3 골격 파일은 고치지 않는다. 근거: `__tests__/swap/quote-display.test.tsx:430-436`
- mock 경계는 F3 관례를 따르고, 새 경계(체인 변경 프로브, 표시 문구 리터럴 비교)는 테스트 설계 단계에서 사용자가 확정한다. 근거: `docs/plans/quote.md` T-6·T-8

## 2. Task

### T-1 — 순수 함수

- 사이드: 프론트
- 상태: 완료
- 목적: 슬리피지 값·상수·최소 수령량 계산·표기를 순수 함수로 만든다
- 선행: 없음
- 연결 항목: DoD-15, DoD-16, EC-1, EC-3
- 수정 대상: `lib/slippage.ts` — 신규, 스펙 §4.1의 타입·상수·`getAmountOutMinimum`, 표기 함수, 프리셋 타입 가드
- 따라야 할 패턴: `lib/` 순수 함수, 로캘 API 없는 표기, kebab-case 파일명과 named export — 근거: `lib/quote-format.ts`, `CLAUDE.md`
- 완료 조건: 연결 항목 충족, `Intl`·`toLocaleString` 미사용 — 검증: T-5
- 실행 명령: `bun run typecheck`, `bun run test __tests__/lib`
- 수정 금지: `lib/` 기존 파일, `components/`, `providers/`, `hooks/`
- 구현 기록: seongho:frontend-dev, 작성 영역 `lib/slippage.ts`(신규). 수정 0/3. export: `SlippageBps`, `SLIPPAGE_PRESETS_BPS`, `DEFAULT_SLIPPAGE_BPS`, `isSlippageBps(value: unknown)`(숫자 프리셋만 true), `getAmountOutMinimum`, `formatSlippageBps`(T-3·T-4 공용 표기). 오케스트레이터 확인: 수정 범위 일치, typecheck 통과, `test __tests__/lib` 46 통과·4 todo, 골자 동결 유지, 로캘 API 미사용

### T-2 — 상태 계층

- 사이드: 프론트
- 상태: 완료
- 목적: `SlippageProvider`·`useSlippage()`·`useAmountOutMinimum()`을 만들고 앱에 마운트한다
- 선행: T-1
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-17, DoD-24, DoD-25
- 수정 대상: `providers/slippage-provider.tsx` — 신규. `hooks/use-amount-out-minimum.ts` — 신규. `providers/app-providers.tsx` — `SlippageProvider`로 `SelectedChainProvider`를 감싼다
- 따라야 할 패턴: Provider와 훅을 한 파일에 둠, 값은 `useMemo`, Provider 밖 호출 throw — 근거: `providers/swap-quote-provider.tsx`, `providers/app-providers.tsx`
- 완료 조건: 연결 항목 충족, Provider가 체인·지갑 훅을 import하지 않음, 견적 queryKey와 입력 시그니처 불변, DoD-2는 코드 대조로 판정 가능한 형태(초기값이 상수) — 검증: T-6, T-7, 7단계 코드 대조
- 실행 명령: `bun run typecheck`, `bun run test __tests__/swap`
- 수정 금지: `providers/swap-form-provider.tsx`, `providers/swap-quote-provider.tsx`, `providers/selected-chain-provider.tsx`, `hooks/use-swap-quote-read.ts`, `lib/`, `components/`
- 구현 기록: seongho:frontend-dev(T-1 작성 에이전트 이어서), 작성 영역 `providers/slippage-provider.tsx`(신규), `hooks/use-amount-out-minimum.ts`(신규), `providers/app-providers.tsx`(마운트). 수정 0/3. export: `SlippageContextValue`, `SlippageProvider`, `useSlippage`(Provider 밖 throw), `useAmountOutMinimum`. 오케스트레이터 확인: diff 범위 일치, 체인·지갑 훅 import 없음, 초기값 상수, typecheck 통과, `test __tests__/swap` 87 통과·19 todo

### T-3 — 슬리피지 설정 팝오버

- 사이드: 프론트
- 상태: 완료
- 목적: 헤더 설정 버튼, 팝오버, 프리셋 라디오를 만든다
- 선행: T-2
- 연결 항목: DoD-3, DoD-6, DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-12, DoD-13, DoD-14, DoD-29, EC-4, EC-5, EC-6, EC-7, EC-8
- 수정 대상: `components/ui/popover.tsx` — 신규(shadcn add 또는 수기 래퍼). `components/slippage-settings.tsx` — 신규, 트리거·팝업·라디오·닫기 버튼·안내 문구와 스펙 §4.3 식별자. `components/swap-card.tsx` — 헤더 배치만, 서버 컴포넌트 유지
- 따라야 할 패턴: ui 래퍼 구조, `FlipButton` 버튼 클래스, 디자인 토큰 — 근거: `components/ui/dropdown-menu.tsx`, `components/token-field.tsx:163-178`, `docs/design/README.md`, `docs/design/wireframe/a-slippage.png`
- 완료 조건: 연결 항목 충족, 팝오버는 버튼 아래 오른쪽 정렬, `modal` 기본값, 닫기 버튼에 접근성 이름, 스펙 비목표 아이콘(슬리피지 행 아이콘, 최소 수령량 `?`) 없음, 프로덕션 빌드 통과 — 검증: T-6, T-9, `bun run build`
- 실행 명령: `bunx shadcn add popover`, `bun run build`, `bun run lint`
- 수정 금지: `components/quote-details.tsx`, 기존 `components/ui/*`, `providers/`, `hooks/`, `lib/`
- 구현 기록: seongho:frontend-dev(T-1·T-2 작성 에이전트 이어서), 작성 영역 `components/ui/popover.tsx`(신규, `bunx shadcn add popover` 생성 + `PopoverClose` 추가, 다른 파일 변경 없음 md5 확인), `components/slippage-settings.tsx`(신규), `components/swap-card.tsx`(헤더 배치, 서버 컴포넌트 유지). 수정 0/3. 구현 판단: 닫기 버튼 접근성 이름 sr-only `닫기`(dialog.tsx 관례), radiogroup `aria-labelledby` 팝오버 제목. 오케스트레이터 확인: 수정 범위 일치, build·lint 통과, `test __tests__/swap` 87 통과·19 todo, 골자 유지, `finalFocus` 미지정·`keepMounted` 없음

### T-4 — 견적 정보 두 행

- 사이드: 프론트
- 상태: 완료
- 목적: 최소 수령량 행과 슬리피지 허용치 행을 견적 정보에 더한다
- 선행: T-2
- 연결 항목: DoD-16, DoD-17, DoD-18, DoD-19, DoD-20, DoD-21, DoD-22, DoD-23, DoD-26, EC-2, EC-5, EC-6
- 수정 대상: `components/quote-details.tsx` — `QuoteRow` 속성 타입 확장, 두 행 추가, 행 순서, 상단 JSDoc
- 따라야 할 패턴: 예상 수령량 행과 스켈레톤 — 근거: `components/quote-details.tsx:25-56,96-106`
- 완료 조건: 연결 항목 충족, 최소 수령량 값은 `useAmountOutMinimum()`만 읽음, 슬리피지 행에 스켈레톤 없음, 기존 세 행의 식별자·속성 불변 — 검증: T-7, T-8
- 실행 명령: `bun run build`, `bun run test __tests__/swap`
- 수정 금지: `components/swap-card.tsx`, `components/slippage-settings.tsx`, `components/ui/`, `providers/`, `hooks/`, `lib/`
- 구현 기록: seongho:frontend-dev(새 인스턴스), 작성 영역 `components/quote-details.tsx`. 수정 0/3. 최소 수령량은 `useAmountOutMinimum()`만 읽고 null이면 스켈레톤·속성 생략, 슬리피지 행은 `formatSlippageBps` 표시·스켈레톤 없음, 행 순서 §1.1. 오케스트레이터 확인: 수정 범위 일치, build 통과, `test __tests__/swap` 87 통과, 골자 유지

### T-5 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 최소 수령량 계산과 슬리피지 표기를 검증한다
- 선행: T-1
- 연결 항목: DoD-15, DoD-16, EC-1, EC-3
- 수정 대상: `__tests__/lib/slippage.test.ts` — 신규
- 따라야 할 패턴: 순수 함수 단위 테스트와 로캘 스텁 원복 — 근거: `__tests__/lib/quote-format.test.ts`, `__tests__/lib/token-amount.test.ts`
- 완료 조건: 연결 항목 판정, 기대값은 bigint·문자열 리터럴, EC-3은 세 프리셋 모두, DoD-16은 기본 로캘 `de-DE`에서도 같은 결과 — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib`
- 수정 금지: 제품 코드, 기존 `__tests__/lib/*`
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/lib/slippage.test.ts`. 수정 0/3. 완성 4 case, todo 0. DoD-15는 리터럴과 테스트 내 공식 비교, DoD-16은 카운팅 로캘 스텁(대조 호출로 집계 동작 확인)·`vi.resetModules()`+동적 import 후 호출 0회. 오케스트레이터 확인: 골자 유지, `bun run test __tests__/lib` 50/50 통과
- 테스트 파일·runner: `__tests__/lib/slippage.test.ts`, Vitest jsdom
- mock 허용 경계: (사용자 확정) 없음. 예외로 DoD-16에 한해 로캘 기본값(`de-DE`) 전역 스텁 허용(F3 DoD-24 선례)과, 그 스텁에서 `Intl.NumberFormat` 생성·`Number`/`BigInt` `toLocaleString` 호출 수를 기록해 표기 중 0회임을 판정하는 것을 허용. 모듈 최상위 생성까지 세기 위해 스텁 설치 뒤 `vi.resetModules()`와 동적 import로 슬리피지 모듈을 새로 평가한다(mock이 아닌 모듈 재평가)
- 데이터 격리: 순수 함수만 사용, 로캘 스텁은 테스트마다 원복

### T-6 — 통합 테스트: 값과 팝오버

- 사이드: 테스트
- 상태: 완료
- 목적: 슬리피지 상태 유지와 팝오버 상호작용·포커스를 실제 앱 트리에서 검증한다
- 선행: T-3
- 연결 항목: DoD-1, DoD-3, DoD-4, DoD-5, DoD-6, DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-12, DoD-13, DoD-29, EC-4, EC-7, EC-8
- 수정 대상: `__tests__/swap/slippage-state.test.tsx` — 신규, 초기값·선택·체인·계정 유지·연속 입력. `__tests__/swap/slippage-popover.test.tsx` — 신규, 렌더링·열기·닫기·포커스·열린 채 체인 변경
- 따라야 할 패턴: `renderApp`·`renderAppHook` 프로브, 체인 변경 프로브, 계정 변경 `stub.changeAccounts`, 해제 `disconnect(config)`, `waitUntil` — 근거: `__tests__/support/wagmi-harness.tsx`, `__tests__/swap/swap-form-state.test.tsx:220`, `__tests__/swap/balances.test.tsx:590,808`
- 완료 조건: 연결 항목 판정, DoD-5는 해제와 계정 변경 두 표본, DoD-6은 미연결·연결 × idle·loading·success·no-route·error 표본, DoD-13은 ✕·Esc 두 경로, DoD-29의 바깥 영역은 포커스를 받지 않는 요소이고 jsdom에서는 Base UI 가상 클릭 경로(`fireEvent` 기본 `detail` 0)로 판정하며 실제 Chrome 마우스 경로는 T-9 수동 확인이 맡음, EC-8은 금액 입력칸으로 포커스가 옮겨 가는 클릭 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/slippage-state.test.tsx __tests__/swap/slippage-popover.test.tsx`
- 수정 금지: 제품 코드, F1·F2·F3 테스트 파일, `__tests__/support/*`
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/slippage-state.test.tsx`(5 case), `__tests__/swap/slippage-popover.test.tsx`(7 case). 수정 0/3. 구현 판단: EC-7은 클릭 사이 await 없이 개별 `fireEvent.click` 연속, DoD-6만 시간 제한 120초, DoD-29 바깥 대상은 받는 칸 `token-field` div, EC-8은 pointerdown→mousedown→focus→pointerup→mouseup→click(detail 1). 오케스트레이터 확인: 골자 유지
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: (사용자 확정) F3 T-6 경계(실제 wagmi·Provider·화면, mock 커넥터 또는 스텁 EIP-1193, 전역 fetch URL 라우팅 스텁과 견적 aggregate3 스텁, 가짜 타이머와 DOM 이벤트, `vi.mock` 금지)에 DoD-4·EC-4 한정으로 선택 체인을 `useSelectedChain().setSelectedChainId` 프로브로 바꾸는 것을 더한다(DoD-4는 값 유지 판정이고 체인 선택 UI는 F1이 덮음, EC-4는 체인 선택 클릭이 바깥 클릭이라 팝오버가 닫힘)
- 데이터 격리: 테스트마다 config 새로 생성과 스텁 초기화, `clearCookies`, QueryClient는 렌더마다 새로 생성

### T-7 — 통합 테스트: 최소 수령량과 행

- 사이드: 테스트
- 상태: 완료
- 목적: 두 행의 속성·표시, 요청 수, 훅 계약, 팝오버가 열린 동안의 견적 변화를 검증한다
- 선행: T-3, T-4
- 연결 항목: DoD-17, DoD-18, DoD-19, DoD-20, DoD-21, DoD-22, DoD-23, DoD-24, DoD-25, EC-2, EC-5, EC-6
- 수정 대상: `__tests__/swap/slippage-quote.test.tsx` — 신규
- 따라야 할 패턴: `setQuoteRule`·`holdQuote`·`failQuoteWhen`·견적 요청 집계, 15초 주기 가짜 타이머, loading 표본 — 근거: `__tests__/support/rpc-balance-stub.ts`, `__tests__/swap/quote-refresh.test.tsx`, `__tests__/swap/quote-display.test.tsx:403-440`
- 완료 조건: 연결 항목 판정, 기대값은 스텁 고정 수령량에서 리터럴이나 테스트 쪽 bigint 식으로 만들고 제품 `getAmountOutMinimum`을 쓰지 않음, DoD-17은 세 프리셋, DoD-23은 슬리피지 변경 전후 견적 JSON-RPC 항목 증가 0, DoD-25는 네 상태, EC-2는 스텁 수령량 1, EC-5는 15초 주기에 수령량이 바뀐 응답, EC-6은 열린 채 `no-route`·`error` 두 표본 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/slippage-quote.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트 파일
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/slippage-quote.test.tsx`(7 case). 수정 0/3. Q=`12_345_678_901_234_567n`, 값 자리는 행 안 role `definition`(dd), DoD-23·EC-5만 `setInterval`·`Date` 가짜 타이머. 오케스트레이터 확인: 골자 유지, T-6·T-7 세 파일 19/19 통과(`bun run test` 3 파일)
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: (사용자 확정) T-6과 같은 F3 경계. 판정 예외로 DoD-18·EC-2에 한해 표시 문구를 스텁 고정 수령량에 대한 기대 문자열 리터럴과 비교한다(F3 DoD-11 선례). DoD-19에 한해 `quote-slippage` 값 텍스트를 `aria-checked="true"`인 `slippage-option`의 텍스트와 비교하는 것을 허용한다(제품 출력끼리 비교, 리터럴 없음). 그 밖의 문구 판정은 금지
- 데이터 격리: T-6과 같음

### T-8 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 실제 포크 견적에서 1.0%를 고른 뒤의 최소 수령량을 검증한다
- 선행: T-3, T-4
- 연결 항목: DoD-26
- 수정 대상: `e2e/slippage.spec.ts` — 신규. `e2e/support/slippage.ts` — 신규, 스펙 §4.3 식별자 locator
- 따라야 할 패턴: `openApp`·`connectWithMock`, `beforeAll` 견적 예열과 그 hook만의 시간 제한 연장, `page.route` 금지 — 근거: `e2e/quote.spec.ts:167-171,213-220`, `e2e/support/anvil.ts:115,170`
- 완료 조건: 연결 항목 판정, 기대값은 화면의 `data-amount-out-raw`에서 테스트 안 bigint 식으로 만들고 제품 함수를 쓰지 않음 — 검증: 테스트
- 실행 명령: `bun run test:e2e e2e/slippage.spec.ts`
- 수정 금지: 제품 코드, 기존 `e2e/*.spec.ts`, 기존 `e2e/support/*`
- 구현 기록: seongho:e2e-dev(골격 작성 에이전트, 살 모드), 작성 영역 `e2e/slippage.spec.ts`(1 case), `e2e/support/slippage.ts`(신규). 수정 0/3. 두 속성은 한 `evaluate`로 같은 시점에 읽고 `expect.poll`로 일치 대기. 작성 중 저장소 전체 `bun run format` 1회 실행(다른 파일 변경 없음을 오케스트레이터가 git diff로 확인). 오케스트레이터 확인: 골자 유지, 정적 검사 통과, E2E 실행은 7단계 e2e-runner 몫
- 테스트 파일·runner: `e2e/slippage.spec.ts`, Playwright chromium
- mock 허용 경계: (사용자 확정) F3 T-8 경계 그대로(mock 커넥터, 러너→anvil 읽기·견적 예열, 앱 코드에 E2E 제어값 추가 금지)
- 데이터 격리: 테스트별 브라우저 컨텍스트, 잔액 주입 없음
- 실행 환경: 앱 `localhost:3100`(`NEXT_PUBLIC_E2E_MOCK=1` 빌드), anvil `localhost:8546`, `config/e2e.ts` 고정 블록, mock 계정은 `config/e2e-mock.ts`

### T-9 — 수동 확인과 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 시안 대조와 Base·Arbitrum 메인넷 확인을 기록하고 전체 정합성 명령을 통과시킨다
- 선행: T-5, T-6, T-7, T-8
- 연결 항목: DoD-14, DoD-27, DoD-28, DoD-29
- 수정 대상: 없음 — 결과는 이 계획의 구현 기록에 남긴다
- 따라야 할 패턴: F3 수동 확인 기록 — 근거: `docs/plans/quote.md` 검증 기록, 커밋 6c4d2b5
- 완료 조건: 연결 항목 확인 결과 기록(시안 대조는 비목표 아이콘 두 개 제외하고 스펙 §1.1 견적 정보 행 순서 포함, 메인넷은 날짜·블록·수령량·프리셋별 최소 수령량과 슬리피지 행 표기, DoD-29는 실제 Chrome에서 포커스를 받지 않는 바깥 영역을 마우스로 클릭한 뒤 포커스 위치), 실행 명령 전부 통과 — 검증: 확인 절차, 명령
- 실행 명령: `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: seongho:e2e-runner(실행), DoD-14 판단은 사용자. 2026-11-15 19:29 KST, E2E mock 없는 프로덕션 빌드(`next start -p 3200`) + Playwright chromium 1280×900, 지갑 미연결, `page.route` 없음. DoD-27 Base ETH→USDC 0.01: 블록 약 57741012~~57741018, 티어 100, amountOut 18280583 → 최소 수령량 10 bps 18262302(0.1%), 50 bps 18189180(0.5%), 100 bps 18097777(1.0%), 모두 내림 계산과 일치. DoD-28 Arbitrum: 블록 약 524434209~~524434213, 티어 100, amountOut 18273192 → 18254918·18181826·18090460, 모두 일치, 체인 전환 뒤 슬리피지 100 유지. DoD-29: 실제 마우스 클릭(isTrusted, detail 1)으로 `h1`·받는 칸 여백을 누르면 닫히고 포커스 `slippage-button`. EC-8 비교: 금액 입력칸 클릭 시 포커스 입력칸 유지. DoD-14: 버튼 헤더 오른쪽, 팝오버 bottom·end 정렬, 선택 테두리 rgb(165,232,197)=`--accent`, 행 순서 §1.1과 같음, 사용자 판단 일치(2026-11-15). 블록 번호는 공개 RPC 참고값. 스크린샷은 scratchpad(저장소 미포함)

## 3. 항목 coverage

- DoD-1: T-2, T-6
- DoD-2: T-2 (코드 대조)
- DoD-3: T-2, T-3, T-6
- DoD-4: T-2, T-6
- DoD-5: T-2, T-6
- DoD-6: T-3, T-6
- DoD-7: T-3, T-6
- DoD-8: T-3, T-6
- DoD-9: T-3, T-6
- DoD-10: T-3, T-6
- DoD-11: T-3, T-6
- DoD-12: T-3, T-6
- DoD-13: T-3, T-6
- DoD-14: T-3, T-9 (수동 1회 기록)
- DoD-15: T-1, T-5
- DoD-16: T-1, T-4, T-5
- DoD-17: T-2, T-4, T-7
- DoD-18: T-4, T-7
- DoD-19: T-4, T-7
- DoD-20: T-4, T-7
- DoD-21: T-4, T-7
- DoD-22: T-4, T-7
- DoD-23: T-4, T-7
- DoD-24: T-2, T-7
- DoD-25: T-2, T-7
- DoD-26: T-4, T-8
- DoD-27: T-9 (수동 1회 기록)
- DoD-28: T-9 (수동 1회 기록)
- DoD-29: T-3, T-6, T-9 (수동 1회 기록)
- EC-1: T-1, T-5
- EC-2: T-4, T-7
- EC-3: T-1, T-5
- EC-4: T-3, T-6
- EC-5: T-3, T-4, T-7
- EC-6: T-3, T-4, T-7
- EC-7: T-3, T-6
- EC-8: T-3, T-6

## 4. 실행 순서

- 1구간: T-1
- 2구간(병렬): T-2(`providers/`, `hooks/`) / T-5(`__tests__/lib/slippage.test.ts`)
- 3구간(병렬): T-3(`components/ui/popover.tsx`, `components/slippage-settings.tsx`, `components/swap-card.tsx`) / T-4(`components/quote-details.tsx`)
- 4구간(병렬): T-6(`__tests__/swap/slippage-state.test.tsx`, `__tests__/swap/slippage-popover.test.tsx`) / T-7(`__tests__/swap/slippage-quote.test.tsx`) / T-8(`e2e/slippage.spec.ts`, `e2e/support/slippage.ts`). E2E 실행은 포트 3100·8546을 독점하므로 이 구간에서 T-8만 E2E를 실행한다
- 5구간: T-9

## 5. 차단 사항

- 없음. `bunx shadcn add popover`가 네트워크 문제로 실패하면 T-3이 수기 래퍼로 대체한다

## 테스트 설계 증거

- 상태: 예외 동결 (reviewer 4라운드 후. 4라운드 finding 저 1건 반영분은 독립 재검토 없이 기계 검사만 통과, 사용자 확정)
- 기준 스펙: `docs/specs/slippage.md` (확정, 2026-11-15 갱신본: DoD-2 코드 대조, DoD-13 ✕·Esc, DoD-29·EC-8 신규, DoD-29 검증에 수동 1회 추가)
- 골자 digest: `3af643e844b77259`
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/slippage.md --files __tests__/lib/slippage.test.ts __tests__/swap/slippage-state.test.tsx __tests__/swap/slippage-popover.test.tsx __tests__/swap/slippage-quote.test.tsx e2e/slippage.spec.ts --exempt DoD-2,DoD-14,DoD-27,DoD-28 --frozen 3af643e844b77259`
- 골격 파일: `__tests__/lib/slippage.test.ts`(T-5, 4 case), `__tests__/swap/slippage-state.test.tsx`(T-6, 5), `__tests__/swap/slippage-popover.test.tsx`(T-6, 7), `__tests__/swap/slippage-quote.test.tsx`(T-7, 7), `e2e/slippage.spec.ts`(T-8, 1)
- 기계 검사: 통과. 항목 37개 중 case 연결 33개, 제외 4개, case 24개(단위 4, 통합 19, E2E 1). 전부 `it.todo`/`test.fixme`
- reviewer 라운드: 4회(매번 새 `general-purpose`, 파일 무변경 확인)
  - 1라운드 NEEDS-DECISION: 중복 case 통합(DoD-3·8·9), DoD-21·DoD-16 약화, DoD-4 체인 변경 수단, DoD-29 jsdom 경로. 스펙 DoD-29 검증 방법 변경
  - 2라운드 NEEDS-FIX(저 4): 닫기 버튼 찾기 방식·T-7 머리 주석 기록, E2E 식별자 서술, DoD-23 표본 렌더 분리
  - 3라운드 NEEDS-DECISION(중 2, 저 2): DoD-16 모듈 최상위 생성 집계, Q > 2^53, DoD-23 기준 시각, DoD-9 대기 작업 진행 후 판정, D-1 슬리피지 행 표기. 자동 3회 초과로 사용자 승인 후 4라운드
  - 4라운드 NEEDS-FIX(저 1): DoD-23 시간 구간 기준점을 요청 시각으로 수정, 반영 후 예외 동결
- 제외 (사용자 확정): DoD-2(7단계 코드 대조), DoD-14·DoD-27·DoD-28(T-9 수동 1회 기록)
- mock 경계 (사용자 확정): 각 테스트 Task의 `mock 허용 경계` 참조. 결정 이력: DoD-4·EC-4 체인 프로브, DoD-16 로캘 스텁 호출 수 0회와 모듈 재평가, DoD-18·EC-2 문구 리터럴 비교, DoD-19 `quote-slippage`·선택 `slippage-option` 텍스트 비교(리터럴 없음), DoD-21 loading·success 텍스트 비교, DoD-29 가상 클릭 경로, 닫기 버튼 role `button` 조회(문구 비교 없음), E2E ETH→USDC·`quote-amount-out` 기준
- 미검증 (경계의 한계): 통합 테스트는 fetch 스텁 RPC라 실제 노드 견적을 증명하지 않는다(E2E·T-9 몫). DoD-29 실제 Chrome 마우스 경로는 T-9 수동 확인만 증명한다. E2E는 Ethereum 포크 ETH→USDC 하나만 본다
- 7단계 코드 대조 항목: DoD-2(초기값이 상수이고 쿠키·저장소·`window`를 읽지 않음), 프리셋 라벨과 슬리피지 행이 `lib/slippage.ts` 표기 함수를 씀, `slippage-button` 접근성 이름 `슬리피지 설정`, T-2 견적 queryKey·입력 시그니처 불변
- T-9 수동 항목: DoD-14(행 순서 포함), DoD-27·28(프리셋별 최소 수령량과 슬리피지 행 표기), DoD-29 실제 Chrome 마우스 클릭
- 본문 작성 주의: EC-6은 붙잡은 견적 응답을 no-route·error로 풀어야 한다(1라운드 reviewer가 `rpc-balance-stub.ts` hold→fail 순서로 가능 확인). 안 되면 NEEDS-DECISION으로 되돌린다. `vitest list --json` 등 파일을 쓰는 옵션 금지(골격 작성 중 파일 덮어쓰기 사고 1건, 복구 완료)

### 검증 기록

- 코드 기준: `877d4e3` + 커밋 전 작업 트리(2026-11-15). 세 검증 모두 실행 전후 `git status`·`git diff` 동일, 검증 중 파일 변경 없음
- 실행(test-runner): format·lint·typecheck·build·check:build 통과, `bun run test` 200/200(F4 단위 4, 통합 19 포함), `bun run test:fork` 8/8
- 실행(e2e-runner): `bun run test:e2e` 24/24(F4 1, F3 3, F2 10, F1 10), 재시도 0. 같은 시각 `check:build`가 `.next-e2e`를 다시 빌드해 겹친 슬리피지 단독 실행은 근거에서 제외하고, 겹치지 않은 전체 실행(자체 빌드)만 근거로 쓴다. `test:e2e`와 `check:build`는 동시에 실행하지 않는다
- 스펙 대조(verify): 37개 중 충족 33, 부분 충족 1(DoD-29 실제 마우스 경로), 검증 불가 3(DoD-14·27·28 수동), 미충족 0. 골자 `3af643e844b77259` 유지, todo·skip 0, 스코프 초과·드리프트 없음. 7단계 코드 대조 4건(DoD-2 초기값 상수, 표기 함수 사용, 접근성 이름, 견적 queryKey·시그니처 불변) 이상 없음
- 수동(T-9): DoD-14·27·28·29 확인, 상세는 T-9 구현 기록

| 스펙 항목                    | 코드 대조                                      | 실행 확인                                                 | 종합 |
| ---------------------------- | ---------------------------------------------- | --------------------------------------------------------- | ---- |
| DoD-1, 3~~13, 15~~25, EC-1~8 | 충족                                           | 확인됨 (단위·통합)                                        | 충족 |
| DoD-26                       | 충족                                           | 확인됨 (E2E 전체 실행)                                    | 충족 |
| DoD-2                        | 충족(초기값 상수, 쿠키·저장소·`window` 미사용) | 코드 대조 항목                                            | 충족 |
| DoD-29                       | 부분 충족(가상 클릭 경로 테스트)               | 확인됨 (통합 가상 클릭 + 2026-11-15 실제 Chromium 마우스) | 충족 |
| DoD-27, DoD-28               | 검증 불가(수동 항목)                           | 수동 확인됨 (2026-11-15, 프리셋별 값 기록)                | 충족 |
| DoD-14                       | 검증 불가(코드상 배치 일치)                    | 수동 확인됨 (2026-11-15 스크린샷, 사용자 판단 일치)       | 충족 |

- verify 저 2건(수정 없음): (1) EC-4는 체인 선택 클릭이 바깥 클릭이라 실제 사용자 경로가 없고 프로브로만 판정한다(계획에서 인지) (2) 쓰지 않는 export: `components/ui/popover.tsx`의 `PopoverHeader`·`PopoverDescription`(shadcn 생성물), `e2e/support/slippage.ts`의 `quoteSlippageRow`
- 미검증: 실제 지갑 연결 상태의 메인넷 확인(T-9는 미연결), DoD-27·28은 2026-11-15 블록 1회
