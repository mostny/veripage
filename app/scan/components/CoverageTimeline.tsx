import type { CoverageEntry } from "@/lib/evidence/types";

const STEP_LABELS: Record<string, string> = {
  "s0-guard": "访问边界",
  "gate1-static": "链接静态分析",
  "gate2-fetch": "隔离取证",
  "gate3-vision": "视觉核验",
  "gate3-analyzer": "身份一致性判断",
  validate: "报告校验",
};

const STATE_LABELS: Record<CoverageEntry["state"], string> = {
  completed: "完成",
  partial: "部分完成",
  skipped: "跳过",
  failed: "失败",
};

const STATE_TONE: Record<CoverageEntry["state"], string> = {
  completed: "border-emerald-300/20 bg-emerald-300/5",
  partial: "border-amber-200/20 bg-amber-200/[0.04]",
  skipped: "border-slate-300/10 bg-slate-300/[0.025]",
  failed: "border-rose-300/25 bg-rose-300/[0.05]",
};

export function CoverageTimeline({ coverage }: { coverage: CoverageEntry[] }) {
  return (
    <section aria-labelledby="coverage-title" className="rounded-2xl border border-white/10 bg-slate-900/65 p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">过程透明</p>
          <h2 id="coverage-title" className="mt-1 text-base font-semibold text-slate-100">检测覆盖</h2>
        </div>
        <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-slate-400">{coverage.length} 步</span>
      </div>
      {coverage.length === 0 ? (
        <p className="text-sm text-slate-500">没有收到阶段记录。</p>
      ) : (
        <ol className="space-y-2.5">
          {coverage.map((entry, index) => (
            <li key={`${entry.step}-${index}`} className={`rounded-xl border p-3 ${STATE_TONE[entry.state]}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-white/15 text-[10px] text-slate-300">
                    {index + 1}
                  </span>
                  <p className="text-sm font-medium leading-5 text-slate-200">{STEP_LABELS[entry.step] ?? entry.step}</p>
                </div>
                <span className="shrink-0 text-xs text-slate-400">{STATE_LABELS[entry.state]}</span>
              </div>
              <p className="mt-1.5 pl-[30px] text-xs leading-5 text-slate-500">
                {entry.reason ?? (entry.state === "completed" ? "已完成" : "系统未提供具体原因")}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
