/**
 * M4 知识接线冒烟（离线）：知识证据进编排器 + 措辞纪律 + 有界补证轮 + 注入缝契约
 * 运行：node eval/m4-knowledge.smoke.ts
 *
 * 离线边界：
 *  - 页面内容一律来自本地 127.0.0.1 HTTP fixture（参考 eval/workbench.e2e.mjs 的 mock 手法），
 *    不访问任何外部站点；S0 访问边界默认拒绝回环地址，fixture 显式注入放行并注明原因。
 *  - 视觉/主分析模型用桩替身，不花真钱；kbLookup/ragSearch 默认走 lib/knowledge 真函数（纯本地 JSON），
 *    消融用例注入空库桩验证跨任务注入缝。
 */
import { createServer, get as httpGet, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { runScan, type ScanEvent, type ScanServices } from "../lib/agent/orchestrator.ts";
import { validateSnapshot } from "../lib/evidence/validate.ts";
import type { CaseSnapshot } from "../lib/evidence/types.ts";
import { PROMPT_VERSION } from "../lib/prompts/analyzer.ts";
import { KNOWLEDGE_VERSION } from "../lib/knowledge/index.ts";
import type { ChatMessage, ChatResult } from "../lib/models.ts";
import type { FetchPageResult, PageEvidence } from "../lib/tools/fetch-page.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` | ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 本地 HTTP fixture + 采集桩
// ---------------------------------------------------------------------------

/** 起一个只回固定 HTML 的本地服务（随机端口，测试结束关闭） */
function startFixtureServer(html: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/fixture`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

/**
 * 拉取本地 fixture HTML 并组装 PageEvidence（不启动 Playwright，保持轻量离线）。
 * 导航记录（startUrl/finalUrl/redirectChain）按被扫描 URL 记——fixture 只提供页面内容，
 * 跳转链不指向 127.0.0.1，否则本地服务地址会被误判为第三方「新域」。
 */
async function fetchLocalPage(scannedUrl: string, fixtureUrl: string): Promise<FetchPageResult> {
  const html = await new Promise<string>((resolve, reject) => {
    httpGet(fixtureUrl, (res: IncomingMessage) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  const capturedAt = new Date().toISOString();
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const action = /<form[^>]*action=["']?([^"'\s>]+)/i.exec(html)?.[1] ?? "";
  const hasPassword = /type=["']?password/i.test(html);
  const selfHost = new URL(fixtureUrl).hostname;
  const scriptDomains = [...html.matchAll(/<script[^>]*src=["']?([^"'\s>]+)/gi)]
    .map((m) => {
      try {
        return new URL(m[1], fixtureUrl).hostname;
      } catch {
        return "";
      }
    })
    .filter((d) => d !== "" && d !== selfHost);
  const evidence: PageEvidence[] = [
    { id: "fx-text", capturedAt, type: "text", source: "fixture:http", title, text, truncated: false },
    {
      id: "fx-forms",
      capturedAt,
      type: "forms",
      source: "fixture:http",
      forms: [{ action, method: "post", hasPasswordInput: hasPassword, inputCount: 2 }],
    },
    { id: "fx-scripts", capturedAt, type: "externalScripts", source: "fixture:http", domains: scriptDomains, scripts: [] },
  ];
  return {
    blocked: false,
    startUrl: scannedUrl,
    finalUrl: scannedUrl,
    redirectChain: [scannedUrl],
    evidence,
    warnings: [],
    blockedRequests: [],
    elapsedMs: 5,
  };
}

const stubGuard = async (): Promise<{ allowed: true; resolvedIps: string[] }> => ({
  allowed: true,
  resolvedIps: ["127.0.0.1"],
});

/** 主分析桩：按序返回 canned 回复并记录每次调用的 messages */
function stubChat(replies: string[], calls: ChatMessage[][]) {
  return async (messages: ChatMessage[]): Promise<ChatResult> => {
    calls.push(messages.map((m) => ({ ...m })));
    return { content: replies.shift() ?? "{}", toolCalls: [] };
  };
}

function assessmentJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    risk: "unknown",
    evidenceSufficiency: "partial",
    gaps: [],
    summary: "基于现有证据的初步判断。",
    findings: [],
    unknowns: [],
    recommendedAction: "建议人工复核。",
    ...overrides,
  });
}

/** 注入桩跑一次完整 runScan；返回快照与主分析调用记录 */
async function runFixture(options: {
  scanUrl: string;
  fixtureUrl: string;
  replies: string[];
  fetchPage?: () => Promise<FetchPageResult>;
  services?: Partial<ScanServices>;
}): Promise<{ snapshot: CaseSnapshot; calls: ChatMessage[][] }> {
  const calls: ChatMessage[][] = [];
  const snapshot = await runScan(options.scanUrl, () => undefined, {
    services: {
      // S0 会拒绝回环地址；离线 fixture 需要本地 HTTP 页面，这里显式放行并记录
      guard: stubGuard,
      fetchPage: options.fetchPage ?? (() => fetchLocalPage(options.scanUrl, options.fixtureUrl)),
      visionChat: async () => ({ content: "", toolCalls: [] }),
      chat: stubChat(options.replies, calls),
      ...options.services,
    },
  });
  return { snapshot, calls };
}

const FORBIDDEN = /未授权|冒用|无风险/;
const snapshots: CaseSnapshot[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

/** 措辞纪律统一断言：证据与摘要不得出现「未授权/冒用/无风险」 */
function assertDiscipline(snapshot: CaseSnapshot, label: string): void {
  const texts: string[] = [];
  for (const e of snapshot.evidence) texts.push(e.excerpt ?? "", e.locator ?? "");
  const a = snapshot.originalAssessment;
  texts.push(a.summary, ...a.gaps, ...a.unknowns, ...a.findings.map((f) => f.statement));
  const hit = texts.filter((t) => FORBIDDEN.test(t));
  check(`${label}：措辞不含 未授权/冒用/无风险`, hit.length === 0, hit.slice(0, 2).join("；"));
}

async function withServer(html: string): Promise<string> {
  const server = await startFixtureServer(html);
  servers.push(server);
  return server.url;
}

// ---------------------------------------------------------------------------
// 1. 品牌矛盾检出：页面自称淘宝网，域名不在官方域白名单
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(
    `<html><head><title>淘宝网 - 账号登录</title></head><body><h1>淘宝网</h1>统一登录，请输入账号和密码</body></html>`,
  );
  const reply = assessmentJson({
    risk: "suspicious",
    evidenceSufficiency: "partial",
    summary: "页面自称淘宝网，但域名归属未获白名单证实。",
    findings: [
      {
        id: "f1",
        statement: "页面自称淘宝网，但其域名未收录于淘宝官方域白名单，身份声明未获证实",
        kind: "inference",
        evidenceIds: ["ev-knowledge-brand", "ev-title"],
        alternativeExplanations: ["白名单可能未覆盖新站或小型网站"],
      },
    ],
  });
  const { snapshot, calls } = await runFixture({ scanUrl: "http://ta0wang-login.example/login", fixtureUrl, replies: [reply] });
  snapshots.push(snapshot);

  const brand = snapshot.evidence.find((e) => e.id === "ev-knowledge-brand");
  check("品牌矛盾 fixture 产出 ev-knowledge-brand", brand !== undefined);
  check("未收录事实写进证据摘录", brand?.excerpt?.includes("未收录于官方域白名单") === true, brand?.excerpt?.slice(0, 60));
  check("主分析器首调输入含知识证据段与 id", String(calls[0]?.[1]?.content ?? "").includes("[ev-knowledge-brand]"));
  check("结论引用知识证据且通过校验", snapshot.originalAssessment.findings.some((f) => f.evidenceIds.includes("ev-knowledge-brand")));
  check("versions.knowledge 非 none-v1", snapshot.versions.knowledge !== "none-v1", snapshot.versions.knowledge);
  check("versions.knowledge = 真实知识库版本", snapshot.versions.knowledge === KNOWLEDGE_VERSION, snapshot.versions.knowledge);
  check("提示词版本 1.1.0", PROMPT_VERSION === "1.1.0", PROMPT_VERSION);
  check("模型调用 1 次", calls.length === 1, String(calls.length));
  assertDiscipline(snapshot, "品牌矛盾 fixture");
  const hardErrors = validateSnapshot(snapshot).errors.filter((e) => !e.startsWith("[warn]"));
  check("品牌矛盾快照硬错误为 0", hardErrors.length === 0, hardErrors.join(" | "));
}

// ---------------------------------------------------------------------------
// 2. SSO 已收录标注：表单提交到 graph.qq.com + 脚本用 jsDelivr
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(
    `<html><head><title>商城快捷登录</title></head><body>使用第三方账号登录` +
      `<form action="https://graph.qq.com/connect" method="post"><input type="password"></form>` +
      `<script src="https://cdn.jsdelivr.net/npm/lib.js"></script></body></html>`,
  );
  const { snapshot, calls } = await runFixture({
    scanUrl: "http://shop-signin.example/signin",
    fixtureUrl,
    replies: [assessmentJson()],
  });
  snapshots.push(snapshot);

  const sso = snapshot.evidence.find((e) => e.id === "ev-knowledge-sso");
  check("第三方目标域核验产出 ev-knowledge-sso", sso !== undefined);
  check("SSO 命中话术=已收录授权登录/公共服务", sso?.excerpt?.includes("已收录授权登录/公共服务") === true, sso?.excerpt?.slice(0, 80));
  check("命中 QQ 互联与 jsDelivr 两项", (sso?.excerpt ?? "").includes("QQ 互联") && (sso?.excerpt ?? "").includes("jsDelivr"));
  check("首调输入含 [ev-knowledge-sso]", String(calls[0]?.[1]?.content ?? "").includes("[ev-knowledge-sso]"));
  assertDiscipline(snapshot, "SSO 命中 fixture");
  check("SSO 快照硬错误为 0", validateSnapshot(snapshot).errors.filter((e) => !e.startsWith("[warn]")).length === 0);
}

// ---------------------------------------------------------------------------
// 3. 第三方域未收录：只写「未在本库收录」，不写未授权/冒用
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(
    `<html><head><title>会员验证</title></head><body>请完成验证` +
      `<form action="https://collect.example.net/submit" method="post"></form></body></html>`,
  );
  const { snapshot } = await runFixture({
    scanUrl: "http://member-verify.example/verify",
    fixtureUrl,
    replies: [assessmentJson()],
  });
  snapshots.push(snapshot);

  const sso = snapshot.evidence.find((e) => e.id === "ev-knowledge-sso");
  check("未收录第三方域仍产出核验证据", sso !== undefined);
  check("未收录话术=未在本库收录", sso?.excerpt?.includes("未在本库收录") === true, sso?.excerpt?.slice(0, 90));
  check("未收录话术不含授权判断", (sso?.excerpt ?? "").includes("收录状态不代表该域可信与否") === true);
  assertDiscipline(snapshot, "SSO 未收录 fixture");
}

// ---------------------------------------------------------------------------
// 4. 相似历史案例：紧迫话术命中 case-urgency
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(
    `<html><head><title>安全提醒</title></head><body>您的账户存在异常，请在24小时内验证，否则将被冻结</body></html>`,
  );
  const { snapshot } = await runFixture({
    scanUrl: "http://notice-alert.example/verify",
    fixtureUrl,
    replies: [assessmentJson()],
  });
  snapshots.push(snapshot);

  const cases = snapshot.evidence.find((e) => e.id === "ev-knowledge-cases");
  check("紧迫话术命中历史案例证据", cases !== undefined);
  check("案例证据含 case-urgency 与纪律尾注", (cases?.excerpt ?? "").includes("case-urgency") && (cases?.excerpt ?? "").includes("不证明当前页面恶意"));
  assertDiscipline(snapshot, "案例命中 fixture");
}

// ---------------------------------------------------------------------------
// 5. 有界补证轮：gaps 指向品牌核验 + 跳转链有新域 → 补证后共 2 次调用
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(`<html><head><title>确认订单</title></head><body>确认订单信息</body></html>`);
  const fetchPage = async (): Promise<FetchPageResult> => {
    const page = await fetchLocalPage("http://login-portal.example/", fixtureUrl);
    return {
      ...page,
      redirectChain: ["http://login-portal.example/", "http://pay-confirm.example.net/next"],
    };
  };
  const replies = [
    assessmentJson({
      gaps: ["需核验跳转目标域名的品牌归属与收录情况"],
      findings: [
        { id: "f1", statement: "页面发生了跳转", kind: "observed_fact", evidenceIds: ["ev-redirect"], alternativeExplanations: [] },
      ],
    }),
    assessmentJson({
      summary: "跳转目标域名归属未知",
      findings: [
        {
          id: "f2",
          statement: "跳转目标域名未收录于官方域白名单，归属未知",
          kind: "observed_fact",
          evidenceIds: ["ev-knowledge-sup-1"],
          alternativeExplanations: [],
        },
      ],
    }),
  ];
  const { snapshot, calls } = await runFixture({ scanUrl: "http://login-portal.example/", fixtureUrl, replies, fetchPage });
  snapshots.push(snapshot);

  check("补证轮触发后总调用 ≤2", calls.length === 2, String(calls.length));
  check("补证证据 ev-knowledge-sup-1 入池", snapshot.evidence.some((e) => e.id === "ev-knowledge-sup-1"));
  check("第二次调用输入含补证证据 id", calls[1]?.some((m) => String(m.content).includes("[ev-knowledge-sup-1]")) === true);
  check("补证证据写明跳转新域", (snapshot.evidence.find((e) => e.id === "ev-knowledge-sup-1")?.excerpt ?? "").includes("pay-confirm.example.net"));
  check("补证后结论可绑定新证据", snapshot.originalAssessment.findings.some((f) => f.evidenceIds.includes("ev-knowledge-sup-1")));
  assertDiscipline(snapshot, "补证轮 fixture");
  check("补证轮快照硬错误为 0", validateSnapshot(snapshot).errors.filter((e) => !e.startsWith("[warn]")).length === 0);
}

// ---------------------------------------------------------------------------
// 6. 补证不空转：gaps 提到品牌但无新域可查 → 不消耗第二次调用
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(`<html><head><title>普通页面</title></head><body>普通内容</body></html>`);
  const { snapshot, calls } = await runFixture({
    scanUrl: "http://plain-site.example/",
    fixtureUrl,
    replies: [assessmentJson({ gaps: ["需核验页面品牌归属"] })],
  });
  snapshots.push(snapshot);
  check("无新域可查时不触发补证（1 次调用）", calls.length === 1, String(calls.length));
  check("未产生补证证据", !snapshot.evidence.some((e) => e.id.startsWith("ev-knowledge-sup")));
  assertDiscipline(snapshot, "补证不空转 fixture");
}

// ---------------------------------------------------------------------------
// 7. 补证+修复合并且仍无依据 → finalizeUnsupportedFindings 降级，不硬猜
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(`<html><head><title>确认订单</title></head><body>确认订单信息</body></html>`);
  const fetchPage = async (): Promise<FetchPageResult> => {
    const page = await fetchLocalPage("http://login-portal.example/", fixtureUrl);
    return {
      ...page,
      redirectChain: ["http://login-portal.example/", "http://pay-confirm.example.net/next"],
    };
  };
  const unsupported = assessmentJson({
    risk: "high",
    evidenceSufficiency: "sufficient",
    gaps: ["需核验跳转目标域名的品牌归属"],
    summary: "已确认是钓鱼网站。",
    findings: [
      { id: "fx", statement: "这是钓鱼网站，凭据将被窃取", kind: "observed_fact", evidenceIds: ["ev-not-real"], alternativeExplanations: [] },
    ],
  });
  const { snapshot, calls } = await runFixture({
    scanUrl: "http://login-portal.example/",
    fixtureUrl,
    replies: [unsupported, unsupported],
    fetchPage,
  });
  snapshots.push(snapshot);

  check("补证+修复合并后总调用 ≤2", calls.length === 2, String(calls.length));
  check("补证证据仍入池", snapshot.evidence.some((e) => e.id === "ev-knowledge-sup-1"));
  const a = snapshot.originalAssessment;
  check("两轮后仍无依据 → risk=unknown", a.risk === "unknown", a.risk);
  check("无依据结论被移除", !a.findings.some((f) => f.id === "fx"));
  check("降级写进 gaps 与摘要", a.gaps.some((g) => g.includes("已移除")) && a.summary.includes("风险暂无法判断"));
  check("降级摘要不保留原断言", !a.summary.includes("已确认是钓鱼网站"));
  assertDiscipline(snapshot, "补证降级 fixture");
  check("降级快照硬错误为 0", validateSnapshot(snapshot).errors.filter((e) => !e.startsWith("[warn]")).length === 0);
}

// ---------------------------------------------------------------------------
// 8. 注入缝契约（P3 消融用）：空库桩替换 kbLookup/ragSearch
// ---------------------------------------------------------------------------
{
  const fixtureUrl = await withServer(
    `<html><head><title>快捷登录</title></head><body>第三方登录` +
      `<form action="https://graph.qq.com/connect" method="post"></form>` +
      `<script src="https://cdn.jsdelivr.net/npm/lib.js"></script></body></html>`,
  );
  const emptyKb = (domain: string) => ({
    domain,
    brand: { hit: false, note: "空库桩：未收录" as const },
    thirdParty: { hit: false },
    knowledgeVersion: "ablation-empty-v0",
  });
  const { snapshot, calls } = await runFixture({
    scanUrl: "http://shop-signin.example/signin",
    fixtureUrl,
    replies: [assessmentJson()],
    services: {
      kbLookup: emptyKb,
      ragSearch: () => ({ matches: [], knowledgeVersion: "ablation-empty-v0", emptyReason: "空库桩无案例" }),
    },
  });
  snapshots.push(snapshot);

  check("versions.knowledge 随注入桩报告", snapshot.versions.knowledge === "ablation-empty-v0", snapshot.versions.knowledge);
  const sso = snapshot.evidence.find((e) => e.id === "ev-knowledge-sso");
  check("空库下 SSO 证据如实未收录", sso?.excerpt?.includes("未在本库收录") === true, sso?.excerpt?.slice(0, 80));
  check("空库下不再出现已收录话术", sso?.excerpt?.includes("已收录授权登录/公共服务") === false);
  check("空库无案例命中 → 无 ev-knowledge-cases", !snapshot.evidence.some((e) => e.id === "ev-knowledge-cases"));
  check("空库品牌证据仍记录未收录事实", snapshot.evidence.some((e) => e.id === "ev-knowledge-brand" && e.excerpt?.includes("未收录于官方域白名单")));
  check("空库快照不出现无风险结论", !snapshot.evidence.some((e) => (e.excerpt ?? "").includes("无风险")));
  check("空库下模型调用 1 次", calls.length === 1, String(calls.length));
  assertDiscipline(snapshot, "空库消融 fixture");
  check("空库快照硬错误为 0", validateSnapshot(snapshot).errors.filter((e) => !e.startsWith("[warn]")).length === 0);
}

// ---------------------------------------------------------------------------
// 9. S0 拒绝路径：不产知识证据，versions.knowledge 仍记录引擎知识库版本
// ---------------------------------------------------------------------------
{
  const events: ScanEvent[] = [];
  const snapshot = await runScan("http://192.168.1.1/", (ev) => {
    events.push(ev);
  });
  snapshots.push(snapshot);
  check("S0 拒绝路径无知识证据", !snapshot.evidence.some((e) => e.id.startsWith("ev-knowledge")));
  check("S0 拒绝路径 versions.knowledge=引擎版本", snapshot.versions.knowledge === KNOWLEDGE_VERSION, snapshot.versions.knowledge);
  check("S0 拒绝路径未调用主分析", !events.some((e) => e.type === "step" && e.step === "gate3-analyzer" && e.state === "completed"));
  check("S0 快照硬错误为 0", validateSnapshot(snapshot).errors.filter((e) => !e.startsWith("[warn]")).length === 0);
}

// ---------------------------------------------------------------------------
// 收尾：全量措辞纪律 + 关闭 fixture 服务
// ---------------------------------------------------------------------------
check("全部快照 versions.knowledge ≠ none-v1", snapshots.every((s) => s.versions.knowledge !== "none-v1"));
for (const server of servers) await server.close();

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
