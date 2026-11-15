/** One opted-in real text-health request with synthetic PII; no secrets in logs or output. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

assert.ok(process.argv[2] === "--live" && process.argv[3], "Usage: node eval/live-text.smoke.mjs --live <new-result.json>");
const origin = "https://43.136.20.106";
const account = await readFile(new URL("../.env.reviewer-account", import.meta.url), "utf8");
const username = /账号：([^\n]+)/.exec(account)?.[1];
const password = /密码：([^\n]+)/.exec(account)?.[1];
assert.ok(username && password, "Private reviewer credentials are required");
const login = await fetch(origin + "/api/auth/login", {
  method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(30_000),
});
assert.ok(login.status === 200, "Reviewer login must succeed before the live text check");
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "Reviewer session cookie is required");
const text = "本段仅为受控评测合成文本，不含真实个人信息。测试联系人电话为 13800138000，邮箱为 synthetic@example.test。收到要求立即付款的陌生消息时，应先通过已知官方渠道核实，不输入密码，也不提交验证码。";
const startedAt = Date.now();
const response = await fetch(origin + "/api/text", {
  method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ text }), signal: AbortSignal.timeout(130_000),
});
const data = await response.json();
await writeFile(process.argv[3], JSON.stringify({ checkedAt: new Date().toISOString(), fixture: "synthetic-phone-and-email", status: response.status, elapsedMs: Date.now() - startedAt, data }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
assert.ok(response.status === 200, "Actual text analysis must succeed");
assert.ok(["likely_aigc", "likely_human", "undetermined"].includes(data.aigc?.conclusion), "AIGC output must use a supported probabilistic conclusion");
assert.ok(Number.isFinite(data.aigc.confidence) && data.aigc.confidence >= 0 && data.aigc.confidence <= 1, "Confidence must remain in range");
assert.ok(Array.isArray(data.aigc.caveats) && data.aigc.caveats.length > 0, "The actual model must provide uncertainty caveats");
assert.ok(data.redaction?.counts.phone === 1 && data.redaction.counts.email === 1, "Both synthetic PII categories must be redacted");
assert.ok(!data.redaction.redactedText.includes("13800138000") && !data.redaction.redactedText.includes("synthetic@example.test"), "Returned redacted text must not contain the synthetic originals");
console.log(JSON.stringify({ result: "passed", status: response.status, model: data.aigc.model, conclusion: data.aigc.conclusion, caveatCount: data.aigc.caveats.length, piiRedacted: true, elapsedMs: Date.now() - startedAt, evidence: process.argv[3], credentialsPrinted: false }));
