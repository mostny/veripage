import type { EvidenceItem, Finding } from "@/lib/evidence/types";

/** Resolve an inference chain to its concrete evidence IDs without looping. */
export function resolveEvidenceIdsForFinding(
  findingId: string,
  findings: Finding[],
  evidence: EvidenceItem[],
): string[] {
  const findingById = new Map(findings.map((finding) => [finding.id, finding]));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const resolved = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const finding = findingById.get(id);
    if (!finding) return;
    for (const reference of finding.evidenceIds) {
      if (evidenceIds.has(reference)) resolved.add(reference);
      else if (findingById.has(reference)) visit(reference);
    }
  };

  visit(findingId);
  return [...resolved];
}

export function findFindingsForEvidence(
  evidenceId: string,
  findings: Finding[],
  evidence: EvidenceItem[],
): Finding[] {
  return findings.filter((finding) =>
    resolveEvidenceIdsForFinding(finding.id, findings, evidence).includes(evidenceId),
  );
}
