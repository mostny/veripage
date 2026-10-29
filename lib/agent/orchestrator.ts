/**
 * 检测编排器：把 S0 访问边界 + 三道闸门 + 快照校验串成一次完整检测
 *
 * 定位（对应 docs/framework.md 的流水线图）：
 *   S0 访问边界（lib/guard/access.ts）
 *     → 闸门① URL 静态分析（lib/tools/url-static.ts，纯规则不联网）
 *     → 闸门② 沙箱代访（lib/tools/fetch-page.ts，Playwright）
 *     → 闸门③ AI 取证（视觉 visionChat + 主分析 chat，提示词见 lib/prompts/analyzer.ts）
 *     → validate（lib/evidence/validate.ts，结论-证据绑定校验）
 *
 * 设计纪律：
 * - 每个阶段都向 onEvent 发一个 step 事件，事件名固定为
 *   s0-guard / gate1-static / gate2-fetch / gate3-vision / gate3-analyzer / validate；
 *   这些事件同时聚合进快照的 coverage（第三维：检测覆盖），失败/跳过必须带 reason。
 * - 「先建 evidence 数组，再用同一份数据生成分析器 user 消息」：analyzer 消息里列出的
 *   证据 id 与最终快照 evidence[].id 必须一一对应，否则 validateSnapshot 必然报
 *   「引用了不存在的证据」——这是本文件最容易踩的坑。
 * - 截图 base64 只在内存里流向视觉模型，绝不写进快照：快照只留 artifactIds。
 * - 任何一步失败都降级不抛异常：模型两次输出不可解析 → risk="unknown" 的兜底报告。
 */

import { randomUUID } from "node:crypto";

import { assertPublicHttpUrl } from "../guard/access.ts";
import { analyzeUrlStatic, getRegistrableDomain, type StaticFinding } from "../tools/url-static.ts";
import { fetchPage, type PageEvidence } from "../tools/fetch-page.ts";
import { chat, visionChat, type ChatMessage } from "../models.ts";
import {
  PROMPT_VERSION,
  analyzerSystemPrompt,
  buildAnalyzerUserMessage,
  visionAnalysisPrompt,
  type AnalyzerEvidenceInput,
} from "../prompts/analyzer.ts";
import { validateSnapshot } from "../evidence/validate.ts";
import {
  EVIDENCE_SUFFICIENCIES,
  FINDING_KINDS,
  RISK_LEVELS,
  type Assessment,
  type CaseSnapshot,
  type CoverageEntry,
  type EvidenceItem,
  type Finding,
  type FindingKind,
  type RiskLevel,
  type StepState,
} from "../evidence/types.ts";

// ---------------------------------------------------------------------------
// 常量与对外类型
// ---------------------------------------------------------------------------

/** 编排器对外事件：过程事件（step，前端进度条）+ 结果事件（report，由路由层发送） */
export type ScanEvent =
  | { type: "step"; step: string; state: StepState; detail?: string; reason?: string }
  | { type: "report"; snapshot: CaseSnapshot };

/** 六个阶段的事件名（前端与 coverage 都按这几个名字对齐） */
const STEP_S0 = "s0-guard";
const STEP_STATIC = "gate1-static";
const STEP_FETCH = "gate2-fetch";
const STEP_VISION = "gate3-vision";
const STEP_ANALYZER = "gate3-analyzer";
const STEP_VALIDATE = "validate";

/** 阻断路径下各采集步骤统一的跳过原因 */
const BLOCKED_REASON = "访问边界拒绝";

/** 截图不入快照本体：excerpt 只留占位说明，base64 由调用方按 artifactId 另存 */
const SCREENSHOT_EXCERPT = "[截图 base64 已存 artifacts]";

/** 证据 excerpt 的统一截断长度（快照要能进 IndexedDB，不能把整页正文塞进去） */
const EXCERPT_LIMIT = 1200;

/** 主分析器第一次输出不可解析时的纠偏提示（追加在 messages 末尾的 user 消息） */
const RETRY_HINT = "上一次输出无法解析为合法 JSON，请严格只输出 JSON 对象";

/** 过程事件回调：同时负责把事件聚合进 coverage */
type EmitStep = (step: string, state: StepState, detail?: string, reason?: string) => void;

// ---------------------------------------------------------------------------
// 证据上下文：evidence 数组与 analyzer 消息的唯一事实来源
// ---------------------------------------------------------------------------

interface ScanContext {
  /** 展示用 URL（归一化后） */
  displayUrl: string;
  registrableDomain: string;
  /** 闸门①静态规则命中 */
  staticFindings: StaticFinding[];
  staticScore: number;
  /** 闸门②跳转链（起点 → 终点） */
  redirectChain: string[];
  pageTitle?: string;
  pageText?: string;
  /** 表单硬事实，id 由编排器生成（ev-form-N），与证据 id 同源 */
  forms: Array<{ id: string; action: string; method: string; hasPasswordInput: boolean; inputCount: number }>;
  externalScriptDomains: string[];
  /** 闸门③视觉模型答复（作为 ev-vision 证据） */
  visionAnswer?: string;
  /** 取证告警（超时 / 部分失败），并入 gaps */
  warnings: string[];
  /** DOM 类证据的实际采集时间（title/text/forms/scripts 同一次 evaluate） */
  domCapturedAt?: string;
  /** 截图证据（base64 只在这里存活，不进快照） */
  screenshot?: { capturedAt: string; width: number; height: number; artifactId: string };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 摘录截断：超长加省略标记，保证快照体积可控 */
function clip(text: string, max = EXCERPT_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…（已截断）` : trimmed;
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

/** 从任意输入里安全取出可注册主域（S0 拒绝路径也要能给 inputSummary 填值） */
function safeRegistrableDomain(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return getRegistrableDomain(url.hostname.toLowerCase()) || url.hostname;
  } catch {
    return "(无法解析)";
  }
}

// ---------------------------------------------------------------------------
// evidence 数组构建（与 analyzer user 消息同源，id 必须一致）
// ---------------------------------------------------------------------------

/**
 * 由同一份 ScanContext 产出两样东西：
 *   1. evidence —— 最终快照的证据池
 *   2. analyzerInput —— 喂给 buildAnalyzerUserMessage 的同一份数据
 * 两边 id 完全一致，模型引用的每个 id 都能在证据池里找到。
 */
function buildEvidence(ctx: ScanContext): {
  evidence: EvidenceItem[];
  analyzerInput: AnalyzerEvidenceInput;
} {
  const now = new Date().toISOString();
  const domAt = ctx.domCapturedAt ?? now;
  const evidence: EvidenceItem[] = [];

  // 用户提交的 URL：一切结论的锚点
  evidence.push({
    id: "ev-url",
    type: "url",
    capturedAt: now,
    source: "user-input",
    locator: ctx.displayUrl,
    excerpt: ctx.displayUrl,
  });

  // 闸门①：命中项逐条成为证据；无命中也要留一条「未命中」的事实
  if (ctx.staticFindings.length === 0) {
    evidence.push({
      id: "ev-static",
      type: "url",
      capturedAt: now,
      source: "url-static:rules",
      locator: ctx.registrableDomain,
      excerpt: "静态规则未命中任何项（静态分 0）",
    });
  } else {
    for (const f of ctx.staticFindings) {
      evidence.push({
        id: f.id,
        type: "url",
        capturedAt: now,
        source: "url-static:rules",
        locator: ctx.registrableDomain,
        excerpt: `${f.title}｜${f.detail}（权重 ${f.weight}）`,
      });
    }
    evidence.push({
      id: "ev-static-score",
      type: "url",
      capturedAt: now,
      source: "url-static:score",
      locator: ctx.registrableDomain,
      excerpt: `静态规则加权分：${ctx.staticScore}/100（参考信号，不是结论）`,
    });
  }

  // 闸门②：跳转链
  const finalUrl = ctx.redirectChain[ctx.redirectChain.length - 1] ?? ctx.displayUrl;
  evidence.push({
    id: "ev-redirect",
    type: "redirect",
    capturedAt: now,
    source: "playwright:redirectChain",
    locator: finalUrl,
    excerpt: ctx.redirectChain.length > 0 ? ctx.redirectChain.join(" → ") : "(无跳转链)",
  });

  if (ctx.pageTitle !== undefined) {
    evidence.push({
      id: "ev-title",
      type: "text",
      capturedAt: domAt,
      source: "playwright:document.title",
      locator: "document.title",
      excerpt: clip(ctx.pageTitle),
    });
  }
  if (ctx.pageText !== undefined && ctx.pageText.length > 0) {
    evidence.push({
      id: "ev-text",
      type: "text",
      capturedAt: domAt,
      source: "playwright:document.body.innerText",
      locator: "document.body",
      excerpt: clip(ctx.pageText),
    });
  }

  if (ctx.forms.length > 0) {
    for (const f of ctx.forms) {
      evidence.push({
        id: f.id,
        type: "form",
        capturedAt: domAt,
        source: "playwright:document.forms",
        locator: `form[action=${f.action || "(当前页)"}]`,
        excerpt:
          `action=${f.action || "(空，提交到当前页)"} method=${f.method} ` +
          `密码框=${f.hasPasswordInput ? "有" : "无"} 输入项=${f.inputCount}`,
      });
    }
  } else {
    evidence.push({
      id: "ev-form-none",
      type: "form",
      capturedAt: domAt,
      source: "playwright:document.forms",
      locator: "document.forms",
      excerpt: "页面未发现表单",
    });
  }

  if (ctx.externalScriptDomains.length > 0) {
    evidence.push({
      id: "ev-scripts",
      type: "request",
      capturedAt: domAt,
      source: "playwright:script[src] 与最终页主域比对",
      locator: ctx.registrableDomain,
      excerpt: `第三方域脚本：${ctx.externalScriptDomains.join(", ")}`,
    });
  }

  // 闸门③视觉：答复作为文本证据；截图本体只留占位与 artifactId
  if (ctx.visionAnswer !== undefined) {
    evidence.push({
      id: "ev-vision",
      type: "text",
      capturedAt: now,
      source: "vision:视觉核验模型对截图的答复",
      locator: "整页截图",
      excerpt: clip(ctx.visionAnswer),
    });
  } else {
    evidence.push({
      id: "ev-vision-none",
      type: "text",
      capturedAt: now,
      source: "vision:skipped",
      locator: "整页截图（缺失）",
      excerpt: "无截图视觉证据（取证未覆盖或页面无截图）",
    });
  }
  if (ctx.screenshot) {
    evidence.push({
      id: "ev-screenshot",
      type: "screenshot",
      capturedAt: ctx.screenshot.capturedAt,
      source: "playwright:page.screenshot(fullPage)",
      locator: `fullPage ${ctx.screenshot.width}x${ctx.screenshot.height}`,
      excerpt: SCREENSHOT_EXCERPT,
    });
  }

  if (ctx.warnings.length > 0) {
    evidence.push({
      id: "ev-warnings",
      type: "text",
      capturedAt: now,
      source: "orchestrator:warnings",
      locator: "coverage",
      excerpt: `取证告警：${clip(ctx.warnings.join("; "))}`,
    });
  }

  const analyzerInput: AnalyzerEvidenceInput = {
    url: ctx.displayUrl,
    registrableDomain: ctx.registrableDomain,
    staticFindings: ctx.staticFindings,
    staticScore: ctx.staticScore,
    redirectChain: ctx.redirectChain,
    pageTitle: ctx.pageTitle,
    pageText: ctx.pageText,
    forms: ctx.forms,
    externalScriptDomains: ctx.externalScriptDomains,
    visionAnswer: ctx.visionAnswer,
    warnings: ctx.warnings,
  };
  return { evidence, analyzerInput };
}

// ---------------------------------------------------------------------------
// 模型输出解析与归一化（抗围栏 / 抗废话 / 抗幻觉证据 id）
// ---------------------------------------------------------------------------

/** 剥掉模型可能输出的 ```json 围栏 */
function stripJsonFences(raw: string): string {
  const text = raw.trim();
  const fence = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(text);
  return fence ? fence[1].trim() : text;
}

/** 模型输出 → Assessment；risk 枚举非法或结构不符时返回 null（调用方负责重试） */
function parseAssessment(raw: string, evidenceIds: Set<string>): Assessment | null {
  const text = stripJsonFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // 兜底：模型在 JSON 前后带了说明文字时，截取首尾花括号之间的内容再试一次
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      json = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return normalizeAssessment(json, evidenceIds);
}

function normalizeAssessment(raw: unknown, evidenceIds: Set<string>): Assessment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const risk = obj.risk;
  if (typeof risk !== "string" || !RISK_LEVELS.includes(risk as RiskLevel)) return null;

  const sufficiency =
    typeof obj.evidenceSufficiency === "string" &&
    (EVIDENCE_SUFFICIENCIES as readonly string[]).includes(obj.evidenceSufficiency)
      ? (obj.evidenceSufficiency as Assessment["evidenceSufficiency"])
      : "partial";

  return {
    risk: risk as RiskLevel,
    evidenceSufficiency: sufficiency,
    gaps: toStringArray(obj.gaps),
    summary:
      typeof obj.summary === "string" && obj.summary.trim().length > 0
        ? obj.summary.trim()
        : "（模型未给出摘要）",
    findings: normalizeFindings(obj.findings, evidenceIds),
    unknowns: toStringArray(obj.unknowns),
    recommendedAction:
      typeof obj.recommendedAction === "string" && obj.recommendedAction.trim().length > 0
        ? obj.recommendedAction.trim()
        : "证据不足，建议人工复核。",
  };
}

/**
 * findings 归一化。模型偶尔会产出重复 id、空 statement、或不存在的 evidenceId，
 * 这里做防御性清洗，保证快照内部自洽（validateSnapshot 可通过）：
 * - 空 statement 的 finding 直接丢弃；
 * - id 缺失/重复时重新编号；
 * - evidenceIds 只保留证据池（或 finding 池）里真实存在的 id；
 * - observed_fact / reference 清洗后一条证据都不剩 → 降级为 inference，
   避免「无依据的观察事实」进入报告。
 */
function normalizeFindings(raw: unknown, evidenceIds: Set<string>): Finding[] {
  const list = Array.isArray(raw) ? raw : [];
  const draft: Finding[] = [];
  const usedIds = new Set<string>();

  list.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const f = item as Record<string, unknown>;
    const statement = typeof f.statement === "string" ? f.statement.trim() : "";
    if (!statement) return;
    let id = typeof f.id === "string" && f.id.trim().length > 0 ? f.id.trim() : `f${i + 1}`;
    if (usedIds.has(id)) id = `${id}-${i + 1}`;
    usedIds.add(id);
    const kind: FindingKind =
      typeof f.kind === "string" && (FINDING_KINDS as readonly string[]).includes(f.kind)
        ? (f.kind as FindingKind)
        : "inference";
    draft.push({
      id,
      statement,
      kind,
      evidenceIds: toStringArray(f.evidenceIds),
      alternativeExplanations: toStringArray(f.alternativeExplanations),
    });
  });

  return draft.map((f) => {
    if (f.kind === "inference") {
      // inference 可引用其他 finding 形成推理链，但不得自引用、不得引用不存在的 id
      return {
        ...f,
        evidenceIds: f.evidenceIds.filter((r) => r !== f.id && (evidenceIds.has(r) || usedIds.has(r))),
      };
    }
    const refs = f.evidenceIds.filter((r) => evidenceIds.has(r));
    if (refs.length === 0) return { ...f, kind: "inference" as const, evidenceIds: [] };
    return { ...f, evidenceIds: refs };
  });
}

// ---------------------------------------------------------------------------
// 兜底报告（模型不可用 / 输出不可解析）
// ---------------------------------------------------------------------------

/** 闸门③主分析失败时的纯规则兜底：risk="unknown"，缺口如实写明 */
function fallbackAssessment(ctx: ScanContext, reason: string): Assessment {
  const findings: Finding[] = ctx.staticFindings.map((f, i) => ({
    id: `f-static-${i + 1}`,
    statement: `${f.title}：${f.detail}`,
    kind: "observed_fact" as const,
    evidenceIds: [f.id],
    alternativeExplanations: [],
  }));
  if (findings.length === 0) {
    findings.push({
      id: "f-static-none",
      statement: "闸门①静态规则未命中任何项",
      kind: "observed_fact",
      evidenceIds: ["ev-static"],
      alternativeExplanations: [],
    });
  }
  return {
    risk: "unknown",
    evidenceSufficiency: "insufficient",
    gaps: [...ctx.warnings, reason],
    summary: `AI 主分析未产出可用结论（${reason}），以下仅为闸门①静态规则观察结果，未做风险定级。`,
    findings,
    unknowns: ["页面的真实身份与行为未经 AI 取证核验，无法判断"],
    recommendedAction: "证据不足，建议人工复核或稍后重试；切勿仅凭静态规则结果下结论。",
  };
}

// ---------------------------------------------------------------------------
// 快照组装与收尾校验
// ---------------------------------------------------------------------------

function buildSnapshot(
  input: { displayUrl: string; registrableDomain: string },
  assessment: Assessment,
  coverage: CoverageEntry[],
  evidence: EvidenceItem[],
  artifactIds: string[],
): CaseSnapshot {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    inputSummary: {
      displayUrl: input.displayUrl.trim() || "(未提供 URL)",
      registrableDomain: input.registrableDomain,
    },
    versions: {
      reportSchema: "1.0",
      model: process.env.VERIPAGE_TEXT_MODEL ?? "agnes-2.5-flash",
      prompt: PROMPT_VERSION,
      policy: "1.0",
      knowledge: "none-v1",
    },
    originalAssessment: assessment,
    coverage,
    evidence,
    artifactIds,
  };
}

/**
 * 统一收尾：跑 validateSnapshot → 记 validate 覆盖条目 → 需要时给 summary 打前缀。
 * 校验不通过也照样返回快照（调用方决定怎么展示），但 ok=false 时 summary 加
 * "[校验未过]" 前缀，避免一份自相矛盾的报告被当成干净结论呈现。
 */
function finalizeSnapshot(snapshot: CaseSnapshot, emitStep: EmitStep): CaseSnapshot {
  const result = validateSnapshot(snapshot);
  const hardErrors = result.errors.filter((e) => !e.startsWith("[warn]"));
  const state: StepState = result.ok ? "completed" : hardErrors.length > 0 ? "failed" : "partial";
  const detail = result.errors.slice(0, 3).join(" | ");

  if (!result.ok) {
    snapshot.originalAssessment = {
      ...snapshot.originalAssessment,
      summary: `[校验未过] ${snapshot.originalAssessment.summary}`,
    };
  }
  // validate 条目在快照组装之后才产生，直接推进同一 coverage 数组（快照持有其引用）
  snapshot.coverage.push({
    step: STEP_VALIDATE,
    state,
    ...(result.ok ? {} : { reason: detail || "校验未通过" }),
  });
  emitStep(
    STEP_VALIDATE,
    state,
    result.ok ? "快照结构与证据绑定校验通过" : detail,
    result.ok ? undefined : detail || "校验未通过",
  );
  return snapshot;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 执行一次完整检测。
 * @param rawUrl   用户提交的 URL
 * @param onEvent 过程事件回调（step 事件；report 事件由路由层发送）
 * @returns        快照。即使部分步骤失败 / 校验未过也一定返回可展示的快照。
 */
export async function runScan(rawUrl: string, onEvent: (ev: ScanEvent) => void): Promise<CaseSnapshot> {
  const coverage: CoverageEntry[] = [];
  /** 发一个过程事件，同时把它聚合进快照的「检测覆盖」维度 */
  const emitStep: EmitStep = (step, state, detail, reason) => {
    coverage.push({ step, state, ...(reason !== undefined ? { reason } : {}) });
    onEvent({
      type: "step",
      step,
      state,
      ...(detail !== undefined ? { detail } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  };

  // ---- S0 访问边界：先于一切网络访问 --------------------------------------
  const guard = await assertPublicHttpUrl(rawUrl);
  if (!guard.allowed) {
    const reason = guard.reason ?? "S0 访问边界拒绝";
    emitStep(STEP_S0, "completed", undefined, reason);
    // 阻断路径：后续采集步骤全部标记 skipped，绝不发起任何网络访问
    for (const step of [STEP_STATIC, STEP_FETCH, STEP_VISION, STEP_ANALYZER]) {
      emitStep(step, "skipped", undefined, BLOCKED_REASON);
    }
    const now = new Date().toISOString();
    const evidence: EvidenceItem[] = [
      {
        id: "ev-url",
        type: "url",
        capturedAt: now,
        source: "user-input",
        locator: rawUrl.trim(),
        excerpt: rawUrl.trim() || "(未提供 URL)",
      },
    ];
    const assessment: Assessment = {
      risk: "unknown",
      evidenceSufficiency: "insufficient",
      gaps: [
        `S0 访问边界拒绝访问：${reason}`,
        "闸门①静态分析、闸门②沙箱代访、闸门③AI 取证均未执行，无任何页面证据",
      ],
      summary: `未发起检测：${reason}`,
      findings: [
        {
          id: "f1",
          statement: `访问边界拒绝访问该 URL：${reason}`,
          kind: "observed_fact",
          evidenceIds: ["ev-url"],
          alternativeExplanations: [],
        },
      ],
      unknowns: ["该地址是否为可公开访问的有效站点未知（访问边界已拒绝，无法取证）"],
      recommendedAction:
        "内网、回环、链路本地等保留地址不在检测范围内；如确需检测，请更换为可公开访问的 http/https 地址。",
    };
    return finalizeSnapshot(
      buildSnapshot(
        { displayUrl: rawUrl.trim(), registrableDomain: safeRegistrableDomain(rawUrl) },
        assessment,
        coverage,
        evidence,
        [],
      ),
      emitStep,
    );
  }
  emitStep(
    STEP_S0,
    "completed",
    `访问边界放行（解析地址：${(guard.resolvedIps ?? []).join(", ") || "未知"}）`,
  );

  // ---- 闸门①：URL 静态分析（纯确定性规则，不访问网络） --------------------
  const staticReport = analyzeUrlStatic(rawUrl);
  emitStep(
    STEP_STATIC,
    "completed",
    `命中 ${staticReport.findings.length} 项，静态分 ${staticReport.score}`,
  );

  // ---- 闸门②：沙箱代访 ----------------------------------------------------
  const page = await fetchPage(rawUrl);
  const warnings: string[] = [];
  let pageEvidence: PageEvidence[] = [];
  let redirectChain: string[] = [staticReport.normalizedUrl];

  if (page.blocked) {
    // 理论上 S0 已放行不会走到这里；仍然只降级不抛异常，靠 gaps 把真相写清楚
    warnings.push(`闸门②被访问边界拒绝：${page.reason ?? "原因未说明"}`);
    emitStep(STEP_FETCH, "partial", undefined, page.reason ?? "访问边界拒绝");
  } else {
    if (page.error) {
      warnings.push(`闸门②沙箱代访未完成：${page.error}`);
      emitStep(STEP_FETCH, "partial", undefined, page.error);
    } else {
      emitStep(
        STEP_FETCH,
        "completed",
        `跳转链 ${page.redirectChain.length} 跳，证据 ${page.evidence.length} 项`,
      );
    }
    warnings.push(...page.warnings);
    pageEvidence = page.evidence.length > 0 ? page.evidence : (page.partialEvidence ?? []);
    if (page.redirectChain.length > 0) redirectChain = page.redirectChain;
  }

  // 从闸门②证据里取出主分析需要的字段（id 与证据池同源）
  const textEvidence = pageEvidence.find((e) => e.type === "text");
  const formsEvidence = pageEvidence.find((e) => e.type === "forms");
  const scriptsEvidence = pageEvidence.find((e) => e.type === "externalScripts");
  const screenshotEvidence = pageEvidence.find((e) => e.type === "screenshot");

  const pageTitle = textEvidence && textEvidence.type === "text" ? textEvidence.title : undefined;
  const pageText = textEvidence && textEvidence.type === "text" ? textEvidence.text : undefined;
  const forms =
    formsEvidence && formsEvidence.type === "forms"
      ? formsEvidence.forms.map((f, i) => ({
          id: `ev-form-${i + 1}`,
          action: f.action,
          method: f.method,
          hasPasswordInput: f.hasPasswordInput,
          inputCount: f.inputCount,
        }))
      : [];
  const externalScriptDomains =
    scriptsEvidence && scriptsEvidence.type === "externalScripts" ? scriptsEvidence.domains : [];

  // ---- 闸门③视觉：截图交给视觉模型，失败不阻断 ----------------------------
  let visionAnswer: string | undefined;
  const shot = screenshotEvidence && screenshotEvidence.type === "screenshot" ? screenshotEvidence : undefined;
  if (!shot) {
    emitStep(STEP_VISION, "skipped", undefined, "未采集到整页截图，跳过视觉核验");
  } else {
    try {
      const res = await visionChat(visionAnalysisPrompt(), shot.data);
      const answer = res.content.trim();
      if (answer.length > 0) {
        visionAnswer = answer;
        emitStep(STEP_VISION, "completed", `视觉核验完成（答复 ${answer.length} 字）`);
      } else {
        emitStep(STEP_VISION, "partial", undefined, "视觉模型返回空内容");
      }
    } catch (err) {
      emitStep(STEP_VISION, "skipped", undefined, `视觉核验失败：${errMsg(err)}`);
    }
  }

  // ---- 闸门③主分析：先建 evidence，再用同一份数据生成 user 消息 ------------
  const ctx: ScanContext = {
    displayUrl: staticReport.normalizedUrl,
    registrableDomain: staticReport.registrableDomain,
    staticFindings: staticReport.findings,
    staticScore: staticReport.score,
    redirectChain,
    pageTitle,
    pageText,
    forms,
    externalScriptDomains,
    visionAnswer,
    warnings,
    domCapturedAt: textEvidence?.capturedAt,
    screenshot: shot
      ? {
          capturedAt: shot.capturedAt,
          width: shot.width,
          height: shot.height,
          artifactId: `art-${randomUUID()}`,
        }
      : undefined,
  };

  const { evidence, analyzerInput } = buildEvidence(ctx);
  const evidenceIds = new Set(evidence.map((e) => e.id));

  const messages: ChatMessage[] = [
    { role: "system", content: analyzerSystemPrompt() },
    { role: "user", content: buildAnalyzerUserMessage(analyzerInput) },
  ];

  let assessment: Assessment | null = null;
  let failure: string | undefined;
  for (let attempt = 1; attempt <= 2 && !assessment; attempt += 1) {
    let content: string;
    try {
      const res = await chat(messages, { temperature: 0.2, maxTokens: 2000 });
      content = res.content;
    } catch (err) {
      failure = `主分析器调用失败：${errMsg(err)}`;
      break;
    }
    assessment = parseAssessment(content, evidenceIds);
    if (!assessment) {
      if (attempt === 1) {
        // 输出不可解析：在 messages 末尾追加一条纠偏 user 消息，重试一次
        messages.push({ role: "user", content: RETRY_HINT });
      } else {
        failure = "主分析器两次输出均无法解析为合法 JSON（JSON 损坏或 risk 枚举非法）";
      }
    }
  }

  if (assessment) {
    emitStep(
      STEP_ANALYZER,
      "completed",
      `风险=${assessment.risk}，findings=${assessment.findings.length} 条，充分度=${assessment.evidenceSufficiency}`,
    );
  } else {
    emitStep(STEP_ANALYZER, "failed", undefined, failure);
    assessment = fallbackAssessment(ctx, failure ?? "主分析器未产出可用结论");
  }

  // ---- 组装快照 + 校验 ----------------------------------------------------
  const artifactIds = ctx.screenshot ? [ctx.screenshot.artifactId] : [];
  return finalizeSnapshot(
    buildSnapshot(
      { displayUrl: staticReport.normalizedUrl, registrableDomain: staticReport.registrableDomain },
      assessment,
      coverage,
      evidence,
      artifactIds,
    ),
    emitStep,
  );
}
