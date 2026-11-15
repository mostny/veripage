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
  completed: "border-line bg-slate-50/60",
  partial: "border-amber-200 bg-amber-50/70",
  skipped: "border-line bg-white",
  failed: "border-rose-200 bg-rose-50/70",
};

const STATE_TEXT: Record<CoverageEntry["state"], string> = {
  completed: "text-emerald-700",
  partial: "text-amber-700",
  skipped: "text-ink-faint",
  failed: "text-rose-700",
};

export function CoverageTimeline({ coverage }: { coverage: CoverageEntry[] }) {
  return (
    <section aria-labelledby="coverage-title" className="rounded-xl border border-line bg-white p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">过程透明</p>
          <h2 id="coverage-title" className="mt-1 text-base font-semibold text-ink">检测覆盖</h2>
        </div>
        <span className="rounded-full border border-line bg-slate-50/70 px-2.5 py-1 text-xs text-ink-faint">{coverage.length} 步</span>
      </div>
      {coverage.length === 0 ? (
        <p className="text-sm text-ink-faint">没有收到阶段记录。</p>
      ) : (
        <ol className="space-y-2.5">
          {coverage.map((entry, index) => (
            <li key={`${entry.step}-${index}`} className={`rounded-lg border p-3 ${STATE_TONE[entry.state]}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-line bg-white text-[10px] text-ink-faint">
                    {index + 1}
                  </span>
                  <p className="text-sm font-medium leading-5 text-ink">{STEP_LABELS[entry.step] ?? entry.step}</p>
                </div>
                <span className={`shrink-0 text-xs ${STATE_TEXT[entry.state]}`}>{STATE_LABELS[entry.state]}</span>
              </div>
              <p className="mt-1.5 pl-[30px] text-xs leading-5 text-ink-faint">
                {entry.reason ?? (entry.state === "completed" ? "已完成" : "系统未提供具体原因")}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
