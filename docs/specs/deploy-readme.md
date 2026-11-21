# 스펙: deploy-readme (Vercel 라이브 배포, RPC 운영, README, 파비콘)

- 상태: 완료
- 최종 갱신: 2026-11-21

## 1. 목표

GOPEPE Swap을 Vercel `*.vercel.app` 기본 도메인에 라이브로 배포한다. main 머지가 production 배포로 이어지고, main은 CI(`check`·`e2e`)를 통과한 PR로만 바뀐다. RPC 프록시 `/api/rpc/*`는 Vercel WAF 레이트 리밋으로 함수 실행 전에 남용을 막는다. 저장소 첫 화면은 한국어 README로 바꾸고, Next 기본 아이콘과 기본 자산은 프로젝트의 것으로 정리한다. [사용자 결정]

## 2. 비목표

- GitHub Pages 등 정적 호스팅과 커스텀 도메인 [사용자 결정]
- GitHub Actions 배포 잡과 수동 CLI 배포 [사용자 결정]
- Preview·Development 환경에 업체 RPC 키를 넣는 것 [사용자 결정]
- 코드 안의 요청 횟수 제한(메모리 카운터, Upstash 등 외부 저장소) [사용자 결정]
- 429 전용 문구와 재시도 UI [제안 후 승인]
- 낮은 `eth_call` 가스 상한에 대응하는 코드 변경(견적 호출 분할 등) [사용자 결정]
- 배포 URL에서 실제 지갑으로 쓰기 트랜잭션을 확인하는 것 [사용자 결정]
- 배포 URL에서 403·429 응답과 Origin·Host·`X-Forwarded-Host` 전달을 직접 확인하는 것. 미검증으로 남기고 DoD-5의 견적 표시로 간접 확인한다 [사용자 결정]
- README의 기술 결정·테스트 전략·스크린샷·로드맵 섹션 [사용자 결정]
- 페페 사진(파비콘·마스코트·헤더 로고)과 OG 이미지 [사용자 결정]
- GitHub 저장소 homepage·description 설정 [사용자 결정]
- LICENSE 파일 [사용자 결정]
- README의 이름 유래 줄 [사용자 결정]
- 문구, 색상, 레이아웃, 스냅샷 자동 테스트와 렌더링 자체만 확인하는 테스트 [사용자 결정]

## 3. 완료의 정의

### 3.1 배포

- DoD-1: Vercel 프로젝트가 GitHub 저장소와 Git 연동되어 있고, main의 머지 커밋이 production으로 배포된다 — 검증: 수동 1회. 머지 전에는 Vercel import 때 배포된 main 머지 커밋(`1f1ef6a`)의 배포 URL·커밋 SHA를 계획에 기록하고, F8 머지 커밋의 production 배포는 F8 PR 코멘트로 기록한다 [사용자 결정]
- DoD-2: Vercel 프로젝트 이름은 `gopepe-swap`이고, production URL은 `*.vercel.app` 기본 도메인이다. 이름이 이미 쓰여 Vercel이 다른 URL을 주면 실제 URL을 기록한다 — 검증: 수동 1회, URL 기록 [사용자 결정]
- DoD-3: Vercel 환경 변수가 §4.2와 일치한다 — 검증: 수동 1회 (`vercel env ls` 또는 대시보드), 변수 이름만 기록 [사용자 결정]
- DoD-4: Vercel 빌드가 `bun.lock`으로 의존성을 설치하고 Node 24.x에서 성공한다 — 검증: 수동 1회, 빌드 로그 기록 [제안 후 승인]
- DoD-5: 배포 URL에서 페이지가 열리고, Ethereum·Base·Arbitrum 각각에서 견적이 표시된다 — 검증: 수동 1회, 결과 기록 [사용자 결정]
- DoD-6: Vercel 프로젝트의 함수 최대 실행 시간을 확인해 기록한다(판정은 §5.2) — 검증: 수동 1회, 기록 [제안 후 승인]

### 3.2 RPC 운영

- DoD-7: Vercel WAF 레이트 리밋 규칙이 §4.1과 일치하게 설정되어 있다 — 검증: 수동 1회, 규칙 설정 기록 (차단 동작은 미검증) [사용자 결정]
- DoD-8: Ethereum·Base·Arbitrum의 업체 RPC와 공개 RPC 각각의 `eth_call` 가스 상한을 확인해 기록한다 — 검증: 수동 1회, 계획 T-1의 측정 절차로 확정, 기록 [사용자 결정]
- DoD-9: README 알려진 한계에 DoD-8의 가스 상한 결과가 반영되어 있다 — 검증: 코드 대조 [사용자 결정]
- DoD-10: F5에서 넘어온 Ethereum 메인넷 쓰기 확인을 "사용자 확인 완료(로컬, tx 해시 없음)"로 계획에 기록한다 — 검증: 계획 기록 대조 [사용자 결정]

### 3.3 저장소 규칙

- DoD-11: main 브랜치 보호가 PR 필수(승인 수 0), required status checks `check`·`e2e`(최신 브랜치 요구 strict 끔), 관리자에게도 적용, force-push 금지, 브랜치 삭제 금지로 설정되어 있다 — 검증: `gh api` 명령 실행 확인, 결과 기록 [사용자 결정]
- DoD-12: 저장소 머지 옵션이 merge commit만 허용하고 squash·rebase 머지를 끈 상태다 — 검증: `gh api` 명령 실행 확인, 결과 기록 [사용자 결정]

### 3.4 README·아이콘·정리

- DoD-13: `README.md`가 한국어이고 한 줄 소개, 라이브 링크, 주요 기능(v1), 로컬 실행·환경 변수, 알려진 한계(`eth_call` 가스 상한, EIP-7702 계정의 unwrap 실패 가능성, 네트워크 수수료 표시 없음 등) 섹션을 이 순서로 담는다 — 검증: 코드 대조 [사용자 결정]
- DoD-14: README의 라이브 링크가 DoD-2의 URL이다 — 검증: 코드 대조 [사용자 결정]
- DoD-15: README 환경 변수 섹션의 변수 집합이 `.env.example`의 변수 3개와 정확히 같다 — 검증: 코드 대조 [사용자 결정]
- DoD-16: `app/favicon.ico`(16px·32px)와 새로 추가한 `app/icon.svg`가 둥근 사각 배경(32px 기준 반경 8px) `--bg`(#101312)에 path로 그린 `--accent`(#a5e8c5) 'G' 한 글자 아이콘이다 — 검증: 코드 대조, 수동 1회 (머지 전 F8 PR preview URL의 브라우저 탭 아이콘. 머지 뒤 production은 F8 PR 코멘트로 기록) [사용자 결정]
- DoD-17: `app/layout.tsx`의 `metadata`가 `{ title: "GOPEPE Swap", description: "이더리움·Base·Arbitrum의 Uniswap V3 단일 홉 스왑" }`이다 — 검증: 코드 대조 [제안 후 승인]
- DoD-18: `public/`의 create-next-app SVG 5개(`file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg`)가 삭제되고, 코드·설정·테스트·README에 이 파일들을 경로로 가리키는 참조가 없다(`docs/specs`·`docs/plans` 제외) — 검증: 코드 대조, `bun run build` [사용자 결정]
- DoD-19: `package.json`의 `name`이 `gopepe-swap`이다 — 검증: 코드 대조 [사용자 결정]

### 3.5 정합성

- DoD-20: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`가 모두 통과한다 — 검증: 명령 실행 확인 [제안 후 승인]

### 3.6 릴리스

- DoD-21: F8 머지 커밋에 `v1.0.0` 태그가 붙어 원격 저장소에 있다 — 검증: `git ls-remote --tags` 명령 실행 확인 [사용자 결정]

## 4. 인터페이스 계약

### 4.1 Vercel WAF 레이트 리밋

- 대상: 경로 접두사 `/api/rpc/`, production과 preview 배포 모두 [사용자 결정]
- 키: 클라이언트 IP [사용자 결정]
- 한도: 60초 고정 창에 120건 [사용자 결정]
- 초과 응답: HTTP 429 [사용자 결정]

### 4.2 Vercel 환경 변수

- Production: `ETH_MAINNET_RPC_URL`, `BASE_MAINNET_RPC_URL`, `ARB_MAINNET_RPC_URL` [사용자 결정]
- Preview·Development: 업체 RPC 변수를 두지 않는다 [사용자 결정]
- `NEXT_PUBLIC_E2E_MOCK`은 어느 환경에도 두지 않는다 [제안 후 승인]

## 5. 엣지 케이스와 실패 시나리오

### 5.1 레이트 리밋

- EC-1: 브라우저 RPC 요청이 WAF 429를 받으면 화면은 기존 실패 상태(견적 `error`, 잔액 미확인)를 그대로 따른다 — 검증: 코드 대조 (429 전용 분기 없음) [제안 후 승인]
- EC-2: 같은 NAT 뒤의 사용자들이 한도를 함께 쓰는 것을 받아들이고, README에 적지 않는다 — 검증: 코드 대조 [제안 후 승인]

### 5.2 함수 실행 시간

- EC-3: DoD-6의 함수 최대 실행 시간이 11초보다 짧으면 구현을 멈추고 사용자 결정을 다시 받는다. 라우트에 `maxDuration`을 미리 선언하지 않는다 — 검증: 계획 기록 대조, 코드 대조 [제안 후 승인]

### 5.3 배포 환경 차이

- EC-4: preview 배포는 업체 RPC 키가 없어 공개 RPC로만 동작한다. 기존 프록시 동작(환경 변수 없음 → 공개 RPC) 외에 추가 처리를 하지 않는다 — 검증: 코드 대조 (프록시 코드 무변경) [제안 후 승인]
- EC-5: Vercel 빌드의 Node·bun 버전이 DoD-4와 다르면 Vercel 프로젝트 설정으로 맞추고, `package.json`에 `engines`를 추가하지 않는다 — 검증: 코드 대조, 빌드 로그 기록 [제안 후 승인]

### 5.4 브랜치 보호

- EC-6: 관리자도 브랜치 보호를 우회할 수 없다. 보호를 켜는 시점과 F8 PR 머지의 순서는 계획에서 정한다 — 검증: `gh api` 명령 실행 확인 (`enforce_admins`) [제안 후 승인]

## 미결정 사항

없음
