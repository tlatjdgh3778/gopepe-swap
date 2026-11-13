# 계획: quote

- 상태: 승인
- 스펙: docs/specs/quote.md
- 기준 코드: 5ff5549 + 작업 트리
- 최종 갱신: 2026-11-13

## 1. 구현 전략

- 순서는 사전 확인, 순수 함수·config, 견적 데이터 계층, 화면, 테스트 본문(단위·통합·포크·F2 회귀·E2E), 수동 확인과 전체 검사다. 근거: `docs/plans/token-amount-input.md` §4
- 견적은 새 Provider 하나가 읽고 받는 칸·견적 정보·주 버튼이 그 컨텍스트만 읽는다. 컴포넌트마다 `useQuery`를 부르면 debounce 상태, 15초 주기, focus 리스너가 관찰자 수만큼 생겨 세 곳이 다른 입력을 볼 수 있다. Provider는 `providers/app-providers.tsx`의 `SwapFormProvider` 안쪽에 둔다. 근거: `hooks/use-token-balance.ts:22`, `providers/swap-form-provider.tsx`
- 조회 훅은 F2 카드 잔액 훅 패턴을 따른다. `retry: false`, 15초 `refetchInterval`(export 상수), `refetchIntervalInBackground: false` 명시, `refetchOnWindowFocus: false`와 window `focus` 리스너의 `refetch({ cancelRefetch: false })`, 리스너는 쿼리가 활성일 때만 붙인다. 클라이언트는 선택 체인 ID로 `config.getClient`에서 얻는다. 근거: `hooks/use-token-balance.ts`, `docs/plans/token-amount-input.md` §1
- queryKey에 bigint를 넣지 않는다. 키는 상수, revision, chainId, 치환 전 소문자 토큰 주소 둘, `amountInRaw.toString()`이다. 근거: `providers/app-providers.tsx:41`(QueryClient hashFn 없음, 기본 JSON.stringify)
- 입력 시그니처(체인, 두 토큰 주소, `amountInRaw` 문자열)가 바뀐 것을 렌더 중에 감지해 revision을 올리고 같은 렌더에서 `loading`을 돌려준다. `useEffect`의 300ms 타이머(export 상수)가 반영값을 확정한다. 시그니처가 `amountInRaw` 기준이라 문자열만 바뀐 입력은 다시 견적하지 않는다. revision이 키에 있어 이전 입력의 늦은 응답은 다른 키에만 쌓인다. 반영 대기 중에는 쿼리를 비활성화하고 `gcTime: 0`으로 둔다. 근거: `providers/swap-form-provider.tsx:90-94`(render 중 파생), `components/token-modal.tsx:62-77`(입력값·반영값 두 state)
- Provider의 상태 결정 순서는 idle 판정, ETH ↔ WETH 판정(대기 없이 `no-route`), 반영 대기(`loading`), 쿼리 결과(data가 있으면 그 결과, 없고 오류면 `error`, 아니면 `loading`)다. data를 먼저 보므로 다시 읽기가 실패해도 마지막 성공 값이 남는다. `placeholderData`는 쓰지 않는다. idle 판정식은 `getSwapInputState`의 토큰·금액 판정과 공유한다. 근거: react-query v5 쿼리 결과 의미, `lib/swap-input-state.ts`
- RPC는 1건으로 만든다. 풀 주소는 viem `getContractAddress`(CREATE2)와 `POOL_INIT_CODE_HASH`로 계산하고, `aggregate3` 1회에 네 티어의 `slot0`과 `quoteExactInputSingle`을 `allowFailure: true`로 묶는다. slot0과 견적이 같은 `eth_call` 안에서 읽힌다. wagmi `batch.multicall`을 끈 클라이언트 사본과 명시 `batchSize`를 쓴다. T-1에서 CREATE2 주소가 `getPool`과 어긋나면 `getPool`·견적 1회 후 `slot0` 1회의 2건 방식으로 바꾼다. 근거: `lib/token-balances.ts:20-26,80-88`
- 판정 로직(티어 선택·제외, 유동성 소진, 가격 영향, 등급, 표시, ETH ↔ WETH, WETH 치환, 풀 주소, 주 버튼 견적 상태 합성)은 `lib/` 순수 함수로 나눈다. 유동성 소진은 `sqrtPriceX96After`가 방향별 한계값과 같은지로 판정한다. 등급은 표시용으로 버린 bps 값으로 판정한다. 숫자 표시는 로캘 API 없이 bigint로 만든다. 근거: `lib/token-amount.ts:8`, `lib/swap-input-state.ts`
- 주 버튼은 지갑 분기, `getSwapInputState`, 견적 상태 합성 순으로 판정한다. `getSwapInputState`의 반환값 `input-valid`는 내부 값으로 남기고 `PrimaryButtonState`에서 뺀다. 근거: `components/primary-button.tsx:13-72`
- 화면은 `components/swap-card.tsx`를 서버 컴포넌트로 두고 입력 그룹과 주 버튼 사이에 클라이언트 컴포넌트를 더한다. 받는 칸 `amount-input` 요소는 항상 DOM에 남기고 값과 속성만 채운다. 스켈레톤은 `bg-raised`, `aria-hidden`, testid 패턴에 동작 줄이기 환경 정지를 더한다. `--warning`은 `app/globals.css`에 추가한다. 근거: `components/token-modal.tsx:164-180`, `__tests__/swap/amount-input.test.tsx:280-286`, `docs/design/README.md`
- mock 경계는 F2 관례를 따른다. 실제 wagmi·Provider·화면, 지갑은 mock 커넥터나 스텁 EIP-1193, RPC는 전역 fetch 스텁, `vi.mock` 금지. 견적 aggregate3 스텁 응답, 탭 숨김 스텁, 받는 칸 값 판정, E2E 견적 예열은 새 경계라 테스트 설계 단계에서 사용자가 확정한다. 근거: `docs/plans/token-amount-input.md` 테스트 설계 증거

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: 스펙의 구현 전 확인 사실 2건과 RPC 1건 설계·테스트 기대값이 기대는 포크·체인 사실을 실행으로 확인한다
- 선행: 없음
- 연결 항목: DoD-5, DoD-8, DoD-9, DoD-10, DoD-16, EC-3, EC-4, EC-15
- 수정 대상: 없음 — 저장소 밖 임시 위치에서 전용 포트(8546·8547 외, 예: 8555)의 anvil 포크와 공개 RPC 읽기로 확인한다
- 따라야 할 패턴: 저장소 밖 확인, 결과는 구현 기록에 남김 — 근거: `docs/plans/token-amount-input.md` T-1
- 완료 조건: 다음 결과를 구현 기록에 남기고, 스펙 확인 사실과 어긋나면 인터뷰로 되돌리며, (3)이 어긋나면 2건 방식으로 전략을 바꾼다. (1) `FORK_BLOCK_NUMBER`에서 네 티어 모두 `getPool`이 0 주소이고 견적이 revert하는 `config/tokens-1.json` 안의 페어 (2) 그 페어의 보내는 토큰을 mock 계정에 `anvil_dealERC20`로 넣을 수 있는지, F1·F2 주입 토큰(USDC, LINK)과 겹치지 않는지 (3) CREATE2 계산 주소와 `getPool` 일치 여부(Ethereum 포크, Base·Arbitrum 공개 RPC, 페어 여러 개 × 네 티어) (4) ETH→USDC aggregate3(slot0 4 + 견적 4) 1회의 본문 바이트·사용 가스와 포크·업체 RPC·공개 RPC(세 체인) 성공 여부 (5) 큰 금액과 유동성 소진 금액에서 가스가 노드 `eth_call` 가스 상한 안인지 (6) 유동성 소진 표본에서 QuoterV2가 revert하지 않고 `sqrtPriceX96After`가 한계값과 같은지 (7) cold 포크 견적 aggregate3 지연과 프록시 상류 제한 5초 비교 (8) 포크 블록 ETH→USDC의 티어별 수령량과 동률 여부 — 검증: 확인 절차
- 실행 명령: `anvil --fork-url $ETH_MAINNET_RPC_URL --fork-block-number 26250000 --port 8555`, `cast call`, `cast rpc`, `cast estimate`
- 수정 금지: 저장소 파일
- 구현 기록: seongho:frontend-dev(조사 전용), 수정 파일 없음(저장소 밖, 포트 8555, 종료 확인). 수정 0/3. 결과: (1) 풀 없는 페어 DAI(`0x6B17…1d0F`, 18)→PENDLE(`0x8085…a827`, 18). 네 티어 `getPool` 0 주소, 견적 revert(data `0x`), aggregate3에서 slot0은 success=true·`0x`(viem `failure` ZeroData), 견적은 success=false. 대안 DAI→ENA (2) DAI `anvil_dealERC20` 주입 가능(절대값 덮어쓰기, anvil 1.8.1), 포크 블록 mock 계정 DAI 0, 고정 토큰이라 F2 DoD-9 잔액 그룹 기대를 깨지 않음 (3) CREATE2(init code hash `0xe34f…8b54`)와 `getPool` 일치: Ethereum 474/474, 포크 29/29, Base 113/113, Arbitrum 76/76 → RPC 1건 전략 유지 (4) ETH→USDC aggregate3(slot0 4+견적 4) 호출 데이터 2,244 B·본문 4,616 B, estimateGas 포크 521,873·Base 582,204·Arbitrum 916,982, 포크·업체·공개 RPC(세 체인) 하위 8건 모두 성공 (5) `eth_call` 상한 anvil 60M·ETH/Arbitrum 공개 50M·업체 550M 이상. 1e4 ETH 이하 50M 안, 1e5 ETH는 50M에서 3000·10000 티어 하위 호출만 가스 부족으로 revert(후보에서 조용히 빠짐), 유동성 소진 금액은 60M 이하 노드에서 호출 전체 out of gas (6) 유동성 소진 시 QuoterV2는 revert하지 않고 `sqrtPriceX96After`가 한계값과 정확히 같음(양방향, Base 포함) (7) cold 포크 ETH→USDC 첫 호출 6.2~~6.9초(프록시 5초 초과, 이후 3~~6 ms), DAI→PENDLE 0.5~0.9초, cold 큰 금액은 더 느림(100 ETH 24.7초) (8) 포크 블록 ETH→USDC 1 ETH 티어별 2375903197·2374332584·2370866990·2350796986(100 선택, 동률 없음), 10 ETH는 500 선택, 1 gwei는 네 티어 모두 2(동률→100), 1e6 wei 이하는 모두 0. 스펙 확인 사실 2건 결정과 일치

### T-2 — 순수 함수와 config

- 사이드: 프론트
- 상태: 완료
- 목적: 티어 선택·제외, 가격 영향·등급·표시, ETH ↔ WETH 판정·치환, 풀 주소, 주 버튼 견적 상태 합성을 순수 함수로 만든다
- 선행: 없음
- 연결 항목: DoD-2, DoD-3, DoD-4, DoD-16, DoD-17, DoD-19, DoD-20, DoD-21, DoD-22, DoD-23, DoD-24, DoD-31, DoD-32, DoD-33, DoD-34, DoD-35, DoD-36, EC-1, EC-2, EC-3, EC-4, EC-6, EC-15
- 수정 대상: `config/uniswap-v3.ts` — 신규, 티어 상수, `POOL_INIT_CODE_HASH`, 한계 sqrt 가격, QuoterV2 `quoteExactInputSingle`·Pool `slot0` ABI. `lib/swap-quote.ts` — 신규, 스펙 §4.1 타입과 견적 판정 함수. `lib/quote-format.ts` — 신규, 등급과 가격 영향·티어·환율 표시. `lib/swap-input-state.ts` — 주 버튼 견적 상태 합성 함수와 idle 판정 공유 export 추가, `getSwapInputState` 동작 불변
- 따라야 할 패턴: 관심사별 config 파일, `lib/` 순수 함수, 로캘 API 없는 bigint 표시, kebab-case 파일명과 named export — 근거: `config/contracts.ts`, `lib/token-amount.ts`, `CLAUDE.md`
- 완료 조건: 연결 항목 충족, 로캘 API 미사용, 정수가 아니거나 음수인 `priceImpactBps` 처리, 두 스왑 방향(zeroForOne 참·거짓) 모두 처리, T-1 (3)이 어긋나면 `POOL_INIT_CODE_HASH` 부분만 고침 — 검증: T-5
- 실행 명령: `bun run typecheck`, `bun run test __tests__/lib`
- 수정 금지: `components/`, `providers/`, `hooks/`, `config/contracts.ts`, `config/tokens.ts`, `lib/token-amount.ts`, `lib/token-balances.ts`
- 구현 기록: seongho:frontend-dev, 작성 영역 `config/uniswap-v3.ts`(신규), `lib/swap-quote.ts`(신규), `lib/quote-format.ts`(신규), `lib/swap-input-state.ts`(함수 추가). 수정 0/3. export: `FEE_TIERS`, `POOL_INIT_CODE_HASH`, `SQRT_PRICE_LIMIT_ZERO_FOR_ONE`·`_ONE_FOR_ZERO`, `quoterV2Abi`, `uniswapV3PoolAbi`, `isEthWethPair`, `getQuoteTokenAddress`, `resolveQuoteTokens`, `sortTokens`, `isZeroForOne`, `getPoolAddress`, `planSwapQuote`, `isLiquidityExhausted`, `selectFeeTier`, `calculatePriceImpactBps`, `buildSwapQuote`(고른 티어 slot0 실패 시 throw), `getPriceImpactSeverity`, `formatPriceImpact`, `formatFeeTier`, `getQuoteRateRaw`, `formatQuoteRate`, `getIncompleteSwapInputState`, `isSwapInputIdle`, `getSwapButtonState`. 구현 판단: 입력 통과+견적 idle 조합(§4.1상 발생 불가)은 `quoting`으로 매핑, `SwapQuoteState`는 판별 유니온. 오케스트레이터 확인: typecheck 통과, `test __tests__/lib` 27 통과·19 todo, 골자 유지, 로캘 API 없음

### T-3 — 견적 데이터 계층

- 사이드: 프론트
- 상태: 완료
- 목적: aggregate3 1회 견적 읽기 함수, 조회 훅, 반영 대기·revision·상태 결정 Provider와 `useSwapQuote()`를 만든다
- 선행: T-1, T-2
- 연결 항목: DoD-1, DoD-4, DoD-5, DoD-6, DoD-7, DoD-8, DoD-25, DoD-26, DoD-27, DoD-28, DoD-29, DoD-30, DoD-37, DoD-41, EC-6, EC-7, EC-9, EC-10, EC-11, EC-12, EC-13, EC-14, EC-16
- 수정 대상: `lib/read-swap-quote.ts` — 신규, 클라이언트를 받아 batch를 끈 사본으로 `multicall` 1회를 보내고 T-2 함수로 결과를 만든다. aggregate3 요청 실패와 고른 티어의 `slot0` 하위 호출 실패는 throw. `lib/token-balances.ts` — `withoutMulticallBatching`에 export만 추가. `hooks/use-swap-quote-read.ts` — 신규, 조회 훅과 focus 리스너. `providers/swap-quote-provider.tsx` — 신규, 반영 대기 상수, revision 파생, 상태 결정, `useSwapQuote()`. `providers/app-providers.tsx` — `SwapFormProvider` 안쪽에 마운트
- 따라야 할 패턴: Provider와 훅을 한 파일에 둠, render 중 파생, 시간 값은 export 상수, `chainId` 명시 — 근거: `providers/swap-form-provider.tsx`, `hooks/use-token-balance.ts`, `components/token-modal.tsx:15`
- 완료 조건: 연결 항목 충족, 견적 1회에 JSON-RPC `eth_call` 1건(T-1 (3)이 어긋나면 2건), ETH ↔ WETH는 RPC 0건, queryKey에 bigint 없음, 지갑 상태와 무관하게 읽음, SSR 첫 렌더는 `idle`, F2 잔액 읽기 동작 불변 — 검증: T-6, T-7, `bun run typecheck`
- 실행 명령: `bun run typecheck`, `bun run test __tests__/swap`
- 수정 금지: `components/`, `config/wagmi.ts`, `config/rpc.ts`, `lib/rpc-proxy.ts`, `providers/swap-form-provider.tsx`, `hooks/use-token-balance.ts`, T-2 파일
- 구현 기록: seongho:frontend-dev(T-2 작성 에이전트 이어서), 작성 영역 `lib/read-swap-quote.ts`(신규), `hooks/use-swap-quote-read.ts`(신규), `providers/swap-quote-provider.tsx`(신규), `lib/token-balances.ts`(export만), `providers/app-providers.tsx`(마운트). 수정 0/3. export: `SWAP_QUOTE_DEBOUNCE_MS`=300, `SwapQuoteProvider`, `useSwapQuote`, `SWAP_QUOTE_REFETCH_INTERVAL_MS`=15_000, `SWAP_QUOTE_QUERY_KEY`, `useSwapQuoteRead`, `SWAP_QUOTE_MULTICALL_BATCH_SIZE`=0(나누지 않음, 항상 aggregate3 1회), `readSwapQuote`, `withoutMulticallBatching`. 구현 판단: 하위 호출 실패(`ContractFunctionExecutionError`)는 그 티어의 revert로, 그 밖의 실패는 throw. 오케스트레이터 확인: typecheck 통과, `test __tests__/swap __tests__/wallet __tests__/lib` 115 통과·33 todo, 골자 유지

### T-4 — 화면

- 사이드: 프론트
- 상태: 완료
- 목적: 받는 칸 수령량, 환율 행, 견적 정보 세 행, 스켈레톤, 가격 영향 색, 주 버튼 견적 상태를 만든다
- 선행: T-3
- 연결 항목: DoD-7, DoD-11, DoD-12, DoD-13, DoD-14, DoD-15, DoD-17, DoD-18, DoD-31, DoD-32, DoD-33, DoD-34, DoD-35, DoD-36, DoD-40, EC-5, EC-8, EC-15
- 수정 대상: `components/token-field.tsx` — 받는 칸 값, `data-amount-out-raw`, `loading` 스켈레톤(`amount-input` 요소와 읽기 전용 유지). `components/quote-details.tsx` — 신규, 환율 행·견적 정보·스켈레톤 컴포넌트. `components/swap-card.tsx` — 견적 정보 배치, 서버 컴포넌트 유지. `components/primary-button.tsx` — `input-valid` 제거, 견적 상태 합성과 문구. `app/globals.css` — `--warning` 토큰
- 따라야 할 패턴: 스켈레톤, 주 버튼 분기·클래스, 디자인 기준 — 근거: `components/token-modal.tsx:164-180`, `components/primary-button.tsx`, `docs/design/README.md`, `docs/design/wireframe/a-desktop.png`
- 완료 조건: 연결 항목 충족, 스펙 §4.2·§4.3 식별자·속성 값 일치, 환율 방향 전환 버튼 없음, SSR HTML에 `data-state="disconnected"` 요소 추가 없음, 프로덕션 빌드 통과 — 검증: T-6, T-8, `bun run build`
- 실행 명령: `bun run build`, `bun run lint`
- 수정 금지: `config/`, `providers/`, `hooks/`, `lib/`
- 구현 기록: seongho:frontend-dev(T-2·T-3 작성 에이전트 이어서), 작성 영역 `components/quote-details.tsx`(신규), `components/token-field.tsx`, `components/swap-card.tsx`(서버 컴포넌트 유지), `components/primary-button.tsx`, `app/globals.css`(`--warning`, `--color-warning`). 수정 0/3. 구현 판단: 견적 정보 제목·행 이름과 수령량 행의 `{수령량} {심볼}` 표기는 시안 A, 환율 행 ⇅ 아이콘은 방향 전환으로 오해되지 않게 뺌, `loading` 중 받는 칸 placeholder는 비움(스켈레톤 아래 `0` 방지). 오케스트레이터 확인: build·lint·format:check 통과. F2 `primary-button.test.tsx` 4건이 `input-valid` 기대로 실패(T-9 소관)

### T-5 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 견적 판정과 표시 순수 함수를 검증한다
- 선행: T-2
- 연결 항목: DoD-2, DoD-3, DoD-4, DoD-16, DoD-17, DoD-19, DoD-20, DoD-21, DoD-22, DoD-23, DoD-24, EC-1, EC-2, EC-3, EC-4, EC-6
- 수정 대상: `__tests__/lib/swap-quote.test.ts`, `__tests__/lib/quote-format.test.ts` — 신규
- 따라야 할 패턴: 순수 함수 단위 테스트 — 근거: `__tests__/lib/token-amount.test.ts`, `__tests__/lib/swap-input-state.test.ts`
- 완료 조건: 연결 항목 판정, DoD-16은 두 스왑 방향과 정수가 아닌 값·음수 표본 포함, DoD-17은 표시값 300·1500 bps 경계 앞뒤와 표시는 `3.00%`인데 원값이 300 bps를 넘는 표본 포함, EC-3은 두 방향의 한계값 표본, EC-6은 두 순서와 세 체인, DoD-24는 기본 로캘이 `de-DE`인 환경에서도 같은 결과 — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib`
- 수정 금지: 제품 코드, F2 테스트 파일
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/lib/swap-quote.test.ts`, `__tests__/lib/quote-format.test.ts`. 수정 0/3. 완성 19 case, todo 0. 기대값은 태그 리터럴(체인별 WETH 포함), DoD-16 비교 허용 오차 5e-7 bps, DoD-24 로캘 스텁 try/finally 원복. 오케스트레이터 확인: 골자 유지, `bun run test __tests__/lib` 46/46 통과
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: (사용자 확정) 없음. 예외로 DoD-24에 한해 F2와 같은 로캘 기본값(`de-DE`) 전역 스텁을 허용한다
- 데이터 격리: 순수 함수와 정적 데이터만 사용, 로캘 스텁은 테스트마다 원복

### T-6 — 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 실제 Provider·wagmi·화면 위에서 요청, 표시, 갱신, 동시성, 주 버튼, 훅 계약을 검증한다
- 선행: T-3, T-4
- 연결 항목: DoD-1, DoD-6, DoD-7, DoD-8, DoD-11, DoD-12, DoD-13, DoD-14, DoD-15, DoD-17, DoD-25, DoD-26, DoD-27, DoD-28, DoD-29, DoD-30, DoD-31, DoD-32, DoD-33, DoD-34, DoD-35, DoD-36, DoD-37, DoD-40, DoD-41, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13, EC-14, EC-15, EC-16
- 수정 대상: `__tests__/swap/quote-read.test.tsx` — 신규, 요청·미연결·잔액 부족·요청 수·훅 계약. `__tests__/swap/quote-display.test.tsx` — 신규, 받는 칸·환율 행·견적 정보·스켈레톤·등급. `__tests__/swap/quote-refresh.test.tsx` — 신규, 반영 대기·주기·포커스·실패·늦은 응답·리셋. `__tests__/swap/quote-button.test.tsx` — 신규, 주 버튼 견적 상태. `__tests__/support/rpc-balance-stub.ts` — 추가만, QuoterV2 대상 aggregate3를 새 분류로 받아 하위 `quoteExactInputSingle`·`slot0`을 디코드해 응답하는 규칙과 기본 성공 규칙, 실패·붙잡기. `__tests__/support/wagmi-harness.tsx` — 대기 헬퍼 추가만
- 따라야 할 패턴: 앱 전체 렌더 하네스, fetch URL 라우팅 스텁, JSON-RPC 항목 단위 집계, 15초 판정은 setInterval 계열만 가짜로 두는 방식 — 근거: `__tests__/support/wagmi-harness.tsx`, `__tests__/support/rpc-balance-stub.ts`, `docs/plans/token-amount-input.md` T-6 구현 기록
- 완료 조건: 연결 항목 판정, DoD-1은 aggregate3 호출 데이터를 디코드해 선택 체인 QuoterV2 주소와 네 티어 확인, DoD-8은 입력 반영 1회당 견적 JSON-RPC 항목 수, EC-12는 이전 입력 응답을 붙잡았다가 입력을 바꾼 뒤 풀어서 판정, EC-11은 실패 뒤 다음 주기 전까지 같은 입력 요청 0건, 스텁의 풀 주소 매핑은 제품 함수를 쓰지 않고 따로 계산, DoD-28은 탭을 숨긴 뒤 15초가 지나도 견적 요청이 없음을 요청 수로 판정, DoD-11은 스텁 고정 수령량에 대한 기대 문자열 리터럴과 받는 칸 값을 비교 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap`
- 수정 금지: 제품 코드, F1 테스트 파일, F2 테스트 파일
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/quote-read.test.tsx`·`quote-display.test.tsx`·`quote-refresh.test.tsx`·`quote-button.test.tsx`, `__tests__/support/rpc-balance-stub.ts`(견적 분류 `quote`·`setQuoteRule`·`failQuoteWhen`·`holdQuote`, 테스트 쪽 CREATE2 `stubPoolAddress`, 기본 성공 규칙 `defaultQuoteRule`, 매처 `matchQuote`; 기존 `hold`·`failWhen`은 견적 외 요청에만 적용되도록 범위 지정, 기존 분류·export 불변), `__tests__/support/wagmi-harness.tsx`(`waitUntilAdvancingFakeClock` 추가). 수정 0/3(사용량 한도로 1회 중단 후 같은 에이전트 재개, 수정 횟수 아님). 완성 33 case. 오케스트레이터 확인: 골자 유지, 새 통합 33/33 통과, 전체 `bun run test` 173 통과·4 실패(F2 `primary-button.test.tsx`의 `input-valid` 기대, T-9 소관)
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: (사용자 확정) F2 T-6 경계(실제 wagmi·Provider·화면, mock 커넥터 또는 스텁 EIP-1193, 전역 fetch URL 라우팅 스텁, 가짜 타이머와 DOM 이벤트, `vi.mock` 금지)에 견적 aggregate3 스텁 응답을 더한다. DoD-28에 한해 `document.visibilityState` 스텁과 `visibilitychange` 발생을 허용한다. 판정 예외: DoD-11에 한해 받는 칸 값을 스텁 고정 수령량에 대한 기대 문자열 리터럴과 비교한다(제품 함수로 기대값을 만들지 않는다). 그 밖의 문구 판정은 금지한다. DoD-18(색)은 자동 테스트에서 제외한다
- 데이터 격리: 테스트마다 config 새로 생성과 스텁 초기화, `clearCookies`, QueryClient는 렌더마다 새로 생성

### T-7 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 실제 anvil 포크에서 프록시를 거친 견적이 티어별 직접 호출 결과와 같고, 풀 없는 페어가 `no-route`임을 검증한다
- 선행: T-1, T-3
- 연결 항목: DoD-5, EC-4
- 수정 대상: `__tests__/fork/swap-quote.fork.test.ts` — 신규
- 따라야 할 패턴: viem `http` transport의 `fetchFn`을 프록시 핸들러에 연결, `vi.stubEnv`, 판정과 분리한 anvil 직접 사전 읽기 — 근거: `__tests__/fork/token-balances.fork.test.ts`
- 완료 조건: 연결 항목 판정, 기대값은 anvil에 QuoterV2를 티어별로 직접 호출한 결과에서 고름, 고정 블록 값과 같아 공개 RPC fallback이 아님을 보임, EC-4 표본은 T-1 (1) 결과 — 검증: 테스트
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드, 기존 `__tests__/fork/` 파일
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/fork/swap-quote.fork.test.ts`. 수정 0/3. 완성 2 case. 기대값은 `beforeAll`에서 anvil 직접 티어별 `simulateContract`(블록 고정)와 테스트 내 선택 규칙, 주소·ABI·한계값 리터럴, 판정은 `planSwapQuote`+`readSwapQuote`를 프록시 경유 클라이언트로. 예열 hook 120초. 오케스트레이터 확인: 골자 유지, `bun run test:fork` 8/8 통과(기존 6 포함), 포트 정리
- 테스트 파일·runner: 수정 대상의 파일, `vitest.fork.config.mts`
- mock 허용 경계: (사용자 확정) 없음(실제 anvil 포크와 프록시 코드, `vi.stubEnv`만). 판정 대상 호출과 분리한 anvil 직접 읽기는 허용
- 데이터 격리: 읽기 전용 호출, 전용 포트 8547

### T-8 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 실제 브라우저·프록시·anvil에서 ETH→USDC 견적 표시, 풀 없는 페어, ETH ↔ WETH, 주 버튼을 검증한다
- 선행: T-4, T-9
- 연결 항목: DoD-11, DoD-12, DoD-33, DoD-35, DoD-36, EC-4, EC-6
- 수정 대상: `e2e/quote.spec.ts` — 신규. `e2e/support/quote.ts` — 신규, 견적 locator. `e2e/support/anvil.ts` — 추가만, 러너의 견적 경로 예열과 티어별 직접 견적 읽기
- 따라야 할 패턴: mock 커넥터 연결, 절대값 주입, 감시만 하는 네트워크(`page.route` 금지) — 근거: `e2e/support/app.ts`, `e2e/support/anvil.ts`, `e2e/support/network.ts`
- 완료 조건: 연결 항목 판정, `data-amount-out-raw`는 러너가 anvil에서 직접 고른 값과 같음, EC-6은 브라우저가 보낸 프록시 요청 중 QuoterV2 호출 0건, EC-4·DoD-33은 T-1 페어에 보내는 토큰을 주입해 잔액 부족이 앞서지 않게 판정 — 검증: 테스트
- 실행 명령: `bun run test:e2e e2e/quote.spec.ts`
- 수정 금지: 제품 코드, F1·F2 E2E 파일
- 구현 기록: seongho:e2e-dev(골격 작성 에이전트, 살 모드), 작성 영역 `e2e/quote.spec.ts`(3 case), `e2e/support/quote.ts`(신규 locator), `e2e/support/anvil.ts`(추가: `QUOTER_V2_ADDRESS`, `quoteEachTierDirectly`, `warmUpSwapQuote`, `QUOTE_WARM_UP_TIMEOUT_MS`). 수정 0/3. EC-4 표본 DAI→PENDLE(DAI 1000 절대값 주입), EC-6은 프록시 요청 감시 후 3,000ms 고정 대기 뒤 QuoterV2 호출 0건 판정, `beforeAll`에서 `warmUpTokenBalances`와 두 페어 견적 경로 예열(hook 시간 제한만 연장). 오케스트레이터 확인: 골자 유지, `bun run test:e2e` 23/23 통과(1.3m), 포트 정리
- 테스트 파일·runner: 수정 대상의 파일, Playwright chromium
- mock 허용 경계: (사용자 확정) F2 T-8 경계(mock 커넥터와 E2E 전용 제어값, 러너→anvil 상태 주입·조회, `page.route` 금지, 앱 코드에 E2E 제어값 추가 금지)에 러너→anvil 견적 경로 예열을 더한다. cold 지연이 5초를 넘으면 그 hook의 시간 제한만 늘린다
- 데이터 격리: 테스트별 브라우저 컨텍스트, 절대값 주입, F1·F2와 겹치지 않는 주입 토큰, 파일 안 순차 실행, snapshot/revert 미도입
- 실행 환경: 앱 `localhost:3100`, anvil `localhost:8546`, 포크 블록과 mock 계정은 `config/e2e.ts`·`config/e2e-mock.ts` 상수, 로그인 없음, Base·Arbitrum 대상 외

### T-9 — F2 회귀 갱신

- 사이드: 테스트
- 상태: 완료
- 목적: F2 테스트·헬퍼의 주 버튼 `input-valid` 기대를 견적 상태로 바꾼다
- 선행: T-4, T-6
- 연결 항목: DoD-38
- 수정 대상: `__tests__/swap/primary-button.test.tsx`, `__tests__/swap/balances.test.tsx`, `__tests__/wallet/restore.test.tsx`, `e2e/support/app.ts`, `e2e/swap-form.spec.ts` — 주 버튼 `input-valid` 기대만
- 따라야 할 패턴: 동결 골격은 assertion만 바꾸되, 사용자 결정에 따라 it 이름과 `@then`의 `input-valid`도 바꾸고 바뀐 F2 골자 digest를 기록한다 — 근거: `docs/plans/token-amount-input.md` T-9
- 완료 조건: 연결 항목 충족, 주 버튼 `data-state`에 대한 `input-valid` 기대 0건, 통합 테스트의 기대는 `quote-ready`(스텁 기본 성공), E2E의 기대는 견적 상태 4종 중 하나(사용자 결정), `__tests__/lib/swap-input-state.test.ts`의 `input-valid`(순수 함수 반환값)는 유지, `__tests__/swap/swap-form-state.test.tsx`의 "미연결 RPC 요청 없음" 전제가 견적과 충돌하지 않는지 확인해 기록, jsdom 테스트 3회 반복 결과 동일 — 검증: 명령
- 실행 명령: `bun run test __tests__/swap __tests__/wallet __tests__/lib`, `bun run test:e2e e2e/swap-form.spec.ts e2e/wallet.spec.ts`
- 수정 금지: 제품 코드, F3 신규 테스트 파일, `__tests__/lib/swap-input-state.test.ts`
- 구현 기록: Vitest 부분 seongho:test-dev(`primary-button.test.tsx` DoD-38은 표본 금액별 견적 응답 후 `quote-ready`, EC-25·EC-11은 `quote-ready` 대기 후 `insufficient-balance` 아님, `CONNECTED_STATES` 3곳을 연결 상태 7종으로), E2E 부분 seongho:e2e-dev(`e2e/support/app.ts` `QUOTE_PRIMARY_STATE`·`CONNECTED_PRIMARY_STATE`·`settled` 정규식, `e2e/swap-form.spec.ts` DoD-38 assertion). 수정 0/3. `swap-form-state.test.tsx:20` 주석은 잔액 요청만 말해 견적과 충돌 없음(요청 수 판정 없음). 오케스트레이터 확인: F2 골자 `f2932cf895687551` 유지, `bun run test` 177/177 3회 반복 동일, `bun run test:e2e` 23/23, `input-valid` 기대 0건(`swap-input-state.test.ts` 순수 함수 반환값 제외)
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom과 Playwright chromium
- mock 허용 경계: (사용자 확정) F2에서 확정한 경계 그대로, 견적 응답은 T-6 스텁의 기본 규칙
- 데이터 격리: F2와 같음
- 실행 환경: T-8과 같음

### T-10 — 수동 확인과 전체 검사

- 사이드: 검증
- 상태: 진행
- 목적: Base·Arbitrum 수동 항목, 전체 명령, 시안·README 포함 여부를 마무리한다
- 선행: T-5, T-6, T-7, T-8, T-9
- 연결 항목: DoD-9, DoD-10, DoD-18, DoD-38, DoD-39
- 수정 대상: 없음 — 수동 확인 결과는 PR 본문에 기록, 시안 PNG와 README는 9단계 커밋에 포함
- 따라야 할 패턴: F2 수동 확인 기록 — 근거: `docs/plans/token-amount-input.md` T-10
- 완료 조건: Base·Arbitrum 메인넷에서 ETH→USDC 견적 표시를 확인해 날짜·블록·티어·수령량·가격 영향·등급 기록(미연결로도 가능), 가격 영향 세 등급의 화면 색을 시안과 한 번 대조해 기록(DoD-18, 등급 표본은 E2E 앱이나 개발 서버에서 금액으로 만든다), 전체 명령 통과, 수정 PNG 6개와 `docs/design/README.md`가 변경 대상에 포함되고 `format:check` 통과 — 검증: 확인 절차와 명령
- 실행 명령: `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: 오케스트레이터 기록. 전체 명령은 7단계 test-runner·e2e-runner가 통과로 확인(검증 기록 참고). DoD-39는 9단계 커밋에 시안 PNG 6개·`docs/design/README.md`를 포함해 충족. DoD-9·DoD-10(Base·Arbitrum 메인넷 견적)과 DoD-18(가격 영향 세 등급의 화면 색 대조)은 2026-11-13 사용자 결정으로 미실시인 채 커밋, 수동 확인 대기

## 3. 항목 coverage

- DoD-1: T-3, T-6
- DoD-2: T-2, T-5
- DoD-3: T-2, T-5
- DoD-4: T-2, T-3, T-5
- DoD-5: T-1, T-3, T-7
- DoD-6: T-3, T-6
- DoD-7: T-3, T-4, T-6
- DoD-8: T-1, T-3, T-6
- DoD-9: T-1, T-10 (수동 1회 기록)
- DoD-10: T-1, T-10 (수동 1회 기록)
- DoD-11: T-4, T-6, T-8
- DoD-12: T-4, T-6, T-8
- DoD-13: T-4, T-6
- DoD-14: T-4, T-6
- DoD-15: T-4, T-6
- DoD-16: T-1, T-2, T-5
- DoD-17: T-2, T-4, T-5, T-6
- DoD-18: T-4, T-10 (자동 테스트 제외, 사용자 확정: 7단계 등급→색 토큰 코드 대조와 화면 수동 대조)
- DoD-19: T-2, T-5
- DoD-20: T-2, T-5
- DoD-21: T-2, T-5
- DoD-22: T-2, T-5
- DoD-23: T-2, T-5
- DoD-24: T-2, T-5
- DoD-25: T-3, T-6
- DoD-26: T-3, T-6
- DoD-27: T-3, T-6
- DoD-28: T-3, T-6 (사용자 확정: visibility 스텁으로 자동 판정)
- DoD-29: T-3, T-6
- DoD-30: T-3, T-6
- DoD-31: T-2, T-4, T-6
- DoD-32: T-2, T-4, T-6
- DoD-33: T-2, T-4, T-6, T-8
- DoD-34: T-2, T-4, T-6
- DoD-35: T-2, T-4, T-6, T-8
- DoD-36: T-2, T-4, T-6, T-8
- DoD-37: T-3, T-6
- DoD-38: T-9, T-10
- DoD-39: T-10
- DoD-40: T-4, T-6
- DoD-41: T-3, T-6
- EC-1: T-2, T-5
- EC-2: T-2, T-5
- EC-3: T-1, T-2, T-5
- EC-4: T-1, T-2, T-5, T-7, T-8
- EC-5: T-4, T-6
- EC-6: T-2, T-3, T-5, T-6, T-8
- EC-7: T-3, T-6
- EC-8: T-4, T-6
- EC-9: T-3, T-6
- EC-10: T-3, T-6
- EC-11: T-3, T-6
- EC-12: T-3, T-6
- EC-13: T-3, T-6
- EC-14: T-3, T-6
- EC-15: T-1, T-2, T-4, T-6
- EC-16: T-3, T-6

## 4. 실행 순서

- 1구간(병렬): T-1, T-2. T-1은 저장소를 수정하지 않는다
- 2구간(병렬): T-3, T-5. T-3은 `lib/read-swap-quote.ts`, `lib/token-balances.ts`, `hooks/`, `providers/`만, T-5는 `__tests__/lib/`의 신규 파일만 수정한다
- 3구간(병렬): T-4, T-7. T-4는 `components/`·`app/globals.css`, T-7은 `__tests__/fork/` 신규 파일만 수정한다
- 4구간(순차): T-6 (T-4 이후)
- 5구간(순차): T-9 (T-6의 스텁 견적 분류와 기본 규칙 이후)
- 6구간(순차): T-8 (T-9 이후, `test:e2e`가 포트 3100·8546을 독점하므로 T-9의 E2E 실행과 겹치지 않게 한다)
- 7구간(순차): T-10

## 5. 차단 사항

- 없음. T-1 (1)·(2) 결과가 스펙 확인 사실과 어긋나면 인터뷰로 되돌린다

## 테스트 설계 증거

- 상태: 예외 동결 (사용자 승인, 2026-11-12). 전체 검토 3회 안에 수렴하지 못해 `REVIEW-BLOCKED`, 사용자 결정으로 전체 검토 2회(4·5회차)를 더 한 뒤 수정 부분 한정 검토 1회 PASS로 동결했다
- 기준 스펙: `docs/specs/quote.md` (상태 확정). 테스트 설계 중 스펙 보완: DoD-18 검증(코드 대조·수동 화면 대조), DoD-24 검증(단위 테스트는 결과의 로캘 무관, 로캘 API 미사용은 코드 대조), DoD-28 검증(visibility 스텁)
- 골자 digest: `8acf896e2a4dffdd`
- 동결 확인 명령: `check-skeleton.py --spec docs/specs/quote.md --files (아래 골격 파일) --exempt DoD-9,DoD-10,DoD-18,DoD-38,DoD-39 --frozen 8acf896e2a4dffdd`
- 골격 파일: `__tests__/lib/swap-quote.test.ts`, `__tests__/lib/quote-format.test.ts`, `__tests__/swap/quote-read.test.tsx`, `__tests__/swap/quote-display.test.tsx`, `__tests__/swap/quote-refresh.test.tsx`, `__tests__/swap/quote-button.test.tsx`, `__tests__/fork/swap-quote.fork.test.ts`, `e2e/quote.spec.ts`
- 기계 검사: 통과. 항목 57개 중 case 연결 52개, 제외 5개, case 57개(단위 19, 통합 33, 포크 2, E2E 3). 모두 `it.todo`·`test.fixme`
- F2 골격 갱신(T-9, 사용자 결정): `__tests__/swap/primary-button.test.tsx`의 `@then` 4줄·it 이름 1개, `e2e/swap-form.spec.ts`의 `@then` 1줄·test 이름 1개에서 주 버튼 `input-valid`를 통합 `quote-ready`, E2E "견적 상태 4종 중 하나"로 바꿨다. 본문 assertion은 T-9 구현 단계. F2 골자 digest `20d4ec1b40c60752` → `f2932cf895687551`(F2 동결 확인 명령의 `--frozen` 값을 이 값으로 읽는다)
- reviewer: 매 회 새 general-purpose 에이전트, 검토 전후 내용 해시 일치. 1회차 `NEEDS-FIX` 12건(Med 6·Low 6), 2회차 `NEEDS-DECISION` 8건(DoD-24 검증 방식 사용자 결정), 3회차 `NEEDS-FIX` 3건, 4회차 `NEEDS-FIX` 2건(High 1: Ethereum ETH→USDC 표본만으로는 WETH 치환 전 주소로 방향을 정하는 버그를 못 잡음 → DoD-1 세 체인 표본에 가격 영향 판정 추가), 5회차 `NEEDS-FIX` 2건(받는 쪽 ETH 치환, idle 즉시성), 한정 검토 PASS
- 계획 갱신(테스트 설계 중): T-6 연결 항목에 EC-6 추가, DoD-18을 T-6에서 빼고 T-10에 연결, T-10 수동 기록에 가격 영향·등급 추가, 테스트 Task mock 경계를 사용자 확정으로 갱신
- 제외 (사용자 확정): DoD-9·DoD-10(T-10 Base·Arbitrum 메인넷 수동 1회 기록), DoD-18(7단계 등급→색 토큰 코드 대조와 T-10 화면 수동 대조), DoD-38·DoD-39(T-9·T-10 명령 실행 확인)
- mock 경계 (사용자 확정): T-5 없음, 단 DoD-24 한정 `de-DE` 로캘 기본값 스텁. T-6 F2 경계(실제 wagmi·Provider·화면, mock 커넥터·스텁 EIP-1193, 전역 fetch URL 라우팅 스텁, 가짜 타이머와 DOM 이벤트, `vi.mock` 금지)에 견적 aggregate3 스텁 응답, DoD-28 한정 visibility 스텁, DoD-11 한정 기대 문자열 리터럴 판정. T-7 없음(`vi.stubEnv`, 판정과 분리한 anvil 직접 읽기). T-8 F2 경계에 러너→anvil 견적 경로 예열(cold 지연이 5초를 넘으면 그 hook 시간 제한만 연장), `page.route` 금지. T-9 F2 경계 그대로, 견적은 T-6 스텁 기본 성공
- 미검증 (경계의 한계): Base·Arbitrum 실제 연동(주소, CREATE2 풀 주소, RPC)은 T-1과 수동 DoD-9·10뿐, 실제 체인의 가격 영향 값은 포크·E2E가 판정하지 않고 수동 기록뿐, 실제 RPC 실패 경로(프록시 502와 viem 재시도), 실제 브라우저 탭 숨김·포커스, F2 E2E DoD-38은 `quote-error`도 통과로 봄
- 7단계 코드 대조: 화면 문구 배선(환율·가격 영향·티어 문자열이 `lib/quote-format.ts` 결과를 쓰는지), 등급→색 토큰(DoD-18), 로캘 API 미사용(DoD-24), 모든 견적 읽기의 선택 체인 `chainId` 명시
- 본문 작성 지시:
  - 통합 스텁은 견적 aggregate3(QuoterV2 하위 호출 포함)를 잔액 aggregate3와 분리해 분류하고, 분류가 되는지 양성 대조를 둔다. F2 테스트가 잔액 읽기를 실패시키거나 붙잡을 때 견적까지 영향받지 않게 한다
  - 실패 응답은 transport 재시도 대상이 아닌 JSON-RPC 오류(-32000 등)
  - 풀 주소·QuoterV2·WETH·USDC 주소 기대값은 제품 config·함수를 쓰지 않고 리터럴이나 테스트 쪽 계산으로 만든다
  - DoD-8·EC-6의 요청 수는 잔액 읽기가 아닌 모든 JSON-RPC 항목을 센다. 하네스 잡음(`eth_chainId` 등)으로 실패하면 테스트에서 빼지 말고 결정으로 되돌린다
  - 정수가 아닌 기대값(DoD-16의 0.865·7.35·32.5 등)은 좁은 허용 오차로 비교한다
  - 가짜 타이머 사용 case는 visibility 스텁 시 `document.hidden`도 함께 맞춘다
  - EC-4 포크·E2E 표본 페어는 T-1 (1) 결과를 쓴다
- 주의: 단위 골격 작성 중 에이전트가 실행 금지를 어기고 `vitest list --json`으로 골격 파일 하나를 덮어썼다가 같은 내용으로 복구했다. 최종본은 이후 전체 검토 4회와 한정 검토 1회를 거쳤다

### 검증 기록

- 코드 기준: `5ff5549` + 커밋 전 작업 트리(내용 해시 `0ae1163aae7d62f753eae44bc07880856f99fc1a`, 2026-11-13). 세 검증 모두 시작·끝 해시 일치, 검증 중 파일 변경 없음
- 실행(test-runner): format·lint·typecheck·build·check:build 통과, `bun run test` 177/177 3회 반복 동일(F3 단위 19, 통합 33 포함), `bun run test:fork` 8/8(F3 2 포함). 포트·프로세스 잔존 없음
- 실행(e2e-runner): `bun run test:e2e` 23/23(F3 3, F2 10, F1 10), 재시도 0
- 스펙 대조(verify): 57개 중 충족 52, 검증 불가 5(DoD-9·10·18 수동, DoD-38·39 명령·커밋), 미충족 0. 골자 F3 `8acf896e2a4dffdd`·F2 `f2932cf895687551` 유지, 스코프 초과·드리프트 없음. 7단계 코드 대조 4건(문구 배선, 등급→색 토큰, 로캘 API 미사용, 선택 체인 `chainId`) 이상 없음

| 스펙 항목                       | 코드 대조                                                  | 실행 확인                      | 종합                                            |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------ | ----------------------------------------------- |
| DoD-1~~8, 11~~17, 19~37, 40, 41 | 충족                                                       | 확인됨 (단위·통합·포크·E2E)    | 충족                                            |
| EC-1~16                         | 충족                                                       | 확인됨 (단위·통합·포크·E2E)    | 충족                                            |
| DoD-38                          | 충족(`input-valid` 기대 제거, F2 골자 유지)                | 확인됨 (`test` ×3, `test:e2e`) | 충족                                            |
| DoD-39                          | 검증 불가(커밋 전)                                         | `format:check` 통과            | 미검증 (9단계 커밋에 시안 PNG·README 포함 필요) |
| DoD-9, DoD-10                   | 검증 불가(코드 경로 동일, 주소 config 확인)                | 미실행 (T-10 수동)             | 미검증                                          |
| DoD-18                          | 코드 대조 부분 충족(등급→`--accent`/`--warning`/`--error`) | 미실행 (T-10 화면 수동 대조)   | 미검증                                          |

- 스펙이 정하지 않은 경우(verify Low 2건, T-1 (5) 사실과 같은 원인): (1) 하위 호출이 가스 부족 등 revert 외 원인으로 실패해도 EC-1처럼 그 티어를 후보에서 뺀다(50M 상한 노드에서 1e5 ETH 이상) (2) 유동성 소진 금액은 60M 이하 상한 노드에서 aggregate3 전체가 가스 부족으로 실패해 EC-3·EC-4의 `no-route` 대신 `error`가 된다. 8단계 사용자 결정(2026-11-13): 코드 변경 없이 스펙 비목표에 알려진 한계로 기록
- 관찰(e2e-runner): E2E EC-4 사전 확인은 "네 티어 모두 revert"가 아니라 "후보 없음"으로 확인한다. 판정(`no-route`)에는 영향 없음
