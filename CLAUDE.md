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
```

테스트 도구는 아직 없다. Vitest(단위·통합)와 Playwright(E2E, wagmi `mock` 커넥터 + anvil 포크)를 도입한다. 도입 후 실행 명령을 여기에 추가한다.

## 브랜치와 커밋

- 기능마다 `main`에서 `feat/<spec-slug>` 브랜치를 만든다. 브랜치명은 `docs/specs/<spec-slug>.md`와 맞춘다.
- `main`에 직접 커밋하지 않고 PR로 머지한다. 머지는 merge commit으로 한다(squash 금지). 커밋의 `Session` 트레일러를 보존하기 위해서다.
- 기능은 순서대로 하나씩 머지한다. 병렬 작업과 스택 PR은 쓰지 않는다.
- 되돌릴 때는 `git revert`를 쓴다. force-push와 `reset`은 쓰지 않는다.
- v1 배포 시점에 `v1.0.0` 태그를 붙인다.
