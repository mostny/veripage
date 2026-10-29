/**
 * 检测编排器：把 S0 边界 + 三道闸门串成一条流水线，产出可校验的 CaseSnapshot
 *
 * 流程：S0 访问边界 → 闸门① 静态分析 → 闸门② 沙箱代访 → 闸门③ 视觉核验 + 主分析 → 快照组装与校验
 * 每个阶段通过 onEvent 向外发 step 事件（前端 SSE 时间线的来源）；
 * 任何失败都不抛异常：降级为结构化结果（risk=unknown + gaps），取证不完整在 coverage 中诚实可见。
 *
 * 证据 id 一致性（本模块的接线核心）：
 *   快照 evidence[].id 与 buildAnalyzerUserMessage 列出的证据 id 来自同一份数据源，
 *   模型 findings 引用的 id 才能通过 validateSnapshot 的绑定校验。
 */

import { assertPublicHttpUrl } from "../guard/access.ts";
import { analyzeUrlStatic } from "../tools/url-static.ts";
import { fetchPage } from "../tools/fetch-page.ts";
import { chat, visionChat, type ChatMessage } from "../models.ts";
import {
  analyzerSystemPrompt,
  visionAnalysisPrompt,
  buildAnalyzerUserMessage,
  PROMPT_VERSION,
  type AnalyzerEvidenceInput,
} from "../prompts/analyzer.ts";
import { validateSnapshot } from "../evidence/validate.ts";
import type {
  Assessment,
  CaseSnapshot,
  CoverageEntry,
  EvidenceItem,
  Finding,
  RiskLevel,
} from "../evidence/types.ts";

export type ScanStepName =
  | "s0-guard"
  | "gate1-static"
  | "gate2-fetch"
  | "gate3-vision"
  | "gate3-analyzer"
  | "validate";

export type ScanEvent =
  | {
      type: "step";
      step: ScanStepName;
      state: "completed" | "partial" | "skipped" | "failed";
      detail?: string;
      reason?: string;
    }
  | { type: "report"; snapshot: CaseSnapshot };

const RISK_ENUM: readonly RiskLevel[] = ["high", "suspicious", "no_significant_risk", "unknown"];

function nowIso(): string {
  return new Date().toISOString();
}

/** 从模型输出中剥围栏并解析 JSON；失败返回 null */
function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 把模型 JSON 收敛成合法 Assessment；结构不合法返回 null */
function coerceAssessment(raw: unknown): Assessment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const risk = r.risk as RiskLevel;
  const suff = r.evidenceSufficiency as Assessment["evidenceSufficiency"];
  if (!RISK_ENUM.includes(risk)) return null;
  if (!["sufficient", "partial", "insufficient"].includes(suff)) return null;
  const findings: Finding[] = Array.isArray(r.findings)
    ? (r.findings as Record<string, unknown>[])
        .filter((f) => f && typeof f.id === "string" && typeof f.statement === "string")
        .map((f, i) => ({
          id: String(f.id) || `f${i + 1}`,
          statement: String(f.statement),
          kind: (["observed_fact", "inference", "reference"].includes(String(f.kind))
            ? f.kind
            : "inference") as Finding["kind"],
          evidenceIds: Array.isArray(f.evidenceIds) ? f.evidenceIds.map(String) : [],
          alternativeExplanations: Array.isArray(f.alternativeExplanations)
            ? f.alternativeExplanations.map(String)
            : [],
        }))
    : [];
  return {
    risk,
    evidenceSufficiency: suff,
    gaps: Array.isArray(r.gaps) ? r.gaps.map(String) : [],
    summary: typeof r.summary === "string" ? r.summary : "",
    findings,
    unknowns: Array.isArray(r.unknowns) ? r.unknowns.map(String) : [],
    recommendedAction:
      typeof r.recommendedAction === "string" ? r.recommendedAction : "建议通过官方渠道独立核实。",
  };
}

/** 主分析：两轮重试内的 JSON 收敛；两轮都失败返回 null（走兜底） */
async function runAnalyzer(input: AnalyzerEvidenceInput): Promise<Assessment | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: analyzerSystemPrompt() },
    { role: "user", content: buildAnalyzerUserMessage(input) },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await chat(messages, { temperature: 0.2, maxTokens: 2000 });
    const assessment = coerceAssessment(extractJson(result.content));
    if (assessment) return assessment;
    if (attempt === 0) {
      messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content: "上一次输出无法解析为合法 JSON（或枚举非法），请严格只输出一个 JSON 对象，不要任何其他文字。",
      });
    }
  }
  return null;
}

export async function runScan(rawUrl: string, onEvent: (ev: ScanEvent) => void): Promise<CaseSnapshot> {
  const capturedAt = nowIso();
  const coverage: CoverageEntry[] = [];
  const evidence: EvidenceItem[] = [];
  const artifactIds: string[] = [];
  const gaps: string[] = [];

  const emitStep = (
    step: ScanStepName,
    state: CoverageEntry["state"],
    detail?: string,
    reason?: string,
  ): void => {
    coverage.push({ step, state, reason });
    onEvent({ type: "step", step, state, detail, reason });
  };

  // ---- S0 访问边界 ---------------------------------------------------------
  const guard = await assertPublicHttpUrl(rawUrl.trim());
  if (!guard.allowed) {
    // 阻断路径也要留下可解析的主域记录（校验要求非空）
    let blockedDomain = "(未知)";
    try {
      const u = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
      blockedDomain = u.hostname || "(未知)";
    } catch {
      // 保持 "(未知)"
    }
    emitStep("s0-guard", "completed", undefined, guard.reason);
    emitStep("gate1-static", "completed", "S0 已拒绝，静态分析仍执行（纯本地）");
    emitStep("gate2-fetch", "skipped", undefined, "访问边界拒绝");
    emitStep("gate3-vision", "skipped", undefined, "访问边界拒绝");
    emitStep("gate3-analyzer", "skipped", undefined, "访问边界拒绝");

    evidence.push({
      id: "ev-url",
      type: "url",
      capturedAt,
      source: "user-input",
      excerpt: rawUrl,
    });
    evidence.push({
      id: "ev-s0-reject",
      type: "request",
      capturedAt,
      source: "guard:assertPublicHttpUrl",
      excerpt: guard.reason,
    });
    gaps.push(`S0 访问边界拒绝：${guard.reason}`);

    const snapshot: CaseSnapshot = {
      id: crypto.randomUUID(),
      createdAt: capturedAt,
      inputSummary: { displayUrl: rawUrl, registrableDomain: blockedDomain },
      versions: buildVersions(),
      originalAssessment: {
        risk: "unknown",
        evidenceSufficiency: "insufficient",
        gaps,
        summary: `该 URL 被访问边界拒绝，未执行任何页面取证：${guard.reason}`,
        findings: [
          {
            id: "f1",
            statement: `URL 目标被判定为不可访问（${guard.reason ?? "访问边界拒绝"}）`,
            kind: "observed_fact",
            evidenceIds: ["ev-s0-reject"],
            alternativeExplanations: ["目标确属内网/保留地址，可能是合法的内网服务，与钓鱼无关"],
          },
        ],
        unknowns: ["未执行页面取证，页面内容与真实行为未知"],
        recommendedAction: "该目标不适用本工具的网页核验（内网/保留地址），如需检测请提供公网页面。",
      },
      coverage,
      evidence,
      artifactIds: [],
    };
    return finish(snapshot, onEvent, emitStep);
  }

  emitStep("s0-guard", "completed", `放行（解析 IP：${guard.resolvedIps?.join(", ") ?? "-"}）`);

  // ---- 闸门① 静态分析 -------------------------------------------------------
  const staticResult = analyzeUrlStatic(rawUrl);
  emitStep(
    "gate1-static",
    "completed",
    `命中 ${staticResult.findings.length} 项，静态分 ${staticResult.score}/100`,
  );
  evidence.push({ id: "ev-url", type: "url", capturedAt, source: "user-input", locator: staticResult.host, excerpt: staticResult.normalizedUrl });
  if (staticResult.findings.length === 0) {
    evidence.push({ id: "ev-static", type: "reputation", capturedAt, source: "rule:url-static", excerpt: "静态规则未命中任何项（静态分 0）" });
  } else {
    for (const f of staticResult.findings) {
      evidence.push({ id: f.id, type: "reputation", capturedAt, source: "rule:url-static", locator: f.title, excerpt: f.detail });
    }
    evidence.push({ id: "ev-static-score", type: "reputation", capturedAt, source: "rule:url-static", excerpt: `静态规则加权分 ${staticResult.score}/100` });
  }

  // ---- 闸门② 沙箱代访 -------------------------------------------------------
  const page = await fetchPage(rawUrl.trim());
  let visionAnswer: string | undefined;
  let pageText: string | undefined;
  let pageTitle: string | undefined;

  if (page.blocked) {
    // S0 已放行但 fetch 内部再次拦截（重绑定等）：按取证失败处理
    emitStep("gate2-fetch", "failed", undefined, page.reason ?? "沙箱代访被拦截");
    gaps.push(`沙箱代访被拦截：${page.reason ?? "未知原因"}`);
  } else if (page.error) {
    emitStep("gate2-fetch", "partial", `已采集 ${page.partialEvidence?.length ?? 0} 项部分证据`, page.error);
    gaps.push(`沙箱代访不完整：${page.error}`);
  } else {
    emitStep("gate2-fetch", "completed", `跳转链 ${page.redirectChain.length} 跳，证据 ${page.evidence.length} 项，耗时 ${page.elapsedMs}ms`);
  }

  const finalUrl = page.finalUrl ?? rawUrl;
  evidence.push({
    id: "ev-redirect",
    type: "redirect",
    capturedAt,
    source: "playwright:redirectChain",
    excerpt: page.redirectChain.join(" → "),
  });

  const textEv = [...page.evidence, ...(page.partialEvidence ?? [])].find((e) => e.type === "text");
  if (textEv && textEv.type === "text") {
    pageTitle = textEv.title;
    pageText = textEv.text;
    evidence.push({ id: "ev-title", type: "text", capturedAt, source: "playwright:document.title", excerpt: textEv.title });
    evidence.push({ id: "ev-text", type: "text", capturedAt, source: "playwright:body.innerText", excerpt: textEv.text.slice(0, 2000) });
  } else {
    gaps.push("未取得页面标题与正文（取证未覆盖）");
  }

  const formsEv = [...page.evidence, ...(page.partialEvidence ?? [])].find((e) => e.type === "forms");
  const forms = formsEv && formsEv.type === "forms" ? formsEv.forms : [];
  if (forms.length > 0) {
    forms.forEach((f, i) => {
      evidence.push({
        id: `ev-form-${i + 1}`,
        type: "form",
        capturedAt,
        source: "playwright:document.forms",
        locator: f.action || "(当前页)",
        excerpt: `action=${f.action || "(空)"} method=${f.method} 密码框=${f.hasPasswordInput ? "有" : "无"} 输入项=${f.inputCount}`,
      });
    });
  } else {
    evidence.push({ id: "ev-form-none", type: "form", capturedAt, source: "playwright:document.forms", excerpt: "页面未发现表单" });
  }

  const scriptsEv = [...page.evidence, ...(page.partialEvidence ?? [])].find((e) => e.type === "externalScripts");
  const externalScriptDomains = scriptsEv && scriptsEv.type === "externalScripts" ? scriptsEv.domains : [];
  if (externalScriptDomains.length > 0) {
    evidence.push({
      id: "ev-scripts",
      type: "request",
      capturedAt,
      source: "playwright:script[src]",
      excerpt: `第三方域脚本：${externalScriptDomains.join(", ")}`,
    });
  }

  const shotEv = [...page.evidence, ...(page.partialEvidence ?? [])].find((e) => e.type === "screenshot");
  const screenshotBase64 = shotEv && shotEv.type === "screenshot" ? shotEv.data : undefined;
  if (screenshotBase64) {
    const artifactId = `art-shot-${crypto.randomUUID().slice(0, 8)}`;
    artifactIds.push(artifactId);
    evidence.push({
      id: "ev-screenshot",
      type: "screenshot",
      capturedAt,
      source: "playwright:page.screenshot(fullPage)",
      locator: artifactId,
      excerpt: "[截图 base64 已存 artifacts]",
    });
  }

  if (page.warnings.length > 0) {
    evidence.push({ id: "ev-warnings", type: "request", capturedAt, source: "fetch-page:warnings", excerpt: page.warnings.join("; ") });
    gaps.push(...page.warnings);
  }

  // ---- 闸门③ 视觉核验 -------------------------------------------------------
  if (screenshotBase64) {
    try {
      const vision = await visionChat(visionAnalysisPrompt(), screenshotBase64, { maxTokens: 500 });
      visionAnswer = vision.content;
      evidence.push({
        id: "ev-vision",
        type: "screenshot",
        capturedAt,
        source: "agnes:visionChat(visionAnalysisPrompt)",
        excerpt: vision.content,
      });
      emitStep("gate3-vision", "completed", `视觉核验完成（${vision.content.length} 字）`);
    } catch (err) {
      emitStep("gate3-vision", "skipped", undefined, `视觉模型调用失败：${err instanceof Error ? err.message : String(err)}`);
      gaps.push("视觉核验未完成");
    }
  } else {
    emitStep("gate3-vision", "skipped", undefined, "无截图可用");
    gaps.push("无截图视觉证据");
  }

  // ---- 闸门③ 主分析 -------------------------------------------------------
  const analyzerInput: AnalyzerEvidenceInput = {
    url: staticResult.normalizedUrl,
    registrableDomain: staticResult.registrableDomain,
    staticFindings: staticResult.findings.map((f) => ({ id: f.id, title: f.title, detail: f.detail, weight: f.weight })),
    staticScore: staticResult.score,
    redirectChain: page.redirectChain,
    pageTitle,
    pageText,
    forms: forms.map((f, i) => ({
      id: `ev-form-${i + 1}`,
      action: f.action,
      method: f.method,
      hasPasswordInput: f.hasPasswordInput,
      inputCount: f.inputCount,
    })),
    externalScriptDomains,
    visionAnswer,
    warnings: page.warnings,
  };

  let assessment: Assessment | null = null;
  if (page.blocked || (page.error && !textEv)) {
    emitStep("gate3-analyzer", "skipped", undefined, "取证数据不足以支撑分析");
    gaps.push("主分析未执行（取证不足）");
  } else {
    try {
      assessment = await runAnalyzer(analyzerInput);
      if (assessment) {
        emitStep("gate3-analyzer", "completed", `结论 risk=${assessment.risk}，findings ${assessment.findings.length} 条`);
      } else {
        emitStep("gate3-analyzer", "failed", undefined, "模型两轮输出均无法解析为合法 JSON");
        gaps.push("AI 分析输出不合法，已使用兜底结论");
      }
    } catch (err) {
      emitStep("gate3-analyzer", "failed", undefined, `模型调用失败：${err instanceof Error ? err.message : String(err)}`);
      gaps.push("AI 分析调用失败");
    }
  }

  const fallback: Assessment = {
    risk: "unknown",
    evidenceSufficiency: "insufficient",
    gaps,
    summary: "AI 分析不可用，已返回取证事实与兜底结论；请结合证据人工判断。",
    findings: [],
    unknowns: ["AI 汇总分析未完成，风险等级未判定"],
    recommendedAction: "建议暂勿输入任何账号密码，并通过官方渠道独立核实该网站。",
  };

  const snapshot: CaseSnapshot = {
    id: crypto.randomUUID(),
    createdAt: capturedAt,
    inputSummary: { displayUrl: staticResult.normalizedUrl, registrableDomain: staticResult.registrableDomain },
    versions: buildVersions(),
    originalAssessment: assessment ?? fallback,
    coverage,
    evidence,
    artifactIds,
  };
  return finish(snapshot, onEvent, emitStep);
}

function buildVersions(): CaseSnapshot["versions"] {
  return {
    reportSchema: "1.0",
    model: process.env.VERIPAGE_TEXT_MODEL ?? "agnes-2.5-flash",
    prompt: PROMPT_VERSION,
    policy: "1.0",
    knowledge: "none-v1",
  };
}

/** 终点：校验 → 修正 summary → 发 report 事件 → 返回 */
function finish(
  snapshot: CaseSnapshot,
  onEvent: (ev: ScanEvent) => void,
  emitStep: (step: ScanStepName, state: CoverageEntry["state"], detail?: string, reason?: string) => void,
): CaseSnapshot {
  const verdict = validateSnapshot(snapshot);
  if (verdict.ok) {
    emitStep("validate", "completed", "快照校验通过");
  } else {
    const hard = verdict.errors.filter((e) => !e.startsWith("[warn]"));
    if (hard.length > 0) {
      emitStep("validate", "failed", hard.slice(0, 3).join("；"));
      snapshot.originalAssessment.summary = `[校验未过] ${snapshot.originalAssessment.summary}`;
    } else {
      emitStep("validate", "partial", verdict.errors.slice(0, 2).join("；"));
    }
  }
  onEvent({ type: "report", snapshot });
  return snapshot;
}
