import { ChainSelect } from "@/components/chain-select";
import { WalletButton } from "@/components/wallet-button";

// 헤더 컨트롤(체인 선택, 지갑 버튼) 공통 높이. 40px(`--space-10`). 두 컨트롤 모두 border-box라 테두리 유무와 무관하다.
const HEADER_CONTROL_CLASS = "h-10";

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:h-20 sm:px-6">
        <span className="shrink-0 text-lg font-bold tracking-tight sm:text-xl">
          GOPEPE<span className="font-normal max-sm:sr-only"> Swap</span>
        </span>
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <ChainSelect className={HEADER_CONTROL_CLASS} />
          <WalletButton className={HEADER_CONTROL_CLASS} />
        </div>
      </div>
    </header>
  );
}
