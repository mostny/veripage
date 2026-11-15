import type { StepState } from "@/lib/evidence/types";
import { STATE_LABELS, STATE_TONE, STEP_LABELS } from "./CoverageTimeline";

export interface ProgressStep {
  state: StepState;
  detail?: string;
  reason?: string;
}

export function ScanProgress({ steps, lastStep, status }: {
  steps: Record<string, ProgressStep>;
  lastStep: (ProgressStep & { step: string }) | null;
  status: "running" | "failed" | "interrupted";
}) {
  const stages = Object.entries(STEP_LABELS);
  const received = stages.filter(([key]) => steps[key]).length;

  return (
    <section aria-labelledby="scan-progress-title" className="mx-auto mb-4 max-w-5xl rounded-2xl border border-line bg-white p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.16em] text-blue-600">过程透明</p>
          <h2 id="scan-progress-title" className="mt-1 text-lg font-semibold text-ink">实时核验进度</h2>
          <p className="mt-2 text-xs leading-6 text-ink-soft">只展示服务端已返回的阶段结果，待记录的阶段保留为未知。</p>
        </div>
        <p role="status" aria-atomic="true" className="max-w-full text-xs leading-6 text-ink-soft">
          <span className="block font-medium text-ink">{status === "running" ? "核验进行中" : "核验已停止"} · 已收到 {received} / {stages.length} 条阶段记录</span>
          {lastStep && <span className="block break-words text-ink-soft">最新记录：{STEP_LABELS[lastStep.step] ?? lastStep.step} · {STATE_LABELS[lastStep.state]}</span>}
        </p>
      </div>
      <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {stages.map(([key, label], index) => {
          const result = steps[key];
          const state = result ? STATE_LABELS[result.state] : "待记录";
          return (
            <li key={key} aria-label={`${label}：${state}`} className={`min-w-0 rounded-xl border p-3 ${result ? STATE_TONE[result.state] : "border-line bg-slate-50/60"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line text-[10px] text-ink-soft">{index + 1}</span>
                  <h3 className="text-sm font-medium leading-6 text-ink">{label}</h3>
                </div>
                <span className="shrink-0 text-xs leading-6 text-ink-soft">{state}</span>
              </div>
              {result?.detail && <p className="mt-2 break-words text-xs leading-6 text-ink-soft [overflow-wrap:anywhere]">{result.detail}</p>}
              {result?.reason && <p className="mt-1 break-words text-xs leading-6 text-ink-soft [overflow-wrap:anywhere]">说明：{result.reason}</p>}
              {!result && <p className="mt-1 text-xs leading-6 text-ink-faint">尚未收到阶段结果</p>}
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-xs leading-6 text-ink-soft">{status === "running" ? "完整报告到达后才展示判断与证据。" : "未收到完整报告，本次没有可保存的核验结论。"}</p>
    </section>
  );
}
