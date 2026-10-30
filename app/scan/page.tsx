"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { CaseSnapshot, EvidenceItem, Finding } from "@/lib/evidence/types";
import { CoverageTimeline } from "./components/CoverageTimeline";
import { EvidencePanel } from "./components/EvidencePanel";
import { FindingList } from "./components/FindingList";
import { ReportSummary } from "./components/ReportSummary";
import { SaveStatus } from "./components/SaveStatus";
import { ScreenshotViewer } from "./components/ScreenshotViewer";
import { findFindingsForEvidence, resolveEvidenceIdsForFinding } from "./components/evidence-relations";

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

type UiState = "pending" | "running" | "completed" | "partial" | "skipped" | "failed";
type ScanStatus = "idle" | "running" | "completed" | "failed" | "interrupted";

const STEP_LABELS: Array<{ key: string; label: string }> = [
  { key: "s0-guard", label: "S0 访问边界（SSRF 防护）" },
  { key: "gate1-static", label: "闸门① 链接静态分析" },
  { key: "gate2-fetch", label: "闸门② 沙箱代访取证" },
  { key: "gate3-vision", label: "闸门③ 视觉核验" },
  { key: "gate3-analyzer", label: "闸门③ 身份一致性分析" },
  { key: "validate", label: "快照校验" },
];

function interruptedMessage(): string {
  return "检测连接已结束，但没有收到完整报告。可重试本次核验；若多次中断，请稍后再试。";
}

function ScanClient() {
  const params = useSearchParams();
  const targetUrl = params.get("url") ?? "";
  const [steps, setSteps] = useState<Record<string, { state: UiState; detail?: string; reason?: string }>>({});
  const [snapshot, setSnapshot] = useState<CaseSnapshot | null>(null);
  const [fatal, setFatal] = useState("");
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [taskId, setTaskId] = useState("");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const generationRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async (url: string) => {
    abortControllerRef.current?.abort(new DOMException("Superseded by a newer scan", "AbortError"));
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const generation = ++generationRef.current;

    setSteps({});
    setSnapshot(null);
    setFatal("");
    setTaskId("");
    setSelectedFindingId(null);
    setSelectedEvidenceId(null);
    setStatus("running");
    let terminal: Exclude<ScanStatus, "idle"> = "running";

    try {
      for await (const event of readScanStream(url, abortController.signal)) {
        if (generation !== generationRef.current) return;

        if (event.type === "started") {
          setTaskId(event.taskId);
          continue;
        }
        if (event.type === "interrupted") {
          if (terminal === "running") {
            terminal = "interrupted";
            setFatal(interruptedMessage());
            setStatus("interrupted");
          }
          continue;
        }
        if (event.type === "step") {
          setSteps((previous) => ({
            ...previous,
            [event.step]: { state: event.state, detail: event.detail, reason: event.reason },
          }));
          if (event.step === "validate" && event.state === "failed") {
            terminal = "failed";
            setFatal(`检测未完成：${event.reason ?? "服务端未能生成有效报告"}`);
            setStatus("failed");
          }
          continue;
        }

        terminal = "completed";
        setSnapshot(event.snapshot);
        setStatus("completed");
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
        terminal = "interrupted";
        setFatal(interruptedMessage());
        setStatus("interrupted");
      }
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!targetUrl) return;
    const timer = window.setTimeout(() => void run(targetUrl), 0);
    return () => {
      window.clearTimeout(timer);
      abortControllerRef.current?.abort(new DOMException("Scan page unloaded", "AbortError"));
    };
  }, [targetUrl, run]);

  const scrollToItem = useCallback((prefix: "finding" | "evidence", id: string) => {
    const targetId = `${prefix}-${encodeURIComponent(id)}`;
    window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    });
  }, []);

  const selectFinding = useCallback((finding: Finding) => {
    setSelectedFindingId(finding.id);
    const matchingIds = snapshot
      ? resolveEvidenceIdsForFinding(finding.id, snapshot.originalAssessment.findings, snapshot.evidence)
      : [];
    const firstEvidenceId = matchingIds[0];
    setSelectedEvidenceId(firstEvidenceId ?? null);
    if (firstEvidenceId) scrollToItem("evidence", firstEvidenceId);
  }, [scrollToItem, snapshot]);

  const selectEvidence = useCallback((item: EvidenceItem) => {
    setSelectedEvidenceId(item.id);
    if (!snapshot) return;
    const related = findFindingsForEvidence(item.id, snapshot.originalAssessment.findings, snapshot.evidence);
    setSelectedFindingId(related[0]?.id ?? null);
  }, [snapshot]);

  const uiStates: Record<string, UiState> = {};
  let runningAssigned = false;
  for (const { key } of STEP_LABELS) {
    const current = steps[key];
    if (current) {
      uiStates[key] = current.state;
    } else if (!runningAssigned && status === "running") {
      uiStates[key] = "running";
      runningAssigned = true;
    } else {
      uiStates[key] = "pending";
    }
  }

  const assessment = snapshot?.originalAssessment;
  const linkedFindings = snapshot && selectedEvidenceId
    ? findFindingsForEvidence(selectedEvidenceId, assessment?.findings ?? [], snapshot.evidence)
    : [];

  return (
    <main className="min-h-screen bg-[#07111d] px-3 py-5 text-slate-100 sm:px-5 sm:py-8">
      <div className="mx-auto w-full max-w-[1480px]">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <Link href="/" className="text-xs font-medium text-emerald-200/80 transition hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">
              ← 网鉴 VeriPage
            </Link>
            <h1 className="mt-1 break-all font-mono text-xs leading-5 text-slate-300 sm:text-sm" title={targetUrl}>
              {targetUrl || "缺少待核验链接"}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            {status === "completed" && (
              <span className="rounded-full border border-emerald-300/20 bg-emerald-300/5 px-3 py-1 text-xs text-emerald-100/80">检测完成</span>
            )}
            <button
              type="button"
              onClick={() => targetUrl && void run(targetUrl)}
              disabled={!targetUrl || status === "running"}
              className="rounded-xl border border-white/15 bg-white/[0.04] px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:border-emerald-200/35 hover:bg-emerald-200/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "running" ? "核验中…" : "重新检测"}
            </button>
          </div>
        </header>

        {!targetUrl && (
          <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-8 text-center">
            <h2 className="text-lg font-semibold">先输入一个待核验链接</h2>
            <p className="mt-2 text-sm text-slate-400">返回首页粘贴链接；待测页面不会在你的当前浏览器中打开。</p>
          </section>
        )}

        {status === "running" && !snapshot && (
          <div role="status" className="mb-4 flex items-center gap-3 rounded-2xl border border-sky-200/15 bg-sky-200/[0.04] px-4 py-3 text-sm text-sky-100/90">
            <span aria-hidden="true" className="motion-safe:animate-spin">◌</span>
            <span>隔离取证与证据核验正在进行。未执行的步骤会明确标出。</span>
          </div>
        )}

        {fatal && (
          <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200/20 bg-rose-200/[0.05] px-4 py-3 text-sm text-rose-100">
            <p>{fatal}</p>
            {targetUrl && (
              <button type="button" onClick={() => void run(targetUrl)} className="rounded-lg border border-rose-100/20 px-3 py-1.5 text-xs font-medium hover:bg-rose-100/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200">
                重试核验
              </button>
            )}
          </div>
        )}

        {snapshot && assessment && (
          <>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[250px_minmax(0,1.15fr)_minmax(360px,0.95fr)] xl:grid-rows-[auto_auto] xl:items-start">
              <div className="xl:col-start-3 xl:row-start-1">
                <ReportSummary assessment={assessment} coverage={snapshot.coverage} />
              </div>

              <div className="xl:col-start-3 xl:row-start-2">
                <FindingList
                  findings={assessment.findings}
                  selectedFindingId={selectedFindingId}
                  onSelectFinding={selectFinding}
                  evidenceCountForFinding={(finding) => resolveEvidenceIdsForFinding(finding.id, assessment.findings, snapshot.evidence).length}
                />
              </div>

              <div className="xl:col-start-2 xl:row-start-1">
                <ScreenshotViewer
                  taskId={taskId}
                  evidence={snapshot.evidence}
                  selectedEvidenceId={selectedEvidenceId}
                  onSelectEvidence={(id) => {
                    const item = snapshot.evidence.find((entry) => entry.id === id);
                    if (item) selectEvidence(item);
                  }}
                />
              </div>

              <div className="xl:col-start-2 xl:row-start-2">
                <EvidencePanel
                  evidence={snapshot.evidence}
                  selectedEvidenceId={selectedEvidenceId}
                  linkedFindings={linkedFindings}
                  selectedFindingId={selectedFindingId}
                  onSelectEvidence={selectEvidence}
                  onSelectFinding={selectFinding}
                />
              </div>

              <div className="xl:col-start-1 xl:row-span-2 xl:row-start-1">
                <CoverageTimeline coverage={snapshot.coverage} />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.72fr)]">
              <SaveStatus />
              <div className="flex flex-col justify-center gap-1 px-2 text-center text-[11px] leading-5 text-slate-600 lg:text-right">
                <span>原始风险判断与证据快照 · model={snapshot.versions.model} · prompt={snapshot.versions.prompt}</span>
                <span>AI 辅助核验；“暂未发现显著风险”不构成安全保证。</span>
              </div>
            </div>
          </>
        )}

        {snapshot && !assessment && (
          <div role="alert" className="rounded-2xl border border-amber-200/20 bg-amber-200/[0.04] p-5 text-sm text-amber-100">
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
  return (
    <Suspense fallback={<main className="grid min-h-screen place-items-center bg-[#07111d] text-sm text-slate-400">正在载入核验工作台…</main>}>
      <ScanClient />
    </Suspense>
  );
}
