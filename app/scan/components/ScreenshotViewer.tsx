"use client";

import type { EvidenceItem } from "@/lib/evidence/types";
import { useState } from "react";

/* eslint-disable @next/next/no-img-element -- The browser must send the task-scoped same-origin cookie directly; Next Image's server optimizer cannot authenticate this short-lived private artifact. */

export function ScreenshotViewer({
  taskId,
  evidence,
  selectedEvidenceId,
  onSelectEvidence,
}: {
  taskId: string;
  evidence: EvidenceItem[];
  selectedEvidenceId: string | null;
  onSelectEvidence: (id: string) => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const screenshot = evidence.find((item) => item.type === "screenshot");
  const artifactUrl = taskId && screenshot?.artifactId
    ? `/api/scans/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(screenshot.artifactId)}`
    : null;
  const screenshotUnavailable = artifactUrl !== null && failedSrc === artifactUrl;

  return (
    <section aria-labelledby="screenshot-title" className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/65">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">惰性静态证据</p>
          <h2 id="screenshot-title" className="mt-1 text-base font-semibold text-slate-100">取证截图</h2>
        </div>
        {screenshot && (
          <button
            type="button"
            aria-pressed={selectedEvidenceId === screenshot.id}
            onClick={() => onSelectEvidence(screenshot.id)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 ${selectedEvidenceId === screenshot.id ? "border-emerald-300/50 bg-emerald-300/10 text-emerald-100" : "border-white/10 text-slate-400 hover:text-slate-100"}`}
          >
            {selectedEvidenceId === screenshot.id ? "已定位此证据" : "定位截图证据"}
          </button>
        )}
      </div>
      {artifactUrl && screenshot && !screenshotUnavailable ? (
        <figure className={`p-3 transition sm:p-4 ${selectedEvidenceId === screenshot.id ? "ring-2 ring-inset ring-emerald-300/50" : ""}`}>
          <div className="relative overflow-auto rounded-xl border border-white/10 bg-slate-950 p-2">
            <img
              src={artifactUrl}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              alt="隔离环境采集的网页静态截图；截图内容不会在此页面执行。"
              onLoad={() => setLoadedSrc(artifactUrl)}
              onError={() => setFailedSrc(artifactUrl)}
              className="mx-auto h-auto max-h-[620px] w-full object-contain object-top"
            />
            {loadedSrc !== artifactUrl && (
              <p role="status" className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-950/70 text-sm text-slate-400">
                正在加载短期截图…
              </p>
            )}
          </div>
          <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
            <span>{screenshot.locator ?? "整页静态截图"}</span>
            <span>短期证据 · 不执行网页内容</span>
          </figcaption>
        </figure>
      ) : screenshotUnavailable ? (
        <div className="m-4 rounded-xl border border-dashed border-amber-200/20 bg-amber-200/[0.035] px-4 py-10 text-center">
          <p className="text-sm font-medium text-amber-100">临时截图已过期或暂时不可用</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">报告中的文字、结论和其他证据仍可查看。</p>
        </div>
      ) : (
        <div className="m-4 rounded-xl border border-dashed border-white/15 bg-slate-950/50 px-4 py-10 text-center">
          <span aria-hidden="true" className="mx-auto grid size-10 place-items-center rounded-full bg-white/5 text-lg text-slate-400">▧</span>
          <p className="mt-3 text-sm font-medium text-slate-300">本次没有可回看的截图</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">
            截图可能未采集成功，或当前任务没有建立短期证据会话；这不会改变其他已取得证据的可读性。
          </p>
        </div>
      )}
    </section>
  );
}
