import type { Assessment, CoverageEntry } from "@/lib/evidence/types";

const RISK_META: Record<Assessment["risk"], { label: string; tone: string; icon: string }> = {
  high: { label: "高风险", tone: "border-rose-400/30 bg-rose-400/10 text-rose-100", icon: "!" },
  suspicious: { label: "可疑", tone: "border-amber-300/30 bg-amber-300/10 text-amber-100", icon: "?" },
  no_significant_risk: { label: "暂未发现显著风险", tone: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100", icon: "✓" },
  unknown: { label: "无法判断", tone: "border-slate-300/25 bg-slate-300/5 text-slate-100", icon: "—" },
};

const SUFFICIENCY_LABEL: Record<Assessment["evidenceSufficiency"], string> = {
  sufficient: "充分",
  partial: "部分充分",
  insufficient: "不足",
};

export function ReportSummary({
  assessment,
  coverage,
}: {
  assessment: Assessment;
  coverage: CoverageEntry[];
}) {
  const risk = RISK_META[assessment.risk];
  const done = coverage.filter((entry) => entry.state === "completed").length;
  const total = coverage.length;

  return (
    <section aria-labelledby="report-summary-title" className="rounded-2xl border border-white/10 bg-slate-900/80 p-5 shadow-xl shadow-black/10 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="report-summary-title" className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            本次核验结论
          </h2>
          <div className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold ${risk.tone}`}>
            <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-black/20 text-xs">{risk.icon}</span>
            <span>{risk.label}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:min-w-52">
          <div className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2.5">
            <p className="text-slate-500">证据充分度</p>
            <p className="mt-1 font-semibold text-slate-100">{SUFFICIENCY_LABEL[assessment.evidenceSufficiency]}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2.5">
            <p className="text-slate-500">检测覆盖</p>
            <p className="mt-1 font-semibold text-slate-100">{done}/{total} 完整</p>
          </div>
        </div>
      </div>

      <p className="mt-5 max-w-3xl text-[15px] leading-7 text-slate-200">{assessment.summary}</p>

      <div className="mt-5 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.045] p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-200/80">建议操作</p>
        <p className="mt-1.5 text-sm leading-6 text-slate-100">{assessment.recommendedAction}</p>
      </div>

      {assessment.gaps.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-200/15 bg-amber-200/[0.04] p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-100/80">证据缺口</p>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-slate-300">
            {assessment.gaps.map((gap, index) => <li key={`${index}-${gap}`}>· {gap}</li>)}
          </ul>
        </div>
      )}

      {assessment.unknowns.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">尚不能确认</p>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-slate-400">
            {assessment.unknowns.map((item, index) => <li key={`${index}-${item}`}>· {item}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
