/**
 * POST /api/text — 文本第二条线：AIGC 判定 + 本地正则脱敏
 *
 * 证据纪律（任务书 P2 §3）：
 * - AIGC 判定是「推断」级：只透传模型的 signals/caveats，两次解析失败返回 502
 *   明确错误，绝不静默返回「是人类写的」
 * - 脱敏是「观察事实」级：本地正则、确定性输出；命中清单只含类型与位置区间
 * - 不声称删除任何数据：脱敏只发生在返回给用户的文本里
 *
 * 隐私最小化（审计 F01）：默认只把「本地脱敏后的文本」传给模型，原文不出本机；
 * 请求体显式携带 allowRawInput: true 时才传原文（知情选择，路由照常返回）。
 *
 * 取消与时限（审计 F06）：组合 request.signal（客户端断开即中止）与
 * 应用层总时限（对齐扫描线 TOTAL_TIMEOUT_MS 的预算纪律）传入 detectAigc，
 * 客户端断开后不再消耗模型调用。
 */

import { chat } from "../../../lib/models.ts";
import { AigcUnavailableError, detectAigc } from "../../../lib/text/aigc.ts";
import { redactPii } from "../../../lib/text/redact.ts";

/** 入参长度上限（任务书 §2：如 20000 字符） */
export const MAX_TEXT_LENGTH = 20000;

/** 单次文本检测的应用层总时限，与扫描线 lib/scans/handler.ts 的 TOTAL_TIMEOUT_MS 对齐 */
export const TEXT_TOTAL_TIMEOUT_MS = 120_000;

/** 组合客户端取消与应用层总时限；AbortSignal.timeout 的内部定时器不阻塞进程退出 */
function composeAigcSignal(request: Request): AbortSignal {
  const timeout = AbortSignal.timeout(TEXT_TOTAL_TIMEOUT_MS);
  return request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return Response.json({ error: "缺少 text 参数（应为非空字符串）" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { error: `文本过长：${text.length} 字符，上限 ${MAX_TEXT_LENGTH} 字符，请分段检测` },
      { status: 400 },
    );
  }

  // 本地脱敏：确定性、不过模型。先算出来，判定失败时也不白跑一趟用户请求。
  const redaction = redactPii(text);

  // F01 默认最小化：模型只拿脱敏副本；仅显式 opt-in（严格 === true）才传原文
  const allowRawInput = (body as { allowRawInput?: unknown } | null)?.allowRawInput === true;
  const textForModel = allowRawInput ? text : redaction.redactedText;

  // F06：客户端已断开时直接中止，不发起（也不再消耗）模型调用
  if (request.signal?.aborted) {
    return Response.json({ error: "客户端已取消请求，AIGC 判定未发起" }, { status: 499 });
  }
  const signal = composeAigcSignal(request);

  let aigc;
  try {
    aigc = await detectAigc(textForModel, {
      chat,
      model: process.env.VERIPAGE_TEXT_MODEL?.trim() || undefined,
      signal,
    });
  } catch (err) {
    if (request.signal?.aborted) {
      // 客户端中途断开：模型调用已被 signal 中止，响应无人接收，如实标记取消
      return Response.json({ error: "客户端已取消请求，AIGC 判定中止" }, { status: 499 });
    }
    if (signal.aborted) {
      // 应用层总时限：上游挂起也有明确期限
      return Response.json(
        { error: `AIGC 判定超出总时限（${TEXT_TOTAL_TIMEOUT_MS / 1000} 秒），已中止模型调用` },
        { status: 502 },
      );
    }
    if (err instanceof AigcUnavailableError) {
      // 明确失败：不返回任何「默认人类所写」的判定
      return Response.json({ error: err.message }, { status: 502 });
    }
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `AIGC 判定失败：${detail}` }, { status: 502 });
  }

  return Response.json({ aigc, redaction });
}
