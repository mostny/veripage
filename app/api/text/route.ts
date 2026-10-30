/**
 * POST /api/text — 文本第二条线：AIGC 判定 + 本地正则脱敏
 *
 * 证据纪律（任务书 P2 §3）：
 * - AIGC 判定是「推断」级：只透传模型的 signals/caveats，两次解析失败返回 502
 *   明确错误，绝不静默返回「是人类写的」
 * - 脱敏是「观察事实」级：本地正则、确定性输出；命中清单只含类型与位置区间
 * - 不声称删除任何数据：脱敏只发生在返回给用户的文本里
 */

import { chat } from "../../../lib/models.ts";
import { AigcUnavailableError, detectAigc } from "../../../lib/text/aigc.ts";
import { redactPii } from "../../../lib/text/redact.ts";

/** 入参长度上限（任务书 §2：如 20000 字符） */
export const MAX_TEXT_LENGTH = 20000;

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

  let aigc;
  try {
    aigc = await detectAigc(text, { chat, model: process.env.VERIPAGE_TEXT_MODEL?.trim() || undefined });
  } catch (err) {
    if (err instanceof AigcUnavailableError) {
      // 明确失败：不返回任何「默认人类所写」的判定
      return Response.json({ error: err.message }, { status: 502 });
    }
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `AIGC 判定失败：${detail}` }, { status: 502 });
  }

  return Response.json({ aigc, redaction });
}
