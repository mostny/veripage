/**
 * W3 对照实验 · 一键运行（验收链命令：node eval/experiments/run-all.mjs）
 *
 * 一条命令跑完三组对照 + 两组消融，每个实验组单独一次进程（成本纪律：
 * 单组 300 文本 + 100 视觉调用上限，实时计数，超限即停并如实记录）。
 * 先小样本试通：node eval/experiments/run-all.mjs --limit 5 --tag trial-xxx
 *
 * 产出：eval/experiments/results/<组>.jsonl（逐样本增量）+ <组>.summary.json + report.md
 * 试跑必须加 --tag <名字>：产物落 results/<名字>/，不覆盖 results/ 下已提交的全量产物。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { limit: null, tag: null, groups: ["A", "B", "C", "C-no-vision", "C-no-kb"], maxText: "300", maxVision: "100", maxTokens: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "limit") args.limit = value;
    else if (key === "tag") args.tag = value;
    else if (key === "groups") args.groups = value.split(",").map((s) => s.trim()).filter(Boolean);
    else if (key === "max-text") args.maxText = value;
    else if (key === "max-vision") args.maxVision = value;
    else if (key === "max-tokens") args.maxTokens = value;
    else continue;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
// --tag：试跑产物隔离到 results/<tag>/。防止试跑覆盖已提交的全量正式产物。
if (args.tag && (args.tag.split(/[\\/]/).includes("..") || path.isAbsolute(args.tag) || args.tag === "results")) {
  console.error("--tag 只接受 results/ 内的普通子目录名（如 --tag trial-xxx），拒绝绝对路径、.. 与 results 本身");
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
console.log(`产出目录：eval/experiments/results/${args.tag ?? ""}${args.tag ? `（--tag 隔离试跑，不碰 results/ 正式产物）` : "（正式产物目录）"}`);

const exitCodes = {};
for (const group of args.groups) {
  const groupArgs = ["eval/experiments/run-group.mjs", "--group", group, "--max-text", args.maxText, "--max-vision", args.maxVision];
  if (args.limit) groupArgs.push("--limit", args.limit);
  if (args.tag) groupArgs.push("--dir", args.tag);
  if (args.maxTokens) groupArgs.push("--max-tokens", args.maxTokens);
  const nodeArgs = hasEnv ? ["--env-file=.env", ...groupArgs] : groupArgs;
  console.log(`\n--- 运行组 ${group}：node ${nodeArgs.join(" ")} ---`);
  exitCodes[group] = await run(process.execPath, nodeArgs);
}

console.log("\n--- 各组退出码 ---");
for (const [group, code] of Object.entries(exitCodes)) console.log(`${group}: ${code}`);

const reportArgs = ["eval/experiments/report.mjs"];
if (args.tag) reportArgs.push("--dir", `eval/experiments/results/${args.tag}`);
// 报告要求五组结果齐全；试跑/单组验证跳过报告生成，不算失败
const FULL_GROUPS = ["A", "B", "C", "C-no-vision", "C-no-kb"];
const ranAllGroups = FULL_GROUPS.every((g) => args.groups.includes(g));
let reportCode = 0;
if (ranAllGroups) {
  reportCode = await run(process.execPath, reportArgs);
  console.log(`\n报告生成退出码：${reportCode}`);
} else {
  console.log("\n--- 跳过报告生成：未跑全五组（试跑/单组验证不需要报告；跑全五组时才生成 report.md）---");
}
console.log(`产出目录：eval/experiments/results/${args.tag ?? ""}`);

const allOk = Object.values(exitCodes).every((c) => c === 0 || c === 3);
process.exit(allOk && reportCode === 0 ? 0 : 1);
