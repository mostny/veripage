/**
 * W3 对照实验 · 单组运行器
 *
 * 用法：
 *   node --env-file=.env eval/experiments/run-group.mjs --group C [--limit N] [--dir 子目录] [--out NAME]
 *       [--max-text 300] [--max-vision 100] [--max-tokens 6000] [--overwrite]
 *
 * 五个组：
 *   A          黑名单 + 闸门①静态规则（不调模型、不访问页面）
 *   B          裸多模态模型（截图 + 正文直接问是否钓鱼）
 *   C          完整 orchestrator（本地 fetcher + guard 放行桩 + 真模型 + 真知识库）
 *   C-no-vision 消融·去视觉（fetcher 不产出截图 → 视觉闸自然 skipped）
 *   C-no-kb    消融·去知识库（注入恒不命中的 kbLookup/ragSearch 桩）
 *
 * 纪律：
 * - 结果逐样本增量落盘 results/<out>.jsonl（崩了也能从断点续看）；
 * - 单组预算：默认 300 文本 + 100 视觉调用，超限即停该组并如实记录；
 * - 实时打印模型调用计数；所有判定阈值来自 config.mjs（跑前写死）。
 *
 * 产物安全（审计 2026-10-30 F02）：所有参数先验证再执行；试跑（--dir）输出严格位于
 * results/ 内的隔离子目录；--out 只接受纯文件名；已有目标文件默认拒绝覆盖（需显式 --overwrite）；
 * --limit/--max-text/--max-vision/--max-tokens 非有限正整数时在打开/清空任何文件之前报错退出。
 * 有样本 error 时退出码 4（审计 F12），预算停止退出码 3。
 */

import { appendFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runScan } from "../../lib/agent/orchestrator.ts";
import { visionChat as realVisionChat, chat as realChat } from "../../lib/models.ts";
import { validateSnapshot } from "../../lib/evidence/validate.ts";
import { analyzeUrlStatic } from "../../lib/tools/url-static.ts";
import { KNOWLEDGE_VERSION } from "../../lib/knowledge/index.ts";
import { PROMPT_VERSION } from "../../lib/prompts/analyzer.ts";

import { BARE_MODEL_PROMPT, CATEGORY_EXPECT, DEFAULT_BUDGET, GROUP_A_RULE, GROUPS } from "./config.mjs";
import { loadDataset } from "./dataset.mjs";
import { startFixtureServer } from "./fixture-server.mjs";
import { parseFinitePositiveInt, parseFlagArgs, resolveIsolatedDir, runnerExitCode, validateIsolationSegment, validateOutName } from "./guards.mjs";
import { createLocalFetcher } from "./local-fetcher.mjs";
import { classify, findingSupport, latencyStats, summarizeByCategory, summarizeByGroupField, summarizeRecords } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = parseFlagArgs(argv, {
    valueKeys: ["group", "limit", "out", "dir", "max-text", "max-vision", "max-tokens"],
    booleanKeys: ["overwrite"],
    flagsLabel: "run-group",
  });
  return {
    group: parsed.args.group ?? null,
    limit: parsed.args.limit ?? null,
    out: parsed.args.out ?? null,
    dir: parsed.args.dir ?? null,
    maxText: parsed.args["max-text"] ?? DEFAULT_BUDGET.text,
    maxVision: parsed.args["max-vision"] ?? DEFAULT_BUDGET.vision,
    maxTokens: parsed.args["max-tokens"] ?? null,
    overwrite: parsed.args.overwrite === true,
    error: parsed.error,
  };
}

const args = parseArgs(process.argv.slice(2));
const usage = `用法：node --env-file=.env eval/experiments/run-group.mjs --group <${Object.keys(GROUPS).join("|")}> [--limit N] [--dir 子目录] [--out 文件名] [--max-text 300] [--max-vision 100] [--max-tokens 6000] [--overwrite]`;
if (args.error) {
  console.error(args.error);
  console.error(usage);
  process.exit(2);
}
if (!args.group || !GROUPS[args.group]) {
  console.error(`--group 必须是五组之一：${Object.keys(GROUPS).join(" | ")}`);
  console.error(usage);
  process.exit(2);
}
// 以下全部验证通过之前，不允许发生任何 mkdir/write（审计 F02：--limit oops/--max-text oops
// 曾以 NaN 使预算比较失效并跑满全量；--tag/--dir 缺值曾静默退回正式目录）
try {
  if (args.limit !== null) args.limit = parseFinitePositiveInt(args.limit, "--limit");
  args.maxText = parseFinitePositiveInt(args.maxText, "--max-text");
  args.maxVision = parseFinitePositiveInt(args.maxVision, "--max-vision");
  if (args.maxTokens !== null) args.maxTokens = parseFinitePositiveInt(args.maxTokens, "--max-tokens");
  if (args.out !== null) validateOutName(args.out);
  if (args.dir !== null) validateIsolationSegment(args.dir, "--dir");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(usage);
  process.exit(2);
}
// --dir：把本组产物写到 results/<子目录>/ 下。试跑必须带它。
// 规范化后必须严格位于 results/ 内部子目录（"."、"./"、..、绝对路径、越出 results 一律拒绝——
// "." 规范化后等于正式 results 根，曾能清空 results/C.jsonl 等正式产物，审计 F02）
const RESULTS_ROOT = path.join(HERE, "results");
const RESULTS_DIR = args.dir ? resolveIsolatedDir(RESULTS_ROOT, args.dir) : RESULTS_ROOT;
const outName = args.out ?? args.group;
const withScreenshot = args.group !== "C-no-vision";
const withKnowledge = args.group !== "C-no-kb";
const jsonlPath = path.join(RESULTS_DIR, `${outName}.jsonl`);
const summaryPath = path.join(RESULTS_DIR, `${outName}.summary.json`);

// 已有目标产物默认拒绝覆盖（审计 F02）：防止试跑/误操作清空正式结果；确要覆盖必须显式 --overwrite。
// 该检查放在 mkdirSync 之前——被拒绝的调用不允许发生任何文件系统写入。
if (!args.overwrite && (existsSync(jsonlPath) || existsSync(summaryPath))) {
  console.error(`目标产物已存在，拒绝覆盖：${jsonlPath}（如确要覆盖请显式加 --overwrite）`);
  process.exit(2);
}
mkdirSync(RESULTS_DIR, { recursive: true });
writeFileSync(jsonlPath, ""); // 新运行覆盖旧文件；运行中逐行追加即增量落盘

// ---------------------------------------------------------------------------
// 数据集 + fixture 服务 + fetcher
// ---------------------------------------------------------------------------

const allSamples = loadDataset();
const samples = args.limit ? allSamples.slice(0, args.limit) : allSamples;
const sampleByUrl = new Map(samples.map((s) => [s.url, s]));
const sampleById = new Map(samples.map((s) => [s.id, s]));
const server = await startFixtureServer(allSamples);
const fetcher = createLocalFetcher({ baseUrl: server.baseUrl, sampleByUrl, withScreenshot });

// ---------------------------------------------------------------------------
// 模型调用计数 / 预算
// ---------------------------------------------------------------------------

/**
 * max_tokens 口径（如实披露，审计 2026-10-30 F14：历史事实与当前默认分开陈述）：
 * - 历史事实：编排器主分析调用曾硬编码 maxTokens=2000（lib/agent/orchestrator.ts）。
 *   step-5-preview 为推理模型（先 reasoning 后 content），2000 试跑（results/trial-2000budget/）
 *   实测 C 组 9 次调用 finish=length（波及 5/6 样本）、4/6 样本最终解析失败，B 组 1 次 length。
 * - 已提交的正式五组统一用 --max-tokens 6000 覆盖（summary 的 models.maxTokensOverride=6000）。
 * - 当前默认：不带 --max-tokens 时，B 组仍是本文件硬编码的 2000，C 组走编排器默认 6000
 *   （VERIPAGE_ANALYZER_MAX_TOKENS 可覆盖）。复现原统一条件必须显式 --max-tokens 6000（README/报告附录 B 已写明）。
 */
const MAX_TOKENS_OVERRIDE = args.maxTokens;
const withBudget = (opts) => (MAX_TOKENS_OVERRIDE ? { ...opts, maxTokens: MAX_TOKENS_OVERRIDE } : opts);

const counters = {
  text: 0,
  vision: 0,
  promptTokens: 0,
  completionTokens: 0,
  finishLength: 0,
  errors: [],
  budgetStopped: false,
};

function noteBudget(kind) {
  const limit = kind === "text" ? args.maxText : args.maxVision;
  if (counters[kind] >= limit) {
    counters.budgetStopped = true;
    throw new Error(`BUDGET_${kind.toUpperCase()}_EXCEEDED（已达单组上限 ${limit}）`);
  }
}

const countedChat = async (messages, opts = {}) => {
  noteBudget("text");
  counters.text += 1;
  const res = await realChat(messages, withBudget(opts));
  counters.promptTokens += res.usage?.promptTokens ?? 0;
  counters.completionTokens += res.usage?.completionTokens ?? 0;
  if (res.finishReason === "length") counters.finishLength += 1;
  return res;
};

const countedVisionChat = async (prompt, imageBase64, opts = {}) => {
  noteBudget("vision");
  counters.vision += 1;
  const res = await realVisionChat(prompt, imageBase64, withBudget(opts));
  counters.promptTokens += res.usage?.promptTokens ?? 0;
  counters.completionTokens += res.usage?.completionTokens ?? 0;
  if (res.finishReason === "length") counters.finishLength += 1;
  return res;
};

// S0 放行桩：fixture 全在 127.0.0.1，真实 S0 会拒绝回环地址（实验壳偏离，report.md 已写明）
const allowGuard = async () => ({ allowed: true, resolvedIps: ["127.0.0.1"] });

// 去知识库消融桩：恒不命中（等价于知识库置空），版本随桩报告
const emptyKbLookup = (domain) => ({
  domain,
  brand: { hit: false, note: "空库桩：未收录于官方域白名单（消融：知识库置空）" },
  thirdParty: { hit: false },
  knowledgeVersion: "ablation-empty-v0",
});
const emptyRagSearch = () => ({
  matches: [],
  knowledgeVersion: "ablation-empty-v0",
  emptyReason: "空库桩：案例库置空（消融）",
});

// ---------------------------------------------------------------------------
// 各组 runner
// ---------------------------------------------------------------------------

function runGroupA(sample, blacklist) {
  const report = analyzeUrlStatic(sample.url);
  const host = new URL(sample.url).hostname.toLowerCase();
  const blacklistHit = blacklist.has(host);
  let risk;
  let decision;
  if (blacklistHit) {
    risk = GROUP_A_RULE.blacklistRisk;
    decision = "blacklist";
  } else if (report.findings.some((f) => f.weight >= GROUP_A_RULE.suspiciousMinWeight)) {
    risk = "suspicious";
    decision = "rule";
  } else {
    risk = GROUP_A_RULE.defaultRisk;
    decision = "default";
  }
  return {
    risk,
    detail: {
      decision,
      blacklistHit,
      staticScore: report.score,
      staticFindings: report.findings.map((f) => ({ id: f.id, weight: f.weight, title: f.title, detail: f.detail })),
      registrableDomain: report.registrableDomain,
    },
  };
}

function parseBareRisk(content) {
  const text = content.trim();
  const tryJson = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  let json = tryJson(text);
  if (!json) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) json = tryJson(text.slice(start, end + 1));
  }
  if (json && typeof json.risk === "string") {
    const risk = json.risk;
    if (["high", "suspicious", "no_significant_risk", "unknown"].includes(risk)) {
      return { risk, reason: typeof json.reason === "string" ? json.reason : "", parseOk: true };
    }
  }
  // 兜底：从自由文本里找风险级关键词（如实记录解析失败）
  const lower = text.toLowerCase();
  const hit = ["no_significant_risk", "suspicious", "high", "unknown"].find((k) => lower.includes(k));
  return {
    risk: hit ?? "unknown",
    reason: text.slice(0, 400),
    parseOk: false,
    parseNote: hit ? "非 JSON 输出，按关键词兜底解析" : "无法解析出风险等级",
  };
}

async function runGroupB(sample) {
  const page = await fetcher.fetchPage(sample.url);
  const textEvidence = page.evidence.find((e) => e.type === "text");
  const shot = page.evidence.find((e) => e.type === "screenshot");
  const pageText = textEvidence && textEvidence.type === "text" ? textEvidence.text : "";
  if (!shot || shot.type !== "screenshot") {
    return {
      risk: "unknown",
      detail: { error: "未取到截图，裸模型无法判断", fetchError: page.error ?? null },
    };
  }
  const res = await countedVisionChat(BARE_MODEL_PROMPT(pageText), shot.data, withBudget({ temperature: 0.2, maxTokens: 2000 }));
  const parsed = parseBareRisk(res.content);
  return {
    risk: parsed.risk,
    detail: {
      reason: parsed.reason,
      parseOk: parsed.parseOk,
      parseNote: parsed.parseNote,
      finishReason: res.finishReason,
      pageTextChars: pageText.length,
      screenshotChars: shot.data.length,
      fetchWarnings: page.warnings,
    },
  };
}

async function runGroupC(sample) {
  const events = [];
  const snapshot = await runScan(sample.url, (ev) => events.push(ev), {
    services: {
      guard: allowGuard,
      fetchPage: (url, opts) => fetcher.fetchPage(url, opts),
      visionChat: countedVisionChat,
      chat: countedChat,
      ...(withKnowledge
        ? {}
        : { kbLookup: emptyKbLookup, ragSearch: emptyRagSearch }),
    },
  });
  const validation = validateSnapshot(snapshot);
  const hardErrors = validation.errors.filter((e) => !e.startsWith("[warn]"));
  const support = findingSupport(snapshot);
  const assessment = snapshot.originalAssessment;
  return {
    risk: assessment.risk,
    detail: {
      snapshotId: snapshot.id,
      versions: snapshot.versions,
      sufficiency: assessment.evidenceSufficiency,
      summary: assessment.summary,
      findings: assessment.findings.map((f) => ({
        id: f.id,
        kind: f.kind,
        statement: f.statement,
        evidenceIds: f.evidenceIds,
      })),
      gaps: assessment.gaps,
      unknowns: assessment.unknowns,
      recommendedAction: assessment.recommendedAction,
      evidenceCount: snapshot.evidence.length,
      evidenceTypes: [...new Set(snapshot.evidence.map((e) => e.type))],
      knowledgeEvidenceIds: snapshot.evidence.filter((e) => e.type === "knowledge").map((e) => e.id),
      coverage: snapshot.coverage.map((c) => ({ step: c.step, state: c.state, ...(c.reason ? { reason: c.reason } : {}) })),
      validateOk: validation.ok,
      validateHardErrors: hardErrors,
      findingSupport: support,
      versionsKnowledge: snapshot.versions.knowledge,
    },
  };
}

// ---------------------------------------------------------------------------
// 主循环（逐样本增量落盘）
// ---------------------------------------------------------------------------

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const records = [];
const blacklist = new Set(
  allSamples.filter((s) => s.blacklist).map((s) => new URL(s.url).hostname.toLowerCase()),
);

console.log(`=== 组 ${args.group}（${GROUPS[args.group].label}） 样本 ${samples.length} 个，预算 text≤${args.maxText} vision≤${args.maxVision} ===`);
console.log(`    fixture: ${server.baseUrl}（本地，无外网请求）`);

for (let i = 0; i < samples.length; i += 1) {
  const sample = samples[i];
  // 预算预估（每组单样本最坏 1 视觉 + 2 文本）：超出即停，不偷偷降质量
  const needVision = args.group === "A" ? 0 : withScreenshot ? 1 : 0;
  const needText = args.group === "A" || args.group === "B" ? 0 : 2;
  if (counters.vision + needVision > args.maxVision || counters.text + needText > args.maxText) {
    counters.budgetStopped = true;
    console.log(`!! 预算上限将超（text ${counters.text}/${args.maxText}, vision ${counters.vision}/${args.maxVision}），停止本组`);
    for (let j = i; j < samples.length; j += 1) {
      const rest = samples[j];
      const record = {
        group: args.group,
        sampleId: rest.id,
        category: rest.category,
        groupField: rest.group,
        url: rest.url,
        expectRisk: rest.expectRisk,
        expect: CATEGORY_EXPECT[rest.category],
        blacklist: rest.blacklist,
        status: "budget-stopped",
        risk: null,
        latencyMs: 0,
        calls: { chat: 0, vision: 0 },
        tokens: { prompt: 0, completion: 0 },
      };
      appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
      records.push(record);
    }
    break;
  }

  const t0 = Date.now();
  const before = {
    text: counters.text,
    vision: counters.vision,
    promptTokens: counters.promptTokens,
    completionTokens: counters.completionTokens,
    finishLength: counters.finishLength,
  };
  let result;
  let status = "ok";
  try {
    if (args.group === "A") result = runGroupA(sample, blacklist);
    else if (args.group === "B") result = await runGroupB(sample);
    else result = await runGroupC(sample);
  } catch (err) {
    status = "error";
    counters.errors.push({ sampleId: sample.id, message: err instanceof Error ? err.message : String(err) });
    result = { risk: "unknown", detail: { error: err instanceof Error ? err.message : String(err) } };
  }
  const latencyMs = Date.now() - t0;

  const record = {
    group: args.group,
    sampleId: sample.id,
    category: sample.category,
    groupField: sample.group,
    url: sample.url,
    expectRisk: sample.expectRisk,
    expect: CATEGORY_EXPECT[sample.category],
    blacklist: sample.blacklist,
    status,
    risk: result.risk,
    latencyMs,
    calls: { chat: counters.text - before.text, vision: counters.vision - before.vision },
    tokens: {
      prompt: counters.promptTokens - before.promptTokens,
      completion: counters.completionTokens - before.completionTokens,
    },
    finishLength: counters.finishLength - before.finishLength,
    ...(args.group === "A" ? { aDetail: result.detail } : {}),
    ...(args.group === "B" ? { bDetail: result.detail } : {}),
    ...(args.group === "C" || args.group === "C-no-vision" || args.group === "C-no-kb" ? { cDetail: result.detail } : {}),
  };
  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
  records.push(record);

  const verdict = classify(sample, result.risk);
  const flag = verdict.correct ? "OK " : verdict.undecidable ? "?? " : "XX ";
  console.log(
    `[${args.group} ${String(i + 1).padStart(2)}/${samples.length}] ${flag}${sample.id.padEnd(22)} ` +
      `risk=${String(result.risk).padEnd(20)} ${(latencyMs / 1000).toFixed(1)}s ` +
      `calls(text+${record.calls.chat},vision+${record.calls.vision}) 累计 text=${counters.text} vision=${counters.vision} tok=${counters.promptTokens}+${counters.completionTokens}`,
  );
  if (counters.budgetStopped) break;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const okRecords = records
  .filter((r) => r.status === "ok")
  .map((r) => ({ ...r, sample: sampleById.get(r.sampleId) }));
const finishedAt = new Date().toISOString();
const summary = {
  group: args.group,
  label: GROUPS[args.group].label,
  note: GROUPS[args.group].note,
  startedAt,
  finishedAt,
  wallMs: Date.now() - startedMs,
  datasetSize: samples.length,
  completed: okRecords.length,
  budgetStopped: counters.budgetStopped,
  budget: { text: args.maxText, vision: args.maxVision },
  counters: {
    text: counters.text,
    vision: counters.vision,
    promptTokens: counters.promptTokens,
    completionTokens: counters.completionTokens,
    finishLength: counters.finishLength,
    fetchErrors: fetcher.stats.fetchErrors,
    abortedSubresources: fetcher.stats.abortedSubresources,
  },
  models: {
    text: process.env.VERIPAGE_TEXT_MODEL ?? "(未设置)",
    vision: process.env.VERIPAGE_VISION_MODEL ?? "(未设置)",
    promptVersion: PROMPT_VERSION,
    knowledgeVersion: withKnowledge ? KNOWLEDGE_VERSION : "ablation-empty-v0",
    maxTokensOverride: MAX_TOKENS_OVERRIDE, // null = 忠实编排器硬编码 2000；数字 = 实验壳覆盖值（报告披露）
  },
  overall: summarizeRecords(okRecords),
  byCategory: summarizeByCategory(okRecords),
  byGroup: summarizeByGroupField(okRecords),
  latency: latencyStats(okRecords),
  fetchStats: fetcher.stats,
};

if (args.group === "A" || args.group === "B") {
  summary.evidenceSupport = null; // 不产出证据绑定结构（A 为规则命中即证据，B 无证据字段）
} else {
  const supports = okRecords
    .filter((r) => r.cDetail?.findingSupport)
    .map((r) => ({ sampleId: r.sampleId, ...r.cDetail.findingSupport }));
  const totalFindings = supports.reduce((s, v) => s + v.total, 0);
  const supportedFindings = supports.reduce((s, v) => s + v.supported, 0);
  summary.evidenceSupport = {
    samplesWithFindings: supports.filter((v) => v.total > 0).length,
    findings: totalFindings,
    supported: supportedFindings,
    rate: totalFindings === 0 ? null : Number((supportedFindings / totalFindings).toFixed(4)),
    unsupportedBySample: supports
      .filter((v) => v.unsupported.length > 0)
      .map((v) => ({ sampleId: v.sampleId, unsupported: v.unsupported })),
  };
  summary.validateOk = okRecords.filter((r) => r.cDetail?.validateOk).length;
  summary.validateFailures = okRecords
    .filter((r) => r.cDetail && !r.cDetail.validateOk)
    .map((r) => ({ sampleId: r.sampleId, errors: r.cDetail.validateHardErrors }));
}

writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
await fetcher.close();
await server.close();

const overall = summary.overall;
console.log(`=== 组 ${args.group} 完成：${summary.completed}/${samples.length} 样本，墙钟 ${(summary.wallMs / 1000).toFixed(0)}s ===`);
console.log(
  `    恶意检出 ${overall.malicious.detected}/${overall.malicious.total}，良性误报 ${overall.benign.falsePositive}/${overall.benign.total}，` +
    `unknown ${overall.undecidableAll.count}/${overall.decided}，调用 text=${counters.text} vision=${counters.vision}`,
);
if (counters.errors.length > 0) {
  console.log(`    !! 本组有 ${counters.errors.length} 个样本运行出错（status=error），退出码 4（审计 F12：错误必须决定退出码）`);
  for (const e of counters.errors) console.log(`       - ${e.sampleId}: ${e.message}`);
}
console.log(`    结果：${jsonlPath}`);
// 审计 F12：有 error 记录必须退出非零（4）；预算停止如实退出 3；全部成功才 0
process.exit(runnerExitCode({ errorCount: counters.errors.length, budgetStopped: counters.budgetStopped }));
