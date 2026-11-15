import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import ReviewerAccess from "./components/ReviewerAccess";
import { ScanInputProvider } from "./scan-input";
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
  title: "网鉴 VeriPage · 网页身份核验",
  description: "核验网页「声称的身份」与「实际行为」是否一致——证据驱动、可解释、便于人工查证的 AI 安全检测台",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-paper text-ink">
        <Suspense fallback={null}><ReviewerAccess /></Suspense>
        <Suspense fallback={<main className="min-h-screen bg-paper p-8 text-sm text-ink-faint" role="status">正在载入工作台…</main>}>
          <ScanInputProvider>{children}</ScanInputProvider>
        </Suspense>
      </body>
    </html>
  );
}
