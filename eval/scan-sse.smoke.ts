/** Scan SSE lifecycle regression; entirely offline. Run: node eval/scan-sse.smoke.ts */
import assert from "node:assert/strict";
import { createScanSseResponse } from "../lib/scans/sse.ts";
import type { CaseSnapshot } from "../lib/evidence/types.ts";

const snapshot = {
  id: "case-fixture",
} as CaseSnapshot;

async function events(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/))
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

let passed = 0;
function check(name: string, condition: boolean): void {
  assert.ok(condition, name);
  passed += 1;
  console.log(`PASS ${name}`);
}

// Success: started -> steps -> exactly one report.
{
  let settled = "";
  const response = createScanSseResponse(
    new Request("http://veripage.local/api/scan", { method: "POST" }),
    "https://example.test/",
    async (_url, emit) => {
      emit({ type: "step", step: "s0-guard", state: "completed" });
      return snapshot;
    },
    { taskId: "task-success", timeoutMs: 500, onSettled: (outcome) => { settled = outcome; } },
  );
  const result = await events(response);
  check("SSE emits a success report", result.some((event) => event.type === "report"));
  check("SSE emits one terminal report", result.filter((event) => event.type === "report").length === 1);
  check("reported outcome is distinguished for artifact retention", settled === "reported");
}

// Unexpected failure: an explicit failed terminal event, never a fake report.
{
  let settled = "";
  const response = createScanSseResponse(
    new Request("http://veripage.local/api/scan", { method: "POST" }),
    "https://example.test/",
    async () => { throw new Error("fixture failure"); },
    { taskId: "task-failure", timeoutMs: 500, onSettled: (outcome) => { settled = outcome; } },
  );
  const result = await events(response);
  check("SSE failure ends with validate=failed", result.some((event) => event.type === "step" && event.step === "validate" && event.state === "failed"));
  check("SSE failure does not fabricate a report", !result.some((event) => event.type === "report"));
  check("failed outcome is distinguished for artifact cleanup", settled === "failed");
}

// Timeout: abort the owned scan and end the stream with a visible failure.
{
  let signalAborted = false;
  let settled = "";
  const response = createScanSseResponse(
    new Request("http://veripage.local/api/scan", { method: "POST" }),
    "https://example.test/",
    (_url, _emit, signal) => new Promise<CaseSnapshot>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    { taskId: "task-timeout", timeoutMs: 20, onSettled: (outcome) => { settled = outcome; } },
  );
  const result = await events(response);
  check("timeout aborts the scan signal", signalAborted);
  check("timeout emits failed terminal state", result.some((event) => event.type === "step" && event.step === "validate" && event.state === "failed"));
  check("timeout closes without report", !result.some((event) => event.type === "report"));
  check("timed-out outcome is distinguished for artifact cleanup", settled === "timed-out");
}

// Client disconnect: cancel the scan and close the response without a report.
{
  const requestController = new AbortController();
  let signalAborted = false;
  let settled = "";
  const response = createScanSseResponse(
    new Request("http://veripage.local/api/scan", { method: "POST", signal: requestController.signal }),
    "https://example.test/",
    (_url, _emit, signal) => new Promise<CaseSnapshot>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        signalAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    { taskId: "task-cancelled", timeoutMs: 500, onSettled: (outcome) => { settled = outcome; } },
  );
  const reading = events(response);
  requestController.abort(new DOMException("fixture disconnect", "AbortError"));
  const result = await reading;
  check("request disconnect aborts the scan signal", signalAborted);
  check("cancelled scan emits no report", !result.some((event) => event.type === "report"));
  check("cancelled outcome is distinguished for artifact cleanup", settled === "cancelled");
}

console.log(`ALL-PASS (${passed})`);
