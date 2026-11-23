# 계획: network-fee

- 상태: 승인
- 스펙: docs/specs/network-fee.md
- 기준 코드: 523f938 + 작업 트리 (branch feat/network-fee)
- 최종 갱신: 2026-11-23

## 1. 구현 전략

- 순서: 사전 확인 → config·lib 순수 함수 → 읽기 함수 → 훅·provider → 화면 → 테스트(단위, 스텁 확장과 통합, 포크) → 기존 테스트 회귀 확인과 §4.5 회귀 갱신 → E2E → 전체 검사. 근거: `docs/plans/usd-price.md:10`
- provider 위치: 새 `providers/network-fee-provider.tsx`(`NetworkFeeProvider`, `useNetworkFee()`)를 `app-providers.tsx`에서 `SwapExecutionProvider` 바로 안쪽에 마운트한다. 주 버튼 상태는 `PrimaryButton`과 같은 입력(`useWalletRestore().status`, `useSwapExecution().phase`, `useSwapForm()`, `useSwapFormBalances().in`, `useSwapQuote()`, `useAmountOutMinimum()`, `useTokenAllowance()`)으로 `getPrimaryButtonState(getPrimaryButtonStateParams(...))`를 다시 계산해 F5·F6·F7 훅 계약과 `lib/primary-button-state.ts`를 바꾸지 않는다. 주 버튼 상태 → kind 매핑은 lib 순수 함수로 두고, 네 상태 밖과 phase 진행 중은 `idle`이다. 근거: `components/primary-button.tsx:91-103`, `providers/swap-execution-provider.tsx:163-175,537-541`, `providers/app-providers.tsx:31-42`
- 요청 조립: `lib/network-fee.ts`의 순수 함수 `buildNetworkFeeTxRequest`가 기존 함수로 `{to, data, value}`를 만든다. approve는 `buildApproveRequest` + `encodeApproveCalldata`(USDT 초기화는 `getApproveAmount`가 `0n`), swap은 `buildSwapTransactionRequest` + `encodeSwapTransactionCalldata`, wrap·unwrap은 `buildWrapRequest`·`buildUnwrapRequest` + `encodeWethCalldata`다. `lib/swap-transaction.ts`는 바꾸지 않는다. 근거: `lib/swap-transaction.ts:38,61,72,231,266,296,308,320`
- 추정 쿼리: 키 `["network-fee-estimate", chainId, account, kind, tokenIn, tokenOut, feeTier|null, amountInRaw 문자열, approveAmount 문자열|null]`(bigint 없음). queryFn은 fetch 시점 최신 값(최소 수령량, allowance, `getSwapDeadline(Date.now())`)을 `latestRef`로 읽어 calldata를 만든다. `retry: false`, `refetchInterval` 없음, `refetchOnWindowFocus`·`refetchOnReconnect: false`, `staleTime: 0`(이전 키 복귀 시 다시 추정), `placeholderData` 없음. 늦게 온 응답은 이전 키 캐시에만 쓰인다. 근거: `providers/swap-execution-provider.tsx:177-195`, `hooks/use-swap-quote-read.ts:87-88`
- gasPrice 쿼리: 키 `["network-fee-gas-price", chainId]`, `refetchInterval`·`staleTime`은 `GAS_PRICE_REFETCH_MS`, `refetchIntervalInBackground: false`, 포커스 갱신·리스너 없음, `retry: false`, `enabled`는 kind ≠ idle. 상태는 data를 먼저 봐서 갱신 실패 때 마지막 값이 남는다. 근거: `hooks/use-token-usd-price.ts:97-104`
- 읽기 함수: 새 `lib/read-network-fee.ts`. `lib/read-token-usd-price.ts`의 `withoutRetry`에 `export`만 붙여 재시도·multicall batch를 끈 클라이언트 사본을 재사용한다. 추정은 viem `estimateGas(client, { account, to, data, value })`를 fee·gas 필드 없이(prepare 파라미터 최소), 가스 가격은 `getGasPrice`, L1은 `viem/op-stack` `estimateL1Fee`(GasPriceOracle `getL1Fee` eth_call 1건)다. `estimateTotalFee`·`prepareTransactionRequest`는 쓰지 않는다. 요청 형태는 T-1 (5)에서 센다. 근거: `lib/read-token-usd-price.ts:39-49`, `node_modules/viem/actions/public/estimateGas.ts:114-232`, `node_modules/viem/op-stack/actions/estimateL1Fee.ts`
- Base L1 경로: `HAS_L1_DATA_FEE_BY_CHAIN`이 참인 체인에서만 추정 queryFn 안에서 `eth_estimateGas` 성공 뒤 `getL1Fee`를 보내 `{ gas, l1Fee }`로 키 단위 저장한다. 주기 갱신은 없다. L1 실패는 추정 전체 실패다. config는 `mainnet.id`·`base.id`·`arbitrum.id` 키 레코드로 두고 숫자 리터럴을 쓰지 않는다. 근거: `config/gas-reserve.ts:1-11`
- ETH 잔액: 한쪽 토큰이 ETH면 그 칸의 `useSwapFormBalances()` 값을 쓰고 쿼리 observer를 만들지 않는다. 양쪽 모두 ETH가 아니면 `getCardBalanceQueryKey(chainId, account, NATIVE_ETH_ADDRESS)` 키에 `readTokenBalance` queryFn, `refetchInterval: GAS_PRICE_REFETCH_MS`, 포커스 갱신 없음, `retry: false`, `enabled`는 kind ≠ idle이다. `hooks/use-token-balance.ts`는 바꾸지 않는다. 근거: `hooks/use-token-balance.ts:23-61`, `providers/swap-execution-provider.tsx:222-247`
- ETH 단가: 보내는·받는 칸의 단가 주소가 WETH(ETH·WETH)면 `useSwapUsdPrices()`의 in/out 상태를 쓰고, 그 밖에는 provider 안에서 `useTokenUsdPrice(chainId, active ? NATIVE_ETH_ADDRESS : undefined)`를 한 번만 부른다. 근거: `providers/swap-usd-price-provider.tsx:28-41`, `hooks/use-token-usd-price.ts:42-44,91-127`
- 상태 조립: idle → (추정 data && gasPrice data) success → (추정 오류 || gasPrice 오류) error → loading. `feeWei = gas × gasPrice + (l1Fee ?? 0)`, `usdMicros`는 ETH 단가 success일 때 `toUsdMicros`, severity 입력의 `isEthLikeIn`은 `isNativeToken`·WETH 판정, `amountInUsdMicros`는 in 단가 success일 때. `ethShortage`는 loading·error에서도 `feeWei: null`로 계산한다. 근거: `lib/token-usd-price.ts:33`, `lib/token-amount.ts:90`
- 화면: 새 `components/network-fee.tsx`를 `swap-card.tsx`의 `QuoteDetails`와 `PrimaryButton` 사이에 둔다. `dt/dd` 행, 값은 `formatEthFee` + ` ETH` + 단가가 있을 때 ` · formatUsd`. 로딩은 `UsdSkeleton`과 같은 스타일의 새 `network-fee-skeleton`(F9 `usd-skeleton` 비사용), 오류는 `role="img"`·접근성 이름이 있는 `—`. 경고 줄은 `text-warning`. `InlineUsd`·`quote-skeleton`은 쓰지 않는다. 근거: `components/swap-card.tsx:28-30`, `components/usd-value.tsx:13-24,78-82`, `components/quote-details.tsx:43-61`
- RPC 요청 수 산정(WAF 120건/60초/IP). 조건은 연결, 두 토큰, 금액 입력, `swap-ready`, 탭 보임, HTTP 1요청 = JSON-RPC 1건. 근거: `docs/plans/usd-price.md:29-34`
  - 평시 60초: 기존 16 + F10(gasPrice 1 + ETH 잔액 1(양쪽 ETH 아님) + ETH 단가 최대 1(양쪽 ETH·WETH 아님, F9 단건 훅)) = 최대 19. L1은 키 단위라 0
  - 포커스 1회: 기존 8 + ETH 단가 focus 리스너 최대 1 = 9
  - 입력 변경 1회: 추정 1(Base는 + L1 1)
  - 최악(F9 시나리오: 모달 1회 + 포커스 1회): 115 + 3 + 1 = 119 ≤ 120
- 동결 테스트 영향: 스펙 §4.5가 정한 세 case(`quote-read` `[EC-6]` `:558`·`[DoD-8]` `:596`, `native-eth-wrap-quote` `[DoD-14]` `:328`)는 T-13에서 집계 대상만 좁힌다. 그 밖의 위험 후보(`usd-price-refresh` 단가 요청 집계 `:699`, `swap-execution-progress` `[EC-10]` 잔액 집계 `:889-960`, `balances.test.tsx`의 `eth_getBalance` 집계, F6 approve 뒤 잔액 요청 집계, E2E `quote.spec.ts [EC-6]`·`usd-price.spec.ts` 모달 흐름)는 T-1 (8)에서 목록으로 만들고 T-12에서 고치지 않고 실행한다. 새로 깨지는 case는 스펙 §4.5 절차대로 보고 후 승인을 받는다
- 테스트 지원 확장: `__tests__/support/rpc-balance-stub.ts`는 T-8 하나가 "추가만"으로 맡는다. 분류 `estimate-gas`(`{from,to,data,value}` 디코드), `gas-price`, `l1-fee`(GasPriceOracle 대상 `getL1Fee(bytes)` eth_call, 단가·견적·aggregate3 판정보다 먼저, bytes 인자 기록과 직렬화 tx 디코드), 기본 성공 응답(리터럴 상수), 규칙 `setNetworkFeeRule`, 실패 `failEstimateGasWhen`·`failGasPriceWhen`·`failL1FeeWhen`, revert 응답(code 3, data `0x`), 수수료 3분류 HTTP 429 응답, 붙잡기 `holdEstimateGas`·`holdGasPrice`·`holdL1Fee`, 매처 `matchNetworkFee.*`를 더한다. 기존 분류·export·`notBalance` 의미는 바꾸지 않는다. 근거: `__tests__/support/rpc-balance-stub.ts:39-49,1265-1340,1479,1566`
- E2E·포크 cold 상태: 추정 지연이 프록시 5초를 넘으면 러너가 anvil에 같은 추정을 미리 보내 예열한다(T-1 (6)). 근거: `config/rpc.ts:28`, `e2e/support/anvil.ts:118,173`
- mock 경계는 F9 경계(실제 wagmi·Provider·화면, mock 커넥터·스텁 EIP-1193 지갑, 전역 fetch URL 라우팅 스텁, 가짜 타이머, `vi.mock` 금지)에 수수료 3분류 스텁(응답·revert·실패·붙잡기·HTTP 429)과 E2E 추정 예열을 더한 것이다 (사용자 확정 2026-11-22)

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: 추정 요청 형태, 포크 실측, L1 경로, anvil gasPrice 안정성, 기존 테스트 노출을 저장소 밖에서 확인한다
- 선행: 없음
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-6, DoD-8, DoD-9, DoD-40, DoD-42, DoD-43, DoD-44, DoD-45, EC-1, EC-14, EC-21
- 수정 대상: 없음. 저장소 밖 `/root/study/.pipeline-scratch/network-fee/t1/`에서 전용 포트 8557(고정 블록 26250000 포크)·8558(`--block-time 1` 포크)과 Base·Arbitrum 공개 읽기 RPC로 확인한다
- 따라야 할 패턴: 저장소 밖에서 확인하고 결과는 구현 기록에 남긴다 — 근거: `docs/plans/usd-price.md:50`
- 완료 조건: 아래 결과를 기록하고, 스펙과 어긋나면 인터뷰로 되돌린다 — 검증: 확인 절차
  - (1) 포크에서 프로젝트 인코딩 그대로 approve, ERC-20 스왑(allowance 충분), ETH 입력, ETH 출력, wrap, unwrap 6종의 `eth_estimateGas` gas 값을 코드 없는 새 주소(`anvil_setBalance`·`anvil_dealERC20`)와 7702 위임 계정(`0xf39F…`)에서 각각 기록한다
  - (2) allowance 0 계정의 ERC-20 스왑 추정 revert 형태를 기록한다
  - (3) Ethereum USDT 부분 allowance에서 `approve(0)` 추정 성공과 체결 뒤 `approve(max)` 추정 성공을 확인한다
  - (4) ETH 잔액 0 계정과 value > 잔액 계정에서 fee 필드 없는 추정 결과를 anvil·Base·Arbitrum 공개 RPC에서 비교한다
  - (5) viem 2.57.16 요청 형태를 로컬 HTTP 서버로 센다: `estimateGas` 1건(본문 `from/to/data/value`만), `getGasPrice` 1건, `estimateL1Fee` eth_call 1건(multicall 미결합), `withoutRetry` 사본으로 429·500·연결 끊김에서 각 1건
  - (6) cold 포크 추정 지연을 프록시 5초와 비교한다
  - (7) `--block-time 1` anvil에서 `eth_gasPrice`가 블록마다 바뀌는지 기록한다(E2E 대기 조건 자료, DoD-42 정확 일치 비교는 하지 않기로 확정)
  - (8) 연결 + 네 상태에 들어가며 `matchQuote.notBalance`·`fetchStub.calls()`·`match.kind`·`usd-skeleton` 전역 수·단가·잔액 집계를 쓰는 기존 case 목록, `-32601`에 기대는 기존 case 유무, E2E 프록시 집계 case를 정적으로 확인한다
  - (9) Base 공개 RPC에서 USDC approve·스왑 calldata의 `estimateL1Fee` 결과와 gas × gasPrice 대비 비율, `base.contracts.gasPriceOracle` 주소를 기록한다
  - (10) TanStack 5.106에서 `staleTime 0` 캐시 키 복귀 fetch, `enabled` false→true fetch, 오류 뒤 주기 타이머 유지, 갱신 오류 때 data 유지, `invalidateQueries`의 disabled observer 처리, 같은 키 observer 두 개(15초·60초) 주기 동작을 확인한다
- 실행 명령: `anvil --fork-url $ETH_MAINNET_RPC_URL --fork-block-number 26250000 --port 8557`, 같은 포크 `--block-time 1 --port 8558`, `cast estimate`, `cast rpc`, `cast call`, 저장소 밖 `bun` 스크립트
- 수정 금지: 저장소 파일
- 구현 기록: general-purpose(조사 전용 에이전트 없음, F9 선례), 저장소 밖 `/root/study/.pipeline-scratch/network-fee/t1/` 작업. 2026-11-23. 저장소 수정 없음, anvil 8557·8558·로컬 서버 18557 종료 확인. anvil/cast 1.8.1, viem 2.57.16, wagmi 3.7.11, query-core 5.106.1. 산출물 `out/*.json`. 스펙과 어긋난 점 없음. (1) gas(새 주소/7702 mock 계정/코드 지움): approve 56285 전부, USDC→DAI 148595, USDC→WETH 131295, ETH 입력 156276/150212/150212, ETH 출력 174459/186745/168583, wrap 27938(WETH 첫 보유 시 45038), unwrap 36015/revert(code 3, data 0x)/36015 → mock 계정 approve·ETH 입력·wrap·승인 뒤 스왑 성공, DoD-42~~44 차단 없음. (2) allowance 0 스왑: code 3 `STF`, 프록시 경유 동일. (3) USDT 부분 allowance: approve(0) 31220 성공(같은 상태 approve(max)는 revert), 체결 뒤 approve(max) 48897 성공. (4) ETH 0 계정 approve·스왑·unwrap 추정 성공(anvil·Base·Arbitrum), value > 잔액은 세 곳 실패, Arbitrum은 value = 잔액도 실패(L1 비용 차감). (5) `estimateGas` 1건(params `{data,from,to,value?}`만), `getGasPrice` 1건, `estimateL1Fee` 사본 eth_call 1건(원본 클라이언트는 aggregate3로 묶임 → 사본 필수, oracle `0x4200…000F`, 셀렉터 `0x49948e0e`), `withoutRetry` 사본은 429·500·끊김 각 1건(사본 없으면 4건). (6) cold(캐시 없음) 최대 2885ms(견적 4048ms) < 5초, CI 캐시 없음 → 예열 유지. (7) `--block-time 1`에서 gasPrice = baseFee + 1 gwei, 약 133블록 동안 매 블록 감소 후 1000000007 고정 → E2E는 > 0 판정. (8) §4.5 세 case 파손 예상 확인. 추가 위험 후보 `swap-execution-progress [EC-10]` :884(계정 변경 뒤 F10 ETH 잔액 `eth_getBalance`가 CARD_READS 집계에 섞일 수 있음, 타이밍 의존). 나머지 후보 안전, `-32601` 의존 case 없음, E2E 프록시 집계 안전, Profiler 커밋 case는 T-12 실행 확인. (9) Base gasPrice 6000000, L1 fee는 gas×gasPrice의 0.27~~0.41%. (10) staleTime 0 키 복귀 시 재요청하며 이전 값 success 유지, enabled false→true는 stale일 때만 요청, 오류 뒤 주기 유지, 갱신 오류 시 data 유지(status=error) → 상태 조립은 data 우선, invalidate는 disabled observer 재요청 안 함, interval은 요청 완료 시점부터 재시작, 같은 키 15초 observer가 있으면 60초 observer 추가 요청 0

### T-2 — config와 lib 순수 함수

- 사이드: 프론트
- 상태: 완료
- 목적: 스펙 §4.1 타입, §4.2 순수 함수, §4.3 상수와 추정 요청 조립·kind 매핑 함수를 만든다
- 선행: 없음
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-16, DoD-17, DoD-18, DoD-22, DoD-23, DoD-24, DoD-25, DoD-26, DoD-30, DoD-31, DoD-46, DoD-50, DoD-51, EC-14, EC-16, EC-17, EC-18, EC-20, EC-21, EC-22, EC-23, EC-25
- 수정 대상: `config/network-fee.ts` — 신규, 경고 bps·gasPrice 주기·`HAS_L1_DATA_FEE_BY_CHAIN`. `lib/network-fee.ts` — 신규, 타입·`formatEthFee`·`getNetworkFeeSeverity`(교차곱 bps 비교, 버림 `ratioPercent`)·`isEthShortage`·주 버튼 상태→kind 매핑·`buildNetworkFeeTxRequest`(deadline 인자)
- 따라야 할 패턴: React·wagmi import 없는 `lib/`, bigint 문자열 연산, 체인별 config 레코드, kebab-case·named export — 근거: `lib/token-usd-price.ts:33-63`, `lib/token-amount.ts:30`, `config/gas-reserve.ts`, `CLAUDE.md`
- 완료 조건: 연결 항목 판정에 필요한 함수가 있다. `Intl`·`toLocaleString`·`Number` 변환과 체인 ID 숫자 리터럴이 없다. `lib/swap-transaction.ts`가 바뀌지 않는다 — 검증: T-7, T-8
- 실행 명령: `bun run typecheck`, `bun run lint`
- 수정 금지: `lib/swap-transaction.ts`, `lib/primary-button-state.ts`, `config/chains.ts`, `config/tokens.ts`, `hooks/`, `providers/`, `components/`
- 구현 기록: seongho:frontend-dev, 작성 영역 `config/network-fee.ts`(경고 bps 500·gasPrice 60초·`HAS_L1_DATA_FEE_BY_CHAIN` viem chain id 키)·`lib/network-fee.ts`(§4.1 타입, `getNetworkFeeKind`, `buildNetworkFeeTxRequest`, `formatEthFee`(1 ETH 이상은 `formatTokenAmount` 재사용), `getNetworkFeeSeverity`(교차곱), `isEthShortage`, 추가 helper `isEthLikeToken`·`getNetworkFeeValueWei`). 수정 0/3. 달라진 점: `ratioPercent`만 §4.1 `number` 계약 때문에 버림 bigint를 안전 정수 상한으로 `Number` 변환(`lib/network-fee.ts:168`), 수수료 0이고 보내는 금액 양수면 ratioPercent 0. 오케스트레이터 확인: typecheck·lint 통과, 금지 패턴은 위 1곳만

### T-3 — 읽기 함수

- 사이드: 프론트
- 상태: 완료
- 목적: 재시도 없는 추정·가스 가격·L1 수수료 읽기 함수를 만든다
- 선행: T-1, T-2
- 연결 항목: DoD-5, DoD-6, DoD-7, DoD-8, DoD-46, DoD-49, EC-3, EC-5
- 수정 대상: `lib/read-network-fee.ts` — 신규, `estimateNetworkFee(client, { chainId, account, request })` → `{ gas, l1Fee }`(L1은 config가 참일 때만, 추정 성공 뒤 순차)와 `readGasPrice(client)`. `lib/read-token-usd-price.ts` — `withoutRetry`에 `export`만 추가
- 따라야 할 패턴: batch·재시도를 끈 클라이언트 사본, `config.getClient()` 클라이언트 전제 — 근거: `lib/read-token-usd-price.ts:39-49`, `docs/plans/usd-price.md:92`
- 완료 조건: 연결 항목 충족. T-1 (5)의 요청 형태와 일치한다. `estimateTotalFee`·`prepareTransactionRequest`·fee 필드가 없고 프록시 transport 외 HTTP가 없다 — 검증: T-8, T-11
- 실행 명령: `bun run typecheck`, `bun run lint`
- 수정 금지: `withoutRetry`의 export 외 `lib/read-token-usd-price.ts` 내용, `lib/token-balances.ts`, `config/wagmi.ts`, `config/rpc.ts`, `lib/rpc-proxy.ts`, T-2 파일
- 구현 기록: seongho:frontend-dev(T-2 에이전트 이어서), 작성 영역 `lib/read-network-fee.ts`·`lib/read-token-usd-price.ts`(`withoutRetry` export만, :43). `estimateNetworkFee`(같은 요청 객체로 추정 후 config가 참일 때만 `estimateL1Fee` 순차, L1 실패 시 throw)·`readGasPrice`, 둘 다 `withoutRetry` 사본. 수정 0/3. 에이전트 자체 확인: 로컬 스텁 서버로 Ethereum·Arbitrum은 estimateGas+gasPrice만, Base는 단일 eth_call getL1Fee(aggregate3 아님), 429에서 각 1건. 오케스트레이터 확인: typecheck·lint 통과, 금지 API 없음, 기존 파일 diff 1줄

### T-4 — 훅과 provider

- 사이드: 프론트
- 상태: 완료
- 목적: 추정·gasPrice·ETH 잔액 쿼리와 `NetworkFeeProvider`·`useNetworkFee()`를 만들고 마운트한다
- 선행: T-3
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-12, DoD-13, DoD-14, DoD-24, DoD-34, DoD-35, DoD-36, DoD-37, DoD-38, DoD-39, DoD-40, DoD-41, DoD-45, DoD-49, DoD-52, DoD-53, EC-1, EC-2, EC-3, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13, EC-14, EC-15, EC-19, EC-21, EC-25
- 수정 대상: `hooks/use-network-fee-reads.ts` — 신규, 키 상수·키 팩터리, 추정·gasPrice·ETH 잔액 쿼리 훅. `providers/network-fee-provider.tsx` — 신규, 주 버튼 상태 재계산·`latestRef`·ETH 단가 출처·상태 조립. `providers/app-providers.tsx` — `SwapExecutionProvider` 안쪽 마운트
- 따라야 할 패턴: Provider와 사용 훅을 한 파일에 둠, 시간 값은 export 상수, 키에 bigint 없음, 선택 체인 `chainId`로 `config.getClient` — 근거: `providers/swap-usd-price-provider.tsx`, `hooks/use-token-usd-price.ts:57-127`, `providers/swap-execution-provider.tsx:177-195`
- 완료 조건: 연결 항목 충족. `useSwapExecution`·`useTokenAllowance`·`useSwapQuote`·`useSwapForm`의 반환 형태가 바뀌지 않는다. ETH 단가 단건 훅 호출은 이 provider 한 곳뿐이다. SSR에서 queryFn이 실행되지 않는다 — 검증: T-8, T-9, T-10, T-12
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap`
- 수정 금지: `providers/swap-execution-provider.tsx`, `providers/token-allowance-provider.tsx`, `providers/swap-quote-provider.tsx`, `providers/swap-form-provider.tsx`, `providers/swap-usd-price-provider.tsx`, `hooks/use-token-balance.ts`, `hooks/use-token-usd-price.ts`, `lib/`, `components/`
- 구현 기록: seongho:frontend-dev(T-2·T-3 에이전트 이어서), 작성 영역 `hooks/use-network-fee-reads.ts`·`providers/network-fee-provider.tsx`·`providers/app-providers.tsx`(+4 −1, `SwapExecutionProvider` 안쪽 마운트). 주 버튼 상태 재계산 → `getNetworkFeeKind`, `latestRef`로 최소 수령량·allowance·deadline을 추정 시점에 읽음, 추정 키 8요소(feeTier는 swap만, 나머지 null), gasPrice 키 `[KEY, chainId]`·60초, 모든 F10 쿼리 retry·focus·reconnect 끔, 상태 조립 data 우선(isFetching 미사용), ETH 단가는 한쪽이 ETH·WETH면 `useSwapUsdPrices()` 재사용 아니면 단건 훅 1곳, ETH 잔액은 한쪽이 ETH면 카드 값 아니면 카드 키 60초 observer(idle이면 끔). 수정 0/3. 오케스트레이터 확인: typecheck·lint 통과, `bun run test __tests__/swap` 3 실패·259 통과 — 실패는 스펙 §4.5 세 case(quote-read `[EC-6]`·`[DoD-8]`, native-eth-wrap-quote `[DoD-14]`)뿐, T-13 대상. 수정 1/3(2026-11-23): EC-14 간헐 실패 원인 — approve 성공 뒤 `finish`(phase idle) 렌더에서 상위 `TokenAllowanceProvider` context가 react-query 알림(`setTimeout(0)`) 전이라 이전 allowance를 보여 approve(0) 키가 다시 켜지고 재추정·한 프레임 표시. 같은 창이 F5 주 버튼에도 있음(기존 결함, 수정 금지 파일이라 범위 밖으로 보고). 수정: `hooks/use-network-fee-reads.ts:171` `useCachedTokenAllowance`(렌더 시점 `getQueryData`, observer·요청 없음), `providers/network-fee-provider.tsx:69-87`이 context가 success이고 캐시 값이 다르면 캐시 값을 주 버튼 상태·approve amount·`latestRef`에 사용. 에이전트 자체 확인 EC-14 병렬 50회 50 통과. 오케스트레이터 확인: typecheck·lint 통과, EC-14 병렬 8×2 16/16 통과, `bun run test __tests__/swap` 303/303 통과

### T-5 — 화면

- 사이드: 프론트
- 상태: 완료
- 목적: 수수료 행과 경고·승인 후 안내·ETH 부족 줄을 표시하고 카드에 배치한다. 수수료 행 라벨·값과 F9 인라인 USD의 구분을 가운뎃점 대신 괄호로 표기한다(2026-11-23 스펙 갱신)
- 선행: T-4
- 연결 항목: DoD-10, DoD-11, DoD-12, DoD-13, DoD-14, DoD-15, DoD-19, DoD-20, DoD-21, DoD-27, DoD-28, DoD-32, DoD-54, EC-1, EC-19
- 수정 대상: `components/network-fee.tsx` — 신규. `components/swap-card.tsx` — `QuoteDetails`와 `PrimaryButton` 사이에 한 줄 추가. `components/usd-value.tsx` — `InlineUsd`의 `·` 접두를 괄호 표기로 바꿈(testid·`data-usd-micros`·스켈레톤 testid 불변)
- 따라야 할 패턴: `UsdSkeleton` 스타일(testid는 새 것), `role="img"` 접근성 이름 기호, `text-muted-foreground font-mono tabular-nums`, `text-warning`, JSX 리터럴 testid — 근거: `components/usd-value.tsx:13-24,78-82`, `components/quote-details.tsx:43-61`, `app/globals.css:33,88`
- 완료 조건: 연결 항목 충족. §4.4 식별자·속성과 일치하고 새 testid는 §4.4의 다섯 개뿐이다. `quote-skeleton`·`usd-skeleton`·`InlineUsd`를 쓰지 않는다. 카드는 서버 컴포넌트 그대로다. 빌드가 통과한다 — 검증: T-9, `bun run build`
- 실행 명령: `bun run build`, `bun run lint`, `bun run typecheck`
- 수정 금지: `lib/`, `config/`, `hooks/`, `providers/`, `components/primary-button.tsx`, `components/quote-details.tsx`, `components/tx-status.tsx`, `app/globals.css`
- 구현 기록: seongho:frontend-dev(T-2~T-4 에이전트 이어서), 작성 영역 `components/network-fee.tsx`·`components/swap-card.tsx`(+2, `QuoteDetails`와 `PrimaryButton` 사이). 클라이언트 컴포넌트, idle이면 null, `data-fee-wei`·`data-severity`는 success만, `data-usd-micros`는 usdMicros 있을 때만, 오류는 `role="img"` `—`, 스켈레톤은 새 `network-fee-skeleton`. 스타일 세부(상단 경계 `pt-4`, USD muted, 스켈레톤 `w-24`)는 §1.1 범위 안 선택. 수정 0/3(보고 전달 실패 1회 재요청). 오케스트레이터 확인: typecheck·lint·build 통과, testid는 §4.4 다섯 개뿐 / 2026-11-23 스펙 변경 재작업(DoD-54, 예산 미산입): seongho:frontend-dev, `components/network-fee.tsx`(:79 라벨 `네트워크 수수료(…)`, :86 ` ($…)`)·`components/usd-value.tsx`(`InlineUsd` wrapper에 ` (` + testid span/스켈레톤 + `)`). 오케스트레이터 확인: typecheck·lint·format 통과, 화면 문자열 `·` 0건

### T-6 — 문서

- 사이드: 문서
- 상태: 완료
- 목적: 디자인 문서의 가스 가격 배지 줄과 README 알려진 한계를 고친다
- 선행: 없음
- 연결 항목: DoD-47, DoD-48
- 수정 대상: `docs/design/README.md:36` — 가스 가격 배지 제거 문장을 수수료 행으로 대체했다는 문장으로 고침. `README.md:58` — 네트워크 수수료 미표시 항목을 표시·안내는 하되 차단하지 않고 추정이 실제와 다를 수 있다는 내용으로 고침(ETH 가스 부족 사전 차단 없음 유지)
- 따라야 할 패턴: 기존 목록·문장 형식 유지 — 근거: `docs/plans/usd-price.md:129-130`
- 완료 조건: 연결 항목 충족. 다른 문장은 바뀌지 않는다 — 검증: `bun run format:check`, 코드 대조
- 실행 명령: `bun run format:check`
- 수정 금지: `docs/specs/*`, 다른 문서 문장
- 구현 기록: seongho:frontend-dev(문서 전용 에이전트 없음, 화면 문서·README 담당으로 배정), 작성 영역 `docs/design/README.md:36`(가스 가격 배지 → 수수료 행 대체 문장)·`README.md:57`(알려진 한계: 표시·안내하되 차단 안 함, 추정 불일치 가능). 수정 0/3. 오케스트레이터 확인: diff 2파일 +2 −2, `bun run format:check` 통과

### T-7 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 표기·경고·ETH 부족 순수 함수의 경계를 검증한다
- 선행: T-2
- 연결 항목: DoD-16, DoD-17, DoD-18, DoD-22, DoD-23, DoD-24, DoD-25, DoD-26, DoD-30, DoD-31, DoD-50, DoD-51, EC-16, EC-17, EC-18, EC-20, EC-21, EC-22, EC-23, EC-25
- 수정 대상: `__tests__/lib/network-fee.test.ts` — 신규
- 따라야 할 패턴: 기대값은 리터럴·테스트 쪽 계산 — 근거: `__tests__/lib/token-usd-price.test.ts`
- 완료 조건: 연결 항목 판정. 경계 표본은 500·499·501 bps, ETH·WETH 경로의 USD 없는 판정, `ratioPercent` 버림과 100% 이상, 1 wei·9999999999 wei·10^10 wei, 1 ETH 경계, 잔액 = fee + value다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib/network-fee.test.ts`
- 수정 금지: 제품 코드, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(T-7 골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/lib/network-fee.test.ts`(18 case 본문, 리터럴·테스트 쪽 계산, 경로 구분 표본). 수정 0/3. 작성 에이전트는 실행하지 않음. 오케스트레이터 확인: `bun run test __tests__/lib/network-fee.test.ts` 18/18 통과, 골자 digest `bfb3eb0d0b7d717d` 유지
- 테스트 파일·runner: `__tests__/lib/network-fee.test.ts`, Vitest
- mock 허용 경계: 없음(순수 함수)
- 데이터 격리: 정적 데이터

### T-8 — 통합 테스트: 추정 요청·계산과 테스트 지원 확장

- 사이드: 테스트
- 상태: 완료
- 목적: 스텁에 수수료 3분류를 더하고 kind별 요청 calldata, 체인별 계산, 요청 경로를 검증한다
- 선행: T-5
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-6, DoD-7, DoD-13, EC-14, EC-15
- 수정 대상: `__tests__/support/rpc-balance-stub.ts` — 추가만(§1 분류·응답·규칙·실패·붙잡기·매처·디코더). `__tests__/swap/network-fee-estimate.test.tsx` — 신규
- 따라야 할 패턴: F9 T-8 스텁 확장, calldata 디코드는 테스트 쪽 ABI 리터럴과 하네스 디코더 — 근거: `docs/plans/usd-price.md:160-165`, `__tests__/support/wagmi-harness.tsx:339-393`
- 완료 조건: 연결 항목 판정. DoD-2는 ERC-20·ETH 입력·ETH 출력 세 표본이고 deadline 인자를 뺀 비교다. DoD-5·7은 Ethereum·Arbitrum, DoD-6은 Base다. 분류 양성 대조(같은 시점 견적은 `quote`, 단가는 `usd-price`)가 있다. 주소 기대값은 리터럴이다. 스텁 확장 뒤 `bun run test` 결과를 기록한다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/network-fee-estimate.test.tsx`, `bun run test`
- 수정 금지: 제품 코드, 기존 테스트 파일, `__tests__/support/rpc-fetch-stub.ts`, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(T-8 골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/support/rpc-balance-stub.ts`(추가만)·`__tests__/swap/network-fee-estimate.test.tsx`(7 case). 스텁 +515줄(추가만, 기존 줄 7곳은 union·signature 확장): 분류 `estimate-gas`·`gas-price`·`l1-fee`(셀렉터 우선), `request.url`·`estimateGas`·`l1Fee`·`feeResult` 필드, `defaultNetworkFeeRule`·`networkFeeRuleWith`·`networkFeeRuleVaryingByInput`, `failEstimateGasWhen`·`failGasPriceWhen`·`failL1FeeWhen`(rpc-error·revert·http-429, 붙잡기 해제 뒤 판정), `holdEstimateGas`·`holdGasPrice`·`holdL1Fee`, `matchNetworkFee.*`(`first` 포함). 기존 테스트 영향: 수수료 요청이 -32601 대신 성공 응답이 되어 기존 화면의 수수료 행이 success가 됨. 수정 0/3. 작성 에이전트는 실행하지 않음. 오케스트레이터 확인: 해당 파일 7/7 통과. T-12 3회 중 1회 `[EC-14]` 간헐 실패 → 읽기 전용 분석(general-purpose, 부하 반복 계측 53 통과·7 실패, 실패와 1:1 일치) 결과 PRODUCT-DEFECT로 테스트 경계는 정상, 테스트 수정 없음, `bun run test` 3 실패·405 통과 — 실패는 스펙 §4.5 세 case뿐
- 테스트 파일·runner: `__tests__/swap/network-fee-estimate.test.tsx`, Vitest jsdom
- mock 허용 경계: F9 경계에 수수료 3분류 스텁 응답·revert·실패·붙잡기·HTTP 429를 더한 것. 버튼이 보내는 tx와 비교하는 case는 스텁 EIP-1193 지갑을 쓴다 (사용자 확정 2026-11-22). 실제 노드 추정값과 Base·Arbitrum 실제 값은 증명하지 못한다
- 데이터 격리: 테스트마다 config·스텁·QueryClient 새로 생성, `clearCookies`

### T-9 — 통합 테스트: 표시·경고·ETH 부족·미표시

- 사이드: 테스트
- 상태: 완료
- 목적: 상태별 DOM, 경고·ETH 부족 줄, 주 버튼 불변, 미표시 조건을 검증한다
- 선행: T-8
- 연결 항목: DoD-11, DoD-12, DoD-13, DoD-14, DoD-15, DoD-20, DoD-21, DoD-24, DoD-27, DoD-28, DoD-29, DoD-32, DoD-33, EC-1, EC-2, EC-3, EC-4, EC-7, EC-8, EC-9, EC-19, EC-20, EC-21, EC-23, EC-24
- 수정 대상: `__tests__/swap/network-fee-display.test.tsx` — 신규
- 따라야 할 패턴: 앱 전체 렌더 하네스, testid·data 속성·role 판정, 기대 micros는 테스트 쪽 계산 — 근거: `__tests__/swap/usd-price-display.test.tsx`, `__tests__/support/wagmi-harness.tsx:81`
- 완료 조건: 연결 항목 판정. 버튼 불변 항목은 같은 입력에서 경고·부족·오류 유무에 따른 `primary-button[data-state]`·disabled 비교다. EC-9는 서명 대기와 각 pending phase다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/network-fee-display.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(T-9 골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/network-fee-display.test.tsx`(18 case, 1625줄). 판단: 경고 case는 gas 100_000 고정·gasPrice만 표본별, EC-3은 mock 커넥터 `switchChain`으로 지갑도 Base, EC-8 견적 규칙은 `approve-swap-button` 리터럴 복사, EC-7·EC-24는 setInterval·Date만 가짜 타이머. 수정 0/3. 작성 에이전트는 실행하지 않음. 오케스트레이터 확인: 해당 파일 18/18 통과
- 테스트 파일·runner: `__tests__/swap/network-fee-display.test.tsx`, Vitest jsdom
- mock 허용 경계: T-8과 같음
- 데이터 격리: T-8과 같음

### T-10 — 통합 테스트: 갱신·요청 수·경합·실패

- 사이드: 테스트
- 상태: 완료
- 목적: 추정 키, 60초 주기, 포커스, ETH 잔액 공유, 평시 요청 수, 실패 무재시도·유지, 전환 경합을 검증한다
- 선행: T-8
- 연결 항목: DoD-34, DoD-35, DoD-36, DoD-37, DoD-38, DoD-39, DoD-40, DoD-49, DoD-52, DoD-53, EC-5, EC-6, EC-10, EC-11, EC-12, EC-13
- 수정 대상: `__tests__/swap/network-fee-refresh.test.tsx` — 신규
- 따라야 할 패턴: setInterval 계열만 가짜로 둔 주기 판정, `focusWindow`, 붙잡기·지연, Profiler 커밋 기록 — 근거: `__tests__/swap/usd-price-refresh.test.tsx`, `__tests__/support/wagmi-harness.tsx:265-337`
- 완료 조건: 연결 항목 판정. DoD-36은 키 요소 각각이다. DoD-40은 Ethereum·Base USDC→DAI `swap-ready` 60초 F10 요청 수다. EC-5는 viem·TanStack 재시도 지연을 덮는 구간에서 센다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/network-fee-refresh.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(T-10 골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/network-fee-refresh.test.tsx`(16 case). 판단: EC-13은 mock 커넥터가 `eth_sendTransaction`을 스텁 밖으로 보내 스텁 EIP-1193 지갑 사용(확정 경계 안), DoD-38 (나)는 `bubbles: true`로 window까지 전달하고 탐침 쿼리 양성 대조, 공허 통과 방지 전제 assertion 추가(기대 결과 불변). 실행 위험 메모: DoD-34 "+4"와 tick 계산은 요청 완료 시점 기준 재무장 전제. 수정 0/3. 작성 에이전트는 실행하지 않음. 오케스트레이터 확인: 해당 파일 16/16 통과
- 테스트 파일·runner: `__tests__/swap/network-fee-refresh.test.tsx`, Vitest jsdom
- mock 허용 경계: T-8에 가짜 타이머·`visibilityState` 스텁을 더한 것. 실제 브라우저 타이머 스로틀링은 증명하지 못한다
- 데이터 격리: T-8과 같음, 가짜 타이머는 테스트마다 원복

### T-11 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: Ethereum 포크에서 프록시를 거친 6종 추정 성공과 allowance 0 revert를 검증한다
- 선행: T-1, T-3
- 연결 항목: DoD-8, DoD-9
- 수정 대상: `__tests__/fork/network-fee.fork.test.ts` — 신규
- 따라야 할 패턴: `fetchFn`을 프록시 핸들러에 연결, `vi.stubEnv`, snapshot/revert, `anvil_setBalance`·`anvil_dealERC20`, 코드 없는 계정 또는 위임 코드 제거, 예열 — 근거: `__tests__/fork/usd-price.fork.test.ts:1-90`, `__tests__/fork/native-eth.fork.test.ts:250-300`, `__tests__/fork/approve-swap.fork.test.ts:242-260`
- 완료 조건: 연결 항목 판정. 요청은 제품 `buildNetworkFeeTxRequest` + `estimateNetworkFee`이고 최소 수령량은 anvil QuoterV2 직접 견적으로 만든다. 표본 금액·계정은 T-1 (1)~(3)을 따른다. 기존 포크 테스트가 통과한다 — 검증: 테스트
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드, 기존 `__tests__/fork/*`, `vitest.fork.config.mts`
- 구현 기록: seongho:test-dev(T-11 골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/fork/network-fee.fork.test.ts`(DoD-8 표본 7개: approve, USDC→DAI, USDC→WETH 1000 USDC, ETH→USDC, USDC→ETH, wrap, unwrap / DoD-9 allowance 0 revert). 계정은 anvil 계정 0 + 7702 위임 코드 제거, 표본별 snapshot/revert, 프록시 경유 판정 전 잔액 일치로 공개 RPC fallback 누출 확인. 수정 0/3. 작성 에이전트는 실행하지 않음. 오케스트레이터 확인: `bun run test:fork` 7 파일 23/23 통과(기존 21 + 신규 2), 형식 검사 통과(계획·스펙 파일 oxfmt 적용)
- 테스트 파일·runner: `__tests__/fork/network-fee.fork.test.ts`, Vitest(`vitest.fork.config.mts`, anvil 8547)
- mock 허용 경계: 없음(실제 anvil 포크, `vi.stubEnv`). Base·Arbitrum은 증명하지 못한다
- 데이터 격리: snapshot/revert, 전용 포트 8547, 파일 순차

### T-12 — 기존 테스트 회귀 확인

- 사이드: 테스트
- 상태: 완료
- 목적: F10 요청·DOM 추가 뒤 F1~F9 테스트를 수정 없이 실행해 결과를 기록한다
- 선행: T-5, T-8
- 연결 항목: DoD-45
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 이전 기능 동결 확인, 명령 순차 실행 — 근거: `docs/plans/usd-price.md:238-254`
- 완료 조건: `bun run test` 3회, `test:fork`, `test:e2e` 결과와 §1 세 case·T-1 (8) 위험 case 결과를 기록한다. F1~F9 digest가 유지된다. 세 case 밖의 실패는 고치지 않고 스펙 §4.5 절차로 보고한다 — 검증: 명령 실행
- 실행 명령: `bun run test`, `bun run test:fork`, `bun run test:e2e`
- 수정 금지: 저장소 파일
- 구현 기록: seongho:test-runner(실행 전용), 수정 없음(실행 전후 status·sha256 동일). 2026-11-23. `bun run test` 3회: 439/442·438/442·439/442 — 3회 공통 실패는 스펙 §4.5 세 case(quote-read `[EC-6]`·`[DoD-8]`, native-eth-wrap-quote `[DoD-14]`, 집계에 `eth_gasPrice`·`eth_estimateGas` 유입)뿐, 2회차만 F10 `network-fee-estimate [EC-14]` 실패(:516, 영수증 seq 뒤 approve(0) 추정 섞임, 간헐). 위험 후보 `swap-execution-progress [EC-10]` 3회 통과, Profiler 커밋 case 통과. `test:fork` 23/23, `test:e2e` 35 통과·3 skip(F10 fixme)·실패 0. F1~~F10 digest 모두 일치(F1 6afdf2fb5d08e92c, F2 a8d00ddb8b88e8f7, F3 6a48e7cea8e0d4ed, F4 3af643e844b77259, F5 b17ea048db48454a, F6 8a07e4e0f647896f, F7 ded5093c9ac9e1a2, F9 6a5e6db5a40c5bc1, F10 bfb3eb0d0b7d717d). 소요 `bun run test` 250~~286s
- 테스트 파일·runner: 기존 파일, Vitest·Playwright
- mock 허용 경계: 기존 그대로
- 데이터 격리: 기존 그대로
- 실행 환경: 앱 3100·anvil 8546 독점, `check:build`와 동시 실행 금지

### T-13 — 동결 테스트 회귀 갱신

- 사이드: 테스트
- 상태: 완료
- 목적: 스펙 §4.5에 따라 F3·F7 동결 세 case의 집계에서 F10 요청을 빼고, F4 `rowValueParts`가 `·` 대신 괄호 조각을 빼게 한다
- 선행: T-12
- 연결 항목: DoD-45
- 수정 대상: `__tests__/swap/quote-read.test.tsx`(`[EC-6]`, `[DoD-8]`), `__tests__/swap/native-eth-wrap-quote.test.tsx`(`[DoD-14]`), `__tests__/swap/slippage-quote.test.tsx`(`rowValueParts` :189 부근) — 판정 보조만. §4.5 절차로 승인된 추가 case가 있으면 함께 고친다
- 따라야 할 패턴: 동결 골격은 assertion만 바꾼다 — 근거: `docs/plans/usd-price.md` T-14
- 완료 조건: 결정 범위만 바뀌고 F3·F7 digest 전후를 기록한다. F10 요청을 뺀 뒤에도 원래 판정(견적 요청 0건·2건 이하)과 양성 대조가 유지된다 — 검증: 해당 파일 실행, 동결 확인 명령
- 실행 명령: `bun run test __tests__/swap/quote-read.test.tsx __tests__/swap/native-eth-wrap-quote.test.tsx __tests__/swap/slippage-quote.test.tsx`
- 수정 금지: 제품 코드, 그 밖의 기존 테스트, `__tests__/support/*`
- 구현 기록: seongho:test-dev(T-8 에이전트, 기존 테스트 판정 보조 수정, 스펙 §4.5 근거), 작성 영역 `__tests__/swap/quote-read.test.tsx`·`__tests__/swap/native-eth-wrap-quote.test.tsx`(+29 −3). 세 case의 `matchQuote.notBalance` 집계에 `!matchNetworkFee.any` 조합(수수료 3분류 제외). F10 ETH 잔액·ETH 단가는 세 case에서 한쪽이 ETH·WETH라 요청이 없어 제외 불필요, F9 단가 요청은 계속 집계. 양성 대조·한도 유지. F3 `6a48e7cea8e0d4ed`·F7 `ded5093c9ac9e1a2` 전후 동일. 수정 0/3. 작성 에이전트는 실행하지 않음. 오케스트레이터 확인: 두 파일 14/14 통과 / 2026-11-23 스펙 변경 재작업(§4.5 F4 `rowValueParts`, 예산 미산입): seongho:test-dev, `__tests__/swap/slippage-quote.test.tsx`(`rowValueParts`가 끝 `()` 또는 `(`·`)` 조각만 제거). F4 digest `3af643e844b77259` 유지. 오케스트레이터 확인: slippage-quote·quote-read·native-eth-wrap-quote 21/21 통과, F1~F10 digest 일치
- 테스트 파일·runner: 위 두 파일, Vitest jsdom
- mock 허용 경계: 기존 그대로
- 데이터 격리: 기존 그대로

### T-14 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 실제 브라우저·프록시·anvil에서 approve→swap, ETH 입력 swap, wrap의 수수료 행을 검증한다
- 선행: T-1, T-5, T-13
- 연결 항목: DoD-42, DoD-43, DoD-44
- 수정 대상: `e2e/network-fee.spec.ts` — 신규. `e2e/support/network-fee.ts` — 신규, locator와 응답 감시 보조. `e2e/support/anvil.ts` — 추가만, 추정 경로 예열
- 따라야 할 패턴: mock 커넥터 연결, 감시만 하는 네트워크(`page.route` 금지), `setErc20Balance`, snapshot/revert, `beforeAll` 예열 — 근거: `e2e/approve-swap.spec.ts:14-15,64,89`, `e2e/support/network.ts:55`, `e2e/support/anvil.ts:52,173,197-209`
- 완료 조건: 연결 항목 판정. DoD-42는 `data-fee-wei` > 0까지 보고 러너 계산값과의 정확 일치는 비교하지 않는다(사용자 확정 2026-11-22, 계산은 T-8이 덮는다). E2E 전체가 통과한다 — 검증: E2E
- 실행 명령: `bun run test:e2e e2e/network-fee.spec.ts`, `bun run test:e2e`
- 수정 금지: 제품 코드, `config/e2e-mock.ts`, 기존 `e2e/*.spec.ts`, `e2e/support/app.ts`, `e2e/support/network.ts`
- 구현 기록: seongho:e2e-dev(T-14 골격 작성 에이전트, 살 모드), 작성 영역 `e2e/network-fee.spec.ts`·`e2e/support/network-fee.ts`·`e2e/support/anvil.ts`(끝에 `warmUpEstimateGas`·예열 요청 생성 함수 추가, viem import에 `encodeFunctionData` 한 단어 추가). 3 case(DoD-42 5 USDC→WETH approve→swap, DoD-43 1 ETH→USDC, DoD-44 1 ETH→WETH), `evaluateAll`로 kind·state·fee-wei 동시 판독 후 `expect.poll`, DoD-42만 snapshot/revert, 7702 위임 코드 유지(ETH 수령 없음). 응답 감시 보조는 정확 일치 비교가 없어 만들지 않음. 수정 0/3. 작성 에이전트는 실행하지 않음. 오케스트레이터 확인: `bun run test:e2e e2e/network-fee.spec.ts` 3/3 통과(24.8s)
- 테스트 파일·runner: `e2e/network-fee.spec.ts`, Playwright chromium
- mock 허용 경계: F9 E2E 경계(mock 커넥터, 감시만 하는 네트워크)에 러너→anvil 추정 예열을 더한 것, `page.route` 금지 (사용자 확정 2026-11-22). 실제 지갑·L2·WAF는 증명하지 못한다
- 데이터 격리: snapshot/revert, `workers: 1`, 테스트별 컨텍스트
- 실행 환경: 앱 3100(`NEXT_PUBLIC_E2E_MOCK=1`, `.next-e2e`), anvil 8546(`--block-time 1`), 포크 블록·포트 `config/e2e.ts`, 계정 `config/e2e-mock.ts`, Ethereum만, `check:build`와 동시 실행 금지

### T-15 — 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 전체 명령, 동결, 코드 대조 항목을 확인한다
- 선행: T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, T-10, T-11, T-12, T-13, T-14
- 연결 항목: DoD-10, DoD-19, DoD-41, DoD-45, DoD-46, DoD-47, DoD-48, DoD-54
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 명령을 순차 실행하고 `check:build`는 `test:e2e` 뒤 단독 — 근거: `docs/plans/usd-price.md` T-17, `CLAUDE.md`
- 완료 조건: 명령이 모두 통과하고 `bun run test`는 3회 같은 결과다. F1~F9 digest가 일치한다(F3·F7은 T-13 뒤 기록값). 코드 대조: DOM 순서, `formatUsd` 사용, ETH 단가 호출 1곳, 훅 계약 diff 없음, 체인 ID 리터럴 없음, 문서 문장, 화면 표기에 가운뎃점 구분자 없음(DoD-54), 프록시 허용 목록·`package.json`·`bun.lock`·환경 변수 무변경, `estimateTotalFee`·`prepareTransactionRequest`·fee 필드 미사용, §1 산정 ≤ 120 — 검증: 명령 실행 확인
- 실행 명령: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`(3회), `bun run build`, `bun run test:fork`, `bun run test:e2e`, 그 뒤 단독으로 `bun run check:build`
- 수정 금지: 저장소 파일
- 구현 기록: 7단계 독립 검증으로 수행(verify general-purpose, seongho:test-runner, seongho:e2e-runner). 2026-11-23. verify PASS(78/78 충족, digest 일치, 범위 위반 없음), test-runner PASS(format·lint·typecheck, `bun run test` 3회 442/442, build, `test:fork` 23/23, F1~~F10 digest 일치), e2e-runner PASS(`test:e2e` 38/38 skip 0, 단독 `check:build` 통과). 검증 전후 작업 트리 해시 동일 / 2차(DoD-54 반영 후, 2026-11-24): verify PASS(79/79), test-runner PASS(`bun run test` 3회 442/442, `test:fork` 23/23, build, F1~~F10 digest 일치), e2e-runner PASS(`test:e2e` 38/38, 단독 `check:build` 통과, ETH→USDC 화면 `·` 0개). 검증 전후 작업 트리 해시 동일

## 3. 항목 coverage

- DoD-1: T-1, T-2, T-4, T-8
- DoD-2: T-1, T-2, T-4, T-8
- DoD-3: T-1, T-2, T-4, T-8
- DoD-4: T-4, T-8
- DoD-5: T-3, T-4, T-8
- DoD-6: T-1, T-3, T-8
- DoD-7: T-3, T-8
- DoD-8: T-1, T-3, T-11
- DoD-9: T-1, T-11
- DoD-10: T-5, T-15 (코드 대조만)
- DoD-11: T-5, T-9
- DoD-12: T-4, T-5, T-9
- DoD-13: T-4, T-5, T-8, T-9
- DoD-14: T-4, T-5, T-9
- DoD-15: T-5, T-9
- DoD-16: T-2, T-7
- DoD-17: T-2, T-7
- DoD-18: T-2, T-7
- DoD-19: T-5, T-15 (코드 대조만)
- DoD-20: T-5, T-9
- DoD-21: T-5, T-9
- DoD-22: T-2, T-7
- DoD-23: T-2, T-7
- DoD-24: T-2, T-4, T-7, T-9
- DoD-25: T-2, T-7
- DoD-26: T-2, T-7
- DoD-27: T-5, T-9
- DoD-28: T-5, T-9
- DoD-29: T-9
- DoD-30: T-2, T-7
- DoD-31: T-2, T-7
- DoD-32: T-5, T-9
- DoD-33: T-9
- DoD-34: T-4, T-10
- DoD-35: T-4, T-10
- DoD-36: T-4, T-10
- DoD-37: T-4, T-10
- DoD-38: T-4, T-10
- DoD-39: T-4, T-10
- DoD-40: T-1, T-4, T-10
- DoD-41: T-4, T-15 (코드 대조만)
- DoD-42: T-1, T-14
- DoD-43: T-1, T-14
- DoD-44: T-1, T-14
- DoD-45: T-1, T-4, T-12, T-13, T-15 (코드 대조와 기존 테스트 실행)
- DoD-46: T-2, T-3, T-15 (코드 대조만)
- DoD-47: T-6, T-15 (코드 대조만)
- DoD-48: T-6, T-15 (코드 대조만)
- DoD-49: T-3, T-4, T-10
- DoD-50: T-2, T-7
- DoD-51: T-2, T-7
- DoD-52: T-4, T-10
- DoD-53: T-4, T-10
- DoD-54: T-5, T-15 (코드 대조만)
- EC-1: T-1, T-4, T-5, T-9
- EC-2: T-4, T-9
- EC-3: T-3, T-4, T-9
- EC-4: T-9
- EC-5: T-3, T-4, T-10
- EC-6: T-4, T-10
- EC-7: T-4, T-9
- EC-8: T-4, T-9
- EC-9: T-4, T-9
- EC-10: T-4, T-10
- EC-11: T-4, T-10
- EC-12: T-4, T-10
- EC-13: T-4, T-10
- EC-14: T-1, T-2, T-4, T-8
- EC-15: T-4, T-8
- EC-16: T-2, T-7
- EC-17: T-2, T-7
- EC-18: T-2, T-7
- EC-19: T-4, T-5, T-9
- EC-20: T-2, T-7, T-9
- EC-21: T-1, T-2, T-4, T-7, T-9
- EC-22: T-2, T-7
- EC-23: T-2, T-7, T-9
- EC-24: T-9
- EC-25: T-2, T-4, T-7

## 4. 실행 순서

- 1구간(병렬): T-1(저장소 밖, 8557·8558) / T-2 / T-6
- 2구간(병렬): T-3(T-1·T-2 뒤) / T-7(T-2 뒤)
- 3구간(병렬): T-4 / T-11(8547 독점, T-3 뒤)
- 4구간: T-5
- 5구간(단독): T-8. 공용 `__tests__/support/rpc-balance-stub.ts`를 고친다
- 6구간(병렬): T-9 / T-10. 각자 신규 파일 하나만 고친다
- 7구간(단독): T-12. 수정 없음, E2E 포트 독점
- 8구간(단독): T-13
- 9구간(단독): T-14. 3100·8546 독점
- 10구간(단독): T-15
- 테스트 설계(골격 동결)는 구현 전에 T-7~T-11·T-14의 골격을 고정한다. 코드 대조로만 판정하는 제외 후보는 DoD-10, DoD-19, DoD-41, DoD-46, DoD-47, DoD-48, DoD-54이고 DoD-45는 명령 실행으로 판정한다
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/network-fee.md --files __tests__/lib/network-fee.test.ts __tests__/swap/network-fee-estimate.test.tsx __tests__/swap/network-fee-display.test.tsx __tests__/swap/network-fee-refresh.test.tsx __tests__/fork/network-fee.fork.test.ts e2e/network-fee.spec.ts --exempt DoD-10,DoD-19,DoD-41,DoD-45,DoD-46,DoD-47,DoD-48,DoD-54`

## 5. 차단 사항

- T-1 (1)에서 7702 위임 계정(E2E mock 계정)의 approve·swap·wrap 추정이 실패하면 DoD-42~44를 이룰 수 없으므로 인터뷰로 되돌린다
- T-12에서 §4.5 세 case 밖의 동결 case가 실패하면 고치지 않고 보고해 사용자 승인을 받는다

## 테스트 설계 증거

- 상태: PASS(사용자 승인 예외 포함, 2026-11-23). 기계 검사 통과, 새 reviewer 4회 중 마지막 4회차 NEEDS-FIX(Med 2·Low 2)를 반영한 뒤 사용자 결정으로 재검토 없이 동결
- 기준 스펙: `docs/specs/network-fee.md`(확정, 2026-11-23 갱신: DoD-52 문구 사용자 결정)
- 골자 digest: `bfb3eb0d0b7d717d` (항목 78개 중 case 연결 71개, 제외 7개, case 64개)
- 골격 파일: `__tests__/lib/network-fee.test.ts`(T-7), `__tests__/swap/network-fee-estimate.test.tsx`(T-8), `__tests__/swap/network-fee-display.test.tsx`(T-9), `__tests__/swap/network-fee-refresh.test.tsx`(T-10), `__tests__/fork/network-fee.fork.test.ts`(T-11), `e2e/network-fee.spec.ts`(T-14). Vitest는 `it.todo`, Playwright는 `test.fixme`
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/network-fee.md --files __tests__/lib/network-fee.test.ts __tests__/swap/network-fee-estimate.test.tsx __tests__/swap/network-fee-display.test.tsx __tests__/swap/network-fee-refresh.test.tsx __tests__/fork/network-fee.fork.test.ts e2e/network-fee.spec.ts --exempt DoD-10,DoD-19,DoD-41,DoD-45,DoD-46,DoD-47,DoD-48,DoD-54 --frozen bfb3eb0d0b7d717d`
- 작성: seongho:test-dev(T-7·T-8·T-9·T-10·T-11), seongho:e2e-dev(T-14), 골격 모드
- reviewer 라운드: 4회(매회 새 general-purpose, 파일 무변경 확인). 1회차 NEEDS-DECISION(High 1: EC-5 HTTP 429 누락 등) → 2회차 NEEDS-FIX(High 2: DoD-37 주기 재시작, DoD-38 visibilitychange) → 3회차 NEEDS-FIX(High 1: DoD-38 공허 통과) → 사용자 승인으로 한도 초과 4회차 NEEDS-FIX(High 0, Med 2: EC-12 토큰 키, EC-6 갱신 중 표시) → 반영 후 재검토 없이 동결(사용자 결정 2026-11-23). 미반영 권고: estimate DoD-1~3 하위 호출 디코드 중복, display DoD-29·EC-4·DoD-33 렌더 수(축소 방향, 사용자 결정으로 유지)
- 사람 확정(2026-11-22~23):
  - mock 경계: 통합은 F9 경계(실제 wagmi·Provider·화면, mock 커넥터·스텁 EIP-1193 지갑, 전역 fetch URL 라우팅 스텁, 가짜 타이머, visibilityState 스텁, `vi.mock` 금지) + 수수료 3분류 스텁 응답·revert·실패·붙잡기·HTTP 429, 테스트 쪽 관찰(탐침 쿼리·focusManager 구독) 양성 대조 허용. E2E는 mock 커넥터 + 감시만 하는 네트워크 + 러너→anvil 추정 예열, `page.route` 금지. 포크는 실제 anvil
  - 제외(코드 대조·명령 판정): DoD-10, DoD-19, DoD-41, DoD-45(기존 테스트 실행), DoD-46, DoD-47, DoD-48
  - DoD-42는 `data-fee-wei` > 0까지, 러너 계산값 정확 일치 비교 없음. T-14의 `/api/rpc/1` 조건 삭제. DoD-49는 L1·추정 요청 순서를 판정하지 않음. DoD-52는 재추정 중 마지막 값 표시 허용
- 미검증·검증 불가: Base·Arbitrum 실제 추정값과 L1 수수료(viem `estimateL1Fee` 직렬화 스텁 값 의존, T-1 (9) 기록뿐), 지갑 실제 수수료와의 일치, 실제 브라우저 타이머 스로틀링, WAF 120건/60초(산정만), E2E mock 계정(7702 위임)의 추정 성공(T-1 (1), §5 차단 사항). DoD-39의 카드 잔액 키 공유는 체인 외에는 코드 대조로만 확인된다
- 살 단계 주의: `visibilitychange`는 window 리스너까지 전달되게 보낸다(기존 `document.dispatchEvent(new Event("visibilitychange"))` 패턴은 TanStack에 닿지 않음). DoD-38 (다)의 다음 tick은 첫 `eth_gasPrice` 시각 기준 주기다. DoD-6의 L1 bytes 대조는 요청을 한 번만 조립한다는 전제다. 표시 테스트 상태(EC-8·EC-9·EC-24, 체인 불일치)는 기존 하네스·스텁으로 만들 수 있다(오케스트레이터 확인)

- 갱신(2026-11-23, update): 사용자 결정으로 가운뎃점 구분자를 괄호로 바꾸며 스펙에 DoD-54(코드 대조 전용)와 §4.5 개정 2건을 추가. 골격 파일 변경 없음, 제외 목록에 DoD-54를 더해 기계 검사 통과(항목 79개 중 case 연결 71개, 제외 8개, case 64개, 골자 digest `bfb3eb0d0b7d717d` 유지). DoD-54 제외는 사용자 확정(문구만 보는 테스트 금지, CLAUDE.md). 골자가 바뀌지 않아 reviewer는 다시 돌리지 않음

### 검증 기록

- 2차 검증(2026-11-24, DoD-54 반영 후, 최종): 코드 기준 HEAD 523f938 + 작업 트리(검증 전후 해시 동일). verify PASS — 충족 79(DoD-1~~54, EC-1~~25), §4·§4.5 일치, digest F1~F10 일치, 범위 초과·수정 금지 위반 없음. test-runner PASS — format·lint·typecheck, `bun run test` 3회 442/442, build, `test:fork` 23/23, F10+F4 verbose 66/66. e2e-runner PASS — `test:e2e` 38/38(skip 0), 단독 `check:build` 통과, ETH→USDC 스냅샷 화면 텍스트 `·` 0개(증거 `scratchpad/verify2-e2e/dod43-eth-usdc-fullpage.png`). DoD-54는 코드 대조 충족(사용자 확정 제외), 나머지 항목은 1차 표와 같이 코드 대조 충족 + 실행 확인됨 → 종합 충족
- Low 관찰(2차): 1차 (1)(2)와 같음
- 아래는 DoD-54 반영 전(2026-11-23 1차) 검증 결과다. 갱신 뒤 7단계를 다시 수행한다

- 코드 기준: HEAD 523f938 + 커밋 전 작업 트리(2026-11-23). 검증 전후 `git status`·내용 해시 동일
- 스펙 대조: 새 general-purpose + `seongho:verify` — PASS(충족 78, 부분·미충족·검증 불가 0, §4 계약 일치, 골자 digest `bfb3eb0d0b7d717d`·F1~F9 일치, 범위 초과·수정 금지 위반 없음)
- 실행: seongho:test-runner — PASS(format·lint·typecheck, `bun run test` 3회 442/442, build, `test:fork` 23/23, F10 verbose 59/59), seongho:e2e-runner — PASS(`test:e2e` 38/38, skip 0, 단독 `check:build` 통과)
- 구현 중 결함: T-12에서 EC-14 간헐 실패 → 읽기 전용 분석으로 제품 결함 분류 → T-4 수정 1/3(렌더 시점 allowance 캐시 우선) → 부하 반복과 3회 전체 실행 통과
- Low 관찰(통과를 막지 않음): (1) §4.3 `hasL1DataFee`의 구현 이름은 `HAS_L1_DATA_FEE_BY_CHAIN`(의미 동일, 계획 §1 명시) (2) F5 주 버튼은 approve 성공 직후 한 커밋 동안 이전 allowance로 `approve-required`를 보일 수 있음(기존 결함, 범위 밖, F10 수수료 행은 캐시 우선으로 영향 없음) (3) `ratioPercent`만 `Number` 변환(§4.1 `number` 계약) (4) EC-5는 재시도 금지로 해석, 실패 뒤 60초 주기 갱신은 계속 (5) F10 ETH 잔액 observer는 idle에서 다시 활성화될 때 한 번 읽음
- 미검증: Base·Arbitrum 실제 추정값과 L1 수수료, 지갑 실제 수수료와의 일치, 실제 브라우저 타이머 스로틀링, WAF 120건/60초(산정만), 메인넷 수동 확인(스펙 비목표)

| 스펙 항목 | 코드 대조 (`verify`) | 실행 확인                                                                                                    | 종합 |
| --------- | -------------------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| DoD-1     | 충족                 | 확인됨: Vitest F10 case `[DoD-1]`(3회 통과)                                                                  | 충족 |
| DoD-2     | 충족                 | 확인됨: Vitest F10 case `[DoD-2]`(3회 통과)                                                                  | 충족 |
| DoD-3     | 충족                 | 확인됨: Vitest F10 case `[DoD-3]`(3회 통과)                                                                  | 충족 |
| DoD-4     | 충족                 | 확인됨: Vitest F10 case `[DoD-4]`(3회 통과)                                                                  | 충족 |
| DoD-5     | 충족                 | 확인됨: Vitest F10 case `[DoD-5]`(3회 통과)                                                                  | 충족 |
| DoD-6     | 충족                 | 확인됨: Vitest F10 case `[DoD-6]`(3회 통과)                                                                  | 충족 |
| DoD-7     | 충족                 | 확인됨: Vitest F10 case `[DoD-7]`(3회 통과)                                                                  | 충족 |
| DoD-8     | 충족                 | 확인됨: `test:fork` network-fee.fork                                                                         | 충족 |
| DoD-9     | 충족                 | 확인됨: `test:fork` network-fee.fork                                                                         | 충족 |
| DoD-10    | 충족                 | 코드 대조 전용(사용자 확정 제외)                                                                             | 충족 |
| DoD-11    | 충족                 | 확인됨: Vitest F10 case `[DoD-11]`(3회 통과)                                                                 | 충족 |
| DoD-12    | 충족                 | 확인됨: Vitest F10 case `[DoD-12]`(3회 통과)                                                                 | 충족 |
| DoD-13    | 충족                 | 확인됨: Vitest F10 case `[DoD-13]`(3회 통과)                                                                 | 충족 |
| DoD-14    | 충족                 | 확인됨: Vitest F10 case `[DoD-14]`(3회 통과)                                                                 | 충족 |
| DoD-15    | 충족                 | 확인됨: Vitest F10 case `[DoD-15]`(3회 통과)                                                                 | 충족 |
| DoD-16    | 충족                 | 확인됨: Vitest F10 case `[DoD-16]`(3회 통과)                                                                 | 충족 |
| DoD-17    | 충족                 | 확인됨: Vitest F10 case `[DoD-17]`(3회 통과)                                                                 | 충족 |
| DoD-18    | 충족                 | 확인됨: Vitest F10 case `[DoD-18]`(3회 통과)                                                                 | 충족 |
| DoD-19    | 충족                 | 코드 대조 전용(사용자 확정 제외)                                                                             | 충족 |
| DoD-20    | 충족                 | 확인됨: Vitest F10 case `[DoD-20]`(3회 통과)                                                                 | 충족 |
| DoD-21    | 충족                 | 확인됨: Vitest F10 case `[DoD-21]`(3회 통과)                                                                 | 충족 |
| DoD-22    | 충족                 | 확인됨: Vitest F10 case `[DoD-22]`(3회 통과)                                                                 | 충족 |
| DoD-23    | 충족                 | 확인됨: Vitest F10 case `[DoD-23]`(3회 통과)                                                                 | 충족 |
| DoD-24    | 충족                 | 확인됨: Vitest F10 case `[DoD-24]`(3회 통과)                                                                 | 충족 |
| DoD-25    | 충족                 | 확인됨: Vitest F10 case `[DoD-25]`(3회 통과)                                                                 | 충족 |
| DoD-26    | 충족                 | 확인됨: Vitest F10 case `[DoD-26]`(3회 통과)                                                                 | 충족 |
| DoD-27    | 충족                 | 확인됨: Vitest F10 case `[DoD-27]`(3회 통과)                                                                 | 충족 |
| DoD-28    | 충족                 | 확인됨: Vitest F10 case `[DoD-28]`(3회 통과)                                                                 | 충족 |
| DoD-29    | 충족                 | 확인됨: Vitest F10 case `[DoD-29]`(3회 통과)                                                                 | 충족 |
| DoD-30    | 충족                 | 확인됨: Vitest F10 case `[DoD-30]`(3회 통과)                                                                 | 충족 |
| DoD-31    | 충족                 | 확인됨: Vitest F10 case `[DoD-31]`(3회 통과)                                                                 | 충족 |
| DoD-32    | 충족                 | 확인됨: Vitest F10 case `[DoD-32]`(3회 통과)                                                                 | 충족 |
| DoD-33    | 충족                 | 확인됨: Vitest F10 case `[DoD-33]`(3회 통과)                                                                 | 충족 |
| DoD-34    | 충족                 | 확인됨: Vitest F10 case `[DoD-34]`(3회 통과)                                                                 | 충족 |
| DoD-35    | 충족                 | 확인됨: Vitest F10 case `[DoD-35]`(3회 통과)                                                                 | 충족 |
| DoD-36    | 충족                 | 확인됨: Vitest F10 case `[DoD-36]`(3회 통과)                                                                 | 충족 |
| DoD-37    | 충족                 | 확인됨: Vitest F10 case `[DoD-37]`(3회 통과)                                                                 | 충족 |
| DoD-38    | 충족                 | 확인됨: Vitest F10 case `[DoD-38]`(3회 통과)                                                                 | 충족 |
| DoD-39    | 충족                 | 확인됨: Vitest F10 case `[DoD-39]`(3회 통과)                                                                 | 충족 |
| DoD-40    | 충족                 | 확인됨: Vitest F10 case `[DoD-40]`(3회 통과)                                                                 | 충족 |
| DoD-41    | 충족                 | 코드 대조 전용(사용자 확정 제외)                                                                             | 충족 |
| DoD-42    | 충족                 | 확인됨: `test:e2e` network-fee.spec `[DoD-42]`                                                               | 충족 |
| DoD-43    | 충족                 | 확인됨: `test:e2e` network-fee.spec `[DoD-43]`                                                               | 충족 |
| DoD-44    | 충족                 | 확인됨: `test:e2e` network-fee.spec `[DoD-44]`                                                               | 충족 |
| DoD-45    | 충족                 | 확인됨: 기존 테스트 전체(`bun run test` 3회 442/442, `test:fork` 23/23, `test:e2e` 38/38), F1~F9 digest 일치 | 충족 |
| DoD-46    | 충족                 | 코드 대조 전용(사용자 확정 제외)                                                                             | 충족 |
| DoD-47    | 충족                 | 코드 대조 전용(사용자 확정 제외)                                                                             | 충족 |
| DoD-48    | 충족                 | 코드 대조 전용(사용자 확정 제외)                                                                             | 충족 |
| DoD-49    | 충족                 | 확인됨: Vitest F10 case `[DoD-49]`(3회 통과)                                                                 | 충족 |
| DoD-50    | 충족                 | 확인됨: Vitest F10 case `[DoD-50]`(3회 통과)                                                                 | 충족 |
| DoD-51    | 충족                 | 확인됨: Vitest F10 case `[DoD-51]`(3회 통과)                                                                 | 충족 |
| DoD-52    | 충족                 | 확인됨: Vitest F10 case `[DoD-52]`(3회 통과)                                                                 | 충족 |
| DoD-53    | 충족                 | 확인됨: Vitest F10 case `[DoD-53]`(3회 통과)                                                                 | 충족 |
| EC-1      | 충족                 | 확인됨: Vitest F10 case `[EC-1]`(3회 통과)                                                                   | 충족 |
| EC-2      | 충족                 | 확인됨: Vitest F10 case `[EC-2]`(3회 통과)                                                                   | 충족 |
| EC-3      | 충족                 | 확인됨: Vitest F10 case `[EC-3]`(3회 통과)                                                                   | 충족 |
| EC-4      | 충족                 | 확인됨: Vitest F10 case `[EC-4]`(3회 통과)                                                                   | 충족 |
| EC-5      | 충족                 | 확인됨: Vitest F10 case `[EC-5]`(3회 통과)                                                                   | 충족 |
| EC-6      | 충족                 | 확인됨: Vitest F10 case `[EC-6]`(3회 통과)                                                                   | 충족 |
| EC-7      | 충족                 | 확인됨: Vitest F10 case `[EC-7]`(3회 통과)                                                                   | 충족 |
| EC-8      | 충족                 | 확인됨: Vitest F10 case `[EC-8]`(3회 통과)                                                                   | 충족 |
| EC-9      | 충족                 | 확인됨: Vitest F10 case `[EC-9]`(3회 통과)                                                                   | 충족 |
| EC-10     | 충족                 | 확인됨: Vitest F10 case `[EC-10]`(3회 통과)                                                                  | 충족 |
| EC-11     | 충족                 | 확인됨: Vitest F10 case `[EC-11]`(3회 통과)                                                                  | 충족 |
| EC-12     | 충족                 | 확인됨: Vitest F10 case `[EC-12]`(3회 통과)                                                                  | 충족 |
| EC-13     | 충족                 | 확인됨: Vitest F10 case `[EC-13]`(3회 통과)                                                                  | 충족 |
| EC-14     | 충족                 | 확인됨: Vitest F10 case `[EC-14]`(3회 통과)                                                                  | 충족 |
| EC-15     | 충족                 | 확인됨: Vitest F10 case `[EC-15]`(3회 통과)                                                                  | 충족 |
| EC-16     | 충족                 | 확인됨: Vitest F10 case `[EC-16]`(3회 통과)                                                                  | 충족 |
| EC-17     | 충족                 | 확인됨: Vitest F10 case `[EC-17]`(3회 통과)                                                                  | 충족 |
| EC-18     | 충족                 | 확인됨: Vitest F10 case `[EC-18]`(3회 통과)                                                                  | 충족 |
| EC-19     | 충족                 | 확인됨: Vitest F10 case `[EC-19]`(3회 통과)                                                                  | 충족 |
| EC-20     | 충족                 | 확인됨: Vitest F10 case `[EC-20]`(3회 통과)                                                                  | 충족 |
| EC-21     | 충족                 | 확인됨: Vitest F10 case `[EC-21]`(3회 통과)                                                                  | 충족 |
| EC-22     | 충족                 | 확인됨: Vitest F10 case `[EC-22]`(3회 통과)                                                                  | 충족 |
| EC-23     | 충족                 | 확인됨: Vitest F10 case `[EC-23]`(3회 통과)                                                                  | 충족 |
| EC-24     | 충족                 | 확인됨: Vitest F10 case `[EC-24]`(3회 통과)                                                                  | 충족 |
| EC-25     | 충족                 | 확인됨: Vitest F10 case `[EC-25]`(3회 통과)                                                                  | 충족 |
