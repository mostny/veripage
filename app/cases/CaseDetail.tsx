"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { deleteCase, getArtifact, getCase } from "@/lib/cases/repository";
import type { ArtifactRetention, StoredCase } from "@/lib/cases/types";
import { minimizeUrlForDisplay } from "@/lib/tools/url-display";
import { ReportWorkbench } from "../scan/components/ReportWorkbench";
import { ReviewPanel } from "./ReviewPanel";
import { CaseExport } from "./PackageTransfer";

type DetailState = { status: "loading" | "missing" | "error" }
  | { status: "ready"; record: StoredCase; imageUrl: string | null; retention: ArtifactRetention[] };

export function CaseDetail({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const record = await getCase(id);
        if (current !== generation.current) return;
        setDeleting(false);
        setDeleteError("");
        if (!record) { setState({ status: "missing" }); return; }
        const screenshotId = record.snapshot.evidence.find((item) => item.type === "screenshot")?.artifactId;
        let retention = record.retention;
        if (screenshotId && retention.some((item) => item.artifactId === screenshotId && item.state === "saved")) {
          let artifact;
          try { artifact = await getArtifact(id, screenshotId); } catch { /* Keep the report readable when its image cannot be read. */ }
          if (current !== generation.current) return;
          if (artifact) objectUrl = URL.createObjectURL(artifact.blob);
          else retention = retention.map((item) => item.artifactId === screenshotId ? { artifactId: screenshotId, state: "missing", reason: "本机截图已不可用，原始报告仍保留" } : item);
        }
        if (current === generation.current) setState({ status: "ready", record, imageUrl: objectUrl, retention });
      } catch {
        if (current === generation.current) {
          setState({ status: "error" });
          setDeleting(false);
          setDeleteError("");
        }
      }
    })();
    return () => { generation.current += 1; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, revision]);

  async function remove() {
    if (!window.confirm("将删除本机报告、截图和相关个人复核记录，不能撤销。确认删除？")) return;
    const current = generation.current;
    setDeleting(true);
    setDeleteError("");
    try { await deleteCase(id); if (current === generation.current) router.replace("/cases"); }
    catch { if (current === generation.current) setDeleteError("删除失败，当前报告仍可查看，请重试。"); }
    finally { if (current === generation.current) setDeleting(false); }
  }

  return (
    <main className="min-h-screen bg-paper px-3 py-5 text-ink sm:px-5 sm:py-8">
      <div className="mx-auto max-w-[1480px]">
        <header className="mb-5 rounded-2xl border border-line bg-white p-5">
          <Link href="/cases" className="rounded text-xs text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400">← 本机案例</Link>
          <div className="mt-4 flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-xs tracking-widest text-ink-soft">本机保存 · 不重新扫描</p><h1 className="mt-2 text-xl font-semibold">历史快照</h1></div>{state.status === "ready" && <button type="button" disabled={deleting} onClick={() => void remove()} className="rounded-lg border border-rose-200 px-3 py-2 text-xs text-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-200 disabled:opacity-40">{deleting ? "删除中…" : "删除本机案例"}</button>}</div>
          {state.status === "ready" && <><p className="mt-3 break-all text-sm text-ink-soft">{minimizeUrlForDisplay(state.record.snapshot.inputSummary.displayUrl)}</p><p className="mt-2 text-xs leading-6 text-ink-soft">检测时间：<time dateTime={state.record.snapshot.createdAt}>{new Date(state.record.snapshot.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>；这是当时的原始判断，不是实时安全结论。重新检测请<Link href="/" className="rounded text-blue-600 underline underline-offset-4 focus:outline-none focus:ring-2 focus:ring-blue-400">返回首页重新输入链接</Link>。</p></>}
        </header>
        {deleteError && <p role="alert" className="mb-4 rounded-xl border border-rose-200 p-4 text-sm text-rose-700">{deleteError}</p>}
        {state.status === "loading" && <p role="status" className="p-6 text-sm text-ink-soft">正在读取本机快照…</p>}
        {state.status === "missing" && <section className="rounded-xl border border-dashed border-line p-8"><h2 className="text-lg font-semibold">本机没有这份快照</h2><p className="mt-2 text-sm text-ink-soft">案例可能已删除，或来自其他浏览器/站点；这里不会向服务器查找历史。</p></section>}
        {state.status === "error" && <div role="alert" className="rounded-xl border border-amber-200 p-6 text-sm text-amber-800"><p>无法读取本机案例，请确认浏览器允许站点数据后重试。</p><button type="button" onClick={() => { setState({ status: "loading" }); setRevision((value) => value + 1); }} className="mt-4 rounded-lg border border-amber-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-200">重试读取</button></div>}
        {state.status === "ready" && <>
          <section aria-label="本机留存清单" className="mb-4 rounded-xl border border-line bg-white p-4 text-xs leading-6 text-ink-soft"><p className="font-semibold text-ink">本机留存清单</p><p>已保留 {state.retention.filter((item) => item.state === "saved").length} 项截图；原始模型判断未被更改。</p><ul>{state.retention.filter((item) => item.state !== "saved").map((item) => <li key={item.artifactId}>{item.state === "missing" ? "缺失：" : "有意省略："}{item.reason}</li>)}</ul></section>
          <ReviewPanel caseId={id} modelRisk={state.record.snapshot.originalAssessment.risk} />
          <CaseExport caseId={id} />
          <ReportWorkbench snapshot={state.record.snapshot} source={{ kind: "local", imageUrl: state.imageUrl, retention: state.retention }} />
          <p className="mt-5 break-words text-xs leading-6 text-ink-faint">model={state.record.snapshot.versions.model} · prompt={state.record.snapshot.versions.prompt} · knowledge={state.record.snapshot.versions.knowledge}。历史结果仅供辅助核验，不构成安全保证；文件内容的来源不由结构校验认证。</p>
        </>}
      </div>
    </main>
  );
}
