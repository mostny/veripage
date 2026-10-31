/**
 * Diagnostic reproductions for main@19b2ee9, not a passing product acceptance test.
 * Run from the repository root: node docs/audits/2026-10-30/reproduce-text.mjs
 * All data is synthetic; model fetch is replaced before any route invocation.
 */
import assert from "node:assert/strict";
import { POST } from "../../../app/api/text/route.ts";
import { redactPii } from "../../../lib/text/redact.ts";

const savedFetch = globalThis.fetch;
const savedEnvironment = new Map(
  ["VERIPAGE_AGNES_BASE_URL", "VERIPAGE_AGNES_API_KEY"].map((key) => [key, process.env[key]]),
);
const requests = [];

try {
  process.env.VERIPAGE_AGNES_BASE_URL = "https://audit.invalid/v1";
  process.env.VERIPAGE_AGNES_API_KEY = "audit-fixture-not-a-real-credential";
  globalThis.fetch = async (_input, init) => {
    requests.push({ body: String(init?.body ?? ""), signal: init?.signal });
    return Response.json({
      choices: [{ message: { content: JSON.stringify({
        isAigc: false,
        confidence: 0.3,
        signals: [],
        caveats: ["Synthetic audit fixture; no real model was called."],
      }) }, finish_reason: "stop" }],
    });
  };

  const input = "联系 13800138000，邮箱 test@example.com";
  const response = await POST(new Request("http://audit.local/api/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: input }),
  }));
  const result = await response.json();
  const outbound = requests[0]?.body ?? "";
  const privacy = {
    status: response.status,
    modelBodyContainsRawPhone: outbound.includes("13800138000"),
    modelBodyContainsRawEmail: outbound.includes("test@example.com"),
    returnedRedactionContainsRawPhone: result.redaction?.redactedText.includes("13800138000"),
    returnedRedactionContainsRawEmail: result.redaction?.redactedText.includes("test@example.com"),
  };
  assert.equal(privacy.status, 200);
  assert.equal(privacy.modelBodyContainsRawPhone, true);
  assert.equal(privacy.modelBodyContainsRawEmail, true);
  assert.equal(privacy.returnedRedactionContainsRawPhone, false);
  assert.equal(privacy.returnedRedactionContainsRawEmail, false);
  console.log("REPRO raw-PII-in-model-request", JSON.stringify(privacy));

  const controller = new AbortController();
  controller.abort(new DOMException("synthetic cancelled request", "AbortError"));
  const previousCount = requests.length;
  const cancelled = await POST(new Request("http://audit.local/api/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "synthetic cancellation audit fixture" }),
    signal: controller.signal,
  }));
  const cancellation = {
    requestAlreadyAborted: controller.signal.aborted,
    modelCallsAfterAbort: requests.length - previousCount,
    forwardedSignalPresent: requests.at(-1)?.signal !== undefined,
    status: cancelled.status,
  };
  assert.equal(cancellation.modelCallsAfterAbort, 1);
  assert.equal(cancellation.forwardedSignalPresent, false);
  console.log("REPRO text-request-cancellation-not-forwarded", JSON.stringify(cancellation));

  const overlap = redactPii("alice+13800138000@example.com");
  assert.equal(overlap.redactedText, "alice+[手机号已脱敏]@example.com");
  assert.equal(overlap.counts.email, 0);
  console.log("REPRO email-containing-phone-overlap", JSON.stringify({
    redactedText: overlap.redactedText,
    counts: overlap.counts,
    hitTypes: overlap.hits.map((hit) => hit.type),
  }));
} finally {
  globalThis.fetch = savedFetch;
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
