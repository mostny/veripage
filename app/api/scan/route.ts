/** POST /api/scan — input validation and bounded scan SSE lifecycle. */

import { randomUUID } from "node:crypto";
import { artifactCookieName, artifactStore, type ScanArtifactSession } from "../../../lib/artifacts/store.ts";
import { runScan } from "../../../lib/agent/orchestrator.ts";
import { createScanSseResponse } from "../../../lib/scans/sse.ts";

/** Covers the Playwright, vision and bounded analyzer-repair stages. */
const TOTAL_TIMEOUT_MS = 120_000;

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const url = (body as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return Response.json({ error: "缺少 url 参数（应为非空字符串）" }, { status: 400 });
  }

  const targetUrl = normalizeUrlInput(url);
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return Response.json({ error: "URL 无法解析" }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json(
      { error: `协议不被允许：${parsed.protocol.replace(":", "")}（仅支持 http/https）` },
      { status: 400 },
    );
  }

  const taskId = randomUUID();
  let session: ScanArtifactSession;
  try {
    session = await artifactStore.createSession(taskId);
  } catch {
    return Response.json({ error: "无法创建本次检测的临时证据会话" }, { status: 503 });
  }

  const cookieName = artifactCookieName(taskId);
  const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
  const headers = new Headers();
  headers.set(
    "Set-Cookie",
    `${cookieName}=${session.token}; Path=/api/scans/${taskId}/artifacts; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );

  return createScanSseResponse(
    request,
    targetUrl,
    (scanUrl, onEvent, signal) => runScan(scanUrl, onEvent, {
      signal,
      artifactSession: { taskId, token: session.token },
    }),
    {
      taskId,
      timeoutMs: TOTAL_TIMEOUT_MS,
      headers,
      onSettled: () => artifactStore.releaseSessionIfEmpty(taskId),
    },
  );
}
