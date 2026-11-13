import { PrimaryButton } from "@/components/primary-button";
import { QuoteDetails } from "@/components/quote-details";
import { FlipButton, TokenField } from "@/components/token-field";

// 스왑 카드. 서버 컴포넌트로 두고 입력부·견적 정보·주 버튼은 클라이언트 하위 컴포넌트가 맡는다.
export function SwapCard() {
  return (
    <section
      aria-labelledby="swap-card-title"
      className="flex w-full max-w-[560px] flex-col gap-6 rounded-lg border border-border bg-surface p-5 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <h1 id="swap-card-title" className="text-2xl font-semibold">
          스왑
        </h1>
        <p className="text-sm text-muted-foreground">토큰을 간편하게 교환하세요</p>
      </div>
      <div className="flex flex-col gap-1">
        <TokenField side="in" />
        <FlipButton />
        <TokenField side="out" />
      </div>
      <QuoteDetails />
      <PrimaryButton />
    </section>
  );
}
