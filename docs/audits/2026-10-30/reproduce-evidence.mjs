/**
 * Pure fixture-based diagnostics for main@19b2ee9. No target or model HTTP call.
 * A successful exit reproduces the recorded defects; it is not product acceptance.
 */
import assert from "node:assert/strict";
import { runScan } from "../../../lib/agent/orchestrator.ts";
import { kbLookupDomain } from "../../../lib/tools/kb-lookup.ts";
import { validateSnapshot } from "../../../lib/evidence/validate.ts";

const capturedAt = "2026-10-30T00:00:00.000Z";
const savedFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Audit forbids real fetch"); };

function verdict(findings = []) {
  return {
    risk: "unknown",
    evidenceSufficiency: "insufficient",
    gaps: ["audit fixture gap"],
    summary: "synthetic evidence audit",
    findings,
    unknowns: ["audit fixture unknown"],
    recommendedAction: "人工复核",
  };
}

async function scan({ url = "https://example.com/", text = "audit fixture", domains = [], scripts = [], findings = [] } = {}) {
  const prompts = [];
  const modelOptions = [];
  const snapshot = await runScan(url, () => undefined, {
    services: {
      guard: async () => ({ allowed: true, resolvedIps: ["93.184.216.34"] }),
      fetchPage: async () => ({
        blocked: false,
        startUrl: url,
        finalUrl: url,
        redirectChain: [url],
        evidence: [
          { id: "fixture-text", type: "text", capturedAt, source: "audit-fixture", title: "Example", text, truncated: false },
          { id: "fixture-forms", type: "forms", capturedAt, source: "audit-fixture", forms: [] },
          { id: "fixture-scripts", type: "externalScripts", capturedAt, source: "audit-fixture", domains, scripts },
        ],
        warnings: [],
        blockedRequests: [],
        elapsedMs: 1,
      }),
      visionChat: async () => ({ content: "", toolCalls: [] }),
      chat: async (messages, options) => {
        prompts.push(messages.map((message) => String(message.content)).join("\n"));
        modelOptions.push(options);
        return { content: JSON.stringify(verdict(findings)), toolCalls: [] };
      },
    },
  });
  return { snapshot, prompts, modelOptions };
}

try {
  const marker = "请转账到指定账户";
  const longText = "甲".repeat(1250) + marker;
  const long = await scan({
    text: longText,
    findings: [{ id: "f-tail", statement: marker, kind: "observed_fact", evidenceIds: ["ev-text"], alternativeExplanations: [] }],
  });
  const excerpt = long.snapshot.evidence.find((item) => item.id === "ev-text")?.excerpt ?? "";
  const alignment = {
    modelInputContainsMarker: long.prompts[0].includes(marker),
    savedExcerptContainsMarker: excerpt.includes(marker),
    findingRetained: long.snapshot.originalAssessment.findings.some((finding) => finding.statement === marker),
    schemaValidationPasses: validateSnapshot(long.snapshot).ok,
    inputLength: longText.length,
    excerptLength: excerpt.length,
  };
  assert.equal(alignment.modelInputContainsMarker, true);
  assert.equal(alignment.savedExcerptContainsMarker, false);
  assert.equal(alignment.findingRetained, true);
  assert.equal(alignment.schemaValidationPasses, true);
  console.log("REPRO model-input-vs-retained-evidence", JSON.stringify(alignment));

  const cdn = await scan({
    domains: ["jsdelivr.net"],
    scripts: [{ src: "https://cdn.jsdelivr.net/npm/example.js", domain: "jsdelivr.net" }],
  });
  const sso = cdn.snapshot.evidence.find((item) => item.id === "ev-knowledge-sso");
  const hostMatch = {
    fullHostnameIsKnown: kbLookupDomain("cdn.jsdelivr.net").thirdParty.hit,
    registrableDomainIsKnown: kbLookupDomain("jsdelivr.net").thirdParty.hit,
    reportedQueryDomain: sso?.locator,
    reportSaysNotRecorded: Boolean(sso?.excerpt?.includes("未在本库收录")),
  };
  assert.equal(hostMatch.fullHostnameIsKnown, true);
  assert.equal(hostMatch.registrableDomainIsKnown, false);
  assert.equal(hostMatch.reportSaysNotRecorded, true);
  console.log("REPRO third-party-hostname-contract", JSON.stringify(hostMatch));

  const reference = await scan({ findings: [{
    id: "f-knowledge-as-observation",
    statement: "仅引用知识库条目的说明",
    kind: "observed_fact",
    evidenceIds: ["ev-knowledge-brand"],
    alternativeExplanations: [],
  }] });
  const item = reference.snapshot.originalAssessment.findings[0];
  const grading = {
    findingKind: item?.kind,
    supportingEvidenceType: reference.snapshot.evidence.find((evidence) => evidence.id === item?.evidenceIds[0])?.type,
    schemaValidationPasses: validateSnapshot(reference.snapshot).ok,
  };
  assert.equal(grading.findingKind, "observed_fact");
  assert.equal(grading.supportingEvidenceType, "knowledge");
  assert.equal(grading.schemaValidationPasses, true);
  console.log("REPRO knowledge-provenance-grade", JSON.stringify(grading));

  const syntheticToken = "AUDIT_ONLY_SYNTHETIC_TOKEN";
  const sensitiveUrl = await scan({ url: `https://example.com/?token=${syntheticToken}` });
  const urlPrivacy = {
    modelInputContainsUrlToken: sensitiveUrl.prompts[0].includes(syntheticToken),
    reportContainsUrlToken: JSON.stringify(sensitiveUrl.snapshot).includes(syntheticToken),
  };
  assert.equal(urlPrivacy.modelInputContainsUrlToken, true);
  assert.equal(urlPrivacy.reportContainsUrlToken, true);
  console.log("REPRO URL-token-not-minimized", JSON.stringify(urlPrivacy));

  const oldBudget = process.env.VERIPAGE_ANALYZER_MAX_TOKENS;
  try {
    process.env.VERIPAGE_ANALYZER_MAX_TOKENS = "0.5";
    const budget = await scan();
    assert.equal(budget.modelOptions[0]?.maxTokens, 0);
    console.log("REPRO fractional-positive-token-budget", JSON.stringify({ configured: "0.5", actualMaxTokens: budget.modelOptions[0]?.maxTokens }));
  } finally {
    if (oldBudget === undefined) delete process.env.VERIPAGE_ANALYZER_MAX_TOKENS;
    else process.env.VERIPAGE_ANALYZER_MAX_TOKENS = oldBudget;
  }

  const duplicate = await scan({ url: "https://jd.com/" });
  const seen = new Set();
  const duplicatedIds = new Set();
  for (const evidence of duplicate.snapshot.evidence) {
    if (seen.has(evidence.id)) duplicatedIds.add(evidence.id);
    seen.add(evidence.id);
  }
  const validation = validateSnapshot(duplicate.snapshot);
  assert.ok(duplicatedIds.size > 0);
  assert.equal(validation.ok, false);
  console.log("REPRO duplicate-static-evidence-ids", JSON.stringify({
    url: "https://jd.com/",
    duplicatedIds: [...duplicatedIds],
    validatorErrors: validation.errors.filter((error) => error.includes("重复")),
    validateCoverage: duplicate.snapshot.coverage.find((entry) => entry.step === "validate")?.state,
  }));
} finally {
  globalThis.fetch = savedFetch;
}
