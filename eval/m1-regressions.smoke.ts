/**
 * M1-3/M1-4/M1-6 的离线回归（不访问目标站点、不调用真实模型）。
 * 运行：node eval/m1-regressions.smoke.ts
 */
import { analyzeUrlStatic } from "../lib/tools/url-static.ts";
import type { FetchPageResult, PageEvidence } from "../lib/tools/fetch-page.ts";
import { runScan } from "../lib/agent/orchestrator.ts";
import { chat } from "../lib/models.ts";
import type { ChatMessage, ChatResult } from "../lib/models.ts";
import { fetchPage } from "../lib/tools/fetch-page.ts";
import { validateSnapshot } from "../lib/evidence/validate.ts";

const now = "2026-10-29T10:00:00.000Z";
let failures = 0;

function check(name: string, passed: boolean, detail = ""): void {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function assessment(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    risk: "unknown",
    evidenceSufficiency: "insufficient",
    gaps: ["未取得页面 DOM 证据"],
    summary: "页面信息不足，无法判断。",
    findings: [],
    unknowns: ["页面表单是否存在未知。"],
    recommendedAction: "证据不足，建议人工复核。",
    ...overrides,
  });
}

function capturedPage(evidence: PageEvidence[], warnings: string[] = []): FetchPageResult {
  return {
    blocked: false,
    startUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    redirectChain: ["https://example.com/"],
    evidence,
    warnings,
    blockedRequests: [],
    elapsedMs: 12,
  };
}

const textEvidence: PageEvidence = {
  id: "ev-text-1",
  capturedAt: now,
  type: "text",
  source: "fixture:document.text",
  title: "Example",
  text: "Example page",
  truncated: false,
};

const emptyFormsEvidence: PageEvidence = {
  id: "ev-forms-2",
  capturedAt: now,
  type: "forms",
  source: "fixture:document.forms",
  forms: [],
};

const emptyScriptsEvidence: PageEvidence = {
  id: "ev-scripts-3",
  capturedAt: now,
  type: "externalScripts",
  source: "fixture:script[src]",
  domains: [],
  scripts: [],
};

async function scanFixture(options: {
  evidence: PageEvidence[];
  warnings?: string[];
  replies: string[];
  onMessages?: (calls: ChatMessage[][]) => void;
}) {
  const calls: ChatMessage[][] = [];
  const staticReport = analyzeUrlStatic("https://example.com/");
  const snapshot = await runScan(
    "https://example.com/",
    () => undefined,
    {
      services: {
        guard: async () => ({ allowed: true, resolvedIps: ["93.184.216.34"] }),
        analyzeUrl: () => staticReport,
        fetchPage: async () => capturedPage(options.evidence, options.warnings),
        visionChat: async () => ({ content: "", toolCalls: [] }),
        chat: async (messages): Promise<ChatResult> => {
          calls.push(messages.map((message) => ({ ...message })));
          return { content: options.replies.shift() ?? "{}", toolCalls: [] };
        },
      },
    },
  );
  options.onMessages?.(calls);
  return snapshot;
}

// 1. DOM/表单未采到：不能制造“页面没有表单”的反向事实。
{
  let calls: ChatMessage[][] = [];
  const snapshot = await scanFixture({
    evidence: [],
    warnings: ["DOM 证据采集失败：测试用模拟中断"],
    replies: [assessment()],
    onMessages: (value) => { calls = value; },
  });
  const analyzerMessage = String(calls[0]?.at(-1)?.content ?? "");
  check("未采集表单不生成否定证据", !snapshot.evidence.some((item) => item.id === "ev-form-none"));
  check("模型输入明确表示表单未采集", analyzerMessage.includes("表单未成功采集"));
  check("模型输入不声称页面没有表单", !analyzerMessage.includes("页面未发现表单"));
  check("覆盖如实显示取证不完整", snapshot.coverage.some((item) => item.step === "gate2-fetch" && item.state === "partial"));
}

// 2. DOM 成功且空表单：只有这种路径可建立“未发现表单”证据。
{
  let calls: ChatMessage[][] = [];
  const snapshot = await scanFixture({
    evidence: [textEvidence, emptyFormsEvidence, emptyScriptsEvidence],
    replies: [assessment({ findings: [{ id: "f1", statement: "页面未发现表单", kind: "observed_fact", evidenceIds: ["ev-form-none"], alternativeExplanations: [] }] })],
    onMessages: (value) => { calls = value; },
  });
  const analyzerMessage = String(calls[0]?.at(-1)?.content ?? "");
  check("成功采集的空表单生成事实证据", snapshot.evidence.some((item) => item.id === "ev-form-none"));
  check("成功采集的空表单可被模型引用", analyzerMessage.includes("[ev-form-none] 页面未发现表单"));
  check("空脚本列表只在采集成功时记录", snapshot.evidence.some((item) => item.id === "ev-scripts" && item.excerpt?.includes("未发现第三方")));
}

// 3. 无依据 finding 只允许一轮修复；仍无依据则移除、记录缺口并降低风险措辞。
{
  const invalidThenInvalid = assessment({
    risk: "high",
    evidenceSufficiency: "sufficient",
    gaps: [],
    unknowns: [],
    summary: "已确认页面高度危险。",
    findings: [
      { id: "f-unsupported", statement: "无证据的可疑说法", kind: "observed_fact", evidenceIds: ["not-in-evidence"], alternativeExplanations: [] },
      { id: "f-supported", statement: "用户输入了 example.com", kind: "observed_fact", evidenceIds: ["ev-url"], alternativeExplanations: [] },
    ],
  });
  let calls: ChatMessage[][] = [];
  const snapshot = await scanFixture({
    evidence: [],
    warnings: ["DOM 证据采集失败：测试用模拟中断"],
    replies: [invalidThenInvalid, invalidThenInvalid],
    onMessages: (value) => { calls = value; },
  });
  const result = snapshot.originalAssessment;
  check("无依据 finding 最多触发一次修复", calls.length === 2, `调用 ${calls.length} 次`);
  check("修复提示不回送模型自由文本", !String(calls[1]?.at(-1)?.content ?? "").includes("无证据的可疑说法"));
  check("无依据 observed_fact 被删除而非改标 inference", !result.findings.some((finding) => finding.id === "f-unsupported"));
  check("保留有依据的 finding", result.findings.some((finding) => finding.id === "f-supported"));
  check("无效结论后风险降为无法判断", result.risk === "unknown");
  check("无效结论计入 gaps 且摘要降措辞", result.gaps.some((gap) => gap.includes("已移除")) && result.summary.includes("风险暂无法判断"));
  check("摘要不保留已删除 finding 的确定性断言", !result.summary.includes("已确认页面高度危险"));
  check("coverage 中 validate 只有一条", snapshot.coverage.filter((item) => item.step === "validate").length === 1);
  check("最终报告通过证据/coverage 校验", validateSnapshot(snapshot).ok, validateSnapshot(snapshot).errors.join(" | "));
}

// 4. 空/损坏的 findings 不能支撑 high 或 no-significant-risk 定级。
{
  const unsupportedRisk = assessment({
    risk: "high",
    evidenceSufficiency: "sufficient",
    gaps: [],
    summary: "目标高度危险。",
    findings: [],
    unknowns: [],
  });
  const noFindings = await scanFixture({
    evidence: [],
    warnings: ["DOM 证据采集失败：测试用模拟中断"],
    replies: [unsupportedRisk, unsupportedRisk],
  });
  check("没有有效 finding 的非 unknown 风险被降级", noFindings.originalAssessment.risk === "unknown");
  check("空 findings 的摘要不保留风险断言", !noFindings.originalAssessment.summary.includes("目标高度危险"));

  const malformedFindings = assessment({
    risk: "high",
    evidenceSufficiency: "sufficient",
    gaps: [],
    findings: {},
    unknowns: [],
  });
  const malformed = await scanFixture({
    evidence: [],
    warnings: ["DOM 证据采集失败：测试用模拟中断"],
    replies: [malformedFindings, malformedFindings],
  });
  check("非数组 findings 触发有限重试并拒绝高风险结果", malformed.originalAssessment.risk === "unknown");
}

// 5. 快照校验器也拒绝空推断和重复 coverage，防止其他调用方绕过编排器。
{
  const base = await scanFixture({
    evidence: [textEvidence, emptyFormsEvidence, emptyScriptsEvidence],
    replies: [assessment()],
  });
  const emptyInference = structuredClone(base);
  emptyInference.originalAssessment.findings = [
    { id: "f-empty", statement: "没有任何依据", kind: "inference", evidenceIds: [], alternativeExplanations: [] },
  ];
  const inferenceValidation = validateSnapshot(emptyInference);
  check("校验器拒绝空依据 inference", !inferenceValidation.ok && inferenceValidation.errors.some((error) => error.includes("未引用任何证据")));

  const duplicateCoverage = structuredClone(base);
  duplicateCoverage.coverage.push({ ...duplicateCoverage.coverage[0] });
  const coverageValidation = validateSnapshot(duplicateCoverage);
  check("校验器拒绝重复 coverage step", !coverageValidation.ok && coverageValidation.errors.some((error) => error.includes("coverage.step 重复")));
}

// 5. 请求取消在进入网络/浏览器之前，以及模型请求重试路径中生效。
{
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled fixture", "AbortError"));
  let browserAbortRejected = false;
  try {
    await fetchPage("https://example.com/", { signal: controller.signal });
  } catch (error) {
    browserAbortRejected = error instanceof Error && error.name === "AbortError";
  }
  check("已取消的浏览器采集在启动前退出", browserAbortRejected);

  const previousBaseUrl = process.env.VERIPAGE_AGNES_BASE_URL;
  const previousApiKey = process.env.VERIPAGE_AGNES_API_KEY;
  const originalFetch = globalThis.fetch;
  let modelFetches = 0;
  try {
    process.env.VERIPAGE_AGNES_BASE_URL = "https://model.invalid/v1";
    process.env.VERIPAGE_AGNES_API_KEY = "offline-fixture";
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      modelFetches += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;

    const modelController = new AbortController();
    const pending = chat([{ role: "user", content: "offline cancellation fixture" }], {
      signal: modelController.signal,
      retries: 3,
    });
    await Promise.resolve();
    modelController.abort(new DOMException("cancelled fixture", "AbortError"));
    let modelAbortRejected = false;
    try {
      await pending;
    } catch (error) {
      modelAbortRejected = error instanceof Error && error.name === "AbortError";
    }
    check("已取消的模型请求立即退出且不重试", modelAbortRejected && modelFetches === 1, `请求数 ${modelFetches}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousBaseUrl === undefined) delete process.env.VERIPAGE_AGNES_BASE_URL;
    else process.env.VERIPAGE_AGNES_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.VERIPAGE_AGNES_API_KEY;
    else process.env.VERIPAGE_AGNES_API_KEY = previousApiKey;
  }
}

console.log(failures === 0 ? "ALL-PASS" : `FAIL(${failures})`);
process.exit(failures === 0 ? 0 : 1);
