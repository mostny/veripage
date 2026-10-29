/**
 * Production-browser workbench journey with mocked SSE and screenshot endpoints.
 * Build first, then run: node eval/workbench.e2e.mjs
 * Optional visual review: VERIPAGE_REVIEW_CJK_FONT=/path/to/NotoSansCJKsc-Regular.otf node eval/workbench.e2e.mjs
 * No external target navigation and no model/API credential are used.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { chromium } from "playwright";

const PORT_SERVER = createServer();
PORT_SERVER.listen(0, "127.0.0.1");
await once(PORT_SERVER, "listening");
const port = PORT_SERVER.address().port;
await new Promise((resolve, reject) => PORT_SERVER.close((error) => error ? reject(error) : resolve()));

const server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
  { cwd: process.cwd(), env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);

async function stopServer() {
  if (server.exitCode !== null) return;
  try { process.kill(-server.pid, "SIGTERM"); } catch {}
  await Promise.race([
    once(server, "exit").catch(() => undefined),
    new Promise((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref(); }),
  ]);
  if (server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch {} }
}

let serverOutput = "";
const startupTimer = setTimeout(() => server.kill("SIGTERM"), 25_000);
try {
  await new Promise((resolve, reject) => {
    server.stdout.on("data", (chunk) => {
      serverOutput += chunk.toString();
      if (serverOutput.includes("Ready in")) resolve();
    });
    server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`next start exited ${code}: ${serverOutput.slice(-2000)}`)));
  });
} catch (error) {
  clearTimeout(startupTimer);
  await stopServer();
  throw error;
}
clearTimeout(startupTimer);

let browser;
try {
const taskId = "11111111-2222-4333-8444-555555555555";
const artifactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const artifactCookie = `vp_scan_${taskId.replaceAll("-", "")}=fixture-session; Path=/api/scans/${taskId}/artifacts; HttpOnly; SameSite=Strict`;
const timestamp = "2026-10-29T10:00:00.000Z";
const reviewCjkFont = process.env.VERIPAGE_REVIEW_CJK_FONT;
const reviewCjkFontBytes = reviewCjkFont ? await readFile(reviewCjkFont) : undefined;

const snapshot = {
  id: "case-workbench-fixture",
  createdAt: timestamp,
  inputSummary: { displayUrl: "https://example.test/login", registrableDomain: "example.test" },
  versions: { reportSchema: "1.0", model: "fixture-model", prompt: "fixture", policy: "1.0", knowledge: "fixture" },
  originalAssessment: {
    risk: "suspicious",
    evidenceSufficiency: "partial",
    gaps: ["示例缺口：没有第三方授权证明。"],
    summary: "页面有密码输入要求，域名关系需要进一步核实。",
    findings: [
      { id: "f-form", statement: "页面出现密码输入框。", kind: "observed_fact", evidenceIds: ["ev-form-1"], alternativeExplanations: [] },
      { id: "f-identity", statement: "页面声称 Example 身份，但域名关系尚未确认。", kind: "inference", evidenceIds: ["f-form", "ev-url"], alternativeExplanations: ["可能是经授权的第三方登录页面。"] },
    ],
    unknowns: ["该第三方登录是否已获授权未知。"],
    recommendedAction: "请从官方渠道核实页面身份后再输入凭据。",
  },
  coverage: [
    { step: "s0-guard", state: "completed" },
    { step: "gate1-static", state: "completed" },
    { step: "gate2-fetch", state: "partial", reason: "fixture 中有一个资源未取回" },
    { step: "gate3-vision", state: "completed" },
    { step: "gate3-analyzer", state: "completed" },
    { step: "validate", state: "completed" },
  ],
  evidence: [
    { id: "ev-url", type: "url", capturedAt: timestamp, source: "user-input", locator: "https://example.test/login", excerpt: "https://example.test/login" },
    { id: "ev-form-1", type: "form", capturedAt: timestamp, source: "playwright:document.forms", locator: "form[action=/collect]", excerpt: "method=post 密码框=有 输入项=2" },
    { id: "ev-screenshot", type: "screenshot", capturedAt: timestamp, source: "playwright:page.screenshot(fullPage)", locator: "fullPage 1280x800", excerpt: "截图已保存为短期证据产物", artifactId },
    { id: "ev-warnings", type: "text", capturedAt: timestamp, source: "orchestrator:warnings", locator: "coverage", excerpt: "取证告警：一个次级资源未取回" },
  ],
  artifactIds: [artifactId],
};

const serializeEvent = (event) => `data: ${JSON.stringify(event)}\n\n`;
const successSse = [
  { type: "started", taskId },
  ...snapshot.coverage.map(({ step, state, reason }) => ({ type: "step", step, state, ...(reason ? { reason } : {}) })),
  { type: "report", snapshot },
].map(serializeEvent).join("");

browser = await chromium.launch({ headless: true });
const screenshotFixturePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await screenshotFixturePage.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#14243a;font-family:Arial,sans-serif}
  header{height:66px;background:#12304e;color:white;display:flex;align-items:center;padding:0 52px;font-weight:700}
  main{display:grid;place-items:center;height:734px;padding:32px}
  article{width:440px;background:white;border:1px solid #d9e1ea;border-radius:18px;padding:36px;box-shadow:0 16px 50px #102a4318}
  h1{font-size:25px;margin:0 0 8px}p{color:#69798c;font-size:14px;line-height:1.6}
  label{display:block;margin-top:20px;font-size:13px;font-weight:600;color:#43566c}
  .field{margin-top:8px;height:46px;border:1px solid #cfd9e4;border-radius:8px;padding:13px;color:#9ba8b6;font-size:14px}
  .button{margin-top:24px;height:46px;border-radius:8px;background:#1674dd;color:white;text-align:center;padding:14px;font-weight:700}
  .note{margin-top:18px;text-align:center;color:#8493a4;font-size:12px}
  </style></head><body><header>EXAMPLE&nbsp;&nbsp; Account Center</header><main><article><h1>Secure sign in</h1><p>Verify your account to continue.</p><label>Email or username</label><div class="field">name@example.com</div><label>Password</label><div class="field">••••••••••••</div><div class="button">Continue</div><div class="note">Protected account access</div></article></main></body></html>`);
const png = await screenshotFixturePage.screenshot({ type: "png" });
await screenshotFixturePage.close();
let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
};

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  if (reviewCjkFontBytes) {
    await page.route("**/workbench-review-font.otf", (route) => route.fulfill({
      status: 200,
      headers: { "Content-Type": "font/otf", "Cache-Control": "no-store" },
      body: reviewCjkFontBytes,
    }));
  }
  let artifactCookieReceived = "";
  await page.route("**/api/scan", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Set-Cookie": artifactCookie },
    body: successSse,
  }));
  await page.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, async (route) => {
    artifactCookieReceived = route.request().headers().cookie ?? "";
    await route.fulfill({ status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" }, body: png });
  });

  await page.goto(`http://127.0.0.1:${port}/scan?url=${encodeURIComponent("https://example.test/login")}`);
  if (reviewCjkFontBytes) {
    await page.addStyleTag({ content: "@font-face{font-family:WorkbenchReviewCJK;src:url('/workbench-review-font.otf') format('opentype');font-weight:100 900}html,body{font-family:WorkbenchReviewCJK,var(--font-geist-sans),sans-serif!important}" });
    await page.evaluate(() => document.fonts.ready);
  }
  await page.getByRole("heading", { name: "本次核验结论" }).waitFor();
  const image = page.locator('img[alt^="隔离环境采集"]');
  await image.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector('img[alt^="隔离环境采集"]');
    return element instanceof HTMLImageElement && element.complete && element.naturalWidth === 1280;
  });
  await page.screenshot({ path: "/tmp/opencode/veripage-workbench-desktop.png", fullPage: true });
  check("completed report presents separate risk and sufficiency", await page.getByText("可疑", { exact: true }).count() > 0 && await page.getByText("部分充分", { exact: true }).count() > 0);
  check("screenshot loads through the session-scoped artifact URL", artifactCookieReceived.includes(`vp_scan_${taskId.replaceAll("-", "")}`));

  const finding = page.locator("#finding-f-identity");
  await finding.focus();
  await page.keyboard.press("Enter");
  check("keyboard selection resolves an inference through its evidence chain", await page.locator("#evidence-ev-form-1").getAttribute("aria-pressed") === "true");
  await page.locator("#evidence-ev-form-1").click();
  check("clicking evidence highlights linked findings in reverse", await page.locator("#finding-f-form").getAttribute("aria-pressed") === "true");

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`workbench fits ${width}px viewport`, overflow <= 0, `horizontal overflow ${overflow}px`);
    if (width === 390) await page.screenshot({ path: "/tmp/opencode/veripage-workbench-mobile.png", fullPage: true });
  }

  // Unexpected EOF must stop the loading view and render a retryable alert.
  const interruptedPage = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await interruptedPage.route("**/api/scan", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: serializeEvent({ type: "started", taskId: "22222222-3333-4444-8555-666666666666" }) + serializeEvent({ type: "step", step: "s0-guard", state: "completed" }),
  }));
  interruptedPage.on("pageerror", (error) => console.log(`INTERRUPTED PAGEERROR ${error.message}`));
  interruptedPage.on("console", (message) => { if (message.type() === "error") console.log(`INTERRUPTED CONSOLE ${message.text()}`); });
  await interruptedPage.goto(`http://127.0.0.1:${port}/scan?url=${encodeURIComponent("https://interrupted.test/")}`);
  const interruption = interruptedPage.getByText("没有收到完整报告", { exact: false });
  await interruption.waitFor();
  check("report-less EOF exits loading and announces interruption", await interruption.count() === 1 && await interruptedPage.getByText("隔离取证与证据核验正在进行").count() === 0);
  await interruptedPage.close();

  const expiredPage = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await expiredPage.route("**/api/scan", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Set-Cookie": artifactCookie },
    body: successSse,
  }));
  await expiredPage.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({
    status: 404,
    headers: { "Content-Type": "text/plain", "Cache-Control": "private, no-store" },
    body: "Temporary evidence is unavailable.",
  }));
  await expiredPage.goto(`http://127.0.0.1:${port}/scan?url=${encodeURIComponent("https://expired.test/")}`);
  await expiredPage.getByRole("heading", { name: "本次核验结论" }).waitFor();
  const expiredNotice = expiredPage.getByText("临时截图已过期或暂时不可用", { exact: false });
  await expiredNotice.waitFor();
  check("expired screenshot explains its absence without losing the report", await expiredPage.getByText("页面有密码输入要求", { exact: false }).count() === 1);
  await expiredPage.close();

  // Explicit server failure is distinguishable from transport EOF.
  const failedPage = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await failedPage.route("**/api/scan", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: serializeEvent({ type: "started", taskId: "33333333-4444-4555-8666-777777777777" }) + serializeEvent({ type: "step", step: "validate", state: "failed", reason: "fixture server failure" }),
  }));
  await failedPage.goto(`http://127.0.0.1:${port}/scan?url=${encodeURIComponent("https://failed.test/")}`);
  const failureText = failedPage.getByText("fixture server failure", { exact: false });
  await failureText.waitFor();
  check("server failure message is preserved rather than relabeled as interruption", await failureText.count() === 1 && await failedPage.getByText("没有收到完整报告", { exact: false }).count() === 0);
  await failedPage.close();

  console.log(`ALL-PASS (${passed} browser assertions)`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer();
}
