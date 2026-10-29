/**
 * Agnes API 适配层（OpenAI 兼容协议）
 *
 * 职责：把「发消息 / 流式发消息 / 带图发消息」三件事封装成对上层稳定的调用面，
 * 让 Agent 循环与 UI 层不直接接触 HTTP 细节（请求体拼装、SSE 分帧、tool_calls 重组、重试）。
 *
 * 事实基线（docs/model-notes.md 实测）：
 *   - 端点：${VERIPAGE_AGNES_BASE_URL}/chat/completions，Bearer 认证
 *   - agnes-2.5-flash 同时覆盖 文本 / 流式 SSE / tools / image_url 视觉输入
 *   - 流式为标准 OpenAI chunk 格式，tool_calls 可能跨多帧增量到达，需按 index 聚合
 *
 * 安全纪律：
 *   - 密钥只从 VERIPAGE_AGNES_API_KEY 读取，不硬编码、不打印、不写日志
 *   - 错误信息只带 HTTP 状态码 + 截断后的响应体，不泄漏完整请求上下文
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 文本片段 */
export interface TextPart {
  type: "text";
  text: string;
}

/** 图片片段。url 支持 http(s) 链接或 data URL（如 data:image/png;base64,xxx） */
export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

/** 多模态消息的 content 数组元素 */
export type ContentPart = TextPart | ImagePart;

/** OpenAI 兼容消息。content 为纯文本或多模态片段数组 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** role 为 "tool" 时必填，指向被回复的 tool_call */
  tool_call_id?: string;
}

/** 工具定义（OpenAI tools 数组元素） */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema 对象 */
    parameters: object;
  };
}

/** 归一化后的工具调用。arguments 为 JSON 字符串（原样保留，交由调用方 JSON.parse） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface ChatOptions {
  /** 缺省取 VERIPAGE_TEXT_MODEL */
  model?: string;
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** Cancels model HTTP requests when the scan request/overall budget is cancelled. */
  signal?: AbortSignal;
  /** 可重试错误（网络错误 / HTTP >=500）的重试次数，默认 1 次 */
  retries?: number;
}

/** 流式事件：文本增量 / 工具调用聚合结果 / 结束信号 */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "toolCalls"; toolCalls: ToolCall[] }
  | { type: "done"; finishReason?: string; usage?: ChatResult["usage"] };

/** 可重试退避时长（ms） */
const RETRY_BACKOFF_MS = 300;
/** 错误响应体截断长度，避免把整页 HTML 塞进异常信息 */
const ERROR_BODY_LIMIT = 300;

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * 校验 BASE_URL / API_KEY 存在，缺失时抛出带修复说明的 Error。
 * 上层（路由处理函数 / 脚本入口）应在真正发请求前调用一次，快速失败。
 */
export function assertModelConfig(): void {
  const base = env("VERIPAGE_AGNES_BASE_URL");
  const key = env("VERIPAGE_AGNES_API_KEY");
  const missing: string[] = [];
  if (!base) missing.push("VERIPAGE_AGNES_BASE_URL");
  if (!key) missing.push("VERIPAGE_AGNES_API_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Agnes 配置缺失：${missing.join(" / ")}。请在 .env 中补齐（参考 .env.example），` +
        `Next 开发/生产环境由框架自动加载；脚本请用 node --env-file=.env 运行。`,
    );
  }
}

/** 取 BASE_URL 并去掉末尾斜杠，保证拼接 /chat/completions 时不会出现双斜杠 */
function baseUrl(): string {
  assertModelConfig();
  return env("VERIPAGE_AGNES_BASE_URL")!.replace(/\/+$/, "");
}

function apiKey(): string {
  return env("VERIPAGE_AGNES_API_KEY")!;
}

/** 默认文本模型 */
function defaultTextModel(): string {
  return env("VERIPAGE_TEXT_MODEL") ?? "agnes-2.5-flash";
}

// ---------------------------------------------------------------------------
// 请求体拼装
// ---------------------------------------------------------------------------

/** 剔除 undefined 字段，避免 JSON 里出现无意义键 */
function normalizeMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  return out;
}

function buildBody(messages: ChatMessage[], opts: ChatOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model ?? defaultTextModel(),
    messages: messages.map(normalizeMessage),
    stream,
  };
  // tools 为空数组时部分网关会报错，只在有工具时才带上
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  return body;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey()}`,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** 把错误响应体压成一行并截断，避免异常信息过长 */
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_BODY_LIMIT ? `${oneLine.slice(0, ERROR_BODY_LIMIT)}…` : oneLine;
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return clip(await res.text());
  } catch {
    return "<响应体读取失败>";
  }
}

/** 4xx（含 429）属于请求本身有问题，重试无意义，直接抛 */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function parseUsage(raw: unknown): ChatResult["usage"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
  const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return { promptTokens, completionTokens };
}

function parseContent(raw: unknown): string {
  // 正常为字符串；个别网关在工具调用场景返回 null，个别返回片段数组，统一压成文本
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawToolCall[])
    .filter((tc) => tc && typeof tc === "object")
    .map((tc, i) => ({
      // 极少数实现漏发 id，用序号兜底，保证上层按 id 关联 tool 消息时不会拿到空串
      id: typeof tc.id === "string" && tc.id.length > 0 ? tc.id : `call_${i}`,
      name: tc.function?.name ?? "",
      // arguments 是 JSON 字符串，原样保留，不在此处 parse
      arguments: tc.function?.arguments ?? "",
    }))
    .filter((tc) => tc.name.length > 0);
}

// ---------------------------------------------------------------------------
// 非流式对话
// ---------------------------------------------------------------------------

/**
 * 非流式对话。
 * 重试策略：网络错误或 HTTP >=500 重试（默认 1 次，300ms 退避）；HTTP 4xx 不重试直接抛错。
 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const url = `${baseUrl()}/chat/completions`;
  const retries = opts.retries ?? 1;

  for (let attempt = 0; ; attempt += 1) {
    opts.signal?.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(buildBody(messages, opts, false)),
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS, opts.signal);
        continue;
      }
      throw new Error(`Agnes 请求失败（网络错误）：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      const detail = await readErrorBody(res);
      const err = new Error(`Agnes 返回 HTTP ${res.status}：${detail}`);
      if (attempt < retries && isRetryableStatus(res.status)) {
        await sleep(RETRY_BACKOFF_MS, opts.signal);
        continue;
      }
      throw err;
    }

    let json: {
      choices?: Array<{
        message?: { content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }>;
      usage?: unknown;
    };
    try {
      json = await res.json();
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      if (attempt < retries) {
        await sleep(RETRY_BACKOFF_MS, opts.signal);
        continue;
      }
      throw new Error(`Agnes 响应非 JSON：${err instanceof Error ? err.message : String(err)}`);
    }

    const choice = json.choices?.[0];
    const message = choice?.message;
    return {
      content: parseContent(message?.content),
      toolCalls: parseToolCalls(message?.tool_calls),
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
      usage: parseUsage(json.usage),
    };
  }
}

// ---------------------------------------------------------------------------
// 流式对话（SSE）
// ---------------------------------------------------------------------------

/** SSE 分帧器：跨网络块缓冲，未完整的行留给下一个块 */
class SseParser {
  /** 已收到但尚未完整（缺换行符）的字节解码后的文本残片 */
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");

  /**
   * 喂入一个网络块，返回本次可处理的完整 SSE 行（不含换行符）。
   * 关键点：一行 data 可能被拆在两个网络块里，所以必须保留 buffer 尾部，
   * 绝不能「按块 split 后当成完整行处理」。
   */
  push(chunk: Uint8Array): string[] {
    // stream: true 增量解码，多字节 UTF-8 字符跨块时不会出现乱码
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split(/\r\n|\n|\r/);
    // 最后一段可能是半行，留到下一块
    this.buffer = lines.pop() ?? "";
    return lines;
  }

  /** 流结束时冲刷解码器残留（非完整 UTF-8 序列的替换字符场景） */
  flush(): string[] {
    const tail = this.decoder.decode();
    if (tail.length > 0) this.buffer += tail;
    if (this.buffer.length === 0) return [];
    const lines = this.buffer.split(/\r\n|\n|\r/);
    this.buffer = "";
    return lines;
  }
}

/** 一行 data 载荷：去掉 "data:" 前缀与至多一个空格；非 data 行返回 null */
function parseDataLine(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  return line.slice(5).replace(/^ /, "");
}

/** 流式 tool_calls 增量累加器：按 index 对齐，arguments 逐帧拼接 */
class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  add(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const tc = item as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      // 未带 index 时按出现顺序兜底
      const index = typeof tc.index === "number" ? tc.index : this.byIndex.size;
      const cur = this.byIndex.get(index) ?? { id: "", name: "", args: "" };
      if (typeof tc.id === "string" && tc.id.length > 0) cur.id = tc.id;
      if (typeof tc.function?.name === "string" && tc.function.name.length > 0) cur.name = tc.function.name;
      if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
      this.byIndex.set(index, cur);
    }
  }

  /** 按 index 顺序输出完整 tool_calls */
  snapshot(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, tc], i) => ({
        id: tc.id.length > 0 ? tc.id : `call_${index}_${i}`,
        name: tc.name,
        arguments: tc.args,
      }))
      .filter((tc) => tc.name.length > 0);
  }
}

/**
 * 流式对话。逐事件 yield：
 *   delta      —— 文本增量（每个 SSE 帧一段）
 *   toolCalls  —— 结束前一次性给出聚合完整的工具调用
 *   done       —— finish_reason / usage
 */
export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<StreamEvent> {
  opts.signal?.throwIfAborted();
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(buildBody(messages, opts, true)),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new Error(`Agnes 流式请求返回 HTTP ${res.status}：${await readErrorBody(res)}`);
  }
  if (!res.body) {
    throw new Error("Agnes 流式响应无 body（ReadableStream 为空）");
  }

  const reader = res.body.getReader();
  const sse = new SseParser();
  const toolCalls = new ToolCallAccumulator();
  let finishReason: string | undefined;
  let usage: ChatResult["usage"];
  /** 是否已收到 data: [DONE] 结束帧 */
  let done = false;

  /**
   * 处理单行 data 载荷，返回该帧携带的文本增量；遇到 [DONE] 时 text 为空且 done=true。
   * tool_calls 不在此处产出事件——分多帧到达时必须等聚合完整后再给调用方。
   */
  const handleData = (payload: string): { text: string; done: boolean } => {
    if (payload.trim() === "[DONE]") return { text: "", done: true };
    let chunk: {
      choices?: Array<{
        delta?: { content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }>;
      usage?: unknown;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      // 容忍网关插入的心跳/注释帧，不影响主流程
      return { text: "", done: false };
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta?.tool_calls) toolCalls.add(delta.tool_calls);
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    const u = parseUsage(chunk.usage);
    if (u) usage = u;
    return { text: parseContent(delta?.content), done: false };
  };

  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      for (const line of sse.push(value)) {
        const payload = parseDataLine(line);
        if (payload === null) continue;
        const frame = handleData(payload);
        if (frame.text.length > 0) yield { type: "delta", text: frame.text };
        if (frame.done) {
          done = true;
          break;
        }
      }
      if (done) break;
    }

    // 流自然结束（未显式 [DONE]）时，冲刷解码器残留与缓冲区里的半行
    if (!done) {
      for (const line of sse.flush()) {
        const payload = parseDataLine(line);
        if (payload === null) continue;
        const frame = handleData(payload);
        if (frame.text.length > 0) yield { type: "delta", text: frame.text };
        if (frame.done) {
          done = true;
          break;
        }
      }
    }
  } finally {
    // 提前 break（[DONE]）时取消上游读取，避免连接悬挂
    await reader.cancel().catch(() => undefined);
  }

  const calls = toolCalls.snapshot();
  if (calls.length > 0) yield { type: "toolCalls", toolCalls: calls };
  yield { type: "done", finishReason, usage };
}

// ---------------------------------------------------------------------------
// 视觉对话
// ---------------------------------------------------------------------------

/**
 * 视觉对话：文本 prompt + 一张 base64 图片（默认按 PNG data URL 组装）。
 * 模型缺省取 VERIPAGE_VISION_MODEL。
 */
export async function visionChat(
  prompt: string,
  imageBase64: string,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const url = imageBase64.startsWith("data:")
    ? imageBase64
    : `data:image/png;base64,${imageBase64.replace(/^data:image\/\w+;base64,/, "")}`;
  const content: ContentPart[] = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url } },
  ];
  const model = opts.model ?? env("VERIPAGE_VISION_MODEL") ?? defaultTextModel();
  return chat([{ role: "user", content }], { ...opts, model });
}
