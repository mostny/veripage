"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { deleteCase, readCaseLibrary } from "@/lib/cases/repository";
import type { StoredCase } from "@/lib/cases/types";
import type { ReviewEvent, RiskLevel } from "@/lib/evidence/types";
import { latestResolution, REVIEW_STATUS_LABELS, reviewStatus } from "@/lib/cases/review";
import { minimizeUrlForDisplay } from "@/lib/tools/url-display";
import { RISK_META } from "../scan/components/ReportSummary";
import { CaseImport } from "./PackageTransfer";

type LibraryState = { status: "loading" | "error" } | { status: "ready"; records: StoredCase[]; events: ReviewEvent[] };

export default function CasesPage() {
  const [state, setState] = useState<LibraryState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState<RiskLevel | "all">("all");
  const [view, setView] = useState<"all" | "pending" | "history">("all");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    void readCaseLibrary().then(({ records, events }) => {
      if (current !== generation.current) return;
      setState({ status: "ready", records, events });
      setDeleting(null);
      setDeleteError("");
    }).catch(() => { if (current === generation.current) setState({ status: "error" }); });
    return () => { generation.current += 1; };
  }, [revision]);

  function refresh() {
    setState({ status: "loading" });
    setRevision((value) => value + 1);
  }

  async function remove(id: string) {
    if (!window.confirm("将删除本机报告、截图和相关个人复核记录，不能撤销。确认删除？")) return;
    const current = generation.current;
    setDeleting(id);
    setDeleteError("");
    try {
      await deleteCase(id);
      if (current === generation.current) setState((previous) => previous.status === "ready"
        ? { status: "ready", records: previous.records.filter((record) => record.id !== id), events: previous.events.filter((event) => event.caseId !== id) } : previous);
    } catch {
      if (current === generation.current) setDeleteError("删除失败，本机副本可能仍在，请重试。");
    } finally { if (current === generation.current) setDeleting(null); }
  }

  const query = search.trim().toLowerCase();
  const reviewsByCase = new Map<string, ReviewEvent[]>();
  if (state.status === "ready") for (const event of state.events) {
    const events = reviewsByCase.get(event.caseId);
    if (events) events.push(event); else reviewsByCase.set(event.caseId, [event]);
  }
  const records = state.status === "ready" ? state.records.filter((record) => {
    const events = reviewsByCase.get(record.id) ?? [];
    return (view === "all" || (view === "pending" ? reviewStatus(events) === "pending" : latestResolution(events) !== undefined)) &&
      (risk === "all" || record.snapshot.originalAssessment.risk === risk) &&
      `${record.snapshot.inputSummary.displayUrl} ${record.snapshot.inputSummary.registrableDomain} ${record.snapshot.originalAssessment.summary}`.toLowerCase().includes(query);
  }) : [];

  return (
    <main className="min-h-screen bg-paper px-3 py-6 text-ink sm:px-6 sm:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 rounded-2xl border border-line bg-white p-5 sm:p-7">
          <Link href="/" className="rounded text-xs text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">← 网鉴 VeriPage</Link>
          <p className="mt-5 text-xs tracking-widest text-ink-soft">仅当前浏览器 · 不上传历史记录</p>
          <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">本机案例</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ink-soft">回看原始判断和已保留的证据。历史快照不是实时安全结论；清理站点数据可能丢失记录。</p>
        </header>

        <CaseImport onImported={refresh} />
        <nav aria-label="复核视图" className="mb-4 flex flex-wrap gap-2">
          {([['all', '全部案例'], ['pending', '待复核'], ['history', '更正记录']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={`rounded-lg border px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 ${view === value ? "border-blue-300 bg-blue-50 text-blue-700" : "border-line text-ink-soft"}`}>{label}</button>)}
        </nav>
        {view === "history" && <p className="mb-4 text-xs leading-6 text-ink-soft">包含已完成更正或维持原判的案例；再次标记待复核不会删除以前的个人意见。</p>}
        <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-white p-4">
          <label className="min-w-0 flex-1 basis-full text-xs text-ink-soft sm:basis-60" htmlFor="case-search">搜索本机案例
            <input id="case-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="域名、链接或结论关键词" className="mt-2 w-full min-w-0 rounded-lg border border-line bg-slate-50 px-3 py-2.5 text-sm text-ink focus:border-blue-400 focus:outline-none" />
          </label>
          <label className="text-xs text-ink-soft" htmlFor="case-risk">模型原判
            <select id="case-risk" value={risk} onChange={(event) => setRisk(event.target.value as RiskLevel | "all")} className="mt-2 block max-w-full rounded-lg border border-line bg-slate-50 px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-400">
              <option value="all">全部风险判断</option>
              {Object.entries(RISK_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
            </select>
          </label>
          <button type="button" onClick={refresh} disabled={state.status === "loading" || deleting !== null} className="rounded-lg border border-line px-3 py-2.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-40">刷新列表</button>
        </div>

        {deleteError && <p role="alert" className="mb-4 rounded-xl border border-rose-200 p-4 text-sm text-rose-700">{deleteError}</p>}
        {state.status === "loading" && <p role="status" className="p-8 text-sm text-ink-soft">正在读取本机案例…</p>}
        {state.status === "error" && <div role="alert" className="rounded-xl border border-amber-200 p-6 text-sm text-amber-800"><p>无法读取本机存储，请确认浏览器允许站点数据后重试。</p><button type="button" onClick={refresh} className="mt-4 rounded-lg border border-amber-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-200">重试读取</button></div>}
        {state.status === "ready" && state.records.length === 0 && <section className="rounded-2xl border border-dashed border-line p-10 text-center"><h2 className="text-lg font-semibold">本机还没有案例</h2><p className="mt-2 text-sm text-ink-soft">完成核验并保存到本机后，会在这里列出。</p><Link href="/" className="mt-5 inline-block rounded-lg border border-blue-200 px-4 py-2 text-sm text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400">开始核验</Link></section>}
        {state.status === "ready" && state.records.length > 0 && <>
          <p aria-live="polite" className="mb-3 text-xs text-ink-soft">{records.length} 条匹配 / {state.records.length} 条本机案例 · 按检测时间倒序</p>
          {records.length === 0 && <p className="rounded-xl border border-line p-8 text-sm text-ink-soft">没有匹配案例，可调整搜索、风险或复核视图。</p>}
          <ul className="space-y-3">{records.map((record) => {
            const snapshot = record.snapshot;
            const meta = RISK_META[snapshot.originalAssessment.risk];
            const missing = record.retention.filter((item) => item.state === "missing").length;
            const omitted = record.retention.filter((item) => item.state === "omitted").length;
            const events = reviewsByCase.get(record.id) ?? [];
            const review = reviewStatus(events);
            const resolved = latestResolution(events);
            return <li key={record.id} className="rounded-2xl border border-line bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1"><p className="break-all text-xs text-ink-soft">{snapshot.inputSummary.registrableDomain}</p><h2 className="mt-1 break-all text-sm font-semibold"><Link href={`/cases/${encodeURIComponent(record.id)}`} className="rounded text-ink underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-400">{minimizeUrlForDisplay(snapshot.inputSummary.displayUrl)}</Link></h2></div>
                <span className={`rounded-full border px-3 py-1 text-xs ${meta.tone}`}>模型原判：{meta.label}</span>
              </div>
              <p className="mt-3 line-clamp-3 text-sm leading-6 text-ink-soft">{snapshot.originalAssessment.summary}</p>
              <p className="mt-2 text-xs leading-6 text-blue-700">个人复核：{REVIEW_STATUS_LABELS[review]}{resolved ? ` · 最近完成：${resolved.action === "correct_assessment" ? `我的判断为${RISK_META[resolved.humanRisk].label}` : "维持模型原判"}` : ""}</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-ink-soft"><div className="flex flex-wrap gap-x-4 gap-y-2"><time dateTime={snapshot.createdAt}>检测时间：{new Date(snapshot.createdAt).toLocaleString("zh-CN", { hour12: false })}</time><span>{missing ? `${missing} 项证据缺失` : "本机保存完成"}{omitted ? ` · ${omitted} 项有意省略` : ""}</span></div><button type="button" disabled={deleting !== null} onClick={() => void remove(record.id)} aria-label={`删除案例 ${snapshot.inputSummary.registrableDomain}`} className="rounded border border-line px-3 py-1.5 text-ink-soft hover:text-rose-700 focus:outline-none focus:ring-2 focus:ring-rose-200 disabled:opacity-40">{deleting === record.id ? "删除中…" : "删除"}</button></div>
            </li>;
          })}</ul>
        </>}
      </div>
    </main>
  );
}
