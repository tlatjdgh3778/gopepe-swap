# 계획: usd-price

- 상태: 승인
- 스펙: docs/specs/usd-price.md
- 기준 코드: 91d4116 + 작업 트리 (branch feat/usd-price)
- 최종 갱신: 2026-11-22

## 1. 구현 전략

- 순서: 사전 확인 → config·lib 순수 함수 → 단가 조회 함수 → 훅·provider → 화면 → 테스트(단위, 통합, 포크) → 기존 테스트 회귀 확인과 F3 E2E 갱신 → E2E → 수동 확인 → 전체 검사. 근거: `docs/plans/native-eth.md:10`, `docs/plans/quote.md:10`
- 티어 선택은 기존 규칙을 다시 쓴다. 토큰 1개(10^decimals)로 네 티어 `quoteExactInputSingle`를 보내고 `selectFeeTier`에 넘겨 revert·수령량 0·유동성 소진 티어를 뺀다. 고른 티어의 `slot0` 하위 호출이 실패하면 `buildSwapQuote`처럼 throw한다. 근거: `lib/swap-quote.ts:215,233-253`, `lib/read-swap-quote.ts:66-92`
- 현물가는 고른 티어 풀 `slot0.sqrtPriceX96`로 만든 유리수다. 대상 토큰 B와 기준 토큰 Q를 `sortTokens`로 정렬해 B가 token0이면 `{sqrtP², 2^192}`, token1이면 `{2^192, sqrtP²}`(Q raw / B raw)다. `calculatePriceImpactBps`의 현물가 식과 같으며 두 순서를 T-1 (4)에서 실측으로 맞춘다. 근거: `lib/swap-quote.ts:101,108,290-294`
- WETH 경유 단가는 토큰→WETH와 WETH→USDC 유리수의 분자끼리·분모끼리 곱이다. 토큰→WETH 티어가 없거나 WETH→USDC 티어가 없으면 `null`, 하위 호출·요청 실패는 throw다. 근거: `lib/swap-quote.ts:233`
- 체인 네이티브 USDC는 `{1n, 1n}`이고 요청을 보내지 않는다. `USDC_BY_CHAIN`은 비공개 `PINNED_STABLECOIN_ADDRESSES[chainId].usdc`로 만들어 export한다. 브리지 USDC는 주소가 달라 일반 경로를 탄다. 근거: `config/tokens.ts:26-45`
- `NATIVE_ETH_ADDRESS`는 `getQuoteTokenAddress`와 같은 방식으로 WETH로 바꾸고, 공유 쿼리 키에도 바꾼 소문자 WETH 주소를 쓴다. wrap 페어에서 단가 요청이 하나로 합쳐져 F3·F7 Vitest 판정에 새 요청이 생기지 않는다. 근거: `lib/swap-quote.ts:72-77`, `__tests__/swap/quote-read.test.tsx:527`, `__tests__/swap/native-eth-wrap-quote.test.tsx:328`
- `readTokenUsdPrices`는 1차로 USDC 직접 경로 aggregate3를 보내고, 직접 경로가 없는 토큰만 2차로 "토큰→WETH + WETH→USDC" aggregate3를 보낸다. 둘 다 `allowFailure: true`, `withoutMulticallBatching`, `batchSize: 0`이다. 입력은 중복을 빼고 ETH→WETH로 바꾸며, decimals는 `TOKENS_BY_CHAIN`에서 찾고 목록 밖 주소는 `null`이다. 결과 맵 키는 넘겨받은 소문자 주소다. 근거: `lib/read-swap-quote.ts:57-61`, `lib/token-balances.ts:18,23`, `config/tokens.ts:80`
- 단가 aggregate3는 쌍마다 `quoteExactInputSingle` 4건을 앞에, `slot0` 4건을 뒤에 둔다(`readSwapQuote`와 반대). 테스트 스텁이 첫 하위 호출로 단가와 견적을 구분해, 동결된 F3·F4 테스트의 `matchQuote.input()`·`holdQuote()`·`failQuoteWhen` 판정에 단가 요청이 섞이지 않는다. 근거: `lib/read-swap-quote.ts:58`, `__tests__/support/rpc-balance-stub.ts:379-391,919`
- 단가 읽기는 transport 재시도를 끈 클라이언트 사본(`client.request`에 `retryCount: 0`)을 쓴다. viem http는 429·네트워크 오류를 최대 3회 다시 보내기 때문이다. 동작은 T-1 (6)에서 확인한다. 근거: `node_modules/viem/_esm/utils/buildRequest.js:10,153-175`, `config/wagmi.ts:54-57`
- 단건 훅 `useTokenUsdPrice`는 카드 잔액·견적 훅 패턴을 따른다: 키 상수 `"token-usd-price"`, `retry: false`, `refetchInterval` 60초(export 상수), `refetchIntervalInBackground: false`, `refetchOnWindowFocus: false`와 window `focus` 리스너의 `refetch({ cancelRefetch: false })`, `staleTime` 60초, 클라이언트는 `config.getClient({ chainId })`. 근거: `hooks/use-token-balance.ts:46-73`, `hooks/use-swap-quote-read.ts:58-85`
- 상태는 토큰 없음 → `idle`, data 있음 → `null`이면 `no-price` 아니면 `success`, 오류 → `error`, 그 밖 → `loading` 순으로 정한다. data를 먼저 보므로 갱신 실패 시 이전 값이 남는다. 키에 금액이 없고 `placeholderData`를 쓰지 않는다. 근거: `docs/plans/quote.md:15`, `hooks/use-swap-quote-read.ts:87-88`
- observer마다 주기 타이머·포커스 리스너가 생기므로 새 `providers/swap-usd-price-provider.tsx`가 보내는·받는 토큰 단가를 한 번씩만 읽고 `useSwapUsdPrices()`로 나눠 준다. 두 토큰의 바뀐 키가 같으면(ETH↔WETH) 받는 쪽은 보내는 쪽 상태를 쓴다. `SwapFormProvider` 안쪽에 마운트한다. 근거: `hooks/use-swap-quote-read.ts:37`, `hooks/use-token-balance.ts:132`, `providers/app-providers.tsx:33-39`
- 일괄 훅 `useTokenUsdPrices`는 토큰을 T-1이 정한 묶음 크기 C(export 상수)로 나눠 묶음마다 `["token-usd-price-batch", chainId, …주소]` 쿼리를 `useQueries`로 보낸다. 각 묶음 queryFn은 `readTokenUsdPrices` 결과를 공유 키에 `setQueryData`로 쓴다. 카드에 이미 있는 단가도 묶음에 넣어 다시 조회한다. 모달 행은 같은 options 팩터리의 토큰별 observer(`enabled: false`)로 읽으며, 카드 주기 갱신으로 공유 값이 바뀌면 모달 표시도 바뀐다. 묶음이 실패하면 캐시 값이 없는 그 묶음 토큰만 `error`다. 근거: `hooks/use-token-list-balances.ts:27-45`
- 모달 일괄 조회의 갱신 정책은 목록 잔액 훅과 같다: `staleTime: 0`, `refetchOnMount: "always"`, `retry`·주기·포커스·재연결 끔. `enabled`는 "이번 열기의 잔액 읽기 성공"이며, 이를 위해 `use-token-list-balances.ts`에 읽기 상태를 함께 돌려주는 export를 추가하고 기존 `useTokenListBalances`는 유지한다. 근거: `hooks/use-token-list-balances.ts:36-44`, `components/token-modal.tsx:60`
- 순수 함수(`lib/token-usd-price.ts`)는 `toUsdMicros`(곱한 뒤 버림), `formatUsd`(센트 = micros/10^4 버림, 수동 쉼표), 현물가·곱셈, USDC 고정 단가를 둔다. bigint 문자열 연산만 쓴다. 근거: `lib/token-amount.ts:30`
- 화면은 새 `components/usd-value.tsx`에 USD 행, 인라인 USD(`·` 접두), `usd-skeleton`을 둔다. `token-field`는 3행 `usd-value[data-side]`를 늘 렌더해 행 자리를 유지한다. 받는 쪽은 견적 `success`·`wrap`의 `amountOut`을 쓴다. 근거: `components/token-field.tsx:52-58,99-161`
- `balance-usd`는 1행에서 `data-testid="balance"` span 바깥에 둔다(F2 테스트가 그 span 텍스트를 `—`로 판정). 모달 `token-option-usd`는 행 잔액 옆, 견적 행 USD는 `quote-amount-out`·`quote-amount-out-minimum` 값 칸 안에 덧붙인다. 근거: `components/token-field.tsx:70-83`, `__tests__/swap/balances.test.tsx:613`, `components/token-modal.tsx:126,147-151`, `components/quote-details.tsx:104-127`
- USD 스켈레톤은 `quote-skeleton`을 쓰지 않는다. F3·F4 동결 테스트가 화면 전체의 `quote-skeleton` 수를 단정한다. 근거: `__tests__/swap/quote-refresh.test.tsx:140,255,265,344,511,601`, `__tests__/swap/slippage-quote.test.tsx:167-168,640`
- SSR에서는 TanStack이 queryFn을 실행하지 않고, SSR·첫 클라이언트 렌더는 금액이 비고 견적 `idle`, 지갑 `restoring`이므로 두 `usd-value`가 `empty`이고 `balance-usd`가 없다. 근거: `providers/swap-form-provider.tsx:72-75`, `providers/app-providers.tsx:51`
- RPC 요청 수 산정(DoD-35, WAF 120건/60초/IP). 연결 상태, 두 토큰 선택, 금액 입력, 탭 보임 기준이며 HTTP 1요청 = JSON-RPC 1건이다. 근거: `docs/plans/deploy-readme.md:46`, `hooks/use-token-balance.ts:15`, `hooks/use-swap-quote-read.ts:12`, `hooks/use-token-allowance-read.ts:91`, `lib/token-balances.ts:14-16`
  - 기존 분당: 카드 잔액 2칸 × 4회 = 8, 견적 4회 × 1건 = 4, allowance 주기 0. 합 12건
  - F9 주기 추가: 토큰 2개 × 1회 × 최대 2건 = 4건. 정상 상태 합 16건
  - 포커스 1회: 기존 4건 + F9 최대 4건 = 8건
  - 모달 열기 1회: 목록 잔액 Ethereum 3건(L2 2건) + F9 2 × ⌈Nb/C⌉건
  - 최악(Ethereum 484개 전부 잔액, 모달 1회 + 포커스 1회, C = 11, T-1 확정): 16 + 3 + 2⌈484/11⌉(88) + 8 = 115건 ≤ 120. C ≥ 11이면 한도 안이다
- 기존 동결 골격 영향: DOM 추가와 새 testid는 기존 판정 대상을 바꾸지 않는다. 위험 case는 T-1 (7)에서 목록으로 만들고 T-13에서 고치지 않고 실행해 확인한다. 위험 대상은 `quote-read` EC-6·`native-eth-wrap-quote` DoD-14(바꾼 키 공유로 0건 예상. DoD-14는 모달을 연 뒤 행을 누르기 전 기준 seq를 잡아, 그 사이 목록 잔액 읽기가 끝나면 모달 일괄 단가 요청이 집계에 섞일 수 있는 타이밍 위험), `quote-read` DoD-8 포커스 계기(견적 1 + 단가 1 = 한도 2에 딱 맞음), 모달을 여는 기존 Vitest 27개 파일의 일괄 조회 시간(기본 스텁 잔액이 전 토큰 > 0이라 Ethereum 483토큰, 열기 한 번 인코드·디코드 0.66~0.77초, T-1 (7))이다. F3 E2E `[EC-6]`은 스펙 §4.5에 따라 T-14에서 집계 대상을 견적 요청으로 좁힌다. 근거: `e2e/quote.spec.ts:154-164,318-347`, `__tests__/swap/quote-read.test.tsx:546-575`
- 테스트 지원 확장은 `__tests__/support/rpc-balance-stub.ts`를 T-8 하나가 "추가만"으로 맡는다. 분류 `usd-price`(첫 하위 호출이 QuoterV2인 aggregate3), 쌍이 여럿인 디코더, 응답 규칙, 실패·붙잡기 API, HTTP 429 응답, 매처를 더한다. 기존 `decodeQuoteAggregate3`는 고치지 않는다. 근거: `__tests__/support/rpc-balance-stub.ts:36-38,430-470,1117-1121`, `docs/plans/quote.md` T-6 구현 기록
- E2E·포크 cold 상태에서 첫 견적이 6~7초 걸려 프록시 5초 제한을 넘으므로 단가 경로 풀을 러너가 미리 읽어 예열한다. 근거: `docs/plans/quote.md:39`, `e2e/support/anvil.ts:117,172`, `config/rpc.ts:28`
- mock 경계는 F3·F7 경계(실제 wagmi·Provider·화면, mock 커넥터, 전역 fetch URL 라우팅 스텁, 가짜 타이머·DOM 이벤트, `vi.mock` 금지)를 기준으로 하고, 새 경계(단가 aggregate3 스텁, HTTP 429, visibility 스텁, SSR 렌더)는 테스트 설계 단계에서 사용자가 확정한다

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: 묶음 크기, 포크·메인넷 표본 토큰, 현물가 식, 재시도 동작, 기존 테스트 노출을 저장소 밖에서 실측한다
- 선행: 없음
- 연결 항목: DoD-5, DoD-6, DoD-8, DoD-9, DoD-23, DoD-25, DoD-35, DoD-36, EC-18, EC-19, EC-23
- 수정 대상: 없음. 저장소 밖 `/root/study/.pipeline-scratch/usd-price/t1/`에서 전용 포트 8555 anvil 포크(블록 26250000)와 Base·Arbitrum 읽기 RPC로 확인한다
- 따라야 할 패턴: 저장소 밖에서 확인하고 결과는 구현 기록에 남긴다 — 근거: `docs/plans/quote.md:27-39`, `docs/plans/native-eth.md:27-39`
- 완료 조건: 아래 결과를 기록하고, 스펙과 어긋나면 인터뷰로 되돌린다. (1)에서 C < 11이면 §1 산정을 다시 하고 사용자에게 보고한다 — 검증: 확인 절차
  - (1) 토큰 1개(quote 4 + slot0 4) 단가 aggregate3의 사용 가스를 Ethereum 포크와 Base·Arbitrum 공개 RPC에서 재고, 묶음 후보(10·20·25·40·50 토큰 + WETH 구간 1쌍)별 가스·호출 데이터 바이트·응답 지연과 노드별 `eth_call` 가스 상한(anvil, 세 체인 공개 RPC, 업체 RPC)을 기록한다. 업체 RPC 상한 안(최악 묶음 기준), 본문 1 MB 이하, 지연 5초 미만, WAF 산정 120건 이하를 만족하는 C를 정한다(기준 변경 사용자 결정 2026-11-22: 공개 RPC 50M의 2배 여유는 토큰 1개 묶음도 넘는 경우가 있어 지킬 수 없다)
  - (2) Ethereum 포크 블록 기준 USDC 직접 경로 후보 티어가 있는 WETH 외 ERC-20 하나(DoD-5 표본)를 고른다. USDC 네 티어 후보가 없고 WETH 티어는 있는 토큰을 WETH 대비 token0·token1 순서별로 고르고, Base·Arbitrum 메인넷에서도 같은 조건의 후보를 하나씩 찾는다
  - (3) USDC·WETH 둘 다 후보 티어가 없는 Ethereum 토큰과, 토큰→WETH는 있고 WETH→USDC가 없는 경우가 실제로 생기는지 확인한다
  - (4) slot0 유리수와 `quote(10^dec)/10^dec`를 두 순서 표본과 WETH 경유 곱에서 비교한다
  - (5) 세 체인 네이티브 USDC decimals가 6인지 확인한다
  - (6) viem 2.57.x http transport가 HTTP 429·네트워크 오류를 다시 시도하는지, 호출별 `retryCount: 0`으로 요청이 1건이 되는지 로컬 HTTP 서버로 센다
  - (7) `matchQuote.input()`·`notBalance`·`holdQuote`·`failQuoteWhen`·`quote-skeleton` 전역 수·E2E QuoterV2 집계를 쓰는 기존 case 목록, 스텁 없는 `__tests__/wallet/*`의 fetch 실패 형태, 모달을 여는 기존 테스트의 일괄 대상 토큰 수와 시간 비용을 정적으로 확인한다
  - (8) mock 계정의 포크 블록 토큰 목록 잔액을 확인한다
  - (9) cold 포크 단가 읽기 지연(ETH, (2) 토큰 2차 포함)을 프록시 5초와 비교한다
  - (10) TanStack Query 5.106의 observer별 주기 타이머, staleTime 안 키 변경 시 fetch 없음, `enabled` 전환 시 fetch, `setQueryData` 전파, signal 취소 동작을 `node_modules`에서 확인한다
- 실행 명령: `anvil --fork-url $ETH_MAINNET_RPC_URL --fork-block-number 26250000 --port 8555`, `cast call`, `cast estimate`, `cast rpc`, 저장소 밖 `bun` 스크립트
- 수정 금지: 저장소 파일
- 구현 기록: general-purpose(조사 전용 에이전트 없음, F6·F7 선례), 저장소 수정 없음, anvil 1.8.1 8555·8556(종료 확인), viem 2.57.16·wagmi 3.7.11·query-core 5.106.1. 2026-11-22. 산출물 `/root/study/.pipeline-scratch/usd-price/t1/`. 보고 NEEDS-DECISION → 사용자 결정으로 해소. (1) eth_call 상한: anvil 60M, Ethereum 업체 550M·공개 50M, Base 업체 550M·공개 600M, Arbitrum 업체 1.1B·공개 50M. 토큰 1개 묶음 가스 ETH: Ethereum 497,840·Base 447,758·Arbitrum 2,803,861, 묶음 가스는 토큰별 합. 유동성 없는 티어 견적이 tick을 끝까지 훑어 토큰 1개도 최대 32.7M(Eth)/54.0M(Base)/41.9M(Arb, 2차) → 50M의 2배 여유는 C=1로도 불가. 본문 토큰당 약 4.36 KB, 지연 웜 ≤2.3초. C=11 최악 묶음 Ethereum 287M/357M, Base 318M/328M, Arbitrum 290M/324M(업체 상한 안). C=25는 Ethereum 2차·Base에서 업체 상한 초과. 사용자 결정(2026-11-22): **C = 11**, 기준은 업체 RPC 상한, 공개 RPC 실패는 EC-20(스펙 EC-19 문구 보완). RPC 최악 115건. (2) 표본: DoD-5 ETH·DAI `0x6B17…1d0F`(직접 100, token0), DoD-6 API3 `0x0b38210ea11411557c13457D4dA7dC6ea731B88a`(WETH 3000, token0)·KNC `0xdd974D5C2e2928deA5F71b9825b8b646686BD200`(WETH 3000, token1), EC-18 SOLV `0x169E36F327cAA83d004f5c2668AC25A1424C940d`(8개 getPool 모두 0), DoD-8 Base GHST `0xcD2F22236DD9Dfe2356D7C543161D4d260FD9BcB`(대안 MOCA), DoD-9 Arbitrum cbETH `0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f`(대안 BLUR). WBTC·mETH는 cold anvil 120초 초과로 제외. (3) 두 경로 모두 없는 목록 토큰 68개 존재. 토큰→WETH 있고 WETH→USDC 없는 경우는 세 체인 모두 없음(EC-26은 스텁만). (4) 현물가 식 두 순서 일치, 현물가 > 견적, 차이 = 수수료 + 가격 영향(ETH 2.14bps, KNC 478bps, Arbitrum cbETH 선택 티어 견적은 현물가의 10%). (5) USDC decimals 세 체인 6. (6) viem 기본 4건(1+재시도 3, 429·500·JSON-RPC 429·연결 끊김), 호출별 `retryCount: 0` 사본이면 1건. 요청 실패 시 aggregate3 `ContractFunctionExecutionError`. (7) `notBalance` 3 case 위험(§1), 분류는 첫 하위 호출로만 구분 가능, E2E QuoterV2 집계는 `e2e/quote.spec.ts:346` 하나, jsdom 무스텁 fetch는 `TypeError: Failed to parse URL`. (8) mock 계정 ERC-20 잔액 전부 0, ETH 10000 → DoD-25 표본은 ETH 행. (9) cold 포크 ETH 7.1초·DAI 6.7초(> 5초, 예열 필요), API3·KNC 2차 웜 ~2초. (10) TanStack: 같은 키 observer 둘이어도 주기 fetch 1회, 백그라운드 정지, staleTime 안 키 변경 무fetch, `setQueryData`는 `enabled: false` observer에 전파, signal 사용 queryFn은 마지막 observer 이탈 시 abort, 서버에서 주기 타이머 없음

### T-2 — config와 lib 순수 함수

- 사이드: 프론트
- 상태: 완료
- 목적: `USDC_BY_CHAIN`, 스펙 §4.1 타입, 환산·표기 함수, 현물가·곱셈 순수 함수를 만든다
- 선행: 없음
- 연결 항목: DoD-1, DoD-2, DoD-10, DoD-11, DoD-12, DoD-13, DoD-14, DoD-15, DoD-33, EC-16, EC-25
- 수정 대상: `config/tokens.ts` — `USDC_BY_CHAIN` export 추가(기존 export 불변). `lib/token-usd-price.ts` — 신규, 타입·`toUsdMicros`·`formatUsd`·slot0 현물가(두 순서)·유리수 곱셈·USDC 고정 단가, 티어별 견적 결과와 `slot0` 결과를 받아 `selectFeeTier`로 고른 티어의 단가 또는 `null`을 내는 결합 순수 함수(직접 경로와 WETH 경유 두 구간)
- 따라야 할 패턴: React·wagmi를 import하지 않는 `lib/` 순수 함수, 로캘 API 없는 bigint 표시, kebab-case와 named export — 근거: `lib/token-amount.ts:30`, `lib/swap-quote.ts:278-302`, `CLAUDE.md`
- 완료 조건: 연결 항목 판정에 필요한 함수가 있다. `Intl`·`toLocaleString`·`Number` 변환을 쓰지 않는다. 기존 config export가 바뀌지 않는다 — 검증: T-7
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/config __tests__/lib`
- 수정 금지: `lib/swap-quote.ts`, `lib/read-swap-quote.ts`, `config/contracts.ts`, `config/uniswap-v3.ts`, `hooks/`, `providers/`, `components/`
- 구현 기록: seongho:frontend-dev, 작성 영역 `config/tokens.ts`(`USDC_BY_CHAIN` 추가)·`lib/token-usd-price.ts`(신규). 수정 0/3. 새 export: `UsdPrice`, `TokenUsdPriceState`, `toUsdMicros`, `formatUsd`(음수 RangeError), `USDC_USD_PRICE`, `isChainUsdc`, `spotPriceFromSqrtPriceX96`(sqrtP ≤ 0 RangeError), `multiplyPrices`(약분 없음, 비교는 교차곱), `selectPairSpotPrice`(고른 티어 slot0 revert면 throw), `selectWethRoutedPrice`, `selectTokenUsdPrice`. 입력은 ETH→WETH 치환 주소. 오케스트레이터 확인: 수정 범위 일치, typecheck·lint 통과, `test __tests__/config __tests__/lib` 12 파일 통과·1 skip, 71 통과·11 todo, 새 파일 `Intl`·`toLocaleString`·`Number(` 0건

### T-3 — 단가 조회 함수

- 사이드: 프론트
- 상태: 완료
- 목적: 1차 USDC 직접, 2차 WETH 경유 aggregate3로 단가 맵을 돌려주는 `readTokenUsdPrices`를 만든다
- 선행: T-1, T-2
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-6, DoD-7, DoD-31, EC-10, EC-14, EC-15, EC-16, EC-17, EC-19, EC-23, EC-26, EC-27
- 수정 대상: `lib/read-token-usd-price.ts` — 신규. `readTokenUsdPrices`, 묶음 크기 상수(T-1 C), 재시도를 끈 클라이언트 사본, 쌍마다 quote 앞·slot0 뒤 순서, ETH→WETH 치환과 중복 제거, decimals 조회
- 따라야 할 패턴: batch를 끈 사본으로 `multicall` 1회, 하위 호출 실패는 그 티어의 revert, 요청 실패와 고른 티어 slot0 실패는 throw — 근거: `lib/read-swap-quote.ts:25-92`, `lib/token-balances.ts:23`
- 완료 조건: 연결 항목 충족. USDC만 넘기면 요청 0건, 직접 경로만 있으면 1건, 경유 토큰이 있으면 2건이다. 첫 하위 호출이 QuoterV2 호출이다. 프록시 transport 외 HTTP가 없다. `lib/read-swap-quote.ts`와 `lib/swap-quote.ts`는 바꾸지 않는다 — 검증: T-8, T-12
- 실행 명령: `bun run typecheck`, `bun run lint`
- 수정 금지: `lib/read-swap-quote.ts`, `lib/swap-quote.ts`, `lib/token-balances.ts`, `config/wagmi.ts`, `config/rpc.ts`, `lib/rpc-proxy.ts`, T-2 파일
- 구현 기록: seongho:frontend-dev(T-2 작성 에이전트 이어서), 작성 영역 `lib/read-token-usd-price.ts`(신규). 수정 0/3. export: `TOKEN_USD_PRICE_BATCH_SIZE = 11`, `ReadTokenUsdPricesInput`, `readTokenUsdPrices`. 1차·2차 묶음은 대상 토큰 ≤ 11((WETH, USDC) 쌍 제외)로 나눠 `Promise.all`, 한 묶음 실패면 호출 전체 throw(EC-20은 T-4 훅이 묶음마다 따로 호출해 맞춘다). 쌍마다 quote 4 → slot0 4 순서. `withoutRetry` 사본(`retryCount: 0`, multicall batch 끔) — readContract·call 확장 클라이언트에서는 무시되므로 wagmi `config.getClient()` 클라이언트를 써야 한다. WETH 자체 직접 경로 없음이면 null. 임시 확인 테스트 6 case는 실행 뒤 삭제. 오케스트레이터 확인: 수정 범위 일치, typecheck·lint 통과

### T-4 — 훅과 provider

- 사이드: 프론트
- 상태: 완료
- 목적: 단건·일괄 훅, 칸 단가 provider, 목록 잔액 읽기 상태 export를 만든다
- 선행: T-3
- 연결 항목: DoD-4, DoD-16, DoD-17, DoD-18, DoD-20, DoD-26, DoD-27, DoD-28, DoD-29, DoD-30, DoD-31, DoD-32, EC-9, EC-10, EC-11, EC-12, EC-13, EC-19, EC-20, EC-21, EC-22, EC-24
- 수정 대상: `hooks/use-token-usd-price.ts` — 신규. 키·주기 상수, options 팩터리, `useTokenUsdPrice`, `useTokenUsdPrices`, focus 리스너. `providers/swap-usd-price-provider.tsx` — 신규, `SwapUsdPriceProvider`, `useSwapUsdPrices()`. `providers/app-providers.tsx` — `SwapFormProvider` 안쪽에 마운트. `hooks/use-token-list-balances.ts` — 읽기 상태를 함께 돌려주는 export 추가(기존 export 동작 불변)
- 따라야 할 패턴: Provider와 사용 훅을 한 파일에 둠, 시간 값은 export 상수, 키에 bigint 없음, 선택 체인 `chainId` 명시 — 근거: `providers/swap-quote-provider.tsx:38,113`, `hooks/use-token-balance.ts:46-73`, `hooks/use-token-list-balances.ts:27-45`
- 완료 조건: 연결 항목 충족. 같은 바꾼 키의 칸 단가 observer가 하나뿐이다. 모달 일괄은 이번 열기의 잔액 성공 뒤에만 켜지고 카드에 있는 단가도 다시 조회한다. SSR에서 queryFn이 실행되지 않는다. F2 목록 잔액·카드 잔액·견적 동작이 바뀌지 않는다 — 검증: T-8, T-9, T-10, T-11, T-13
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap`
- 수정 금지: `hooks/use-token-balance.ts`, `hooks/use-swap-quote-read.ts`, `providers/swap-form-provider.tsx`, `providers/swap-quote-provider.tsx`, `components/`, T-2·T-3 파일
- 구현 기록: seongho:frontend-dev(T-2·T-3 작성 에이전트 이어서), 작성 영역 `hooks/use-token-usd-price.ts`(신규)·`providers/swap-usd-price-provider.tsx`(신규)·`providers/app-providers.tsx`(SwapFormProvider 안쪽, SwapQuoteProvider 바깥 마운트)·`hooks/use-token-list-balances.ts`(`useTokenListBalancesRead` 추가, 기존 훅은 그 `.balances`). 수정 0/3. export: `TOKEN_USD_PRICE_REFETCH_INTERVAL_MS`·`TOKEN_USD_PRICE_STALE_TIME_MS`(60초), 키 상수 2개, `getTokenUsdPriceAddress`, `getTokenUsdPriceQueryKey`, `tokenUsdPriceQueryOptions`, `useTokenUsdPrice`, `useTokenUsdPrices`, `SwapUsdPriceProvider`·`useSwapUsdPrices()`(`{ in, out }`), `useTokenListBalancesRead(open)` → `{ balances, readSucceeded }`. 구현 판단(스펙에 없던 처리, 7단계 대조 대상): 모달 일괄 꺼짐·캐시 없음 행은 `idle`, USDC는 쿼리 없이 $1(일괄 묶음에서 제외), 선택 체인 밖 토큰은 `idle`. 보고 NEEDS-DECISION: F3 `quote-read` `[DoD-1][DoD-4][DoD-16][DoD-37]`이 전체 fetch 기록의 QuoterV2 selector를 선택 체인 경로로만 단정 → 기본 ETH 단가가 체인 전환 전 `/api/rpc/1`로 나가 실패. 사용자 결정(2026-11-22): 스펙 DoD-36·§4.5에 회귀 갱신 예외 추가, T-14에서 집계를 견적 요청으로 좁힘. `bun run test __tests__/swap` 3 실패(위 1건 + `quote-refresh` DoD-29 포커스 4≠3, `slippage-quote` DoD-17 1≠0 — 스텁이 단가 aggregate3를 견적으로 분류, T-8 확장 뒤 T-13에서 재확인). 오케스트레이터 확인: typecheck·lint 통과, 충돌 case 코드(`quote-read.test.tsx:326-332`) 대조로 원인 확인

### T-5 — 화면

- 사이드: 프론트
- 상태: 완료
- 목적: USD 행, 카드 잔액 USD, 모달 행 USD, 견적 행 USD와 `usd-skeleton`·`—`를 표시한다
- 선행: T-4
- 연결 항목: DoD-16, DoD-17, DoD-18, DoD-19, DoD-20, DoD-21, DoD-22, EC-1, EC-2, EC-3, EC-4, EC-5, EC-6, EC-7, EC-8, EC-24
- 수정 대상: `components/usd-value.tsx` — 신규, USD 행(`usd-value`), 인라인 USD, `usd-skeleton`. `components/token-field.tsx` — 3행과 `balance-usd`. `components/quote-details.tsx` — 두 행의 USD. `components/token-modal.tsx` — `token-option-usd`와 일괄 훅 연결
- 따라야 할 패턴: 스켈레톤(`bg-raised`, `aria-hidden`, 동작 줄이기 정지), `text-muted-foreground font-mono tabular-nums`, 행 컴포넌트 — 근거: `components/quote-details.tsx:28-61`, `docs/design/README.md:38-41`
- 완료 조건: 연결 항목 충족. 스펙 §4.4 식별자·속성 값이 일치하고 `data-usd-micros`는 `success`에서만 있다. `quote-skeleton`을 USD 자리에 쓰지 않는다. `balance-usd`는 `balance` span 밖에 있다. 기존 testid·data 속성이 바뀌지 않는다. 프로덕션 빌드가 통과한다 — 검증: T-9, T-11, T-15, `bun run build`
- 실행 명령: `bun run build`, `bun run lint`, `bun run typecheck`
- 수정 금지: `lib/`, `config/`, `hooks/`, `providers/`, `components/swap-card.tsx`, `components/primary-button.tsx`, `app/globals.css`
- 구현 기록: seongho:frontend-dev(T-2~T-4 작성 에이전트 이어서), 작성 영역 `components/usd-value.tsx`(신규: `UsdValue`·`InlineUsd`·`usd-skeleton`)·`components/token-field.tsx`(3행 `usd-value` 늘 렌더, `balance-usd`는 `balance` span 밖)·`components/quote-details.tsx`(두 행 dd 안 ` · $…`)·`components/token-modal.tsx`(`useTokenListBalancesRead`, 대상은 `TOKENS_BY_CHAIN` 순서의 잔액 > 0 전체, `token-option-usd`). 수정 0/3. 구현 판단(7단계 대조 대상): `—`는 `role="img"`·`aria-label="USD 가격 없음"`, 모달 행 USD는 잔액 뒤 같은 줄 ` · $…`, 인라인 첫 조회 중에는 testid 요소 없이 ` · [usd-skeleton]`. 오케스트레이터 확인: 수정 범위 일치(lib·config·hooks·providers 무변경), lint·typecheck·`bun run build` 통과, `quote-skeleton` 미사용(주석 1건). `bun run test __tests__/swap` 실패는 T-4와 같은 3건(T-8·T-14 대상)

### T-6 — 문서

- 사이드: 문서
- 상태: 완료
- 목적: README 알려진 한계와 디자인 문서의 제거 항목에서 달러 환산을 뺀다
- 선행: 없음
- 연결 항목: DoD-37, DoD-38
- 수정 대상: `README.md` — 59행 한 줄 삭제. `docs/design/README.md` — 36행 제거 항목 문장에서 "달러 환산"만 뺀다
- 따라야 할 패턴: 기존 목록·문장 형식 유지 — 근거: `README.md:52-61`, `docs/design/README.md:36`
- 완료 조건: 연결 항목 충족. 나머지 문장은 바뀌지 않는다 — 검증: `bun run format:check`, 코드 대조
- 실행 명령: `bun run format:check`
- 수정 금지: `docs/specs/*`, 그 밖의 README·디자인 문서 문장
- 구현 기록: general-purpose(문서 전용 에이전트 없음), 작성 영역 `README.md`·`docs/design/README.md`. 수정 0/3. README 알려진 한계 59행 삭제, 디자인 문서 36행에서 "달러 환산·"만 삭제. 오케스트레이터 확인: diff 2파일(+1 −2), `bun run format:check` 통과

### T-7 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 현물가·경유 곱·티어 선택 결합과 환산·표기 순수 함수를 검증한다
- 선행: T-2
- 연결 항목: DoD-1, DoD-2, DoD-10, DoD-11, DoD-12, DoD-13, DoD-14, EC-16, EC-25
- 수정 대상: `__tests__/lib/token-usd-price.test.ts` — 신규
- 따라야 할 패턴: 순수 함수 단위 테스트, 기대값은 리터럴이나 테스트 쪽 계산 — 근거: `__tests__/lib/swap-quote.test.ts`, `__tests__/lib/token-amount.test.ts`
- 완료 조건: 연결 항목 판정. 현물가는 token0·token1 두 순서다. 경계는 `<$0.01`·`$0.01`, 버림, 큰 값 무축약, uint256 상한 근처다. DoD-15는 코드 대조(T-17)로만 판정한다(사용자 확정 2026-11-22) — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib/token-usd-price.test.ts`
- 수정 금지: 제품 코드, 기존 테스트, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/lib/token-usd-price.test.ts`(11 case). 수정 0/3. 본문 판단: 현물가 두 순서는 수치·문자열 대소가 같은/반대인 주소 4개 × sqrtP 2개, 티어 결합은 기존 selectFeeTier 표본 5종 × 방향 2, 경유는 순서 2×2와 16개 티어 조합 중 기대 조합만 일치, EC-25 기대값은 임의 정밀도로 따로 계산한 리터럴, 값 비교는 교차곱. 오케스트레이터 확인: 골자 동결 유지(`6a5e6db5a40c5bc1`), `bun run test __tests__/lib/token-usd-price.test.ts` 11/11 통과
- 테스트 파일·runner: `__tests__/lib/token-usd-price.test.ts`, Vitest
- mock 허용 경계: 없음(순수 함수) (사용자 확정 2026-11-22)
- 데이터 격리: 정적 데이터만 사용

### T-8 — 통합 테스트: 단가 조회·경로와 테스트 지원 확장

- 사이드: 테스트
- 상태: 완료
- 목적: 스텁에 단가 분류를 더하고, 직접·경유·USDC·ETH·목록 밖·실패 경로의 단가 결과와 요청을 검증한다
- 선행: T-4
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-36, EC-14, EC-15, EC-16, EC-17, EC-26, EC-27
- 수정 대상: `__tests__/support/rpc-balance-stub.ts` — 추가만. 분류 `usd-price`, 쌍이 여럿인 디코더, 단가 응답 규칙과 기본 성공 규칙, `failUsdPriceWhen`·`holdUsdPrice`, HTTP 429 응답, 매처, scope 분리. 기존 분류·export·규칙 불변. `__tests__/swap/usd-price-read.test.tsx` — 신규
- 따라야 할 패턴: F3 T-6 스텁 확장 방식, 테스트 쪽 CREATE2 풀 주소, JSON-RPC 항목 단위 집계 — 근거: `__tests__/support/rpc-balance-stub.ts:228-240,379-470,1112-1125`, `docs/plans/quote.md` T-6
- 완료 조건: 연결 항목 판정. 분류 양성 대조(단가 요청은 `usd-price`, 같은 시점 견적은 `quote`)가 있다. EC-16·EC-26은 훅 상태와 함께 `readTokenUsdPrices` 맵 값 `null`을 본다. DoD-3은 USDC 단가 요청 0건, DoD-4는 세 체인이다. 주소 기대값은 제품 config를 쓰지 않는다. 기존 `bun run test` 결과가 스텁 변경 전과 같다(T-13에서 재확인) — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/usd-price-read.test.tsx`, `bun run test`
- 수정 금지: 제품 코드, 기존 테스트 파일, `__tests__/support/rpc-fetch-stub.ts`의 기존 동작, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/usd-price-read.test.tsx`(12 case)·`__tests__/support/rpc-balance-stub.ts`(추가 442줄, union·3항식 확장 4줄). 수정 1/3: 오케스트레이터 실행에서 DoD-2가 표본 충돌(두 구간이 같은 sqrtP 배수 {2,3,5,7}이라 KNC 방향에서 3000×10000 = 10000×3000)로 실패 → 토큰→WETH 풀 배수를 {11,13,17,19}로 바꾼 본문 수정(판정 불변). 스텁 추가 API: 분류 `usd-price`(첫 하위 호출이 QuoterV2인 aggregate3, 견적 판정보다 먼저), `setUsdPriceRule`·`usdPriceRule`·`defaultUsdPriceRule`, `failUsdPriceWhen`(-32000), `respondUsdPriceHttp429When`, `holdUsdPrice`, `request.usdPrice.pairs`, `matchUsdPrice.any·stage·target·pair`, `usdPriceStage`·`usdPriceTargets`, `usdPriceRuleWith`, `stubRevertQuote`, `stubExhaustedSqrtPriceX96After`, 기대값 `stubSpotPrice`·`stubMultiplyPrices`·`stubPricesEqual`·`stubUsdMicros`·`stubSelectFeeTier`·`stubPairPrice`·`expectedStubUsdPrice`, 리터럴 `STUB_USDC_BY_CHAIN`·`STUB_WETH_BY_CHAIN`·`STUB_ETH_ADDRESS`. 단가 요청에는 기존 견적 규칙·hold·fail이 적용되지 않는다. 오케스트레이터 확인: 골자 동결 유지, `bun run test __tests__/swap/usd-price-read.test.tsx` 2회 12/12 통과. `bun run test` 전체는 이 파일 외 실패 2건(F3 `quote-read` 집계, F4 `slippage-quote` 최소 수령량 행 비교 — 사용자 결정으로 T-14 회귀 갱신), `quote-refresh` DoD-29는 분류 추가로 통과
- 테스트 파일·runner: `__tests__/swap/usd-price-read.test.tsx`, Vitest jsdom
- mock 허용 경계: F3 통합 경계(실제 wagmi·Provider·화면, mock 커넥터, 전역 fetch URL 라우팅 스텁, `vi.mock` 금지)에 단가 aggregate3 스텁 분류·응답과 HTTP 429 응답을 더한 것 (사용자 확정 2026-11-22). 실제 풀 가격과 실제 RPC 오류 형태는 증명하지 못한다
- 데이터 격리: 테스트마다 config·스텁·QueryClient 새로 생성, `clearCookies`

### T-9 — 통합 테스트: 화면 표시와 SSR

- 사이드: 테스트
- 상태: 완료
- 목적: USD 행·카드 잔액·견적 행의 상태별 표시와 SSR 일치를 검증한다
- 선행: T-5, T-8
- 연결 항목: DoD-16, DoD-17, DoD-18, DoD-19, DoD-21, DoD-22, EC-1, EC-2, EC-3, EC-4, EC-5, EC-6, EC-7, EC-8, EC-24
- 수정 대상: `__tests__/swap/usd-price-display.test.tsx` — 신규
- 따라야 할 패턴: 앱 전체 렌더 하네스, testid·data 속성 판정, 기대 micros는 테스트 쪽 계산 — 근거: `__tests__/support/wagmi-harness.tsx:81`, `__tests__/swap/quote-display.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-18은 `wrap` 두 방향이다. DoD-22는 `useAmountOutMinimum()` 값으로 판정한다. EC-4·5의 접근성 이름은 role 조회로 판정한다. EC-24는 SSR 렌더 중 요청 0건과 상태 일치다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/usd-price-display.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/usd-price-display.test.tsx`(13 case). 수정 1/3: 오케스트레이터 실행에서 DoD-16의 버림 전제(나머지 ≠ 0)가 ETH 표본에서 깨짐(기본 slot0 배수로 단가가 1/9, 금액 1234567890123456789가 9의 배수) → 본문에 분수 단가 규칙(`defaultSlot0SqrtPriceX96(fee) + 12345n`) 추가(판정 불변). 본문 판단: `renderAppHook` + probe, EC-1·EC-3은 단가 상태마다 렌더 1회에 금액·견적 상태 반복, EC-24는 `renderToString` → container에 붙인 뒤 RTL hydrate, `Profiler` 첫 커밋에서 상태 비교. support 무변경. 오케스트레이터 확인: 골자 동결 유지, `bun run test __tests__/swap/usd-price-display.test.tsx` 2회 13/13 통과
- 테스트 파일·runner: `__tests__/swap/usd-price-display.test.tsx`, Vitest jsdom
- mock 허용 경계: T-8 경계에 EC-24 한정 서버 렌더(`react-dom/server`)를 더한 것 (사용자 확정 2026-11-22). 실제 Next SSR·하이드레이션 경로는 증명하지 못한다
- 데이터 격리: T-8과 같음

### T-10 — 통합 테스트: 갱신·캐시·실패

- 사이드: 테스트
- 상태: 완료
- 목적: 60초 주기, 포커스, 숨김 탭, 카드·견적 행 캐시 공유, 실패 유지·무재시도, 체인·토큰·금액 변화를 검증한다
- 선행: T-5, T-8
- 연결 항목: DoD-26, DoD-27, DoD-28, DoD-29, EC-9, EC-10, EC-11, EC-12, EC-13, EC-23
- 수정 대상: `__tests__/swap/usd-price-refresh.test.tsx` — 신규
- 따라야 할 패턴: setInterval 계열만 가짜로 두는 주기 판정, visibility 스텁, 붙잡기·실패 규칙 — 근거: `__tests__/swap/quote-refresh.test.tsx`, `docs/plans/quote.md` 테스트 설계 증거
- 완료 조건: 연결 항목 판정. EC-23은 HTTP 429로 요청 1건, 다음 주기 전까지 재요청이 없음을 판정한다. EC-13은 금액 변경 전후 단가 요청 0건이다. DoD-29는 카드↔견적 행 방향을 여기서, 모달→카드 방향을 T-11에서 판정한다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/usd-price-refresh.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/usd-price-refresh.test.tsx`(11 case). 수정 0/3. 본문 판단: 토큰 구분용 테스트 쪽 단가 규칙 `priceRule(version)`, 재시도 관찰 구간 실제 2초, 모달 일괄 배제를 위해 목록 읽기 중 잔액 0 → 카드 규칙 복원(시점 분리, support 무변경), DoD-28 `vi.spyOn` visibility, EC-13은 금액 변경 직전 setTimeout까지 가짜, EC-11·12는 Profiler 커밋 기록으로 이전 단가 값 부재 확인. 오케스트레이터 확인: 골자 동결 유지, `bun run test __tests__/swap/usd-price-refresh.test.tsx` 11/11 통과
- 테스트 파일·runner: `__tests__/swap/usd-price-refresh.test.tsx`, Vitest jsdom
- mock 허용 경계: T-8 경계에 가짜 타이머, `document.visibilityState`·`visibilitychange` 스텁, HTTP 429 응답을 더한 것 (사용자 확정 2026-11-22). 실제 브라우저의 탭 숨김·타이머 스로틀링은 증명하지 못한다
- 데이터 격리: T-8과 같음, 가짜 타이머는 테스트마다 원복

### T-11 — 통합 테스트: 모달 일괄 조회

- 사이드: 테스트
- 상태: 완료
- 목적: 모달 단가의 대상 선정, 2단계 조회, 묶음 나누기, 묶음 실패, 열린 동안·다시 열기, 모달→카드 캐시 재사용을 검증한다
- 선행: T-5, T-8
- 연결 항목: DoD-20, DoD-29, DoD-30, DoD-31, DoD-32, EC-7, EC-8, EC-19, EC-20, EC-21, EC-22
- 수정 대상: `__tests__/swap/usd-price-modal.test.tsx` — 신규
- 따라야 할 패턴: 모달 열기·목록 잔액 붙잡기·요청 디코드 — 근거: `__tests__/swap/balances.test.tsx:91`, `__tests__/swap/token-select.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-29는 카드에 이미 있는 단가도 일괄 요청에 포함되고, 모달 결과를 카드가 추가 요청 없이 쓰는 방향을 본다. DoD-30은 잔액 0·미반환 토큰이 요청에 없음을 디코드로 확인한다. DoD-31은 1차·2차 요청의 쌍 구성이다. DoD-32는 열린 동안 일괄 요청 0건(카드 주기 갱신 요청은 판정 밖)이다. EC-19는 제품 export 상수 C를 읽어 1차·2차 요청마다 대상 토큰 수 ≤ C를 판정하고((WETH, USDC) 구간 쌍은 세지 않는다), 가스 상한 적합성은 T-1 (1) 실측 기록으로 갈음한다(사용자 확정 2026-11-22). EC-20은 한 묶음 실패 시 다른 묶음 행 표시다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/usd-price-modal.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/usd-price-modal.test.tsx`(12 case). 수정 0/3. 본문 판단: 모달 일괄 요청 = `usdPriceTargets`에 카드 토큰 밖 토큰이 있는 단가 요청(`match.since`), EC-19·EC-20 표본은 붙잡은 목록 읽기 동안 화면 행에서 고름(2C+1 ≤ 행 수 전제 확인), C(`TOKEN_USD_PRICE_BATCH_SIZE`)는 표본 크기·판정 상한에만 사용, 재시도 관찰 2초. 오케스트레이터 확인: 골자 동결 유지, `bun run test __tests__/swap/usd-price-modal.test.tsx` 12/12 통과(31.7초)
- 테스트 파일·runner: `__tests__/swap/usd-price-modal.test.tsx`, Vitest jsdom
- mock 허용 경계: T-8 경계와 가짜 타이머 (사용자 확정 2026-11-22). 실제 eth_call 가스 상한은 증명하지 못한다(T-1 실측에 의존)
- 데이터 격리: T-8과 같음

### T-12 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: Ethereum 포크에서 프록시를 거친 `readTokenUsdPrices` 결과가 직접 읽기 계산과 같은지 검증한다
- 선행: T-1, T-3
- 연결 항목: DoD-5, DoD-6, EC-18
- 수정 대상: `__tests__/fork/usd-price.fork.test.ts` — 신규
- 따라야 할 패턴: `fetchFn`을 프록시 핸들러에 연결, `vi.stubEnv`, 판정과 분리한 anvil 직접 읽기, 예열 hook — 근거: `__tests__/fork/swap-quote.fork.test.ts:1-80`
- 완료 조건: 연결 항목 판정. 기대값은 anvil에서 티어별 QuoterV2를 직접 호출해 테스트 쪽 규칙으로 고른 티어의 `slot0`로 계산한다. 주소·ABI는 리터럴이다. 표본은 ETH, USDC 직접 경로 토큰, T-1 (2)·(3) 토큰이다. 기존 포크 테스트가 통과한다 — 검증: 테스트
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드, 기존 `__tests__/fork/*`, `vitest.fork.config.mts`, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/fork/usd-price.fork.test.ts`(3 case). 수정 0/3. 본문 판단: 프록시 핸들러에 `fetchFn` 연결(`retryCount: 0`), 기대값은 anvil 고정 블록 티어별 QuoterV2 직접 호출 + 테스트 쪽 티어 규칙 + `getPool`·`slot0` 직접 읽기, 교차곱 비교, describe별 `beforeAll` 예열(120초). 표본 T-1: ETH·DAI, API3(token0)·KNC(token1), SOLV. EC-18은 기록된 aggregate3를 디코드해 (SOLV, USDC)·(SOLV, WETH) 요청 발생 확인. 제품 config는 입력 `NATIVE_ETH_ADDRESS`와 EC-18 목록 소속 전제(`TOKENS_BY_CHAIN[1]`)에만 사용. 오케스트레이터 확인: 골자 동결 유지, `bun run test:fork` 6 파일 21/21 통과(기존 18 + 신규 3)
- 테스트 파일·runner: `__tests__/fork/usd-price.fork.test.ts`, Vitest(`vitest.fork.config.mts`, anvil 8547)
- mock 허용 경계: 없음(실제 anvil Ethereum 포크, `vi.stubEnv`, 판정과 분리한 anvil 직접 읽기) (사용자 확정 2026-11-22). Base·Arbitrum은 증명하지 못한다
- 데이터 격리: 읽기 전용, 전용 포트 8547, 파일 순차 실행

### T-13 — 기존 테스트 회귀 확인

- 사이드: 테스트
- 상태: 완료
- 목적: 단가 요청과 DOM 추가 뒤 F1~F7 테스트가 수정 없이 통과하는지 확인하고 실패를 기록한다
- 선행: T-5, T-8
- 연결 항목: DoD-36
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 이전 기능 동결 확인 명령, 명령 순차 실행 — 근거: `docs/plans/native-eth.md` T-17
- 완료 조건: `bun run test` 3회와 `bun run test:fork`가 기존 case 전부 통과한다. `bun run test:e2e`는 F3 `[EC-6]` 하나만 실패하거나 통과하고 그 밖은 통과한다. §1 위험 case의 결과와 소요 시간 변화를 기록한다. F1~F7 digest가 유지된다. 그 밖의 실패는 고치지 않고 결정으로 되돌린다 — 검증: 명령 실행 확인
- 실행 명령: `bun run test`, `bun run test:fork`, `bun run test:e2e`
- 수정 금지: 저장소 파일
- 구현 기록: 오케스트레이터 직접 실행(수정 없음, 2026-11-22). `bun run test` 3회 모두 50 파일 중 48 통과, 383 case 중 381 통과, 실패 2건 동일: F3 `quote-read` `[DoD-1][DoD-4][DoD-16][DoD-37]`(전체 fetch 기록 집계), F4 `slippage-quote` `[DoD-17][DoD-18][DoD-19][DoD-22][DoD-24]`(최소 수령량 행 값 조각 비교) — 둘 다 사용자 결정으로 T-14 회귀 갱신. `quote-refresh` DoD-29·`quote-read` EC-6·DoD-8·`native-eth-wrap-quote` DoD-14는 통과(T-1 위험 미발현). `bun run test:fork` 6 파일 21/21(T-12 때). `bun run test:e2e` 32 통과·1 실패·2 skip(F9 E2E 골격 `test.fixme`): 실패는 F3 `[EC-6]`(프록시 QuoterV2 호출 수, 예상대로 T-14). 로그에 chain 1 프록시 업스트림 timeout 1회(cold 포크, 판정 영향 없음 — T-15 예열 대상). 동결: 기존 테스트 파일 무변경(`git diff`는 `__tests__/support/rpc-balance-stub.ts`만), F3 `6a48e7cea8e0d4ed`·F4 `3af643e844b77259` 일치
- 테스트 파일·runner: 기존 파일, Vitest·Playwright
- mock 허용 경계: 기존 파일의 경계 그대로
- 데이터 격리: 기존 파일의 격리 그대로
- 실행 환경: `bun run test:e2e` 기본 환경(앱 3100, anvil 8546), `check:build`와 동시 실행 금지

### T-14 — F3 E2E 회귀 갱신

- 사이드: E2E
- 상태: 완료
- 목적: 스펙 §4.5에 따라 F3 E2E `[EC-6]`의 QuoterV2 집계와 F3 통합 `quote-read` `[DoD-1][DoD-4][DoD-16][DoD-37]`의 fetch 집계를 견적 요청으로 좁히고, F4 `slippage-quote`의 최소 수령량 행 값 비교에서 USD 요소를 뺀다
- 선행: T-13
- 연결 항목: DoD-36
- 수정 대상: `e2e/quote.spec.ts` — `[EC-6]`의 QuoterV2 집계에서 단가 aggregate3(첫 하위 호출이 QuoterV2이고 slot0이 뒤에 오는 요청)를 빼는 판정 보조만. 동결 골격의 `@then`·it 이름은 바꾸지 않는다. `__tests__/swap/quote-read.test.tsx` — `[DoD-1][DoD-4][DoD-16][DoD-37]`의 `rpc.fetchStub.calls()` selector 집계에서 단가 aggregate3(첫 하위 호출이 QuoterV2이고 slot0이 뒤에 오는 요청)를 빼는 판정 보조만(사용자 결정 2026-11-22, T-4 보고). `__tests__/swap/slippage-quote.test.tsx` — `quote-amount-out-minimum` 값 칸 조각 비교(`:386`, `:428` 등)에서 USD 요소(`quote-amount-out-minimum-usd`·`usd-skeleton`) 텍스트를 빼는 판정 보조만(사용자 결정 2026-11-22, T-8 검증)
- 따라야 할 패턴: 동결 골격은 assertion만 바꾼다 — 근거: `docs/plans/native-eth.md` T-13
- 완료 조건: 결정 범위만 바뀌고 F3·F4 digest 전후를 기록한다. 단가 요청을 뺀 뒤에도 견적 요청 0건 판정이 유지된다 — 검증: `bun run test:e2e e2e/quote.spec.ts`, 동결 확인 명령
- 실행 명령: `bun run test __tests__/swap/quote-read.test.tsx __tests__/swap/slippage-quote.test.tsx`, `bun run test:e2e e2e/quote.spec.ts`
- 수정 금지: 제품 코드, 그 밖의 기존 테스트, `e2e/support/*`, `__tests__/support/*`
- 구현 기록: seongho:e2e-dev(T-15 골격 작성 에이전트) — `e2e/quote.spec.ts`(viem import에 `toFunctionSelector`, `isUsdPriceAggregate3`(첫 하위 호출이 QuoterV2 `quoteExactInputSingle`), `countQuoterV2CallsInItem`에서 단가 aggregate3는 0건). seongho:test-dev(T-8·T-9 작성 에이전트) — `__tests__/swap/quote-read.test.tsx`(`bodyHasSwapQuoteRequest`로 `[DoD-1][DoD-4][DoD-16][DoD-37]`의 selector fetch 집계에서 단가 aggregate3 제외), `__tests__/swap/slippage-quote.test.tsx`(`rowValueParts`가 값 칸 복제본에서 `quote-amount-out-minimum-usd`·`usd-skeleton`과 끝 `·`를 빼고 조각화). 수정 1/3: 7단계 스펙 대조 Low 소견(`quote-read` 집계가 aggregate3가 아닌 직접 `eth_call`까지 빼 §4.5 예외보다 넓음) → 사용자 결정으로 `isUsdPriceOnlyBody`(모든 항목이 단가 aggregate3인 fetch만 제외)로 좁힘, 재검증 test-runner `quote-read` 7/7·`bun run test` 383/383. 태그·이름·다른 case 무변경. 두 에이전트 모두 역할 정의상 테스트를 실행하지 않음. 오케스트레이터 확인: `bun run test __tests__/swap/quote-read.test.tsx __tests__/swap/slippage-quote.test.tsx` 14/14, `bun run test:e2e e2e/quote.spec.ts` 3/3 통과. F3 digest `6a48e7cea8e0d4ed` → `6a48e7cea8e0d4ed`(유지), F4 `3af643e844b77259` → `3af643e844b77259`(유지)
- 테스트 파일·runner: `e2e/quote.spec.ts`(Playwright chromium), `__tests__/swap/quote-read.test.tsx`·`__tests__/swap/slippage-quote.test.tsx`(Vitest jsdom)
- mock 허용 경계: 기존 파일의 경계 그대로
- 데이터 격리: 기존 파일의 격리 그대로
- 실행 환경: 앱 3100, anvil 8546(`--block-time 1`), Ethereum만

### T-15 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 실제 브라우저·프록시·anvil에서 ETH→USDC USD 표시, 모달 USD, 프록시 경로를 검증한다
- 선행: T-1, T-5, T-14
- 연결 항목: DoD-7, DoD-23, DoD-24, DoD-25
- 수정 대상: `e2e/usd-price.spec.ts` — 신규. `e2e/support/usd-price.ts` — 신규, locator와 러너 쪽 micros 계산. `e2e/support/anvil.ts` — 추가만, 풀 `slot0` 직접 읽기와 단가 경로 예열
- 따라야 할 패턴: mock 커넥터 연결, 감시만 하는 네트워크(`page.route` 금지), 러너 티어별 직접 견적, `beforeAll` 예열 — 근거: `e2e/support/network.ts:55-80`, `e2e/support/anvil.ts:97-179`, `e2e/quote.spec.ts`
- 완료 조건: 연결 항목 판정. 기대 micros는 러너가 anvil에서 직접 고른 티어의 `slot0`로 계산하고 제품 함수를 쓰지 않는다. DoD-7은 ETH→USDC 흐름과 모달 흐름 모두에서(사용자 확정 2026-11-22) 감시 구간 전체에서 `/api/rpc/*`·mock 커넥터용 anvil 외 JSON-RPC가 없고 단가 aggregate3가 `/api/rpc/1`로 나감을 확인한다. DoD-25는 T-1 (8) 잔액 토큰이다. E2E 전체가 통과한다 — 검증: E2E
- 실행 명령: `bun run test:e2e e2e/usd-price.spec.ts`, `bun run test:e2e`
- 수정 금지: 제품 코드, `config/e2e-mock.ts`, 기존 `e2e/*.spec.ts`, `e2e/support/app.ts`, `e2e/support/network.ts`
- 구현 기록: seongho:e2e-dev(골격 작성 에이전트, 살 모드), 작성 영역 `e2e/usd-price.spec.ts`(2 case)·`e2e/support/usd-price.ts`(신규: locator, 러너 쪽 티어 선택·현물가·micros, `watchUsdPriceRequests`)·`e2e/support/anvil.ts`(추가 67줄: `UNISWAP_V3_FACTORY_ADDRESS`, `readEachTierPoolSlot0Directly`, `warmUpUsdPricePath`). 수정 0/3. 본문 판단: `beforeAll`에서 목록 잔액·Multicall3·WETH→USDC 단가 경로·견적 예열, 단가 aggregate3 식별은 첫 하위 호출이 QuoterV2(`0xc6a5026a`), case 1 기대 micros는 러너가 anvil 직접 읽기로 계산(in: 1 ETH × 2^192/sqrtP², out: amountOut × 1), case 2는 ETH 행(T-1 (8)), 기준선 이후 새 단가 요청을 모달 일괄로 본다. 작성자 지적 위험: case 2는 기준선 뒤 window focus로 카드 재조회가 생기면 모달 일괄로 잘못 셀 수 있다(7단계 대조 대상). 오케스트레이터 확인: 골자 동결 유지, `bun run test:e2e e2e/usd-price.spec.ts` 2/2 통과(19.7초)
- 테스트 파일·runner: `e2e/usd-price.spec.ts`, Playwright chromium
- mock 허용 경계: F3 E2E 경계(mock 커넥터, 감시만 하는 네트워크)에 러너→anvil 단가 경로 예열과 `slot0` 직접 읽기를 더한 것, `page.route` 금지 (사용자 확정 2026-11-22). 실제 지갑, L2 체인, Vercel WAF는 증명하지 못한다
- 데이터 격리: 테스트별 브라우저 컨텍스트, 읽기 전용, `workers: 1`
- 실행 환경: 앱 3100(`NEXT_PUBLIC_E2E_MOCK=1`, `.next-e2e`), anvil 8546(`--block-time 1`), 포크 블록·포트 `config/e2e.ts`, 계정 `config/e2e-mock.ts`, Ethereum만, `check:build`와 동시 실행 금지

### T-16 — Base·Arbitrum 수동 확인

- 사이드: 수동
- 상태: 완료
- 목적: Base·Arbitrum 메인넷에서 ETH·USDC·WETH 경유 토큰의 USD 표시를 1회 확인하고 기록한다
- 선행: T-5
- 연결 항목: DoD-8, DoD-9
- 수정 대상: 없음. 결과는 구현 기록과 PR 본문에 남긴다
- 따라야 할 패턴: F3 수동 확인 기록 — 근거: `docs/plans/quote.md:167-179`
- 완료 조건: 체인마다 ETH·USDC·T-1 (2) 후보 토큰을 골라 금액을 입력하고, `usd-value`가 `success`인지와 날짜·표시값·토큰 주소를 기록한다(미연결로 가능) — 검증: 확인 절차
- 실행 명령: `bun run dev`
- 수정 금지: 저장소 파일
- 구현 기록: 7단계 seongho:e2e-runner(시나리오 B)가 수행, 2026-11-22T07:52Z, 지갑 미연결, Playwright chromium. Next dev 잠금(사용자 dev 서버 3000 실행 중) 때문에 작업 트리 사본(저장소 밖, 원본과 `diff -rq` 동일, 확인 후 `.env.local` 사본과 함께 삭제)에서 `next dev -p 3201`. 프록시 4xx·5xx 0, 콘솔 오류 0. Base: ETH `success` 1663766383 micros($1,663.76), USDC 1000000($1.00), GHST `0xcD2F22236DD9Dfe2356D7C543161D4d260FD9BcB` 45968($0.04). Arbitrum: ETH 1663754810($1,663.75), USDC 1000000($1.00), cbETH `0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f` 1900121956($1,900.12). 외부 시세 대조 없음. 증거 `/root/study/.pipeline-scratch/usd-price/t16/`(스크린샷 6장, `results.json`)

### T-17 — 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 전체 명령, 이전 기능 동결, 코드 대조 항목을 확인한다
- 선행: T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, T-10, T-11, T-12, T-13, T-14, T-15, T-16
- 연결 항목: DoD-7, DoD-15, DoD-33, DoD-34, DoD-35, DoD-36
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 명령을 하나씩 순서대로 실행, `check:build`는 `test:e2e` 뒤 단독 — 근거: `docs/plans/native-eth.md` T-17, `CLAUDE.md`
- 완료 조건: 명령이 모두 통과하고 `bun run test`는 3회 같은 결과다. F1~F7 동결 확인이 일치한다(F3은 T-14 뒤 새 digest). 코드 대조: 새 파일에 `Intl`·`toLocaleString` 없음, `package.json`·`bun.lock`·환경 변수 무변경, 외부 HTTP 없음, 프록시 허용 메서드 무변경, 이전 스펙 파일 무변경, §1 산정이 T-1 C로 갱신돼 120 이하, `lib/read-token-usd-price.ts`의 묶음 크기 상수 C가 T-1 (1) 기록값과 같음(사용자 확정 2026-11-22). DoD-36의 판정은 T-13·T-14와 이 Task의 명령 결과로만 하고, T-8의 스텁 분류 case는 보조다(사용자 확정 2026-11-22) — 검증: 명령 실행 확인
- 실행 명령: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`(3회), `bun run build`, `bun run test:fork`, `bun run test:e2e`, 그 뒤 단독으로 `bun run check:build`
- 수정 금지: 저장소 파일
- 구현 기록: 7단계 독립 검증으로 수행(아래 검증 기록). format·lint·typecheck·build 통과, `bun run test` 3회 383/383(+ 재검증 1회 383/383), `test:fork` 21/21, `test:e2e` 35/35, `check:build`는 E2E 뒤 오케스트레이터가 단독 실행해 통과. F1~F9 동결 일치(F3 `6a48e7cea8e0d4ed`·F4 `3af643e844b77259` 유지). 코드 대조 항목은 verify가 모두 충족(C = 11 = T-1 기록, §1 산정 115 ≤ 120)

## 3. 항목 coverage

- DoD-1: T-2, T-3, T-7, T-8
- DoD-2: T-2, T-3, T-7, T-8
- DoD-3: T-3, T-8
- DoD-4: T-3, T-4, T-8
- DoD-5: T-1, T-3, T-12
- DoD-6: T-1, T-3, T-12
- DoD-7: T-3, T-15, T-17
- DoD-8: T-1, T-16
- DoD-9: T-1, T-16
- DoD-10: T-2, T-7
- DoD-11: T-2, T-7
- DoD-12: T-2, T-7
- DoD-13: T-2, T-7
- DoD-14: T-2, T-7
- DoD-15: T-2, T-17
- DoD-16: T-4, T-5, T-9
- DoD-17: T-4, T-5, T-9
- DoD-18: T-4, T-5, T-9
- DoD-19: T-5, T-9
- DoD-20: T-4, T-5, T-11
- DoD-21: T-5, T-9
- DoD-22: T-5, T-9
- DoD-23: T-1, T-15
- DoD-24: T-15
- DoD-25: T-1, T-15
- DoD-26: T-4, T-10
- DoD-27: T-4, T-10
- DoD-28: T-4, T-10
- DoD-29: T-4, T-10, T-11
- DoD-30: T-4, T-11
- DoD-31: T-3, T-4, T-11
- DoD-32: T-4, T-11
- DoD-33: T-2, T-17
- DoD-34: T-17
- DoD-35: T-1, T-17
- DoD-36: T-1, T-8, T-13, T-14, T-17
- DoD-37: T-6
- DoD-38: T-6
- EC-1: T-5, T-9
- EC-2: T-5, T-9
- EC-3: T-5, T-9
- EC-4: T-5, T-9
- EC-5: T-5, T-9
- EC-6: T-5, T-9
- EC-7: T-5, T-9, T-11
- EC-8: T-5, T-9, T-11
- EC-9: T-4, T-10
- EC-10: T-3, T-4, T-10
- EC-11: T-4, T-10
- EC-12: T-4, T-10
- EC-13: T-4, T-10
- EC-14: T-3, T-8
- EC-15: T-3, T-8
- EC-16: T-2, T-3, T-7, T-8
- EC-17: T-3, T-8
- EC-18: T-1, T-12
- EC-19: T-1, T-3, T-4, T-11
- EC-20: T-4, T-11
- EC-21: T-4, T-11
- EC-22: T-4, T-11
- EC-23: T-1, T-3, T-10
- EC-24: T-4, T-5, T-9
- EC-25: T-2, T-7
- EC-26: T-3, T-8
- EC-27: T-3, T-8

## 4. 실행 순서

- 1구간(병렬): T-1(저장소 밖, 8555) / T-2 / T-6
- 2구간(병렬): T-3(T-1·T-2 뒤) / T-7(T-2 뒤)
- 3구간(병렬): T-4 / T-12(8547 독점)
- 4구간: T-5
- 5구간(단독): T-8. 공용 지원 모듈 `__tests__/support/rpc-balance-stub.ts`를 고친다
- 6구간(병렬): T-9 / T-10 / T-11. 각자 신규 파일 하나만 고친다. T-16은 T-5 뒤 언제든 가능하다(저장소 수정 없음)
- 7구간(단독): T-13. 수정 없음, E2E 포트를 독점한다
- 8구간(단독): T-14
- 9구간(단독): T-15. 포트 3100·8546을 독점한다
- 10구간(단독): T-17
- 테스트 설계(골격 동결)는 구현 전에 T-7~T-12, T-14, T-15의 골격을 먼저 고정한다

## 5. 차단 사항

- T-1 (1)에서 C < 11이면 §1 산정을 다시 하고 사용자 결정을 받는다

## 테스트 설계 증거

- 상태: 예외 동결 (reviewer 3라운드 뒤 자동 반복 한도 도달 → 사용자 승인으로 4라운드 1회 추가. 4라운드 NEEDS-FIX Med 2건(F001 EC-11 동일 주소 토큰 표본, F002 EC-16·26·18 목록 안 토큰 전제·요청 발생 판정)과 note 1건(F003 모달 일괄 무재시도) 반영분은 독립 재검토 없이 기계 검사만 통과, 사용자 확정 2026-11-22)
- 기준 스펙: `docs/specs/usd-price.md` (확정, 2026-11-22. 계획 단계 S-1~S-7 반영본)
- 골자 digest: `6a5e6db5a40c5bc1`
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/usd-price.md --files __tests__/lib/token-usd-price.test.ts __tests__/fork/usd-price.fork.test.ts __tests__/swap/usd-price-read.test.tsx __tests__/swap/usd-price-display.test.tsx __tests__/swap/usd-price-refresh.test.tsx __tests__/swap/usd-price-modal.test.tsx e2e/usd-price.spec.ts --exempt DoD-8,DoD-9,DoD-15,DoD-33,DoD-34,DoD-35,DoD-37,DoD-38 --frozen 6a5e6db5a40c5bc1`
- 골격 파일: `__tests__/lib/token-usd-price.test.ts`(T-7, 11 case), `__tests__/swap/usd-price-read.test.tsx`(T-8, 12), `__tests__/swap/usd-price-display.test.tsx`(T-9, 13), `__tests__/swap/usd-price-refresh.test.tsx`(T-10, 11), `__tests__/swap/usd-price-modal.test.tsx`(T-11, 12), `__tests__/fork/usd-price.fork.test.ts`(T-12, 3), `e2e/usd-price.spec.ts`(T-15, 2). T-13·T-14는 F9 골격 파일이 없다(T-14는 F3 동결 `[EC-6]`의 assertion만 바꾸고 F3 digest 전후를 기록한다)
- 기계 검사: 통과. 항목 65개 중 case 연결 57개, 제외 8개, case 64개(단위 11, 통합 48, 포크 3, E2E 2). 전부 `it.todo`/`test.fixme`. 포맷·린트 통과
- 작성 에이전트: seongho:test-dev 3개(T-7·T-12 / T-8·T-9 / T-10·T-11), seongho:e2e-dev 1개(T-15). 살 모드는 같은 에이전트가 이어서 맡는다. 세션이 바뀌면 같은 타입의 새 인스턴스에 지시 전문을 다시 주고 구현 기록에 남긴다
- reviewer 라운드: 4회(매번 새 `general-purpose`, "새 case 요구에는 틀린 구현 예" 지시, 검토 전후 파일 해시 동일 확인)
  - 1라운드 NEEDS-DECISION(digest `7ed0e8f6d21d233f`): NEEDS-FIX 11건(F001 모달 ETH·USDC 행, F002·F011 일괄 요청 구조 정의, F003 DoD-3 직접 호출 0건, F004 decimals ≠ 18 표본, F005 SSR empty, F006·F007 공허한 balance-usd 판정, F009 표본 병합, F015 EC-8 두 칸), 결정 3건(F008 EC-19 부풀림 제거, F012 DoD-36 보조 표기, F013 C 대조·전제 확인)
  - 2라운드 NEEDS-FIX(digest `2867f6a5d2466f84`): 재열기 잔액 경계(EC-21·22), 열린 동안 검색어(DoD-32), 미연결 표본(DoD-16·17), 단가 상태 × 금액·견적 상태 우선(EC-1·3), EC-24 부풀림 제거
  - 3라운드 NEEDS-FIX(digest `c61fb117a94c4ca3`): 재시도 관찰 구간(EC-10·23), 입력 반영 대기 전 판정(EC-13), EC-12 판정 정합, 실패 묶음 안 카드 토큰 유지(EC-20 × EC-9, 새 case). 한도 도달 → 사용자 승인으로 4라운드
  - 4라운드 NEEDS-FIX(digest `156389b29a63f977`): F001·F002(위 상태 참고). 반영 후 예외 동결
- 제외 (사용자 확정 2026-11-22): DoD-8·DoD-9(Base·Arbitrum 메인넷 수동 1회, T-16), DoD-15·DoD-33·DoD-35·DoD-37·DoD-38(코드 대조, T-1·T-6·T-17·7단계 verify), DoD-34(명령 실행, T-17)
- mock 경계 (사용자 확정 2026-11-22): T-7 없음(순수 함수). T-8 F3 통합 경계(실제 wagmi·Provider·화면, mock 커넥터, 전역 fetch URL 라우팅 스텁, `vi.mock` 금지) + 단가 aggregate3 스텁 분류·응답·HTTP 429 응답. T-9 T-8 + EC-24 한정 `react-dom/server`. T-10 T-8 + 가짜 타이머·`visibilityState` 스텁·HTTP 429. T-11 T-8 + 가짜 타이머. T-12 없음(실제 anvil Ethereum 포크, `vi.stubEnv`). T-15 F3 E2E 경계(mock 커넥터, 감시만 하는 네트워크) + 러너→anvil 단가 경로 예열·`slot0` 직접 읽기, `page.route` 금지
- 해석 결정 (사용자 확정 2026-11-22): T-2에 견적·`slot0` 결합 순수 함수 추가(T-7 DoD-1·2·EC-16의 층). T-1 (2)에 USDC 직접 경로 ERC-20 표본 선정 추가(T-12 DoD-5). EC-16·26은 훅 상태와 함께 맵 값 `null` 판정. EC-19는 제품 export 상수 C로 요청당 ≤ C 판정((WETH, USDC) 구간 쌍 제외), C = T-1 (1) 기록값은 T-17 코드 대조, 표본 전제 2C+1 ≤ 목록 토큰 수를 본문이 먼저 확인. DoD-36 판정은 T-13·T-14·T-17 명령 결과로만 하고 T-8의 분류 case는 보조. DoD-7은 E2E 두 흐름(ETH→USDC, 모달) 모두에서 판정. EC-20은 "캐시 값이 없는 묶음 토큰만 생략", 실패 묶음 안 카드 단가 토큰은 EC-9에 따라 이전 값 유지
- 미검증 (경계의 한계): 실제 Next SSR·하이드레이션(EC-24), 실제 브라우저 탭 숨김·타이머 스로틀링(DoD-28), Vercel WAF 실제 429 형태와 분당 한도(EC-23·DoD-35는 산정 대조), eth_call 가스 상한(EC-19는 T-1 실측 의존), Base·Arbitrum 실제 가격·경로(DoD-8·9 수동만, EC-14 스텁만), 실제 지갑. 요청 수 판정은 "첫 하위 호출이 QuoterV2인 aggregate3" 분류(계획 §1 순서)에 의존한다. 4라운드 반영분 3건은 독립 재검토를 받지 않았다
- 스펙 변경 (구현 단계 T-1 결과, 사용자 결정 2026-11-22): EC-19의 가스 기준을 "업체 RPC의 eth_call 가스 상한"으로 명확히 하고 공개 RPC 실패는 EC-20으로 처리한다는 문장을 더했다. 골격 EC-19 case는 "요청당 ≤ C"만 판정하므로 골자 변경 없음, `--frozen 6a5e6db5a40c5bc1` 일치 확인. 이 변경에 대한 reviewer 재검토는 하지 않았다
- 구현 전 확인 위험: EC-18(USDC·WETH 풀이 모두 없는 **목록 안** 토큰), DoD-6(WETH 대비 token0·token1 경유 토큰), DoD-25(mock 계정 잔액 토큰) 표본이 T-1에서 실제로 존재하는지. 없으면 구현을 멈추고 스펙·골격(test-design update)으로 되돌린다
- 7단계 코드 대조 항목: `balance-usd`가 `balance` span 바깥, 새 파일에 `Intl`·`toLocaleString` 없음, `package.json`·`bun.lock`·환경 변수 무변경, 외부 HTTP 없음, 프록시 허용 메서드 무변경, 이전 스펙 파일 무변경, `quote-skeleton`을 USD 자리에 쓰지 않음, 단가 aggregate3 하위 호출 순서(quote 앞·slot0 뒤), 묶음 크기 C = T-1 기록값, README·디자인 문서 문장(DoD-37·38)
- 본문 작성 주의: T-8이 `__tests__/support/rpc-balance-stub.ts`를 추가만으로 먼저 확장한다(T-9~T-11은 그 뒤). 기대 주소·단가·micros는 리터럴과 테스트 쪽 계산으로 정하고 제품 config·함수를 쓰지 않는다(EC-19의 C만 예외). 재시도 없음 판정은 재시도 지연(TanStack 1·2·4s, viem 150·300·600ms)을 덮는 구간에서 센다. 표본 토큰은 T-1 결과를 따른다. `vitest list --json` 등 파일을 쓰는 옵션 금지. `check:build`와 `test:e2e`는 동시에 실행하지 않는다

### 검증 기록

- 코드 기준: `91d4116` + 커밋 전 작업 트리(2026-11-22). 스펙 대조·test-runner·e2e-runner 실행 전후 작업 트리 동일(오케스트레이터 스냅샷 비교: HEAD·`git status --porcelain`·`git diff` 해시·미추적 파일 해시). 8단계 사용자 결정 반영 뒤 바뀐 것은 스펙 문구 2곳(EC-20 묶음 범위, §4.1 `idle` 주석)과 `__tests__/swap/quote-read.test.tsx` 판정 보조 함수뿐이며, 이 범위를 test-runner가 재실행했다
- 스펙 대조(새 general-purpose + `seongho:verify`, 실행 없음): 충족 61·부분 0·미충족 0·검증 불가 4(DoD-8·9 수동, DoD-34·36 명령 실행). 스코프 초과 0, 엣지 케이스 누락 0, High·Med 결함 0. F9·F3·F4 동결 일치, F9 todo·fixme·skip·only 0건. 7단계 코드 대조 항목 10개 모두 이상 없음. Low 소견 7건 → 사용자 결정(2026-11-22): 1(EC-20 묶음 범위)·6(`idle` 의미)은 스펙 문구 명확화, 3(`quote-read` 집계 범위)은 T-14 수정, 2·4·5·7은 알려진 한계로 기록
- 테스트 실행(`seongho:test-runner`): format·lint·typecheck·build 통과, `bun run test` 3회 50 파일 383/383, Task별 개별 실행 전부 통과(T-7 11, T-8 12, T-9 13, T-10 11, T-11 12, T-14 Vitest 14, config·lib 82), `test:fork` 6 파일 21/21, F1~F9 동결 확인 8건 일치. 재검증: `quote-read` 7/7, `bun run test` 383/383, F9·F3 일치
- E2E 실행(`seongho:e2e-runner`): `test:e2e e2e/usd-price.spec.ts` 2/2, `test:e2e` 전체 35/35(1 worker, 재시도 0, flaky 0). F3 `[EC-6]` 통과. 관찰: F2 `swap-form` DoD-30이 36.8초(같은 시점 chain 1 프록시 업스트림 timeout 로그), 통과. 시나리오 B(T-16)는 위 T-16 기록
- `check:build`: E2E 종료 뒤 오케스트레이터가 단독 실행, "모든 빌드 결과 검사 통과"

| 스펙 항목          | 코드 대조                    | 실행 확인 (근거 case)                                                           | 종합 |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------- | ---- |
| DoD-1·2            | 충족                         | 확인됨 (`token-usd-price` DoD-1·2, `usd-price-read` DoD-1·2)                    | 충족 |
| DoD-3·4            | 충족                         | 확인됨 (`usd-price-read` DoD-3·4, 세 체인)                                      | 충족 |
| DoD-5·6, EC-18     | 충족                         | 확인됨 (`usd-price.fork` DoD-5·6·EC-18, `test:fork`)                            | 충족 |
| DoD-7              | 충족                         | 확인됨 (`e2e/usd-price` 두 case, JSON-RPC 감시)                                 | 충족 |
| DoD-8·9            | 검증 불가(수동)              | 확인됨 (T-16 메인넷 화면 6건 `success`)                                         | 충족 |
| DoD-10~14, EC-25   | 충족                         | 확인됨 (`token-usd-price`)                                                      | 충족 |
| DoD-15·33·35·37·38 | 충족                         | 코드 대조 항목(실행 대상 아님)                                                  | 충족 |
| DoD-16~22          | 충족                         | 확인됨 (`usd-price-display`, `usd-price-modal` DoD-20)                          | 충족 |
| DoD-23·24·25       | 충족                         | 확인됨 (`e2e/usd-price`)                                                        | 충족 |
| DoD-26~29          | 충족                         | 확인됨 (`usd-price-refresh`, `usd-price-modal` DoD-29)                          | 충족 |
| DoD-30~32          | 충족                         | 확인됨 (`usd-price-modal`)                                                      | 충족 |
| DoD-34             | 검증 불가(명령)              | 확인됨 (`check:build` 통과)                                                     | 충족 |
| DoD-36             | 코드 부분 충족(§4.5 예외 안) | 확인됨 (`test` 383/383, `test:fork` 21/21, `test:e2e` 35/35, F3·F4 digest 유지) | 충족 |
| EC-1~8             | 충족                         | 확인됨 (`usd-price-display`, `usd-price-modal` EC-7·8)                          | 충족 |
| EC-9~13, EC-23     | 충족                         | 확인됨 (`usd-price-refresh`)                                                    | 충족 |
| EC-14~17, EC-26·27 | 충족                         | 확인됨 (`usd-price-read`)                                                       | 충족 |
| EC-19~22           | 충족                         | 확인됨 (`usd-price-modal`)                                                      | 충족 |
| EC-24              | 충족                         | 확인됨 (`usd-price-display` EC-24, `react-dom/server` 경계)                     | 충족 |

- 알려진 한계(사용자 확정 2026-11-22): E2E `[DoD-25][DoD-7]`은 카드 ETH 단가 재조회와 모달 일괄 요청을 내용으로 구분하지 못해, 기준선 뒤 카드 재조회가 생기면 "모달 일괄 요청 1건 이상"의 증명력이 약하다. EC-24 case는 SSR·첫 렌더 모두 금액이 비어 단가 상태와 무관하게 empty다. display 테스트 probe가 ETH 단가를 직접 읽어 provider의 ETH 조회 결함을 가릴 수 있다(refresh 테스트가 요청 수로 잡는다). DoD-35 산정은 분당 모달 열기 1회 전제이며, 잔액 토큰이 많은 계정이 1분에 모달을 두 번 열면 최악 198건이다
- 미검증: 실제 지갑, 실제 Vercel WAF 429 형태와 분당 한도, 실제 Next SSR·하이드레이션, 실제 브라우저 탭 숨김 스로틀링, 50M 상한 공개 RPC에서 무거운 토큰 묶음의 실패(EC-20 처리 대상), 메인넷 USD 값의 외부 시세 대조
