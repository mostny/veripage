/**
 * Production-browser diagnostic for main@19b2ee9: older text response overwrites newer input.
 * Requires an existing production build. Model HTTP is intercepted with synthetic responses.
 * A successful exit means the defect was reproduced, not that product acceptance passed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "playwright";

const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
const outputDirectory = process.env.VERIPAGE_AUDIT_OUTPUT;
if (outputDirectory) await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

const server = spawn(process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
  { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let browser;
let startupTimer;
try {
  let startup = "";
  await new Promise((resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error("Audit next start timed out")), 25_000);
    server.stdout.on("data", (chunk) => { startup += chunk.toString(); if (startup.includes("Ready in")) resolve(); });
    server.stderr.on("data", (chunk) => { startup += chunk.toString(); });
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`next start exited ${code}: ${startup.slice(-1000)}`)));
  });
  clearTimeout(startupTimer);

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pending = [];
  let firstSeen;
  let secondSeen;
  const firstRequest = new Promise((resolve) => { firstSeen = resolve; });
  const secondRequest = new Promise((resolve) => { secondSeen = resolve; });
  await page.route("**/api/text", (route) => {
    pending.push(route);
    if (pending.length === 1) firstSeen();
    if (pending.length === 2) secondSeen();
  });
  const fontPath = process.env.VERIPAGE_REVIEW_CJK_FONT;
  if (fontPath) {
    const font = await readFile(fontPath);
    await page.route("**/audit-cjk.otf", (route) => route.fulfill({ status: 200, contentType: "font/otf", body: font }));
  }
  await page.goto(`http://127.0.0.1:${port}/text`);
  await page.locator("#text-input").waitFor();
  if (fontPath) {
    await page.addStyleTag({ content: "@font-face{font-family:AuditCJK;src:url('/audit-cjk.otf') format('opentype')}body{font-family:AuditCJK,sans-serif!important}.font-mono{font-family:var(--font-geist-mono),AuditCJK,monospace!important}" });
    await page.evaluate(() => document.fonts.ready);
  }
  const inputA = "AUDIT_INPUT_A ".repeat(5);
  const inputB = "AUDIT_INPUT_B ".repeat(5);
  await page.locator("#text-input").fill(inputA);
  await page.locator("#text-input").press("Control+Enter");
  await firstRequest;
  const buttonDisabledDuringFirstRequest = await page.locator('button[aria-busy="true"]').isDisabled();
  await page.locator("#text-input").fill(inputB);
  await page.locator("#text-input").press("Control+Enter");
  await Promise.race([secondRequest, new Promise((_resolve, reject) => setTimeout(() => reject(new Error("Second keyboard request was not observed")), 5_000))]);

  const response = (marker) => ({
    aigc: { isAigc: false, confidence: 0.3, conclusion: "undetermined", signals: [marker], caveats: ["Synthetic audit fixture"], promptVersion: "fixture", model: "fixture", repaired: false },
    redaction: { redactedText: marker, hits: [], counts: { "id-card": 0, phone: 0, "bank-card": 0, email: 0 }, note: "Synthetic audit fixture" },
  });
  await pending[1].fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response("AUDIT_RESULT_B")) });
  await page.waitForFunction(() => document.getElementById("redacted-text")?.textContent === "AUDIT_RESULT_B");
  await pending[0].fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response("AUDIT_RESULT_A")) });
  await page.waitForFunction(() => document.getElementById("redacted-text")?.textContent === "AUDIT_RESULT_A");
  const currentInput = await page.locator("#text-input").inputValue();
  const finalResult = await page.locator("#redacted-text").textContent();
  assert.equal(pending.length, 2);
  assert.equal(currentInput, inputB);
  assert.equal(finalResult, "AUDIT_RESULT_A");
  console.log("REPRO text-response-race", JSON.stringify({
    requestCount: pending.length,
    buttonDisabledDuringFirstRequest,
    currentInputIsB: currentInput === inputB,
    finalDisplayedResultIsA: finalResult === "AUDIT_RESULT_A",
  }));

  if (outputDirectory) {
    await page.screenshot({ path: path.join(outputDirectory, "text-race-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 820 });
    await page.screenshot({ path: path.join(outputDirectory, "text-race-mobile.png"), fullPage: true });
  }
} finally {
  if (startupTimer) clearTimeout(startupTimer);
  await browser?.close().catch(() => undefined);
  if (server.exitCode === null) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { server.kill("SIGTERM"); }
    await Promise.race([once(server, "exit").catch(() => undefined), new Promise((resolve) => { const timer = setTimeout(resolve, 5_000); timer.unref(); })]);
    if (server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); } }
  }
}
