"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReviewEvent, RiskLevel } from "@/lib/evidence/types";
import { appendReviewEvent, listReviewEvents } from "@/lib/cases/repository";
import { latestResolution, MAX_REVIEW_REASON_LENGTH, REVIEW_ACTION_LABELS, REVIEW_STATUS_LABELS, ReviewConflictError, reviewStatus } from "@/lib/cases/review";
import { RISK_META } from "../scan/components/ReportSummary";

type ReviewState = { status: "loading" | "error" } | { status: "ready"; events: ReviewEvent[] };

export function ReviewPanel({ caseId, modelRisk }: { caseId: string; modelRisk: RiskLevel }) {
  const [state, setState] = useState<ReviewState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [reason, setReason] = useState("");
  const [humanRisk, setHumanRisk] = useState<RiskLevel | "">("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const submitting = useRef(false);
  const generation = useRef(0);
  const inputId = useId();
  const reasonId = `review-reason-${inputId}`;
  const riskId = `review-risk-${inputId}`;

  useEffect(() => {
    const current = ++generation.current;
    void listReviewEvents(caseId).then((events) => {
      if (current !== generation.current) return;
      setState({ status: "ready", events });
      submitting.current = false;
      setBusy(false);
    }).catch(() => {
      if (current === generation.current) { setState({ status: "error" }); submitting.current = false; setBusy(false); }
    });
    return () => { generation.current += 1; };
  }, [caseId, revision]);

  function refresh() {
    setState({ status: "loading" });
    setRevision((value) => value + 1);
  }

  async function submit(action: ReviewEvent["action"], events: ReviewEvent[]) {
    if (submitting.current) return;
    if (!reason.trim()) { setFormError("请先填写复核理由。"); return; }
    const base = { id: crypto.randomUUID(), caseId, createdAt: new Date().toISOString(), reason: reason.trim(), actor: "local_user" as const };
    let event: ReviewEvent;
    if (action === "correct_assessment") {
      if (!humanRisk) { setFormError("请选择我的风险判断。"); return; }
      event = { ...base, action, humanRisk };
    } else event = { ...base, action };
    const current = generation.current;
    submitting.current = true;
    setBusy(true);
    setFormError("");
    try {
      const updated = await appendReviewEvent(event, events.at(-1)?.id ?? null);
      if (current === generation.current) { setState({ status: "ready", events: updated }); setReason(""); setHumanRisk(""); }
    } catch (error) {
      if (current === generation.current) {
        setFormError(error instanceof Error ? error.message : "复核记录未保存，请重试。");
        if (error instanceof ReviewConflictError) refresh();
      }
    } finally {
      if (current === generation.current) { submitting.current = false; setBusy(false); }
    }
  }

  const status = state.status === "ready" ? reviewStatus(state.events) : null;
  const resolved = state.status === "ready" ? latestResolution(state.events) : undefined;

  return (
    <section aria-label="个人复核" className="mb-4 rounded-2xl border border-blue-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold text-ink">个人复核</h2>{status && <p aria-live="polite" className="rounded-full border border-line px-3 py-1 text-xs text-blue-700">{REVIEW_STATUS_LABELS[status]}</p>}</div>
      <p className="mt-2 text-xs leading-6 text-ink-soft">模型原判：{RISK_META[modelRisk].label}，始终保留。这里仅记录本机使用者意见，不代表平台认定，不自动进入知识库或原始评测。</p>
      {resolved && <p className="mt-2 text-sm text-ink">最近已完成复核：{resolved.action === "correct_assessment" ? `我的判断为${RISK_META[resolved.humanRisk].label}` : "维持模型原判"}。</p>}
      {formError && <p role="alert" className="mt-3 text-sm text-amber-800">{formError}</p>}
      {state.status === "loading" && <p role="status" className="mt-3 text-xs text-ink-soft">正在读取个人复核记录…</p>}
      {state.status === "error" && <div role="alert" className="mt-3 text-sm text-amber-800"><p>无法读取个人复核记录，原始报告仍可查看。</p><button type="button" onClick={refresh} className="mt-2 rounded border border-amber-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-200">重试读取复核记录</button></div>}
      {state.status === "ready" && <details open={status === "pending"} className="mt-3">
        <summary className="cursor-pointer rounded py-2 text-sm text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-400">填写复核意见和记录</summary>
        <div className="mt-3 grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="min-w-0">
            <label htmlFor={reasonId} className="text-xs text-ink-soft">理由（必填，最多 {MAX_REVIEW_REASON_LENGTH} 字符）</label>
            <textarea id={reasonId} value={reason} maxLength={MAX_REVIEW_REASON_LENGTH} disabled={busy} onChange={(event) => setReason(event.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-line bg-slate-50 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50" />
            {status === "pending" && <label className="mt-3 block text-xs text-ink-soft" htmlFor={riskId}>我的判断（保存更正时必选）<select id={riskId} value={humanRisk} disabled={busy} onChange={(event) => setHumanRisk(event.target.value as RiskLevel | "")} className="mt-2 block max-w-full rounded-lg border border-line bg-slate-50 px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-blue-400"><option value="">请选择我的判断</option>{Object.entries(RISK_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label>}
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {status === "pending" ? <><button type="button" disabled={busy || !reason.trim() || !humanRisk} onClick={() => void submit("correct_assessment", state.events)} className="rounded-lg border border-blue-200 px-3 py-2 text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-40">保存个人更正</button><button type="button" disabled={busy || !reason.trim()} onClick={() => void submit("uphold_assessment", state.events)} className="rounded-lg border border-line px-3 py-2 text-ink focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-40">维持原判</button></> : <button type="button" disabled={busy || !reason.trim()} onClick={() => void submit("flag_false_positive", state.events)} className="rounded-lg border border-blue-200 px-3 py-2 text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-40">{status === "unmarked" ? "标记待复核" : "再次标记待复核"}</button>}
            </div>
            <p className="mt-2 text-xs text-ink-faint">{busy ? "正在提交到本机…" : "只追加记录，不覆盖已有意见或模型原判。"}</p>
          </div>
          <div className="min-w-0"><h3 className="text-sm font-semibold text-ink">复核记录（按提交顺序）</h3>{state.events.length === 0 ? <p className="mt-3 text-xs text-ink-soft">还没有个人复核记录。</p> : <ol className="mt-3 space-y-3">{state.events.map((event, index) => <li key={event.id} className="rounded-lg border border-line bg-white p-3"><p className="text-xs font-semibold text-ink">{index + 1}. {REVIEW_ACTION_LABELS[event.action]}{event.action === "correct_assessment" ? ` · 我的判断：${RISK_META[event.humanRisk].label}` : ""}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{event.reason}</p><time dateTime={event.createdAt} className="mt-2 block text-[11px] text-ink-faint">本机使用者 · {new Date(event.createdAt).toLocaleString("zh-CN", { hour12: false })}</time></li>)}</ol>}</div>
        </div>
      </details>}
    </section>
  );
}
