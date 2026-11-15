import { NextResponse } from "next/server";
import {
  REVIEWER_COOKIE,
  authError,
  consumeLoginAttempt,
  createReviewerSession,
  getReviewerConfig,
  isSameOrigin,
  reviewerCookieOptions,
  verifyReviewerCredentials,
} from "../../../../lib/auth/reviewer.ts";

export async function POST(request: Request): Promise<Response> {
  const config = getReviewerConfig();
  if (!config) return authError("评测账号尚未配置，请联系项目负责人", 503);
  if (!isSameOrigin(request, config)) return authError("请求来源不匹配，请从本站登录页操作", 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return authError("请使用 JSON 提交登录信息", 400);
  }
  // Bound the body before parsing it, including chunked requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return authError("请输入账号和密码", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return authError("登录信息过长", 413);
      }
      chunks.push(value);
    }
  } catch {
    return authError("无法读取登录信息，请重试", 400);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return authError("请求体不是合法 JSON", 400);
  }
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || !username || username.length > 64 ||
      typeof password !== "string" || !password || password.length > 256) {
    return authError("请输入有效的账号和密码", 400);
  }
  const retryAfter = consumeLoginAttempt();
  if (retryAfter) return authError("登录尝试过于频繁，请稍后重试", 429, { "Retry-After": String(retryAfter) });
  if (!await verifyReviewerCredentials(username, password, config)) {
    return authError("账号或密码不正确", 401);
  }
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  response.cookies.set(REVIEWER_COOKIE, await createReviewerSession(config), reviewerCookieOptions(config));
  return response;
}
