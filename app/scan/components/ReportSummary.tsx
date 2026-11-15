import type { Assessment, CoverageEntry } from "@/lib/evidence/types";

const RISK_META: Record<Assessment["risk"], { label: string; tone: string; icon: string }> = {
  high: { label: "高风险", tone: "border-rose-200 bg-rose-50 text-rose-700", icon: "!" },
  suspicious: { label: "可疑", tone: "border-amber-200 bg-amber-50 text-amber-700", icon: "?" },
  no_significant_risk: { label: "暂未发现显著风险", tone: "border-emerald-200 bg-emerald-50 text-emerald-700", icon: "✓" },
  unknown: { label: "无法判断", tone: "border-line bg-slate-100 text-ink-soft", icon: "—" },
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
    <section aria-labelledby="report-summary-title" className="rounded-xl border border-line bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="report-summary-title" className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            本次核验结论
          </h2>
          <div className={`mt-3 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold ${risk.tone}`}>
            <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-white/70 text-xs">{risk.icon}</span>
            <span>{risk.label}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:min-w-52">
          <div className="rounded-lg border border-line bg-slate-50/70 px-3 py-2.5">
            <p className="text-ink-faint">证据充分度</p>
            <p className="mt-1 font-semibold text-ink">{SUFFICIENCY_LABEL[assessment.evidenceSufficiency]}</p>
          </div>
          <div className="rounded-lg border border-line bg-slate-50/70 px-3 py-2.5">
            <p className="text-ink-faint">检测覆盖</p>
            <p className="mt-1 font-semibold text-ink">{done}/{total} 完整</p>
          </div>
        </div>
      </div>

      <p className="mt-5 max-w-3xl text-[15px] leading-7 text-ink">{assessment.summary}</p>

      <div className="mt-5 max-w-3xl rounded-lg border border-emerald-100 bg-emerald-50/70 p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">建议操作</p>
        <p className="mt-1.5 text-sm leading-6 text-ink-soft">{assessment.recommendedAction}</p>
      </div>

      {assessment.gaps.length > 0 && (
        <div className="mt-4 max-w-3xl rounded-lg border border-amber-100 bg-amber-50/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">证据缺口</p>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-ink-soft">
            {assessment.gaps.map((gap, index) => <li key={`${index}-${gap}`}>· {gap}</li>)}
          </ul>
        </div>
      )}

      {assessment.unknowns.length > 0 && (
        <div className="mt-4 max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint">尚不能确认</p>
          <ul className="mt-2 space-y-1 text-sm leading-6 text-ink-soft">
            {assessment.unknowns.map((item, index) => <li key={`${index}-${item}`}>· {item}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
