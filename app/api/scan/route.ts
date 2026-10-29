/**
 * POST /api/scan —— 检测编排的 SSE 入口
 *
 * 请求：{ "url": "https://..." }
 * 响应：text/event-stream，每条事件 `data: {JSON}\n\n`：
 *   {type:"started", taskId} → {type:"step", step, state, detail?, reason?}* → {type:"report", snapshot}
 * 路由只做 HTTP 壳与超时保护，全部逻辑在 lib/agent/orchestrator。
 */

import { runScan } from "@/lib/agent/orchestrator";

const TOTAL_TIMEOUT_MS = 120_000;

export async function POST(request: Request): Promise<Response> {
  let body: { url?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    // 走下面的 400 分支
  }
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (url.length === 0) {
    return Response.json({ error: "缺少 url 字段" }, { status: 400 });
  }
  try {
    new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return Response.json({ error: "url 无法解析" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (obj: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true; // 客户端断开
        }
      };

      const timer = setTimeout(() => {
        send({ type: "step", step: "validate", state: "failed", reason: `总超时 ${TOTAL_TIMEOUT_MS}ms` });
      }, TOTAL_TIMEOUT_MS);

      try {
        send({ type: "started", taskId: crypto.randomUUID() });
        await runScan(url, (ev) => send(ev));
      } catch (err) {
        send({
          type: "step",
          step: "validate",
          state: "failed",
          reason: `编排器异常：${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        clearTimeout(timer);
        closed = true;
        try {
          controller.close();
        } catch {
          // 已关闭则忽略
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
