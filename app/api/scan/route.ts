/**
 * POST /api/scan —— 检测编排的 SSE 外壳
 *
 * 本文件只做 HTTP 边界，不含任何检测逻辑：
 *   1. 参数校验（缺失 / 无法解析 → 400 JSON {error}）
 *   2. SSE 分帧：每条事件一行 `data: {JSON}\n\n`
 *   3. 总超时保护：120s 未跑完 → 发 validate failed(总超时) 并关闭流
 * 全部流程在 lib/agent/orchestrator.ts 的 runScan 中。
 *
 * 事件序列：started → step…（透传 runScan）→ report
 */

import { randomUUID } from "node:crypto";

import { runScan, type ScanEvent } from "../../../lib/agent/orchestrator.ts";

/** 单次检测总超时（ms）：闸门②沙箱 + 视觉 + 最多两次主分析调用都要在这条线内完成 */
const TOTAL_TIMEOUT_MS = 120_000;

/** 与闸门① normalizeInput 同一套补全规则：缺协议时补 https:// */
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
    return Response.json({ error: `URL 无法解析：${url}` }, { status: 400 });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Response.json(
      { error: `协议不被允许：${parsed.protocol.replace(":", "")}（仅支持 http/https）` },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      /** 统一 SSE 分帧；客户端已断开时静默丢弃 */
      const send = (payload: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          /* 连接已关闭，无需处理 */
        }
      };

      send({ type: "started", taskId: randomUUID() });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), TOTAL_TIMEOUT_MS);
      });

      try {
        const outcome = await Promise.race([
          runScan(targetUrl, (ev: ScanEvent) => send(ev)).then((snapshot) => ({
            timeout: false as const,
            snapshot,
          })),
          timeout,
        ]);
        if (outcome.timeout) {
          // 超时不等同于「检测完成」：明确告诉前端这一步失败了，且不给 report
          send({ type: "step", step: "validate", state: "failed", reason: "总超时" });
        } else {
          send({ type: "report", snapshot: outcome.snapshot });
        }
      } catch (err) {
        send({
          type: "step",
          step: "validate",
          state: "failed",
          reason: `编排器异常：${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        if (timer) clearTimeout(timer);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 反向代理（Nginx 等）默认会缓冲 SSE，关掉缓冲保证逐条送达
      "X-Accel-Buffering": "no",
    },
  });
}
