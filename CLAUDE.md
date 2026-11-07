# GOPEPE Swap

이더리움·Base·Arbitrum 메인넷용 단일 홉 Uniswap V3 스왑 UI.

## 스택

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind 4
- 지갑: wagmi 3 + viem
- UI 프리미티브: 접근성 처리가 까다로운 부분만 shadcn/ui + Base UI. 호환 문제가 있으면 Base UI를 직접 쓴다.
- 패키지 매니저: bun. Node 버전은 `.nvmrc`를 따른다.

## 코드 구조

- 루트에 `components/`, `config/`, `hooks/`, `lib/`, `providers/`, `scripts/`를 두고 `src/`는 쓰지 않는다.
- 파일명은 kebab-case, `app/` 규약 파일 외에는 named export를 쓴다.
- 디자인 기준은 `docs/design/README.md`를 따른다.

## 명령

```bash
bun install
bun run dev           # 개발 서버
bun run build         # 프로덕션 빌드
bun run lint          # oxlint
bun run format:check  # oxfmt 검사
bun run format        # oxfmt 적용
bun run typecheck     # 라우트 타입 생성 후 타입 검사
bun run test          # Vitest 전체 1회 실행 (__tests__/fork/ 제외)
bun run test:watch    # Vitest watch 모드
bun run test:fork     # 실제 anvil Ethereum 포크 통합 테스트 (__tests__/fork/)
bun run test:e2e      # Playwright E2E (anvil 포크와 E2E 빌드 앱을 띄워 실행)
bun run check:build   # 빌드 결과 검사 (업체 RPC URL·키 노출, mock 코드 포함 여부)
```

단일 테스트 실행:

```bash
bun run test __tests__/config/chains.test.ts  # Vitest 파일 하나
bun run test -t "테스트 이름"                 # Vitest 이름 일치
bun run test:e2e e2e/wallet.spec.ts           # Playwright 파일 하나
bun run test:e2e -g "테스트 이름"             # Playwright 이름 일치
```

- Vitest는 `*.test.ts(x)`, Playwright는 `e2e/*.spec.ts`를 수집한다. `__tests__/fork/`는 `bun run test`에서 빠지고 `bun run test:fork`(`vitest.fork.config.mts`)로만 실행한다.
- Playwright를 처음 실행하기 전에 `bunx playwright install chromium`으로 브라우저를 설치한다. 시스템 라이브러리가 없다는 오류가 나면 `bunx playwright install-deps chromium`을 실행한다.
- `test:fork`, `test:e2e`는 `ETH_MAINNET_RPC_URL`(환경 변수 또는 `.env.local`)이 필요하다. 없거나 비면 설정 단계에서 실패한다. 포크 블록과 포트는 `config/e2e.ts` 상수를 따른다.
- E2E는 wagmi `mock` 커넥터 + anvil Ethereum 포크로 돈다. Playwright가 anvil(포트 8546)과 `NEXT_PUBLIC_E2E_MOCK=1`로 빌드한 앱(`.next-e2e`, 포트 3100)을 띄우고, 끝나면 둘 다 종료한다. 이미 떠 있는 서버는 재사용하지 않으므로 포트가 사용 중이면 실패한다.
- `test:fork`는 globalSetup이 anvil(포트 8547)을 띄우고 끝나면 종료한다.

## 테스트 규칙

- 자동 테스트는 요소를 `data-testid`나 접근성 role로 찾고, 문구가 아니라 상태와 결과로 판정한다.
- 문구, 색상, 레이아웃, 스냅샷과 렌더링 자체만 확인하는 테스트는 쓰지 않는다.

## CI

PR과 `main` 푸시마다 GitHub Actions(`.github/workflows/ci.yml`)가 `check`(format, lint, typecheck, test, build)와 `e2e`(Foundry 설치, test:fork, test:e2e, check:build) 잡을 실행한다. `e2e` 잡은 `ETH_MAINNET_RPC_URL` 시크릿이 없으면 실패한다.

## 브랜치와 커밋

- 기능마다 `main`에서 `feat/<spec-slug>` 브랜치를 만든다. 브랜치명은 `docs/specs/<spec-slug>.md`와 맞춘다.
- `main`에 직접 커밋하지 않고 PR로 머지한다. 머지는 merge commit으로 한다(squash 금지). 커밋의 `Session` 트레일러를 보존하기 위해서다.
- 기능은 순서대로 하나씩 머지한다. 병렬 작업과 스택 PR은 쓰지 않는다.
- 되돌릴 때는 `git revert`를 쓴다. force-push와 `reset`은 쓰지 않는다.
- v1 배포 시점에 `v1.0.0` 태그를 붙인다.
