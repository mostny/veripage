"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { CaseSnapshot, CoverageEntry } from "@/lib/evidence/types";

// ---------------------------------------------------------------------------
// SSE 客户端（与服务端同款纪律：跨网络块缓冲，半行留待下一块）
// ---------------------------------------------------------------------------

interface StepEvent {
  type: "step";
  step: string;
  state: "completed" | "partial" | "skipped" | "failed";
  detail?: string;
  reason?: string;
}
type ScanEvent = StepEvent | { type: "started"; taskId: string } | { type: "report"; snapshot: CaseSnapshot };

async function* readScanStream(url: string): AsyncGenerator<ScanEvent> {
  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`检测请求失败（HTTP ${res.status}）${text.slice(0, 120)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔；最后一个可能是半截，留在缓冲区
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          yield JSON.parse(line.slice(6)) as ScanEvent;
        } catch {
          // 忽略无法解析的帧
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 展示配置
// ---------------------------------------------------------------------------

const STEP_LABELS: Array<{ key: string; label: string }> = [
  { key: "s0-guard", label: "S0 访问边界（SSRF 防护）" },
  { key: "gate1-static", label: "闸门① 链接静态分析" },
  { key: "gate2-fetch", label: "闸门② 沙箱代访取证" },
  { key: "gate3-vision", label: "闸门③ 视觉核验" },
  { key: "gate3-analyzer", label: "闸门③ 身份一致性分析" },
  { key: "validate", label: "快照校验" },
];

type UiState = "pending" | "running" | "completed" | "partial" | "skipped" | "failed";

const STATE_ICON: Record<UiState, string> = {
  pending: "○",
  running: "◐",
  completed: "●",
  partial: "◑",
  skipped: "◌",
  failed: "✕",
};
const STATE_COLOR: Record<UiState, string> = {
  pending: "text-neutral-600 border-neutral-800",
  running: "text-sky-400 border-sky-500/40",
  completed: "text-emerald-400 border-emerald-500/40",
  partial: "text-amber-400 border-amber-500/40",
  skipped: "text-neutral-400 border-neutral-700",
  failed: "text-red-400 border-red-500/40",
};

const RISK_META: Record<string, { label: string; cls: string }> = {
  high: { label: "高风险", cls: "border-red-500/50 bg-red-500/10 text-red-300" },
  suspicious: { label: "可疑", cls: "border-amber-500/50 bg-amber-500/10 text-amber-300" },
  no_significant_risk: { label: "暂未发现显著风险", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" },
  unknown: { label: "无法判断", cls: "border-neutral-600 bg-neutral-800/60 text-neutral-300" },
};

const KIND_META: Record<string, { label: string; cls: string }> = {
  observed_fact: { label: "观察事实", cls: "bg-sky-500/15 text-sky-300" },
  inference: { label: "风险推断", cls: "bg-amber-500/15 text-amber-300" },
  reference: { label: "引用资料", cls: "bg-violet-500/15 text-violet-300" },
};

const SUFF_LABEL: Record<string, string> = {
  sufficient: "充分",
  partial: "部分充分",
  insufficient: "不足",
};
const COV_LABEL: Record<CoverageEntry["state"], string> = {
  completed: "完成",
  partial: "部分完成",
  skipped: "跳过",
  failed: "失败",
};

// ---------------------------------------------------------------------------
// 检测过程页主体
// ---------------------------------------------------------------------------

function ScanClient() {
  const params = useSearchParams();
  const targetUrl = params.get("url") ?? "";

  const [steps, setSteps] = useState<Record<string, { state: UiState; detail?: string; reason?: string }>>({});
  const [snapshot, setSnapshot] = useState<CaseSnapshot | null>(null);
  const [fatal, setFatal] = useState("");
  const started = useRef(false);

  const run = useCallback(async (url: string) => {
    setSteps({});
    setSnapshot(null);
    setFatal("");
    try {
      for await (const ev of readScanStream(url)) {
        if (ev.type === "step") {
          setSteps((prev) => {
            const next = { ...prev };
            // 前一个 running 收尾：本事件之前的 running 步骤视为已结束（保持最后已知状态）
            for (const k of Object.keys(next)) {
              if (next[k].state === "running") next[k] = { ...next[k], state: "pending" };
            }
            next[ev.step] = { state: ev.state, detail: ev.detail, reason: ev.reason };
            return next;
          });
        } else if (ev.type === "report") {
          setSnapshot(ev.snapshot);
        }
      }
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!targetUrl || started.current) return;
    started.current = true;
    void run(targetUrl);
  }, [targetUrl, run]);

  // 推导每个固定步骤的展示状态：收到事件用事件状态；否则第一个未完成步骤=running
  const uiStates: Record<string, UiState> = {};
  let runningAssigned = false;
  for (const { key } of STEP_LABELS) {
    const got = steps[key];
    if (got) {
      uiStates[key] = got.state;
    } else if (!runningAssigned && !snapshot && !fatal) {
      uiStates[key] = "running";
      runningAssigned = true;
    } else {
      uiStates[key] = "pending";
    }
  }

  const assessment = snapshot?.originalAssessment;
  const riskMeta = assessment ? RISK_META[assessment.risk] : undefined;

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link href="/" className="text-sm text-neutral-500 transition hover:text-neutral-300">
              ← 网鉴 VeriPage
            </Link>
            <h1 className="mt-1 truncate font-mono text-sm text-neutral-300 sm:text-base" title={targetUrl}>
              {targetUrl || "（缺少 url 参数）"}
            </h1>
          </div>
          <button
            onClick={() => targetUrl && run(targetUrl)}
            disabled={!targetUrl}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-neutral-500 disabled:opacity-40"
          >
            重新检测
          </button>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
          {/* 左：步骤时间线 */}
          <section aria-label="检测步骤" className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">检测步骤</h2>
            <ol className="space-y-1">
              {STEP_LABELS.map(({ key, label }) => {
                const ui = uiStates[key];
                const info = steps[key];
                return (
                  <li key={key} className={`rounded-lg border px-3 py-2 ${STATE_COLOR[ui]}`}>
                    <div className="flex items-center gap-2 text-sm">
                      <span className={ui === "running" ? "animate-pulse" : ""}>{STATE_ICON[ui]}</span>
                      <span className="text-neutral-200">{label}</span>
                    </div>
                    {(info?.detail || info?.reason) && (
                      <p className="mt-1 pl-6 text-xs leading-relaxed text-neutral-500">
                        {info.reason ? `原因：${info.reason}` : info.detail}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>

          {/* 右：报告 / 状态 */}
          <section aria-label="检测报告">
            {fatal && (
              <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-4 text-sm text-red-300">
                {fatal}
                <p className="mt-2 text-xs text-red-400/70">可点击「重新检测」重试；若持续失败请检查服务端日志。</p>
              </div>
            )}

            {!snapshot && !fatal && (
              <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-8 text-center text-sm text-neutral-500">
                <span className="mb-2 inline-block animate-pulse text-2xl">◐</span>
                <p>正在核验……机器沙箱正在替你访问页面并采集证据（通常 15~40 秒）</p>
              </div>
            )}

            {snapshot && assessment && riskMeta && (
              <div className="space-y-5">
                {/* 三维报告之：风险判断 + 证据充分程度 */}
                <div className={`rounded-xl border p-5 ${riskMeta.cls}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-2xl font-bold">{riskMeta.label}</span>
                    <span className="text-xs opacity-70">
                      证据充分程度：{SUFF_LABEL[assessment.evidenceSufficiency] ?? assessment.evidenceSufficiency}
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-neutral-200">{assessment.summary}</p>
                </div>

                {/* 处置建议 */}
                <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-neutral-500">处置建议</h3>
                  <p className="text-sm text-neutral-200">{assessment.recommendedAction}</p>
                  {assessment.gaps.length > 0 && (
                    <p className="mt-2 text-xs text-neutral-500">证据缺口：{assessment.gaps.join("；")}</p>
                  )}
                </div>

                {/* findings */}
                <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    结论与依据（{assessment.findings.length} 条）
                  </h3>
                  {assessment.findings.length === 0 && (
                    <p className="text-sm text-neutral-500">无（兜底结论或无显著发现）</p>
                  )}
                  <ul className="space-y-3">
                    {assessment.findings.map((f) => {
                      const kind = KIND_META[f.kind] ?? KIND_META.inference;
                      return (
                        <li key={f.id} className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${kind.cls}`}>{kind.label}</span>
                            <span className="font-mono text-[11px] text-neutral-600">{f.id}</span>
                          </div>
                          <p className="text-sm leading-relaxed text-neutral-200">{f.statement}</p>
                          {f.evidenceIds.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {f.evidenceIds.map((id) => (
                                <span key={id} className="rounded border border-neutral-700 px-1.5 py-0.5 font-mono text-[10px] text-neutral-400">
                                  {id}
                                </span>
                              ))}
                            </div>
                          )}
                          {f.alternativeExplanations.length > 0 && (
                            <p className="mt-2 text-xs text-neutral-500">
                              替代解释：{f.alternativeExplanations.join("；")}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* unknowns */}
                {assessment.unknowns.length > 0 && (
                  <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">未知事项（不硬猜）</h3>
                    <ul className="list-inside list-disc space-y-1 text-sm text-neutral-300">
                      {assessment.unknowns.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* coverage + evidence 折叠 */}
                <details className="rounded-xl border border-neutral-800 bg-neutral-900 p-4">
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    技术细节：检测覆盖与证据清单（{snapshot.evidence.length} 项）
                  </summary>
                  <table className="mt-3 w-full text-left text-xs">
                    <thead className="text-neutral-500">
                      <tr>
                        <th className="pb-1 pr-3">步骤</th>
                        <th className="pb-1 pr-3">状态</th>
                        <th className="pb-1">原因</th>
                      </tr>
                    </thead>
                    <tbody className="text-neutral-300">
                      {snapshot.coverage.map((c, i) => (
                        <tr key={i} className="border-t border-neutral-800/60">
                          <td className="py-1 pr-3 font-mono">{c.step}</td>
                          <td className="py-1 pr-3">{COV_LABEL[c.state]}</td>
                          <td className="py-1 text-neutral-500">{c.reason ?? "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ul className="mt-4 space-y-2">
                    {snapshot.evidence.map((e) => (
                      <li key={e.id} className="rounded border border-neutral-800 bg-neutral-950/60 p-2 text-xs">
                        <span className="font-mono text-neutral-400">{e.id}</span>
                        <span className="ml-2 text-neutral-600">{e.type}</span>
                        <p className="mt-1 line-clamp-2 text-neutral-500">{e.excerpt ?? e.locator ?? ""}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-[11px] text-neutral-600">
                    版本：model={snapshot.versions.model} · prompt={snapshot.versions.prompt} · policy={snapshot.versions.policy}
                  </p>
                </details>

                <p className="text-center text-[11px] text-neutral-600">
                  结论由 AI 基于证据生成，是辅助判断；「未检出风险」不等于保证安全。
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

export default function ScanPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-sm text-neutral-500">
          正在载入检测页……
        </main>
      }
    >
      <ScanClient />
    </Suspense>
  );
}
