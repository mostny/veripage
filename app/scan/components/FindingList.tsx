import type { Finding } from "@/lib/evidence/types";

const KIND_META: Record<Finding["kind"], { label: string; tone: string }> = {
  observed_fact: { label: "观察事实", tone: "border-sky-200 bg-sky-50 text-sky-700" },
  inference: { label: "风险推断", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  reference: { label: "引用资料", tone: "border-violet-200 bg-violet-50 text-violet-700" },
};

export function FindingList({
  findings,
  selectedFindingId,
  onSelectFinding,
  evidenceCountForFinding,
}: {
  findings: Finding[];
  selectedFindingId: string | null;
  onSelectFinding: (finding: Finding) => void;
  evidenceCountForFinding: (finding: Finding) => number;
}) {
  return (
    <section aria-labelledby="findings-title" className="rounded-xl border border-line bg-white p-4 sm:p-5">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">结论有据可查</p>
          <h2 id="findings-title" className="mt-1 text-base font-semibold text-ink">判断依据</h2>
        </div>
        <span className="rounded-full border border-line bg-slate-50/70 px-2.5 py-1 text-xs text-ink-faint">{findings.length} 条</span>
      </div>

      {findings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-slate-50/70 px-4 py-8 text-center">
          <p className="text-sm text-ink-soft">当前没有可展示的具体结论</p>
          <p className="mt-1 text-xs text-ink-faint">请结合风险判断、证据充分度和检测覆盖阅读报告。</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {findings.map((finding) => {
            const kind = KIND_META[finding.kind] ?? KIND_META.inference;
            const selected = selectedFindingId === finding.id;
            const evidenceCount = evidenceCountForFinding(finding);
            return (
              <li key={finding.id}>
                <button
                  id={`finding-${encodeURIComponent(finding.id)}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectFinding(finding)}
                  className={`w-full rounded-lg border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${selected ? "border-blue-400 bg-blue-50/70" : "border-line bg-white hover:border-slate-300 hover:bg-slate-50/70"}`}
                >
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${kind.tone}`}>{kind.label}</span>
                  <span className="ml-2 text-xs text-ink-faint">{finding.id}</span>
                  <p className="mt-2.5 text-sm leading-6 text-ink">{finding.statement}</p>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-xs text-blue-700">
                    <span aria-hidden="true">↳</span>
                    {evidenceCount > 0 ? `定位 ${evidenceCount} 项依据` : "没有可定位的直接证据"}
                  </span>
                  {finding.alternativeExplanations.length > 0 && (
                    <span className="mt-3 block border-t border-line pt-3 text-xs leading-5 text-ink-faint">
                      合理解释：{finding.alternativeExplanations.join("；")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
