# 계획: deploy-readme

- 상태: 승인
- 스펙: docs/specs/deploy-readme.md
- 기준 코드: 1f1ef6a + 작업 트리
- 최종 갱신: 2026-11-21

## 1. 구현 전략

- 자동 테스트 Task를 두지 않는다. 연결 항목이 외부 서비스 설정(Vercel·GitHub), README 문구, 아이콘 렌더링, 코드 무변경 대조로만 이루어져 있고, 문구·렌더링 테스트는 프로젝트 규칙이 금지한다. 5단계(테스트 설계)는 사용자 승인(2026-11-21)으로 건너뛰고 사유를 `테스트 설계 증거`에 적는다 — 근거: `CLAUDE.md` "테스트 규칙"
- 기존 테스트·제품 동작 코드(`lib/rpc-proxy.ts`, `config/rpc.ts`, `app/api/**`)는 바꾸지 않는다. F1~F7 골격 digest는 그대로 유지된다 — 근거: `lib/rpc-proxy.ts:205-225`, `config/rpc.ts:31-57`
- 외부 설정 변경(Vercel 대시보드, `gh api` PUT·PATCH, 태그 push)은 실행 직전에 명령·값을 보여 주고 사용자 확인을 받는다. 계획 승인은 실행 승인이 아니다 — 근거: `CLAUDE.md` "브랜치와 커밋"
- 수동 확인 결과는 각 Task의 구현 기록에 남긴다. 업체 RPC는 호스트·키 없이 "업체 RPC(Ethereum)" 같은 라벨로만 적는다 — 근거: `docs/plans/approve-swap.md:236-248`, `docs/plans/quote.md:167-179`
- 일회성 스크립트(가스 측정, ICO 조립)는 저장소 밖 `/root/study/.pipeline-scratch/deploy-readme/`에 두고 내용을 구현 기록에 보존한다 — 근거: `docs/plans/native-eth.md:31-38`
- DoD-10 기록: F5에서 넘어온 Ethereum 메인넷 쓰기 확인은 사용자 확인 완료(로컬, tx 해시 없음)다(사용자 진술, 2026-11-21) — 근거: `docs/specs/approve-swap.md:30`
- 조사 시점 GitHub 상태: main 보호에 required checks `check`·`e2e`(GitHub Actions app 15368), `enforce_admins`, force-push·삭제 금지가 이미 있고 PR 필수가 없다. 머지 옵션은 merge·squash·rebase가 모두 켜져 있다. check 이름은 `.github/workflows/ci.yml:15,32`의 job id다 — 근거: `gh api repos/tlatjdgh3778/gopepe-swap/branches/main/protection`

## 2. Task

### T-1 — `eth_call` 가스 상한 측정

- 사이드: 조사
- 상태: 완료
- 목적: 세 체인 × {업체 RPC, viem 공개 RPC} 6개 엔드포인트의 `eth_call` 가스 상한을 잰다
- 선행: 없음
- 연결 항목: DoD-8
- 수정 대상: 없음. 스크립트는 `/root/study/.pipeline-scratch/deploy-readme/t1/`
- 따라야 할 패턴: `.env.local`은 `@next/env` `loadEnvConfig`(silent) 후 `resetEnv()`로 읽는다, F3 상한 측정 — 근거: `playwright.config.ts:9-29`, `docs/plans/quote.md:33-36`
- 완료 조건: 아래 절차로 6개 엔드포인트마다 날짜, 블록 번호, M1 값, M2 결과(값 또는 오류 code·message와 최대 수락 gas), 보정값을 기록하고 anvil 종료를 확인한다. 출력에는 `.result`·`.error.code`·`.error.message`와 예외 `name`만 남기고 URL을 남기지 않는다(`cast`·`curl -S`·`set -x` 미사용). 절차: (0) 보정 — 포크 없는 `anvil --port 8555 --gas-limit 50000000`에서 M1을 실행해 `보정값 = 50,000,000 − 반환값`을 구한다. (M1) gas 생략 — `eth_call {data: "0x5a60005260206000f3"}`(생성 호출, `GAS PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`) 반환값 + 보정값을 기본 상한으로 기록한다. 견적 호출이 gas를 지정하지 않으므로 이 값이 앱에 해당한다(`lib/read-swap-quote.ts:57`). (M2) gas 명시 — 같은 호출에 `gas: 0x3b9aca00`을 보내 깎인 값을 기록하고, 오류면 1M 단위 이분 탐색으로 최대 수락 gas를 찾는다 — 검증: 확인 절차
- 실행 명령: `anvil --port 8555 --gas-limit 50000000`, `bun /root/study/.pipeline-scratch/deploy-readme/t1/measure.ts`
- 수정 금지: 저장소의 모든 파일
- 구현 기록: 담당 `general-purpose`(조사 전용 에이전트 없음). 작성 영역: 저장소 밖 `/root/study/.pipeline-scratch/deploy-readme/t1/`. 2026-11-21 11:35 UTC 측정. 보정값 53,124(포크 없는 anvil 50M에서 반환 49,946,876, 이론값과 일치). gas 생략 기본 상한(M1): 업체 RPC(Ethereum) 550,000,000(블록 26463214), 공개 RPC(Ethereum) `https://ethereum.reth.rs/rpc` 50,000,000(블록 26463214), 업체 RPC(Base) 550,000,000(블록 60352666), 공개 RPC(Base) `https://mainnet.base.org` 600,000,000(블록 60352672), 업체 RPC(Arbitrum) 1,100,000,000(블록 526225003), 공개 RPC(Arbitrum) `https://arb1.arbitrum.io/rpc` 50,000,000(블록 526225007). M2(gas 1e9 명시): 6곳 모두 오류 없이 각 상한으로 깎임(업체 Arbitrum은 1e9 그대로), 이분 탐색 미실행. F3 대비: Ethereum·Arbitrum 공개 50M·업체 550M 이상과 일치, 공개 Base 600M은 신규, 업체 Arbitrum 1.1B. 스크립트·출력 `/root/study/.pipeline-scratch/deploy-readme/t1/measure.ts`·`measure.out`(오케스트레이터 확인: 업체 호스트 0건, anvil 종료, 저장소 무변경). 수정 0/3

### T-2 — Vercel 프로젝트·환경 변수·WAF

- 사이드: 운영(사용자 수동, 에이전트 읽기 보조)
- 상태: 완료
- 목적: Git 연동 production 배포와 URL을 만들고, 환경 변수·Node 버전·함수 최대 실행 시간·WAF 규칙을 설정하고 기록한다
- 선행: 없음
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-6, DoD-7, EC-3, EC-5
- 수정 대상: 없음(`vercel.json`, `engines` 추가 없음). 외부 설정만 바꾼다
- 따라야 할 패턴: 수동 확인 기록 형식 — 근거: `docs/plans/approve-swap.md:236-248`
- 완료 조건: 사용자 대시보드 절차 (1) 저장소 Import(프로젝트 이름 `gopepe-swap`, Production Branch `main`, Import 화면에서는 환경 변수를 넣지 않음) (2) Node.js 24.x (3) 업체 RPC 변수 3개를 Production에만 등록 (4) production Redeploy (5) Functions의 최대 실행 시간 확인 — 11초 미만이면 즉시 중단하고 사용자 결정을 받으며 T-4~T-6을 시작하지 않는다 (6) Firewall 레이트 리밋 규칙 추가·Publish, 요금제에서 쓸 수 없으면 중단하고 질문 (7) 빌드 로그의 bun.lock 감지·`bun install`·Node 버전 줄 전달 (8) production URL에서 세 체인 견적 확인. 에이전트는 `gh api .../deployments`로 production 배포 SHA가 `1f1ef6a`인지, `curl`로 URL이 200인지 대조한다. URL, 배포 SHA, 환경별 변수 이름, 빌드 로그 발췌, 최대 실행 시간, WAF 규칙 값과 적용 범위, 세 체인 견적 결과를 기록한다 — 검증: 확인 절차
- 실행 명령: `gh api repos/tlatjdgh3778/gopepe-swap/deployments --jq '.[] | {id, sha, environment, created_at}'`, `gh api repos/tlatjdgh3778/gopepe-swap/deployments/{id}/statuses --jq '.[0] | {state, environment_url}'`, `curl -s -o /dev/null -w '%{http_code}' https://{url}/`
- 수정 금지: 저장소의 모든 파일, Vercel Preview·Development 환경 변수
- 구현 기록: 사용자 대시보드 수행, 오케스트레이터가 ego-browser·`curl`로 확인(2026-11-21). Vercel GitHub App 저장소 접근에 `gopepe-swap`을 추가한 뒤 Import, 첫 배포는 사용자가 Create Deployment(main)로 실행. URL: production 도메인 `https://gopepe-swap.vercel.app`(배포 `gopepe-swap-35vtf2n77-seonghos-projects-03a1ce1f.vercel.app`), `curl` 200. 배포: Production, Ready, 소스 main `1f1ef6a`(PR #9 머지 커밋), 빌드 42s. Vercel 수동 배포라 GitHub deployments에는 기록이 없다. 환경 변수: `ETH_MAINNET_RPC_URL`·`BASE_MAINNET_RPC_URL`·`ARB_MAINNET_RPC_URL` 모두 Production만, `NEXT_PUBLIC_E2E_MOCK` 없음. Node.js Version 설정 24.x(빌드 로그에는 Node 버전 줄이 없다). 배포 Resources 탭에서 함수 4개(`/api/rpc/[chainId]` 포함) 런타임이 모두 `Node.js 24.x`임을 확인(7단계 검증 지적 반영, 2026-11-21). 빌드 로그 발췌: "Detected `bun.lock` generated by bun@1.4.x", "bun install v1.4.4", "384 packages installed", "Detected Next.js version: 16.3.4", "Running \"bun run build\"", "Build Completed in /vercel/output [36s]". 함수: Fluid compute 켜짐, Default Max Duration 미입력 → 기본 300초(입력란 placeholder 300, max 900) → EC-3 게이트 통과. 리전 iad1. WAF: 프로젝트 규칙 `rpc-rate-limit` 1개 active — If Request Path Starts with `/api/rpc/`, Rate Limit Fixed Window 60초 120건, Rate Limit By IP Address, Then Too Many Requests (429). 환경 조건 없이 프로젝트 전체에 적용. 폼 입력은 오케스트레이터가 ego-browser로 채우고 저장·게시는 사용자가 했다. 차단 동작은 미검증(스펙 비목표). DoD-5: production에서 미연결 상태 ETH→USDC 0.01 견적 표시 — Ethereum 16.5018 USDC(티어 0.01%), Base 16.5056 USDC(티어 0.01%), Arbitrum 16.4928 USDC(티어 0.05%), 사용자 스크린샷. 수정 0/3

### T-3 — GitHub 브랜치 보호·머지 옵션

- 사이드: 운영(사용자 실행 승인 후 에이전트 `gh api`)
- 상태: 완료
- 목적: main 보호에 PR 필수를 더하고 머지 옵션을 merge commit 하나로 줄인다
- 선행: 없음. F8 PR을 열기 전에 끝낸다
- 연결 항목: DoD-11, DoD-12, EC-6
- 수정 대상: 없음. 외부 설정만 바꾼다
- 따라야 할 패턴: 기존 보호 값을 유지하고 PR 항목만 더한다. PUT은 전체를 덮어쓰므로 기존 값(checks `check`·`e2e` app 15368, strict false, enforce_admins, force-push·삭제 금지)을 모두 다시 보낸다 — 근거: 조사 시점 `gh api .../branches/main/protection` GET 결과(§1)
- 완료 조건: 실행 직전에 PUT 본문과 PATCH 명령을 사용자에게 보여 주고 확인을 받는다. 확인용 GET 두 개의 결과가 연결 항목과 일치하고 결과를 기록한다 — 검증: 명령
- 실행 명령: `gh api -X PUT repos/tlatjdgh3778/gopepe-swap/branches/main/protection --input /root/study/.pipeline-scratch/deploy-readme/t3/protection.json`, `gh api -X PATCH repos/tlatjdgh3778/gopepe-swap -F allow_merge_commit=true -F allow_squash_merge=false -F allow_rebase_merge=false`, `gh api repos/tlatjdgh3778/gopepe-swap/branches/main/protection --jq '{pr: .required_pull_request_reviews.required_approving_review_count, checks: [.required_status_checks.checks[].context], strict: .required_status_checks.strict, admins: .enforce_admins.enabled, force: .allow_force_pushes.enabled, del: .allow_deletions.enabled}'`, `gh api repos/tlatjdgh3778/gopepe-swap --jq '{allow_merge_commit, allow_squash_merge, allow_rebase_merge}'`
- 수정 금지: 저장소 파일, rulesets, Actions 시크릿, 저장소 homepage·description
- 구현 기록: 사용자 실행 승인(2026-11-21). 담당 `general-purpose`(운영 전용 에이전트 없음). 작성 영역: 외부 설정만. 실행 전 GET: 보호 `{admins:true, checks:[check,e2e](app 15368), del:false, force:false, pr:null, strict:false}`, 머지 옵션 merge·squash·rebase 모두 true. PUT·PATCH 성공(본문 `/root/study/.pipeline-scratch/deploy-readme/t3/protection.json`). 실행 후 GET(오케스트레이터 재확인 2026-11-21): 보호 `{admins:true, checks:[check,e2e], del:false, force:false, pr:0, strict:false}`, 머지 옵션 `{allow_merge_commit:true, allow_rebase_merge:false, allow_squash_merge:false}`. 저장소 파일 무변경. 수정 0/3

### T-4 — 'G' 아이콘

- 사이드: 프론트
- 상태: 완료
- 목적: `app/icon.svg`를 만들고 같은 디자인의 16·32px `app/favicon.ico`로 교체한다
- 선행: T-2 (5) 통과
- 연결 항목: DoD-16
- 수정 대상: `app/icon.svg` — 신규(viewBox 32, 둥근 사각 배경, path 'G', text 요소 미사용), `app/favicon.ico` — 교체(이미지 16·32 두 장)
- 따라야 할 패턴: 색 토큰 `app/globals.css:77,85`·`docs/design/README.md:18,26`, radius sm 8px `docs/design/README.md`, Next 아이콘 파일 규약 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/app-icons.md`. ICO는 저장소 밖 일회성 bun 스크립트(`/root/study/.pipeline-scratch/deploy-readme/t4/`)가 `createRequire`로 기존 `node_modules/sharp`를 불러 `app/icon.svg`를 16·32 PNG로 렌더링한 뒤 ICO 헤더·엔트리를 직접 조립한다. 새 의존을 추가하지 않는다 — 근거: `package.json:52-59`
- 완료 조건: DoD-16의 코드 대조 부분 충족. `file app/favicon.ico`가 16x16·32x32 두 이미지를 보고하고, ICO에서 꺼낸 PNG의 배경 픽셀이 `--bg`, 글자 영역 픽셀이 `--accent` 값이다. 스크립트 전문을 구현 기록에 남긴다 — 검증: 확인 절차, 명령
- 실행 명령: `bun /root/study/.pipeline-scratch/deploy-readme/t4/build-icon.ts`, `file app/favicon.ico`
- 수정 금지: `app/layout.tsx`, `public/`, `package.json`, `bun.lock`, `app/globals.css`. `bun run build` 실행 금지(T-5와 `.next` 충돌)
- 구현 기록: 담당 `seongho:frontend-dev`. 작성 영역: `app/icon.svg`, `app/favicon.ico`, 저장소 밖 `/root/study/.pipeline-scratch/deploy-readme/t4/`. IMPLEMENTED. `app/icon.svg`: viewBox 32, `rect rx=8 fill=#101312`, 단일 fill path 'G' `#a5e8c5`(text 요소 없음). `app/favicon.ico` 968B, PNG 내장 16·32 두 엔트리. 스크립트 `/root/study/.pipeline-scratch/deploy-readme/t4/build-icon.ts`(sharp `createRequire`, density로 크기별 직접 래스터화, ICO 헤더·엔트리 직접 조립, 쓴 ICO를 다시 읽어 픽셀 검사): 배경 (16,19,18,255)·글자 (165,232,197,255)·모서리 alpha 0 모두 OK. 오케스트레이터 확인: `file app/favicon.ico` = "2 icons, 16x16 … 32x32", 32px PNG 육안 확인. 수정 0/3

### T-5 — metadata·기본 자산·패키지 이름

- 사이드: 프론트
- 상태: 완료
- 목적: metadata description을 넣고, create-next-app SVG를 지우고, 패키지 이름을 바꾼다
- 선행: T-2 (5) 통과
- 연결 항목: DoD-17, DoD-18, DoD-19, EC-5
- 수정 대상: `app/layout.tsx` — `metadata` 객체만, `public/file.svg`·`public/globe.svg`·`public/next.svg`·`public/vercel.svg`·`public/window.svg` — 삭제, `package.json` — `name`만, `bun.lock` — 6번 줄 `name`만 수동 수정(bun 1.4.2의 `bun install`이 `package.json` name 변경을 lockfile에 반영하지 않는다. 사용자 결정 2026-11-21)
- 따라야 할 패턴: 기존 metadata 선언 `app/layout.tsx:22-24`, CI의 `bun install --frozen-lockfile` — 근거: `.github/workflows/ci.yml:27,50`, `bun.lock:6`
- 완료 조건: 연결 항목 충족. `git diff bun.lock`이 이름 한 줄이고 `bun install --frozen-lockfile`·`bun run typecheck`·`bun run build`가 통과한다. `grep -rnE '(file|globe|next|vercel|window)\.svg' --exclude-dir={node_modules,.next,.next-e2e,.git,docs} .` 결과가 없다 — 검증: 명령
- 실행 명령: `bun install`, `git diff bun.lock`, `bun install --frozen-lockfile`, `bun run typecheck`, `bun run build`
- 수정 금지: `app/favicon.ico`, `app/icon.svg`, `README.md`, `lib/rpc-proxy.ts`, `config/rpc.ts`, `app/api/**`, `package.json`의 다른 필드
- 구현 기록: 담당 `seongho:frontend-dev`(T-4와 별도 인스턴스). 작성 영역: `app/layout.tsx`, `public/*.svg` 삭제, `package.json`, `bun.lock`. 1차 보고 NEEDS-DECISION: `bun install`(bun 1.4.2)이 `package.json` name 변경을 `bun.lock:6`에 반영하지 않는다("no changes", diff 없음). `bun.lock:6`이 `frontend`든 손으로 고친 `gopepe-swap`이든 `--frozen-lockfile` 통과(에이전트 scratchpad 확인, 오케스트레이터 재확인). 나머지(metadata, SVG 5개 삭제, name, engines 없음)는 완료, typecheck·build·grep 통과. 재위임 1회(SendMessage, 사용자 결정 반영): `bun.lock:6` name 수동 수정. 최종: `app/layout.tsx:22-25` description 추가, SVG 5개 삭제(`public/` 디렉터리 소멸), `package.json:2`·`bun.lock:6` `gopepe-swap`, `engines` 없음. 오케스트레이터 확인: `git diff bun.lock` 한 줄, `bun install --frozen-lockfile` no changes, 참조 grep 0건, typecheck·build 통과(에이전트 보고). 수정 1/3(원인: 계획의 lockfile 재생성 가정 오류)

### T-6 — README

- 사이드: 문서
- 상태: 완료
- 목적: create-next-app README를 한국어 README로 교체한다
- 선행: T-1, T-2
- 연결 항목: DoD-9, DoD-13, DoD-14, DoD-15, EC-2
- 수정 대상: `README.md` — 전체 교체
- 따라야 할 패턴: 기능 사실은 각 스펙 §1(`docs/specs/wallet-chains.md`, `token-amount-input.md`, `quote.md`, `slippage.md`, `approve-swap.md`, `tx-status.md`, `native-eth.md`), 알려진 한계는 `docs/specs/quote.md:32`·`docs/specs/native-eth.md:36,38`·각 스펙 비목표와 T-1 결과, 명령은 `CLAUDE.md` "명령"·`.nvmrc`·`package.json` `packageManager`, 업체 변수 없음 → 공개 RPC 동작은 `config/rpc.ts:31-57`. `docs/overview.md`·`CLAUDE.local.md`로 링크하거나 그 내용에 기대지 않는다 — 근거: `CLAUDE.local.md`
- 완료 조건: 연결 항목 충족. 라이브 링크는 T-2 기록 URL이다. 알려진 한계의 "등" 항목은 위 스펙 출처 안에서만 고르고 8단계 검토에서 확정한다. `bun run format:check`가 통과한다 — 검증: 코드 대조, 명령
- 실행 명령: `bun run format`, `bun run format:check`
- 수정 금지: `.env.example`, `docs/specs/*`, 제품 코드
- 구현 기록: 담당 `general-purpose`(문서 전용 에이전트 없음). 작성 영역: `README.md`. IMPLEMENTED. `README.md` 전체 교체: 제목+한 줄 소개(:3), 라이브 링크(:5-7, `https://gopepe-swap.vercel.app`), 주요 기능 v1(:9-19), 로컬 실행·환경 변수(:21-51, 변수 3개 표), 알려진 한계(:53-61, 가스 상한 T-1 수치·7702 unwrap·수수료 미표시 + 멀티홉/exactOutput·달러 환산·WalletConnect·토큰 주소 추가 없음). NAT·횟수 제한 언급 없음. 에이전트가 문장별 출처 스펙 매핑을 보고함. `bun run format:check` 통과(오케스트레이터 재확인). "등" 항목 선택은 8단계 검토에서 확정. 수정 0/3

### T-7 — 코드 대조와 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 커밋 전에 확인할 수 있는 항목을 대조하고 정합성 명령을 순서대로 통과시킨다
- 선행: T-1, T-2, T-3, T-4, T-5, T-6
- 연결 항목: DoD-9, DoD-10, DoD-13, DoD-14, DoD-15, DoD-16, DoD-17, DoD-18, DoD-19, DoD-20, EC-1, EC-2, EC-3, EC-4, EC-5
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 전체 검사 Task — 근거: `docs/plans/approve-swap.md:236-248`, `docs/plans/native-eth.md` T-17
- 완료 조건: 연결 항목 대조 결과를 기록한다. `git diff 1f1ef6a -- lib/rpc-proxy.ts config/rpc.ts app/api`가 비어 있고, 제품 코드에 429 전용 분기와 `maxDuration` 선언이 없고, `package.json`에 `engines`가 없다. `bun run build` 뒤 `bun run start -p 3200`으로 `/`의 title·description과 icon link 2개, `/favicon.ico`·`/icon.svg` 200, `/next.svg` 404를 확인하고 서버를 종료한다. 실행 명령을 순서대로 하나씩 실행해 모두 통과하고, `check:build`는 `test:e2e`가 끝난 뒤 단독으로 실행한다 — 검증: 코드 대조, 명령
- 실행 명령: `bun install --frozen-lockfile`, `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run start -p 3200`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: 7단계 독립 검증으로 수행(2026-11-21, 코드 기준 `1f1ef6a` + 작업 트리). 코드 대조: 새 `general-purpose` + `seongho:verify`(읽기 전용) — 코드 대조 가능 13개 충족, 미충족 0, 스코프 초과·드리프트 0, `git diff 1f1ef6a -- lib/rpc-proxy.ts config/rpc.ts app/api`·`-- __tests__ e2e` 비어 있음, 429 분기·`maxDuration`·`engines` 0건. 지적 2건(DoD-4 Node 로그 증거, T-1 공개 RPC 블록 번호)은 오케스트레이터가 T-1·T-2 기록에 보완. 실행: `seongho:test-runner` — `bun install --frozen-lockfile` no changes, `format:check`·`lint`·`typecheck` 통과, `test` 45 files 324/324, `build` 통과(`○ /icon.svg`), `test:fork` 5 files 18/18. 로컬 확인은 포트 3200이 다른 프로젝트 점유라 3210으로 바꿔 실행: title `GOPEPE Swap`, description 스펙 문자열, icon link 2개(`/favicon.ico` sizes 32x32 image/x-icon, `/icon.svg` sizes any image/svg+xml), `/favicon.ico`·`/icon.svg` 200, `/next.svg`·`/vercel.svg` 404, 서버 종료 확인. `seongho:e2e-runner` — `test:e2e` 33/33(flaky·skip 0). 이어서 `check:build` 단독 실행 통과(DoD-19 카나리 없음, DoD-20 음성·양성 통과). 모든 실행 전후 `git status` 동일

### T-8 — PR 검사와 preview 아이콘 확인

- 사이드: 검증(사용자 수동 + 에이전트 `gh`)
- 상태: 완료
- 목적: F8 PR에서 required checks가 통과하는지와 preview 배포의 탭 아이콘을 확인한다
- 선행: 9단계 커밋·push·PR 생성(사용자 승인), T-3
- 연결 항목: DoD-11, DoD-16, DoD-20
- 수정 대상: `docs/plans/deploy-readme.md` — 구현 기록만(F8 브랜치 추가 커밋, 사용자 승인)
- 따라야 할 패턴: 수동 확인 기록 형식 — 근거: `docs/plans/approve-swap.md:236-248`
- 완료 조건: `gh pr checks`에서 `check`·`e2e`가 required로 통과한다. GitHub deployment statuses에서 F8 브랜치 preview URL을 얻고, 사용자가 그 URL의 탭 아이콘을 확인한다. 결과를 기록한다 — 검증: 확인 절차, 명령
- 실행 명령: `gh pr checks {PR} --required`, `gh api repos/tlatjdgh3778/gopepe-swap/deployments --jq '.[] | select(.environment != "Production") | {id, sha, environment}'`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: 오케스트레이터 수행(2026-11-21). PR #10(커밋 `3912c5f`). GitHub deployments는 Vercel Git 연동에서도 0건이라 계획의 `gh api .../deployments` 대신 Vercel PR 코멘트·커밋 status에서 preview URL `https://gopepe-swap-git-feat-deploy-readme-seonghos-projects-03a1ce1f.vercel.app`을 얻었다. ego-browser(로그인 프로필)로 열어 title `GOPEPE Swap`, description 스펙 문자열, icon link 2개(`/favicon.ico` 32x32 `image/vnd.microsoft.icon` 200, `/icon.svg` any `image/svg+xml` 200) 확인. 사용자가 preview 탭에서 'G' 아이콘을 확인했다(DoD-16 머지 전 수동 확인). PR 체크 `Vercel`·`Vercel Preview Comments` pass. required checks `check`·`e2e` 결과는 이 기록 커밋 이후에 나오므로 PR #10 코멘트에 남긴다

### T-9 — 머지 후 production 확인과 v1.0.0 태그

- 사이드: 검증·릴리스(사용자 머지 후 에이전트 실행, 태그 push는 사용자 확인)
- 상태: 대기
- 목적: F8 머지 커밋의 production 배포와 탭 아이콘을 PR 코멘트로 기록하고 `v1.0.0` 태그를 붙인다
- 선행: 사용자가 F8 PR을 merge commit으로 머지
- 연결 항목: DoD-1, DoD-16, DoD-21
- 수정 대상: 없음(저장소 파일 무변경). F8 PR 코멘트, 원격 태그
- 따라야 할 패턴: `CLAUDE.md` "브랜치와 커밋"(v1 배포 시점 `v1.0.0` 태그, main 직접 커밋 금지)
- 완료 조건: `gh api .../deployments`에서 Production 배포 SHA가 F8 머지 커밋이고 URL이 200이며, 사용자가 production 탭 아이콘을 확인한 결과를 F8 PR 코멘트로 남긴다. 태그 명령을 보여 주고 확인을 받은 뒤 머지 커밋에 annotated 태그 `v1.0.0`을 push하고 `git ls-remote --tags origin v1.0.0`이 머지 커밋을 가리킨다 — 검증: 확인 절차, 명령
- 실행 명령: `git fetch origin main`, `gh api repos/tlatjdgh3778/gopepe-swap/deployments --jq '.[] | select(.environment == "Production") | {sha, created_at}'`, `gh pr comment {PR} --body-file /root/study/.pipeline-scratch/deploy-readme/t9/comment.md`, `git tag -a v1.0.0 {머지 커밋} -m "v1.0.0"`, `git push origin v1.0.0`, `git ls-remote --tags origin v1.0.0`
- 수정 금지: main 직접 커밋, 저장소 파일
- 구현 기록: 없음

## 3. 항목 coverage

- DoD-1: T-2, T-9
- DoD-2: T-2
- DoD-3: T-2
- DoD-4: T-2
- DoD-5: T-2
- DoD-6: T-2
- DoD-7: T-2
- DoD-8: T-1
- DoD-9: T-6, T-7
- DoD-10: T-7
- DoD-11: T-3, T-8
- DoD-12: T-3
- DoD-13: T-6, T-7
- DoD-14: T-6, T-7
- DoD-15: T-6, T-7
- DoD-16: T-4, T-7, T-8, T-9
- DoD-17: T-5, T-7
- DoD-18: T-5, T-7
- DoD-19: T-5, T-7
- DoD-20: T-7, T-8
- DoD-21: T-9
- EC-1: T-7
- EC-2: T-6, T-7
- EC-3: T-2, T-7
- EC-4: T-7
- EC-5: T-2, T-5, T-7
- EC-6: T-3

## 4. 실행 순서

- 1구간(병렬): T-1 / T-2 / T-3. 저장소 파일을 수정하지 않는다. T-1은 포트 8555를 쓴다
- 게이트: T-2 (5) 함수 최대 실행 시간이 11초 이상일 때만 2구간으로 간다(EC-3)
- 2구간(병렬, 수정 파일 겹침 없음): T-4(`app/favicon.ico`, `app/icon.svg`) / T-5(`app/layout.tsx`, `public/*`, `package.json`, `bun.lock`) / T-6(`README.md`, T-1·T-2 완료 후). `bun run build`는 T-5만 실행한다
- 3구간(순차): T-7
- 7~9단계: 독립 검증 → 사용자 최종 승인 → 커밋 → push → PR
- 4구간: T-8
- 사용자 머지(merge commit) 뒤 5구간: T-9

## 5. 차단 사항

- 없음

## 테스트 설계 증거

- 상태: 생략(사용자 승인 2026-11-21)
- 사유: 모든 연결 항목이 외부 서비스 설정(DoD-1부터 DoD-8, DoD-11, 12, 21), README 문구(DoD-9, DoD-13부터 DoD-15), 아이콘 렌더링(DoD-16), metadata 리터럴(DoD-17), 삭제·이름 변경(DoD-18, 19), 코드 무변경 대조(EC-1, 3, 4)라서 `CLAUDE.md` "테스트 규칙"상 자동 테스트를 쓰지 않는다. DoD-8 측정 방법은 T-1 절차로 확정했다(스펙 DoD-8)
- 7단계: `seongho:verify` 스펙 대조(코드 대조 항목)와 `test-runner`의 T-7 명령 실행으로 검증한다. 기존 테스트와 F1~F7 골격은 바뀌지 않는다

### 검증 기록

- 코드 기준: `1f1ef6a` + 작업 트리(미커밋, 2026-11-21)
- 스펙 대조: 새 `general-purpose` + `seongho:verify`(읽기 전용, 실행 없음)
- 테스트 실행: `seongho:test-runner`(정합성 명령 7개 + 로컬 start 확인), `seongho:e2e-runner`(`test:e2e`)
- 외부 상태: 오케스트레이터가 ego-browser(Vercel 대시보드)·`gh api`·`curl`로 직접 확인
- 표기: "충족(코드)"는 사용자 승인으로 자동 테스트를 두지 않은 항목(문구·렌더링, `테스트 설계 증거`)으로 코드 대조만 근거다

| 스펙 항목 | 코드 대조         | 실행·외부 확인                                                                    | 종합              |
| --------- | ----------------- | --------------------------------------------------------------------------------- | ----------------- |
| DoD-1     | 검증 불가(외부)   | Git 연결, production `1f1ef6a` Ready(T-2). F8 머지 커밋 자동 배포는 T-9           | 부분(머지 후 T-9) |
| DoD-2     | 검증 불가(외부)   | `https://gopepe-swap.vercel.app` 200(T-2)                                         | 충족              |
| DoD-3     | 검증 불가(외부)   | 변수 3개 Production만, E2E 플래그 없음(T-2)                                       | 충족              |
| DoD-4     | 검증 불가(외부)   | bun.lock 감지·bun install 로그, 함수 런타임 Node.js 24.x(T-2)                     | 충족              |
| DoD-5     | 검증 불가(외부)   | 세 체인 견적 표시(T-2, 사용자 스크린샷)                                           | 충족              |
| DoD-6     | 검증 불가(외부)   | 기본 300초(T-2)                                                                   | 충족              |
| DoD-7     | 검증 불가(외부)   | 규칙 `rpc-rate-limit` active, 값 일치(T-2). 차단 동작 미검증(비목표)              | 충족              |
| DoD-8     | 검증 불가(외부)   | 6개 엔드포인트 측정 기록(T-1)                                                     | 충족              |
| DoD-9     | 충족              | `README.md:55` = T-1 값                                                           | 충족(코드)        |
| DoD-10    | 충족              | 계획 §1 기록                                                                      | 충족              |
| DoD-11    | 검증 불가(외부)   | `gh api` GET 일치(T-3). PR required checks 동작은 T-8                             | 부분(T-8)         |
| DoD-12    | 검증 불가(외부)   | `gh api` GET 일치(T-3)                                                            | 충족              |
| DoD-13    | 충족              | 해당 없음                                                                         | 충족(코드)        |
| DoD-14    | 충족              | 해당 없음                                                                         | 충족(코드)        |
| DoD-15    | 충족              | 해당 없음                                                                         | 충족(코드)        |
| DoD-16    | 충족(코드 대조분) | `file` 2 icons, 로컬 start에서 icon link 2개·200. 브라우저 탭 수동 확인은 T-8·T-9 | 부분(T-8·T-9)     |
| DoD-17    | 충족              | 로컬 start HTML title·description 일치                                            | 충족              |
| DoD-18    | 충족              | `build` 통과, `/next.svg`·`/vercel.svg` 404                                       | 충족              |
| DoD-19    | 충족              | `bun install --frozen-lockfile` 통과                                              | 충족              |
| DoD-20    | 해당 없음         | 8개 명령 전부 통과. PR CI는 T-8                                                   | 충족(로컬)        |
| DoD-21    | 검증 불가(미수행) | T-9                                                                               | 미수행(머지 후)   |
| EC-1      | 충족              | 429 분기 0건, `test` 통과                                                         | 충족(코드)        |
| EC-2      | 충족              | 해당 없음                                                                         | 충족(코드)        |
| EC-3      | 충족              | 300초 ≥ 11초(T-2), `maxDuration` 0건                                              | 충족              |
| EC-4      | 충족              | 프록시 diff 없음, `test`·`test:fork`·`test:e2e` 통과                              | 충족              |
| EC-5      | 충족              | `engines` 없음, Node 24.x(T-2)                                                    | 충족              |
| EC-6      | 검증 불가(외부)   | `enforce_admins` true(T-3)                                                        | 충족              |
