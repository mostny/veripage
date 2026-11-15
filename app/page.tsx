"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { useScanInput } from "./scan-input";

export default function HomePage() {
  const router = useRouter();
  const { setTargetUrl } = useScanInput();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  function startScan() {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      setError("请输入要核验的链接");
      return;
    }
    try {
      const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      const parsed = new URL(candidate);
      if (!parsed.hostname.includes(".")) throw new Error("hostname");
      setTargetUrl(candidate);
      setUrl("");
      router.push("/scan");
    } catch {
      setError("链接格式无法解析，请检查后重试");
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 py-16 text-ink">
      <div className="w-full max-w-2xl">
        <header className="mb-10 text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1 text-xs text-ink-soft">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-600" aria-hidden />
            身份一致性核验 · 检测在你提交的这一刻开始
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-ink">
            网鉴 <span className="text-blue-600">VeriPage</span>
          </h1>
          <p className="mt-3 text-balance text-ink-soft">
            核验网页「声称的身份」与「实际行为」是否一致——证据驱动、可解释、便于人工查证
          </p>
        </header>

        <div className="rounded-xl border border-line bg-white p-5">
          <label htmlFor="scan-url" className="mb-2 block text-sm font-medium text-ink-soft">
            待核验链接
          </label>
          <div className="flex gap-2">
            <input
              id="scan-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && startScan()}
              placeholder="https://example.com（收到可疑短信/邮件里的链接粘进来）"
              className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2.5 font-mono text-sm text-ink outline-none transition placeholder:text-ink-faint focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
            <button
              onClick={startScan}
              className="shrink-0 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              开始核验
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

          <div className="mt-4 grid grid-cols-1 gap-2 text-xs text-ink-faint sm:grid-cols-3">
            <div className="rounded-lg border border-line bg-slate-50/70 p-2.5">
              <span className="text-ink-soft">① 不打开页面</span> —— 机器沙箱替你访问
            </div>
            <div className="rounded-lg border border-line bg-slate-50/70 p-2.5">
              <span className="text-ink-soft">② 三路取证</span> —— 域名 / 视觉 / 技术事实
            </div>
            <div className="rounded-lg border border-line bg-slate-50/70 p-2.5">
              <span className="text-ink-soft">③ 证据可查</span> —— 每条结论绑定证据
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs">
          <Link href="/cases" className="rounded text-blue-600 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">本机案例</Link>
          <span className="text-ink-faint">仅当前浏览器保存，不是云备份</span>
        </div>

        <Link
          href="/text"
          className="mt-4 block rounded-xl border border-line bg-white p-5 transition hover:border-blue-300"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink">
                文本第二条线 <span className="text-blue-600">·</span> AIGC 识别 + 隐私脱敏
              </div>
              <p className="mt-1 text-xs text-ink-faint">
                AIGC 判定带保留意见；身份证号 / 手机号 / 银行卡号 / 邮箱四类服务端正则脱敏，命中位置可查
              </p>
            </div>
            <span className="shrink-0 text-sm text-blue-600" aria-hidden>
              进入 →
            </span>
          </div>
        </Link>

        <p className="mt-6 text-center text-xs leading-relaxed text-ink-faint">
          链接会提交服务器检测，不放入应用地址栏。报告与可用截图会自动保存在当前浏览器，可在结果页清除。
          <br />
          部分临时取证产物默认 15 分钟后不可访问。请勿提交密码、登录令牌等敏感信息；「未检出风险」不等于保证安全。
        </p>
      </div>
    </main>
  );
}
