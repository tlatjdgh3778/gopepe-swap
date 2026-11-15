"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useId } from "react";

import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SLIPPAGE_PRESETS_BPS, formatSlippageBps, isSlippageBps } from "@/lib/slippage";
import { useSlippage } from "@/providers/slippage-provider";

// 스왑 카드 헤더의 슬리피지 설정 버튼과 팝오버. 견적·지갑 상태와 관계없이 항상 렌더링한다.
// 열림·닫힘, Esc·바깥 클릭 닫힘, 닫힌 뒤 포커스 복귀는 Base UI Popover 기본값(`modal` false, `finalFocus` 기본)에 맡긴다.
export function SlippageSettings() {
  const { slippageBps, setSlippageBps } = useSlippage();
  const titleId = useId();

  return (
    <Popover>
      <PopoverTrigger
        data-testid="slippage-button"
        aria-label="슬리피지 설정"
        className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-raised text-text transition-colors outline-none hover:bg-border focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <SlidersHorizontalIcon aria-hidden className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        data-testid="slippage-popover"
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-66 gap-3 rounded-md border border-border bg-raised p-4 shadow-lg ring-0"
      >
        <div className="flex items-center justify-between gap-2">
          <PopoverTitle id={titleId} className="text-sm font-semibold">
            슬리피지 허용치
          </PopoverTitle>
          <PopoverClose className="-mr-1 flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:bg-border hover:text-text focus-visible:ring-3 focus-visible:ring-ring/50">
            <XIcon aria-hidden className="size-4" />
            <span className="sr-only">닫기</span>
          </PopoverClose>
        </div>
        <RadioGroup
          aria-labelledby={titleId}
          value={slippageBps}
          onValueChange={(value: unknown) => {
            if (isSlippageBps(value)) setSlippageBps(value);
          }}
          className="grid grid-cols-3 gap-2"
        >
          {SLIPPAGE_PRESETS_BPS.map((bps) => (
            <Radio.Root
              key={bps}
              value={bps}
              data-testid="slippage-option"
              data-slippage-bps={bps}
              className="flex h-9 cursor-pointer items-center justify-center rounded-sm border border-border bg-field text-sm font-medium text-text transition-colors outline-none hover:border-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:border-primary data-checked:hover:border-primary"
            >
              {formatSlippageBps(bps)}
            </Radio.Root>
          ))}
        </RadioGroup>
        <p className="text-xs text-muted-foreground">최소 수령량에 바로 반영</p>
      </PopoverContent>
    </Popover>
  );
}
