/**
 * 检测编排器冒烟测试
 * 运行：node --env-file=.env eval/orchestrator.smoke.ts
 *
 * 用例 1（https://example.com）会真实走完整流水线：
 *   S0 访问边界 → 闸门①静态规则 → 闸门② Playwright 沙箱代访 → 闸门③视觉 + 主分析（Agnes API）→ validate
 * 用例 2（http://192.168.1.1）走 S0 拒绝路径，不发起任何网络访问。
 */
import { runScan, type ScanEvent } from "../lib/agent/orchestrator.ts";
import { validateSnapshot } from "../lib/evidence/validate.ts";
import { RISK_LEVELS } from "../lib/evidence/types.ts";

let fail = 0;
const check = (name: string, ok: boolean) => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

type StepEvent = Extract<ScanEvent, { type: "step" }>;
const stepEvents = (events: ScanEvent[]): StepEvent[] =>
  events.filter((e): e is StepEvent => e.type === "step");

/** 一行摘要打印每个事件 */
function describeEvent(ev: ScanEvent): string {
  if (ev.type === "report") {
    return `report  snapshot=${ev.snapshot.id} risk=${ev.snapshot.originalAssessment.risk}`;
  }
  const parts = [`${ev.step}=${ev.state}`];
  if (ev.detail) parts.push(ev.detail);
  if (ev.reason) parts.push(`reason=${ev.reason}`);
  return parts.join("  ");
}

const STEP_NAMES = ["s0-guard", "gate1-static", "gate2-fetch", "gate3-vision", "gate3-analyzer", "validate"];

// --- 用例 1：公网站点完整检测 ---------------------------------------------
console.log("=== 用例 1：https://example.com 完整检测 ===");
const events1: ScanEvent[] = [];
const startedAt = Date.now();
const snapshot = await runScan("https://example.com", (ev) => {
  events1.push(ev);
  console.log(`  · ${describeEvent(ev)}`);
});
console.log(`  耗时 ${Date.now() - startedAt}ms`);

const steps1 = stepEvents(events1);
check("step 事件 ≥5", steps1.length >= 5);
for (const name of STEP_NAMES) {
  check(`包含 step ${name}`, steps1.some((s) => s.step === name));
}

const validation = validateSnapshot(snapshot);
const hardErrors = validation.errors.filter((e) => !e.startsWith("[warn]"));
check("validateSnapshot 硬错误为 0", hardErrors.length === 0);
if (validation.errors.length > 0) {
  console.log(`  校验信息（${validation.errors.length} 条）：${validation.errors.join(" | ")}`);
} else {
  console.log("  校验信息：无");
}

check("risk 属于四枚举", RISK_LEVELS.includes(snapshot.originalAssessment.risk));
check(
  "risk 对 example.com 合理（no_significant_risk 或 unknown）",
  snapshot.originalAssessment.risk === "no_significant_risk" ||
    snapshot.originalAssessment.risk === "unknown",
);
check("evidence.length ≥ 4", snapshot.evidence.length >= 4);

console.log(
  `  risk=${snapshot.originalAssessment.risk} 充分度=${snapshot.originalAssessment.evidenceSufficiency} ` +
    `findings=${snapshot.originalAssessment.findings.length} evidence=${snapshot.evidence.length} ` +
    `artifacts=${snapshot.artifactIds.length} coverage=${snapshot.coverage.length}`,
);
console.log(`  summary: ${snapshot.originalAssessment.summary}`);

// --- 用例 2：内网地址走 S0 拒绝路径 ---------------------------------------
console.log("=== 用例 2：http://192.168.1.1 S0 拒绝路径 ===");
const events2: ScanEvent[] = [];
const snapshot2 = await runScan("http://192.168.1.1", (ev) => {
  events2.push(ev);
  console.log(`  · ${describeEvent(ev)}`);
});

const steps2 = stepEvents(events2);
const stateOf = (name: string): string | undefined => steps2.find((s) => s.step === name)?.state;
const reasonOf = (name: string): string | undefined => steps2.find((s) => s.step === name)?.reason;

check("s0-guard completed", stateOf("s0-guard") === "completed");
check("gate2-fetch skipped", stateOf("gate2-fetch") === "skipped");
check("gate3-vision skipped", stateOf("gate3-vision") === "skipped");
check("gate3-analyzer skipped", stateOf("gate3-analyzer") === "skipped");
check("跳过原因注明访问边界拒绝", reasonOf("gate2-fetch") === "访问边界拒绝");
check("risk=unknown", snapshot2.originalAssessment.risk === "unknown");

const validation2 = validateSnapshot(snapshot2);
const hardErrors2 = validation2.errors.filter((e) => !e.startsWith("[warn]"));
check("拒绝路径快照硬错误为 0", hardErrors2.length === 0);
if (validation2.errors.length > 0) {
  console.log(`  校验信息（${validation2.errors.length} 条）：${validation2.errors.join(" | ")}`);
} else {
  console.log("  校验信息：无");
}
check("快照仍可组装返回", snapshot2.id.length > 0 && snapshot2.evidence.length >= 1);
console.log(
  `  risk=${snapshot2.originalAssessment.risk} evidence=${snapshot2.evidence.length} ` +
    `gaps=${JSON.stringify(snapshot2.originalAssessment.gaps)}`,
);

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
