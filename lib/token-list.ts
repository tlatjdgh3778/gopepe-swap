import type { Address } from "viem";

import type { Token } from "@/config/tokens";

// 토큰 주소별 정수 잔액. 키는 토큰 목록의 `address` 그대로다.
// 잔액을 모르거나(미연결·복원 중) 개별 읽기가 실패한 토큰은 키가 없다.
export type TokenBalances = ReadonlyMap<Address, bigint>;

// 로캘 비교(localeCompare)를 쓰지 않고 UTF-16 코드 단위로 비교한다.
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// 대소문자를 무시한 심볼순, 심볼이 같으면 소문자로 바꾼 주소 문자열순.
function compareTokens(a: Token, b: Token): number {
  return (
    compareText(a.symbol.toLowerCase(), b.symbol.toLowerCase()) ||
    compareText(a.address.toLowerCase(), b.address.toLowerCase())
  );
}

/**
 * 모달 목록 순서를 정한다.
 * 고정 토큰(`pinnedTokens` 순서), 잔액이 0보다 큰 토큰, 나머지 토큰(잔액 0·잔액 정보 없음) 순이며,
 * 뒤의 두 그룹 안은 대소문자 무시 심볼순, 같은 심볼은 소문자 주소순이다.
 * 결과는 `tokens`의 토큰만 한 번씩 담는다. `pinnedTokens` 중 `tokens`에 없는 토큰은 넣지 않는다.
 * `balances`가 없으면 잔액 그룹 없이 고정 토큰, 나머지 토큰 순이다.
 */
export function sortTokenList(
  tokens: readonly Token[],
  pinnedTokens: readonly Token[],
  balances?: TokenBalances | null,
): Token[] {
  const pinnedOrder = new Map<string, number>(
    pinnedTokens.map((token, index) => [token.address.toLowerCase(), index]),
  );

  const pinned: Token[] = [];
  const withBalance: Token[] = [];
  const rest: Token[] = [];

  for (const token of tokens) {
    if (pinnedOrder.has(token.address.toLowerCase())) {
      pinned.push(token);
      continue;
    }
    const balance = balances?.get(token.address);
    if (balance !== undefined && balance > 0n) {
      withBalance.push(token);
    } else {
      rest.push(token);
    }
  }

  pinned.sort(
    (a, b) =>
      (pinnedOrder.get(a.address.toLowerCase()) ?? 0) -
      (pinnedOrder.get(b.address.toLowerCase()) ?? 0),
  );
  withBalance.sort(compareTokens);
  rest.sort(compareTokens);

  return [...pinned, ...withBalance, ...rest];
}

/**
 * 앞뒤 공백을 지운 검색어로 심볼과 이름에 대소문자를 무시한 부분 일치로 거른다. 주소는 검색하지 않는다.
 * 검색어가 비었거나 공백뿐이면 전체 목록을 돌려준다. 입력 순서를 유지한다.
 */
export function filterTokenList(tokens: readonly Token[], query: string): Token[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...tokens];

  return tokens.filter(
    (token) =>
      token.symbol.toLowerCase().includes(needle) || token.name.toLowerCase().includes(needle),
  );
}
