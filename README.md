# GOPEPE Swap

이더리움·Base·Arbitrum 메인넷에서 쓰는 Uniswap V3 단일 홉 스왑 UI다.

## 라이브 링크

https://gopepe-swap.vercel.app

## 주요 기능 (v1)

- Ethereum·Base·Arbitrum 메인넷을 헤더 드롭다운에서 고른다. 트랜잭션을 보내기 직전에 지갑 네트워크를 선택한 체인으로 자동 전환한다.
- EIP-6963으로 감지한 브라우저 지갑을 연결한다.
- 체인별 토큰 목록에서 보낼 토큰과 받을 토큰을 고르고, 잔액을 보며 보낼 금액을 입력한다. ETH `최대`는 가스 몫(Ethereum 0.005 ETH, Base·Arbitrum 0.0005 ETH)을 남긴다.
- QuoterV2로 수수료 티어 0.01%·0.05%·0.3%·1%를 모두 견적하고 수령량이 가장 많은 티어를 자동으로 고른다. 예상 수령량, 환율, 가격 영향, 수수료 티어를 보여 준다.
- 슬리피지 허용치를 0.1%·0.5%·1.0% 프리셋에서 고르고(기본 0.5%), 최소 수령량에 반영한다.
- ERC-20 간 스왑은 SwapRouter02 승인이 부족하면 승인 트랜잭션을 먼저 보내고, 충분하면 스왑 트랜잭션을 보낸다.
- ETH를 보내는 스왑은 승인 없이 보내고, ETH를 받는 스왑은 WETH를 ETH로 풀어서 받는다. ETH ↔ WETH는 견적 없이 1:1로 전환한다.
- 가격 영향이 15%를 넘으면 ETH가 낀 스왑을 포함해 스왑을 막는다.
- 주 버튼 아래에 트랜잭션 진행 상태와 결과(성공, 거절, 네트워크 전환 실패, 전송 실패, revert, 확인 실패, 취소·대체)를 보여 주고 블록 탐색기 링크를 단다.

## 로컬 실행·환경 변수

Node는 `.nvmrc`의 24.21.0, 패키지 매니저는 bun 1.4.2를 쓴다.

```bash
cp .env.example .env.local
bun install
bun run dev
```

개발 서버는 http://localhost:3000 에서 열린다.

`.env.local`에는 체인별 업체 RPC URL 3개를 넣는다. 서버의 RPC 프록시(`/api/rpc/[chainId]`)만 읽는 값이라 브라우저에 노출되지 않는다.

| 변수                   | 체인     |
| ---------------------- | -------- |
| `ETH_MAINNET_RPC_URL`  | Ethereum |
| `BASE_MAINNET_RPC_URL` | Base     |
| `ARB_MAINNET_RPC_URL`  | Arbitrum |

값을 비워 두면 그 체인은 공개 RPC(viem 기본 RPC)로 동작한다. 업체 RPC 호출이 실패해도 공개 RPC로 넘긴다.

테스트:

```bash
bun run test       # 단위·통합 테스트
bun run test:fork  # anvil Ethereum 포크 통합 테스트
bun run test:e2e   # Playwright E2E
```

`test:fork`와 `test:e2e`는 Foundry의 `anvil`과 `ETH_MAINNET_RPC_URL`이 필요하다. Playwright를 처음 실행하기 전에 `bunx playwright install chromium`으로 브라우저를 설치한다.

## 알려진 한계

- `eth_call` 가스 상한: 견적은 가스를 지정하지 않은 `eth_call`로 받으므로 노드의 기본 가스 상한을 따른다. 2026-11-21 측정값은 업체 RPC가 Ethereum 550M, Base 550M, Arbitrum 1.1B이고, 공개 RPC가 Ethereum 50M, Base 600M, Arbitrum 50M이다. 배포 사이트는 업체 RPC를 쓰고, 업체 RPC가 실패하거나 환경 변수가 없으면(로컬에서 비워 둔 경우, preview 배포) 공개 RPC를 쓴다. 공개 RPC의 50M 상한에서는 유동성을 거의 다 쓰는 아주 큰 금액의 견적에서 일부 수수료 티어가 후보에서 빠지거나 견적이 실패할 수 있다.
- EIP-7702 계정의 unwrap 실패 가능성: WETH를 ETH로 전환할 때 WETH 컨트랙트는 ETH를 2300 가스로 보낸다. 위임 코드의 `receive`가 그 안에 끝나지 않는 계정은 전환이 실패하고, 일반 실패 메시지로 보인다.
- 네트워크 수수료를 표시하지 않고, ETH 가스 부족을 미리 판정하지 않는다.
- 단일 홉 exactInput만 지원한다. 멀티홉 라우팅과 받을 금액 지정(exactOutput)은 없다.
- 달러 환산을 표시하지 않는다.
- WalletConnect와 모바일 지갑 직접 연결을 지원하지 않는다.
- 토큰 목록에 없는 토큰을 주소로 추가할 수 없다.
