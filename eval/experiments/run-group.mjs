/**
 * W3 对照实验 · 单组运行器
 *
 * 用法：
 *   node --env-file=.env eval/experiments/run-group.mjs --group C [--limit N] [--out NAME]
 *       [--max-text 300] [--max-vision 100]
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
 */

import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
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
import { createLocalFetcher } from "./local-fetcher.mjs";
import { classify, findingSupport, latencyStats, summarizeByCategory, summarizeByGroupField, summarizeRecords } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, "results");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { group: null, limit: null, out: null, maxText: DEFAULT_BUDGET.text, maxVision: DEFAULT_BUDGET.vision, maxTokens: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "group") args.group = value;
    else if (key === "limit") args.limit = Number(value);
    else if (key === "out") args.out = value;
    else if (key === "max-text") args.maxText = Number(value);
    else if (key === "max-vision") args.maxVision = Number(value);
    else if (key === "max-tokens") args.maxTokens = Number(value);
    else continue;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.group || !GROUPS[args.group]) {
  console.error(`用法：node --env-file=.env eval/experiments/run-group.mjs --group <${Object.keys(GROUPS).join("|")}> [--limit N]`);
  process.exit(2);
}
const outName = args.out ?? args.group;
const withScreenshot = args.group !== "C-no-vision";
const withKnowledge = args.group !== "C-no-kb";

mkdirSync(RESULTS_DIR, { recursive: true });
const jsonlPath = path.join(RESULTS_DIR, `${outName}.jsonl`);
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

// ---------------------------------------------------------------------------
// 模型调用计数 / 预算
// ---------------------------------------------------------------------------

/**
 * max_tokens 口径（如实披露）：
 * 编排器主分析调用硬编码 maxTokens=2000（lib/agent/orchestrator.ts）。
 * step-5-preview 为推理模型（先 reasoning 后 content），试跑实测 2000 预算下
 * 4/6 样本 finish=length、JSON 被截断而无法解析。按项目既有做法
 *（commit 07b09e9 / 29b0889：给足预算使判定不被截断混淆，不放宽判定），
 * 实验壳用 --max-tokens 覆盖调用预算；默认不覆盖（忠实 2000）。
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

writeFileSync(path.join(RESULTS_DIR, `${outName}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
await fetcher.close();
await server.close();

const overall = summary.overall;
console.log(`=== 组 ${args.group} 完成：${summary.completed}/${samples.length} 样本，墙钟 ${(summary.wallMs / 1000).toFixed(0)}s ===`);
console.log(
  `    恶意检出 ${overall.malicious.detected}/${overall.malicious.total}，良性误报 ${overall.benign.falsePositive}/${overall.benign.total}，` +
    `unknown ${overall.undecidableAll.count}/${overall.decided}，调用 text=${counters.text} vision=${counters.vision}`,
);
console.log(`    结果：${jsonlPath}`);
process.exit(counters.budgetStopped ? 3 : 0);
