/**
 * AIGC 判定（文本第二条线）
 *
 * 契约（任务书 P2 §2 / §3）：
 * - 提示词要求模型输出可解析 JSON，且必须带 caveats（lib/prompts/text.ts 已写死）
 * - 解析失败一次纠偏重试（照抄 orchestrator 的 RETRY_HINT 模式）；
 *   两次失败抛 AigcUnavailableError，由路由返回 502——绝不静默返回「是人类写的」
 * - 判定是推断级结论：附带 signals 与 caveats，置信度低时结论为 undetermined
 * - chat 可注入：离线冒烟用假对话函数驱动，不花真钱、不发真实请求
 */

import { chat, type ChatMessage, type ChatOptions, type ChatResult } from "../models.ts";
import {
  TEXT_PROMPT_VERSION,
  buildTextAnalysisUserMessage,
  textAnalysisSystemPrompt,
} from "../prompts/text.ts";

/** 纠偏提示（与 orchestrator RETRY_HINT 同款模式：追加一条 user 消息重试一次） */
export const AIGC_RETRY_HINT =
  "上一次输出无法解析为合法 JSON（或 caveats 为空/缺失）。请严格只输出 JSON 对象，字段为 isAigc/confidence/signals/caveats，且 caveats 必须为非空字符串数组，不要输出任何其他文字。";

/** 低于该置信度一律「无法判定」——宁可不说，不可硬下结论 */
export const CONFIDENCE_FLOOR = 0.5;

export type AigcConclusion = "likely_aigc" | "likely_human" | "undetermined";

export interface AigcVerdict {
  isAigc: boolean;
  /** 归一化到 0~1 的置信度 */
  confidence: number;
  conclusion: AigcConclusion;
  /** 模型给出的支持特征 */
  signals: string[];
  /** 模型给出的保留意见（非空） */
  caveats: string[];
  promptVersion: string;
  /** 实际使用的模型（未指定时为 undefined，UI 展示「默认模型」） */
  model?: string;
  /** 是否发生过解析纠偏重试 */
  repaired: boolean;
}

/** 判定不可用（两次解析失败 / 模型调用失败）。路由据此返回 502，不做任何默认判定。 */
export class AigcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AigcUnavailableError";
  }
}

/** 可注入的对话函数签名（与 lib/models.ts 的 chat 兼容） */
export type ChatFn = (messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResult>;

export interface DetectAigcOptions {
  /** 默认走 lib/models.ts 的 chat；测试注入假函数 */
  chat?: ChatFn;
  model?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// 解析与归一化（抗围栏 / 抗前后废话）
// ---------------------------------------------------------------------------

/** 剥掉模型可能输出的 ```json 围栏 */
function stripJsonFences(raw: string): string {
  const text = raw.trim();
  const fence = /^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/.exec(text);
  return fence ? fence[1].trim() : text;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

/**
 * 置信度归一化：0~1 原样接受；1~100 视为百分制除以 100；
 * 非有限数或越界（<0 或 >100）判非法——交给调用方重试，不猜。
 */
function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  const scaled = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, scaled));
}

/** 模型输出 → 判定字段；结构损坏、isAigc 非布尔或 caveats 为空时返回 null */
export function parseAigcVerdict(raw: string): Omit<AigcVerdict, "conclusion" | "promptVersion" | "model" | "repaired"> | null {
  const text = stripJsonFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // 兜底：JSON 前后带了说明文字时，截取首尾花括号之间再试一次
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      json = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.isAigc !== "boolean") return null;
  const confidence = normalizeConfidence(obj.confidence);
  if (confidence === null) return null;
  const caveats = toStringArray(obj.caveats);
  // 契约硬约束：必须带 caveats，否则视为无效输出（触发纠偏重试）
  if (caveats.length === 0) return null;
  return { isAigc: obj.isAigc, confidence, signals: toStringArray(obj.signals), caveats };
}

function deriveConclusion(isAigc: boolean, confidence: number): AigcConclusion {
  if (confidence < CONFIDENCE_FLOOR) return "undetermined";
  return isAigc ? "likely_aigc" : "likely_human";
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 判定一段文本是否具有 AI 生成特征。
 * 两次解析失败抛 AigcUnavailableError（路由 → 502），绝不返回默认「人类所写」。
 */
export async function detectAigc(text: string, opts: DetectAigcOptions = {}): Promise<AigcVerdict> {
  const chatFn = opts.chat ?? chat;
  const messages: ChatMessage[] = [
    { role: "system", content: textAnalysisSystemPrompt() },
    { role: "user", content: buildTextAnalysisUserMessage(text) },
  ];
  let repaired = false;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    opts.signal?.throwIfAborted();
    let content: string;
    try {
      const res = await chatFn(messages, {
        temperature: 0.2,
        maxTokens: 800,
        model: opts.model,
        signal: opts.signal,
      });
      content = res.content;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new AigcUnavailableError(`AIGC 判定模型调用失败：${detail}`);
    }

    const parsed = parseAigcVerdict(content);
    if (parsed) {
      return {
        ...parsed,
        conclusion: deriveConclusion(parsed.isAigc, parsed.confidence),
        promptVersion: TEXT_PROMPT_VERSION,
        model: opts.model,
        repaired,
      };
    }

    if (attempt === 1) {
      // 输出不可解析：追加一条纠偏 user 消息，重试一次（与 orchestrator 同款模式）
      repaired = true;
      messages.push({ role: "user", content: AIGC_RETRY_HINT });
    }
  }

  throw new AigcUnavailableError(
    "AIGC 判定两次输出均无法解析为合法 JSON（或缺少 caveats 字段），已停止判定；本服务不会在判定失败时默认按「人类所写」返回，请稍后重试或人工复核。",
  );
}
