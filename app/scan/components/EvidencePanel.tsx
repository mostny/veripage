import type { EvidenceItem, Finding } from "@/lib/evidence/types";

const TYPE_LABEL: Record<EvidenceItem["type"], string> = {
  url: "链接与域名",
  redirect: "跳转记录",
  screenshot: "页面截图",
  text: "页面文字",
  form: "表单事实",
  request: "网络/脚本事实",
  reputation: "信誉信息",
  knowledge: "核验资料",
};

export function EvidencePanel({
  evidence,
  selectedEvidenceId,
  linkedFindings,
  selectedFindingId,
  onSelectEvidence,
  onSelectFinding,
}: {
  evidence: EvidenceItem[];
  selectedEvidenceId: string | null;
  linkedFindings: Finding[];
  selectedFindingId: string | null;
  onSelectEvidence: (item: EvidenceItem) => void;
  onSelectFinding: (finding: Finding) => void;
}) {
  return (
    <section aria-labelledby="evidence-title" className="rounded-xl border border-line bg-white p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">可回溯的采集记录</p>
          <h2 id="evidence-title" className="mt-1 text-base font-semibold text-ink">证据清单</h2>
        </div>
        <span className="rounded-full border border-line bg-slate-50/70 px-2.5 py-1 text-xs text-ink-faint">{evidence.length} 项</span>
      </div>

      {evidence.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-7 text-center text-sm text-ink-faint">本次没有取得可展示的证据。</p>
      ) : (
        <ul className="space-y-2">
          {evidence.map((item) => {
            const selected = selectedEvidenceId === item.id;
            return (
              <li key={item.id}>
                <button
                  id={`evidence-${encodeURIComponent(item.id)}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectEvidence(item)}
                  className={`w-full rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${selected ? "border-blue-400 bg-blue-50/70" : "border-line bg-white hover:border-slate-300 hover:bg-slate-50/70"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-ink-soft">{TYPE_LABEL[item.type] ?? item.type}</span>
                    {item.artifactId && <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">{item.type === "screenshot" ? "有短期截图" : "有短期产物"}</span>}
                  </div>
                  <p className="mt-1.5 break-words text-sm leading-5 text-ink">{item.excerpt ?? item.locator ?? "采集到证据，但没有文字摘录"}</p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-ink-faint">
                    <span>来源：{item.source}</span>
                    <span>{item.capturedAt}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selectedEvidenceId && (
        <div aria-live="polite" className="mt-4 rounded-lg border border-line bg-slate-50/70 p-3">
          <p className="text-xs font-semibold text-ink-soft">与所选证据相关的结论</p>
          {linkedFindings.length === 0 ? (
            <p className="mt-2 text-xs text-ink-faint">没有结论引用此证据。</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {linkedFindings.map((finding) => (
                <li key={finding.id}>
                  <button
                    type="button"
                    aria-pressed={selectedFindingId === finding.id}
                    onClick={() => onSelectFinding(finding)}
                    className={`rounded text-left text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${selectedFindingId === finding.id ? "font-medium text-blue-800" : "text-ink-soft hover:text-ink"}`}
                  >
                    {finding.statement}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
