"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EVIDENCE_SUFFICIENCIES, EVIDENCE_TYPES, FINDING_KINDS, RISK_LEVELS, STEP_STATES, type CaseSnapshot } from "@/lib/evidence/types";
import { validateSnapshot } from "@/lib/evidence/validate";
import { minimizeUrlForDisplay } from "@/lib/tools/url-display";
import { useScanInput } from "../scan-input";
import { saveCaseSnapshot } from "@/lib/cases/save";
import { deleteCase } from "@/lib/cases/repository";
import type { CaseSaveState } from "@/lib/cases/types";
import { SaveStatus } from "./components/SaveStatus";
import { ReportWorkbench } from "./components/ReportWorkbench";
import { ScanProgress, type ProgressStep } from "./components/ScanProgress";

interface StepEvent {
  type: "step";
  step: string;
  state: "completed" | "partial" | "skipped" | "failed";
  detail?: string;
  reason?: string;
}

type ScanEvent =
  | StepEvent
  | { type: "started"; taskId: string }
  | { type: "report"; snapshot: CaseSnapshot }
  | { type: "interrupted" };

async function* readScanStream(url: string, signal: AbortSignal): AsyncGenerator<ScanEvent> {
  const response = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
    credentials: "same-origin",
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`检测请求失败（HTTP ${response.status}）${text.slice(0, 120)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let receivedReport = false;

  const parseBlock = (block: string): ScanEvent | undefined => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return undefined;
    try {
      return JSON.parse(data) as ScanEvent;
    } catch {
      return undefined;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const blocks = normalized.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseBlock(block);
        if (!event) continue;
        if (event.type === "report") receivedReport = true;
        yield event;
      }
    }

    buffer += decoder.decode();
    const finalBlock = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    if (finalBlock) {
      const event = parseBlock(finalBlock);
      if (event) {
        if (event.type === "report") receivedReport = true;
        yield event;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!receivedReport) yield { type: "interrupted" };
}

type ScanStatus = "idle" | "running" | "completed" | "failed" | "interrupted";

function interruptedMessage(): string {
  return "检测连接已结束，但没有收到完整报告。可重试本次核验；若多次中断，请稍后再试。";
}

/** SSE is a JSON boundary: check render fields before handing them to the workbench. */
function isRenderableSnapshot(value: unknown): value is CaseSnapshot {
  if (!value || typeof value !== "object") return false;
  const report = value as CaseSnapshot;
  const text = (item: unknown): item is string => typeof item === "string";
  const texts = (items: unknown): items is string[] => Array.isArray(items) && items.every(text);
  const assessment = report.originalAssessment;
  return text(report.id) && text(report.createdAt) &&
    !!report.inputSummary && text(report.inputSummary.displayUrl) && text(report.inputSummary.registrableDomain) &&
    !!report.versions && [report.versions.reportSchema, report.versions.model, report.versions.prompt, report.versions.policy, report.versions.knowledge].every(text) &&
    !!assessment && RISK_LEVELS.includes(assessment.risk) && EVIDENCE_SUFFICIENCIES.includes(assessment.evidenceSufficiency) &&
    text(assessment.summary) && text(assessment.recommendedAction) && texts(assessment.gaps) && texts(assessment.unknowns) &&
    Array.isArray(assessment.findings) && assessment.findings.every((finding) => finding && text(finding.id) &&
      text(finding.statement) && FINDING_KINDS.includes(finding.kind) && texts(finding.evidenceIds) && texts(finding.alternativeExplanations)) &&
    Array.isArray(report.evidence) && report.evidence.every((item) => item && text(item.id) && EVIDENCE_TYPES.includes(item.type) &&
      text(item.capturedAt) && text(item.source) && [item.locator, item.excerpt, item.artifactId].every((entry) => entry === undefined || text(entry))) &&
    Array.isArray(report.coverage) && report.coverage.every((entry) => entry && text(entry.step) && STEP_STATES.includes(entry.state) &&
      (entry.reason === undefined || text(entry.reason))) && texts(report.artifactIds);
}

function ScanClient({ targetUrl }: { targetUrl: string }) {
  const displayUrl = minimizeUrlForDisplay(targetUrl);
  const [steps, setSteps] = useState<Record<string, ProgressStep>>({});
  const [lastStep, setLastStep] = useState<StepEvent | null>(null);
  const [snapshot, setSnapshot] = useState<CaseSnapshot | null>(null);
  const [fatal, setFatal] = useState("");
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [taskId, setTaskId] = useState("");
  const [saveState, setSaveState] = useState<CaseSaveState>({ status: "idle" });
  const [reportValidationFailed, setReportValidationFailed] = useState(false);
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const persist = useCallback(async (report: CaseSnapshot, reportTaskId: string) => {
    const generation = generationRef.current;
    setSaveState({ status: "saving" });
    try {
      const record = await saveCaseSnapshot(report, reportTaskId);
      if (generation === generationRef.current) setSaveState({ status: "saved", record });
    } catch (error) {
      if (generation === generationRef.current) setSaveState({ status: "error", message: error instanceof Error ? error.message : "本机存储不可用" });
    }
  }, []);

  const removeSavedCase = useCallback(async (id: string) => {
    const generation = generationRef.current;
    await deleteCase(id);
    if (generation === generationRef.current) setSaveState({ status: "deleted" });
  }, []);

  const run = useCallback(async (url: string) => {
    abortControllerRef.current?.abort(new DOMException("Superseded by a newer scan", "AbortError"));
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const generation = ++generationRef.current;

    setSteps({});
    setLastStep(null);
    setSnapshot(null);
    setFatal("");
    setTaskId("");
    setSaveState({ status: "idle" });
    setReportValidationFailed(false);
    setStatus("running");
    let terminal: Exclude<ScanStatus, "idle"> = "running";
    let reportTaskId = "";
    let validationFailure: string | undefined;
    const finishWithoutReport = () => {
      terminal = validationFailure === undefined ? "interrupted" : "failed";
      setFatal(validationFailure === undefined ? interruptedMessage() : `检测未完成：${validationFailure}`);
      setStatus(terminal);
    };

    try {
      for await (const event of readScanStream(url, abortController.signal)) {
        if (generation !== generationRef.current) return;

        if (event.type === "started") {
          reportTaskId = event.taskId;
          setTaskId(event.taskId);
          continue;
        }
        if (event.type === "interrupted") {
          if (terminal === "running") finishWithoutReport();
          continue;
        }
        if (event.type === "step") {
          setSteps((previous) => ({
            ...previous,
            [event.step]: { state: event.state, detail: event.detail, reason: event.reason },
          }));
          setLastStep(event);
          if (event.step === "validate") validationFailure = event.state === "failed"
            ? event.reason ?? event.detail ?? "服务端未能生成有效报告"
            : undefined;
          continue;
        }

        if (!isRenderableSnapshot(event.snapshot)) {
          throw new Error("收到的报告缺少有效判断结构。请重试；本次不会将不完整结果展示为结论。");
        }
        const hardErrors = validateSnapshot(event.snapshot).errors.filter((error) => !error.startsWith("[warn]"));
        setReportValidationFailed(hardErrors.length > 0 || event.snapshot.coverage.some((entry) => entry.step === "validate" && entry.state === "failed"));
        terminal = "completed";
        setFatal("");
        setSnapshot(event.snapshot);
        setStatus("completed");
        void persist(event.snapshot, reportTaskId);
        // A report is terminal; later connection noise must not turn success into failure.
        break;
      }
    } catch (error) {
      if (abortController.signal.aborted || generation !== generationRef.current) return;
      terminal = "failed";
      setFatal(error instanceof Error ? error.message : "检测请求失败");
      setStatus("failed");
    } finally {
      if (generation === generationRef.current && terminal === "running") {
        finishWithoutReport();
      }
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
    }
  }, [persist]);

  useEffect(() => {
    if (!targetUrl) return;
    const timer = window.setTimeout(() => void run(targetUrl), 0);
    return () => {
      window.clearTimeout(timer);
      generationRef.current += 1;
      abortControllerRef.current?.abort(new DOMException("Scan page unloaded", "AbortError"));
    };
  }, [targetUrl, run]);

  const assessment = snapshot?.originalAssessment;

  return (
    <main className="min-h-screen bg-paper px-3 py-5 text-ink sm:px-5 sm:py-8">
      <div className="mx-auto w-full max-w-[1480px]">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-white px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <Link href="/" className="text-xs font-medium text-blue-600 transition hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
              ← 网鉴 VeriPage
            </Link>
            <h1 className="mt-1 break-all font-mono text-xs leading-5 text-ink-soft sm:text-sm" title={displayUrl}>
              {displayUrl}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {status === "completed" && (
              <span className={`rounded-full border px-3 py-1 text-xs ${reportValidationFailed ? "border-amber-300 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{reportValidationFailed ? "报告已收到 · 校验未通过" : "检测完成"}</span>
            )}
            <button
              type="button"
              onClick={() => targetUrl && void run(targetUrl)}
              disabled={!targetUrl || status === "running"}
              className="rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-medium text-ink transition hover:border-blue-300 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "running" ? "核验中…" : "重新检测"}
            </button>
          </div>
        </header>

        {!snapshot && (status === "running" || status === "failed" || status === "interrupted") && (
          <ScanProgress steps={steps} lastStep={lastStep} status={status} />
        )}

        {fatal && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <p>{fatal}</p>
            {targetUrl && (
              <button type="button" onClick={() => void run(targetUrl)} className="rounded-lg border border-rose-300 px-3 py-1.5 text-xs font-medium hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200">
                重试核验
              </button>
            )}
          </div>
        )}

        {snapshot && assessment && (
          <>
            <ReportWorkbench key={snapshot.id} snapshot={snapshot} source={{ kind: "temporary", taskId }} />

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.72fr)]">
              <SaveStatus key={snapshot.id} state={saveState} onRetry={() => void persist(snapshot, taskId)} onDelete={() => removeSavedCase(snapshot.id)} />
              <div className="flex flex-col justify-center gap-1 px-2 text-center text-[11px] leading-5 text-ink-faint lg:text-right">
                <span>原始风险判断与证据快照 · model={snapshot.versions.model} · prompt={snapshot.versions.prompt}</span>
                <span>AI 辅助核验；“暂未发现显著风险”不构成安全保证。</span>
              </div>
            </div>
          </>
        )}

        {snapshot && !assessment && (
          <div role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
            收到的报告缺少有效判断结构。请重试；本次不会将不完整结果展示为结论。
          </div>
        )}

        {snapshot && !assessment?.findings.length && assessment && (
          <p className="sr-only" aria-live="polite">报告没有可展示的具体结论，请结合风险判断、覆盖和证据缺口阅读。</p>
        )}
      </div>
    </main>
  );
}

export default function ScanPage() {
  const { targetUrl } = useScanInput();
  if (targetUrl) return <ScanClient targetUrl={targetUrl} />;

  return (
    <main className="grid min-h-screen place-items-center bg-paper px-4 text-ink">
      <section className="max-w-lg rounded-2xl border border-line bg-white p-8 text-center">
        <h1 className="text-lg font-semibold">先输入一个待核验链接</h1>
        <p className="mt-2 text-sm leading-6 text-ink-soft">链接只在当前页面会话中临时传递，刷新或离开后需要重新输入。</p>
        <Link href="/" className="mt-5 inline-block rounded-lg border border-blue-200 px-4 py-2 text-sm text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">返回首页</Link>
        <Link href="/cases" className="ml-3 mt-5 inline-block rounded-lg border border-line px-4 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">查看本机案例</Link>
      </section>
    </main>
  );
}
