/** Evidence workbench relationship contract; offline. Run: node eval/evidence-relations.smoke.ts */
import assert from "node:assert/strict";
import type { EvidenceItem, Finding } from "../lib/evidence/types.ts";
import { findFindingsForEvidence, indexEvidenceRelations, resolveEvidenceIdsForFinding } from "../app/scan/components/evidence-relations.ts";

const evidence: EvidenceItem[] = [
  { id: "ev-form-1", type: "form", capturedAt: "2026-10-29T00:00:00Z", source: "fixture", excerpt: "密码框" },
  { id: "ev-url", type: "url", capturedAt: "2026-10-29T00:00:00Z", source: "fixture", excerpt: "example.test" },
];
const findings: Finding[] = [
  { id: "fact-1", statement: "观察到密码框", kind: "observed_fact", evidenceIds: ["ev-form-1"], alternativeExplanations: [] },
  { id: "inference-1", statement: "可能索取凭据", kind: "inference", evidenceIds: ["fact-1", "ev-url"], alternativeExplanations: [] },
  { id: "cycle-a", statement: "循环 A", kind: "inference", evidenceIds: ["cycle-b"], alternativeExplanations: [] },
  { id: "cycle-b", statement: "循环 B", kind: "inference", evidenceIds: ["cycle-a"], alternativeExplanations: [] },
];

assert.deepEqual(resolveEvidenceIdsForFinding("fact-1", findings, evidence), ["ev-form-1"]);
assert.deepEqual(resolveEvidenceIdsForFinding("inference-1", findings, evidence), ["ev-form-1", "ev-url"]);
assert.deepEqual(resolveEvidenceIdsForFinding("cycle-a", findings, evidence), []);
assert.deepEqual(findFindingsForEvidence("ev-form-1", findings, evidence).map((finding) => finding.id), ["fact-1", "inference-1"]);
assert.deepEqual(findFindingsForEvidence("ev-url", findings, evidence).map((finding) => finding.id), ["inference-1"]);
const indexed = indexEvidenceRelations(findings, evidence);
for (const finding of findings) assert.equal(indexed.countForFinding(finding.id), resolveEvidenceIdsForFinding(finding.id, findings, evidence).length);
for (const item of evidence) assert.deepEqual(indexed.findingsForEvidence(item.id).map((finding) => finding.id), findFindingsForEvidence(item.id, findings, evidence).map((finding) => finding.id));

const chained: Finding[] = [
  { ...findings[1], id: "outer", evidenceIds: ["a", "ev-form-1"] },
  { ...findings[1], id: "a", evidenceIds: ["b"] },
  { ...findings[1], id: "b", evidenceIds: ["a", "ev-url"] },
];
const chainIndex = indexEvidenceRelations(chained, evidence);
assert.equal(chainIndex.countForFinding("outer"), 2);
assert.equal(chainIndex.countForFinding("a"), 1);
assert.equal(chainIndex.countForFinding("b"), 1);
assert.deepEqual(chainIndex.findingsForEvidence("ev-url").map((finding) => finding.id), ["outer", "a", "b"]);
assert.deepEqual(chainIndex.findingsForEvidence("ev-form-1").map((finding) => finding.id), ["outer"]);

const wideEvidence = Array.from({ length: 70 }, (_, index) => ({ ...evidence[0], id: `wide-${index}` }));
const wideFindings = [{ ...findings[0], id: "wide-fact", evidenceIds: ["wide-31", "wide-32", "wide-69"] }, { ...findings[1], id: "wide-inference", evidenceIds: ["wide-fact"] }];
const wideIndex = indexEvidenceRelations(wideFindings, wideEvidence);
assert.deepEqual(wideFindings.map((finding) => wideIndex.countForFinding(finding.id)), [3, 3]);
assert.deepEqual(wideIndex.findingsForEvidence("wide-69").map((finding) => finding.id), ["wide-fact", "wide-inference"]);
assert.deepEqual(wideIndex.findingsForEvidence("wide-0"), []);

const dense: Finding[] = Array.from({ length: 400 }, (_, index) => ({ ...findings[1], id: `dense-${index}`, evidenceIds: [...Array.from({ length: 400 }, (_, n) => `dense-${n}`).filter((id) => id !== `dense-${index}`), ...(index === 0 ? ["ev-url"] : [])] }));
const denseIndex = indexEvidenceRelations(dense, evidence);
assert.ok(dense.every((finding) => denseIndex.countForFinding(finding.id) === 1));
assert.equal(denseIndex.findingsForEvidence("ev-url").length, 400);
console.log("ALL-PASS (legacy linkage, SCC dependencies, bitset boundaries and dense-graph indexing)");
