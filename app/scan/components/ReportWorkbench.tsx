"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { CaseSnapshot, EvidenceItem, Finding } from "@/lib/evidence/types";
import type { ArtifactRetention } from "@/lib/cases/types";
import { CoverageTimeline } from "./CoverageTimeline";
import { EvidencePanel } from "./EvidencePanel";
import { FindingList } from "./FindingList";
import { ReportSummary } from "./ReportSummary";
import { ScreenshotViewer } from "./ScreenshotViewer";
import { indexEvidenceRelations, resolveEvidenceIdsForFinding } from "./evidence-relations";

type ReportSource =
  | { kind: "temporary"; taskId: string }
  | { kind: "local"; imageUrl: string | null; retention: ArtifactRetention[] };

export function ReportWorkbench({ snapshot, source }: { snapshot: CaseSnapshot; source: ReportSource }) {
  const root = useRef<HTMLDivElement>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const assessment = snapshot.originalAssessment;
  const relations = useMemo(() => indexEvidenceRelations(snapshot.originalAssessment.findings, snapshot.evidence), [snapshot]);
  const screenshot = snapshot.evidence.find((item) => item.type === "screenshot");
  const imageUrl = source.kind === "local" ? source.imageUrl
    : source.taskId && screenshot?.artifactId
      ? `/api/scans/${encodeURIComponent(source.taskId)}/artifacts/${encodeURIComponent(screenshot.artifactId)}` : null;

  const selectFinding = useCallback((finding: Finding) => {
    setSelectedFindingId(finding.id);
    const ids = resolveEvidenceIdsForFinding(finding.id, snapshot.originalAssessment.findings, snapshot.evidence);
    const first = ids[0] ?? null;
    setSelectedEvidenceId(first);
    if (first) window.requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>(`[id="evidence-${encodeURIComponent(first)}"]`)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "center",
      });
    });
  }, [snapshot]);

  const selectEvidence = useCallback((item: EvidenceItem) => {
    setSelectedEvidenceId(item.id);
    const linked = relations.findingsForEvidence(item.id);
    setSelectedFindingId(linked[0]?.id ?? null);
  }, [relations]);
  const linkedFindings = selectedEvidenceId
    ? relations.findingsForEvidence(selectedEvidenceId) : [];

  return (
    <div ref={root} className="grid grid-cols-1 gap-4 xl:grid-cols-[250px_minmax(0,1.25fr)_minmax(340px,0.95fr)] xl:items-start">
      <div className="xl:col-span-3 xl:row-start-1"><ReportSummary assessment={assessment} coverage={snapshot.coverage} /></div>
      <div className="xl:col-start-1 xl:row-span-2 xl:row-start-2"><CoverageTimeline coverage={snapshot.coverage} /></div>
      <div className="xl:col-start-2 xl:row-start-2">
        <ScreenshotViewer mode={source.kind} imageUrl={imageUrl} evidence={snapshot.evidence} selectedEvidenceId={selectedEvidenceId} onSelectEvidence={(id) => {
          const item = snapshot.evidence.find((entry) => entry.id === id);
          if (item) selectEvidence(item);
        }} />
      </div>
      <div className="xl:col-start-3 xl:row-start-2 xl:row-span-2">
        <FindingList findings={assessment.findings} selectedFindingId={selectedFindingId} onSelectFinding={selectFinding} evidenceCountForFinding={(finding) => relations.countForFinding(finding.id)} />
      </div>
      <div className="xl:col-start-2 xl:row-start-3">
        <EvidencePanel evidence={snapshot.evidence} retention={source.kind === "local" ? source.retention : undefined} selectedEvidenceId={selectedEvidenceId} linkedFindings={linkedFindings} selectedFindingId={selectedFindingId} onSelectEvidence={selectEvidence} onSelectFinding={selectFinding} />
      </div>
    </div>
  );
}
