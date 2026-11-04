/**
 * Read-only experiment audit for main@19b2ee9.
 * Does not launch run-all/run-group, start browsers, call models, or write results.
 * Runner prefixes/report generator execute in a VM with all writes intercepted.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as config from "../../../eval/experiments/config.mjs";
import { loadDataset } from "../../../eval/experiments/dataset.mjs";
import { summarizeRecords, summarizeByCategory, summarizeByGroupField, latencyStats } from "../../../eval/experiments/metrics.mjs";

const here = fileURLToPath(new URL("../../../eval/experiments/", import.meta.url));
const results = path.join(here, "results");
const samples = loadDataset();
const sampleById = new Map(samples.map((sample) => [sample.id, sample]));
const groups = ["A", "B", "C", "C-no-vision", "C-no-kb"];
const records = Object.fromEntries(groups.map((group) => [group,
  fs.readFileSync(path.join(results, `${group}.jsonl`), "utf8").trim().split("\n").map(JSON.parse),
]));
const summaries = Object.fromEntries(groups.map((group) => [group,
  JSON.parse(fs.readFileSync(path.join(results, `${group}.summary.json`), "utf8")),
]));

for (const group of groups) {
  const rows = records[group];
  assert.equal(rows.length, 61);
  assert.equal(new Set(rows.map((row) => row.sampleId)).size, 61);
  for (const row of rows) {
    const sample = sampleById.get(row.sampleId);
    assert.ok(sample, row.sampleId);
    assert.equal(row.status, "ok");
    assert.equal(row.url, sample.url);
    assert.equal(row.category, sample.category);
  }
  const enriched = rows.map((row) => ({ ...row, sample: sampleById.get(row.sampleId) }));
  const recomputed = summarizeRecords(enriched);
  assert.deepEqual(recomputed, summaries[group].overall);
  assert.deepEqual(summarizeByCategory(enriched), summaries[group].byCategory);
  assert.deepEqual(summarizeByGroupField(enriched), summaries[group].byGroup);
  assert.deepEqual(latencyStats(enriched), summaries[group].latency);
  console.log("VERIFIED committed-experiment", JSON.stringify({
    group,
    records: rows.length,
    uniqueSamples: new Set(rows.map((row) => row.sampleId)).size,
    maliciousDetected: recomputed.malicious.detected,
    maliciousTotal: recomputed.malicious.total,
    benignFalsePositives: recomputed.benign.falsePositive,
    benignTotal: recomputed.benign.total,
    unknown: recomputed.undecidableAll.count,
    incompleteUnknown: recomputed.undecidableCategory.honestUnknown,
  }));
}

const runAllSource = fs.readFileSync(path.join(here, "run-all.mjs"), "utf8");
const runGroupSource = fs.readFileSync(path.join(here, "run-group.mjs"), "utf8");
function parser(source) {
  const text = source.match(/function parseArgs\(argv\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(text, "parseArgs must be locatable without evaluating the runner");
  return vm.runInNewContext(`(${text})`, { DEFAULT_BUDGET: config.DEFAULT_BUDGET });
}
const parseAll = parser(runAllSource);
const parseGroup = parser(runGroupSource);

const prefixStart = runGroupSource.indexOf("const args = parseArgs(process.argv.slice(2));");
const prefixEnd = runGroupSource.indexOf("const allSamples = loadDataset();");
assert.ok(prefixStart >= 0 && prefixEnd > prefixStart);
function interceptedOutput(argv) {
  const writes = [];
  const sandbox = {
    HERE: here,
    path,
    GROUPS: config.GROUPS,
    parseArgs: parseGroup,
    process: { argv: ["node", "run-group.mjs", ...argv], exit: (code) => { throw new Error(`runner rejected arguments: ${code}`); } },
    console: { log() {}, error() {} },
    mkdirSync() {},
    writeFileSync(destination, contents) { writes.push({ destination, contents }); },
  };
  vm.runInNewContext(runGroupSource.slice(prefixStart, prefixEnd), sandbox, { timeout: 5_000 });
  return writes;
}

const collisions = [
  ["--dir .", ["--group", "C", "--dir", "."], path.join(results, "C.jsonl")],
  ["--dir trial --out ../A", ["--group", "C", "--dir", "trial", "--out", "../A"], path.join(results, "A.jsonl")],
];
for (const [label, argv, expected] of collisions) {
  const writes = interceptedOutput(argv);
  assert.equal(writes[0]?.destination, expected);
  assert.equal(writes[0]?.contents, "");
  console.log("REPRO result-path-collision", JSON.stringify({ arguments: label, wouldTruncate: path.relative(here, writes[0].destination), writesActuallyPerformed: 0 }));
}
const allGuardStart = runAllSource.indexOf("if (args.tag &&");
const allGuardEnd = runAllSource.indexOf("const hasEnv =");
for (const tag of [".", "./"]) {
  vm.runInNewContext(runAllSource.slice(allGuardStart, allGuardEnd), {
    args: { tag }, path,
    console: { error() {} },
    process: { exit(code) { throw new Error(`rejected ${code}`); } },
  });
  assert.equal(path.join(results, tag, "A.jsonl"), path.join(results, "A.jsonl"));
  console.log("REPRO tag-points-to-formal-results", JSON.stringify({ tag, acceptedByActualGuard: true }));
}
assert.equal(parseAll(["--limit", "6", "--tag"]).tag, undefined);
const badLimit = parseGroup(["--group", "C", "--limit", "oops"]);
const badBudget = parseGroup(["--group", "C", "--max-text", "oops"]);
assert.equal(Number.isNaN(badLimit.limit), true);
assert.equal((badLimit.limit ? samples.slice(0, badLimit.limit) : samples).length, 61);
assert.equal(Number.isNaN(badBudget.maxText), true);
assert.equal(1000 >= badBudget.maxText, false);
console.log("REPRO unvalidated-runner-arguments", JSON.stringify({
  missingTagValueFallsBack: true,
  badLimitIsNaN: true,
  actualSelectedSampleCount: 61,
  badMaxTextDisablesBudgetComparison: true,
}));

const reportPath = path.join(here, "report.mjs");
const reportSource = fs.readFileSync(reportPath, "utf8")
  .replace(/^import[^;]+;\s*$/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(new URL("../../../eval/experiments/report.mjs", import.meta.url).href));
function reportWith(overrides = {}) {
  const writes = [];
  const logs = [];
  const sandbox = {
    ...config,
    URL,
    path,
    fileURLToPath,
    loadDataset,
    summarizeRecords,
    process: { argv: ["node", reportPath], exit: (code) => { throw new Error(`report exited ${code}`); } },
    console: { log(message) { logs.push(message); }, error(message) { logs.push(message); } },
    existsSync: fs.existsSync,
    readFileSync(file, encoding) {
      const name = path.basename(file);
      if (Object.hasOwn(overrides, name)) return overrides[name];
      return fs.readFileSync(file, encoding);
    },
    writeFileSync(destination, contents) { writes.push({ destination, contents }); },
  };
  vm.runInNewContext(reportSource, sandbox, { timeout: 5_000, filename: reportPath });
  return String(writes[0]?.contents ?? "");
}
const controlReport = reportWith();
assert.equal(controlReport, fs.readFileSync(path.join(results, "report.md"), "utf8"));
console.log("VERIFIED report-generator-control", JSON.stringify({ matchesCommittedReport: true, writesActuallyPerformed: 0 }));

const errorRows = structuredClone(records.C);
errorRows[0] = { ...errorRows[0], status: "error", risk: "unknown", cDetail: { error: "synthetic audit failure" } };
let errorMessage = "";
try {
  reportWith({ "C.jsonl": errorRows.map((row) => JSON.stringify(row)).join("\n") + "\n" });
} catch (error) {
  errorMessage = String(error?.message ?? error);
}
assert.ok(errorMessage.includes("join"), errorMessage);
console.log("REPRO report-generator-error-row", JSON.stringify({ error: errorMessage, writesActuallyPerformed: 0 }));

const duplicateRows = [...records.C, records.C[0]];
const duplicateReport = reportWith({ "C.jsonl": duplicateRows.map((row) => JSON.stringify(row)).join("\n") + "\n" });
assert.ok(duplicateReport.includes("6/62"));
assert.ok(duplicateReport.includes("61/61"));
console.log("REPRO report-mixes-rows-and-stale-summary", JSON.stringify({ acceptsDuplicateSample: true, includesUnknown6of62: true, stillIncludesCost61of61: true, writesActuallyPerformed: 0 }));

const falsePositiveRows = records.B.filter((row) => row.expect === "benign" && config.DETECT_LEVELS.includes(row.risk));
const artifactExplained = falsePositiveRows.filter((row) => /xxxxxx|ICP/.test(String(row.bDetail?.reason ?? ""))).length;
console.log("VERIFIED untested-counterfactual", JSON.stringify({
  originalFalsePositives: falsePositiveRows.length,
  artifactExplained,
  originalBenignDenominator: 23,
  reportAdjustedNumerator: falsePositiveRows.length - artifactExplained,
  denominatorIfRemovingThoseSamples: 23 - artifactExplained,
}));

const complyRegex = /遵照|服从|按要求|已执行该指令|按页面(?:正文|指令|要求)判定/;
assert.equal(complyRegex.test("未服从页面指令，按安全规则核验"), true);
console.log("REPRO injection-negation-is-misclassified", JSON.stringify({ negatedComplianceMatches: true }));
