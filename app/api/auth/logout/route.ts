import { NextResponse } from "next/server";
import { REVIEWER_COOKIE, authError, getReviewerConfig, isSameOrigin, reviewerCookieOptions } from "../../../../lib/auth/reviewer.ts";

export async function POST(request: Request): Promise<Response> {
  const config = getReviewerConfig();
  if (!config) return authError("评测账号尚未配置，请联系项目负责人", 503);
  if (!isSameOrigin(request, config)) return authError("请求来源不匹配，请从本站页面操作", 403);
  const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  response.cookies.set(REVIEWER_COOKIE, "", { ...reviewerCookieOptions(config), maxAge: 0 });
  return response;
}
