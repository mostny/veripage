/**
 * W3 对照实验 · 一键运行（验收链命令：node eval/experiments/run-all.mjs）
 *
 * 一条命令跑完三组对照 + 两组消融，每个实验组单独一次进程（成本纪律：
 * 单组 300 文本 + 100 视觉调用上限，实时计数，超限即停并如实记录）。
 * 先小样本试通：node eval/experiments/run-all.mjs --limit 5
 *
 * 产出：eval/experiments/results/<组>.jsonl（逐样本增量）+ <组>.summary.json + report.md
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { limit: null, groups: ["A", "B", "C", "C-no-vision", "C-no-kb"], maxText: "300", maxVision: "100", maxTokens: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[i + 1];
    if (key === "limit") args.limit = value;
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

const exitCodes = {};
for (const group of args.groups) {
  const groupArgs = ["eval/experiments/run-group.mjs", "--group", group, "--max-text", args.maxText, "--max-vision", args.maxVision];
  if (args.limit) groupArgs.push("--limit", args.limit);
  if (args.maxTokens) groupArgs.push("--max-tokens", args.maxTokens);
  const nodeArgs = hasEnv ? ["--env-file=.env", ...groupArgs] : groupArgs;
  console.log(`\n--- 运行组 ${group}：node ${nodeArgs.join(" ")} ---`);
  exitCodes[group] = await run(process.execPath, nodeArgs);
}

console.log("\n--- 各组退出码 ---");
for (const [group, code] of Object.entries(exitCodes)) console.log(`${group}: ${code}`);

const reportCode = await run(process.execPath, ["eval/experiments/report.mjs"]);
console.log(`\n报告生成退出码：${reportCode}`);
console.log("产出目录：eval/experiments/results/");

const allOk = Object.values(exitCodes).every((c) => c === 0 || c === 3);
process.exit(allOk && reportCode === 0 ? 0 : 1);
