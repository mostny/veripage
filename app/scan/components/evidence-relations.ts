import type { EvidenceItem, Finding } from "@/lib/evidence/types";

/** Index one snapshot once. Collapse cycles, then propagate evidence bitsets on the DAG. */
export function indexEvidenceRelations(findings: Finding[], evidence: EvidenceItem[]) {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const evidenceIndex = new Map(evidence.map((item, index) => [item.id, index]));
  const edges = new Map(findings.map((finding) => [finding.id, finding.evidenceIds.filter((id) => !evidenceIndex.has(id) && byId.has(id))]));
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const component = new Map<string, number>();
  const groups: string[][] = [];
  let next = 0;

  function connect(id: string) {
    const rank = next++;
    order.set(id, rank); low.set(id, rank);
    stack.push(id); onStack.add(id);
    for (const dependency of edges.get(id) ?? []) {
      if (!order.has(dependency)) {
        connect(dependency);
        low.set(id, Math.min(low.get(id)!, low.get(dependency)!));
      } else if (onStack.has(dependency)) low.set(id, Math.min(low.get(id)!, order.get(dependency)!));
    }
    if (low.get(id) === order.get(id)) {
      const members: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.set(member, groups.length);
        members.push(member);
      } while (member !== id);
      groups.push(members);
    }
  }
  for (const id of byId.keys()) if (!order.has(id)) connect(id);

  // Tarjan emits dependency components before their dependents.
  const words = Math.ceil(evidence.length / 32);
  const bits = groups.map(() => new Uint32Array(words));
  const totals: number[] = [];
  for (let group = 0; group < groups.length; group++) {
    const dependencies = new Set<number>();
    for (const id of groups[group]) {
      for (const reference of byId.get(id)!.evidenceIds) {
        const index = evidenceIndex.get(reference);
        if (index !== undefined) bits[group][index >>> 5] |= 1 << (index & 31);
        else {
          const target = component.get(reference);
          if (target !== undefined && target !== group) dependencies.add(target);
        }
      }
    }
    for (const target of dependencies) for (let word = 0; word < words; word++) bits[group][word] |= bits[target][word];
    let total = 0;
    for (const value of bits[group]) {
      let remaining = value;
      while (remaining) { remaining = (remaining & (remaining - 1)) >>> 0; total += 1; }
    }
    totals[group] = total;
  }
  return {
    countForFinding(id: string): number { const group = component.get(id); return group === undefined ? 0 : totals[group]; },
    findingsForEvidence(id: string): Finding[] {
      const index = evidenceIndex.get(id);
      if (index === undefined) return [];
      return findings.filter((finding) => (bits[component.get(finding.id)!][index >>> 5] & (1 << (index & 31))) !== 0);
    },
  };
}

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
