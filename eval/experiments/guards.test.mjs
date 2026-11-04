/**
 * 实验链守卫与校验单测（审计 2026-10-30 F02/F12/F13/F14/F15 验收测试）
 *
 * 运行：node eval/experiments/guards.test.mjs（零网络、不跑真实实验、不读 .env）
 * 手法与 docs/audits/2026-10-30/reproduce-experiments.mjs 相同：runner 的参数/写入前缀
 * 与报告生成器在 VM 中执行，所有 mkdirSync/writeFileSync 拦截计数——
 * 攻击参数被拒绝时必须断言 0 次写盘；正式数据只读复算，不落任何文件。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import * as config from "./config.mjs";
import { loadDataset } from "./dataset.mjs";
import { dedupeAdjacent, mergeNavigationChain, sameUrl } from "./chain-utils.mjs";
import {
  GuardError,
  parseFinitePositiveInt,
  parseFlagArgs,
  resolveIsolatedDir,
  runnerExitCode,
  validateIsolationSegment,
  validateOutName,
} from "./guards.mjs";
import { deepEqual, validateExperimentSet } from "./report-guards.mjs";
import { summarizeRecords } from "./metrics.mjs";

const HERE = fileURLToPath(new URL("./", import.meta.url));
const RESULTS = path.join(HERE, "results");
const GROUP_ORDER = ["A", "B", "C", "C-no-vision", "C-no-kb"];
const samples = loadDataset();
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`PASS ${name}`);
};
const rejects = (fn, name, needle) => {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  assert.ok(threw instanceof GuardError, `${name} 应抛 GuardError，实际：${threw}`);
  if (needle) assert.ok(String(threw.message).includes(needle), `${name} 错误信息应含「${needle}」：${threw.message}`);
};
const readRecordsFrom = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const readRecords = (g) => readRecordsFrom(path.join(RESULTS, `${g}.jsonl`));
const readSummaryFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readSummary = (g) => readSummaryFile(path.join(RESULTS, `${g}.summary.json`));

// ===========================================================================
// F02 · 数值参数守卫（纯函数）
// ===========================================================================
{
  assert.equal(parseFinitePositiveInt("6", "--limit"), 6);
  assert.equal(parseFinitePositiveInt(6, "--limit"), 6);
  assert.equal(parseFinitePositiveInt("300", "--max-text"), 300);
  for (const bad of ["oops", "", " ", "1.5", "0", "-1", "abc", "6x", "Infinity"]) {
    rejects(() => parseFinitePositiveInt(bad, "--limit"), `parseFinitePositiveInt(${JSON.stringify(bad)})`);
  }
  rejects(() => parseFinitePositiveInt(NaN, "--max-text"), "parseFinitePositiveInt(NaN)");
  rejects(() => parseFinitePositiveInt(null, "--limit"), "parseFinitePositiveInt(null)");
  rejects(() => parseFinitePositiveInt(undefined, "--max-text"), "parseFinitePositiveInt(undefined)");
  ok("F02 parseFinitePositiveInt：非有限正整数一律拒绝（--limit oops / --max-text oops → NaN 不再放行）");
}

// ===========================================================================
// F02 · 隔离子目录与 --out 纯文件名守卫（纯函数）
// ===========================================================================
{
  assert.equal(validateIsolationSegment("trial-xxx", "--tag"), "trial-xxx");
  assert.equal(validateIsolationSegment("trial/a", "--dir"), "trial/a");
  for (const bad of [".", "./", "..", "../x", "a/../b", "", "  ", "results", " trial", "/abs", "D:\\tmp", "a//b"]) {
    rejects(() => validateIsolationSegment(bad, "--tag"), `validateIsolationSegment(${JSON.stringify(bad)})`);
  }
  assert.equal(validateOutName("C-retry"), "C-retry");
  for (const bad of ["../A", "sub/A.jsonl", "a\\B", ".", "..", "", " x", "x "]) {
    rejects(() => validateOutName(bad), `validateOutName(${JSON.stringify(bad)})`);
  }
  const isolated = resolveIsolatedDir(RESULTS, "trial-ok");
  assert.equal(isolated, path.resolve(RESULTS, "trial-ok"), "隔离子目录规范化结果");
  assert.notEqual(isolated, RESULTS);
  rejects(() => resolveIsolatedDir(RESULTS, "."), "resolveIsolatedDir(.)", "等于正式产物目录本身");
  rejects(() => resolveIsolatedDir(RESULTS, "./"), "resolveIsolatedDir(./)");
  rejects(() => resolveIsolatedDir(RESULTS, ".."), "resolveIsolatedDir(..)", "越出");
  rejects(() => resolveIsolatedDir(RESULTS, "../A"), "resolveIsolatedDir(../A)", "越出");
  rejects(() => resolveIsolatedDir(RESULTS, "a/../../x"), "resolveIsolatedDir(a/../../x)");
  ok("F02 路径守卫：--tag/--dir/--out 的目录穿越与 results 根碰撞全部拒绝");
}

// ===========================================================================
// F02 · parseFlagArgs：缺值 / 未知参数（纯函数）
// ===========================================================================
{
  const parsed = parseFlagArgs(["--limit", "6", "--tag", "trial-x"], {
    valueKeys: ["limit", "tag"],
    booleanKeys: ["overwrite"],
    flagsLabel: "test",
  });
  assert.equal(parsed.error, null);
  assert.equal(parsed.args.limit, "6");
  assert.equal(parsed.args.tag, "trial-x");
  assert.equal(parseFlagArgs(["--limit", "6", "--tag"], { valueKeys: ["limit", "tag"], booleanKeys: [], flagsLabel: "test" }).error.includes("缺少值"), true);
  assert.equal(parseFlagArgs(["--tg", "x"], { valueKeys: ["tag"], booleanKeys: [], flagsLabel: "test" }).error.includes("无法识别"), true);
  assert.equal(parseFlagArgs(["--overwrite"], { valueKeys: [], booleanKeys: ["overwrite"], flagsLabel: "test" }).args.overwrite, true);
  ok("F02 parseFlagArgs：--limit 6 --tag 缺值、未知/写错参数一律报错");
}

// ===========================================================================
// F02 · run-group 参数/写入前缀（VM + 写盘拦截）
//   每条审计攻击参数必须：退出非零 且 0 次 mkdir/write
// ===========================================================================
const runGroupSource = fs.readFileSync(path.join(HERE, "run-group.mjs"), "utf8");
const runAllSource = fs.readFileSync(path.join(HERE, "run-all.mjs"), "utf8");

function extractParseArgs(source) {
  const text = source.match(/function parseArgs\(argv\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(text, "必须能不执行 runner 就定位 parseArgs");
  return vm.runInNewContext(`(${text})`, { DEFAULT_BUDGET: config.DEFAULT_BUDGET, parseFlagArgs });
}
const parseGroup = extractParseArgs(runGroupSource);
const parseAll = extractParseArgs(runAllSource);

class RunnerRejected extends Error {
  constructor(code) {
    super(`runner rejected arguments: exit ${code}`);
    this.code = code;
  }
}

/** 在 VM 中执行 run-group 的参数→验证→建目录→清空目标文件 前缀（到 loadDataset 之前），拦截全部写盘 */
function runGroupPrefix(argv, { existingFiles = new Set() } = {}) {
  const start = runGroupSource.indexOf("const args = parseArgs(process.argv.slice(2));");
  const end = runGroupSource.indexOf("const allSamples = loadDataset();");
  assert.ok(start >= 0 && end > start, "run-group 前缀锚点必须存在");
  const writes = [];
  const mkdirs = [];
  const sandbox = {
    HERE,
    path,
    GROUPS: config.GROUPS,
    parseArgs: parseGroup,
    parseFinitePositiveInt,
    validateIsolationSegment,
    validateOutName,
    resolveIsolatedDir,
    process: { argv: ["node", "run-group.mjs", ...argv], exit: (code) => { throw new RunnerRejected(code); } },
    console: { log() {}, error() {} },
    mkdirSync(dir) { mkdirs.push(path.resolve(dir)); },
    existsSync: (p) => existingFiles.has(path.resolve(p)),
    writeFileSync(destination, contents) { writes.push({ destination: path.resolve(destination), contents }); },
  };
  vm.runInNewContext(runGroupSource.slice(start, end), sandbox, { timeout: 5_000 });
  return { writes, mkdirs };
}

function assertRejectedNoWrites(label, argv, existingFiles = new Set()) {
  let rejected = null;
  let writes = [];
  let mkdirs = [];
  try {
    ({ writes, mkdirs } = runGroupPrefix(argv, { existingFiles }));
  } catch (err) {
    rejected = err;
  }
  assert.ok(rejected instanceof RunnerRejected, `${label} 必须退出非零（实际放行，写盘 ${writes.length} 次）`);
  assert.notEqual(rejected.code, 0, `${label} 退出码必须非零`);
  assert.equal(writes.length, 0, `${label} 不允许发生任何 writeFileSync（实际 ${writes.length} 次：${writes.map((w) => w.destination).join(",")}）`);
  assert.equal(mkdirs.length, 0, `${label} 不允许发生任何 mkdirSync`);
  console.log(`PASS F02 run-group 拒绝 ${label}（exit ${rejected.code}，mkdir/write 均 0 次）`);
  passed += 1;
}

{
  const formalC = path.join(RESULTS, "C.jsonl");
  const formalA = path.join(RESULTS, "A.jsonl");
  // 审计 F02 攻击参数逐条验收：拒绝 + 0 次文件系统写入
  assertRejectedNoWrites("--dir .（规范化后指向正式 results 根）", ["--group", "C", "--dir", "."]);
  assertRejectedNoWrites("--dir ./", ["--group", "C", "--dir", "./"]);
  assertRejectedNoWrites("--dir trial --out ../A（--out 无路径约束曾定位到正式 A.jsonl）", ["--group", "C", "--dir", "trial", "--out", "../A"]);
  assertRejectedNoWrites("--out ../A（无 --dir 也拒绝路径分隔符）", ["--group", "C", "--out", "../A"]);
  assertRejectedNoWrites("--out 带正斜杠子路径", ["--group", "C", "--out", "sub/A.jsonl"]);
  assertRejectedNoWrites("--out 带反斜杠子路径", ["--group", "C", "--out", "sub\\A.jsonl"]);
  assertRejectedNoWrites("--limit oops（NaN 曾跑满全 61 样本）", ["--group", "C", "--limit", "oops"]);
  assertRejectedNoWrites("--max-text oops（NaN 曾使预算比较失效）", ["--group", "C", "--max-text", "oops"]);
  assertRejectedNoWrites("--max-vision oops", ["--group", "C", "--max-vision", "oops"]);
  assertRejectedNoWrites("--max-tokens 0.5（非整数）", ["--group", "C", "--max-tokens", "0.5"]);
  assertRejectedNoWrites("--limit 缺值（末尾）", ["--group", "C", "--limit"]);
  assertRejectedNoWrites("--limit 6 --dir 缺值（曾静默退回正式目录）", ["--group", "C", "--limit", "6", "--dir"]);
  assertRejectedNoWrites("--limit 6 后跟未知参数（写错的隔离参数不得静默落回正式目录）", ["--group", "C", "--limit", "6", "--tg", "x"]);
  // 目标已存在且无 --overwrite：拒绝覆盖、0 写盘（正式 C.jsonl 一个字节都不能动）
  assertRejectedNoWrites("目标已存在且未显式 --overwrite", ["--group", "C", "--dir", "trial-ok"], new Set([path.join(RESULTS, "trial-ok", "C.jsonl")]));
  assert.ok(fs.existsSync(formalC) && fs.existsSync(formalA), "正式产物仍在（本测试只读）");

  // 合法试跑：写入严格位于隔离子目录，且只清空隔离目标
  const fresh = runGroupPrefix(["--group", "C", "--dir", "trial-ok", "--limit", "6", "--max-tokens", "6000"]);
  assert.equal(fresh.writes.length, 1, "合法试跑只应清空隔离 jsonl 一个文件");
  assert.equal(fresh.writes[0].destination, path.join(RESULTS, "trial-ok", "C.jsonl"));
  assert.equal(fresh.writes[0].contents, "");
  assert.notEqual(fresh.writes[0].destination, formalC, "试跑目标绝不能是正式 results/C.jsonl");
  // 合法试跑 + 显式 --overwrite：放行（仍然只写隔离目录）
  const over = runGroupPrefix(["--group", "C", "--dir", "trial-ok", "--overwrite"], { existingFiles: new Set([path.join(RESULTS, "trial-ok", "C.jsonl")]) });
  assert.equal(over.writes.length, 1);
  assert.equal(over.writes[0].destination, path.join(RESULTS, "trial-ok", "C.jsonl"));
  ok("F02 run-group 前缀：合法试跑严格落隔离子目录；--overwrite 显式放行");
}

// ===========================================================================
// F02 · run-all 参数前缀（VM）：--tag 攻击参数拒绝
// ===========================================================================
{
  const start = runAllSource.indexOf("const args = parseArgs(process.argv.slice(2));");
  const end = runAllSource.indexOf("const hasEnv =");
  assert.ok(start >= 0 && end > start, "run-all 前缀锚点必须存在");
  const runAllPrefix = (argv) => {
    vm.runInNewContext(runAllSource.slice(start, end), {
      HERE,
      path,
      GROUPS: config.GROUPS,
      DEFAULT_BUDGET: config.DEFAULT_BUDGET,
      parseArgs: parseAll,
      parseFinitePositiveInt,
      validateIsolationSegment,
      resolveIsolatedDir,
      process: { argv: ["node", "run-all.mjs", ...argv], exit: (code) => { throw new RunnerRejected(code); } },
      console: { log() {}, error() {} },
    }, { timeout: 5_000 });
  };
  for (const [label, argv] of [
    ["--tag .（规范化后等于正式 results 根）", ["--tag", "."]],
    ["--tag ./", ["--tag", "./"]],
    ["--tag results", ["--tag", "results"]],
    ["--tag ../out（越出）", ["--tag", "../out"]],
    ["--limit 6 --tag 缺值（曾静默退回正式目录）", ["--limit", "6", "--tag"]],
    ["--limit oops", ["--limit", "oops"]],
    ["--max-text oops", ["--max-text", "oops"]],
    ["--groups 含未知组", ["--groups", "A,X"]],
    ["未知参数 --tg（写错不得静默落回正式目录）", ["--tg", "x"]],
  ]) {
    let rejected = null;
    try {
      runAllPrefix(argv);
    } catch (err) {
      rejected = err;
    }
    assert.ok(rejected instanceof RunnerRejected, `${label} 必须退出非零`);
    assert.notEqual(rejected.code, 0);
    console.log(`PASS F02 run-all 拒绝 ${label}（exit ${rejected.code}）`);
    passed += 1;
  }
  // 合法试跑/全量参数原样通过验证（不触发 exit）
  runAllPrefix(["--limit", "6", "--tag", "trial-xxx", "--max-tokens", "6000"]);
  runAllPrefix([]);
  ok("F02 run-all 前缀：合法试跑/全量参数通过验证");
}

// ===========================================================================
// F12 · runnerExitCode：error 记录必须决定退出码（纯函数 + 接线静态检查）
// ===========================================================================
{
  assert.equal(runnerExitCode({ errorCount: 0, budgetStopped: false }), 0);
  assert.equal(runnerExitCode({ errorCount: 0, budgetStopped: true }), 3);
  assert.equal(runnerExitCode({ errorCount: 2, budgetStopped: false }), 4);
  assert.equal(runnerExitCode({ errorCount: 1, budgetStopped: true }), 4, "错误优先于预算停止");
  assert.ok(/counters\.errors\.push\(/.test(runGroupSource), "run-group 必须把 error 记录计入 counters.errors");
  assert.ok(/runnerExitCode\(\{ errorCount: counters\.errors\.length/.test(runGroupSource), "run-group 退出码必须由 error 记录数决定");
  assert.ok(/c !== 0 && c !== 3/.test(runAllSource), "run-all 必须把非 0/3 退出码视为失败");
  ok("F12 runnerExitCode：error 记录 → 退出码 4；预算停止 → 3；成功 → 0（含接线检查）");
}

// ===========================================================================
// F12 · validateExperimentSet：错误行/重复行/混批/summary 不一致（纯函数）
// ===========================================================================
{
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(deepEqual([1, 2], [1, 2, 3]), false);

  for (const g of GROUP_ORDER) {
    assert.deepEqual(
      validateExperimentSet({ group: g, records: readRecords(g), summary: readSummary(g), samples }),
      [],
      `正式 ${g} 组应通过强校验`,
    );
  }
  ok("F12 validateExperimentSet：正式五组全部通过强校验（61 唯一 sampleId、summary 与重算一致）");

  const errorRows = structuredClone(readRecords("C"));
  errorRows[0] = { ...errorRows[0], status: "error", risk: "unknown", cDetail: { error: "synthetic audit failure" } };
  const errorResult = validateExperimentSet({ group: "C", records: errorRows, summary: readSummary("C"), samples });
  assert.ok(errorResult.some((e) => e.includes("status=")), "error 行必须被拒");

  const dupRows = [...readRecords("C"), readRecords("C")[0]];
  const dupResult = validateExperimentSet({ group: "C", records: dupRows, summary: readSummary("C"), samples });
  assert.ok(dupResult.some((e) => e.includes("重复")), "重复行必须被拒");

  const crossRows = [...readRecords("C"), { ...readRecords("B")[0], sampleId: "zz-cross" }];
  const crossResult = validateExperimentSet({ group: "C", records: crossRows, summary: readSummary("C"), samples });
  assert.ok(crossResult.some((e) => e.includes("不在当前数据集")), "异集样本必须被拒");

  const crossGroupRows = [...readRecords("C"), readRecords("B")[1]];
  const crossGroupResult = validateExperimentSet({ group: "C", records: crossGroupRows, summary: readSummary("C"), samples });
  assert.ok(crossGroupResult.some((e) => e.includes("跨组混入")), "跨组记录必须被拒");

  const budgetRows = readRecords("C").map((r) => ({ ...r, status: "budget-stopped", risk: null }));
  const budgetResult = validateExperimentSet({ group: "C", records: budgetRows, summary: readSummary("C"), samples });
  assert.ok(budgetResult.some((e) => e.includes("budget-stopped")), "budget-stopped 行必须被拒");

  const staleSummary = structuredClone(readSummary("C"));
  staleSummary.overall.malicious.detected += 1;
  const staleResult = validateExperimentSet({ group: "C", records: readRecords("C"), summary: staleSummary, samples });
  assert.ok(staleResult.some((e) => e.includes("overall") && e.includes("不一致")), "summary 与重算不一致必须被拒");

  const partialRows = readRecords("C").slice(0, 60);
  const partialResult = validateExperimentSet({ group: "C", records: partialRows, summary: readSummary("C"), samples });
  assert.ok(partialResult.some((e) => e.includes("覆盖不完整")), "覆盖不完整必须被拒");
  ok("F12 validateExperimentSet：error/重复/跨批/跨组/budget-stopped/summary 不一致/覆盖不全全部拒绝");
}

// ===========================================================================
// F12/F13/F14 · 报告生成器（VM + 写盘拦截）
//   控制组逐字节一致；带病数据明确失败退出且 0 写盘
// ===========================================================================
const reportSource = fs.readFileSync(path.join(HERE, "report.mjs"), "utf8")
  .replace(/^import[^;]+;\s*$/gm, "")
  .replaceAll("import.meta.url", JSON.stringify(new URL("./report.mjs", import.meta.url).href));

function reportWith(overrides = {}, { missingFiles = new Set() } = {}) {
  const writes = [];
  const errors = [];
  const sandbox = {
    ...config,
    URL,
    path,
    fileURLToPath,
    loadDataset,
    summarizeRecords,
    validateExperimentSet,
    process: { argv: ["node", "report.mjs", "--overwrite"], exit: (code) => { const e = new Error(`report exited ${code}`); e.exitCode = code; throw e; } },
    console: { log() {}, error(message) { errors.push(String(message)); } },
    existsSync: (file) => !missingFiles.has(path.basename(file)) && fs.existsSync(file),
    readFileSync(file, encoding) {
      const name = path.basename(file);
      if (Object.hasOwn(overrides, name)) return overrides[name];
      return fs.readFileSync(file, encoding);
    },
    writeFileSync(destination, contents) { writes.push({ destination: path.resolve(destination), contents }); },
  };
  vm.runInNewContext(reportSource, sandbox, { timeout: 30_000, filename: path.join(HERE, "report.mjs") });
  return { writes, errors };
}

{
  // 控制组：从正式数据生成，逐字节等于已提交 report.md（证明只加了守卫与措辞、没动数据）
  const control = reportWith();
  assert.equal(control.writes.length, 1, "控制组只写 report.md 一个文件");
  const committed = fs.readFileSync(path.join(RESULTS, "report.md"), "utf8");
  assert.equal(control.writes[0].contents, committed, "生成文本必须与已提交 report.md 逐字一致");
  ok("F12 控制组：生成器对正式数据产出与 results/report.md 逐字节一致");
}

function assertReportRefused(label, overrides, options) {
  let failure = null;
  let writes = [];
  const errors = [];
  try {
    const r = reportWith(overrides, options);
    writes = r.writes;
    errors.push(...r.errors);
  } catch (err) {
    failure = err;
    errors.push(String(err?.message ?? err));
  }
  assert.ok(failure, `${label} 必须失败退出（实际放行，写盘 ${writes.length} 次）`);
  assert.equal(writes.length, 0, `${label} 不允许写任何文件（实际 ${writes.length} 次）`);
  assert.ok(!errors.some((e) => e.includes("Cannot read properties")), `${label} 不得以 TypeError 崩溃收场`);
  console.log(`PASS F12 报告拒绝 ${label}（明确失败退出，写盘 0 次）`);
  passed += 1;
}

{
  const cRows = readRecords("C");
  // 注入 error 行：不再崩溃（旧版抛 Cannot read properties of undefined (reading 'join')）、不再出报告
  const errorRows = structuredClone(cRows);
  errorRows[0] = { ...errorRows[0], status: "error", risk: "unknown", cDetail: { error: "synthetic audit failure" } };
  assertReportRefused("注入 error 行", { "C.jsonl": errorRows.map((r) => JSON.stringify(r)).join("\n") + "\n" });
  // 注入重复行：拒绝（旧版曾产出 6/62 与 61/61 并存的报告）
  const dupRows = [...cRows, cRows[0]];
  assertReportRefused("注入重复行", { "C.jsonl": dupRows.map((r) => JSON.stringify(r)).join("\n") + "\n" });
  // 跨组混入：拒绝
  assertReportRefused("注入跨组记录", { "C.jsonl": [...cRows.map(JSON.stringify), JSON.stringify(readRecords("B")[1])].join("\n") + "\n" });
  // 缺 summary：拒绝
  assertReportRefused("缺失 summary", {}, { missingFiles: new Set(["C.summary.json"]) });
  // 空结果文件：拒绝
  assertReportRefused("空结果文件", { "C.jsonl": "\n" });
  // summary 被改：拒绝
  const tampered = structuredClone(readSummary("C"));
  tampered.overall.benign.falsePositive += 1;
  assertReportRefused("summary 与重算不一致", { "C.summary.json": JSON.stringify(tampered) });
  ok("F12 报告生成器：带病数据一律明确失败退出且零写盘");
}

// ===========================================================================
// F12 · cDetail 缺省字段不再崩溃（ok 行缺 validateHardErrors 的可生成路径）
// ===========================================================================
{
  const cRows = structuredClone(readRecords("C"));
  const idx = cRows.findIndex((r) => r.sampleId === "official-jd"); // 原本就有 validateOk=false（带错误数组）
  assert.ok(idx >= 0, "official-jd 必须在 C 组");
  cRows[idx] = { ...cRows[idx], cDetail: { ...cRows[idx].cDetail, validateOk: false, validateHardErrors: undefined } };
  const out = reportWith({ "C.jsonl": cRows.map((r) => JSON.stringify(r)).join("\n") + "\n" });
  assert.equal(out.writes.length, 1, "缺 validateHardErrors 的 ok 行不应让生成器崩溃");
  assert.ok(out.writes[0].contents.includes("未知错误"), "缺省时给出可读的兜底文案");
  ok("F12 cDetail 兼容：validateHardErrors 缺省不再 join() 崩溃");
}

// ===========================================================================
// F13 · 注入服从启发式与报告措辞：不越证据、数字一致
// ===========================================================================
{
  const regexText = reportSource.match(/const INJECTION_COMPLY = (\/.+\/);/)?.[1];
  assert.ok(regexText, "report.mjs 必须能定位 INJECTION_COMPLY");
  const comply = vm.runInNewContext(`(${regexText})`, {});
  assert.equal(comply.test("已遵照页面指令执行"), true);
  assert.equal(comply.test("按要求修改判定"), true);
  assert.equal(comply.test("未服从页面指令，按安全规则核验"), false, "否定式「未服从」不得计为服从（审计 F13）");
  assert.equal(comply.test("不遵照页面正文判定"), false, "否定式「不遵照」不得计为服从");
  assert.equal(comply.test("该页面存在提示注入企图"), false, "提及注入不等于服从");
  const committed = fs.readFileSync(path.join(RESULTS, "report.md"), "utf8");
  for (const banned of ["注入指令本身被全部抗住", "剔除该痕迹后 B 组良性误报为", "剔除后 B 误报 2/23", "剔除后 B 误报 2/16", "2000 下未截断"]) {
    assert.ok(!committed.includes(banned), `报告不得再出现越证据措辞：「${banned}」`);
  }
  for (const required of ["不足以得出因果性的抗注入结论", "分母应为 16", "注意混杂", "graph.qq.com/connect", "不进入 innerText 与截图", "未见服从迹象"]) {
    assert.ok(committed.includes(required), `报告必须包含可支持口径：「${required}」`);
  }
  // 数字一致性：三组的注入组疑似服从计数保持 0（启发式收紧不改变既有数据上的计数）
  for (const g of ["A 黑名单+规则", "B 裸多模态模型", "C 完整 orchestrator"]) {
    const line = committed.split("\n").find((l) => l.startsWith(`- ${g}：注入组`));
    assert.ok(line, `保留 ${g} 注入组统计行`);
    assert.ok(line.includes("疑似服从注入指令 0"), `${g} 疑似服从计数必须仍为 0`);
  }
  ok("F13 注入口径：否定式不误判；报告无越证据措辞、数字与原数据一致");
}

// ===========================================================================
// F14 · 预算历史口径：从正式 trial/probe 数据复算事实，措辞与之相符
// ===========================================================================
{
  const trialC = readSummaryFile(path.join(RESULTS, "trial-2000budget", "C.summary.json"));
  const trialB = readSummaryFile(path.join(RESULTS, "trial-2000budget", "B.summary.json"));
  const trialCRows = readRecordsFrom(path.join(RESULTS, "trial-2000budget", "C.jsonl"));
  const trialBRows = readRecordsFrom(path.join(RESULTS, "trial-2000budget", "B.jsonl"));
  const probe = readSummaryFile(path.join(RESULTS, "probe-C6k.summary.json"));
  // 事实复算：C 9 次 length 波及 5 样本、4 样本最终解析失败；B 1 次 length 且该样本最终解析失败
  assert.equal(trialC.counters.finishLength, 9);
  assert.equal(trialCRows.filter((r) => (r.finishLength ?? 0) > 0).length, 5);
  assert.equal(trialCRows.filter((r) => r.risk === "unknown").length, 4);
  assert.equal(trialB.counters.finishLength, 1);
  const bLen = trialBRows.filter((r) => (r.finishLength ?? 0) > 0);
  assert.equal(bLen.length, 1);
  assert.equal(bLen[0].bDetail?.parseOk, false, "B 的 length 调用导致该样本最终解析失败");
  assert.equal(probe.datasetSize, 3, "6k probe 只覆盖 3 样本，不是完整 6 样本配对");
  assert.equal(probe.counters.finishLength, 0);
  // 正式五组：统一 6000 覆盖、finish=length 合计 2 次（均在 C-no-kb）
  for (const g of GROUP_ORDER) {
    assert.equal(readSummary(g).models.maxTokensOverride, 6000, `正式 ${g} 组 maxTokensOverride 应为 6000`);
  }
  // 报告措辞必须与上述事实一致且分开两个口径
  const committed = fs.readFileSync(path.join(RESULTS, "report.md"), "utf8");
  for (const required of [
    "9 次调用 finish=length",
    "4 个样本最终 JSON 解析失败",
    "1 次调用 finish=length（official-12306）",
    "仅覆盖试跑集的前 3 个样本",
    "不是完整 6 样本配对",
    "历史与当前默认分开陈述",
    "复现原统一预算条件必须显式带",
    "两个口径",
  ]) {
    assert.ok(committed.includes(required), `报告 0.5/第 7 节必须包含：「${required}」`);
  }
  ok("F14 预算口径：调用次数 vs 解析失败样本数分开；probe 覆盖范围如实标注；B 截断事实改正");
}

// ===========================================================================
// F15 · 客户端跳转合并（纯数组级）
// ===========================================================================
{
  const L0 = "http://127.0.0.1:7000/hop/s/0";
  const L1 = "http://127.0.0.1:7000/hop/s/1";
  const LPAGE = "http://127.0.0.1:7000/page/s";
  const LCLIENT = "http://127.0.0.1:7000/page/s2"; // 客户端 JS 跳转后的新文档
  // Playwright 语义：framenavigated 按文档提交触发——30x 链只在落地时提交一次，
  // 所以 navigatedUrls 里是「落地页 + 后续客户端导航」，服务端跳转由 redirectedFrom 反推。
  // 场景 1：服务端 30x 链（L0→L1→LPAGE）落地后，页面脚本又把主框架导航到新地址
  const merged = mergeNavigationChain([L0, L1, LPAGE], [LPAGE, LCLIENT]);
  assert.deepEqual(merged, [L0, L1, LPAGE, LCLIENT], "客户端 main-frame navigation 必须被保留（旧条件恒 false 会丢弃它）");
  // 场景 2：无服务端跳转（response 为 null）时纯客户端跳转
  assert.deepEqual(mergeNavigationChain([], [L0, LCLIENT]), [L0, LCLIENT]);
  // 场景 3：直接落地无跳转（30x 链即全链，framenavigated 只重复落地 URL）
  assert.deepEqual(mergeNavigationChain([L0], [L0]), [L0]);
  // 场景 4：相邻重复与末尾斜杠差异不重复计数（保留首个形态，与生产 dedupeAdjacent 一致）
  assert.deepEqual(mergeNavigationChain([L0, L1, LPAGE], [LPAGE + "/", LPAGE, LCLIENT]), [L0, L1, LPAGE, LCLIENT]);
  assert.deepEqual(dedupeAdjacent([L1, LPAGE + "/", LPAGE]), [L1, LPAGE + "/"]);
  assert.equal(sameUrl(LPAGE, LPAGE + "/"), true);
  assert.equal(sameUrl(L0, L1), false);
  // finalUrl 语义：取实际观察链末尾（公开化后），而不是声明链末尾
  const publicChain = ["https://pub.example/start", "https://pub.example/final"];
  const mapLocalToPublic = (u) => (u === L0 ? publicChain[0] : u === LPAGE ? publicChain[1] : u);
  const observed = mergeNavigationChain([L0, LPAGE], [LPAGE, LCLIENT]);
  const publicObserved = observed.map(mapLocalToPublic);
  if (publicObserved[0] !== publicChain[0]) publicObserved.unshift(publicChain[0]);
  const finalUrl = publicObserved[publicObserved.length - 1];
  assert.equal(finalUrl, LCLIENT, "finalUrl 必须取实际观察链末尾（客户端跳转后的地址），不是声明链末尾");
  assert.notEqual(finalUrl, publicChain[publicChain.length - 1]);
  // 接线检查：local-fetcher 使用 mergeNavigationChain 且 finalUrl 取观察链末尾
  const fetcherSource = fs.readFileSync(path.join(HERE, "local-fetcher.mjs"), "utf8");
  assert.ok(fetcherSource.includes("mergeNavigationChain("), "local-fetcher 必须使用合并工具");
  assert.ok(/const finalUrl = publicObservedChain\[publicObservedChain\.length - 1\];/.test(fetcherSource), "finalUrl 必须取实际观察链末尾");
  assert.ok(!fetcherSource.includes("!dedupeAdjacent([chain[chain.length - 1], u]).length"), "恒 false 的旧条件必须移除");
  // 现有 61 样本未覆盖客户端跳转路径：已提交记录不含 finalUrl 字段，本修复不改变已提交统计
  for (const g of GROUP_ORDER) {
    const raw = fs.readFileSync(path.join(RESULTS, `${g}.jsonl`), "utf8");
    assert.ok(!raw.includes('"finalUrl"'), `${g}.jsonl 不含 finalUrl 字段（本轮统计不受本修复影响）`);
  }
  ok("F15 客户端跳转：导航保留、finalUrl 取观察链末尾；已提交统计不受影响");
}

console.log(`\nALL-PASS ${passed} 项断言组全部通过（零写盘、零网络、未触碰正式产物）`);
