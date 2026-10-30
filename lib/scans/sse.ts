import type { CaseSnapshot } from "../evidence/types.ts";
import type { ScanEvent } from "../agent/orchestrator.ts";

export type ScanRunner = (
  url: string,
  onEvent: (event: ScanEvent) => void,
  signal: AbortSignal,
) => Promise<CaseSnapshot>;

export interface ScanSseOptions {
  taskId: string;
  timeoutMs: number;
  headers?: HeadersInit;
  onSettled?: (outcome: ScanSseOutcome) => void | Promise<void>;
}

export type ScanSseOutcome = "reported" | "failed" | "timed-out" | "cancelled";

function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 240) || "未知错误";
}

/**
 * Shared SSE lifecycle for the scan route. A failed scan always has an explicit
 * terminal `validate=failed` event; client cancellation and timeout abort work.
 */
export function createScanSseResponse(
  request: Request,
  url: string,
  runScan: ScanRunner,
  options: ScanSseOptions,
): Response {
  const abortController = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let terminalSent = false;
  let responseClosed = false;
  let timeoutFired = false;
  let outcome: ScanSseOutcome | null = null;
  let settled = false;
  const encoder = new TextEncoder();

  const settle = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await options.onSettled?.(outcome ?? "cancelled");
    } catch {
      // Cleanup errors must not turn a terminal response into an unhandled rejection.
    }
  };

  const abort = (reason: unknown): void => {
    if (!abortController.signal.aborted) abortController.abort(reason);
  };
  const close = (): void => {
    if (responseClosed) return;
    responseClosed = true;
    try {
      streamController?.close();
    } catch {
      // The client may already have cancelled the stream.
    }
  };
  const send = (payload: unknown): boolean => {
    if (responseClosed) return false;
    try {
      streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      return true;
    } catch {
      outcome = "cancelled";
      abort(new DOMException("The client disconnected", "AbortError"));
      return false;
    }
  };
  const sendFailure = (reason: string): void => {
    if (terminalSent) return;
    terminalSent = true;
    send({ type: "step", step: "validate", state: "failed", reason });
  };

  const onRequestAbort = (): void => {
    if (outcome !== "reported") outcome = "cancelled";
    abort(request.signal.reason ?? new DOMException("The client disconnected", "AbortError"));
    close();
  };
  request.signal.addEventListener("abort", onRequestAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      streamController = controller;
      send({ type: "started", taskId: options.taskId });

      if (request.signal.aborted) {
        onRequestAbort();
        await settle();
        return;
      }

      let rejectOnAbort: ((reason: unknown) => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        rejectOnAbort = reject;
      });
      const onAbort = (): void => {
        rejectOnAbort?.(abortController.signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      abortController.signal.addEventListener("abort", onAbort, { once: true });

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          timeoutFired = true;
          outcome = "timed-out";
          const reason = new Error("检测总时限已达设定预算");
          abort(reason);
          reject(reason);
        }, options.timeoutMs);
      });

      try {
        const snapshot = await Promise.race([
          runScan(
            url,
            (event) => {
              if (event.type === "step") send(event);
            },
            abortController.signal,
          ),
          timeoutPromise,
          abortPromise,
        ]);
        if (!abortController.signal.aborted && !terminalSent) {
          terminalSent = true;
          if (send({ type: "report", snapshot })) outcome = "reported";
        }
      } catch (error) {
        if (timeoutFired) {
          outcome = "timed-out";
          sendFailure(errorReason(error));
        } else if (outcome === "cancelled" || request.signal.aborted || responseClosed) {
          outcome = "cancelled";
        } else {
          outcome = "failed";
          sendFailure("检测未能完成：" + errorReason(error));
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        abortController.signal.removeEventListener("abort", onAbort);
        request.signal.removeEventListener("abort", onRequestAbort);
        close();
        await settle();
      }
    },
    cancel(reason) {
      if (outcome !== "reported") outcome = "cancelled";
      abort(reason ?? new DOMException("The client cancelled the request", "AbortError"));
      request.signal.removeEventListener("abort", onRequestAbort);
      if (timeoutId) clearTimeout(timeoutId);
      void settle();
    },
  });

  const headers = new Headers(options.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");

  return new Response(body, { headers });
}
