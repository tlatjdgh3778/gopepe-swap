import { ConnectModalProvider } from "@/components/connect-modal";
import { SiteHeader } from "@/components/site-header";
import { SwapCard } from "@/components/swap-card";

export default function Home() {
  return (
    <ConnectModalProvider>
      <SiteHeader />
      <main className="flex flex-1 items-start justify-center px-4 py-8 sm:px-6 sm:py-12">
        <SwapCard />
      </main>
    </ConnectModalProvider>
  );
}
