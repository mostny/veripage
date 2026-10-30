import { randomUUID } from "node:crypto";
import { artifactCookieName, artifactStore, type ArtifactStore } from "../artifacts/store.ts";
import type { CaseSnapshot } from "../evidence/types.ts";
import { createScanSseResponse } from "./sse.ts";
import type { ScanEvent } from "../agent/orchestrator.ts";

export interface ScanHandlerContext {
  signal: AbortSignal;
  taskId: string;
  sessionToken: string;
}

export type ScanHandlerRunner = (
  url: string,
  onEvent: (event: ScanEvent) => void,
  context: ScanHandlerContext,
) => Promise<CaseSnapshot>;

export interface ScanHandlerOptions {
  runScan: ScanHandlerRunner;
  artifactStore?: ArtifactStore;
  timeoutMs?: number;
}

const TOTAL_TIMEOUT_MS = 120_000;

function normalizeUrlInput(raw: string): string {
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Request validation, artifact session issuance, and SSE lifecycle shared by the route and offline tests. */
export async function handleScanPost(request: Request, options: ScanHandlerOptions): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const rawUrl = (body as { url?: unknown } | null)?.url;
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return Response.json({ error: "缺少 url 参数（应为非空字符串）" }, { status: 400 });
  }

  const targetUrl = normalizeUrlInput(rawUrl);
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
  const store = options.artifactStore ?? artifactStore;
  let session: Awaited<ReturnType<ArtifactStore["createSession"]>>;
  try {
    session = await store.createSession(taskId);
  } catch {
    return Response.json({ error: "无法创建本次检测的临时证据会话" }, { status: 503 });
  }

  const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === "production" || new URL(request.url).protocol === "https:";
  const headers = new Headers();
  headers.set(
    "Set-Cookie",
    `${artifactCookieName(taskId)}=${session.token}; Path=/api/scans/${taskId}/artifacts; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`,
  );

  return createScanSseResponse(
    request,
    targetUrl,
    (url, onEvent, signal) => options.runScan(url, onEvent, {
      signal,
      taskId,
      sessionToken: session.token,
    }),
    {
      taskId,
      timeoutMs: options.timeoutMs ?? TOTAL_TIMEOUT_MS,
      headers,
      onSettled: (outcome) => outcome === "reported"
        ? store.releaseSessionIfEmpty(taskId)
        : store.removeTask(taskId),
    },
  );
}
