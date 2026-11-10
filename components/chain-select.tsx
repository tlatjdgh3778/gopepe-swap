"use client";

import { RemoteLogo } from "@/components/token-logo";
import { CHAIN_ICON_URLS } from "@/config/chain-icons";
import { SUPPORTED_CHAINS, type SupportedChainId, isSupportedChainId } from "@/config/chains";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSelectedChain } from "@/providers/selected-chain-provider";

// 서버 렌더링 결과에도 선택 체인 라벨이 나오도록 Select에 `items`를 준다.
const CHAIN_ITEMS = SUPPORTED_CHAINS.map((chain) => ({ value: chain.id, label: chain.name }));

// 체인 아이콘. 불러오지 못하면 체인 이름 첫 글자로 대체한다. 장식이라 접근성 이름에 섞이지 않는다.
function ChainIcon({ chainId, name }: { chainId: SupportedChainId; name: string }) {
  return <RemoteLogo src={CHAIN_ICON_URLS[chainId]} label={name} className="size-5 text-xs" />;
}

// 앱의 선택 체인만 바꾼다. 지갑에는 요청하지 않는다.
// 높이는 `className`으로 받는다(헤더가 지갑 버튼과 같은 값을 준다).
export function ChainSelect({ className }: { className?: string }) {
  const { selectedChainId, setSelectedChainId } = useSelectedChain();

  return (
    <Select<SupportedChainId>
      items={CHAIN_ITEMS}
      value={selectedChainId}
      onValueChange={(value) => {
        if (value !== null && isSupportedChainId(value)) setSelectedChainId(value);
      }}
    >
      <SelectTrigger
        data-testid="chain-select"
        data-selected-chain-id={selectedChainId}
        aria-label="체인 선택"
        className={cn(
          "min-w-0 shrink rounded-md border-border bg-surface px-2.5 font-medium sm:px-3 hover:bg-raised data-popup-open:bg-raised",
          className,
        )}
      >
        <SelectValue className="min-w-0">
          {(value: SupportedChainId | null) => {
            const item = CHAIN_ITEMS.find((candidate) => candidate.value === value);
            if (!item) return null;
            return (
              <span className="flex min-w-0 items-center gap-2">
                <ChainIcon chainId={item.value} name={item.label} />
                <span className="min-w-0 truncate">{item.label}</span>
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="min-w-40 rounded-md border border-border p-1 ring-0"
      >
        {CHAIN_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value} label={item.label} className="py-2 pl-2">
            <ChainIcon chainId={item.value} name={item.label} />
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
