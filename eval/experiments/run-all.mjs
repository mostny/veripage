/**
 * W3 对照实验 · 一键运行（验收链命令：node eval/experiments/run-all.mjs）
 *
 * 一条命令跑完三组对照 + 两组消融，每个实验组单独一次进程（成本纪律：
 * 单组 300 文本 + 100 视觉调用上限，实时计数，超限即停并如实记录）。
 * 先小样本试通：node eval/experiments/run-all.mjs --limit 6 --tag trial-xxx --max-tokens 6000
 *（试跑必须加 --tag：产物落 results/<tag>/，不覆盖 results/ 下已提交的全量产物）
 *
 * 产物安全（审计 2026-10-30 F02）：所有参数先验证再执行；--tag 规范化后必须严格位于
 * results/ 内的隔离子目录（拒绝 "."、"./"、".."、绝对路径）；数值参数非有限正整数直接拒绝；
 * 已有目标产物默认拒绝覆盖（需显式 --overwrite，会透传给各子进程与报告生成器）。
 * 复现正式五组的统一预算条件必须显式 --max-tokens 6000（审计 F14：B 裸命令默认仍 2000）。
 *
 * 产出：eval/experiments/results/<组>.jsonl（逐样本增量）+ <组>.summary.json + report.md
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUDGET, GROUPS } from "./config.mjs";
import { parseFinitePositiveInt, parseFlagArgs, resolveIsolatedDir, validateIsolationSegment } from "./guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const parsed = parseFlagArgs(argv, {
    valueKeys: ["limit", "tag", "groups", "max-text", "max-vision", "max-tokens"],
    booleanKeys: ["overwrite"],
    flagsLabel: "run-all",
  });
  return {
    limit: parsed.args.limit ?? null,
    tag: parsed.args.tag ?? null,
    groups: parsed.args.groups ?? null,
    maxText: parsed.args["max-text"] ?? String(DEFAULT_BUDGET.text),
    maxVision: parsed.args["max-vision"] ?? String(DEFAULT_BUDGET.vision),
    maxTokens: parsed.args["max-tokens"] ?? null,
    overwrite: parsed.args.overwrite === true,
    error: parsed.error,
  };
}

const args = parseArgs(process.argv.slice(2));
// 以下验证全部通过之前，不启动任何子进程（审计 F02：--tag 缺值/写错、--limit oops
// 曾静默退回正式目录或以 NaN 跑满全量 61 样本，存在清空正式产物风险）
if (args.error) {
  console.error(args.error);
  console.error("用法：node eval/experiments/run-all.mjs [--limit N] [--tag 试跑子目录] [--groups A,B,C,...] [--max-text 300] [--max-vision 100] [--max-tokens 6000] [--overwrite]");
  process.exit(2);
}
if (args.groups !== null) {
  const wanted = args.groups.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((g) => !GROUPS[g]);
  if (wanted.length === 0 || unknown.length > 0) {
    console.error(`--groups 只接受 ${Object.keys(GROUPS).join(" | ")} 的逗号列表，无法识别：${unknown.join(", ") || "(空)"}`);
    process.exit(2);
  }
  args.groups = wanted;
} else {
  args.groups = ["A", "B", "C", "C-no-vision", "C-no-kb"];
}
try {
  if (args.limit !== null) args.limit = parseFinitePositiveInt(args.limit, "--limit");
  args.maxText = parseFinitePositiveInt(args.maxText, "--max-text");
  args.maxVision = parseFinitePositiveInt(args.maxVision, "--max-vision");
  if (args.maxTokens !== null) args.maxTokens = parseFinitePositiveInt(args.maxTokens, "--max-tokens");
  // --tag：试跑产物隔离到 results/<tag>/。规范化后必须严格位于 results/ 内部子目录——
  // "." / "./" 规范化后等于正式 results 根，曾能定位并清空 results/A.jsonl 等正式产物（审计 F02）
  if (args.tag !== null) {
    validateIsolationSegment(args.tag, "--tag");
    resolveIsolatedDir(path.join(HERE, "results"), args.tag);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const hasEnv = existsSync(path.resolve(HERE, "..", "..", ".env"));

function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      console.error(`启动失败：${err.message}`);
      resolve(1);
    });
  });
}

console.log("=== W3 对照实验：三组对照 + 两组消融 ===");
console.log(`组：${args.groups.join(", ")}${args.limit ? `（试跑 limit=${args.limit}）` : "（全量）"}`);
console.log(`.env 存在：${hasEnv ? "是（模型组走真实 API）" : "否（仅 A 组可跑，模型组会因缺配置失败）"}`);
console.log(`产出目录：eval/experiments/results/${args.tag ?? ""}${args.tag ? `（--tag 隔离试跑，不碰 results/ 正式产物）` : "（正式产物目录）"}${args.overwrite ? "（--overwrite：允许覆盖已存在的产物）" : ""}`);

const exitCodes = {};
for (const group of args.groups) {
  const groupArgs = ["eval/experiments/run-group.mjs", "--group", group, "--max-text", String(args.maxText), "--max-vision", String(args.maxVision)];
  if (args.limit) groupArgs.push("--limit", String(args.limit));
  if (args.tag) groupArgs.push("--dir", args.tag);
  if (args.maxTokens) groupArgs.push("--max-tokens", String(args.maxTokens));
  if (args.overwrite) groupArgs.push("--overwrite");
  const nodeArgs = hasEnv ? ["--env-file=.env", ...groupArgs] : groupArgs;
  console.log(`\n--- 运行组 ${group}：node ${nodeArgs.join(" ")} ---`);
  exitCodes[group] = await run(process.execPath, nodeArgs);
}

console.log("\n--- 各组退出码 ---");
for (const [group, code] of Object.entries(exitCodes)) console.log(`${group}: ${code}`);

const reportArgs = ["eval/experiments/report.mjs"];
if (args.tag) reportArgs.push("--dir", `eval/experiments/results/${args.tag}`);
if (args.overwrite) reportArgs.push("--overwrite");
// 报告要求五组结果齐全；试跑/单组验证跳过报告生成，不算失败
const FULL_GROUPS = ["A", "B", "C", "C-no-vision", "C-no-kb"];
const ranAllGroups = FULL_GROUPS.every((g) => args.groups.includes(g));
const groupsFailed = Object.entries(exitCodes).filter(([, c]) => c !== 0 && c !== 3);
let reportCode = 0;
if (!ranAllGroups) {
  console.log("\n--- 跳过报告生成：未跑全五组（试跑/单组验证不需要报告；跑全五组时才生成 report.md）---");
} else if (groupsFailed.length > 0) {
  reportCode = 1;
  console.log(`\n--- 跳过报告生成：有组未成功（${groupsFailed.map(([g, c]) => `${g}=${c}`).join(", ")}；审计 F12：带病数据不得生成肯定性报告）---`);
} else if (args.limit !== null) {
  console.log(`\n--- 跳过报告生成：--limit ${args.limit} 为部分样本试跑，报告校验要求每组完整覆盖数据集（审计 F12）---`);
} else {
  reportCode = await run(process.execPath, reportArgs);
  console.log(`\n报告生成退出码：${reportCode}`);
}
console.log(`产出目录：eval/experiments/results/${args.tag ?? ""}`);

const allOk = Object.values(exitCodes).every((c) => c === 0 || c === 3);
process.exit(allOk && reportCode === 0 ? 0 : 1);
