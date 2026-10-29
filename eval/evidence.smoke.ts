/**
 * 证据契约冒烟测试
 * 运行：node eval/evidence.smoke.ts（Node 24 原生剥离 TS 类型）
 *
 * 覆盖：合法最小快照通过 + 4 类违规被检出
 *   a) finding 引用不存在的证据 id
 *   b) 重复证据 id
 *   c) risk="unknown" 但 unknowns 为空（[warn] 级）
 *   d) inference 自引用
 */
import { validateSnapshot } from "../lib/evidence/validate.ts";
import type { CaseSnapshot } from "../lib/evidence/types.ts";

const now = "2026-10-29T10:00:00.000Z";

function baseSnapshot(): CaseSnapshot {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    createdAt: now,
    inputSummary: { displayUrl: "https://ta0bao.com/login", registrableDomain: "ta0bao.com" },
    versions: {
      reportSchema: "1.0",
      model: "agnes-2.5-flash",
      prompt: "p1",
      policy: "v2",
      knowledge: "kb-2026-10",
    },
    originalAssessment: {
      risk: "suspicious",
      evidenceSufficiency: "partial",
      gaps: ["未取得该域名注册信息"],
      summary: "页面声称淘宝登录但域名为 ta0bao.com",
      findings: [
        {
          id: "f1",
          statement: "页面存在密码输入框，域名为 ta0bao.com",
          kind: "observed_fact",
          evidenceIds: ["ev-1"],
          alternativeExplanations: [],
        },
        {
          id: "f2",
          statement: "可能在索取淘宝账号凭据",
          kind: "inference",
          evidenceIds: ["f1", "ev-2"],
          alternativeExplanations: ["可能是第三方比价站的跳转页"],
        },
      ],
      unknowns: [],
      recommendedAction: "建议暂勿访问",
    },
    coverage: [
      { step: "url-static", state: "completed" },
      { step: "fetch-page", state: "completed" },
      { step: "vision-analyze", state: "partial", reason: "截图区域被遮挡" },
      { step: "kb-lookup", state: "skipped", reason: "访问策略限制" },
    ],
    evidence: [
      {
        id: "ev-1",
        type: "form",
        capturedAt: now,
        source: "playwright:dom.query",
        locator: "form#login > input[type=password]",
        excerpt: '<input type="password" name="pwd">',
      },
      {
        id: "ev-2",
        type: "url",
        capturedAt: now,
        source: "url-static",
        locator: "ta0bao.com",
        excerpt: "域名与 taobao.com 编辑距离为 1",
      },
    ],
    artifactIds: ["art-1"],
  };
}

const results: boolean[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  results.push(cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
}

// 1. 合法最小快照
{
  const r = validateSnapshot(baseSnapshot());
  check("合法快照 ok=true", r.ok === true, r.errors.join("; "));
}

// 2a. finding 引用不存在的证据 id
{
  const s = baseSnapshot();
  s.originalAssessment.findings[0].evidenceIds.push("ev-xx");
  const r = validateSnapshot(s);
  check(
    "a) 检出不存在的证据引用",
    r.ok === false && r.errors.some((e) => e.includes("finding[f1] 引用了不存在的证据: ev-xx")),
    r.errors.join(" | ")
  );
}

// 2b. 重复证据 id
{
  const s = baseSnapshot();
  s.evidence.push({ ...s.evidence[0], capturedAt: now });
  const r = validateSnapshot(s);
  check(
    "b) 检出重复证据 id",
    r.ok === false && r.errors.some((e) => e === "证据 id 重复: ev-1"),
    r.errors.join(" | ")
  );
}

// 2c. risk="unknown" 但 unknowns 为空
{
  const s = baseSnapshot();
  s.originalAssessment.risk = "unknown";
  const r = validateSnapshot(s);
  check(
    "c) 检出 unknown 无未知事项 [warn]",
    r.ok === false &&
      r.errors.some((e) => e.startsWith("[warn]") && e.includes("risk 为 unknown")),
    r.errors.join(" | ")
  );
}

// 2d. inference 自引用
{
  const s = baseSnapshot();
  s.originalAssessment.findings[1].evidenceIds = ["f2", "ev-2"];
  const r = validateSnapshot(s);
  check(
    "d) 检出 inference 自引用",
    r.ok === false && r.errors.some((e) => e === "finding[f2] 引用了自身"),
    r.errors.join(" | ")
  );
}

const failed = results.filter((v) => !v).length;
console.log(failed === 0 ? "ALL-PASS" : `FAIL(${failed})`);
process.exit(failed === 0 ? 0 : 1);
