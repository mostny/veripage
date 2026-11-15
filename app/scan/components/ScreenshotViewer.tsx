"use client";

import type { EvidenceItem } from "@/lib/evidence/types";
import { useEffect, useId, useRef, useState } from "react";

/* eslint-disable @next/next/no-img-element -- Private task URLs need browser cookies, and local Blob URLs cannot use the server image optimizer. */

export function ScreenshotViewer({
  mode,
  imageUrl,
  evidence,
  selectedEvidenceId,
  onSelectEvidence,
}: {
  mode: "temporary" | "local";
  imageUrl: string | null;
  evidence: EvidenceItem[];
  selectedEvidenceId: string | null;
  onSelectEvidence: (id: string) => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [zoomSource, setZoomSource] = useState<string | null>(null);
  const [zoomState, setZoomState] = useState<"loading" | "ready" | "error">("loading");
  const [naturalSize, setNaturalSize] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const dialogTitle = useId();
  const screenshot = evidence.find((item) => item.type === "screenshot");
  const artifactUrl = imageUrl;
  const screenshotUnavailable = artifactUrl !== null && failedSrc === artifactUrl;
  const expandedSource = zoomSource === artifactUrl ? zoomSource : null;

  useEffect(() => {
    const current = dialog.current;
    return () => { current?.close(); };
  }, [artifactUrl]);

  return (
    <section aria-labelledby="screenshot-title" className="overflow-hidden rounded-2xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-soft">惰性静态证据</p>
          <h2 id="screenshot-title" className="mt-1 text-base font-semibold text-ink">取证截图</h2>
        </div>
        <div className="flex flex-wrap gap-2">
        {artifactUrl && screenshot && (
          <button
            type="button"
            disabled={loadedSrc !== artifactUrl || screenshotUnavailable}
            onClick={() => {
              setZoomSource(artifactUrl);
              setZoomState("loading");
              setNaturalSize(false);
              dialog.current?.showModal();
            }}
            className="min-h-10 rounded-lg border border-blue-200 px-3 py-1.5 text-xs text-blue-700 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
          >放大查看截图</button>
        )}
        {screenshot && (
          <button
            type="button"
            aria-pressed={selectedEvidenceId === screenshot.id}
            onClick={() => onSelectEvidence(screenshot.id)}
            className={`rounded-lg border px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${selectedEvidenceId === screenshot.id ? "border-blue-400 bg-blue-50 text-blue-700" : "border-line text-ink-soft hover:text-ink"}`}
          >
            {selectedEvidenceId === screenshot.id ? "已定位此证据" : "定位截图证据"}
          </button>
        )}
        </div>
      </div>
      {artifactUrl && screenshot && !screenshotUnavailable ? (
        <figure className={`p-3 transition sm:p-4 ${selectedEvidenceId === screenshot.id ? "ring-2 ring-inset ring-blue-400" : ""}`}>
          <div className="relative overflow-auto rounded-xl border border-line bg-slate-50 p-2">
            <img
              src={artifactUrl}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              alt={`${mode === "local" ? "本机保存" : "隔离环境采集"}的网页静态截图；截图内容不会在此页面执行。`}
              onLoad={() => setLoadedSrc(artifactUrl)}
              onError={() => setFailedSrc(artifactUrl)}
              className="mx-auto h-auto max-h-[620px] w-full object-contain object-top"
            />
            {loadedSrc !== artifactUrl && (
              <p role="status" className="pointer-events-none absolute inset-0 grid place-items-center bg-white/80 text-sm text-ink-soft">
                {mode === "local" ? "正在加载本机截图…" : "正在加载短期截图…"}
              </p>
            )}
          </div>
          <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-ink-faint">
            <span>{screenshot.locator ?? "整页静态截图"}</span>
            <span>{mode === "local" ? "本机副本" : "短期证据"} · 不执行网页内容</span>
          </figcaption>
        </figure>
      ) : screenshotUnavailable ? (
        <div className="m-4 rounded-xl border border-dashed border-amber-200 bg-amber-50 px-4 py-10 text-center">
          <p className="text-sm font-medium text-amber-800">{mode === "local" ? "本机截图无法读取" : "临时截图已过期或暂时不可用"}</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-faint">报告中的文字、结论和其他证据仍可查看。</p>
        </div>
      ) : (
        <div className="m-4 rounded-xl border border-dashed border-line bg-white px-4 py-10 text-center">
          <span aria-hidden="true" className="mx-auto grid size-10 place-items-center rounded-full bg-slate-50 text-lg text-ink-soft">▧</span>
          <p className="mt-3 text-sm font-medium text-ink-soft">{mode === "local" ? "本机未保留可回看的截图" : "本次没有可回看的截图"}</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-faint">
            {mode === "local" ? "缺失或有意省略的内容见本机留存清单；不会自动访问原站或临时端点。" : "截图可能未采集成功，或当前任务没有建立短期证据会话；这不会改变其他已取得证据的可读性。"}
          </p>
        </div>
      )}
      <dialog
        ref={dialog}
        aria-labelledby={dialogTitle}
        onClose={() => setZoomSource(null)}
        onKeyDown={(event) => {
          if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
          if (!event.shiftKey && event.target === scrollArea.current) {
            event.preventDefault();
            closeButton.current?.focus();
          } else if (event.shiftKey && event.target === closeButton.current) {
            event.preventDefault();
            scrollArea.current?.focus();
          }
        }}
        className="m-auto h-[92dvh] max-h-[92dvh] w-[calc(100%_-_1.5rem)] max-w-6xl overflow-hidden rounded-2xl border border-line bg-paper p-0 text-ink shadow-2xl backdrop:bg-slate-900/50 open:flex open:flex-col"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <p className="text-xs leading-6 text-blue-600">{mode === "local" ? "本机副本" : "短期证据"} · 静态 PNG</p>
            <h2 id={dialogTitle} className="text-base font-semibold">放大查看截图</h2>
          </div>
          <button ref={closeButton} type="button" onClick={() => dialog.current?.close()} className="min-h-11 shrink-0 rounded-lg border border-line px-3 text-sm text-ink hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">关闭截图</button>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-3 text-xs sm:px-5">
          <button type="button" disabled={zoomState !== "ready"} onClick={() => setNaturalSize((value) => !value)} className="min-h-11 rounded-lg border border-blue-200 px-3 text-blue-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40">{naturalSize ? "适应窗口" : "原始尺寸"}</button>
          <p className="leading-6 text-ink-soft">{naturalSize ? "按原始尺寸显示，可滚动查看细节。" : "当前适应窗口；切换原始尺寸查看细节。"}</p>
        </div>
        <div ref={scrollArea} role="region" aria-label="放大截图滚动区域" tabIndex={0} className="relative min-h-0 flex-1 overflow-auto border-y border-line bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400">
          {expandedSource && zoomState !== "error" && <img
            src={expandedSource}
            decoding="async"
            referrerPolicy="no-referrer"
            alt="放大后的静态网页截图；不执行网页内容。"
            onLoad={() => setZoomState("ready")}
            onError={() => setZoomState("error")}
            className={naturalSize ? "mx-auto block h-auto w-auto max-w-none" : "block h-full w-full object-contain"}
          />}
          {expandedSource && zoomState === "loading" && <p role="status" className="absolute inset-0 grid place-items-center bg-white/80 p-6 text-sm text-ink-soft">正在加载放大截图…</p>}
          {expandedSource && zoomState === "error" && <div role="alert" className="grid h-full place-content-center gap-2 p-6 text-center"><p className="text-sm text-amber-800">放大截图暂时无法读取</p><p className="max-w-md text-xs leading-6 text-ink-soft">{mode === "local" ? "本机图像暂不可用。" : "短期证据端点可能已过期或暂不可用。"}关闭后仍可查看报告及已加载的缩略图。</p></div>}
        </div>
        <p className="shrink-0 px-4 py-3 text-xs leading-6 text-ink-soft sm:px-5">只展示采集时的图像，不会打开或执行目标网页。按 Esc 或“关闭截图”返回。</p>
      </dialog>
    </section>
  );
}
