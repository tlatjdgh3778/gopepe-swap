# 계획: batch-calls

- 상태: 승인
- 스펙: docs/specs/batch-calls.md
- 기준 코드: 8de387e + 작업 트리 (branch feat/batch-calls, 스펙 파일만 미추적)
- 최종 갱신: 2026-11-26

## 1. 구현 전략

- 순서: 사전 확인 → lib 순수 함수·타입 → capabilities 읽기와 배치 가능 provider → 실행 provider `batch()` → 화면(주 버튼·tx-status·수수료 행) → 테스트(스텁 확장과 통합 4파일, 포크) → 기존 테스트 회귀 확인과 §4.5 회귀 갱신(조건부) → E2E → 수동 확인과 전체 검사. 근거: `docs/plans/network-fee.md:10`, `docs/plans/tx-status.md:10`
- 상태 판정: `lib/primary-button-state.ts`에 상태 두 개를 더한다. `batching`은 `unwrapping` 다음(진행 묶음), `batch-ready`는 `approve-required`와 같은 판정 지점에 둔다(배열에서는 바로 앞, 둘은 서로 배타적이라 판정 결과는 같다). `SwapExecutionPhase`에 `batching`을 더하면 기존 `if (phase !== "idle") return phase`가 그대로 `batching`을 돌려준다. 마지막 분기는 `allowance < amountInRaw ? (batchAvailable ? "batch-ready" : "approve-required") : "swap-ready"`이고, `batchAvailable`은 `PrimaryButtonStateParams`·`PrimaryButtonSourceParams`의 선택 필드(기본 false)다. F7 단위 테스트의 `toSourceParams`가 `PrimaryButtonSourceParams` 리터럴을 돌려주므로 필수 필드로 만들면 동결 테스트 typecheck가 깨진다. 활성 집합에 `batch-ready`만 더한다. 근거: `lib/primary-button-state.ts:10-46,51-68,99,121-124,129-142,144-185`, `__tests__/lib/native-eth-button-state.test.ts:25-47,99-140`
- 배치 가능 판정 위치: 주 버튼 상태를 계산하는 세 곳(`PrimaryButton`, `SwapExecutionProvider`, `NetworkFeeProvider`)이 같은 값을 쓰도록 새 `providers/batch-capability-provider.tsx`(`BatchCapabilityProvider`, `useBatchCapability()` → `{ available, markUnsupported(chainId, account) }`)를 `TokenAllowanceProvider`와 `SwapExecutionProvider` 사이에 마운트한다. `available` = 연결됨 ∧ 선택 체인 capability `atomic.status ∈ {supported, ready}` ∧ (계정·체인)이 강등 집합에 없음. 읽는 중·오류·항목 없음은 false다. 강등 집합은 provider의 메모리 state라 새로고침하면 사라진다. 근거: `providers/app-providers.tsx:38-41`, `providers/token-allowance-provider.tsx:33-69`, `components/primary-button.tsx:91-103`, `providers/swap-execution-provider.tsx:163-175`, `providers/network-fee-provider.tsx:89-101`
- capabilities 쿼리: 새 `hooks/use-wallet-capabilities-read.ts`. 키는 `["wallet-atomic-capability", selectedChainId, account 소문자]`, queryFn은 `wagmi/actions` `getCapabilities(config, { account, chainId })`이고 `atomic?.status ?? null`을 돌려준다(TanStack v5는 `undefined` data를 오류로 보므로 null). 옵션은 `retry: false`, `refetchOnWindowFocus`·`refetchOnReconnect`·`refetchInterval` 없음, `staleTime: 0`, `enabled`는 지갑 `connected`이고 계정이 있을 때다. 커넥터 클라이언트는 `retryCount: 0`이라 viem 재시도가 없다. 클릭 경로에서는 이 쿼리를 다시 읽지 않는다. 근거: `hooks/use-token-allowance-read.ts:77-95`, `node_modules/@wagmi/core/src/actions/getCapabilities.ts`, `node_modules/@wagmi/core/src/actions/getConnectorClient.ts:154`, `node_modules/viem/actions/wallet/getCapabilities.ts`
- calls 조립: 새 `lib/batch-calls.ts`의 순수 함수 `buildBatchCalls({ chainId, token, allowance, swap })` → `{ to, data, value }` 배열. swap 항목은 `buildSwapTransactionRequest` + `encodeSwapTransactionCalldata` 결과를 그대로 쓴다. 단일 approve 금액 규칙(`getApproveAmount`)과 `lib/swap-transaction.ts`는 바꾸지 않는다(포크 테스트가 import한다). capabilities 응답에서 status를 꺼내는 순수 함수도 이 파일에 둔다. 근거: `lib/swap-transaction.ts:18-80,231-270`, `__tests__/fork/approve-swap.fork.test.ts:23-30`
- 전송: `batch()`는 `approve()`·`swap()`과 같은 가드(잠금, 클릭 시점 스냅샷 `primaryState === "batch-ready"`, 세대)를 쓴다. 체인 확인 단계와 선택 체인 비교는 기존 `execute`와 똑같이 하고, 전송은 `wagmi/actions` `sendCalls(config, { account, chainId: txChainId, calls, forceAtomic: true })`다. viem 기본값은 `forceAtomic = false`라 명시해야 `atomicRequired: true`가 실린다. `experimental_fallback`은 넘기지 않는다. deadline은 기존 swap처럼 전송 직전에 정한다. 기존 `execute`(4종)는 그대로 두고, 같은 파일에 `executeBatch`를 따로 둬 동결된 F5~F7 경로의 동작을 바꾸지 않는다. 근거: `providers/swap-execution-provider.tsx:255-309,416-471`, `node_modules/viem/actions/wallet/sendCalls.ts:103-105,152,172`
- 오류 분류: `lib/tx-result.ts`에 `TxKind`의 `batch`와 batch 결과 타입(스펙 §4.1)을 더하고, 원인 체인(`cause`) code 판정을 재사용한 `classifyBatchSendError(error) → { status: "rejected" | "send-failed"; unsupported: boolean }`를 둔다. `unsupported`이면 결과를 기록하는 세대 가드 뒤에서 `markUnsupported(txChainId, txAccount)`를 부른다. 근거: `lib/tx-result.ts:8,24-56`
- 상태 대기: `wagmi/actions` `waitForCallsStatus(config, { id, timeout: 0 })`. viem 기본 timeout은 60초라 0을 넘겨야 한다. 상태 코드 대역 판정과 receipt 판정은 `lib/tx-result.ts`의 순수 함수 `getBatchStatusOutcome(statusCode, receipts)`가 맡는다. viem 기본 종료 조건(200 또는 ≥300)은 201~299를 끝내지 않으므로(T-1 (e)) `status` 판정 함수로 1xx가 아니면 끝낸다. `getCallsStatus` throw 재시도는 viem 기본(retryCount 4, 약 3초)을 둔다(사용자 결정 2026-11-24). 근거: `node_modules/viem/actions/wallet/waitForCallsStatus.ts:112-116,191`, `node_modules/viem/actions/wallet/getCallsStatus.ts:118-141`, `providers/swap-execution-provider.tsx:318-342`
- 진행·후처리: 배치 id를 받으면 `{ phase: "batching", pendingTx: { kind: "batch", chainId, batchId } }`로 둔다. 성공은 swap 성공 분기와 같다(금액 비우기 조건, 카드 잔액 무효화, allowance 다시 읽기를 기다린 뒤 결과 기록과 idle 전환). `balanceDropped`는 없다. 그 밖의 결과(id 수신 뒤)는 allowance·잔액을 기다리지 않고 무효화한다. 계정이 바뀌면 기존 세대 effect가 결과를 버린다. 근거: `providers/swap-execution-provider.tsx:204-208,336-358`
- 화면: `components/primary-button.tsx`에 `batch-ready`·`batching` 문구와 클릭 분기 `batch-ready → batch()`를 더한다. `components/tx-status.tsx`는 `PENDING_PHASES`에 `batching`을 넣고 메시지 레코드에 `batch` 항목을 더하며, pending 링크는 `pendingTx.kind === "batch"`이면 없다. 결과 링크는 hash가 있을 때만 그린다. 근거: `components/primary-button.tsx:24-45,105-116`, `components/tx-status.tsx:25-47,91-110,132-138`
- 수수료 행: `lib/network-fee.ts`의 kind 매핑에 `batch-ready → approve`를 더하고, 주 버튼 상태로 안내 줄을 고르는 순수 함수 `getNetworkFeeNote(state) → "swap-pending" | "batch" | null`을 둔다. `NetworkFeeProvider`는 `batchAvailable`을 상태 계산에 넣고, F10 §4.1 `NetworkFeeState` 타입은 바꾸지 않은 채 같은 파일의 두 번째 context(`useNetworkFeeNote()`)로 안내 종류를 내보낸다. `components/network-fee.tsx`는 `fee.kind === "approve"` 조건을 이 값으로 바꾸고 `network-fee-batch-note`를 더한다. 근거: `lib/network-fee.ts:47-60`, `providers/network-fee-provider.tsx:48,89-107,243-251`, `components/network-fee.tsx:9,20,105-109`
- RPC·WAF 영향: `wallet_getCapabilities`·`wallet_sendCalls`·`wallet_getCallsStatus`는 커넥터 provider(지갑)로 가고 `/api/rpc/*` 프록시로 가지 않는다. 프록시 허용 목록, `config/rpc.ts`, `lib/rpc-proxy.ts`는 바꾸지 않는다. 배치 성공 뒤 읽기는 swap 성공과 같고, 두 단계 흐름의 영수증 폴링(프록시)과 approve 뒤 잔액 새 읽기가 지갑 폴링으로 바뀌므로 프록시 요청은 줄거나 같다. F10의 WAF 산정(최악 119 ≤ 120)은 그대로다. 근거: `docs/plans/network-fee.md:21-25`, `config/wagmi.ts:26-28,53-57`, `node_modules/@wagmi/core/src/connectors/mock.ts:225-240`
- 동결 테스트 영향(스펙 §4.5): (1) `PendingTx` batch 분기의 `hash?: undefined`로 `__tests__/swap/tx-status-pending.test.tsx:684`·`__tests__/swap/swap-execution-progress.test.tsx:802`의 hash 접근은 그대로 컴파일된다. (2) `TxResult` 분리가 동결 테스트의 `result.hash` 접근에 주는 영향은 T-1 (f)가 사본에서 확인한다. (3) 정확 길이 창(`wrap-execute.test.tsx:681,839,869-907`, `swap-execute.test.tsx:824,905`, `tx-status-lifetime.test.tsx:729`)은 capabilities 쿼리가 연결·키 변경 때만 나가므로 안전할 것으로 보이며 T-1 (f)에서 확인한다. (4) F7 단위 테스트는 `batchAvailable`을 선택 필드로 두어 지킨다. (5) E2E 상태 정규식(`e2e/support/app.ts:57-68`)은 배치가 기본 꺼짐이라 영향이 없다. 새로 깨지는 case는 §4.5 절차대로 보고 후 승인을 받는다. 근거: `docs/specs/batch-calls.md` §4.5, `tsconfig.json`
- 테스트 지원 확장: `__tests__/support/stub-eip1193.ts`는 T-6 하나가 "추가만"으로 맡는다. `installWalletCalls(stub)`는 `wallet_getCapabilities`(체인별 atomic status, 항목 없음, 오류 code, 붙잡기), `wallet_sendCalls`(요청 기록, id 응답, 오류 code·cause, 붙잡기), `wallet_getCallsStatus`(statusCode 순서열, receipts, throw, 붙잡기)를 다룬다. 기본 4200 동작은 바꾸지 않아 기존 테스트는 두 단계 흐름 그대로다. `rpc-balance-stub.ts`에 필요한 것이 있으면 T-6이 함께 맡고 다른 테스트 Task는 `__tests__/support/*`를 고치지 않는다. 근거: `__tests__/support/stub-eip1193.ts:56,117-125,186-330`, `docs/plans/network-fee.md:27`
- E2E·포크 실행 방식(T-1 확정, 사용자 확정 2026-11-24): 7702 실행 컨트랙트는 포크 블록에 있는 eth-infinitism Simple7702Account `0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9`(`executeBatch((address,uint256,bytes)[])`, self-call만, 실패 시 전체 revert)이고 위임은 snapshot 뒤 `anvil_setCode(계정, 0xef0100‖주소)`로 둔다. E2E는 A2 방식이다: 테스트가 켤 때만 래퍼가 체인 1 `atomic: supported`를 보고하고, `wallet_sendCalls`를 `executeBatch` 자기 호출 1건(명시 gas)으로 보내고, `wallet_getCallsStatus`를 그 receipt로 응답한다(없으면 100, `0x1` 200, `0x0` 500). `config/e2e-mock.ts`(E2E 빌드 전용 제품 코드, `check:build` 표식 검사 대상)는 F5 선례처럼 E2E Task(T-13) 하나가 맡는다. 근거: `docs/plans/approve-swap.md:225-232`, `config/e2e-mock.ts:24-35,83-131`, `scripts/check-build-artifacts.ts:41-43`
- 문서: 스펙에 문서 항목이 없어 README·`docs/design/README.md` 변경 Task를 두지 않는다. `docs/overview.md`는 이 worktree가 추적하지 않는다(main checkout의 `.git/info/exclude`). 근거: `docs/plans/network-fee.md:113-125`, `/root/study/gopepe-swap/.git/info/exclude:7`
- mock 경계(사용자 확정 2026-11-24): 통합 테스트는 F10 경계(실제 wagmi·Provider·화면, 스텁 EIP-1193(injected) 지갑 — wagmi mock 커넥터는 capabilities가 하드코딩이라 배치 조건에 쓰지 않는다, 전역 fetch URL 라우팅 스텁, 가짜 타이머, `vi.mock` 금지)에 지갑 `wallet_*` 세 메서드 스텁 응답·오류·붙잡기를 더한다. E2E는 mock 커넥터 + `config/e2e-mock.ts` 배치 opt-in 제어값 + 러너→anvil 준비, `page.route` 금지. 포크는 실제 anvil이다. 근거: `docs/plans/network-fee.md:29`

## 2. Task

### T-1 — 사전 확인

- 사이드: 조사
- 상태: 완료
- 목적: E2E 배치 실행 방식, 포크 7702 실행 컨트랙트, sendCalls·capabilities·상태 대기의 실제 요청·오류·기본값, 기존 테스트 노출을 저장소 밖에서 확인하고 E2E 방식과 실행 컨트랙트를 정한다
- 선행: 없음
- 연결 항목: DoD-7, DoD-9, DoD-16, DoD-26, DoD-27, DoD-28, DoD-29, DoD-30, DoD-31, EC-1, EC-2, EC-7, EC-13, EC-14, EC-15, EC-16, EC-18, EC-22, EC-23
- 수정 대상: 없음. 작업 디렉터리는 저장소 밖 `/root/study/.pipeline-scratch/batch-calls/t1/`이다. 전용 포트 8565(고정 블록 26250000 포크, 자동 채굴)·8566(같은 포크 `--block-time 1`)과 로컬 스텁 서버(18565)를 쓴다. 타입 영향 확인은 worktree를 scratch로 복사한 사본에서만 한다
- 따라야 할 패턴: 저장소 밖에서 확인하고 결과는 구현 기록에 남긴다 — 근거: `docs/plans/network-fee.md:33-55`, `docs/plans/tx-status.md:23-35`
- 완료 조건: 아래 결과를 기록하고 (a)(b)의 선택을 확정한다. 스펙과 어긋나면 인터뷰로 되돌린다 — 검증: 확인 절차
  - (a) E2E 배치 경로: ① wagmi mock 내장 `wallet_sendCalls`를 8566에서 실행해 approve 채굴 전 swap 가스 추정 revert 여부와 `wallet_getCallsStatus`가 receipt 하나만 생겨도 200을 돌려주는지 기록한다. ② 래퍼가 `wallet_sendCalls`를 직접 구현하는 두 방식을 실행한다. A2는 러너가 계정 0에 7702 위임 표식을 snapshot 뒤 설정하고 래퍼가 자기 자신 호출 `executeBatch(calls)` 1건을 보낸다. A3는 명시 gas로 call을 차례로 보내고 각 receipt를 기다리며 모두 나올 때까지 100을 돌려준다. ③ 선택한 방식의 제어값 형태(체인 1만, 기본 꺼짐, 요청 시점마다 읽음, 앱 연결 전에 켬)와 상태 응답 형태를 정한다. ④ `walletRequests`에 앱이 보낸 요청만 남고 래퍼 내부 anvil 요청은 남지 않는지 확인한다. ⑤ 위임 표식 교체가 snapshot/revert로 원복되는지 확인한다
  - (b) 7702 실행 컨트랙트: 포크 블록에서 후보(계정 0의 현재 위임 대상, eth-infinitism Simple7702Account, MetaMask EIP7702StatelessDeleGator, Uniswap Calibur 등)의 코드·ABI·원자성·self-call 허용을 기록한다. 위임 설정 수단은 viem `signAuthorization` + type-4 tx와 `anvil_setCode` 표식을 anvil 1.8.1에서 비교한다. 앱 `buildBatchCalls`와 같은 calls로 한 tx 체결과 받는 토큰 증가, 최소 수령량을 높인 revert에서 allowance 원복(명시 gas)을 확인한다. 쓸 수 있는 컨트랙트가 없으면 리터럴 바이트코드 방법을 보고, 그것도 안 되면 DoD-30·31 제외 사유를 기록한다
  - (c) `sendCalls` 요청 형태: 스텁 EIP-1193으로 wagmi 3.7.11 `sendCalls(config, { account, chainId, calls, forceAtomic: true })`의 `wallet_sendCalls` params와 지갑이 받는 전체 요청 순서를 기록한다. `experimental_fallback`이 없으면 어떤 오류에서도 `eth_sendTransaction`으로 넘어가지 않는지 확인한다. 4001·5000·-32601·4200·5700·5740·5750·-32603·-32000 응답의 viem 오류 클래스, `cause` 순회로 원 code를 찾을 수 있는지, 재시도 0을 기록한다
  - (d) capabilities 조회: `getCapabilities` params, 체인 항목이 없을 때의 반환값, 4200·-32601·-32603에서 요청 1건, TanStack 5.106에서 같은 키 재요청 0건, 키 변경·계정 왕복·재연결 요청 수, wagmi 자체가 `wallet_getCapabilities`를 보내지 않는지, Vitest mock 커넥터 응답에 `atomic`이 없는지 확인한다
  - (e) 상태 대기: `waitForCallsStatus` 기본값(timeout, `timeout: 0` 동작, retryCount와 대기 합계, 커넥터 클라이언트 pollingInterval)을 기록한다. 1xx·2xx(200 외 포함)·3xx·4xx·5xx·6xx·7xx 이상·throw에서 resolve/reject와 `statusCode`·`receipts[].status` 노출을 기록하고, 대역 판정에 `status` 함수 지정이 필요한지 정한다. 가짜 타이머로 1xx가 계속될 때 reject가 없는지 확인한다
  - (f) 기존 테스트 노출: scratch 사본에서 타입만 바꿔(`PendingTx` union + `hash?: undefined`, `TxResult` 분리, `TxKind`·`SwapExecutionPhase`·`PrimaryButtonState` 확장, `batchAvailable` 선택 필드) `tsc --noEmit`으로 깨지는 동결 파일과 줄을 목록으로 만든다. `stub.requests` 정확 길이·메서드 순서 비교 case, `walletRequests` 사용 E2E case, `e2e/support/app.ts` 상태 정규식, F10 `network-fee-swap-pending` case, Base 선택 체인 mock 커넥터 case를 정적으로 확인해 위험 목록을 만든다
  - (g) (c)~(e)의 모든 요청이 지갑 provider로만 가고 프록시·업체 RPC로 가지 않는지 확인한다
- 실행 명령: `anvil --fork-url $ETH_MAINNET_RPC_URL --fork-block-number 26250000 --port 8565`, 같은 포크 `--block-time 1 --port 8566`, `cast code`, `cast rpc`, `cast send`, 저장소 밖 `bun` 스크립트, 사본에서 `bunx tsc --noEmit`
- 수정 금지: 저장소 파일
- 구현 기록: general-purpose(조사 전용 에이전트 없음, F9·F10 선례), 저장소 밖 `/root/study/.pipeline-scratch/batch-calls/t1/`. 2026-11-24. 저장소 수정 없음, 8565·8566·18565 종료 확인. anvil/cast 1.8.1, viem 2.57.16, wagmi 3.7.11, query-core 5.106.1. 스펙과 어긋난 점 없음. (a) wagmi mock 내장 `wallet_sendCalls`는 approve·swap이 다른 블록이고 그 사이 receipt 1개로 200을 응답해 불채택. A2(위임 표식 + `executeBatch` 자기 호출 1건) 3/3 성공·revert 500 원자 원복, A3(순차)는 revert 600에 approve 잔존이라 불채택 → A2. 제어값은 요청 시점 읽기·기본 꺼짐·연결 전 `addInitScript`. `walletRequests`에는 앱 요청만(`eth_chainId, wallet_sendCalls, eth_chainId, wallet_getCallsStatus×n`). 위임 표식을 안 두면 기존 sweeper 위임이 호출을 삼켜 200·잔액 불변 → 러너가 코드 단정. (b) Simple7702Account `0x4Cd2…66c9` 채택, `anvil_setCode` 권장(type-4도 동작). 앱 calldata 성공 tx 1건, revert(최소 수령량 견적+1, 명시 gas 800k) allowance 0→0, USDT 3-call 성공. USDC는 max allowance도 차감, 추정은 revert 시 실패 → 명시 gas. (c) 요청 `eth_chainId`→`wallet_sendCalls [{atomicRequired:true, calls:[{to,data}…], chainId:"0x1", from, version:"2.0.0"}]`, 오류 4001·5000→rejected 판정 가능, -32601·4200·5700·5740·5750·-32603·-32000 code는 cause 순회로 확인, fallback 없음·재시도 0. (d) `wallet_getCapabilities [account, ["0x1"]]`, 항목 없으면 undefined, 오류 1건, wagmi 자체 요청 0, 키 변경·재연결 때만 재요청. (e) pollingInterval 4000ms, 기본 timeout 60초, `timeout: 0`은 10분 무reject, 기본 종료 조건은 201~299를 끝내지 않음 → `status` 함수 필요, throw 재시도 4회 약 3초. (f) 스펙 타입 적용 사본에서 동결 테스트 tsc 실패 0(`hash?: undefined` 없으면 2줄 실패), 제품 변경 지점 `primary-button.tsx:24`, `tx-status.tsx:25,32,96,108`, `swap-execution-provider.tsx:72,257`. 정확 길이 창 case 안전, E2E 상태 정규식은 새 helper 필요. (g) `wallet_*` 요청의 프록시 fetch 0건

### T-2 — lib 순수 함수와 타입

- 사이드: 프론트
- 상태: 완료
- 목적: 주 버튼 상태·phase·TxKind·TxResult 확장, 배치 calls 조립, capability 판정, 배치 오류 분류·상태 결과 변환, 수수료 kind·안내 매핑을 순수 함수로 만든다
- 선행: 없음
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-5, DoD-7, DoD-8, DoD-13, DoD-16, DoD-17, DoD-21, DoD-22, DoD-23, DoD-25, DoD-30, DoD-31, EC-5, EC-7, EC-10, EC-12, EC-13, EC-14, EC-15, EC-16, EC-22, EC-23, EC-24
- 수정 대상: `lib/primary-button-state.ts` — 상태 2개, phase `batching`, 선택 필드 `batchAvailable`, 활성 집합. `lib/tx-result.ts` — `TxKind` `batch`, batch 결과 타입, `classifyBatchSendError`, `getBatchStatusOutcome`(기존 export 동작 불변). `lib/batch-calls.ts` — 신규, `buildBatchCalls`, capability status 추출·`isAtomicBatchStatus`. `lib/network-fee.ts` — 매핑 `batch-ready → approve`, `getNetworkFeeNote`
- 따라야 할 패턴: React·wagmi import 없는 `lib/`, 원인 체인 code 판정 재사용, 기존 조립 함수 재사용, kebab-case·named export — 근거: `lib/tx-result.ts:31-56`, `lib/network-fee.ts:47-60`, `lib/swap-transaction.ts:38-80,231-270`, `CLAUDE.md`
- 완료 조건: 연결 항목 판정에 필요한 함수가 있다. `batchAvailable`이 없으면 모든 입력에서 판정이 기존과 같다. 오류 판정은 메시지 문구를 보지 않는다. `lib/swap-transaction.ts`가 바뀌지 않는다. 단일 트랜잭션 결과 타입이 기존과 같다 — 검증: T-6~T-10, `bun run test __tests__/lib`
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/lib`
- 수정 금지: `lib/swap-transaction.ts`, `config/`, `hooks/`, `providers/`, `components/`, 테스트 파일
- 구현 기록: seongho:frontend-dev, 작성 영역 `lib/primary-button-state.ts`(상태 `batching`·`batch-ready`, 선택 필드 `batchAvailable` 기본 false, 활성 집합)·`lib/tx-result.ts`(`SingleTxKind`·`TxKind`, `SingleTxResult`·`BatchTxResult`·`TxResult`, `classifyBatchSendError`, `isBatchStatusFinal`, `getBatchStatusOutcome`, 원인 체인 판정 `hasCauseCode`로 정리·동작 불변)·`lib/batch-calls.ts`(신규 `buildBatchCalls`, `getAtomicCapabilityStatus`, `isAtomicBatchStatus`)·`lib/network-fee.ts`(`batch-ready → approve`, `getNetworkFeeNote`). 수정 0/3. 세부 결정: `getBatchStatusOutcome`은 1xx에 null, 비유한 수는 receipt-failed, `buildBatchCalls`의 swap 인자는 chainId·tokenIn 제외, capability 입력은 unknown. 오케스트레이터 확인(2026-11-25): lint 통과, `bun run test __tests__/lib` 94/94 통과, `lib/swap-transaction.ts` 무변경, typecheck 오류 7건은 모두 T-4(`providers/swap-execution-provider.tsx` 3)·T-5(`components/primary-button.tsx` 1, `components/tx-status.tsx` 3) 대상으로 T-1 (f) 예측과 일치

### T-3 — capabilities 읽기와 배치 가능 provider

- 사이드: 프론트
- 상태: 완료
- 목적: 연결 계정·선택 체인의 atomic capability를 한 번 읽고, 배치 가능 여부와 강등 집합을 제공한다
- 선행: T-1, T-2
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, EC-1, EC-2, EC-3, EC-4, EC-8
- 수정 대상: `hooks/use-wallet-capabilities-read.ts` — 신규, 키 상수·키 팩터리·쿼리 훅. `providers/batch-capability-provider.tsx` — 신규, `BatchCapabilityProvider`, `useBatchCapability()`, 강등 집합 `markUnsupported`. `providers/app-providers.tsx` — `TokenAllowanceProvider` 안쪽, `SwapExecutionProvider` 바깥에 마운트
- 따라야 할 패턴: Provider와 사용 훅을 한 파일에 둔다, 키에 bigint 없음·소문자 주소, `retry: false`·포커스·재연결 끔, 한 곳에서만 쿼리 observer를 만든다 — 근거: `providers/token-allowance-provider.tsx:33-75`, `hooks/use-token-allowance-read.ts:25-95`, `providers/app-providers.tsx:31-48`
- 완료 조건: 연결 항목 충족. T-1 (d)의 요청 수와 일치한다. 미연결·복원 중에는 요청이 없다. 클릭 경로에서 쿼리를 다시 읽지 않는다. SSR에서 queryFn이 실행되지 않는다. 기존 훅 계약(`useTokenAllowance`, `useSwapForm`, `useSelectedChain`)이 바뀌지 않는다 — 검증: T-6, T-11
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap __tests__/wallet`
- 수정 금지: `providers/swap-execution-provider.tsx`, `providers/token-allowance-provider.tsx`, `providers/network-fee-provider.tsx`, `lib/`, `components/`, `config/`
- 구현 기록: seongho:frontend-dev(T-2 에이전트 이어서), 작성 영역 `hooks/use-wallet-capabilities-read.ts`(신규, 키 `["wallet-atomic-capability", chainId, 소문자 계정]`, `getCapabilities` → status|null, retry·포커스·재연결·주기 끔, staleTime 0)·`providers/batch-capability-provider.tsx`(신규, `available`·`markUnsupported` 메모리 Set)·`providers/app-providers.tsx`(+5 −4, `TokenAllowanceProvider` 안쪽·`SwapExecutionProvider` 바깥 마운트). 수정 0/3. 오케스트레이터 확인(2026-11-25): lint 통과, typecheck 오류는 T-2 기록의 7건 그대로(새 오류 없음), `bun run test __tests__/swap __tests__/wallet` 39 파일 통과·4 skipped(배치 골격), 318 통과·41 todo

### T-4 — 실행 provider `batch()`

- 사이드: 프론트
- 상태: 완료
- 목적: `useSwapExecution()`에 `batch()`를 더하고 전송·분류·강등·상태 대기·후처리를 구현한다
- 선행: T-3
- 연결 항목: DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, DoD-12, DoD-13, DoD-16, DoD-17, DoD-18, DoD-19, DoD-20, EC-4, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11, EC-12, EC-13, EC-14, EC-15, EC-16, EC-17, EC-18, EC-19, EC-20, EC-21, EC-22, EC-23, EC-24
- 수정 대상: `providers/swap-execution-provider.tsx` — `PendingTx` union, `PENDING_PHASE_BY_KIND`에 `batch`, `useBatchCapability().available`을 주 버튼 상태 재계산에 넣음, `executeBatch`와 `batch()`, `SwapExecutionValue.batch`, 문서 주석. 기존 `execute`·`approve`·`swap`·`wrap`·`unwrap` 본문은 바꾸지 않는다
- 따라야 할 패턴: 호출 시점 값은 `latestRef`, 잠금·세대 가드, 체인 확인→체인 비교→전송 단계 분리, `finish` 한 번 기록, 성공 후처리 순서 — 근거: `providers/swap-execution-provider.tsx:177-208,255-376,416-471`
- 완료 조건: 연결 항목 충족. `sendCalls`에 `forceAtomic: true`가 있고 `experimental_fallback`이 없다. `waitForCallsStatus`에 `timeout: 0`이 있다. 클릭으로 `wallet_getCapabilities`·`eth_sendTransaction`을 보내지 않는다. 결과 기록과 강등은 세대 가드 뒤에만 한다. 기존 F5~F7·F10 통합 테스트가 통과한다 — 검증: T-7, T-8, T-11
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run test __tests__/swap`
- 수정 금지: `lib/`, `hooks/`, `components/`, 다른 `providers/*`, `config/`
- 구현 기록: seongho:frontend-dev(T-2·T-3 에이전트 이어서), 작성 영역 `providers/swap-execution-provider.tsx`(+218 −?, `PendingTx` union·`hash?: undefined`, `PENDING_PHASE_BY_KIND.batch`, `batchAvailable` 입력, `executeBatch`·`batch()`, `sendCalls` `forceAtomic: true`, `waitForCallsStatus` `timeout: 0`·`status: isBatchStatusFinal`·retryCount 기본, 세대 가드 뒤 `markUnsupported`, 성공 후처리는 swap과 같음, 기존 `execute` 본문 불변·kind 타입만 `SingleTxKind`). 수정 0/3. 세부: 4xx는 id 수신 뒤 non-success로 무효화만, `getBatchStatusOutcome` null은 receipt-failed(도달 불가 경로). 오케스트레이터 확인(2026-11-25): lint 통과, `experimental_fallback`·`retryCount` 지정·키 없는 `invalidateQueries()` 없음, typecheck 오류는 T-5 대상 `components/` 5건(`primary-button.tsx:24`, `tx-status.tsx:25,32,96,108`)만, `bun run test __tests__/swap` 35 파일 통과·303 통과·41 todo

### T-5 — 화면: 주 버튼·tx-status·수수료 행

- 사이드: 프론트
- 상태: 완료
- 목적: `batch-ready`·`batching` 문구와 클릭, `tx-status[data-kind=batch]` 메시지·링크, 수수료 행 kind·안내 줄을 표시한다
- 선행: T-4
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, DoD-6, DoD-13, DoD-14, DoD-15, DoD-17, DoD-20, DoD-21, DoD-22, DoD-23, DoD-24, DoD-25, EC-17
- 수정 대상: `components/primary-button.tsx` — `batchAvailable` 입력, 문구 두 개, `batch-ready → batch()`. `components/tx-status.tsx` — `batching` pending, `batch` 메시지 레코드, batch pending 링크 없음, hash 없는 결과 링크 없음. `providers/network-fee-provider.tsx` — `batchAvailable` 입력, `useNetworkFeeNote()` context 추가, `NetworkFeeState` 불변. `components/network-fee.tsx` — 안내 줄 분기, `network-fee-batch-note`
- 따라야 할 패턴: JSX 리터럴 testid, `text-muted-foreground` 안내 줄, 루트 노드 유지, 같은 입력으로 주 버튼 상태 재계산 — 근거: `components/network-fee.tsx:105-109`, `components/tx-status.tsx:75-145`, `components/primary-button.tsx:91-128`, `providers/network-fee-provider.tsx:62-107`
- 완료 조건: 연결 항목 충족. 새 testid는 `network-fee-batch-note` 하나다. 문구는 스펙 §1.1과 같다. `approve-required`에서 `network-fee-swap-pending`이 그대로 있다. 빌드가 통과한다 — 검증: T-6, T-8, T-9, `bun run build`
- 실행 명령: `bun run typecheck`, `bun run lint`, `bun run build`
- 수정 금지: `lib/`, `hooks/`, `providers/swap-execution-provider.tsx`, `providers/batch-capability-provider.tsx`, `components/swap-card.tsx`, `app/globals.css`
- 구현 기록: seongho:frontend-dev(T-2~T-4 에이전트 이어서), 작성 영역 `components/primary-button.tsx`(`batchAvailable`, 문구 `${symbol} 승인 후 스왑`·`스왑 중…`, `batch-ready → batch()`)·`components/tx-status.tsx`(`batching` pending, batch 메시지, hash 있을 때만 링크)·`providers/network-fee-provider.tsx`(`batchAvailable`, `useNetworkFeeNote()` 두 번째 context, 캐시 allowance 보정 유지, `NetworkFeeState` 불변)·`components/network-fee.tsx`(`note` 분기, `network-fee-batch-note`). 수정 0/3. 오케스트레이터 확인(2026-11-25): typecheck 통과(오류 0), lint 통과, build 통과, 새 testid는 `network-fee-batch-note` 하나. 에이전트 보고 `bun run test __tests__/swap` 303 통과

### T-6 — 통합 테스트: 배치 판정·capabilities 조회와 지갑 스텁 확장

- 사이드: 테스트
- 상태: 완료
- 목적: 스텁 지갑에 `wallet_*` 세 메서드 제어를 더하고, capability별 주 버튼 상태·활성과 조회 요청 수를 검증한다
- 선행: T-5
- 연결 항목: DoD-1, DoD-2, DoD-3, DoD-4, DoD-5, EC-1, EC-2, EC-3, EC-4
- 수정 대상: `__tests__/support/stub-eip1193.ts` — 추가만, `installWalletCalls`와 타입·매처. 필요하면 `__tests__/support/rpc-balance-stub.ts` — 추가만. `__tests__/swap/batch-capability.test.tsx` — 신규
- 따라야 할 패턴: F5·F6 지원 확장(`installWalletTransactions`의 기록·응답·붙잡기 형태), 앱 전체 렌더 하네스, testid·data 속성 판정 — 근거: `__tests__/support/stub-eip1193.ts:186-330`, `docs/plans/tx-status.md:96-111`, `__tests__/support/wagmi-harness.tsx:39-49,81-135`
- 완료 조건: 연결 항목 판정. DoD-3은 `unsupported`·체인 항목 없음·`atomic` 없음 세 표본이다. EC-1은 4200·-32601·그 밖의 오류 표본이다. EC-3은 계정 변경과 선택 체인 변경이다. EC-4는 클릭 전후 `wallet_getCapabilities` 수 비교다. 스텁 기본 4200이 유지된다. 스텁 확장 뒤 `bun run test` 결과를 기록한다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/batch-capability.test.tsx`, `bun run test`
- 수정 금지: 제품 코드, 기존 테스트 파일, 스텁의 기존 export·기본 동작, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(T-6~T-9 골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/support/stub-eip1193.ts`(+426, 추가만: `installWalletCalls` → `{capabilities, sendCalls, callsStatus}` 응답·오류·cause·붙잡기·순서열·기록, 상수·helper)·`__tests__/swap/batch-capability.test.tsx`(7 case 본문). 작성 에이전트는 실행하지 않음. 수정 0/3. 오케스트레이터 확인(2026-11-25): 골자 digest 유지, `bun run test __tests__/swap/batch-capability.test.tsx` 7/7 통과. 2026-11-26 전체 `bun run test` 57 파일 통과·1 skipped(batch-progress 골격)·463 통과·20 todo
- 테스트 파일·runner: `__tests__/swap/batch-capability.test.tsx`, Vitest jsdom
- mock 허용 경계: §1 경계(스텁 EIP-1193(injected) 지갑의 `wallet_*` 세 메서드 응답·오류·붙잡기, 사용자 확정 2026-11-24). 실제 지갑의 capabilities·상태 코드 형태는 증명하지 못한다
- 데이터 격리: 테스트마다 config·스텁·QueryClient 새로 생성, `clearCookies`

### T-7 — 통합 테스트: 전송과 전송 실패

- 사이드: 테스트
- 상태: 완료
- 목적: `wallet_sendCalls` 요청 내용·순서·원자 요구, 체인 확인, 거부·실패 분류와 강등, 연타를 검증한다
- 선행: T-6
- 연결 항목: DoD-7, DoD-8, DoD-9, DoD-10, DoD-11, EC-5, EC-6, EC-7, EC-8, EC-9, EC-10, EC-11, EC-19
- 수정 대상: `__tests__/swap/batch-send.test.tsx` — 신규
- 따라야 할 패턴: 하네스 디코더와 테스트 쪽 ABI 리터럴로 calldata 디코드, deadline 인자를 뺀 비교, 체인 전환 스텁 — 근거: `__tests__/support/wagmi-harness.tsx:339-393`, `__tests__/swap/swap-execution-progress.test.tsx:270-290`, `__tests__/swap/tx-status-failure.test.tsx:325-360`
- 완료 조건: 연결 항목 판정. DoD-7의 swap 항목은 같은 시점 `buildSwapTransactionRequest` 결과와 deadline만 빼고 같다. DoD-8은 Ethereum USDT 부분 allowance 표본이다. EC-7은 다섯 code 각각이다. EC-8·9는 강등 뒤 `approve-required`와 `eth_sendTransaction`·`wallet_sendTransaction` 0건이다. EC-11은 거부·실패 두 표본에서 `wallet_sendCalls`가 0건이다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/batch-send.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(T-6 에이전트 이어서, 살 모드, 세션 재시작으로 1회 재개), 작성 영역 `__tests__/swap/batch-send.test.tsx`(10 case 본문, calldata 디코드·deadline 제외 비교, `requestsSince` 전송 0건, EC-8 단계별 note 판정). 작성 에이전트는 실행하지 않음. 수정 0/3. 오케스트레이터 확인(2026-11-26): 골자 digest 유지, `bun run test __tests__/swap/batch-send.test.tsx` 10/10 통과
- 테스트 파일·runner: `__tests__/swap/batch-send.test.tsx`, Vitest jsdom
- mock 허용 경계: T-6과 같음
- 데이터 격리: T-6과 같음

### T-8 — 통합 테스트: 진행·결과·후처리

- 사이드: 테스트
- 상태: 완료
- 목적: phase·주 버튼·tx-status 진행, 상태 코드 대역별 결과, 링크, 금액 비우기·allowance 다시 읽기, 무기한 대기, 계정 변경을 검증한다
- 선행: T-6
- 연결 항목: DoD-12, DoD-13, DoD-14, DoD-15, DoD-16, DoD-17, DoD-18, DoD-19, DoD-20, EC-12, EC-13, EC-14, EC-15, EC-16, EC-17, EC-18, EC-20, EC-21, EC-22, EC-23, EC-24
- 수정 대상: `__tests__/swap/batch-progress.test.tsx` — 신규
- 따라야 할 패턴: 붙잡기로 phase 관찰, 탐색기 URL 리터럴, 가짜 타이머는 setTimeout·setInterval만, allowance 규칙 변경 — 근거: `__tests__/swap/tx-status-pending.test.tsx:82-97,530-560`, `__tests__/swap/tx-status-success.test.tsx`, `__tests__/swap/network-fee-refresh.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-17은 receipt 2개 이상 표본에서 마지막 hash다. EC-13~15는 대역 대표값과 대역 안 다른 값(예: 500·599, 400·404) 표본이다. EC-16은 T-1 (e)의 재시도 소진 뒤 판정한다. EC-18은 60초를 넘는 가짜 시간 동안 `batching`이 유지된다. EC-21은 revert 뒤 다시 읽은 allowance로 `batch-ready`다. EC-23은 3xx와 700 이상 표본, EC-24는 100 미만과 숫자가 아닌 값 표본이다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/batch-progress.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(새 인스턴스, 살 모드, 세션 재시작으로 1회 재개), 작성 영역 `__tests__/swap/batch-progress.test.tsx`(20 case 본문, 붙잡기·상태 순서열·가짜 타이머(EC-16·17·18), 대역 표본, receipt 0개 `[]`·없음 null 구분, EC-24 0·99·"abc"·null). 세부: DoD-17 500 표본 `[reverted, reverted]`·300 표본 `[success, success]`, 4xx는 receipt 없음, 1xx·붙잡기 표본은 판정 뒤 200으로 정리. 작성 에이전트는 실행하지 않음. 수정 0/3. 오케스트레이터 확인(2026-11-26): 골자 digest 유지, `bun run test __tests__/swap/batch-progress.test.tsx` 20/20 통과
- 테스트 파일·runner: `__tests__/swap/batch-progress.test.tsx`, Vitest jsdom
- mock 허용 경계: T-6에 가짜 타이머를 더한 것. 실제 지갑 폴링 간격은 증명하지 못한다
- 데이터 격리: T-6과 같음, 가짜 타이머는 테스트마다 원복

### T-9 — 통합 테스트: 수수료 행

- 사이드: 테스트
- 상태: 완료
- 목적: `batch-ready`의 수수료 kind·추정 요청·안내 줄·경고·ETH 부족과 스왑 추정 부재를 검증한다
- 선행: T-6
- 연결 항목: DoD-21, DoD-22, DoD-23, DoD-24, DoD-25
- 수정 대상: `__tests__/swap/batch-network-fee.test.tsx` — 신규
- 따라야 할 패턴: `matchNetworkFee.*` 매처와 추정 calldata 디코드, 같은 입력의 `approve-required` 대조 — 근거: `__tests__/support/rpc-balance-stub.ts:1219-1500`, `__tests__/swap/network-fee-estimate.test.tsx`, `__tests__/swap/network-fee-display.test.tsx`
- 완료 조건: 연결 항목 판정. DoD-21은 일반 토큰과 USDT 부분 allowance(`approve(0)`) 표본이다. DoD-24는 같은 gas·gasPrice에서 `approve-required` 표본과 `data-severity`·ETH 부족 유무가 같다. DoD-25는 `batch-ready` 동안 swap 대상 `eth_estimateGas`가 0건이고 양성 대조가 있다 — 검증: 테스트
- 실행 명령: `bun run test __tests__/swap/batch-network-fee.test.tsx`
- 수정 금지: 제품 코드, `__tests__/support/*`, 기존 테스트, 파일을 쓰는 실행 옵션
- 구현 기록: seongho:test-dev(새 인스턴스, 살 모드, 세션 재시작으로 1회 재개), 작성 영역 `__tests__/swap/batch-network-fee.test.tsx`(4 case 본문, approve 추정 calldata 디코드, swap 추정 0건·양성 대조, DoD-24 8표본 supported/unsupported 대조). 작성 에이전트는 실행하지 않음. 수정 0/3. 오케스트레이터 확인(2026-11-26): 골자 digest 유지, `bun run test __tests__/swap/batch-network-fee.test.tsx` 4/4 통과
- 테스트 파일·runner: `__tests__/swap/batch-network-fee.test.tsx`, Vitest jsdom
- mock 허용 경계: T-6에 F10 수수료 3분류 스텁을 더한 것. 지갑이 보여 줄 실제 배치 수수료는 증명하지 못한다(스펙 비목표)
- 데이터 격리: T-6과 같음

### T-10 — 포크 통합 테스트

- 사이드: 테스트
- 상태: 완료
- 목적: 고정 블록 Ethereum 포크에서 앱 `buildBatchCalls` 결과를 7702 실행 컨트랙트로 한 트랜잭션에 실행해 원자 체결과 revert 원복을 검증한다
- 선행: T-1, T-2
- 연결 항목: DoD-30, DoD-31
- 수정 대상: `__tests__/fork/batch-calls.fork.test.ts` — 신규
- 따라야 할 패턴: 프록시 경유 판정 읽기, `vi.stubEnv`, snapshot/revert, 위임 표식 확인·교체 뒤 revert, QuoterV2 직접 견적으로 최소 수령량, revert 관찰용 명시 gas — 근거: `__tests__/fork/approve-swap.fork.test.ts:34-80`, `__tests__/fork/native-eth.fork.test.ts:52-62,256-270`
- 완료 조건: 연결 항목 판정. 실행 컨트랙트·위임 수단·표본은 T-1 (b)를 따른다. DoD-30은 tx 1건, receipt success, 받는 토큰 증가다. DoD-31은 최소 수령량을 견적보다 크게 둔 calls의 receipt가 reverted이고 allowance가 실행 전과 같다. T-1이 제외로 정하면 사유를 구현 기록과 §5에 남기고 파일을 만들지 않는다. 기존 포크 테스트가 통과한다 — 검증: 테스트
- 실행 명령: `bun run test:fork`
- 수정 금지: 제품 코드, 기존 `__tests__/fork/*`, `vitest.fork.config.mts`
- 구현 기록: seongho:test-dev(T-10 골격 작성 에이전트, 살 모드), 작성 영역 `__tests__/fork/batch-calls.fork.test.ts`(2 case 본문, Simple7702Account `anvil_setCode` 위임 표식·코드 단정, 앱 `buildBatchCalls`로 calls 생성, `executeBatch` 자기 호출 명시 gas 1M·800k, DoD-30은 receipt success·nonce +1·같은 영수증의 Approval·DAI Transfer·DAI 증가, DoD-31은 최소 수령량 견적+1·receipt reverted·allowance 불변, 프록시 경유 판정 읽기, snapshot/revert). 작성 에이전트는 실행하지 않음. 수정 0/3. 오케스트레이터 확인(2026-11-25): 골자 digest `64d4f90c6d10b79a` 유지, `bun run test:fork` 8 파일 25/25 통과(기존 23 + 신규 2). 실행 환경 주의: 이 셸은 PATH에 `/root/.foundry/bin`이 없어 globalSetup이 anvil 기동에 실패했고 vite 오류 출력 버그로 "No test files found"만 보였다. worktree에 `.env.local`이 없어 main checkout 값을 환경 변수로만 주입했다
- 테스트 파일·runner: `__tests__/fork/batch-calls.fork.test.ts`, Vitest(`vitest.fork.config.mts`, anvil 8547)
- mock 허용 경계: 없음(실제 anvil 포크, `vi.stubEnv`, 준비 단계의 anvil 직접 상태 변경, Simple7702Account 위임 표식). 실제 지갑의 위임 컨트랙트와 Base·Arbitrum은 증명하지 못한다
- 데이터 격리: snapshot/revert, 전용 포트 8547, 파일 순차

### T-11 — 기존 테스트 회귀 확인

- 사이드: 테스트
- 상태: 완료
- 목적: 배치 기본 꺼짐(스텁 4200·mock 커넥터 응답)에서 기존 테스트를 수정 없이 실행해 결과를 기록한다
- 선행: T-5, T-6
- 연결 항목: DoD-26
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 이전 기능 동결 확인, 명령 순차 실행 — 근거: `docs/plans/network-fee.md:212-228`
- 완료 조건: `bun run test` 3회, `test:fork`, `test:e2e`, `typecheck` 결과와 T-1 (f) 위험 case 결과를 기록한다. F1~F10 골자 digest가 유지된다. 실패는 고치지 않고 스펙 §4.5 절차로 보고한다 — 검증: 명령 실행
- 실행 명령: `bun run test`(3회), `bun run test:fork`, `bun run test:e2e`, `bun run typecheck`
- 수정 금지: 저장소 파일
- 구현 기록: seongho:test-runner(실행 전용, 세션 재시작으로 1회 재개, 처음부터 재실행). 2026-11-26, 코드 기준 HEAD 8de387e + 작업 트리(실행 전후 `git status` 동일). `bun run typecheck` 통과, `bun run test` 3회 모두 58/58 파일·483/483, `bun run test:fork` 8/8 파일·25/25, `bun run test:e2e` 38 통과·1 skipped(`e2e/batch-calls.spec.ts` `test.fixme` 골격)·실패 0, F1~F11 digest 일치(`/root/study/.pipeline-scratch/batch-calls/frozen-all.sh`). T-1 (f) 위험 case(wrap-execute·swap-execute·tx-status-lifetime·network-fee-display, E2E chain·approve-swap 계열) 모두 통과. 실행 환경: PATH에 `/root/.foundry/bin`, `ETH_MAINNET_RPC_URL`은 main checkout 값을 환경 변수로만 주입. 동결 테스트 실패 0건이라 스펙 §4.5 보고 대상 없음
- 테스트 파일·runner: 기존 파일, Vitest·Playwright
- mock 허용 경계: 기존 그대로
- 데이터 격리: 기존 그대로
- 실행 환경: 앱 3100·anvil 8546 독점, `check:build`와 동시 실행 금지

### T-12 — 동결 테스트 회귀 갱신(조건부)

- 사이드: 테스트
- 상태: 완료
- 목적: T-1 (f)·T-11에서 깨진 동결 case 중 스펙 §4.5에 사용자 승인이 추가된 것만 판정 보조를 고친다
- 선행: T-11, 사용자 승인
- 연결 항목: DoD-26
- 수정 대상: 승인된 case만. 대상이 없으면 이 Task는 건너뛰고 기록한다
- 따라야 할 패턴: 동결 골격은 assertion·판정 보조만 바꾸고 `@given/@when/@then`과 it 이름은 바꾸지 않는다 — 근거: `docs/plans/network-fee.md:230-245`, `docs/plans/tx-status.md:181-197`
- 완료 조건: 승인 범위만 바뀌고 해당 기능의 골자 digest가 전후로 같다. 원래 판정 의도가 유지된다 — 검증: 해당 파일 실행, `bun run typecheck`, 동결 확인 명령
- 실행 명령: 승인된 파일 경로를 붙인 `bun run test`, `bun run typecheck`
- 수정 금지: 제품 코드, 승인 밖의 기존 테스트, `__tests__/support/*`
- 구현 기록: 건너뜀(2026-11-26). T-1 (f)에서 동결 테스트 tsc 실패 0건(`PendingTx` batch 분기 `hash?: undefined`), T-11에서 기존 테스트 실패 0건이라 갱신 대상이 없다. 수정 파일 없음
- 테스트 파일·runner: 승인된 파일, Vitest jsdom
- mock 허용 경계: 기존 그대로
- 데이터 격리: 기존 그대로

### T-13 — E2E

- 사이드: E2E
- 상태: 완료
- 목적: mock 지갑에 배치 opt-in을 더하고, 실제 브라우저·anvil에서 ERC-20 입력 스왑을 지갑 요청 한 번으로 체결한다
- 선행: T-1, T-5, T-11(T-12가 실행되면 T-12)
- 연결 항목: DoD-27, DoD-28, DoD-29
- 수정 대상: `config/e2e-mock.ts` — 래퍼에 추가만, 배치 opt-in 제어값, 켜졌을 때 체인 1 `wallet_getCapabilities` 응답과 T-1 (a)에서 정한 `wallet_sendCalls`·`wallet_getCallsStatus` 구현, 꺼지면 기존 mock 동작 그대로. `e2e/batch-calls.spec.ts` — 신규. `e2e/support/batch-calls.ts` — 신규, locator·opt-in 켜기·지갑 전송 요청 집계·필요하면 위임 표식 설정. `e2e/support/anvil.ts` — 추가만, 필요하면 `anvil_setCode` 표식 설정
- 따라야 할 패턴: `connectError`·`sendTransactionError`와 같은 요청 시점 제어값, 연결 전 제어값 설정, `walletRequests` 기록, `setErc20Balance`, snapshot/revert, `beforeAll` 예열, `page.route` 금지 — 근거: `config/e2e-mock.ts:24-35,111-127`, `e2e/support/approve-swap.ts:54-72`, `e2e/approve-swap.spec.ts:14-15,64,89`, `e2e/support/anvil.ts:40-60,198-249,323-360`, `e2e/support/native-eth.ts:31-45`
- 완료 조건: 연결 항목 판정. DoD-28 기대는 러너가 anvil에서 직접 읽은 잔액이다. DoD-29는 클릭 뒤 `walletRequests` 집계다. 제어값을 켜지 않은 기존 E2E 동작이 바뀌지 않는다. `check:build`가 통과한다(표식은 e2e-mock 모듈 안에만). E2E 전체가 통과한다 — 검증: E2E, `bun run check:build`(단독)
- 실행 명령: `bun run test:e2e e2e/batch-calls.spec.ts`, `bun run test:e2e`, 그 뒤 단독으로 `bun run check:build`
- 수정 금지: `config/e2e-mock.ts` 추가분 밖의 제품 코드, 기존 `e2e/*.spec.ts`, `e2e/support/app.ts`, `e2e/support/network.ts`, `e2e/support/approve-swap.ts`, `playwright.config.ts`
- 구현 기록: 작업 분리(오케스트레이터 라우팅): 제품 코드 `config/e2e-mock.ts`는 seongho:frontend-dev(T-2~T-5 에이전트 이어서, e2e-dev는 제품 코드를 고치지 않으므로), E2E 테스트는 seongho:e2e-dev(T-13 골격 작성 에이전트, 살 모드). 작성 영역: `config/e2e-mock.ts`(+139 −1, 제어값 `atomicBatch` 기본 꺼짐·요청 시점 읽기, 켜면 `wallet_getCapabilities` 0x1 supported·`wallet_sendCalls` → 체인 1 provider로 `executeBatch` 자기 호출 1건(gas 0xf4240)·`wallet_getCallsStatus` 100/200/500, 내부 요청은 `walletRequests`·`sendTransactionError` 밖)·`e2e/batch-calls.spec.ts`(1 case 본문, snapshot 뒤 Simple7702Account 위임 표식·코드 단정, USDC→DAI 5, 앱 로드 전 opt-in, 클릭 1회, anvil 직접 잔액 비교, `walletRequests` 집계)·`e2e/support/batch-calls.ts`(신규 helper)·`e2e/support/anvil.ts`(+8, `setAccountCode` 추가만). 수정 0/3. DoD-28은 스펙 문구대로 대소 비교만(정확한 감소량 판정 없음). 오케스트레이터 확인(2026-11-26): F11 digest 유지, typecheck·lint 통과, `bun run test:e2e e2e/batch-calls.spec.ts` 1/1 통과(7.2s), `bun run test:e2e` 39/39 통과(3.0m, 업체 RPC timeout 로그 있었으나 실패 없음), 그 뒤 단독 `bun run check:build` 통과
- 테스트 파일·runner: `e2e/batch-calls.spec.ts`, Playwright chromium
- mock 허용 경계: mock 커넥터 + `config/e2e-mock.ts` 배치 opt-in 제어값(테스트가 켤 때만) + 러너→anvil 준비(잔액 주입, snapshot/revert, 필요하면 위임 표식), `page.route` 금지. 방식은 A2(사용자 확정 2026-11-24). 실제 지갑의 확인 UI·위임 컨트랙트·WAF는 증명하지 못한다
- 데이터 격리: snapshot/revert, `workers: 1`, 테스트별 컨텍스트
- 실행 환경: 앱 3100(`NEXT_PUBLIC_E2E_MOCK=1`, `.next-e2e`), anvil 8546(`--block-time 1`), 포크 블록·포트 `config/e2e.ts`, 계정 `config/e2e-mock.ts`, Ethereum만, `check:build`와 동시 실행 금지

### T-14 — 수동 확인과 전체 검사

- 사이드: 검증
- 상태: 완료
- 목적: 실제 MetaMask 메인넷 체결을 기록하고 전체 명령·동결·코드 대조를 확인한다
- 선행: T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, T-10, T-11, T-12, T-13
- 연결 항목: DoD-6, DoD-26, DoD-32
- 수정 대상: 없음. 결과는 구현 기록에 남긴다
- 따라야 할 패턴: 수동 확인 기록 형식, 명령 순차 실행, `check:build`는 `test:e2e` 뒤 단독 — 근거: `docs/plans/approve-swap.md:236-246`, `docs/plans/network-fee.md:265-277`
- 완료 조건: DoD-32는 사용자가 수행하고 날짜·계정 축약·체인·페어·금액·지갑 확인 횟수·tx 해시를 기록한다(에이전트 대행 금지). DoD-6은 코드 대조다. 명령이 모두 통과하고 `bun run test`는 3회 같은 결과다. F1~F10 digest가 일치한다. 코드 대조 항목: `forceAtomic: true`, `experimental_fallback` 미사용, `timeout: 0`, 프록시 허용 목록·`package.json`·`bun.lock`·환경 변수 무변경 — 검증: 확인 절차, 명령 실행
- 실행 명령: `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`(3회), `bun run build`, `bun run test:fork`, `bun run test:e2e`, 그 뒤 단독 `bun run check:build`
- 수정 금지: 저장소 파일
- 구현 기록: 오케스트레이터 명령 실행(2026-11-26): `bun run format:check` 통과, `bun run lint` 통과, `bun run typecheck` 통과, `bun run test` 3회 58/58·483/483(T-11 test-runner), `bun run build` 통과, `bun run test:fork` 25/25, `bun run test:e2e` 39/39, 단독 `bun run check:build` 통과, F1~F11 digest 일치. 코드 대조: `forceAtomic: true`(`providers/swap-execution-provider.tsx:710`), `experimental_fallback`은 주석에만, 배치 경로 `retryCount` 지정 없음, `waitForCallsStatus` `timeout: 0`(`:615`), `config/rpc.ts`·`lib/rpc-proxy.ts`·`package.json`·`bun.lock`·`.env*`·`lib/swap-transaction.ts`·이전 스펙 파일 무변경, 새 testid는 `network-fee-batch-note` 하나, DoD-6 문구 `${symbol} 승인 후 스왑`(`components/primary-button.tsx:116`)·`스왑 중…`(`:36`) 스펙 §1.1 일치. **DoD-32(사용자 메인넷 수동 1회)는 이번에 하지 않는다**(사용자 결정 2026-11-26). 실제 MetaMask의 capabilities·오류·상태 코드 형태, 확인 UI, 위임 컨트랙트, Base·Arbitrum 배치 실행은 미검증으로 남긴다

## 3. 항목 coverage

- DoD-1: T-2, T-3, T-5, T-6
- DoD-2: T-2, T-3, T-5, T-6
- DoD-3: T-2, T-3, T-5, T-6
- DoD-4: T-3, T-5, T-6
- DoD-5: T-2, T-5, T-6
- DoD-6: T-5, T-14 (코드 대조만, 테스트 제외: 문구 판정 테스트 금지 규칙)
- DoD-7: T-1, T-2, T-4, T-7
- DoD-8: T-2, T-4, T-7
- DoD-9: T-1, T-4, T-7
- DoD-10: T-4, T-7
- DoD-11: T-4, T-7
- DoD-12: T-4, T-8
- DoD-13: T-2, T-4, T-5, T-8
- DoD-14: T-5, T-8
- DoD-15: T-5, T-8
- DoD-16: T-1, T-2, T-4, T-8
- DoD-17: T-2, T-4, T-5, T-8
- DoD-18: T-4, T-8
- DoD-19: T-4, T-8
- DoD-20: T-4, T-5, T-8
- DoD-21: T-2, T-5, T-9
- DoD-22: T-2, T-5, T-9
- DoD-23: T-2, T-5, T-9
- DoD-24: T-5, T-9
- DoD-25: T-2, T-5, T-9
- DoD-26: T-1, T-11, T-12, T-14 (기존 테스트 명령 실행 판정, 새 테스트 제외)
- DoD-27: T-1, T-13
- DoD-28: T-1, T-13
- DoD-29: T-1, T-13
- DoD-30: T-1, T-2, T-10 (T-1이 실행 컨트랙트 없음으로 정하면 사유를 기록하고 제외)
- DoD-31: T-1, T-2, T-10 (제외 조건 DoD-30과 같음)
- DoD-32: T-14 (사용자 수동 1회, 자동 테스트 제외)
- EC-1: T-1, T-3, T-6
- EC-2: T-1, T-3, T-6
- EC-3: T-3, T-6
- EC-4: T-3, T-4, T-6
- EC-5: T-2, T-4, T-7
- EC-6: T-4, T-7
- EC-7: T-1, T-2, T-4, T-7
- EC-8: T-3, T-4, T-7
- EC-9: T-4, T-7
- EC-10: T-2, T-4, T-7
- EC-11: T-4, T-7
- EC-12: T-2, T-4, T-8
- EC-13: T-1, T-2, T-4, T-8
- EC-14: T-1, T-2, T-4, T-8
- EC-15: T-1, T-2, T-4, T-8
- EC-16: T-1, T-2, T-4, T-8
- EC-17: T-4, T-5, T-8
- EC-18: T-1, T-4, T-8
- EC-19: T-4, T-7
- EC-20: T-4, T-8
- EC-21: T-4, T-8
- EC-22: T-1, T-2, T-4, T-8
- EC-23: T-1, T-2, T-4, T-8
- EC-24: T-2, T-4, T-8

## 4. 실행 순서

- 1구간(병렬): T-1(저장소 수정 없음, anvil 8565·8566) / T-2(`lib/primary-button-state.ts`, `lib/tx-result.ts`, `lib/batch-calls.ts`, `lib/network-fee.ts`)
- 2구간(병렬): T-3(`hooks/use-wallet-capabilities-read.ts`, `providers/batch-capability-provider.tsx`, `providers/app-providers.tsx`) / T-10(`__tests__/fork/batch-calls.fork.test.ts`, anvil 8547 독점). 두 Task 모두 T-1·T-2 뒤이고 공유 파일이 없다
- 3구간: T-4(`providers/swap-execution-provider.tsx`)
- 4구간: T-5(`components/primary-button.tsx`, `components/tx-status.tsx`, `components/network-fee.tsx`, `providers/network-fee-provider.tsx`)
- 5구간(단독): T-6. 공용 `__tests__/support/stub-eip1193.ts`(필요하면 `rpc-balance-stub.ts`)를 고친다
- 6구간(병렬): T-7 / T-8 / T-9. 각자 신규 파일 하나만 고치고 `__tests__/support/*`는 고치지 않는다
- 7구간(단독): T-11. 수정 없음, E2E 포트 독점
- 8구간(단독, 조건부): T-12
- 9구간(단독): T-13. 3100·8546 독점, `config/e2e-mock.ts`의 유일한 소유자
- 10구간(단독): T-14
- 테스트 설계(골격 동결)는 구현 전에 T-6~T-10·T-13의 골격을 고정한다. 제외 후보는 DoD-6(코드 대조), DoD-26(기존 테스트 명령), DoD-32(사용자 수동)이고, DoD-30·31은 T-1이 제외로 정하면 더한다
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/batch-calls.md --files __tests__/swap/batch-capability.test.tsx __tests__/swap/batch-send.test.tsx __tests__/swap/batch-progress.test.tsx __tests__/swap/batch-network-fee.test.tsx __tests__/fork/batch-calls.fork.test.ts e2e/batch-calls.spec.ts --exempt DoD-6,DoD-26,DoD-32`

## 5. 차단 사항

- T-1 (a)에서 E2E 배치 실행 경로를 만들 수 없으면 DoD-27~29를 이룰 수 없으므로 인터뷰로 되돌린다
- T-1 (b)에서 쓸 수 있는 7702 실행 컨트랙트가 없으면 DoD-30·31을 제외하고 사유를 이 절과 T-10 구현 기록에 남긴다(스펙 허용)
- T-1 (f)·T-11에서 동결 case가 실패하면 고치지 않고 보고해 스펙 §4.5 승인을 받는다(T-12)

## 테스트 설계 증거

- 상태: PASS(사용자 확정 동결, 2026-11-25). 마지막 수정(EC-2 `@when` 시간 창 60초 초과)은 reviewer PASS 없이 기계 검사로 동결했다(사용자 결정)
- 기준 스펙: `docs/specs/batch-calls.md`(확정, 최종 갱신 2026-11-25, DoD-1~~32·EC-1~~24)
- 골자 digest: `64d4f90c6d10b79a`(항목 56개 중 case 연결 53개, 제외 3개, case 44개)
- 골격 파일: `__tests__/swap/batch-capability.test.tsx`(7, `it.todo`), `__tests__/swap/batch-send.test.tsx`(10), `__tests__/swap/batch-progress.test.tsx`(20), `__tests__/swap/batch-network-fee.test.tsx`(4), `__tests__/fork/batch-calls.fork.test.ts`(2), `e2e/batch-calls.spec.ts`(1, `test.fixme`)
- 동결 확인 명령: `python3 /root/study/skills/dev-pipeline/skills/test-design/scripts/check-skeleton.py --spec docs/specs/batch-calls.md --files __tests__/swap/batch-capability.test.tsx __tests__/swap/batch-send.test.tsx __tests__/swap/batch-progress.test.tsx __tests__/swap/batch-network-fee.test.tsx __tests__/fork/batch-calls.fork.test.ts e2e/batch-calls.spec.ts --exempt DoD-6,DoD-26,DoD-32 --frozen 64d4f90c6d10b79a`
- 작성: seongho:test-dev(T-6~T-9 한 에이전트, T-10 한 에이전트), seongho:e2e-dev(T-13). 골격 모드, 실행 없음
- reviewer 라운드: 새 general-purpose 5회. 1회 NEEDS-DECISION(F 8건, D-1~4), 2회 NEEDS-FIX(medium 5), 3회 NEEDS-FIX(medium 1·low 4), 4회 NEEDS-FIX(medium 1, EC-16 회복 표본), 5회 NEEDS-FIX(medium 1, EC-2 시간 창). 자동 3회 한도 초과는 사용자가 4·5회를 허용했다. 매 라운드 뒤 `git status`·`--frozen`으로 reviewer 무수정 확인
- 사람 확정(2026-11-24~25):
  - 제외: DoD-6(문구, 코드 대조), DoD-26(기존 테스트 명령 실행), DoD-32(사용자 메인넷 수동 1회)
  - mock 경계: 통합은 실제 wagmi·Provider·화면 + 스텁 EIP-1193(injected) 지갑의 `wallet_*` 세 메서드 응답·오류·붙잡기 + fetch URL 라우팅 스텁 + 가짜 타이머(T-8) + F10 수수료 스텁(T-9), `vi.mock` 금지. 포크는 실제 anvil + Simple7702Account `anvil_setCode` 위임 표식. E2E는 mock 커넥터 + 테스트가 켤 때만 동작하는 A2 래퍼 + 러너→anvil 준비, `page.route` 금지
  - 골자 결정: DoD-18은 체인·계정 변경 뒤 성공 시 금액 유지(반대 경우)를 포함한다. 동결은 T-1 결과 뒤. DoD-30·31 제외 시 다시 묻기(T-1이 실행 컨트랙트를 찾아 해당 없음)
  - 스펙 갱신(이 단계에서): EC-16 재시도 문구, EC-24 추가, §1.1 링크 규칙 명확화
- 미검증·검증 불가: 실제 지갑의 capabilities·오류 code·cause 구조·상태 코드·폴링 간격, 실제 지갑의 위임 컨트랙트, Base·Arbitrum 배치 실행, 지갑 확인 UI, WAF. 실제 MetaMask 경로는 DoD-32 수동 1회에만 기댄다. E2E 성공은 래퍼가 만든 상태 응답에 기댄다
- 살 단계 주의: EC-24 표본에 `"CONFIRMED"`·`"PENDING"`(viem이 200·100으로 변환)·숫자 문자열을 쓰지 않는다. 4xx·receipt 있음 표본을 만들지 않는다. DoD-30 "트랜잭션 1건" `@then`은 nonce·로그 등으로 관찰 방법을 구체화한다. EC-16 회복 표본 4회는 viem retryCount 4(요청 5건) 안이다. USDC는 max allowance도 차감한다

### 검증 기록

- 1차 검증(2026-11-26): 코드 기준 HEAD 8de387e + 작업 트리(`git status` 해시 7767dc4b6fda, `git diff` 해시 e53b0132fe13, 검증 전후 동일). 세 역할 모두 새 인스턴스, 구현 대화 미전달
- 스펙 대조: 새 general-purpose + `seongho:verify` — 충족 54, 부분·미충족 0, 검증 불가 2(DoD-26 명령 실행 항목, DoD-32 사용자 수동 미실시). §4.1~§4.5·§1.1 일치, F1~F11 digest 일치, 범위 초과·수정 금지 위반·테스트 변조 0. 낮음 3건: (1) EC-2 왕복(다른 계정·체인 → 원래 키, 재연결) 시 같은 키 재조회 — 스펙 EC-2·EC-3 경계 모호, (2) `timeout: 0`이라 1xx 지속 시 계정 변경·언마운트 뒤에도 상태 폴링 지속(결과는 세대 가드가 버림, 기존 영수증 대기와 같은 방식), (3) §1.1 표 success 링크 "있음"이지만 receipt 0개 success(EC-22)는 링크 없음 — §4.1·EC-17을 따름
- 테스트 실행: seongho:test-runner — PASS. format·lint·typecheck 통과, `bun run test` 3회 58/58 파일·483/483(todo·skipped 0), build 통과, `test:fork` 8/8·25/25, 배치 4개 파일 verbose 41/41, `__tests__/lib` 94/94, F1~F11 digest 일치
- E2E 실행: seongho:e2e-runner — PASS. `test:e2e e2e/batch-calls.spec.ts` 1/1, `test:e2e` 39/39(기존 38 + 배치 1, flaky·skipped 0), 그 뒤 단독 `check:build` 통과

| 스펙 항목 | 코드 대조 (`verify`)              | 실행 확인 (`test-runner`·`e2e-runner`)                                                                   | 종합   |
| --------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ |
| DoD-1     | 충족                              | 확인됨: batch-capability [DoD-1][DoD-2][DoD-5]                                                           | 충족   |
| DoD-2     | 충족                              | 확인됨: batch-capability [DoD-1][DoD-2][DoD-5]                                                           | 충족   |
| DoD-3     | 충족                              | 확인됨: batch-capability [DoD-3]                                                                         | 충족   |
| DoD-4     | 충족                              | 확인됨: batch-capability [DoD-4]                                                                         | 충족   |
| DoD-5     | 충족                              | 확인됨: batch-capability [DoD-1][DoD-2][DoD-5]                                                           | 충족   |
| DoD-6     | 충족(코드 대조, 문구 바이트 일치) | 제외(설계상)                                                                                             | 충족   |
| DoD-7     | 충족                              | 확인됨: batch-send [DoD-7][DoD-9][DoD-10]                                                                | 충족   |
| DoD-8     | 충족                              | 확인됨: batch-send [DoD-8]                                                                               | 충족   |
| DoD-9     | 충족                              | 확인됨: batch-send [DoD-7][DoD-9][DoD-10]                                                                | 충족   |
| DoD-10    | 충족                              | 확인됨: batch-send [DoD-7][DoD-9][DoD-10]                                                                | 충족   |
| DoD-11    | 충족                              | 확인됨: batch-send [DoD-11]                                                                              | 충족   |
| DoD-12    | 충족                              | 확인됨: batch-progress [DoD-12]                                                                          | 충족   |
| DoD-13    | 충족                              | 확인됨: batch-progress [DoD-13][DoD-14][DoD-15]                                                          | 충족   |
| DoD-14    | 충족                              | 확인됨: batch-progress [DoD-13][DoD-14][DoD-15]                                                          | 충족   |
| DoD-15    | 충족                              | 확인됨: batch-progress [DoD-13][DoD-14][DoD-15]                                                          | 충족   |
| DoD-16    | 충족                              | 확인됨: batch-progress [DoD-16][DoD-18], [EC-16][DoD-16]                                                 | 충족   |
| DoD-17    | 충족                              | 확인됨: batch-progress [DoD-17]                                                                          | 충족   |
| DoD-18    | 충족                              | 확인됨: batch-progress [DoD-16][DoD-18], [DoD-18], [EC-20][DoD-18]                                       | 충족   |
| DoD-19    | 충족                              | 확인됨: batch-progress [DoD-19]                                                                          | 충족   |
| DoD-20    | 충족                              | 확인됨: batch-progress [DoD-20]                                                                          | 충족   |
| DoD-21    | 충족                              | 확인됨: batch-network-fee [DoD-21]                                                                       | 충족   |
| DoD-22    | 충족                              | 확인됨: batch-network-fee [DoD-22][DoD-23]                                                               | 충족   |
| DoD-23    | 충족                              | 확인됨: batch-network-fee [DoD-22][DoD-23]                                                               | 충족   |
| DoD-24    | 충족                              | 확인됨: batch-network-fee [DoD-24]                                                                       | 충족   |
| DoD-25    | 충족                              | 확인됨: batch-network-fee [DoD-25]                                                                       | 충족   |
| DoD-26    | 검증 불가(명령 항목, 전제 충족)   | 확인됨: `bun run test` 3회 58/58·483/483, `test:fork` 25/25, `test:e2e` 기존 38 통과, F1~F11 digest 일치 | 충족   |
| DoD-27    | 충족                              | 확인됨: e2e batch-calls [DoD-27][DoD-28][DoD-29]                                                         | 충족   |
| DoD-28    | 충족                              | 확인됨: e2e batch-calls [DoD-27][DoD-28][DoD-29]                                                         | 충족   |
| DoD-29    | 충족                              | 확인됨: e2e batch-calls [DoD-27][DoD-28][DoD-29]                                                         | 충족   |
| DoD-30    | 충족                              | 확인됨: fork batch-calls [DoD-30]                                                                        | 충족   |
| DoD-31    | 충족                              | 확인됨: fork batch-calls [DoD-31]                                                                        | 충족   |
| DoD-32    | 검증 불가                         | 미실행: 사용자 메인넷 수동 1회 대기                                                                      | 미검증 |
| EC-1      | 충족                              | 확인됨: batch-capability [EC-1]                                                                          | 충족   |
| EC-2      | 충족                              | 확인됨: batch-capability [EC-2]                                                                          | 충족   |
| EC-3      | 충족                              | 확인됨: batch-capability [EC-3]                                                                          | 충족   |
| EC-4      | 충족                              | 확인됨: batch-capability [EC-4]                                                                          | 충족   |
| EC-5      | 충족                              | 확인됨: batch-send [EC-5][EC-6]                                                                          | 충족   |
| EC-6      | 충족                              | 확인됨: batch-send [EC-5][EC-6]                                                                          | 충족   |
| EC-7      | 충족                              | 확인됨: batch-send [EC-7][EC-9]                                                                          | 충족   |
| EC-8      | 충족                              | 확인됨: batch-send [EC-8]                                                                                | 충족   |
| EC-9      | 충족                              | 확인됨: batch-send [EC-7][EC-9]                                                                          | 충족   |
| EC-10     | 충족                              | 확인됨: batch-send [EC-10]                                                                               | 충족   |
| EC-11     | 충족                              | 확인됨: batch-send [EC-11] 두 case                                                                       | 충족   |
| EC-12     | 충족                              | 확인됨: batch-progress [EC-12]                                                                           | 충족   |
| EC-13     | 충족                              | 확인됨: batch-progress [EC-13]                                                                           | 충족   |
| EC-14     | 충족                              | 확인됨: batch-progress [EC-14]                                                                           | 충족   |
| EC-15     | 충족                              | 확인됨: batch-progress [EC-15]                                                                           | 충족   |
| EC-16     | 충족                              | 확인됨: batch-progress [EC-16], [EC-16][DoD-16]                                                          | 충족   |
| EC-17     | 충족                              | 확인됨: batch-progress [EC-17]                                                                           | 충족   |
| EC-18     | 충족                              | 확인됨: batch-progress [EC-18]                                                                           | 충족   |
| EC-19     | 충족                              | 확인됨: batch-send [EC-19]                                                                               | 충족   |
| EC-20     | 충족                              | 확인됨: batch-progress [EC-20][DoD-18]                                                                   | 충족   |
| EC-21     | 충족                              | 확인됨: batch-progress [EC-21]                                                                           | 충족   |
| EC-22     | 충족                              | 확인됨: batch-progress [EC-22]                                                                           | 충족   |
| EC-23     | 충족                              | 확인됨: batch-progress [EC-23]                                                                           | 충족   |
| EC-24     | 충족                              | 확인됨: batch-progress [EC-24]                                                                           | 충족   |

- 8단계 사용자 결정(2026-11-26): DoD-32는 이번에 하지 않고 미검증으로 남긴다. verify 낮음 3건은 현재 동작을 유지하고 스펙 문구만 명확히 했다 — §1.1 success 링크 "receipt가 있을 때만", EC-2 "같은 계정·체인이 유지되는 동안, 왕복·재연결은 EC-3의 바뀜". 판정 의도와 골격 태그는 바뀌지 않아(F11 digest `64d4f90c6d10b79a` 유지) 재검증하지 않았다. 1xx 지속 시 계정 변경·언마운트 뒤에도 상태 폴링이 이어지는 것은 기존 영수증 대기(`waitForTransactionReceipt` `timeout: 0`)와 같은 알려진 동작으로 둔다(결과는 세대 가드가 버린다)
