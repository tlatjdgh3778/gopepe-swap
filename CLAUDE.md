# GoPepe Swap

이더리움·Base·Arbitrum 메인넷용 단일 홉 Uniswap V3 스왑 UI.

## 스택

- Next.js 16 (App Router), React 19, TypeScript
- Tailwind 4
- 패키지 매니저: bun. Node 버전은 `.nvmrc`를 따른다.

## 명령

```bash
bun install
bun run dev           # 개발 서버
bun run build         # 프로덕션 빌드
bun run lint          # oxlint
bun run format:check  # oxfmt 검사
bun run format        # oxfmt 적용
bunx tsc --noEmit     # 타입 검사
bun run test          # Vitest 전체 1회 실행
bun run test:watch    # Vitest watch 모드
bun run test:e2e      # Playwright E2E (빌드 후 서버를 띄워 실행)
```

단일 테스트 실행:

```bash
bun run test __tests__/page.test.tsx          # Vitest 파일 하나
bun run test -t "테스트 이름"                 # Vitest 이름 일치
bun run test:e2e e2e/scaffold.spec.ts         # Playwright 파일 하나
bun run test:e2e -g "테스트 이름"             # Playwright 이름 일치
```

- Vitest는 `*.test.ts(x)`, Playwright는 `e2e/*.spec.ts`를 수집한다.
- Playwright를 처음 실행하기 전에 `bunx playwright install chromium`으로 브라우저를 설치한다. 시스템 라이브러리가 없다는 오류가 나면 `bunx playwright install-deps chromium`을 실행한다.
- `localhost:3000`에 이미 서버가 떠 있으면 Playwright는 빌드 없이 그 서버를 재사용한다(CI 제외).
- wagmi `mock` 커넥터 + anvil 포크 E2E 설정은 F1(`wallet-chains`)에서 추가한다.

## 브랜치와 커밋

- 기능마다 `main`에서 `feat/<spec-slug>` 브랜치를 만든다. 브랜치명은 `docs/specs/<spec-slug>.md`와 맞춘다.
- `main`에 직접 커밋하지 않고 PR로 머지한다. 머지는 merge commit으로 한다(squash 금지). 커밋의 `Session` 트레일러를 보존하기 위해서다.
- 기능은 순서대로 하나씩 머지한다. 병렬 작업과 스택 PR은 쓰지 않는다.
- 되돌릴 때는 `git revert`를 쓴다. force-push와 `reset`은 쓰지 않는다.
- v1 배포 시점에 `v1.0.0` 태그를 붙인다.
