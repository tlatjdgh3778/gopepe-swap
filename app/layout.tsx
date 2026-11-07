import type { Metadata } from "next";

import { Geist, Geist_Mono } from "next/font/google";
import { cookies, headers } from "next/headers";

import { getWagmiInitialState } from "@/config/wagmi";
import { SELECTED_CHAIN_COOKIE, parseSelectedChainId } from "@/lib/selected-chain";
import { AppProviders } from "@/providers/app-providers";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GOPEPE Swap",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const initialChainId = parseSelectedChainId(cookieStore.get(SELECTED_CHAIN_COOKIE)?.value);
  const initialState = getWagmiInitialState((await headers()).get("cookie"));

  return (
    <html lang="ko" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <AppProviders initialChainId={initialChainId} initialState={initialState}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
