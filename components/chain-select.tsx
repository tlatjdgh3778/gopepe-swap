"use client";

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
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="min-w-40 rounded-md border border-border p-1 ring-0"
      >
        {CHAIN_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value} className="py-2 pl-2">
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
