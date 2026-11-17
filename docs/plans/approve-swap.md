# 계획: approve-swap

- 상태: 승인
- 스펙: docs/specs/approve-swap.md
- 기준 코드: 68f074a + 작업 트리
- 최종 갱신: 2026-11-15

## 1. 구현 전략

- 순서는 사전 확인, config·순수 함수, allowance 데이터 계층, 실행 상태 계층, 주 버튼, 테스트(단위·지원 확장·통합·포크·F2/F3 회귀·E2E), 수동 확인과 전체 검사다. 근거: `docs/plans/quote.md:241-249`
- 스펙의 구현 전 확인 사실 3건과 포크·E2E 체결이 기대는 체인 사실은 사전 확인 Task가 저장소 밖 전용 포트 anvil과 공개 RPC 읽기로 확인한다. 어긋나면 인터뷰로 되돌린다. 근거: `docs/plans/quote.md:24-36`
- `swapRouter02`는 `ChainContracts` 타입과 체인별 상수에 더한다. SwapRouter02 로컬 ABI는 QuoterV2·Pool ABI가 있는 관심사별 config에 둔다. allowance 초기화 대상 목록은 고정 스테이블 주소처럼 토큰 config에 체인별 주소로 둔다. ERC-20은 viem `erc20Abi`를 쓴다. 근거: `config/contracts.ts:7-37`, `config/uniswap-v3.ts:24-50`, `config/tokens.ts:26-45`
- 판정·조립 로직은 `lib/`의 신규 순수 함수 두 파일로 나눈다. `lib/primary-button-state.ts`는 스펙 상태 순서의 판정과 활성 여부를 맡고 입력 판정은 기존 `getSwapInputState`, ETH 판정은 `isNativeToken`, 등급은 `getPriceImpactSeverity`를 재사용한다. `lib/swap-transaction.ts`는 approve 금액 선택, `exactInputSingle` 인자(WETH 치환은 `resolveQuoteTokens`), `multicall` 인코딩, deadline 계산을 맡는다. F2·F3 단위 테스트가 import하는 `lib/swap-input-state.ts`의 기존 함수는 바꾸지 않는다. 근거: `lib/swap-input-state.ts:53-98`, `lib/swap-quote.ts:67-84`, `lib/quote-format.ts:29`, `lib/token-amount.ts:90`
- allowance 읽기는 카드 잔액 훅 패턴을 따라 선택 체인 클라이언트(`config.getClient`)의 `withoutMulticallBatching` 사본으로 `readContract` 1회를 보낸다. 배치가 켜지면 aggregate3로 묶여 스텁 분류·요청 수가 달라진다. `retry: false`, 주기 없음, `refetchOnWindowFocus: false`에 window `focus` 리스너, reconnect 재읽기 끔이다. queryKey는 상수, chainId, 계정, 소문자 토큰 주소, spender이며 bigint가 없다. 마지막 성공 값 유지는 react-query `data` 유지로 한다. 근거: `hooks/use-token-balance.ts:24-62`, `lib/token-balances.ts:23-48`, `hooks/use-swap-quote-read.ts:46-56`
- 조회 훅은 Provider 한 곳에서만 호출하고 버튼·실행 계층·F6·F7은 컨텍스트만 읽는다(호출마다 focus 리스너가 생기는 문제는 F3 견적 Provider와 같은 이유). `TokenAllowanceProvider`(`useTokenAllowance()`)와 `SwapExecutionProvider`(`useSwapExecution()`)는 `SwapQuoteProvider` 안쪽에 이 순서로 둔다. Provider 밖 호출은 throw한다. 근거: `providers/app-providers.tsx:27-36`, `providers/swap-quote-provider.tsx:105-109`, `docs/plans/quote.md:11`
- 전송은 `wagmi/actions`의 `writeContract`에 클릭 시점 선택 체인 `chainId`를 넘겨 viem이 지갑 체인 일치를 assert하게 한다. simulate하지 않으므로 USDT 반환값 디코딩 문제를 피한다(T-1에서 확인). 가스 추정과 전송은 지갑이 맡는다(`eth_chainId`, `eth_sendTransaction`). 근거: `node_modules/@wagmi/core/src/actions/writeContract.ts:77-122`, `node_modules/viem/actions/wallet/sendTransaction.ts:222-268`
- 영수증은 트랜잭션 체인의 `config.getClient({ chainId })`에 viem `waitForTransactionReceipt`를 시간 제한 없이 써서 프록시로 읽고 `receipt.status`로 판정한다. wagmi 버전은 revert일 때 `eth_getTransactionByHash`·`eth_call`을 추가로 보낸다. 프록시 허용 메서드는 바꾸지 않는다. 근거: `node_modules/@wagmi/core/src/actions/waitForTransactionReceipt.ts:50-90`, `node_modules/viem/actions/public/waitForTransactionReceipt.ts:191,248-275`, `config/rpc.ts:5-19`
- 실행 상태는 `phase`·`pendingTx` state, 중복 실행 방지 ref 잠금(리렌더 전 두 번째 클릭), 클릭 시점 값 스냅샷, F3 revision 같은 실행 세대 ref(계정 변경·해제 뒤 늦은 결과 폐기)로 이룬다. 체인 확인은 `useEnsureChain()`을 전송 전에 await하고, 확인 뒤 최신 선택 체인을 클릭 시점 체인과 비교한다. 근거: `hooks/use-ensure-chain.ts:28-46`, `providers/selected-chain-provider.tsx:44`, `providers/swap-quote-provider.tsx:57-71`
- 체결 뒤 다시 읽기는 react-query `invalidateQueries`로 카드 잔액·allowance 키 접두어(키 상수, 트랜잭션 체인, 계정)를 무효화하고, 영수증 성공 시 allowance 재읽기 Promise가 끝난 뒤 phase를 되돌린다. 금액 비우기는 ref로 잡은 최신 `useSwapFormActions().setAmountInput("")`로 한다(빈 문자열은 형식 통과, F2 Provider 불변). 근거: `hooks/use-token-balance.ts:13-15,33`, `providers/swap-form-provider.tsx:141-152`, `lib/token-amount.ts:14,52-60`, `providers/app-providers.tsx:45`
- jsdom에서 mock 커넥터의 `eth_sendTransaction`은 체인 기본 RPC URL로 fetch되어 스텁 라우트가 없으므로, 전송 통합 테스트는 스텁 EIP-1193 커넥터(`setHandler`)를 쓰고 읽기 판정 테스트는 mock 커넥터를 써도 된다. E2E에서는 mock 커넥터가 `eth_sendTransaction`을 anvil(8546)로 직접 보낸다. 근거: `node_modules/@wagmi/core/src/connectors/mock.ts:159-166,328-335`, `__tests__/support/wagmi-harness.tsx:39-49`, `__tests__/support/stub-eip1193.ts:140`, `config/e2e-mock.ts:69-76`
- RPC 스텁은 지금 allowance `eth_call`과 영수증 계열을 `other`로 분류해 -32601로 응답한다. 새 분류를 추가만 하고 기존 분류·export·`notBalance` 의미는 바꾸지 않는다. 근거: `__tests__/support/rpc-balance-stub.ts:345-348,544-586`
- F2·F3 회귀 갱신은 F3 T-9 방식을 따른다. 동결 골격은 assertion만 바꾸고 사용자 결정이 있을 때만 `@then`과 it 이름을 바꾼 뒤 골자 digest를 기록한다. 대부분의 F2·F3 통합 테스트는 보내는 토큰이 ETH라 allowance가 `idle`이어서 영향이 없다. 확인된 대상은 ERC-20 페어 표본이 `quote-ready`를 단정하는 F2 EC-25 case와 E2E 상태 정규식이다. 근거: `docs/plans/quote.md:149-165`, `__tests__/swap/primary-button.test.tsx:439-470`, `e2e/support/app.ts:55-69`
- 쓰기 격리는 E2E가 Playwright `workers: 1`과 러너→anvil `evm_snapshot`/`evm_revert`, 포크 테스트가 `vitest.fork.config.mts` 파일 순차 실행과 testClient snapshot/revert다. 근거: `playwright.config.ts:33-44`, `vitest.fork.config.mts`, `__tests__/fork/token-balances.fork.test.ts:181-196`, `e2e/support/anvil.ts:143-153`
- mock 경계는 F3·F4 관례를 따르고, 새 경계(allowance·영수증 스텁, 지갑 전송 핸들러, E2E 거부 주입, pending 관찰)는 테스트 설계 단계에서 사용자가 확정한다. 근거: `docs/plans/quote.md:111`, `docs/plans/slippage.md:112`

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: 스펙의 구현 전 확인 사실과 포크·E2E 체결 테스트가 기대는 체인 사실을 실행으로 확인한다
- 선행: 없음
- 연결 항목: DoD-2, DoD-3, DoD-4, DoD-13, DoD-15, DoD-18, DoD-26, EC-12
- 수정 대상: 없음. 저장소 밖에서 전용 포트(8546·8547 외, 예: 8555) anvil 포크와 공개 RPC 읽기로 확인한다
- 따라야 할 패턴: 저장소 밖에서 확인하고 결과는 구현 기록에 남긴다 — 근거: `docs/plans/quote.md:24-36`
- 완료 조건: 아래 결과를 구현 기록에 남기고, 스펙 확인 사실과 어긋나면 인터뷰로 되돌린다. (1) 포크 블록 Ethereum과 Base·Arbitrum 공개 RPC에서 라우터 주소의 코드 존재 (2) `multicall(uint256,bytes[])`·`exactInputSingle` 7필드 튜플 selector와 세 체인 라우터 코드의 디스패치 포함 여부 (3) 포크 블록 Ethereum USDT `approve`의 반환 데이터 없음, `erc20Abi` simulate 디코딩 실패와 calldata 전송 성공, 0이 아닌 allowance 위 0이 아닌 approve의 revert (4) mock 계정(anvil 0번)에 USDC를 주입한 뒤 USDC→DAI approve(max)와 `multicall(deadline, [exactInputSingle])` 체결, 선택 티어, 수령량 ≥ 최소 수령량, 표본 금액의 가격 영향 등급과 최소 수령량 0 여부 (5) 포크 블록 timestamp와 클라이언트 시각+1800의 관계 (6) `evm_snapshot`/`evm_revert`(revert한 id 재사용 가능 여부)와 `evm_setAutomine` 사용 가능 여부 (7) 브라우저 출처 요청에 대한 anvil CORS 응답 (8) F1~F4 E2E 주입 토큰(USDC, LINK, DAI)과의 겹침과 snapshot/revert 아래 영향 — 검증: 확인 절차
- 실행 명령: `anvil --fork-url $ETH_MAINNET_RPC_URL --fork-block-number 26250000 --port 8555`, `cast code`, `cast sig`, `cast call`, `cast send --unlocked`, `cast rpc`
- 수정 금지: 저장소 파일
- 구현 기록: general-purpose(조사 전용 에이전트 없음), 저장소 수정 없음, anvil 8555(종료 확인). 2026-11-16. (1) 포크 블록 26250000 Ethereum·Base(mainnet.base.org, 블록 ~58199120)·Arbitrum(arb1.arbitrum.io, 블록 ~524740021) 라우터 코드 24497바이트, `factory()`·`WETH9()`가 config와 일치 (2) `multicall(uint256,bytes[])` `0x5ae401dc`, `exactInputSingle` 7필드 `0x04e45aaf`, 세 체인 디스패치에 각 1회, v1 8필드 `0x414bf389` 0회 (3) USDT approve 반환 데이터 없음, `erc20Abi` simulate는 `AbiDecodingZeroDataError`, writeContract 전송 성공, 0이 아닌 allowance 위 0이 아닌 approve는 estimateGas revert·직접 gas 지정 시 영수증 reverted, approve(0) 후 approve(max) 성공 (4) USDC→DAI 선택 티어 100(10000 티어 유동성 소진), USDC 5: amountOut 4999293837387471838, 가격 영향 normal, 최소 수령량(50bps) 4974297368200534478, 체결 시 USDC −5000000·DAI +amountOut 정확히 일치. USDC→DAI에서 최소 수령량 0 표본 없음(1 raw는 no-route) (5) 포크 timestamp 1792694303, 클라이언트 시각이 약 24.7일 앞서 deadline 통과, 과거 deadline은 `Transaction too old` revert (6) `evm_revert`는 실패 시 throw 없이 false, id 재사용 불가, 바깥 snapshot revert 시 안쪽 무효, `evm_setAutomine` 사용 가능 (7) anvil CORS `access-control-allow-origin: *` (8) 기존 E2E는 USDC(swap-form)·DAI 1000(quote) 절대값 주입, DAI는 증감으로 판정 필요, revert하지 않으면 USDC allowance max−amountIn이 남아 DoD-26 전제가 깨짐. 주의: 스왑 뒤 USDC allowance는 max−amountIn, mock 계정(anvil 0번)에 포크 블록의 EIP-7702 위임 코드 있음(ERC-20 흐름 영향 없음, F7에서 재확인), cold 포크 USDC→DAI 견적 약 9초(E2E 예열 필요), 상류 RPC 일시 503 1회. 스펙 확인 사실과 어긋난 점 없음

### T-2 — config와 순수 함수

- 사이드: 프론트
- 상태: 완료
- 목적: 라우터 주소·ABI·초기화 대상 목록 config와 주 버튼 상태 판정·전송 인자 조립 순수 함수를 만든다
- 선행: 없음
- 연결 항목: DoD-1, DoD-2, DoD-5, DoD-6, DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-13, DoD-15, DoD-16, DoD-17, DoD-18, EC-12, EC-14
- 수정 대상: `config/contracts.ts` — 타입 필드와 세 체인 값 추가. `config/tokens.ts` — 체인별 allowance 초기화 대상 주소 목록 export 추가. `config/uniswap-v3.ts` — SwapRouter02 로컬 ABI 추가. `lib/swap-transaction.ts` — 신규, approve 금액 선택, `exactInputSingle` 인자 조립, `multicall` calldata 인코딩, deadline 상수와 계산. `lib/primary-button-state.ts` — 신규, 주 버튼 상태 타입과 판정·활성 함수
- 따라야 할 패턴: 관심사별 config, 출처 주석, `lib/` 순수 함수, kebab-case 파일명과 named export — 근거: `config/contracts.ts`, `config/uniswap-v3.ts:23-50`, `lib/swap-input-state.ts`, `CLAUDE.md`
- 완료 조건: 연결 항목 충족. 기존 주소·export 불변. 판정 함수는 지갑 상태, phase, 입력 상태, 견적 상태, ETH 페어 여부, 등급, 최소 수령량, allowance 상태를 입력으로 받고 React·wagmi를 import하지 않는다. allowance `idle`이 ERC-20 페어 견적 success와 함께 오는 조합(스펙상 발생 불가)의 매핑을 구현 기록에 남긴다(F3 T-2 선례). deadline은 현재 시각을 인자로 받고 초 단위 변환 방식을 구현 기록에 남긴다 — 검증: T-6, T-9, T-11
- 실행 명령: `bun run typecheck`, `bun run test __tests__/lib __tests__/config`
- 수정 금지: `lib/swap-input-state.ts`, `lib/swap-quote.ts`, `lib/quote-format.ts`, `lib/token-amount.ts`, `components/`, `providers/`, `hooks/`
- 구현 기록: seongho:frontend-dev, 작성 영역 `config/contracts.ts`·`config/tokens.ts`·`config/uniswap-v3.ts`(추가만), `lib/swap-transaction.ts`·`lib/primary-button-state.ts`(신규). 수정 0/3. 발생 불가 조합 매핑: allowance `idle`+ERC-20 success, allowance success인데 값·amountInRaw null → `checking-allowance`, 입력 유효+견적 idle → `quoting`, 등급 null은 error 아님, 최소 수령량 null은 0n 아님(`lib/primary-button-state.ts:59-69`). deadline은 `getSwapDeadline(nowMs)` = `floor(nowMs/1000)+1800`(호출자가 전송 직전 `Date.now()` 전달). `isPrimaryButtonEnabled`는 `disconnected`도 활성(F1 동작 유지). 오케스트레이터 확인: 수정 범위 일치, typecheck 통과, `test __tests__/lib __tests__/config` 55 통과·3 todo

### T-3 — allowance 데이터 계층

- 사이드: 프론트
- 상태: 완료
- 목적: allowance 읽기 함수, 조회 훅, `TokenAllowanceProvider`와 `useTokenAllowance()`를 만들고 앱에 마운트한다
- 선행: T-2
- 연결 항목: DoD-9, DoD-10, DoD-11, DoD-12, EC-14, EC-15, EC-16, EC-17
- 수정 대상: `lib/token-allowance.ts` — 신규, 배치를 끈 클라이언트로 `allowance` `eth_call` 1회. `hooks/use-token-allowance-read.ts` — 신규, 조회 훅, 키 상수 export, focus 리스너, 다시 읽기 Promise 노출. `providers/token-allowance-provider.tsx` — 신규, Provider와 `useTokenAllowance()`, Provider 밖 throw. `providers/app-providers.tsx` — `SwapQuoteProvider` 안쪽에 마운트
- 따라야 할 패턴: 카드 잔액 조회 훅, Provider와 훅을 한 파일에 두는 방식 — 근거: `hooks/use-token-balance.ts:24-62`, `lib/token-balances.ts:23-48`, `providers/swap-quote-provider.tsx`
- 완료 조건: 연결 항목 충족. spender는 선택 체인 라우터 주소다. 보내는 토큰이 ETH이거나 미연결·복원 중이면 쿼리가 비활성이다. queryKey에 bigint와 금액이 없다. 주기·reconnect 재읽기가 없다. F2 잔액 읽기 동작은 바뀌지 않는다 — 검증: T-8
- 실행 명령: `bun run typecheck`, `bun run test __tests__/swap __tests__/wallet`
- 수정 금지: `hooks/use-token-balance.ts`, `lib/token-balances.ts`, `providers/swap-form-provider.tsx`, `providers/swap-quote-provider.tsx`, `config/rpc.ts`, `lib/rpc-proxy.ts`, `components/`, T-2 파일
- 구현 기록: seongho:frontend-dev, 작성 영역 `lib/token-allowance.ts`·`hooks/use-token-allowance-read.ts`·`providers/token-allowance-provider.tsx`(신규), `providers/app-providers.tsx`(마운트). 수정 0/3. T-4용 export: `TOKEN_ALLOWANCE_QUERY_KEY`, `getTokenAllowanceQueryKeyPrefix(chainId, owner)`, `getTokenAllowanceQueryKey`, `invalidateTokenAllowance(queryClient, chainId, owner)`(활성 쿼리 재읽기 완료까지 await, 실패해도 reject 안 함). 구현 판단: 성공 값 없이 `error`인 키를 포커스로 다시 읽는 동안 `error` 유지(F3 견적 관례) — 스펙 DoD-9 문자 해석(읽는 중이면 loading)과 다를 수 있어 7단계 대조 대상. 오케스트레이터 확인: 수정 범위 일치, typecheck 통과, `test __tests__/swap __tests__/wallet` 121 통과·40 todo(F2 EC-25 USDC→DAI 영향 없음)

### T-4 — 실행 상태 계층

- 사이드: 프론트
- 상태: 완료
- 목적: approve·swap 전송, 진행 상태, 영수증 후처리를 맡는 `SwapExecutionProvider`와 `useSwapExecution()`을 만들고 앱에 마운트한다
- 선행: T-3
- 연결 항목: DoD-13, DoD-14, DoD-15, DoD-16, DoD-17, DoD-19, DoD-20, DoD-21, DoD-22, DoD-23, DoD-24, DoD-25, DoD-30, EC-1, EC-2, EC-3, EC-4, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13, EC-15, EC-18, EC-19, EC-20, EC-21
- 수정 대상: `providers/swap-execution-provider.tsx` — 신규, phase·pendingTx, 잠금, 클릭 시점 스냅샷, 체인 확인과 체인 비교, `writeContract`, 영수증 대기, 무효화, 금액 비우기, 실행 세대. `providers/app-providers.tsx` — `TokenAllowanceProvider` 안쪽에 마운트
- 따라야 할 패턴: Provider와 훅을 한 파일에 두는 방식, 호출 시점 값은 ref로 읽는 방식, `wagmi/actions` 직접 호출 — 근거: `providers/selected-chain-provider.tsx:36-44`, `hooks/use-ensure-chain.ts:28-46`, `providers/swap-quote-provider.tsx`
- 완료 조건: 연결 항목 충족. simulate를 쓰지 않는다. 전송에 클릭 시점 체인 `chainId`를 넘긴다. 영수증은 트랜잭션 체인 클라이언트로 시간 제한 없이 읽는다. approve 체결 뒤 swap을 자동으로 보내지 않는다. 무효화는 키 접두어로 하고 모달 목록 잔액 쿼리는 건드리지 않는다. 금액 비우기는 선택 체인과 계정이 그 트랜잭션과 같을 때만 한다. `approve`·`swap` 내부 오류는 모두 잡아 phase로만 드러낸다 — 검증: T-9, T-10
- 실행 명령: `bun run typecheck`, `bun run test __tests__/swap __tests__/wallet`
- 수정 금지: `providers/swap-form-provider.tsx`, `providers/swap-quote-provider.tsx`, `providers/token-allowance-provider.tsx`, `hooks/use-ensure-chain.ts`, `hooks/use-token-balance.ts`, `config/`, `lib/`, `components/`
- 구현 기록: seongho:frontend-dev(T-3 작성 에이전트 이어서), 작성 영역 `providers/swap-execution-provider.tsx`(신규), `providers/app-providers.tsx`(마운트, SwapQuote > TokenAllowance > SwapExecution). 수정 0/3. 구현 판단: approve 성공 뒤 allowance만 재읽기(잔액 미재읽기), revert·reject 뒤에는 재읽기를 기다리지 않고 idle, 진행 중 페어 변경(EC-7) 뒤 성공하면 체인·계정이 같은 한 최신 보내는 칸 금액을 비움, 영수증 대기는 viem `waitForTransactionReceipt` `timeout: 0`. 오케스트레이터 확인: 수정 범위 일치, typecheck 통과, `test __tests__/swap __tests__/wallet` 121 통과·40 todo. 주의: viem 영수증 대기는 anvil automine에서 경합으로 멈출 수 있음(T-11 진단, E2E에 영향 가능)

### T-5 — 주 버튼

- 사이드: 프론트
- 상태: 완료
- 목적: 주 버튼이 F5 상태 집합으로 판정하고 문구·활성·클릭 동작을 갖게 한다
- 선행: T-4
- 연결 항목: DoD-5, DoD-6, DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-13, DoD-15, DoD-22, EC-6, EC-14, EC-16
- 수정 대상: `components/primary-button.tsx` — 판정을 `lib/primary-button-state.ts`로 바꾸고, 스펙 §1.1 문구, 두 상태만 활성, 클릭 시 `approve`/`swap` 호출
- 따라야 할 패턴: 기존 주 버튼 분기·클래스·`data-state` — 근거: `components/primary-button.tsx:20-89`, `docs/design/README.md`
- 완료 조건: 연결 항목 충족. 새 `data-testid` 없음. `restoring`·`disconnected` 분기와 SSR 첫 렌더 불변. ETH 페어 견적 success는 기존 값 그대로 비활성. approve 문구는 보내는 토큰 `symbol`을 쓴다. 프로덕션 빌드 통과 — 검증: T-8, T-10, `bun run build`
- 실행 명령: `bun run build`, `bun run lint`
- 수정 금지: `config/`, `lib/`, `providers/`, `hooks/`, `components/swap-card.tsx`
- 구현 기록: seongho:frontend-dev(T-3·T-4 작성 에이전트 이어서), 작성 영역 `components/primary-button.tsx`. 수정 0/3. 판정은 `getPrimaryButtonState(getPrimaryButtonStateParams(...))`로 `SwapExecutionProvider` EC-19 가드와 같은 입력, 컴포넌트의 `PrimaryButtonState` export를 lib 타입으로 대체(import처 없음). 오케스트레이터 확인: 수정 범위 일치, `bun run build`·`bun run lint` 통과. 참고 실행에서 F2 `primary-button.test.tsx` EC-25 USDC→DAI 1건 실패(`allowance-error` ≠ `quote-ready`, 스텁이 allowance eth_call을 -32601로 응답) — T-7·T-12 소관

### T-6 — 단위 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 라우터 주소 형식과 주 버튼 상태 판정 순서를 검증한다
- 선행: T-2
- 연결 항목: DoD-1, DoD-5
- 수정 대상: `__tests__/config/swap-router.test.ts` — 신규. `__tests__/lib/primary-button-state.test.ts` — 신규
- 따라야 할 패턴: config 주소 체크섬 검사, 순수 함수 단위 테스트 — 근거: `__tests__/config/chains.test.ts:45-91`, `__tests__/lib/swap-input-state.test.ts`
- 완료 조건: 연결 항목 판정. 주소 기대값은 스펙 §4.1의 리터럴로 두고 제품 상수로 만들지 않는다. DoD-5는 인접한 두 상태의 조건이 함께 성립하는 표본마다 앞선 상태가 나오는지를 모든 인접 경계에서 본다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/lib __tests__/config`
- 수정 금지: 제품 코드, `__tests__/config/chains.test.ts`, `__tests__/lib/swap-input-state.test.ts`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(새 인스턴스, 살 모드. 골격 작성 인스턴스가 아님), 작성 영역 `__tests__/config/swap-router.test.ts`, `__tests__/lib/primary-button-state.test.ts`. 수정 0/3. 완성 3 case, todo 0. 판정 경로는 `getPrimaryButtonStateParams` → `getPrimaryButtonState`(원래 값으로 select-token·enter-amount 공존 표본을 만들기 위해), DoD-5 case 2는 쌍 표 95행과 계약상 성립 불가 쌍 `UNREACHABLE_AFTER`(인접 경계 제외 불가), 기대 순서는 스펙 리터럴 `SPEC_ORDER`. 골자 관련 보고: case 1 앞 다섯 상태는 계약상 단독 표본이 없어 `swap-ready` 조건을 함께 둠(@then 유지). 오케스트레이터 확인: 골자 동결 유지, `test __tests__/lib __tests__/config` 58/58 통과
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: (사용자 확정) 없음(순수 함수와 정적 config만)
- 데이터 격리: 순수 함수와 정적 데이터만 사용

### T-7 — 통합 테스트 지원 확장

- 사이드: 테스트
- 상태: 완료
- 목적: RPC 스텁·지갑 스텁·하네스에 allowance, 영수증, 전송 경계를 추가만 한다. T-10 살 모드 위임에 포함해 같은 에이전트가 T-10 본문보다 먼저 수행한다(사용자 확정, F3 T-6 선례: test-dev는 독립 지원 모듈 Task를 맡지 않음)
- 선행: T-4
- 연결 항목: DoD-12, DoD-20, EC-4, EC-5, EC-14, EC-17, EC-18
- 수정 대상: `__tests__/support/rpc-balance-stub.ts` — allowance `eth_call` 분류·규칙·실패·붙잡기, 영수증 계열(`eth_getTransactionReceipt`, `eth_blockNumber`, `eth_getTransactionByHash`) 분류와 성공·revert·미발견·실패·붙잡기 규칙, 기본 규칙. `__tests__/support/stub-eip1193.ts` — `eth_sendTransaction` 기록·해시 응답 헬퍼(추가만). `__tests__/support/wagmi-harness.tsx` — 대기·디코드 헬퍼(추가만)
- 따라야 할 패턴: F3의 견적 분류 추가 방식(기존 분류·export 불변, 범위를 나눈 실패·붙잡기) — 근거: `__tests__/support/rpc-balance-stub.ts:33-36,544-586`, `docs/plans/quote.md:109`
- 완료 조건: 연결 항목에 필요한 경계 제공. 기존 분류·export·`notBalance` 의미 불변. 분류 양성 대조 수단 제공. 실패 응답은 transport 재시도 대상이 아닌 JSON-RPC 오류. 영수증 응답은 viem 포매터가 받는 형태. 디코드에 쓰는 ABI·주소는 테스트 쪽 리터럴 — 검증: T-8, T-9, T-10, T-12의 전체 실행
- 실행 명령: `bun run typecheck`, `bun run lint`
- 수정 금지: 제품 코드, 기존 테스트 파일, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(T-10 골격 작성 에이전트, T-10 살 모드 위임에 포함 — 독립 위임은 모드 밖이라 BLOCKED, 사용자 확정으로 병합). 작성 영역 `__tests__/support/rpc-balance-stub.ts`(allowance·receipt 분류, `setAllowances`·`allowanceWhen`·`failAllowanceWhen`·`holdAllowance`, `setReceiptRule`·`makeReceiptRule`·`failReceiptWhen`·`holdReceipt`, `eth_blockNumber` 요청마다 증가, `parityQuoteRule`), `__tests__/support/stub-eip1193.ts`(`installWalletTransactions`, `installChainSwitch`, `callDefault`), `__tests__/support/wagmi-harness.tsx`(`chooseChainFromDropdown`, `advanceFakeClockInSteps`, approve·swap calldata 디코드). 추가만, 기존 export·분류 불변. 수정 0/3(사용량 한도로 1회 중단 후 같은 에이전트 재개, 수정 횟수 아님). 오케스트레이터 확인: typecheck·lint 통과, T-10 18/18 통과
- 테스트 파일·runner: 수정 대상의 파일(지원 모듈), Vitest jsdom
- mock 허용 경계: F3 T-6 경계(전역 fetch URL 라우팅 스텁, 스텁 EIP-1193, `vi.mock` 금지)에 allowance·영수증 응답 스텁과 지갑 `eth_sendTransaction` 핸들러를 더한다. (사용자 확정) 기본 allowance 규칙의 값은 0이다
- 데이터 격리: 스텁은 테스트마다 새로 설치·초기화

### T-8 — 통합 테스트: 주 버튼 상태와 allowance

- 사이드: 테스트
- 상태: 완료
- 목적: ERC-20·ETH 페어의 주 버튼 상태와 allowance 읽기 조건·시점·값 유지를 실제 앱 트리에서 검증한다
- 선행: T-5, T-7
- 연결 항목: DoD-6, DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-12, EC-14, EC-15, EC-16, EC-17
- 수정 대상: `__tests__/swap/approve-swap-button.test.tsx` — 신규, 상태별 판정. `__tests__/swap/token-allowance.test.tsx` — 신규, 훅 계약·요청 조건·다시 읽기 시점·값 유지
- 따라야 할 패턴: `renderApp`·`renderAppHook`, 견적 규칙 조작(`setQuoteRule`·`holdQuote`), 요청 집계, window `focus`, 15초 가짜 타이머 — 근거: `__tests__/support/wagmi-harness.tsx:81-90`, `__tests__/swap/quote-display.test.tsx:555-650`, `__tests__/swap/quote-refresh.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-6은 보내는 ETH·받는 ETH 두 방향. DoD-7은 WETH 포함 페어 표본. DoD-12는 ETH·미연결·복원 중 표본에서 allowance 분류 요청 0건. EC-15는 견적 15초 주기·금액 변경·슬리피지 변경에서 allowance 요청이 늘지 않음과 계정·체인·토큰 변경·포커스·트랜잭션 종료에서 다시 읽음. EC-17은 포커스 다시 읽기를 붙잡은 동안과 실패시킨 뒤 두 표본. 기대값은 스텁 리터럴로 만든다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/approve-swap-button.test.tsx __tests__/swap/token-allowance.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트 파일, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/approve-swap-button.test.tsx`(8 case), `__tests__/swap/token-allowance.test.tsx`(5 case). 수정 0/3. 테스트 쪽 견적 규칙: 가격 영향 50% 규칙(500 티어 slot0 가격 1, amountOut = amountIn×0.4995), 수령량 1 raw 규칙. EC-15 비계기는 10분을 5초 단계로 진행. 오케스트레이터 확인: 골자 동결 유지, 13/13 통과
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: F3·F4 경계(실제 wagmi·Provider·화면, mock 커넥터 또는 스텁 EIP-1193, 전역 fetch URL 라우팅 스텁과 견적 aggregate3 스텁, 가짜 타이머와 DOM 이벤트, `vi.mock` 금지)에 allowance 응답·실패·붙잡기 스텁을 더한다. 트랜잭션 종료 계기는 T-7 영수증 스텁과 스텁 EIP-1193 `eth_sendTransaction` 해시 응답을 쓴다 (사용자 확정)
- 데이터 격리: 테스트마다 config 새로 생성과 스텁 초기화, `clearCookies`, QueryClient는 렌더마다 새로 생성

### T-9 — 통합 테스트: approve·swap 전송과 체결 후처리

- 사이드: 테스트
- 상태: 완료
- 목적: 전송 요청 내용, 클릭 시점 값, 체결 뒤 allowance·잔액·금액 처리, 호출 계약을 검증한다
- 선행: T-5, T-7
- 연결 항목: DoD-13, DoD-14, DoD-15, DoD-16, DoD-17, DoD-19, DoD-20, EC-11, EC-12, EC-13, EC-15, EC-19
- 수정 대상: `__tests__/swap/approve-execute.test.tsx` — 신규, approve 요청·초기화 대상 토큰·체결 뒤 상태. `__tests__/swap/swap-execute.test.tsx` — 신규, swap 요청 디코딩·deadline·체결 뒤 처리·상태 밖 호출
- 따라야 할 패턴: 스텁 EIP-1193 요청 기록과 `setHandler`, `createDeferred`, `waitUntilAdvancingFakeClock`, 요청 집계 — 근거: `__tests__/support/stub-eip1193.ts:126-160`, `__tests__/support/wagmi-harness.tsx:157-168,265-292`, `__tests__/swap/primary-button.test.tsx:35-45`
- 완료 조건: 연결 항목 판정. 전송 calldata는 테스트 쪽 ABI 리터럴로 디코딩하고 라우터·WETH 주소는 리터럴. DoD-14는 approve 체결 뒤 전송 요청 추가 0건. DoD-17은 가짜 시계를 정수 초 경계에 맞춰 반올림 방식과 무관하게 판정. DoD-20은 15초 주기 전에 두 잔액과 allowance 요청이 생김. EC-11은 서명 대기 중 견적 갱신으로 수령량이 바뀐 표본. EC-12·13은 Ethereum USDT 표본과 대조군(초기화 대상이 아닌 토큰). EC-19는 `renderAppHook`으로 상태 밖 `approve`·`swap` 호출 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/approve-execute.test.tsx __tests__/swap/swap-execute.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트 파일, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/approve-execute.test.tsx`(4 case), `__tests__/swap/swap-execute.test.tsx`(5 case). 수정 0/3. 테스트 쪽 견적 규칙 `bestTierRule`(수령량 amountIn×2+k, slot0 가격 1), amount-too-small(수령량 1, √가격 2000·2^96), price-impact-error(수령량 절반). DoD-17은 `Date`만 가짜, T = 1_900_000_000_000. 오케스트레이터 확인: 골자 동결 유지, 9/9 통과
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: T-8 경계에 스텁 EIP-1193 `eth_sendTransaction` 핸들러(해시 응답, 붙잡기), 영수증 성공·붙잡기 스텁(EC-19 진행 중 표본), 체인 전환 요청 붙잡기(EC-11 클릭과 인코딩 사이 견적 변화), `Date` 가짜 시계(DoD-17)를 더한다 (사용자 확정)
- 데이터 격리: T-8과 같음

### T-10 — 통합 테스트: 체인 확인·진행 상태·실패·동시성

- 사이드: 테스트
- 상태: 완료
- 목적: 체인 확인 순서, 진행 상태 전이, `pendingTx`, 지갑·영수증 실패, 중복 클릭, 진행 중 입력·체인·계정 변경을 검증한다
- 선행: T-5, T-7
- 연결 항목: DoD-21, DoD-22, DoD-23, DoD-24, DoD-25, DoD-30, EC-1, EC-2, EC-3, EC-4, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-15, EC-18, EC-20, EC-21
- 수정 대상: `__tests__/swap/swap-execution-progress.test.tsx` — 신규, 체인 확인·상태 전이·`pendingTx`·동시성. `__tests__/swap/swap-execution-failure.test.tsx` — 신규, 거부·가스 추정 실패·revert·영수증 대기 reject·Promise resolve
- 따라야 할 패턴: `createButtonStateRecorder`(커밋마다 상태 기록), `requestsSince`·`CHAIN_SWITCH_METHODS`, `changeAccounts`, `disconnect(config)`, 체인 선택 조작 — 근거: `__tests__/support/wagmi-harness.tsx:127-132,189-221`, `__tests__/wallet/use-ensure-chain.test.tsx`, `__tests__/swap/balances.test.tsx:808-811`
- 완료 조건: 연결 항목 판정. DoD-21은 체인 전환 요청이 전송 요청보다 앞서는 순서와 전송 체인. DoD-22는 클릭 직후 첫 커밋부터의 상태 기록. DoD-30은 allowance 다시 읽기를 붙잡은 동안 phase 유지. EC-1·2·3은 전송 요청 0건(EC-3은 전송 요청은 있으나 해시 없음)과 클릭 전 상태 복귀. EC-4·5는 allowance·잔액 재요청. EC-6은 리렌더 전 연속 클릭. EC-8은 트랜잭션 체인 경로로만 영수증 요청. EC-9는 체인을 되돌려 금액을 다시 입력한 표본. EC-18은 영수증 미발견을 가짜 타이머로 오래 진행한 표본. EC-21은 체인 전환 대기 중 선택 체인 변경 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/swap-execution-progress.test.tsx __tests__/swap/swap-execution-failure.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트 파일, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/swap/swap-execution-progress.test.tsx`(12 case), `__tests__/swap/swap-execution-failure.test.tsx`(6 case). 수정 0/3. 구현 판단: DoD-21 전송 체인은 전송 요청 시점 지갑 체인으로 판정(viem은 params에 chainId 없음), EC-21 표본은 지갑 Base·선택 Ethereum 클릭 뒤 드롭다운 Arbitrum, EC-18은 3초×620단계. 오케스트레이터 확인: 골자 동결 유지, 18/18 통과
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom
- mock 허용 경계: T-9 경계에 체인 전환 거부·실패, 서명 거부 4001, 영수증 revert·reject·붙잡기(pending), 계정 변경·연결 해제를 더한다. (사용자 확정) EC-3 가스 추정 실패는 스텁 지갑 `eth_sendTransaction`의 4001이 아닌 JSON-RPC 오류(-32000) 응답, EC-5 reject는 영수증 미발견과 `eth_getTransactionByHash` 지속 실패로 viem 재시도를 소진시키는 방식(가짜 타이머), EC-8·EC-21 체인 변경은 실제 드롭다운 조작(프로브 금지)
- 데이터 격리: T-8과 같음

### T-11 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 실제 Ethereum 포크에서 라우터 코드, approve 체결 뒤 allowance, swap 체결과 수령량, USDT 초기화 경로를 검증하고 포크 쓰기 격리를 설정한다
- 선행: T-1, T-3
- 연결 항목: DoD-2, DoD-13, DoD-18, DoD-31, EC-12
- 수정 대상: `__tests__/fork/approve-swap.fork.test.ts` — 신규. `vitest.fork.config.mts` — 파일 순차 실행 설정만 추가
- 따라야 할 패턴: 고정 블록 `getCode`, `fetchFn`을 프록시 핸들러에 연결한 읽기, 판정과 분리한 anvil 직접 상태 변경과 snapshot/revert — 근거: `__tests__/fork/fork.fork.test.ts:40-62`, `__tests__/fork/token-balances.fork.test.ts:181-196`, `__tests__/fork/swap-quote.fork.test.ts`
- 완료 조건: 연결 항목 판정. 전송 calldata는 제품 `lib/swap-transaction.ts` 함수로 만들고 체결은 anvil 계정 전송으로 한다. allowance 판정은 프록시를 거친 제품 읽기 함수로 한다. 수령량 기대는 같은 블록의 anvil 직접 견적에서 만든다. EC-12는 0이 아닌 allowance 위의 0이 아닌 approve가 revert하는 전제를 대조로 둔다. 표본 페어·금액은 T-1 (3)(4) 결과를 쓴다. 기존 포크 테스트 8개가 순차 실행에서도 통과한다 — 검증: 테스트, 명령
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드, 기존 `__tests__/fork/` 파일, `vitest.fork.config.mts`의 순차 실행 외 설정, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: seongho:test-dev(골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/fork/approve-swap.fork.test.ts`(5 case), `vitest.fork.config.mts`(`fileParallelism: false`만). 수정 1/3 — 원인: 준비 헬퍼의 viem `waitForTransactionReceipt`가 anvil automine에서 경합으로 멈춤(첫 영수증 null → 교체 확인용 포크 블록 조회 중 채굴된 블록 이벤트를 건너뛰고 이후 블록이 없어 무한 대기, 오케스트레이터 재현), anvil `eth_getTransactionReceipt` 직접 폴링 헬퍼로 교체. 구현 판단: 직접 견적은 T-1 티어 100만 호출해 T-1 수령량과 같다는 전제, 준비에 `anvil_setBalance` 추가, 각 쓰기 case 끝에 프록시 응답 정상 보조 확인. 잔여 위험: 프록시가 5초 초과 시 공개 RPC로 폴백하면 EC-12 본 case의 allowance 0 판정이 메인넷 값과 구분되지 않음. 오케스트레이터 확인: 골자 동결 유지, `bun run test:fork` 1차 2 실패(타임아웃) → 수정 후 4 파일 13/13 통과
- 테스트 파일·runner: `__tests__/fork/approve-swap.fork.test.ts`, `vitest.fork.config.mts`
- mock 허용 경계: 없음(실제 anvil 포크와 프록시 코드, `vi.stubEnv`). (사용자 확정) anvil 직접 상태 변경(`anvil_dealERC20`, 잠금 해제 계정 전송과 부분 allowance 준비, snapshot/revert)은 준비 단계에만 쓰고, 판정은 제품 함수와 프록시를 거친 읽기로 한다
- 데이터 격리: 파일 순차 실행과 테스트마다 snapshot/revert

### T-12 — F2·F3 회귀 갱신

- 사이드: 테스트
- 상태: 완료
- 목적: ERC-20 페어로 `quote-ready`를 단정하는 기존 테스트와 E2E 상태 정규식을 F5 상태 집합에 맞춘다
- 선행: T-8, T-9, T-10
- 연결 항목: DoD-5, DoD-6, DoD-7
- 수정 대상: `__tests__/swap/primary-button.test.tsx` — EC-25 USDC→DAI 표본의 주 버튼 기대만. `e2e/support/app.ts` — 주 버튼 상태 정규식 3개
- 따라야 할 패턴: 동결 골격은 assertion만 바꾸고 사용자 결정이 있을 때만 `@then`과 it 이름을 바꾸며 바뀐 F2 골자 digest를 기록한다 — 근거: `docs/plans/quote.md:149-165,263`
- 완료 조건: 연결 항목 충족. ERC-20 페어 표본에 대한 `quote-ready` 기대 0건(ETH 페어 기대는 유지). (사용자 확정) EC-25 `@then`은 "`insufficient-balance`가 아니고 견적 뒤 상태(USDC→DAI는 `approve-required`, ETH→USDC는 `quote-ready`)다"로 바꾸고 F2 골자 digest를 갱신한다. 정규식은 `QUOTE_PRIMARY_STATE`와 `settled`에 멈춘 상태(`price-impact-too-high`, `amount-too-small`, `allowance-error`, `approve-required`, `swap-ready`)만, `CONNECTED_PRIMARY_STATE`에는 일시 상태(`checking-allowance`, `awaiting-signature`, `approving`, `swapping`)까지 더한다. 그 밖의 F2·F3·F4 테스트(연결 상태 목록, `notBalance` 요청 수, WETH→ETH 표본)는 전체 실행으로 영향 없음을 확인해 기록하고, 실패하면 이 Task에 파일을 추가하기 전에 결정으로 되돌린다. jsdom 전체 3회 반복 결과가 같다 — 검증: 명령
- 실행 명령: `bun run test`(3회), `bun run test:e2e e2e/wallet.spec.ts e2e/swap-form.spec.ts e2e/quote.spec.ts e2e/slippage.spec.ts`
- 수정 금지: 제품 코드, F5 신규 테스트 파일, `__tests__/support/*`, `__tests__/lib/swap-input-state.test.ts`, 파일을 쓰는 실행 옵션(`vitest list --json` 등)
- 구현 기록: Vitest 부분 seongho:test-dev(T-8 작성 에이전트, `__tests__/swap/primary-button.test.tsx` EC-25만: `@then`을 사용자 확정 문구로, 표본별 기대 `approve-required`·`quote-ready` 대기), E2E 부분 seongho:e2e-dev(T-13 골격 작성 에이전트, `e2e/support/app.ts` 정규식 3개: `QUOTE_PRIMARY_STATE`·`settled`에 멈춘 상태 5개, `CONNECTED_PRIMARY_STATE`에 멈춘 5개+일시 4개). 수정 0/3. F2 `e2e/swap-form.spec.ts` DoD-38은 USDC→ETH(ETH 페어)라 변경 불필요. 오케스트레이터 확인: `bun run test` 3회 모두 34 파일 243/243 통과, F1~F4 E2E 4 spec 19/19 통과(재시도 0), F2 골자 digest `f2932cf895687551` → `12a88df2f0bb1e2a`(EC-25 `@then`만), F3 `8acf896e2a4dffdd`·F4 `3af643e844b77259` 유지
- 테스트 파일·runner: 수정 대상의 파일, Vitest jsdom과 Playwright chromium
- mock 허용 경계: (사용자 확정) F2·F3에서 확정한 경계 그대로. allowance 응답은 T-7 기본 규칙(0)
- 데이터 격리: F2·F3와 같음
- 실행 환경: T-13과 같음. 이 Task의 E2E 실행은 다른 E2E 실행·`check:build`와 겹치지 않게 한다

### T-13 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: 실제 브라우저·프록시·anvil에서 ERC-20 페어 approve→swap 사용자 흐름과 거부 경로를 검증하고 쓰기 격리 설정으로 E2E 전체를 통과시킨다
- 선행: T-1, T-12
- 연결 항목: DoD-26, DoD-27, EC-2
- 수정 대상: `e2e/approve-swap.spec.ts` — 신규. `e2e/support/approve-swap.ts` — 신규, locator와 흐름 헬퍼. `e2e/support/anvil.ts` — 추가만, snapshot/revert, allowance 직접 읽기. `playwright.config.ts` — `workers: 1`, E2E anvil(8546)에 `--block-time 1` 구간 채굴 추가(사용자 확정: viem 영수증 대기와 자동 채굴의 경합으로 앱이 approving·swapping에 멈추는 것을 막는다. anvil은 자동 채굴 대신 1초 구간 채굴로 바뀌고 tx는 1초 안에 채굴된다). `config/e2e-mock.ts` — 추가만, 전송 거부(4001) 제어값
- 따라야 할 패턴: `openApp`·`connectWithMock`, 절대값 주입, `beforeAll` 예열과 그 hook만의 시간 제한 연장, `page.route` 금지, `walletRequests` 기록 — 근거: `e2e/support/app.ts:71-96`, `e2e/support/anvil.ts:155-283`, `e2e/quote.spec.ts`, `config/e2e-mock.ts:24-35,103-112`
- 완료 조건: 연결 항목 판정. 잔액 증감 기대는 러너가 anvil에서 직접 읽은 값과 화면 `data-amount-out-raw`·입력 정수로 만들고 제품 함수를 쓰지 않는다. 쓰기 테스트마다 snapshot을 새로 잡고 끝에 revert한다. EC-2는 체결이 없고 잔액·allowance가 그대로이며 주 버튼이 클릭 전 상태로 돌아왔는지 본다. E2E 제어값을 추가하면 `check:build` 표식 검사가 통과한다. 쓰기 spec을 포함한 E2E 전체 통과 — 검증: 테스트, 명령
- 실행 명령: `bun run test:e2e e2e/approve-swap.spec.ts`, `bun run test:e2e`
- 수정 금지: 제품 코드(`config/e2e-mock.ts`의 전송 거부 제어값 추가 제외), automine 제어, 기존 `e2e/*.spec.ts`, `e2e/support/app.ts`, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:e2e-dev(골격 작성 에이전트, 살 모드), 작성 영역 `e2e/approve-swap.spec.ts`(2 case), `e2e/support/approve-swap.ts`(신규: `enterErc20Swap`, 거부 제어, role 메시지 관찰), `e2e/support/anvil.ts`(추가: `readErc20Allowance`, `takeAnvilSnapshot`, `revertAnvilSnapshot`), `playwright.config.ts`(`workers: 1`, anvil `--block-time 1`), `config/e2e-mock.ts`(추가: `sendTransactionError` 제어값). 수정 0/3. 참고: anvil `--block-time 1`은 자동 채굴을 1초 구간 채굴로 바꾼다(계획 문구 "자동 채굴 유지"는 부정확, tx는 1초 안에 채굴). EC-2 판정에 nonce 비교는 넣지 않고 지갑 전송 요청 1건·거부를 확인. 오케스트레이터 확인: 골자 동결 유지, `test:e2e e2e/approve-swap.spec.ts` 2/2 통과(DoD-26 8.4s, EC-2 3.0s), `bun run test:e2e` 전체 26/26 통과(1 worker, 재시도 0)
- 테스트 파일·runner: `e2e/approve-swap.spec.ts`, Playwright chromium
- mock 허용 경계: F3 T-8 경계(mock 커넥터와 E2E 전용 제어값, 러너→anvil 상태 주입·조회, `page.route` 금지)에 테스트마다 러너→anvil `evm_snapshot`/`evm_revert`, 러너→anvil allowance 읽기를 더한다. (사용자 확정) EC-2 거부 주입은 `config/e2e-mock.ts` request 래퍼에 `connectError`와 같은 방식의 전송 거부(4001) 제어값을 추가한다(E2E 전용 코드, `check:build` 표식 검사 대상). automine은 제어하지 않고 approving·swapping 관찰은 통합 테스트(T-10)가 맡는다
- 데이터 격리: 테스트별 브라우저 컨텍스트, 쓰기 테스트마다 snapshot/revert, 절대값 주입, `workers: 1`로 파일 순차 실행
- 실행 환경: 앱 `localhost:3100`(`NEXT_PUBLIC_E2E_MOCK=1` 빌드), anvil `localhost:8546`, 포크 블록과 mock 계정은 `config/e2e.ts`·`config/e2e-mock.ts` 상수, 로그인 없음, Base·Arbitrum은 대상이 아니다. `check:build`와 동시에 실행하지 않는다

### T-14 — 수동 확인과 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: Base·Arbitrum 라우터 배포와 메인넷 체결을 기록하고 전체 정합성 명령을 순차로 통과시킨다
- 선행: T-6, T-8, T-9, T-10, T-11, T-13
- 연결 항목: DoD-3, DoD-4, DoD-27, DoD-28, DoD-29, DoD-31
- 수정 대상: 없음. 결과는 이 계획의 구현 기록에 남긴다
- 따라야 할 패턴: F3·F4 수동 확인 기록 — 근거: `docs/plans/slippage.md:150-162`, `docs/plans/quote.md:167-179`
- 완료 조건: DoD-3·4는 날짜, 확인 수단, 블록, 코드 존재를 기록한다(T-1 결과 참조 가능). DoD-28·29는 사용자 지갑으로 소액 ERC-20 페어 approve와 swap tx 해시, 날짜, 페어, 금액, 수령량을 기록한다. 명령은 아래 순서로 하나씩 실행하고 `check:build`는 `test:e2e`가 끝난 뒤 따로 실행한다(같은 `.next-e2e`를 다시 빌드한다). 전부 통과 — 검증: 확인 절차, 명령
- 실행 명령: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, `bun run test:fork`, `bun run test:e2e`, `bun run check:build`
- 수정 금지: 제품 코드, 테스트 코드
- 구현 기록: 오케스트레이터(명령 실행·기록, 제품·테스트 수정 없음). 2026-11-17. 명령 순차 실행: `format:check`(1차 실패 — `docs/plans/approve-swap.md` 서식만, oxfmt 적용 후 통과), `lint` 통과, `typecheck` 통과, `test` 34 파일 243/243, `build` 통과, `test:fork` 4 파일 13/13, `test:e2e` 26/26(T-13 확인 실행, 이후 코드 변경 없음), `check:build` 통과(`test:e2e` 종료 뒤 단독 실행, mock 표식 양성·음성 대조 포함). DoD-3·4: T-1(2026-11-16) 공개 RPC(mainnet.base.org 블록 ~58199120, arb1.arbitrum.io 블록 ~524740021)로 라우터 코드 24497바이트와 `factory()`·`WETH9()`가 config와 일치함을 확인. DoD-29: 2026-11-17 Arbitrum One, 사용자 MetaMask(계정 0x4808…1778, 실제 지갑, `bun run dev` localhost:3000), USDC → USDT(USDT0) 1.247094 USDC, 티어 0.01%, 예상 1.2479·최소 1.2417 USDT. approve: 지출자 SwapRouter02·무제한·nonce 36·수수료 <0.0001 ETH, 컨펌 뒤 주 버튼 `스왑` 활성. swap: `multicall`·nonce 37·수수료 <0.0001 ETH, 수령 1.24796 USDT0(앱 표시 1.2479), 체결 뒤 보내는 칸 금액 비움·USDC 0·USDT 1.2479 즉시 반영. swap tx `0x326267a9179984c6d2f5199cb938c65a865bf52c11e309157d9d70c54c29ab92`(블록 525039372, 2026-11-17 12:58:18 UTC, Arbiscan "Swap 1.247094 USDC for 1.24796 USD₮0 on Uniswap"). approve tx 해시는 MetaMask 활동에 상세 미표시(nonce 36으로 식별). 참고: 같은 날 Ethereum 메인넷에서 USDT approve 1회 성공(지갑이 가스 0.702 USDT를 USDT로 지불해 잔액 부족으로 swap 미진행, overview 미결정 13). DoD-28: 2026-11-17 Base, 같은 사용자 MetaMask(계정 ETH 0), USDC → USDT, 티어 0.01%. approve: 지출자 SwapRouter02·무제한·nonce 0, 지갑이 가스를 USDC로 지불(0.104 USDC)해 잔액 1.2327 → 1.1289, 입력 1.232795 > 잔액이라 주 버튼 `잔액 부족`, `최대`(1.128942)로 다시 판정해 approve 없이 `스왑` 활성(EC-16). swap: `multicall`·nonce 1, 1.128942 USDC → 1.1297 USDT(예상 1.1297·최소 1.124), 체결 뒤 금액 비움·잔액 즉시 반영. approve tx `0x15f7e9d340f18f4da703f7f12fc807bcd55b3c8b4edfbb40a02f101f578ef6d9`(블록 58650045, 12:59:44 UTC, EIP-7702 타입 4, MetaMask Gas Station 2 → Delegation Manager `redeemDelegations`, 같은 tx에서 수수료 0.103853 USDC를 사용자 → MetaMask 수수료 수신 주소 `0xe3478b0B…948Be1964`로 전송, 대납자 실제 가스 약 $0.003 ETH). swap tx `0x8f1f9191de32074ac0adbfb3718481acf9e5126219d176da6b9eb144ed0d980a`(블록 58650732, 13:02:02 UTC, MetaMask Gas Station `Redeem Delegations` 경유 — 사용자 계정이 MetaMask 스마트 계정(EIP-7702)이라 대납자가 실행). swap 가스는 지갑이 같은 tx 안에서 USDT 0.104752로 지불(USDT 잔액 1.1297 → 1.0249). 50초 뒤 tx `0x98b696e491acd37362c7b40d30ffd07e76f10ea9d4575ab9fb11dd495a3e35c4`(블록 58650982)는 주소 포이즈닝 스팸으로 확인(사용자 Basescan Logs 확인) — 가짜 토큰 `0xA8c325F8DEf86b43515a5C9A815158b195720E98`(Basescan `Suspicious_Token56008`, 기호 USDT)에서 제3자 `0xcd74F5aC…E7c38F`가 사용자 주소 → 닮은꼴 주소 `0xe34750E1473B6cDD1f942e757309C1679b281964`로 같은 금액의 가짜 Transfer 이벤트만 기록. 받는 주소가 실제 수수료 수신 주소 `0xe3478b0B…948Be1964`와 축약 표기(`0xe347…1964`)가 같도록 만든 닮은꼴이고, 토큰 기호는 키릴 문자를 섞은 "UЅDТ". 활동 기록의 주소 복사 송금을 노리는 수법이며, 사용자 서명·승인 사용·진짜 USDT(`0xfde4…bb2`) 이동은 없다(실제 USDT 잔액 1.129741 − 수수료 0.104752 = 1.025와 일치). 앱과 무관하고 송금하지 않아 피해 없음. 자금은 Arbitrum 스왑 결과 1.24796 USDT0을 MetaMask 브리지로 Base 1.232795 USDC로 옮겨 마련

## 3. 항목 coverage

- DoD-1: T-2, T-6
- DoD-2: T-1, T-2, T-11
- DoD-3: T-1, T-14
- DoD-4: T-1, T-14
- DoD-5: T-2, T-5, T-6, T-12
- DoD-6: T-2, T-5, T-8, T-12
- DoD-7: T-2, T-5, T-8, T-12
- DoD-8: T-2, T-5, T-8
- DoD-9: T-2, T-3, T-5, T-8
- DoD-10: T-2, T-3, T-5, T-8
- DoD-11: T-2, T-3, T-5, T-8
- DoD-12: T-3, T-7, T-8
- DoD-13: T-1, T-2, T-4, T-5, T-9, T-11
- DoD-14: T-4, T-9
- DoD-15: T-1, T-2, T-4, T-5, T-9
- DoD-16: T-2, T-4, T-9
- DoD-17: T-2, T-4, T-9
- DoD-18: T-1, T-2, T-11
- DoD-19: T-4, T-9
- DoD-20: T-4, T-7, T-9
- DoD-21: T-4, T-10
- DoD-22: T-4, T-5, T-10
- DoD-23: T-4, T-10
- DoD-24: T-4, T-10
- DoD-25: T-4, T-10
- DoD-26: T-1, T-13
- DoD-27: T-13, T-14
- DoD-28: T-14
- DoD-29: T-14
- DoD-30: T-4, T-10
- DoD-31: T-11, T-14
- EC-1: T-4, T-10
- EC-2: T-4, T-10, T-13
- EC-3: T-4, T-10
- EC-4: T-4, T-7, T-10
- EC-5: T-4, T-7, T-10
- EC-6: T-4, T-5, T-10
- EC-7: T-4, T-10
- EC-8: T-4, T-10
- EC-9: T-4, T-10
- EC-10: T-4, T-10
- EC-11: T-4, T-9
- EC-12: T-1, T-2, T-4, T-9, T-11
- EC-13: T-4, T-9
- EC-14: T-2, T-3, T-5, T-7, T-8
- EC-15: T-3, T-4, T-8, T-9, T-10
- EC-16: T-3, T-5, T-8
- EC-17: T-3, T-7, T-8
- EC-18: T-4, T-7, T-10
- EC-19: T-4, T-9
- EC-20: T-4, T-10
- EC-21: T-4, T-10

## 4. 실행 순서

- 1구간(병렬): T-1(저장소 수정 없음, anvil 8555) / T-2(`config/contracts.ts`, `config/tokens.ts`, `config/uniswap-v3.ts`, `lib/swap-transaction.ts`, `lib/primary-button-state.ts`)
- 2구간(병렬): T-3(`lib/token-allowance.ts`, `hooks/use-token-allowance-read.ts`, `providers/token-allowance-provider.tsx`, `providers/app-providers.tsx`) / T-6(`__tests__/config/swap-router.test.ts`, `__tests__/lib/primary-button-state.test.ts`)
- 3구간(병렬): T-4(`providers/swap-execution-provider.tsx`, `providers/app-providers.tsx`) / T-11(`__tests__/fork/approve-swap.fork.test.ts`, `vitest.fork.config.mts`, anvil 8547은 이 구간에서 T-11만 쓴다)
- 4구간(순차): T-5(`components/primary-button.tsx`)
- 5구간(순차): T-7 + T-10(같은 에이전트, `__tests__/support/*` 추가만 → T-10 신규 파일 2개)
- 6구간(병렬): T-8 / T-9. 각자 `__tests__/swap/`의 신규 파일 2개씩만 수정하고 `__tests__/support/*`는 수정하지 않는다
- 7구간(순차): T-12. jsdom 전체 3회와 F1~F4 E2E 실행
- 8구간(순차): T-13. `test:e2e`는 포트 3100·8546을 독점하므로 다른 E2E 실행과 겹치지 않는다
- 9구간(순차): T-14. 명령을 순서대로 하나씩 실행하고 `check:build`는 `test:e2e` 종료 뒤에 실행한다

## 5. 차단 사항

- DoD-28·29는 사용자 지갑과 Base·Arbitrum 메인넷 자금으로 사용자가 직접 실행해야 한다. T-14는 그 기록을 받아야 완료된다
- T-1 결과가 스펙 확인 사실이나 라우터 주소와 어긋나면 인터뷰로 되돌린다

## 테스트 설계 증거

- 상태: 예외 동결 (reviewer 3라운드 후 자동 반복 한도 도달. 3라운드 NEEDS-FIX 2건·결정 1건 반영분은 독립 재검토 없이 기계 검사만 통과, 사용자 확정 2026-11-16)
- 기준 스펙: `docs/specs/approve-swap.md` (확정, 2026-11-15 갱신본: 계획 단계 공백 S-1~~S-6 반영으로 DoD-30·31, EC-17~~21 추가, DoD-9·20, EC-5·10·14, §4.2 보완)
- 골자 digest: `a169e441a57a3a96`
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/approve-swap.md --files __tests__/config/swap-router.test.ts __tests__/lib/primary-button-state.test.ts __tests__/swap/approve-swap-button.test.tsx __tests__/swap/token-allowance.test.tsx __tests__/swap/approve-execute.test.tsx __tests__/swap/swap-execute.test.tsx __tests__/swap/swap-execution-progress.test.tsx __tests__/swap/swap-execution-failure.test.tsx __tests__/fork/approve-swap.fork.test.ts e2e/approve-swap.spec.ts --exempt DoD-3,DoD-4,DoD-27,DoD-28,DoD-29,DoD-31 --frozen a169e441a57a3a96`
- 골격 파일: `__tests__/config/swap-router.test.ts`(T-6, 1 case), `__tests__/lib/primary-button-state.test.ts`(T-6, 2), `__tests__/swap/approve-swap-button.test.tsx`(T-8, 8), `__tests__/swap/token-allowance.test.tsx`(T-8, 5), `__tests__/swap/approve-execute.test.tsx`(T-9, 4), `__tests__/swap/swap-execute.test.tsx`(T-9, 5), `__tests__/swap/swap-execution-progress.test.tsx`(T-10, 12), `__tests__/swap/swap-execution-failure.test.tsx`(T-10, 6), `__tests__/fork/approve-swap.fork.test.ts`(T-11, 5), `e2e/approve-swap.spec.ts`(T-13, 2)
- 기계 검사: 통과. 항목 52개 중 case 연결 46개, 제외 6개, case 50개(단위 3, 통합 40, 포크 5, E2E 2). 전부 `it.todo`/`test.fixme`. 포맷 검사 통과
- reviewer 라운드: 3회(매번 새 `general-purpose`, 매 라운드 "서술 취향은 관찰로만" 지시, 파일 무변경 md5 확인)
  - 1라운드 NEEDS-DECISION(NEEDS-FIX 12, 결정 1): DoD-5 비인접 순서 역전, DoD-16 클릭~~인코딩 사이 금액·슬리피지 표본, DoD-17 deadline 시점, EC-18 시간 하한, EC-15 재연결·중복, EC-12 대조군(심볼 판정), EC-4·5 기대 상태, DoD-23~~25 case 통합, EC-11 표본 정리. 결정: EC-2 메시지 판정, DoD-17이 EC-11의 예외
  - 2라운드 NEEDS-DECISION(NEEDS-FIX 6, 결정 1): EC-10 판정이 실패할 수 없음(고), DoD-25 null·유지 경로, EC-19 차단 상태 표본, EC-15 주기 표본 길이, EC-18 시간. 결정: EC-19 진행 중 호출 즉시 resolve
  - 3라운드 NEEDS-FIX(중 2, 결정 1): EC-19 approve 쪽 allowance-error·checking-allowance·amount-too-small 표본, EC-11·DoD-16 fee·tokenOut 변화 표본. 결정: tx 없는 종료 뒤 allowance 재읽기 금지. 반영 후 예외 동결
- 제외 (사용자 확정): DoD-3·4·28·29(T-14 수동 기록), DoD-27(T-13·T-14 명령 실행 확인), DoD-31(T-11·T-14 명령 실행 확인)
- mock 경계 (사용자 확정): 각 테스트 Task의 `mock 허용 경계` 참조. 결정 이력: 스텁 기본 allowance 0, EC-3 -32000·EC-5 viem 재시도 소진·EC-8/21 실제 드롭다운, 포크 직접 상태 변경은 준비 단계만, E2E 거부는 `config/e2e-mock.ts` 전송 거부(4001) 제어값·automine 제어 없음, T-9에 영수증·체인 전환 붙잡기 허용, T-8에 지갑 전송 해시 응답 허용
- 해석 결정 (사용자 확정): E2E EC-2는 approve 거부만(swap 거부는 T-10). 통합 EC-2는 "해시 없음 + 영수증 조회 0건". EC-2 "메시지 없음"은 role=alert·status 요소 0개. EC-5 교체·취소 표본 제외. EC-9는 다른 체인 표본만. T-8 체인 변경은 체인+토큰 함께. DoD-5는 쌍 (i, j)마다 공존 가능한 뒤 조건 전부. DoD-17이 EC-11의 예외. EC-19 진행 중 호출은 즉시 resolve. DoD-14·EC-13 "다시 누르기 전/다음 클릭". tx 없는 종료(EC-1·2·3·21) 뒤 allowance 재읽기 금지(EC-15). 트랜잭션 종료 뒤 재읽기 판정은 T-8이 아니라 T-9(DoD-14·19·20)·T-10(EC-4·5)에 둔다
- F2 회귀 (사용자 확정, T-12에서 수행): F2 EC-25 `@then`을 "`insufficient-balance`가 아니고 견적 뒤 상태(USDC→DAI는 `approve-required`, ETH→USDC는 `quote-ready`)"로 바꿨다. F2 골자 digest `f2932cf895687551` → `12a88df2f0bb1e2a`(F2 동결 확인 명령의 `--frozen` 값을 이 값으로 읽는다)
- 미검증 (경계의 한계): 실제 지갑의 오류 형태(체인 전환 거부·4001·-32000)와 pending 중 체인 변경은 스텁으로만 증명. 실제 브라우저의 approving·swapping 관찰 없음(E2E automine). EC-5 트랜잭션 교체·취소 경로. EC-2 role 없는 문구(F6 메시지 영역 전까지 판정력 낮음). DoD-20 "트랜잭션 체인" 무효화는 선택 체인이 다른 동안 비활성 쿼리라 같은 체인 표본으로만 검증. Base·Arbitrum 라우터·체결은 수동 기록만. 통합 테스트는 fetch 스텁 RPC라 실제 노드 동작을 증명하지 않는다. 3라운드 반영분(EC-19 approve 표본 3개, EC-11 티어·받는 토큰 변화 표본, EC-1·2·3·21 allowance 재읽기 0건)은 독립 재검토를 받지 않았다
- 7단계 코드 대조 항목: simulate 미사용, `writeContract`에 클릭 시점 `chainId`, `waitForTransactionReceipt` 시간 제한 없음, allowance 쿼리에 주기·reconnect 재읽기 없음, RPC 프록시 허용 메서드 불변(§4.4), 새 `data-testid` 없음(§4.3), `lib/swap-input-state.ts` 기존 함수 불변
- T-14 수동 항목: DoD-3·4(라우터 코드 존재), DoD-28·29(Base·Arbitrum 소액 approve→swap tx 해시)
- 본문 작성 주의: 포크·E2E 기대값은 T-1 결과(라우터 selector, USDT 반환·revert, 표본 금액의 가격 영향·최소 수령량, 포크 timestamp와 deadline)에 기댄다. EC-5 viem 재시도 소진(약 12.6초)은 잔액 15초 주기와 구별되게 시계를 맞춘다. EC-21은 체인 변경으로 폼이 초기화돼 allowance를 읽지 않는다. `vitest list --json` 등 파일을 쓰는 옵션 금지. `check:build`와 `test:e2e`는 동시에 실행하지 않는다

### 검증 기록

- 코드 기준: `68f074a` + 커밋 전 작업 트리(2026-11-17). 세 검증 모두 실행 전후 작업 트리 동일(오케스트레이터 스냅샷 비교, 실행 에이전트 `git status` 비교), 검증 중 파일 변경 없음
- 실행(test-runner): `format:check`·`lint`·`typecheck`·`build` 통과, `bun run test` 34 파일 243/243(F5 통합 40·단위 3 포함, skip·todo 0), `bun run test:fork` 4 파일 13/13(F5 5 포함), `check:build` 통과(`test:e2e` 종료 뒤 단독, 키 음성·mock 음성·mock 양성 대조)
- 실행(e2e-runner): `bun run test:e2e` 26/26(1 worker, 재시도 0, 1.6m). F5 DoD-26 8.4s, EC-2 3.0s, F1~F4 24 회귀 통과
- 스펙 대조(verify): 52개 중 충족 46, 미충족 2(DoD-28·29 수동 기록 없음), 검증 불가 4(DoD-3·4 수동, DoD-27·31 실행 확인 항목), 제품 결함 0, 스코프 초과·드리프트 0. 골자 F5 `a169e441a57a3a96`·F2 `12a88df2f0bb1e2a`·F3 `8acf896e2a4dffdd`·F4 `3af643e844b77259` 모두 유지. 7단계 코드 대조 7건 이상 없음. T-4 구현 판단 4건 스펙 위반 아님
- 8단계 사용자 결정(2026-11-17, 코드·골자 변경 없이 스펙 문구로 명시): DoD-9와 EC-14의 경계는 현재 동작대로 스펙 §4.2에 "성공 값 없이 실패한 키를 다시 읽는 동안 `error` 유지"를 추가했다(골자 digest 유지). 원 보고 — 스펙 결함(낮음): DoD-9와 EC-14의 경계 — 성공 값 없이 실패한 키를 다시 읽는 동안 구현은 `error`·`allowance-error`를 유지(DoD-5 순서상 `allowance-error`가 앞서 위반 아님, §4.2가 이 구간 status를 정하지 않음). 이 구간을 판정하는 case 없음
- 지원 모듈 "추가만" 확인(오케스트레이터 `git diff`): 삭제 줄은 `BalanceRpcKind` 유니언·게이트 scope 확장, import 정리, `config/e2e-mock.ts` 기록 줄 재구성(기록 유지)뿐

| 스펙 항목                     | 코드 대조            | 실행 확인                                                              | 종합 |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------- | ---- |
| DoD-1, 2, 5~~26, 30, EC-1~~21 | 충족                 | 확인됨 (단위·통합·포크·E2E)                                            | 충족 |
| DoD-27                        | 검증 불가(실행 항목) | 확인됨 (`test:e2e` 26/26, 1 worker, 쓰기 spec snapshot/revert)         | 충족 |
| DoD-31                        | 검증 불가(실행 항목) | 확인됨 (`test:fork` 13/13, `fileParallelism: false`)                   | 충족 |
| DoD-3, DoD-4                  | 검증 불가(수동)      | 수동 기록 (T-1, 2026-11-16, 공개 RPC 코드 존재·`factory`·`WETH9` 일치) | 충족 |
| DoD-28, DoD-29                | 검증 불가(수동)      | 수동 기록 (2026-11-17, Base·Arbitrum approve·swap tx, T-14 구현 기록)  | 충족 |
