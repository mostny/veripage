/**
 * 编排器冒烟：真实跑通 S0→闸门①②③→快照校验 全链路
 * 运行：node --env-file=.env eval/orchestrator.smoke.ts
 * 用例 1 会真实调用 Agnes API 与 Playwright（免费额度，正常跑）
 */
import { runScan, type ScanEvent } from "../lib/agent/orchestrator.ts";
import { validateSnapshot } from "../lib/evidence/validate.ts";
import type { CaseSnapshot } from "../lib/evidence/types.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` | ${detail}` : ""}`);
};

const ALL_STEPS = ["s0-guard", "gate1-static", "gate2-fetch", "gate3-vision", "gate3-analyzer", "validate"] as const;

async function collect(url: string): Promise<{ events: ScanEvent[]; snapshot: CaseSnapshot }> {
  const events: ScanEvent[] = [];
  const snapshot = await runScan(url, (ev) => events.push(ev));
  return { events, snapshot };
}

// ---- 用例 1：公网站点全链路 ----
console.log("=== 用例 1：https://example.com ===");
const r1 = await collect("https://example.com");
for (const ev of r1.events) {
  if (ev.type === "step") {
    console.log(`  [step] ${ev.step} → ${ev.state}${ev.reason ? `（${ev.reason}）` : ""}`);
  }
}
const stepEvents = r1.events.filter((e): e is Extract<ScanEvent, { type: "step" }> => e.type === "step");
check("step 事件 ≥5", stepEvents.length >= 5, `实际 ${stepEvents.length}`);
for (const name of ALL_STEPS) {
  check(`包含步骤 ${name}`, stepEvents.some((e) => e.step === name));
}
const v1 = validateSnapshot(r1.snapshot);
const hard1 = v1.errors.filter((e) => !e.startsWith("[warn]"));
check("快照无硬校验错误", hard1.length === 0, hard1.slice(0, 2).join("；"));
check("risk ∈ 四枚举", ["high", "suspicious", "no_significant_risk", "unknown"].includes(r1.snapshot.originalAssessment.risk), r1.snapshot.originalAssessment.risk);
check("risk 符合 example.com 预期", ["no_significant_risk", "unknown"].includes(r1.snapshot.originalAssessment.risk));
check("evidence ≥ 4", r1.snapshot.evidence.length >= 4, `实际 ${r1.snapshot.evidence.length}`);
check("versions.prompt 已记录", r1.snapshot.versions.prompt.length > 0, r1.snapshot.versions.prompt);
console.log(`  summary: ${r1.snapshot.originalAssessment.summary.slice(0, 80)}`);
console.log(`  findings: ${r1.snapshot.originalAssessment.findings.length} 条 | unknowns: ${r1.snapshot.originalAssessment.unknowns.length}`);

// ---- 用例 2：S0 阻断路径 ----
console.log("=== 用例 2：http://192.168.1.1（S0 阻断） ===");
const r2 = await collect("http://192.168.1.1");
const step2 = r2.events.filter((e): e is Extract<ScanEvent, { type: "step" }> => e.type === "step");
for (const ev of step2) console.log(`  [step] ${ev.step} → ${ev.state}${ev.reason ? `（${ev.reason}）` : ""}`);
check("gate2-fetch 被跳过", step2.some((e) => e.step === "gate2-fetch" && e.state === "skipped"));
check("gate3-* 被跳过", step2.some((e) => e.step === "gate3-analyzer" && e.state === "skipped"));
check("阻断路径 risk=unknown", r2.snapshot.originalAssessment.risk === "unknown");
const v2 = validateSnapshot(r2.snapshot);
const hard2 = v2.errors.filter((e) => !e.startsWith("[warn]"));
check("阻断快照无硬校验错误", hard2.length === 0, hard2.slice(0, 2).join("；"));

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
