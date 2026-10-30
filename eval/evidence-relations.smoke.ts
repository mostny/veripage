/** Evidence workbench relationship contract; offline. Run: node eval/evidence-relations.smoke.ts */
import assert from "node:assert/strict";
import type { EvidenceItem, Finding } from "../lib/evidence/types.ts";
import { findFindingsForEvidence, resolveEvidenceIdsForFinding } from "../app/scan/components/evidence-relations.ts";

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
console.log("ALL-PASS (5 evidence relationship assertions)");
