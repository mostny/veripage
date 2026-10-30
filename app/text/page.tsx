"use client";

import { useState } from "react";
import Link from "next/link";
import { MAX_TEXT_LENGTH } from "../api/text/route";

// ---------------------------------------------------------------------------
// 与服务端同款的结果契约（app/api/text/route.ts）
// ---------------------------------------------------------------------------

type AigcConclusion = "likely_aigc" | "likely_human" | "undetermined";

interface AigcResult {
  isAigc: boolean;
  confidence: number;
  conclusion: AigcConclusion;
  signals: string[];
  caveats: string[];
  promptVersion: string;
  model?: string;
  repaired: boolean;
}

interface RedactionHit {
  type: string;
  label: string;
  start: number;
  end: number;
}

interface RedactionResult {
  redactedText: string;
  hits: RedactionHit[];
  counts: Record<string, number>;
  note: string;
}

interface TextAnalysisResponse {
  aigc: AigcResult;
  redaction: RedactionResult;
}

const CONCLUSION_META: Record<AigcConclusion, { label: string; cls: string }> = {
  likely_aigc: {
    label: "具有 AI 生成特征",
    cls: "border-amber-500/50 bg-amber-500/10 text-amber-200",
  },
  likely_human: {
    label: "未观察到明显 AI 生成特征",
    cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-200",
  },
  undetermined: {
    label: "无法判定",
    cls: "border-neutral-600 bg-neutral-800/60 text-neutral-300",
  },
};

function percent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export default function TextPage() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TextAnalysisResponse | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function analyze() {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError("请先粘贴或输入要检测的文本");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    setCopyState("idle");
    try {
      const res = await fetch("/api/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });
      const data = (await res.json().catch(() => null)) as (TextAnalysisResponse & { error?: string }) | null;
      if (!res.ok) {
        // 失败必须显式：包括「两次解析失败」的 502，不做任何默认判定
        throw new Error(data?.error ?? `检测请求失败（HTTP ${res.status}）`);
      }
      if (!data?.aigc || !data?.redaction) {
        throw new Error("响应缺少 aigc 或 redaction 字段，已中止展示");
      }
      setResult(data);
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : "检测请求失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  async function copyRedacted() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.redaction.redactedText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  const conclusionMeta = result ? CONCLUSION_META[result.aigc.conclusion] : null;
  const overLimit = text.length > MAX_TEXT_LENGTH;

  return (
    <main className="flex min-h-screen flex-col items-center bg-neutral-950 px-4 py-10 text-neutral-100 sm:px-6 sm:py-16">
      <div className="w-full max-w-3xl">
        <header className="mb-8 text-center">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-neutral-400">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400" aria-hidden />
            文本第二条线 · AIGC 识别 + 隐私脱敏
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            文本 <span className="text-sky-400">检测台</span>
          </h1>
          <p className="mt-3 text-balance text-sm text-neutral-400 sm:text-base">
            AIGC 判定只给特征倾向与保留意见；隐私脱敏走本地正则，确定性替换、命中可查
          </p>
          <Link href="/" className="mt-2 inline-block text-xs text-neutral-500 underline hover:text-neutral-300">
            ← 返回链接检测线
          </Link>
        </header>

        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 shadow-lg sm:p-5">
          <label htmlFor="text-input" className="mb-2 block text-sm font-medium text-neutral-300">
            待检测文本
          </label>
          <textarea
            id="text-input"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void analyze();
              }
            }}
            rows={8}
            placeholder="粘贴待检测文本（Ctrl+Enter 快捷提交）。例如含手机号、邮箱、身份证号、银行卡号的文本，可同时看到脱敏结果。"
            className="w-full resize-y rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm leading-relaxed text-neutral-100 outline-none transition focus:border-sky-500"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className={`text-xs ${overLimit ? "text-red-400" : "text-neutral-500"}`}>
              {text.length} / {MAX_TEXT_LENGTH} 字符
            </span>
            <button
              onClick={() => void analyze()}
              disabled={loading}
              aria-busy={loading}
              className="shrink-0 rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-semibold text-neutral-950 transition hover:bg-sky-400 disabled:opacity-50"
            >
              {loading ? "分析中…" : "开始分析"}
            </button>
          </div>
          {error && (
            <p id="analyze-error" role="alert" className="mt-3 rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-300">
              {error}
            </p>
          )}
        </section>

        {loading && (
          <p id="loading-indicator" className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-center text-sm text-neutral-400">
            分析中：AIGC 判定走模型，脱敏在本地进行…
          </p>
        )}

        {!loading && !result && !error && (
          <p id="empty-hint" className="mt-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-center text-sm text-neutral-500">
            粘贴文本后点击「开始分析」，AIGC 判定与隐私脱敏结果会显示在这里。
          </p>
        )}

        {result && (
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* AIGC 判定：推断级结论，必须带信号与保留意见 */}
            <section id="aigc-result" aria-label="AIGC 判定" className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 sm:p-5">
              <h2 className="mb-3 text-sm font-semibold text-neutral-300">AIGC 判定（推断级）</h2>
              <div className={`rounded-lg border p-3 ${conclusionMeta?.cls ?? ""}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-base font-semibold">{conclusionMeta?.label}</span>
                  <span className="font-mono text-sm">置信度 {percent(result.aigc.confidence)}</span>
                </div>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-neutral-500">
                AI 检测本身存在不确定性，以上为特征倾向而非事实认定；置信度低于 50% 时结论为「无法判定」。
              </p>

              <h3 className="mt-4 text-xs font-medium text-neutral-400">支持特征（signals）</h3>
              {result.aigc.signals.length > 0 ? (
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-neutral-300">
                  {result.aigc.signals.map((s, i) => (
                    <li key={i} className="break-words">
                      {s}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-neutral-500">模型未给出支持特征。</p>
              )}

              <h3 className="mt-4 text-xs font-medium text-neutral-400">保留意见（caveats）</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-neutral-300">
                {result.aigc.caveats.map((c, i) => (
                  <li key={i} className="break-words">
                    {c}
                  </li>
                ))}
              </ul>

              <p className="mt-4 text-xs text-neutral-600">
                提示词版本 {result.aigc.promptVersion} · 模型 {result.aigc.model ?? "默认（VERIPAGE_TEXT_MODEL）"}
                {result.aigc.repaired ? " · 模型输出经一次纠偏重试后解析成功" : ""}
              </p>
            </section>

            {/* 脱敏结果：观察事实级，命中可查，原值不回显 */}
            <section id="redaction-result" aria-label="脱敏结果" className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 sm:p-5">
              <h2 className="mb-3 text-sm font-semibold text-neutral-300">隐私脱敏（本地正则，观察事实级）</h2>
              {result.redaction.hits.length > 0 ? (
                <ul className="space-y-1.5">
                  {result.redaction.hits.map((h, i) => (
                    <li
                      key={i}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm"
                    >
                      <span className="text-neutral-200">{h.label}</span>
                      <span className="font-mono text-xs text-neutral-500">
                        位置 {h.start}–{h.end} · 已替换为占位符
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-lg border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-500">
                  未命中四类已知模式（身份证号 / 手机号 / 银行卡号 / 邮箱）。
                </p>
              )}
              <p className="mt-2 text-xs text-neutral-600">
                命中清单只含类型与位置区间，不回显原值；{result.redaction.note}。
              </p>

              <div className="mt-4 flex items-center justify-between gap-2">
                <h3 className="text-xs font-medium text-neutral-400">脱敏后文本</h3>
                <button
                  onClick={() => void copyRedacted()}
                  className="shrink-0 rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-sky-500 hover:text-sky-300"
                >
                  {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败，请手动选择" : "复制脱敏文本"}
                </button>
              </div>
              <pre
                id="redacted-text"
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-neutral-800 bg-neutral-950 p-3 font-mono text-xs leading-relaxed text-neutral-300"
              >
                {result.redaction.redactedText}
              </pre>
              <p className="mt-2 text-xs leading-relaxed text-neutral-600">
                说明：脱敏只发生在上面这份返回给你的文本里。本演示环境不保存任何输入，也不声称删除已发出的原始内容。
              </p>
            </section>
          </div>
        )}

        <p className="mt-6 text-center text-xs leading-relaxed text-neutral-600">
          检测结论是辅助判断，「未观察到 AI 特征」不等于保证是人类所写。
          <br />
          脱敏为正则匹配，敏感信息外发前请人工复核。
        </p>
      </div>
    </main>
  );
}
