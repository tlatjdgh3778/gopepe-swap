# 계획: wallet-chains

- 상태: 승인
- 스펙: docs/specs/wallet-chains.md
- 기준 코드: eb6b060 + 작업 트리
- 최종 갱신: 2026-11-07

## 1. 구현 전략

- 순서는 사전 확인, 기반, config, 프록시·지갑 코어·테스트 환경, 화면, 테스트 본문, 수동 확인이다. 근거: `CLAUDE.md`, `AGENTS.md`
- 선택 체인은 wagmi 상태에서 파생하지 않고, `gopepe-chain` 쿠키를 서버에서 읽어 자체 Provider로 내려보낸다.
- wagmi config는 요청 간 상태가 섞이지 않도록 팩토리로 만들고, transport는 체인별 프록시 경로로 고정한다.
- `chain.rpcUrls`는 운영에서 viem 기본값을 유지한다. 체인 추가 요청이 이 값을 지갑에 넘기기 때문이다. E2E 빌드에서만 anvil로 바꾼다.
- 프록시 코어는 `lib/`로 분리하고, 환경 변수는 요청 시점에 읽는다.
- wagmi 관련 근거는 잔존 설치본의 소스 분석이므로, 정식 설치 후 버전 차이를 확인한다.

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: 스펙의 구현 전 확인 사실을 실행으로 확인한다
- 선행: 없음
- 연결 항목: DoD-5, DoD-12
- 수정 대상: 없음 — 저장소 밖 임시 위치에서 확인한다
- 따라야 할 패턴: AGENTS.md의 Next 문서 확인 지시 — 근거: `AGENTS.md`
- 완료 조건: 스펙 미결정 절의 확인 사실 2건 결과를 구현 기록에 남기고, 어긋나면 인터뷰로 되돌린다 — 검증: 확인 절차
- 실행 명령: `cast chain-id`, `cast block`, shadcn 초기화 스모크
- 수정 금지: 저장소 파일
- 구현 기록: seongho:frontend-dev, 수정 파일 없음(저장소 밖 확인). 수정 0/3. 결과: anvil 포크 체인 ID 1, 고정 블록 26250000 조회와 QuoterV2 `factory()`·`WETH9()` 정상, 비채굴 시 `latest` 고정. shadcn 4.23.0 `--base base`로 `@base-ui/react` 1.9.0 사용, Next 16.3.4 빌드 통과, 쿠키 값이 SSR HTML에 반영(Select에 `items` 필요), 하이드레이션 오류 없음. wagmi와 함께 쓴 조합은 미확인

### T-2 — 의존성과 기반 설정

- 사이드: 프론트
- 상태: 완료
- 목적: 정식 의존성과 공통 설정을 갖춘다
- 선행: T-1
- 연결 항목: DoD-19
- 수정 대상: `package.json`, `bun.lock`, `tsconfig.json`, `.gitignore`, `.env.example`, `components.json`, `lib/utils.ts`, `config/e2e.ts`, `app/globals.css` — shadcn 초기화 내용만 `app/globals.css`에 반영, 의존성, `test:fork`·`check:build` 스크립트, target, env 예시, shadcn 초기화, 포트·포크 블록 상수
- 따라야 할 패턴: bun과 frozen lockfile — 근거: `.github/workflows/ci.yml`
- 완료 조건: node_modules를 지운 깨끗한 설치에서 타입 검사가 통과해 잔존물 의존이 없음을 보인다 — 검증: 명령
- 실행 명령: `rm -rf node_modules && bun install --frozen-lockfile && bun run typecheck`
- 수정 금지: 제품 기능 코드
- 구현 기록: seongho:frontend-dev, 수정 파일은 수정 대상과 같음. 수정 0/3. wagmi 3.7.11, viem 2.57.16, `@base-ui/react`, 깨끗한 설치 후 typecheck 통과

### T-3 — 체인·컨트랙트·토큰 config

- 사이드: 프론트
- 상태: 완료
- 목적: 체인별 config와 토큰 스냅샷을 만든다
- 선행: T-2
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-6, DoD-7, DoD-23
- 수정 대상: `config/chains.ts`, `config/contracts.ts`, `config/tokens.ts`, `config/tokens-1.json`, `config/tokens-8453.json`, `config/tokens-42161.json`, `scripts/generate-token-lists.ts`
- 따라야 할 패턴: 코드 구조 규칙 — 근거: `CLAUDE.md`
- 완료 조건: 연결 항목 충족, 스크립트 재실행 시 diff 없음, 컨트랙트 주소를 Uniswap 공식 문서와 대조한 출처를 구현 기록에 남김 — 검증: 명령 + T-8
- 실행 명령: `bun scripts/generate-token-lists.ts && git diff --exit-code config/`
- 수정 금지: `package.json`
- 구현 기록: seongho:frontend-dev, 수정 파일은 수정 대상과 같음. 수정 0/3. 주소는 Uniswap 공식 배포 문서(v3-ethereum, v3-base, v3-arbitrum deployments) 원문과 일치. 스냅샷 원본은 Uniswap Labs Default v22.33.0, 재실행 해시 일치

### T-4 — RPC 프록시

- 사이드: 백엔드
- 상태: 완료
- 목적: 서버 프록시를 구현한다
- 선행: T-3
- 연결 항목: DoD-16, DoD-17, DoD-18, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13
- 수정 대상: `app/api/rpc/[chainId]/route.ts`, `lib/rpc-proxy.ts`, `config/rpc.ts`
- 따라야 할 패턴: Route Handler 문서 — 근거: `node_modules/next/dist/docs/`
- 완료 조건: 연결 항목 충족, 크기 제한은 실제 읽은 바이트로도 판정 — 검증: T-9
- 실행 명령: `bun run test __tests__/api`
- 수정 금지: 화면 코드
- 구현 기록: seongho:backend-dev, 수정 파일은 수정 대상과 같음. 수정 1/3(원인: EC-12 `result` 필드에서 키를 가리지 않음). 8단계 사용자 수정 요청(2026-11-07, 예산 별도, seongho:backend-dev, 수정 파일 `config/rpc.ts`·`lib/rpc-proxy.ts`): E2E 빌드의 Ethereum 공개 RPC 대상을 anvil로, 가릴 때 응답 JSON 원문 보존(`__proto__`·큰 숫자), 서브도메인 키의 호스트 형태 가림. 수정 2/3(원인: 중복 키에 가려진 값의 키를 원문 그대로 반환, hostname에 길이 하한 없음 — EC-12 부분 충족)

### T-5 — 지갑 코어

- 사이드: 프론트
- 상태: 완료
- 목적: wagmi 구성, 선택 체인, 복원, 전환 훅을 만든다
- 선행: T-3
- 연결 항목: DoD-8, DoD-9, DoD-10, DoD-11, DoD-13, DoD-14, DoD-15, EC-3, EC-4, EC-5, EC-6, EC-7
- 수정 대상: `config/wagmi.ts`, `config/e2e-mock.ts`, `providers/app-providers.tsx`, `providers/selected-chain-provider.tsx`, `lib/selected-chain.ts`, `hooks/use-ensure-chain.ts`, `hooks/use-wallet-restore.ts`
- 따라야 할 패턴: 코드 구조 규칙 — 근거: `CLAUDE.md`
- 완료 조건: 연결 항목 충족, mock은 플래그 없는 빌드에서 제외되는 형태로 가져옴, E2E 빌드 전용 제어값 `window.__GOPEPE_E2E__`로 연결 오류 재현과 지갑 요청 기록과 앱의 RPC 읽기와 같은 클라이언트로 보내는 프록시 테스트 호출을 제공, 새로고침 후 복원과 해제 후 미연결을 mock 커넥터로 재현하는 E2E 전용 처리를 제공 — 검증: T-10, T-12
- 실행 명령: `bun run test __tests__/wallet`
- 수정 금지: `app/`, `components/`
- 구현 기록: seongho:frontend-dev, 수정 파일은 수정 대상과 같음. 수정 1/3(원인: 항상 번들되는 파일의 표식 문자열이 서버 source map에서 검출). 쿠키 만료 1년(스펙 외 값, 사용자 확인 대상)

### T-6 — 화면

- 사이드: 프론트
- 상태: 완료
- 목적: 헤더, 스왑 카드 뼈대, 주 버튼, 연결 모달을 만들고 스캐폴드를 교체한다
- 선행: T-5
- 연결 항목: DoD-8, DoD-9, DoD-10, DoD-12, DoD-15, EC-1, EC-2
- 수정 대상: `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `components/site-header.tsx`, `components/chain-select.tsx`, `components/wallet-button.tsx`, `components/connect-modal.tsx`, `components/swap-card.tsx`, `components/primary-button.tsx`, `components/ui/`, `__tests__/page.test.tsx`, `e2e/scaffold.spec.ts` — 스캐폴드 테스트 2개는 삭제
- 따라야 할 패턴: 디자인 기준 — 근거: `docs/design/README.md`
- 완료 조건: 연결 항목 충족, 테스트가 쓸 `data-testid`와 상태 속성 제공, 프로덕션 빌드 통과 — 검증: T-10, T-12, 명령
- 실행 명령: `bun run build`
- 수정 금지: `config/`, `providers/`, `hooks/`
- 구현 기록: seongho:frontend-dev, 수정 파일은 수정 대상과 같음(`components/ui/` 4개는 shadcn add). 수정 1/3(원인: EC-1 안내 요소에 testid 없음. 사용자 결정: testid 추가). 8단계 사용자 수정 요청(2026-11-07, 예산 별도): 헤더의 체인 선택과 지갑 버튼 높이 불일치(seongho:frontend-dev, 수정 파일 `components/ui/select.tsx`·`components/chain-select.tsx`·`components/wallet-button.tsx`·`components/site-header.tsx`)

### T-7 — 테스트 환경과 CI

- 사이드: 인프라
- 상태: 완료
- 목적: anvil과 앱을 띄우는 E2E 환경, 빌드 결과 검사, CI를 갖춘다
- 선행: T-2
- 연결 항목: DoD-5, DoD-19, DoD-20, DoD-21, DoD-22
- 수정 대상: `next.config.ts`, `playwright.config.ts`, `vitest.config.mts`, `vitest.fork.config.mts`, `__tests__/fork/global-setup.ts`, `scripts/check-build-artifacts.ts`, `.github/workflows/ci.yml`, `CLAUDE.md` — `CLAUDE.md`의 포트 재사용 안내 수정. 커밋 전 변경을 덮어쓰지 않음
- 따라야 할 패턴: 기존 Playwright·CI 구성 — 근거: `playwright.config.ts`, `.github/workflows/ci.yml`
- 완료 조건: 연결 항목 충족, 시크릿 없으면 설정 단계에서 실패, anvil 로그에 RPC URL이 찍히지 않음, 기본 `bun run test`에서 `__tests__/fork/` 제외, CI `e2e` 잡에서 `test:fork` 실행 — 검증: 명령
- 실행 명령: `bun run test:e2e`, `bun run check:build`, `ss -ltn`
- 수정 금지: 제품 코드
- 구현 기록: seongho:backend-dev, 수정 파일은 수정 대상과 같음. 수정 2/3(2차 원인: CLAUDE.md에 삭제된 테스트 파일 예시가 남음. 1차 원인: 원인: 플래그 없는 빌드에서 mock 코드 미제거. 사용자 결정: E2E가 아닌 빌드에 플래그를 빈 값으로 고정, source map 포함 엄격 검사 유지)

### T-8 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: config와 쿠키 파서를 검증한다
- 선행: T-3, T-5
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, EC-7
- 수정 대상: `__tests__/config/chains.test.ts`, `__tests__/config/tokens.test.ts`, `__tests__/lib/selected-chain.test.ts`
- 완료 조건: 연결 항목 판정 — 검증: 테스트
- 실행 명령: `bun run test __tests__/config __tests__/lib`
- 수정 금지: 제품 코드
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드). 수정 0/3
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: 없음
- 데이터 격리: 순수 함수와 정적 데이터만 사용

### T-9 — 프록시 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 프록시의 전달, 거절, fallback을 검증한다
- 선행: T-4
- 연결 항목: DoD-16, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13
- 수정 대상: `__tests__/api/rpc-proxy.test.ts`, `__tests__/support/rpc-fetch-stub.ts`
- 완료 조건: 연결 항목 판정, EC-8은 업체 호출 0회로 판정 — 검증: 테스트
- 실행 명령: `bun run test __tests__/api`
- 수정 금지: 제품 코드
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드). 수정 1/3(원인: EC-12 `result` 내부 키 표본 없음). 8단계 사용자 수정 요청(2026-11-07, 예산 별도, seongho:test-dev 살 모드, 수정 파일 `__tests__/api/rpc-proxy.test.ts`): 가린 응답의 원문 보존 판정, 서브도메인 키 업체 URL 표본. 수정 2/3(원인: 중복 키·재직렬화 fallback·키 이름의 비밀 표본 없음)
- 테스트 파일·runner: 수정 대상의 파일, Vitest node 환경
- mock 허용 경계: 전역 fetch만 URL 라우팅 스텁으로 교체. console은 출력 기록만 허용. route와 NextRequest는 실제 코드
- 데이터 격리: vi.stubEnv와 vi.unstubAllEnvs, 테스트마다 스텁 초기화

### T-10 — 지갑 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 전환 훅, 지갑 이벤트, 복원, 지갑 없음을 검증한다
- 선행: T-5, T-6
- 연결 항목: DoD-13, DoD-15, EC-1, EC-3, EC-4, EC-5, EC-6
- 수정 대상: `__tests__/wallet/use-ensure-chain.test.tsx`, `__tests__/wallet/wallet-events.test.tsx`, `__tests__/wallet/restore.test.tsx`, `__tests__/wallet/connect-modal.test.tsx`, `__tests__/support/wagmi-harness.tsx`, `__tests__/support/stub-eip1193.ts`
- 완료 조건: 연결 항목 판정 — 검증: 테스트
- 실행 명령: `bun run test __tests__/wallet`
- 수정 금지: 제품 코드
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드). 수정 2/3(2차 원인: restore.test.tsx 5개 case가 저장된 연결 준비 단계에서 실패. 1차 원인: 원인: EC-1 안내를 대리 판정. 사용자 결정: T-6이 testid를 추가한 뒤 그 testid로 판정)
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: wagmi는 실제 코드. mock 커넥터 또는 스텁 EIP-1193 provider만 허용. EC-4, EC-5는 mock 커넥터로 재현되지 않아 스텁 provider 사용
- 데이터 격리: 테스트마다 config 새로 생성, 복원 잠금 정리를 위해 필요 시 vi.resetModules

### T-11 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 실제 anvil 포크에서 체인과 주소, 프록시 경유를 검증한다
- 선행: T-4, T-7
- 연결 항목: DoD-5, DoD-6, DoD-17, DoD-23
- 수정 대상: `__tests__/fork/fork.fork.test.ts`
- 완료 조건: 연결 항목 판정, DoD-17은 고정 블록 응답으로 공개 RPC와 구분 — 검증: 테스트
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드). 수정 0/3
- 테스트 파일·runner: 수정 대상의 파일, `vitest.fork.config.mts`
- mock 허용 경계: 없음(실제 anvil 포크)
- 데이터 격리: 읽기 전용 호출만 사용, 전용 포트

### T-12 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 사용자 흐름과 네트워크 경로를 검증한다
- 선행: T-6, T-7
- 연결 항목: DoD-8, DoD-9, DoD-10, DoD-11, DoD-12, DoD-14, DoD-15, DoD-18, EC-2, EC-7
- 수정 대상: `e2e/wallet.spec.ts`, `e2e/chain.spec.ts`, `e2e/rpc-network.spec.ts`, `e2e/support/`
- 완료 조건: 연결 항목 판정, DoD-18은 테스트 호출의 프록시 경유로 양성 대조 — 검증: 테스트
- 실행 명령: `bun run test:e2e`
- 수정 금지: 제품 코드
- 구현 기록: seongho:e2e-dev(골격 작성 에이전트, 살 모드). 수정 1/3(원인: DoD-18 음성 감시가 업체 대상 127.0.0.1:8546을 허용)
- 테스트 파일·runner: 수정 대상의 파일, Playwright chromium
- mock 허용 경계: mock 커넥터와 E2E 빌드 전용 제어값(`window.__GOPEPE_E2E__`)만 허용. `page.route` 가로채기 금지, 감시만 허용
- 데이터 격리: 테스트별 브라우저 컨텍스트로 쿠키 격리, `.next-e2e`와 전용 포트 사용
- 실행 환경: 앱 `localhost:3100`, anvil `localhost:8546`, 로그인 없음, 포크 블록은 `config/e2e.ts` 상수

### T-13 — 수동 확인과 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 수동 항목과 전체 명령을 마무리한다
- 선행: T-8, T-9, T-10, T-11, T-12
- 연결 항목: DoD-7, DoD-21, DoD-22
- 수정 대상: 없음 — 수동 확인 결과는 PR 본문에 기록
- 완료 조건: Base·Arbitrum 주소 코드 존재 기록, 정상·실패 종료 후 포트와 프로세스 잔존 없음, 전체 명령 통과 — 검증: 명령 + 확인 절차
- 실행 명령: `cast code`, `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:fork`, `bun run test:e2e`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: 오케스트레이터 수동 확인. DoD-7: 2026-11-06 공개 RPC `cast code`로 Base(블록 53901675) QuoterV2·Factory·WETH, Arbitrum(블록 521797890) QuoterV2·Factory·WETH 모두 코드 있음(hex 길이 16548·49072·4084, 16548·49072·4186). 전체 명령은 7단계 test-runner·e2e-runner 결과로 기록

## 3. 항목 coverage

- DoD-1: T-3, T-8
- DoD-2: T-3, T-8
- DoD-3: T-3, T-8
- DoD-4: T-3, T-8
- DoD-5: T-1, T-7, T-11
- DoD-6: T-3, T-11
- DoD-7: T-3, T-13
- DoD-8: T-5, T-6, T-12
- DoD-9: T-5, T-6, T-12
- DoD-10: T-5, T-6, T-12
- DoD-11: T-5, T-12
- DoD-12: T-1, T-6, T-12
- DoD-13: T-5, T-10
- DoD-14: T-5, T-12
- DoD-15: T-5, T-6, T-10, T-12
- DoD-16: T-4, T-9
- DoD-17: T-4, T-11
- DoD-18: T-4, T-12
- DoD-19: T-2, T-7
- DoD-20: T-7
- DoD-21: T-7, T-13
- DoD-22: T-7, T-13
- DoD-23: T-3, T-11
- EC-1: T-6, T-10
- EC-2: T-6, T-12
- EC-3: T-5, T-10
- EC-4: T-5, T-10
- EC-5: T-5, T-10
- EC-6: T-5, T-10
- EC-7: T-5, T-8, T-12
- EC-8: T-4, T-9
- EC-9: T-4, T-9
- EC-10: T-4, T-9
- EC-11: T-4, T-9
- EC-12: T-4, T-9
- EC-13: T-4, T-9

## 4. 실행 순서

- 순차: T-1, T-2, T-3
- 병렬: T-4, T-5, T-7. `package.json`과 `config/e2e.ts`는 T-2가 끝낸 뒤 읽기만 한다
- 순차: T-6 (T-5 이후)
- 병렬: T-8, T-9, T-10, T-11, T-12. 지원 파일은 Task별로 나눈다
- 순차: T-13

## 5. 차단 사항

- 없음

## 테스트 설계 증거

- 상태: 예외 동결 (사용자 승인). `PASS` 조건인 "기계 검사와 새 reviewer가 같은 digest에서 통과"는 충족하지 못했다
- 기준 스펙: `docs/specs/wallet-chains.md` (상태 확정, 2026-11-05). 2026-11-07 문구 명확화(§1.3, §4.2, EC-9, EC-10) 후에도 골자 digest 일치
- 골자 digest: `6afdf2fb5d08e92c`
- 동결 확인 명령: `check-skeleton.py --spec docs/specs/wallet-chains.md --files (아래 골격 파일) --exempt DoD-7,DoD-19,DoD-20,DoD-21,DoD-22 --frozen 6afdf2fb5d08e92c`
- 골격 파일: `__tests__/config/chains.test.ts`, `__tests__/config/tokens.test.ts`, `__tests__/lib/selected-chain.test.ts`, `__tests__/api/rpc-proxy.test.ts`, `__tests__/wallet/use-ensure-chain.test.tsx`, `__tests__/wallet/wallet-events.test.tsx`, `__tests__/wallet/restore.test.tsx`, `__tests__/wallet/connect-modal.test.tsx`, `__tests__/fork/fork.fork.test.ts`, `e2e/wallet.spec.ts`, `e2e/chain.spec.ts`, `e2e/rpc-network.spec.ts`
- 기계 검사: 통과. 항목 36개 중 case 연결 31개, 제외 5개, case 60개
- reviewer: 전체 검토 5회 모두 `NEEDS-FIX` (마지막 회 High 0, Med 2). 자동 한도 3회 초과분은 사용자 승인으로 진행했다
- 한정 검토 1회: 마지막 수정 부분 대상. `NEEDS-FIX` 1건(`[DoD-13][EC-5]` `@given`)을 제안대로 고쳤고, 이 한 줄 수정은 재검토하지 않았다
- 제외 (사용자 확정): DoD-7(T-13 수동 `cast code`), DoD-19·DoD-20(T-7 빌드 결과 검사), DoD-21·DoD-22(T-7, T-13 명령 실행 확인)
- mock 경계 (사용자 확정): T-8 없음, T-9 전역 fetch 스텁과 console 출력 기록, T-10 실제 wagmi에 mock 커넥터 또는 스텁 EIP-1193 provider, T-11 없음, T-12 mock 커넥터와 E2E 전용 제어값
- 미검증 (사용자 결정): 실제 MetaMask 등 실제 지갑 동작(전환, 체인 추가, 새로고침 후 권한 유지), Base·Arbitrum 프록시 경로와 포크
- 미검증 (경계의 한계): 실제 업체·공개 RPC 응답과 가용성, 배포 프록시의 헤더 전달, console을 거치지 않는 로그
- 7단계 코드 대조: DoD-18 테스트 호출이 앱의 RPC 읽기와 같은 클라이언트인지, EC-6 시간 값이 상수인지
- 본문 작성 지시: 멀티바이트 본문 크기, 업체 응답 헤더 값 노출, MetaMask 링크 대상, 체인 추가 요청의 `rpcUrls`, 공개 RPC 본문 지연, 가짜 타이머와 `AbortSignal.timeout`, EC-5의 연결 체인 측정 기준(connection chainId), DoD-17의 anvil 비채굴 전제
- 주의: 이 Task의 wagmi 근거는 잔존 설치본 분석이며, 정식 설치 후 재확인한다

### 검증 기록

- 코드 기준: `eb6b060` + 커밋 전 작업 트리(2026-11-07 10:53 KST, 8단계 수정 후 12:22 KST 재검증). 검증 중 파일 변경 없음(`git status`와 내용 해시 일치)
- 실행: `bun run test` 46/46, `bun run test:fork` 4/4, `bun run test:e2e` 10/10(2회), `bun run check:build` 통과, format·lint·typecheck 통과. 지갑 테스트 3회 반복 통과
- 1차 검증 실패와 처리: `restore.test.tsx` 5개 실패(테스트 결함, T-10), EC-12 `result` 키 미가림(제품 결함, T-4)과 표본 누락(T-9), DoD-18 음성 감시 허용 범위(테스트 결함, T-12), `CLAUDE.md` 예시(T-7)

| 스펙 항목                    | 코드 대조             | 실행 확인                                              | 종합 |
| ---------------------------- | --------------------- | ------------------------------------------------------ | ---- |
| DoD-1~4                      | 충족                  | 확인됨 (`__tests__/config`)                            | 충족 |
| DoD-5, DoD-6, DoD-17, DoD-23 | 충족                  | 확인됨 (`test:fork`)                                   | 충족 |
| DoD-7                        | 충족 (수동 기록)      | 확인됨 (T-13 `cast code`)                              | 충족 |
| DoD-8~12, DoD-14             | 충족                  | 확인됨 (E2E)                                           | 충족 |
| DoD-13                       | 충족                  | 확인됨 (`use-ensure-chain.test.tsx`)                   | 충족 |
| DoD-15                       | 충족                  | 확인됨 (`restore.test.tsx`, E2E)                       | 충족 |
| DoD-16                       | 충족                  | 확인됨 (`rpc-proxy.test.ts`)                           | 충족 |
| DoD-18                       | 충족                  | 확인됨 (E2E)                                           | 충족 |
| DoD-19                       | 충족                  | 확인됨 (`check:build`)                                 | 충족 |
| DoD-20~22                    | 검증 불가 (실행 항목) | 확인됨 (`check:build`, E2E 실행 중 포트·프로세스 기록) | 충족 |
| EC-1, EC-3~6                 | 충족                  | 확인됨 (`__tests__/wallet`)                            | 충족 |
| EC-2                         | 충족                  | 확인됨 (E2E)                                           | 충족 |
| EC-7                         | 충족                  | 확인됨 (단위, E2E)                                     | 충족 |
| EC-8~13                      | 충족                  | 확인됨 (`rpc-proxy.test.ts`)                           | 충족 |

- 8단계 수정(사용자 요청): 위 Low 관찰 4건(E2E 빌드의 공개 RPC fallback 대상, 가릴 때 `__proto__`·큰 숫자 손실, 서브도메인 키 호스트 미가림, EC-9·EC-10 우선순위)을 스펙 문구와 T-4·T-9 수정으로 처리했다
- 8단계 수정 후 1차 재검증: EC-12 부분 충족(중복 키에 가려진 값의 키 반환, hostname 길이 하한 없음 — 제품 결함, T-4·T-9 수정 2/3). 2차 재검증: 전 항목 충족, 실행 `bun run test` 46/46, `__tests__/api` 24/24(3회), `test:fork` 4/4, `test:e2e` 10/10, `check:build` 통과, format·lint·typecheck 통과. 검증 중 파일 변경 없음
- 8단계 수정(사용자 요청, T-6): 헤더의 체인 선택(32px)과 지갑 버튼(40px) 높이 불일치. 원인은 `SelectTrigger`의 변형 선택자 높이가 `h-10`보다 우선한 것. 재검증: 전 항목 충족, `bun run build`·`test` 46/46·지갑 15/15(3회)·`test:fork` 4/4·`test:e2e` 10/10·`check:build`·format·lint·typecheck 통과, 실제 화면 측정(1280·375px, 복원 중·미연결·연결됨)에서 두 컨트롤 모두 40px. 높이 자동 테스트는 비목표에 따라 두지 않음. 검증 중 파일 변경 없음
- 남은 Low 관찰(기존 정책): 6자 이상 경로·쿼리 조각과 서브도메인 라벨·호스트의 과잉 가림, 재직렬화 fallback 시 숫자 표기·공백 변화, 경로 조각이 envelope 키 이름과 같을 때의 키 가림, 쿠키 만료 1년(스펙 외 값)
- 남은 검증 공백(Low): 치환 후 잔존 재검사만 없앤 변형을 잡는 표본 없음(앞쪽 중복 값의 `\u` 이스케이프 키), 짧은 호스트 하한의 회귀 표본 없음, E2E 공개 RPC → anvil 분기의 자동 테스트 없음(연결 DoD 없음, 코드 대조)
- 미검증: 실제 지갑 동작, Base·Arbitrum 프록시 경로와 포크, 실제 업체·공개 RPC 응답, 배포 프록시 헤더 전달, 디자인 일치
