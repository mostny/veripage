/**
 * Production-browser workbench journey with mocked SSE and screenshot endpoints.
 * Build first, then run: node --experimental-strip-types eval/workbench.e2e.mjs
 * Optional visual review: VERIPAGE_REVIEW_CJK_FONT=/path/to/NotoSansCJKsc-Regular.otf node --experimental-strip-types eval/workbench.e2e.mjs
 * No external target navigation and no model/API credential are used.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { installReviewerFixture } from "./reviewer-fixture.ts";
import { REVIEWER_COOKIE } from "../lib/auth/reviewer.ts";

const PORT_SERVER = createServer();
PORT_SERVER.listen(0, "127.0.0.1");
await once(PORT_SERVER, "listening");
const port = PORT_SERVER.address().port;
await new Promise((resolve, reject) => PORT_SERVER.close((error) => error ? reject(error) : resolve()));

const origin = `http://127.0.0.1:${port}`;
const outputDirectory = await mkdtemp(join(process.env.VERIPAGE_E2E_OUTPUT_DIR ?? tmpdir(), "veripage-workbench-"));
console.log(`SCREENSHOTS ${outputDirectory}`);
const reviewer = await installReviewerFixture(origin);
let server;
let browser;
let streamingServer;
const streamingResponses = new Set();

/** Windows 上没有进程组信号：组杀失败后退回按 pid 杀，再不行用 taskkill /T /F 杀整树（对齐 eval/text-page.e2e.mjs，审计 F16） */
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const pid = server.pid;
  try { process.kill(-pid, "SIGTERM"); } catch {}
  try { process.kill(pid, "SIGTERM"); } catch {}
  await Promise.race([
    once(server, "exit").catch(() => undefined),
    new Promise((resolve) => { const timer = setTimeout(resolve, 5000); timer.unref(); }),
  ]);
  if (server.exitCode === null) {
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

try {
server = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      VERIPAGE_AGNES_BASE_URL: "http://127.0.0.1:1",
      VERIPAGE_AGNES_API_KEY: "offline-workbench-fixture-key",
      VERIPAGE_TEXT_MODEL: "offline-workbench-fixture-model",
      VERIPAGE_VISION_MODEL: "offline-workbench-fixture-model",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
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
} finally {
  clearTimeout(startupTimer);
}
const taskId = "11111111-2222-4333-8444-555555555555";
const artifactId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const rawArtifactId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
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
    { id: "ev-url", type: "url", capturedAt: timestamp, source: "user-input", locator: "https://example.test/login", excerpt: "https://example.test/login", artifactId: rawArtifactId },
    { id: "ev-form-1", type: "form", capturedAt: timestamp, source: "playwright:document.forms", locator: "form[action=/collect]", excerpt: "method=post 密码框=有 输入项=2" },
    { id: "ev-screenshot", type: "screenshot", capturedAt: timestamp, source: "playwright:page.screenshot(fullPage)", locator: "fullPage 1280x800", excerpt: "截图已保存为短期证据产物", artifactId },
    { id: "ev-warnings", type: "text", capturedAt: timestamp, source: "orchestrator:warnings", locator: "coverage", excerpt: "取证告警：一个次级资源未取回" },
  ],
  artifactIds: [artifactId, rawArtifactId],
};

const serializeEvent = (event) => `data: ${JSON.stringify(event)}\n\n`;
const sseFor = (report) => [
  { type: "started", taskId },
  ...report.coverage.map(({ step, state, reason }) => ({ type: "step", step, state, ...(reason ? { reason } : {}) })),
  { type: "report", snapshot: report },
].map(serializeEvent).join("");
const successSse = sseFor(snapshot);

browser = await chromium.launch({ headless: true, chromiumSandbox: true });
const authenticateContext = (context) => context.addCookies([{
  name: REVIEWER_COOKIE,
  value: reviewer.cookie.slice(REVIEWER_COOKIE.length + 1),
  url: origin,
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
}]);
async function createReviewerPage(options) {
  const page = await browser.newPage(options);
  await authenticateContext(page.context());
  return page;
}
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
await screenshotFixturePage.setViewportSize({ width: 960, height: 800 });
const secondPng = await screenshotFixturePage.screenshot({ type: "png" });
await screenshotFixturePage.close();
let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
};

const startScan = async (page, target, keyboard = false) => {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator("#scan-url").fill(target);
  if (keyboard) await page.locator("#scan-url").press("Enter");
  else await page.getByRole("button", { name: "开始核验", exact: true }).click();
};

const readLocal = async (page, id = snapshot.id) => page.evaluate(async (caseId) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("veripage-cases");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const tx = db.transaction(["cases", "artifacts", "reviewEvents"], "readonly");
    const read = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [record, cases, artifacts, reviews] = await Promise.all([
      read(tx.objectStore("cases").get(caseId)),
      read(tx.objectStore("cases").getAll()),
      read(tx.objectStore("artifacts").index("caseId").getAll(IDBKeyRange.only(caseId))),
      read(tx.objectStore("reviewEvents").index("caseId").getAll(IDBKeyRange.only(caseId))),
    ]);
    const images = [];
    for (const artifact of artifacts) {
      const bitmap = await createImageBitmap(artifact.blob);
      images.push({ id: artifact.artifactId, size: artifact.blob.size, width: bitmap.width });
      bitmap.close();
    }
    return { record: record ?? null, caseCount: cases.length, images, reviews };
  } finally { db.close(); }
}, id);

const reviewFont = async (page) => {
  if (!reviewCjkFontBytes) return;
  await page.addStyleTag({ content: "@font-face{font-family:WorkbenchReviewCJK;src:url('/workbench-review-font.otf') format('opentype');font-weight:100 900}html,body{font-family:WorkbenchReviewCJK,var(--font-geist-sans),sans-serif!important}h1.font-mono{font-family:var(--font-geist-mono),WorkbenchReviewCJK,monospace!important}" });
  await page.evaluate(() => document.fonts.ready);
};

const exerciseScreenshotReader = async (page, name, expectedSource, expectedWidth) => {
  const opener = page.getByRole("button", { name: "放大查看截图", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "放大查看截图", exact: true });
  await modal.waitFor();
  const close = modal.getByRole("button", { name: "关闭截图", exact: true });
  const picture = modal.getByRole("img", { name: "放大后的静态网页截图；不执行网页内容。", exact: true });
  await picture.waitFor();
  await page.waitForFunction((width) => {
    const image = document.querySelector("dialog[open] img");
    return image?.complete && image.naturalWidth === width;
  }, expectedWidth);
  await page.waitForFunction((button) => !button.disabled, await modal.getByRole("button", { name: "原始尺寸", exact: true }).elementHandle());
  check(`${name}: keyboard opens a real modal with the same static image source`, await picture.getAttribute("src") === expectedSource && await close.evaluate((element) => element === document.activeElement) && await modal.locator("iframe, object, embed").count() === 0);
  const focusObservation = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim().slice(0, 55), label: document.activeElement?.getAttribute("aria-label"), inModal: document.activeElement?.closest("dialog")?.open === true }));
  await page.keyboard.press("Tab");
  const onSize = await modal.getByRole("button", { name: "原始尺寸", exact: true }).evaluate((element) => element === document.activeElement);
  const firstTab = await focusObservation();
  await page.keyboard.press("Tab");
  const region = modal.getByRole("region", { name: "放大截图滚动区域", exact: true });
  const onRegion = await region.evaluate((element) => element === document.activeElement);
  const secondTab = await focusObservation();
  await page.keyboard.press("Tab");
  const thirdTab = await focusObservation();
  await page.keyboard.press("Shift+Tab");
  const reverseToRegion = await region.evaluate((element) => element === document.activeElement);
  await page.keyboard.press("Tab");
  await page.screenshot({ path: `${outputDirectory}/veripage-${name}-focus-observation.png` });
  check(`${name}: dialog cycles keyboard focus only among its controls`, onSize && onRegion && reverseToRegion && await close.evaluate((element) => element === document.activeElement), JSON.stringify({ firstTab, secondTab, thirdTab, reverseToRegion }));
  await modal.getByRole("button", { name: "原始尺寸", exact: true }).click();
  await page.waitForFunction((width) => document.querySelector("dialog[open] img")?.clientWidth === width, expectedWidth);
  check(`${name}: original-size mode renders real image pixels rather than stretching the preview`, await picture.evaluate((image) => image.clientWidth === image.naturalWidth));
  await reviewFont(page);
  await page.screenshot({ path: `${outputDirectory}/veripage-${name}-zoom-desktop.png` });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 820 });
    const bounds = await modal.boundingBox();
    check(`${name}: modal controls remain inside ${width}px viewport`, bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 820 && await close.isVisible() && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await region.evaluate((element) => { element.scrollLeft = 0; element.scrollTop = 0; });
    await region.focus();
    await page.keyboard.press("ArrowRight");
    try {
      await page.waitForFunction(() => document.querySelector('dialog[open] [aria-label="放大截图滚动区域"]').scrollLeft > 0);
    } catch (error) {
      console.log("READER-SCROLL-DIAGNOSTIC", JSON.stringify({ width, metrics: await region.evaluate((element) => ({ active: element === document.activeElement, scrollLeft: element.scrollLeft, scrollTop: element.scrollTop, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, direction: getComputedStyle(element).direction, overflowX: getComputedStyle(element).overflowX, imageWidth: element.querySelector("img")?.clientWidth })) }));
      await page.screenshot({ path: `${outputDirectory}/veripage-${name}-${width}-scroll-failure.png` });
      throw error;
    }
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => document.querySelector('dialog[open] [aria-label="放大截图滚动区域"]').scrollTop > 0);
    check(`${name}: ${width}px reader scrolls original pixels in both axes by keyboard`, await region.evaluate((element) => element.scrollWidth > element.clientWidth && element.scrollHeight > element.clientHeight));
    if (width === 390) {
      await region.evaluate((element, imageWidth) => { element.scrollLeft = Math.max(0, (imageWidth - 600) / 2); element.scrollTop = 80; }, expectedWidth);
      await page.screenshot({ path: `${outputDirectory}/veripage-${name}-zoom-mobile.png` });
    }
  }
  await modal.getByRole("button", { name: "适应窗口", exact: true }).click();
  check(`${name}: fit mode removes internal overflow again`, await region.evaluate((element) => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight));
  await page.screenshot({ path: `${outputDirectory}/veripage-${name}-zoom-fit-mobile.png` });
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  check(`${name}: Escape closes the modal, releases its image and restores the opener`, await opener.evaluate((element) => element === document.activeElement) && await page.locator("dialog img").count() === 0);
  await opener.click();
  await modal.waitFor();
  await modal.getByRole("button", { name: "原始尺寸", exact: true }).waitFor();
  await page.waitForFunction((width) => {
    const image = document.querySelector("dialog[open] img");
    return image?.complete && image.naturalWidth === width;
  }, expectedWidth);
  await close.click();
  await modal.waitFor({ state: "hidden" });
  check(`${name}: close button also restores focus and opening resets fit mode`, await opener.evaluate((element) => element === document.activeElement));
  await page.setViewportSize({ width: 1280, height: 900 });
};

  // A genuine HTTP SSE fixture, not route.fulfill's buffered body. Writes are released only after UI assertions.
  const streamSlots = new Map();
  streamingServer = createHttpServer((request, response) => {
    const headers = {
      "Access-Control-Allow-Origin": `http://127.0.0.1:${port}`,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return; }
    const slot = streamSlots.get(request.url);
    if (request.method !== "POST" || !slot) { response.writeHead(404, headers); response.end(); return; }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      slot.posts.push(JSON.parse(body));
      response.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8" });
      response.flushHeaders();
      streamingResponses.add(response);
      response.once("close", () => streamingResponses.delete(response));
      const sent = [];
      slot.onConnection({ response, sent, send(event) { sent.push(event); response.write(serializeEvent(event)); }, end() { response.end(); } });
    });
  });
  await new Promise((resolve) => streamingServer.listen(0, "127.0.0.1", resolve));
  const streamOrigin = `http://127.0.0.1:${streamingServer.address().port}`;
  const openStreamingPage = async (name) => {
    const slot = { posts: [], onConnection: null };
    const next = () => new Promise((resolve) => { slot.onConnection = resolve; });
    const first = next();
    const streamUrl = `${streamOrigin}/${name}`;
    streamSlots.set(`/${name}`, slot);
    const page = await createReviewerPage({ viewport: { width: 1280, height: 900 } });
    if (reviewCjkFontBytes) await page.route("**/workbench-review-font.otf", (route) => route.fulfill({ status: 200, headers: { "Content-Type": "font/otf" }, body: reviewCjkFontBytes }));
    await page.route("**/api/scan", (route) => route.fulfill({ status: 307, headers: { Location: streamUrl, "Set-Cookie": artifactCookie }, body: "" }));
    await page.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({ status: 200, headers: { "Content-Type": "image/png" }, body: png }));
    const ready = page.waitForResponse((response) => response.url() === streamUrl && response.status() === 200);
    await startScan(page, `https://${name}.example.test/`);
    await ready;
    return { page, connection: await first, next, streamUrl, slot };
  };

  const staged = await openStreamingPage("staged-progress");
  const progress = staged.page.getByRole("region", { name: "实时核验进度", exact: true });
  await progress.waitFor();
  check("a held HTTP stream shows six unreported stages, not invented running/completed work", await progress.getByText("待记录", { exact: true }).count() === 6 && await staged.page.getByRole("heading", { name: "本次核验结论", exact: true }).count() === 0);
  staged.connection.send({ type: "started", taskId });
  staged.connection.send({ type: "step", step: "s0-guard", state: "completed", detail: "可信本地 fixture：访问检查已返回" });
  await progress.getByRole("listitem", { name: "访问边界：完成", exact: true }).waitFor();
  check("a received stage is visible while the server still withholds the report", await progress.getByText("待记录", { exact: true }).count() === 5 && !staged.connection.sent.some((event) => event.type === "report") && await staged.page.getByText("检测完成", { exact: true }).count() === 0);
  staged.connection.send({ type: "step", step: "gate1-static", state: "completed", detail: "静态规则未命中；不构成安全保证" });
  const inertReason = '<img src=x onerror="window.__progressInjected=true">' + "很长的服务端说明".repeat(16);
  staged.connection.send({ type: "step", step: "gate2-fetch", state: "partial", detail: "已采集 DOM 与截图", reason: inertReason });
  const fetchStage = progress.getByRole("listitem", { name: "隔离取证：部分完成", exact: true });
  await fetchStage.getByText("已采集 DOM 与截图", { exact: true }).waitFor();
  check("partial stage detail/reason are visible as inert text before terminal data", (await fetchStage.textContent()).includes(inertReason) && await progress.locator("img").count() === 0 && await staged.page.evaluate(() => window.__progressInjected !== true));
  staged.connection.send({ type: "step", step: "gate2-fetch", state: "partial", detail: "取证记录已更新", reason: "一个次级资源未取回" });
  await fetchStage.getByText("取证记录已更新", { exact: true }).waitFor();
  check("a repeated step updates its record without inflating phase counts", (await progress.getByRole("status").textContent()).includes("已收到 3 / 6") && await fetchStage.getByText("已采集 DOM 与截图", { exact: true }).count() === 0);
  await reviewFont(staged.page);
  await staged.page.screenshot({ path: `${outputDirectory}/veripage-progress-desktop.png`, fullPage: true });
  for (const width of [390, 360]) {
    await staged.page.setViewportSize({ width, height: 820 });
    check(`live progress fits ${width}px without horizontal clipping`, await staged.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 390) await staged.page.screenshot({ path: `${outputDirectory}/veripage-progress-mobile.png`, fullPage: true });
  }
  const longReason = `一个次级资源未取回：${"x".repeat(220)}`;
  staged.connection.send({ type: "step", step: "gate2-fetch", state: "partial", reason: longReason });
  await fetchStage.getByText(`说明：${longReason}`, { exact: true }).waitFor();
  check("an unbroken server reason still wraps inside a 360px live-progress card", await staged.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  staged.connection.send({ type: "step", step: "gate3-vision", state: "skipped", reason: "fixture 视觉答复为空，未完成视觉核验" });
  staged.connection.send({ type: "step", step: "gate3-analyzer", state: "failed", reason: "fixture 模型未产出有效判断" });
  await progress.getByRole("listitem", { name: "身份一致性判断：失败", exact: true }).waitFor();
  check("skipped and failed stages remain distinct without inventing a conclusion", await progress.getByRole("listitem", { name: "视觉核验：跳过", exact: true }).count() === 1 && await staged.page.getByRole("heading", { name: "本次核验结论", exact: true }).count() === 0);
  staged.connection.send({ type: "step", step: "validate", state: "completed" });
  await progress.getByRole("listitem", { name: "报告校验：完成", exact: true }).waitFor();
  check("six phase records do not become a completed report or persisted case", (await progress.getByRole("status").textContent()).includes("核验进行中 · 已收到 6 / 6") && await staged.page.getByText("检测完成", { exact: true }).count() === 0 && await staged.page.evaluate(async () => (await indexedDB.databases()).length === 0));
  const streamedSnapshot = {
    ...snapshot, id: "case-live-progress",
    originalAssessment: { ...snapshot.originalAssessment, risk: "unknown", summary: "fixture 模型未完成，保留已观察事实供人工核验。" },
    coverage: [
      { step: "s0-guard", state: "completed" }, { step: "gate1-static", state: "completed" },
      { step: "gate2-fetch", state: "partial", reason: "一个次级资源未取回" },
      { step: "gate3-vision", state: "skipped", reason: "fixture 视觉答复为空" },
      { step: "gate3-analyzer", state: "failed", reason: "fixture 模型未产出有效判断" }, { step: "validate", state: "completed" },
    ],
  };
  staged.connection.send({ type: "report", snapshot: streamedSnapshot });
  staged.connection.end();
  await staged.page.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor();
  await staged.page.getByText("已保存到本机", { exact: true }).waitFor();
  check("only the terminal report replaces progress and commits its real snapshot", await progress.count() === 0 && await staged.page.getByText("检测完成", { exact: true }).count() === 1 && (await readLocal(staged.page, streamedSnapshot.id)).record.snapshot.id === streamedSnapshot.id);
  await staged.page.close();

  const stopped = await openStreamingPage("stopped-progress");
  const stoppedProgress = stopped.page.getByRole("region", { name: "实时核验进度", exact: true });
  stopped.connection.send({ type: "started", taskId });
  stopped.connection.send({ type: "step", step: "s0-guard", state: "completed" });
  stopped.connection.send({ type: "step", step: "validate", state: "failed", reason: "分阶段 fixture 校验失败" });
  await stoppedProgress.getByRole("listitem", { name: "报告校验：失败", exact: true }).waitFor();
  const phaseFailureView = { summary: await stoppedProgress.getByRole("status").textContent(), alerts: await stopped.page.locator("main").getByRole("alert").count() };
  check("a failed validation phase is not a stream terminal while the report may still arrive", phaseFailureView.summary.includes("核验进行中") && phaseFailureView.alerts === 0 && await stoppedProgress.getByText("待记录", { exact: true }).count() === 4, JSON.stringify(phaseFailureView));
  stopped.connection.end();
  await stopped.page.getByRole("alert").getByText("分阶段 fixture 校验失败", { exact: false }).waitFor();
  check("report-less EOF confirms failure and preserves its specific server reason", (await stoppedProgress.getByRole("status").textContent()).includes("核验已停止") && await stopped.page.getByText("没有收到完整报告", { exact: false }).count() === 0);
  check("failed staged detection has no report to save", await stopped.page.evaluate(async () => (await indexedDB.databases()).length === 0) && await stopped.page.getByRole("heading", { name: "本次核验结论", exact: true }).count() === 0);
  const retryConnection = stopped.next();
  const retryReady = stopped.page.waitForResponse((response) => response.url() === stopped.streamUrl && response.status() === 200);
  await stopped.page.getByRole("button", { name: "重试核验", exact: true }).click();
  await retryReady;
  const retryStream = await retryConnection;
  await stoppedProgress.getByRole("status").filter({ hasText: "核验进行中 · 已收到 0 / 6" }).waitFor();
  const retryReset = {
    pending: await stoppedProgress.getByText("待记录", { exact: true }).count(),
    globalAlerts: await stopped.page.getByRole("alert").count(),
    scanAlerts: await stopped.page.locator("main").getByRole("alert").count(),
    hasLatest: (await stoppedProgress.textContent()).includes("最新记录"),
  };
  check("retry clears previous records, errors and latest-stage announcement", retryReset.pending === 6 && retryReset.scanAlerts === 0 && !retryReset.hasLatest, JSON.stringify(retryReset));
  retryStream.send({ type: "started", taskId });
  retryStream.send({ type: "step", step: "s0-guard", state: "completed", detail: "新请求的访问检查" });
  await stoppedProgress.getByText("新请求的访问检查", { exact: true }).waitFor();
  const disconnected = once(retryStream.response, "close", { signal: AbortSignal.timeout(10_000) });
  await stopped.page.getByRole("link", { name: "← 网鉴 VeriPage", exact: true }).click();
  await stopped.page.waitForURL(`http://127.0.0.1:${port}/`);
  await disconnected;
  check("leaving an observed live scan closes the real SSE request before server completion", !retryStream.response.writableEnded && !retryStream.sent.some((event) => event.type === "report") && stopped.slot.posts.length === 2);
  await stopped.page.goBack();
  await stopped.page.getByRole("heading", { name: "先输入一个待核验链接", exact: true }).waitFor();
  check("cancelled live stages cannot reappear through back navigation", await stoppedProgress.count() === 0 && stopped.slot.posts.length === 2);
  await stopped.page.close();

  const validationReport = await openStreamingPage("validation-warning-report");
  const warningProgress = validationReport.page.getByRole("region", { name: "实时核验进度", exact: true });
  validationReport.connection.send({ type: "started", taskId });
  validationReport.connection.send({ type: "step", step: "validate", state: "failed", reason: "fixture 证据绑定未通过" });
  await warningProgress.getByRole("listitem", { name: "报告校验：失败", exact: true }).waitFor();
  const invalidSnapshot = {
    ...snapshot, id: "case-validation-warning",
    originalAssessment: {
      ...snapshot.originalAssessment, risk: "unknown", summary: "[校验未过] fixture 保留原始报告供复核。",
      findings: [{ ...snapshot.originalAssessment.findings[0], evidenceIds: ["missing-fixture-evidence"] }],
    },
    coverage: snapshot.coverage.map((entry) => entry.step === "validate" ? { ...entry, state: "failed", reason: "fixture 证据绑定未通过" } : entry),
  };
  validationReport.connection.send({ type: "report", snapshot: invalidSnapshot });
  validationReport.connection.end();
  await validationReport.page.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor();
  await validationReport.page.getByText("保存失败", { exact: true }).waitFor();
  check("failed-validation then report does not leave a stale fatal retry message", await warningProgress.count() === 0 && await validationReport.page.getByRole("button", { name: "重试核验", exact: true }).count() === 0 && await validationReport.page.getByText("未收到完整报告，本次没有可保存的核验结论。", { exact: true }).count() === 0);
  check("a returned invalid report is labelled unvalidated and never treated as clean completion", await validationReport.page.getByText("报告已收到 · 校验未通过", { exact: true }).count() === 1 && await validationReport.page.getByText("检测完成", { exact: true }).count() === 0 && await validationReport.page.getByText("[校验未过] fixture 保留原始报告供复核。", { exact: true }).count() === 1);
  const invalidSave = {
    message: await validationReport.page.getByRole("region", { name: "本地保存状态", exact: true }).textContent(),
    databases: await validationReport.page.evaluate(async () => (await indexedDB.databases()).map((entry) => entry.name)),
  };
  check("invalid returned reports retain the existing no-local-save boundary", invalidSave.message.includes("报告结构校验未通过，未保存到本机") && invalidSave.databases.length === 0, JSON.stringify(invalidSave));
  await reviewFont(validationReport.page);
  await validationReport.page.screenshot({ path: `${outputDirectory}/veripage-validation-warning.png`, fullPage: true });
  await validationReport.page.close();

  const clientValidation = await createReviewerPage();
  await clientValidation.route("**/api/scan", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: sseFor({
      ...snapshot,
      originalAssessment: { ...snapshot.originalAssessment, findings: [{ ...snapshot.originalAssessment.findings[0], evidenceIds: ["missing-client-fixture-evidence"] }] },
    }),
  }));
  await startScan(clientValidation, "https://client-validation.example.test/");
  await clientValidation.getByText("报告已收到 · 校验未通过", { exact: true }).waitFor();
  await clientValidation.getByText("保存失败", { exact: true }).waitFor();
  check("client validates evidence bindings even when the server marks validation completed", await clientValidation.getByText("检测完成", { exact: true }).count() === 0 && await clientValidation.evaluate(async () => (await indexedDB.databases()).length === 0));
  await clientValidation.close();

  const malformedReport = await createReviewerPage();
  await malformedReport.route("**/api/scan", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: serializeEvent({ type: "report", snapshot: { id: "malformed-client-fixture", originalAssessment: { risk: "unexpected-risk" } } }),
  }));
  await startScan(malformedReport, "https://malformed-report.example.test/");
  await malformedReport.locator("main").getByRole("alert").getByText("收到的报告缺少有效判断结构", { exact: false }).waitFor();
  check("malformed report JSON becomes a retryable error without rendering or saving a conclusion", await malformedReport.getByRole("heading", { name: "本次核验结论", exact: true }).count() === 0 && await malformedReport.getByRole("button", { name: "重试核验", exact: true }).count() === 1 && await malformedReport.evaluate(async () => (await indexedDB.databases()).length === 0));
  await malformedReport.close();

  const httpFailure = await createReviewerPage();
  await httpFailure.route("**/api/scan", (route) => route.fulfill({ status: 503, body: "fixture unavailable" }));
  await startScan(httpFailure, "https://http-failure.example.test/");
  await httpFailure.getByRole("alert").getByText("HTTP 503", { exact: false }).waitFor();
  check("HTTP failure retains unreported stages without showing a fabricated completed phase", await httpFailure.getByRole("region", { name: "实时核验进度" }).getByText("待记录", { exact: true }).count() === 6 && await httpFailure.getByText("检测完成", { exact: true }).count() === 0);
  await httpFailure.close();

  const page = await createReviewerPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    window.__caseBlobUrls = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); window.__caseBlobUrls.created.push(url); return url; };
    URL.revokeObjectURL = (url) => { window.__caseBlobUrls.revoked.push(url); revoke(url); };
  });
  if (reviewCjkFontBytes) {
    await page.route("**/workbench-review-font.otf", (route) => route.fulfill({
      status: 200,
      headers: { "Content-Type": "font/otf", "Cache-Control": "no-store" },
      body: reviewCjkFontBytes,
    }));
  }
  let artifactCookieReceived = "";
  const submittedBodies = [];
  const applicationRequests = [];
  let releaseArtifactSave;
  const artifactSaveGate = new Promise((resolve) => { releaseArtifactSave = resolve; });
  let rawArtifactRequests = 0;
  let mainSse = successSse;
  page.on("request", (request) => {
    if (new URL(request.url()).origin === `http://127.0.0.1:${port}`) applicationRequests.push(request.url());
  });
  await page.route("**/api/scan", (route) => {
    submittedBodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8", "Set-Cookie": artifactCookie },
      body: mainSse,
    });
  });
  await page.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, async (route) => {
    artifactCookieReceived = route.request().headers().cookie ?? "";
    if (route.request().resourceType() === "fetch") await artifactSaveGate;
    await route.fulfill({ status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" }, body: png });
  });
  await page.route(`**/api/scans/${taskId}/artifacts/${rawArtifactId}`, (route) => {
    rawArtifactRequests += 1;
    return route.fulfill({ status: 200, headers: { "Content-Type": "text/plain" }, body: "raw synthetic secret: never copy" });
  });

  const secret = "SYNTHETIC_URL_TOKEN_123";
  const sensitiveTarget = `https://example.test/login?token=${secret}&keep=1`;
  await startScan(page, sensitiveTarget, true);
  await reviewFont(page);
  await page.getByRole("heading", { name: "本次核验结论" }).waitFor();
  check("target URL is carried in POST, never the application navigation query",
    new URL(page.url()).pathname === "/scan" && new URL(page.url()).search === "" &&
    applicationRequests.every((url) => !url.includes(secret) && !new URL(url).searchParams.has("url")));
  check("POST retains the exact target needed for collection", submittedBodies.length === 1 && submittedBodies[0].url === sensitiveTarget);
  const heading = page.getByRole("heading", { level: 1 });
  check("header and tooltip show a minimized URL", (await heading.textContent()).includes("[已隐藏]") && (await heading.getAttribute("title")).includes("[已隐藏]") && !(await page.content()).includes(secret));
  check("raw target is not persisted in browser key-value storage", await page.evaluate((token) => !JSON.stringify({ ...localStorage, ...sessionStorage }).includes(token), secret));
  await page.getByText("正在保存到本机…", { exact: true }).waitFor();
  check("report is completed while local evidence saving is independently pending", await page.getByText("检测完成", { exact: true }).count() === 1);
  releaseArtifactSave();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const firstLocal = await readLocal(page);
  check("native IndexedDB commits report and screenshot together", firstLocal.record.snapshot.id === snapshot.id && firstLocal.images.length === 1 && firstLocal.images[0].size === png.length && firstLocal.images[0].width === 1280);
  check("sensitive non-screenshot artifact is deliberately omitted without a download", rawArtifactRequests === 0 && firstLocal.record.retention.some((r) => r.artifactId === rawArtifactId && r.state === "omitted"));
  check("local save retains the original assessment unchanged", JSON.stringify(firstLocal.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await page.getByRole("heading", { name: "本次核验结论" }).waitFor();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  check("recheck uses the private in-memory target", submittedBodies.length === 2 && submittedBodies[1].url === sensitiveTarget && new URL(page.url()).search === "");
  check("saving the same snapshot ID is idempotent", (await readLocal(page)).caseCount === 1);
  const image = page.locator('img[alt^="隔离环境采集"]');
  await image.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const element = document.querySelector('img[alt^="隔离环境采集"]');
    return element instanceof HTMLImageElement && element.complete && element.naturalWidth === 1280;
  });
  await page.screenshot({ path: `${outputDirectory}/veripage-workbench-desktop.png`, fullPage: true });
  check("completed report presents separate risk and sufficiency", await page.getByText("可疑", { exact: true }).count() > 0 && await page.getByText("部分充分", { exact: true }).count() > 0);
  check("screenshot loads through the session-scoped artifact URL", artifactCookieReceived.includes(`vp_scan_${taskId.replaceAll("-", "")}`));
  await exerciseScreenshotReader(page, "temporary", await image.getAttribute("src"), 1280);
  const zoomFailureTarget = `**/api/scans/${taskId}/artifacts/${artifactId}`;
  let zoomFailureRequests = 0;
  await page.route(zoomFailureTarget, (route) => { zoomFailureRequests += 1; return route.fulfill({ status: 404, headers: { "Cache-Control": "no-store" }, body: "expired after preview loaded" }); });
  await page.route(`${zoomFailureTarget}?reader-error-fixture=1`, (route) => { zoomFailureRequests += 1; return route.fulfill({ status: 404, headers: { "Cache-Control": "no-store" }, body: "controlled expanded image failure" }); });
  const zoomOpener = page.getByRole("button", { name: "放大查看截图", exact: true });
  await zoomOpener.click();
  const unavailableZoom = page.getByRole("dialog", { name: "放大查看截图", exact: true });
  await unavailableZoom.waitFor();
  await page.screenshot({ path: `${outputDirectory}/veripage-zoom-expiry-observation.png` });
  console.log("ZOOM-EXPIRY", JSON.stringify({ requests: zoomFailureRequests, images: await unavailableZoom.locator("img").evaluateAll((images) => images.map((image) => ({ src: image.getAttribute("src"), complete: image.complete, width: image.naturalWidth }))), alerts: await unavailableZoom.getByRole("alert").count() }));
  // An active preview can supply decoded bytes without a new GET. Force a distinct image request
  // only when needed to exercise the actual browser error path; do not call a cached success a 404.
  if (await unavailableZoom.locator("img").count()) await unavailableZoom.locator("img").evaluate((element) => { element.src = `${element.src}?reader-error-fixture=1`; });
  await unavailableZoom.getByRole("alert").getByText("放大截图暂时无法读取", { exact: true }).waitFor();
  check("an actual expanded-image failure is explained without discarding the preview or saved report", zoomFailureRequests > 0 && await image.evaluate((element) => element.complete && element.naturalWidth === 1280) && (await readLocal(page)).caseCount === 1 && submittedBodies.length === 2);
  await page.screenshot({ path: `${outputDirectory}/veripage-zoom-error.png` });
  await page.keyboard.press("Escape");
  await unavailableZoom.waitFor({ state: "hidden" });
  check("zoom failure still allows Escape and focus return", await zoomOpener.evaluate((element) => element === document.activeElement));
  await page.route(zoomFailureTarget, (route) => route.fulfill({ status: 200, headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" }, body: png }));

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
    if (width === 390) await page.screenshot({ path: `${outputDirectory}/veripage-workbench-mobile.png`, fullPage: true });
  }

  // Unexpected EOF must stop the loading view and render a retryable alert.
  const interruptedPage = await createReviewerPage({ viewport: { width: 390, height: 800 } });
  let interruptedRequests = 0;
  await interruptedPage.route("**/api/scan", (route) => {
    interruptedRequests += 1;
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Set-Cookie": artifactCookie },
      body: interruptedRequests === 1
        ? serializeEvent({ type: "started", taskId: "22222222-3333-4444-8555-666666666666" }) + serializeEvent({ type: "step", step: "s0-guard", state: "completed" })
        : successSse,
    });
  });
  await interruptedPage.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
    body: png,
  }));
  interruptedPage.on("pageerror", (error) => console.log(`INTERRUPTED PAGEERROR ${error.message}`));
  interruptedPage.on("console", (message) => { if (message.type() === "error") console.log(`INTERRUPTED CONSOLE ${message.text()}`); });
  await startScan(interruptedPage, "https://interrupted.test/");
  const interruption = interruptedPage.getByText("没有收到完整报告", { exact: false });
  await interruption.waitFor();
  check("report-less EOF exits loading and announces interruption", await interruption.count() === 1 && await interruptedPage.getByRole("region", { name: "实时核验进度" }).getByRole("status").getByText("核验已停止", { exact: false }).count() === 1);
  await interruptedPage.getByRole("button", { name: "重试核验", exact: true }).click();
  await interruptedPage.getByRole("heading", { name: "本次核验结论" }).waitFor();
  await interruption.waitFor({ state: "hidden" });
  const applicationAlerts = await interruptedPage.locator('main [role="alert"]').allTextContents();
  check("retry after report-less EOF receives a report and clears the error", await interruption.count() === 0 && applicationAlerts.length === 0 && await interruptedPage.getByText("页面有密码输入要求", { exact: false }).count() === 1, JSON.stringify({ applicationAlerts, allAlertTexts: await interruptedPage.getByRole("alert").allTextContents() }));
  check("retry issues exactly a second scan request", interruptedRequests === 2);
  await interruptedPage.close();

  const expiredContext = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await authenticateContext(expiredContext);
  const expiredPage = await expiredContext.newPage();
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
  await startScan(expiredPage, "https://expired.test/");
  await expiredPage.getByRole("heading", { name: "本次核验结论" }).waitFor();
  const expiredNotice = expiredPage.getByText("临时截图已过期或暂时不可用", { exact: false });
  await expiredNotice.waitFor();
  check("expired screenshot explains its absence without losing the report", await expiredPage.getByText("页面有密码输入要求", { exact: false }).count() === 1);
  check("an unavailable thumbnail never exposes an active zoom action", await expiredPage.getByRole("button", { name: "放大查看截图", exact: true }).isDisabled() && await expiredPage.getByRole("dialog", { name: "放大查看截图", exact: true }).count() === 0);
  await expiredPage.getByText("已保存报告，证据不完整", { exact: true }).waitFor();
  const partialLocal = await readLocal(expiredPage);
  check("expired evidence saves an explicit partial record instead of false complete success", partialLocal.images.length === 0 && partialLocal.record.retention.some((r) => r.artifactId === artifactId && r.state === "missing"));
  const partialHistory = await expiredPage.context().newPage();
  let partialHistoryApiRequests = 0;
  await partialHistory.route("**/api/**", (route) => { partialHistoryApiRequests += 1; return route.abort(); });
  await partialHistory.goto(`http://127.0.0.1:${port}/cases/${snapshot.id}`);
  await partialHistory.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor();
  await partialHistory.getByText("本机未保留可回看的截图", { exact: true }).waitFor();
  check("partial history preserves the report and explicit missing evidence without remote recovery", partialHistoryApiRequests === 0 && await partialHistory.getByText("本机缺失", { exact: true }).count() === 1);
  check("a missing local image has no enlargement action", await partialHistory.getByRole("button", { name: "放大查看截图", exact: true }).count() === 0);
  await partialHistory.close();
  await expiredPage.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({ status: 200, headers: { "Content-Type": "image/png" }, body: png }));
  await expiredPage.getByRole("button", { name: "重试保存", exact: true }).click();
  await expiredPage.getByText("已保存到本机", { exact: true }).waitFor();
  const repairedLocal = await readLocal(expiredPage);
  check("partial-save retry adds the missing screenshot without replacing the original assessment", repairedLocal.images.length === 1 && repairedLocal.record.retention.some((r) => r.artifactId === artifactId && r.state === "saved") && JSON.stringify(repairedLocal.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));
  await expiredContext.close();

  // Explicit server failure is distinguishable from transport EOF.
  const failedPage = await createReviewerPage({ viewport: { width: 390, height: 800 } });
  await failedPage.route("**/api/scan", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    body: serializeEvent({ type: "started", taskId: "33333333-4444-4555-8666-777777777777" }) + serializeEvent({ type: "step", step: "validate", state: "failed", reason: "fixture server failure" }),
  }));
  await startScan(failedPage, "https://failed.test/");
  const failureText = failedPage.getByRole("alert").getByText("fixture server failure", { exact: false });
  await failureText.waitFor();
  check("server failure message is preserved rather than relabeled as interruption", await failureText.count() === 1 && await failedPage.getByText("没有收到完整报告", { exact: false }).count() === 0);
  await failedPage.close();

  await page.reload();
  await page.getByRole("heading", { name: "先输入一个待核验链接", exact: true }).waitFor();
  check("reload does not restore a private target or silently rerun", submittedBodies.length === 2 && new URL(page.url()).search === "");
  await page.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({ status: 404, body: "expired" }));
  const afterReload = await readLocal(page);
  check("stored screenshot survives reload and temporary endpoint expiry", afterReload.images.length === 1 && afterReload.images[0].width === 1280 && afterReload.caseCount === 1);

  const emptyPage = await createReviewerPage();
  let unexpectedScans = 0;
  await emptyPage.route("**/api/scan", (route) => { unexpectedScans += 1; return route.abort(); });
  await emptyPage.goto(`http://127.0.0.1:${port}/scan`);
  await emptyPage.getByRole("heading", { name: "先输入一个待核验链接", exact: true }).waitFor();
  check("direct scan entry without input remains idle", unexpectedScans === 0);
  await emptyPage.goto(`http://127.0.0.1:${port}/scan?url=${encodeURIComponent(sensitiveTarget)}`);
  await emptyPage.getByRole("heading", { name: "先输入一个待核验链接", exact: true }).waitFor();
  check("legacy URL query is not used as scan input", unexpectedScans === 0 && !(await emptyPage.locator("main").textContent()).includes(secret));
  await emptyPage.close();

  const cancelledPage = await createReviewerPage();
  await cancelledPage.addInitScript(() => {
    window.__scanAborts = 0;
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (input === "/api/scan") init.signal.addEventListener("abort", () => { window.__scanAborts += 1; });
      return originalFetch(input, init);
    };
  });
  let releasePending;
  const pendingGate = new Promise((resolve) => { releasePending = resolve; });
  await cancelledPage.route("**/api/scan", async (route) => {
    await pendingGate;
    await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: successSse }).catch(() => undefined);
  });
  await startScan(cancelledPage, sensitiveTarget);
  await cancelledPage.getByRole("region", { name: "实时核验进度" }).getByRole("status").filter({ hasText: "核验进行中" }).waitFor();
  await cancelledPage.getByRole("link", { name: "← 网鉴 VeriPage", exact: true }).click();
  await cancelledPage.waitForURL(`http://127.0.0.1:${port}/`);
  await cancelledPage.waitForFunction(() => window.__scanAborts > 0);
  check("leaving the workbench aborts the in-flight client request", true);
  await cancelledPage.goBack();
  await cancelledPage.getByRole("heading", { name: "先输入一个待核验链接", exact: true }).waitFor();
  check("back navigation cannot resurrect the previous private target", new URL(cancelledPage.url()).search === "" && !(await cancelledPage.content()).includes(secret));
  releasePending();
  await cancelledPage.close();

  // Storage access and mid-transaction aborts use the real browser IndexedDB.
  for (const failure of ["blocked", "abort"]) {
    const storagePage = await createReviewerPage();
    let analysisRequests = 0;
    await storagePage.addInitScript((kind) => {
      window.__failSave = true;
      if (kind === "blocked") {
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (...args) => {
          if (window.__failSave) throw new DOMException("Storage disabled for this fixture", "SecurityError");
          return open(...args);
        };
      } else {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          const request = put.apply(this, args);
          if (this.name === "artifacts" && window.__failSave) this.transaction.abort();
          return request;
        };
      }
    }, failure);
    await storagePage.route("**/api/scan", (route) => {
      analysisRequests += 1;
      return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream", "Set-Cookie": artifactCookie }, body: successSse });
    });
    await storagePage.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({ status: 200, headers: { "Content-Type": "image/png" }, body: png }));
    await startScan(storagePage, "https://storage-fixture.test/");
    await storagePage.getByText("保存失败", { exact: true }).waitFor();
    check(`${failure}: save failure preserves the completed visible report`, await storagePage.getByRole("heading", { name: "本次核验结论" }).count() === 1 && await storagePage.getByText("已保存到本机", { exact: true }).count() === 0);
    if (failure === "abort") {
      const rolledBack = await readLocal(storagePage);
      check("artifact-write abort rolls back both report and image", rolledBack.record === null && rolledBack.images.length === 0);
    }
    await storagePage.evaluate(() => { window.__failSave = false; });
    await storagePage.getByRole("button", { name: "重试保存", exact: true }).click();
    await storagePage.getByText("已保存到本机", { exact: true }).waitFor();
    const retried = await readLocal(storagePage);
    check(`${failure}: explicit retry commits one complete local copy without re-analysis`, retried.caseCount === 1 && retried.images.length === 1 && analysisRequests === 1);
    await storagePage.getByRole("button", { name: "清除本机副本", exact: true }).click();
    await storagePage.getByText("本机副本已清除", { exact: true }).waitFor();
    const deleted = await readLocal(storagePage);
    check(`${failure}: user can remove the local report and image without losing the current view`, deleted.record === null && deleted.images.length === 0 && await storagePage.getByRole("heading", { name: "本次核验结论" }).count() === 1);
    await storagePage.close();
  }

  // A second, newer snapshot exercises list ordering, independent case keys and playback.
  const second = {
    ...snapshot,
    id: "case-workbench-second",
    createdAt: "2026-10-30T10:00:00.000Z",
    inputSummary: { displayUrl: "https://second.test/", registrableDomain: "second.test" },
    originalAssessment: { ...snapshot.originalAssessment, risk: "unknown", summary: "第二份受控本机快照，证据不足。" },
    evidence: snapshot.evidence.map((item) => item.id === "ev-url" ? { ...item, excerpt: "https://second.test/", locator: "https://second.test/" }
      : item.type === "screenshot" ? { ...item, locator: "fullPage 960x800" } : item),
  };
  mainSse = sseFor(second);
  await page.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({ status: 200, headers: { "Content-Type": "image/png" }, body: secondPng }));
  await page.setViewportSize({ width: 1280, height: 900 });
  await startScan(page, "https://second.test/");
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const scanCountBeforeHistory = submittedBodies.length;
  const artifactRequestsBeforeHistory = applicationRequests.filter((url) => new URL(url).pathname.startsWith("/api/scans/")).length;
  await page.route(`**/api/scans/${taskId}/artifacts/${artifactId}`, (route) => route.fulfill({ status: 404, body: "expired after save" }));
  await page.getByRole("link", { name: "查看本机快照", exact: true }).click();
  await page.getByRole("heading", { name: "历史快照", exact: true }).waitFor();
  const localImage = page.locator('img[alt^="本机保存"]:visible');
  await localImage.waitFor();
  await page.waitForFunction(() => [...document.images].some((image) => image.alt.startsWith("本机保存") && image.offsetParent !== null && image.complete && image.naturalWidth === 960));
  let secondBlob = await localImage.getAttribute("src");
  check("saved-result link opens the correct case-specific Blob history view", secondBlob.startsWith("blob:") && new URL(page.url()).pathname.endsWith(second.id));
  const blobsBeforeZoom = await page.evaluate(() => window.__caseBlobUrls.created.length);
  await exerciseScreenshotReader(page, "local", secondBlob, 960);
  check("local enlargement reuses the owned Blob URL without API recovery or new object URLs", await page.evaluate(() => window.__caseBlobUrls.created.length) === blobsBeforeZoom && submittedBodies.length === scanCountBeforeHistory && applicationRequests.filter((url) => new URL(url).pathname.startsWith("/api/scans/")).length === artifactRequestsBeforeHistory);
  const previousBlob = secondBlob;
  await page.getByRole("button", { name: "放大查看截图", exact: true }).click();
  await page.getByRole("dialog", { name: "放大查看截图", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "先输入一个待核验链接", exact: true }).waitFor();
  await page.waitForFunction((url) => window.__caseBlobUrls.revoked.includes(url), previousBlob);
  check("navigation while viewing an image closes the top-layer modal and releases the old Blob", await page.getByRole("dialog", { name: "放大查看截图", exact: true }).count() === 0);
  await page.goForward();
  await page.getByRole("heading", { name: "历史快照", exact: true }).waitFor();
  await page.waitForFunction((old) => [...document.images].some((image) => image.alt.startsWith("本机保存") && image.complete && image.naturalWidth === 960 && image.src !== old), previousBlob);
  secondBlob = await localImage.getAttribute("src");
  check("forward navigation reloads the correct local bytes with no stale open image", secondBlob !== previousBlob && await page.getByRole("dialog", { name: "放大查看截图", exact: true }).count() === 0 && submittedBodies.length === scanCountBeforeHistory);
  await page.getByRole("link", { name: "← 本机案例", exact: true }).click();
  await page.getByRole("heading", { name: "本机案例", exact: true }).waitFor();
  await page.getByRole("link", { name: "https://second.test/", exact: true }).waitFor();
  await page.waitForFunction((url) => window.__caseBlobUrls.revoked.includes(url), secondBlob);
  check("leaving history releases its object URL", true);
  const caseLinks = await page.getByRole("listitem").getByRole("link").allTextContents();
  check("case library lists newer detection first", caseLinks[0] === "https://second.test/" && caseLinks[1] === "https://example.test/login");
  await page.locator("#case-search").fill("unmatched-fixture");
  await page.getByText("没有匹配案例，可调整搜索、风险或复核视图。", { exact: true }).waitFor();
  check("local keyword search shows an honest no-match state", await page.getByRole("link", { name: "https://second.test/", exact: true }).count() === 0);
  await page.locator("#case-search").fill("");
  await page.locator("#case-risk").selectOption("suspicious");
  check("risk filter uses the original model assessment", await page.getByRole("link", { name: "https://example.test/login", exact: true }).count() === 1 && await page.getByRole("link", { name: "https://second.test/", exact: true }).count() === 0);
  await page.locator("#case-risk").selectOption("all");
  await reviewFont(page);
  await page.screenshot({ path: `${outputDirectory}/veripage-cases-desktop.png`, fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 820 });
    check(`case library fits ${width}px viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 390) await page.screenshot({ path: `${outputDirectory}/veripage-cases-mobile.png`, fullPage: true });
  }
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "删除案例 second.test", exact: true }).click();
  check("cancelling library deletion keeps the case and image", (await readLocal(page, second.id)).images.length === 1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除案例 second.test", exact: true }).click();
  await page.getByRole("link", { name: "https://second.test/", exact: true }).waitFor({ state: "hidden" });
  const secondDeleted = await readLocal(page, second.id);
  check("library deletion commits before removing the row", secondDeleted.record === null && secondDeleted.images.length === 0 && secondDeleted.caseCount === 1);

  await page.getByRole("link", { name: "https://example.test/login", exact: true }).click();
  await page.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor();
  await localImage.waitFor();
  await page.waitForFunction(() => [...document.images].some((image) => image.alt.startsWith("本机保存") && image.offsetParent !== null && image.complete && image.naturalWidth === 1280));
  const reviewRegion = page.getByRole("region", { name: "个人复核", exact: true });
  await reviewRegion.getByText("未标记", { exact: true }).waitFor();
  await reviewRegion.getByText("填写复核意见和记录", { exact: true }).click();
  check("review requires a reason before submitting", await reviewRegion.getByRole("button", { name: "标记待复核", exact: true }).isDisabled());
  await reviewRegion.getByRole("textbox", { name: /理由/ }).fill("需要从官方渠道核实，标记本机待复核。");
  await reviewRegion.getByRole("button", { name: "标记待复核", exact: true }).click();
  await reviewRegion.getByText("待复核", { exact: true }).waitFor();
  check("marking creates one pending event without changing the machine assessment", (await readLocal(page)).reviews.length === 1 && (await readLocal(page)).record.snapshot.originalAssessment.risk === "suspicious");
  await page.getByRole("link", { name: "← 本机案例", exact: true }).click();
  await page.getByRole("button", { name: "待复核", exact: true }).click();
  await page.getByRole("link", { name: "https://example.test/login", exact: true }).waitFor();
  check("pending view contains flagged cases", true);
  await page.getByRole("button", { name: "更正记录", exact: true }).click();
  await page.getByText("没有匹配案例，可调整搜索、风险或复核视图。", { exact: true }).waitFor();
  check("an unresolved flag is not presented as a completed correction", await page.getByRole("link", { name: "https://example.test/login", exact: true }).count() === 0);
  await page.getByRole("button", { name: "待复核", exact: true }).click();
  await page.getByRole("link", { name: "https://example.test/login", exact: true }).click();
  await reviewRegion.getByText("待复核", { exact: true }).waitFor();
  const personalReason = "<b>人工核对</b>：仅为本机使用者意见，并非平台认定。";
  await reviewRegion.getByRole("textbox", { name: /理由/ }).fill(personalReason);
  await reviewRegion.getByRole("combobox", { name: /我的判断/ }).selectOption("no_significant_risk");
  await reviewRegion.getByRole("button", { name: "保存个人更正", exact: true }).click();
  await reviewRegion.getByText("已更正", { exact: true }).waitFor();
  await reviewRegion.getByText("最近已完成复核：我的判断为暂未发现显著风险。", { exact: true }).waitFor();
  const correctedLocal = await readLocal(page);
  const visibleOriginalRisk = await page.getByRole("region", { name: "本次核验结论", exact: true }).getByText("可疑", { exact: true }).count();
  check("personal correction is appended and the original model risk stays visible", correctedLocal.reviews.length === 2 && correctedLocal.reviews[1].humanRisk === "no_significant_risk" && JSON.stringify(correctedLocal.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment) && visibleOriginalRisk === 1, JSON.stringify({ eventCount: correctedLocal.reviews.length, personalRisk: correctedLocal.reviews[1]?.humanRisk, originalUnchanged: JSON.stringify(correctedLocal.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment), visibleOriginalRisk }));
  await reviewRegion.getByText("填写复核意见和记录", { exact: true }).click();
  check("review reason is inert text, not executable markup", await reviewRegion.getByText(personalReason, { exact: true }).count() === 1 && await reviewRegion.locator("b").count() === 0);
  await page.getByRole("link", { name: "← 本机案例", exact: true }).click();
  await page.getByRole("button", { name: "更正记录", exact: true }).click();
  await page.getByRole("link", { name: "https://example.test/login", exact: true }).waitFor();
  check("completed correction view keeps original risk and personal status separate", await page.getByText("模型原判：可疑", { exact: true }).count() === 1 && await page.getByText(/个人复核：已更正/).count() === 1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await reviewFont(page);
  await page.screenshot({ path: `${outputDirectory}/veripage-review-library.png`, fullPage: true });
  await page.getByRole("link", { name: "https://example.test/login", exact: true }).click();
  await reviewRegion.getByText("已更正", { exact: true }).waitFor();
  const reviewDetails = reviewRegion.locator("details");
  if (!await reviewDetails.evaluate((element) => element.open)) await reviewRegion.getByText("填写复核意见和记录", { exact: true }).click();
  await reviewRegion.getByRole("textbox", { name: /理由/ }).fill("补充新的核验信息，再次标记复核。");
  await reviewRegion.getByRole("button", { name: "再次标记待复核", exact: true }).click();
  await reviewRegion.getByText("待复核", { exact: true }).waitFor();
  await page.getByRole("link", { name: "← 本机案例", exact: true }).click();
  await page.getByRole("button", { name: "更正记录", exact: true }).click();
  await page.getByRole("link", { name: "https://example.test/login", exact: true }).waitFor();
  check("reopening preserves access to previous completed opinions", await page.getByText(/个人复核：待复核/).count() === 1);
  await page.getByRole("button", { name: "待复核", exact: true }).click();
  await page.getByRole("link", { name: "https://example.test/login", exact: true }).click();
  await reviewRegion.getByText("待复核", { exact: true }).waitFor();
  await reviewRegion.getByRole("textbox", { name: /理由/ }).fill("复核后决定维持机器原判，保留此前更正记录。");
  await reviewRegion.getByRole("button", { name: "维持原判", exact: true }).click();
  await reviewRegion.locator('p[aria-live="polite"]').getByText("维持原判", { exact: true }).waitFor();
  const upheldLocal = await readLocal(page);
  check("upholding appends a fourth event and keeps all previous opinions", upheldLocal.reviews.length === 4 && upheldLocal.reviews[3].action === "uphold_assessment" && JSON.stringify(upheldLocal.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));
  if (!await reviewDetails.evaluate((element) => element.open)) await reviewRegion.getByText("填写复核意见和记录", { exact: true }).click();
  await page.locator("#finding-f-identity:visible").focus();
  await page.keyboard.press("Enter");
  check("history reuses keyboard finding-to-evidence linkage", await page.locator("#evidence-ev-form-1:visible").getAttribute("aria-pressed") === "true");
  await page.locator("#evidence-ev-form-1:visible").click();
  check("history retains reverse evidence linkage", await page.locator("#finding-f-form:visible").getAttribute("aria-pressed") === "true");
  await page.setViewportSize({ width: 1280, height: 900 });
  await reviewFont(page);
  await page.screenshot({ path: `${outputDirectory}/veripage-history-desktop.png`, fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 820 });
    check(`history fits ${width}px viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (width === 390) await page.screenshot({ path: `${outputDirectory}/veripage-history-mobile.png`, fullPage: true });
  }
  await page.reload();
  await page.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor();
  await reviewRegion.locator('p[aria-live="polite"]').getByText("维持原判", { exact: true }).waitFor();
  await localImage.waitFor();
  await page.waitForFunction(() => [...document.images].some((image) => image.alt.startsWith("本机保存") && image.offsetParent !== null && image.complete && image.naturalWidth === 1280));
  check("reloaded history displays stored bytes after temporary endpoint expiry", (await localImage.getAttribute("src")).startsWith("blob:") && await page.getByText("已存本机", { exact: true }).count() === 1);
  check("review status and append-only history survive reload", (await readLocal(page)).reviews.length === 4);
  check("history performs no scan, model proxy or temporary artifact request", submittedBodies.length === scanCountBeforeHistory && applicationRequests.filter((url) => new URL(url).pathname.startsWith("/api/scans/")).length === artifactRequestsBeforeHistory);

  let downloadCount = 0;
  page.on("download", () => { downloadCount += 1; });
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "导出案例包", exact: true }).click();
  check("export requires explicit sensitive-content confirmation", downloadCount === 0);
  const downloadPromise = page.waitForEvent("download");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "导出案例包", exact: true }).click();
  const packageDownload = await downloadPromise;
  const packagePath = `${outputDirectory}/roundtrip-case.json`;
  await packageDownload.saveAs(packagePath);
  const exportedPackage = JSON.parse(await readFile(packagePath, "utf8"));
  check("downloaded package contains the actual original assessment, PNG and ordered opinions", exportedPackage.version === 1 && exportedPackage.artifacts.length === 1 && exportedPackage.reviews.length === 4 && JSON.stringify(exportedPackage.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));
  check("download removes sensitive raw-URL references without modifying the stored snapshot", !exportedPackage.record.snapshot.artifactIds.includes(rawArtifactId) && exportedPackage.record.snapshot.evidence.find((item) => item.id === "ev-url").artifactId === undefined && JSON.stringify((await readLocal(page)).record.snapshot) === JSON.stringify(snapshot));
  await page.getByRole("link", { name: "← 本机案例", exact: true }).click();
  await page.getByRole("region", { name: "导入案例包", exact: true }).locator('input[type="file"]').setInputFiles(packagePath);
  await page.getByRole("alert").getByText("本机已有同编号案例，未覆盖任何记录", { exact: true }).waitFor();
  check("UI duplicate import preserves all local opinions and original risk", (await readLocal(page)).reviews.length === 4 && (await readLocal(page)).record.snapshot.originalAssessment.risk === "suspicious");
  await page.getByRole("button", { name: "全部案例", exact: true }).click();
  await page.getByRole("link", { name: "https://example.test/login", exact: true }).click();
  await page.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "删除本机案例", exact: true }).click();
  await page.getByRole("heading", { name: "本机还没有案例", exact: true }).waitFor();
  const allDeleted = await readLocal(page);
  check("detail deletion removes report, image and review events before showing empty library", allDeleted.caseCount === 0 && allDeleted.images.length === 0 && allDeleted.reviews.length === 0);
  await page.getByRole("region", { name: "导入案例包", exact: true }).locator('input[type="file"]').setInputFiles(packagePath);
  await page.getByRole("status").filter({ hasText: "已导入本机案例。" }).waitFor();
  await page.getByRole("link", { name: "查看导入快照", exact: true }).click();
  await page.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor();
  await reviewRegion.locator('p[aria-live="polite"]').getByText("维持原判", { exact: true }).waitFor();
  await localImage.waitFor();
  await page.waitForFunction(() => [...document.images].some((image) => image.alt.startsWith("本机保存") && image.offsetParent !== null && image.complete && image.naturalWidth === 1280));
  const restoredPackage = await readLocal(page);
  check("file-picker import restores a deleted case, PNG and four opinions", restoredPackage.caseCount === 1 && restoredPackage.images.length === 1 && restoredPackage.reviews.length === 4 && JSON.stringify(restoredPackage.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));
  check("package roundtrip does not call scan or temporary artifact APIs", submittedBodies.length === scanCountBeforeHistory && applicationRequests.filter((url) => new URL(url).pathname.startsWith("/api/scans/")).length === artifactRequestsBeforeHistory);
  await page.getByRole("link", { name: "← 本机案例", exact: true }).click();
  await page.getByRole("region", { name: "导入案例包", exact: true }).locator('input[type="file"]').setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer: Buffer.from('{"format":"veripage-case","version":99}') });
  await page.getByRole("alert").getByText("不支持的案例包格式或版本", { exact: true }).waitFor();
  check("invalid file-picker input leaves the restored case intact", (await readLocal(page)).caseCount === 1 && (await readLocal(page)).reviews.length === 4);
  const densePackage = structuredClone(exportedPackage);
  densePackage.record.id = "case-dense-fixture";
  densePackage.record.snapshot.id = "case-dense-fixture";
  densePackage.reviews = [];
  densePackage.record.snapshot.originalAssessment.findings = Array.from({ length: 400 }, (_, index) => ({ id: `dense-${index}`, kind: "inference", statement: `受控稠密图节点 ${index}`, evidenceIds: [...Array.from({ length: 400 }, (_, n) => `dense-${n}`).filter((id) => id !== `dense-${index}`), ...(index === 0 ? ["ev-url"] : [])], alternativeExplanations: [] }));
  await page.getByRole("region", { name: "导入案例包", exact: true }).locator('input[type="file"]').setInputFiles({ name: "dense.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(densePackage)) });
  await page.getByRole("status").filter({ hasText: "已导入本机案例。" }).waitFor();
  await page.getByRole("link", { name: "查看导入快照", exact: true }).click();
  await page.locator("#finding-dense-0:visible").waitFor();
  check("dense imported package opens an actually rendered indexed workbench", await page.locator('[id^="finding-dense-"]:visible').count() === 400);
  await page.goto(`http://127.0.0.1:${port}/cases/never-saved-fixture`);
  await page.getByRole("heading", { name: "本机没有这份快照", exact: true }).waitFor();
  check("deleted or unknown local IDs never fall back to server history", submittedBodies.length === scanCountBeforeHistory);

  const blockedLibrary = await createReviewerPage();
  await blockedLibrary.addInitScript(() => {
    window.__blockLibrary = true;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => { if (window.__blockLibrary) throw new DOMException("Storage disabled", "SecurityError"); return open(...args); };
  });
  await blockedLibrary.goto(`http://127.0.0.1:${port}/cases`);
  await blockedLibrary.getByText("无法读取本机存储，请确认浏览器允许站点数据后重试。", { exact: true }).waitFor();
  check("storage denial is not mislabeled as an empty library", await blockedLibrary.getByRole("heading", { name: "本机还没有案例", exact: true }).count() === 0);
  await blockedLibrary.evaluate(() => { window.__blockLibrary = false; });
  await blockedLibrary.getByRole("button", { name: "重试读取", exact: true }).click();
  await blockedLibrary.getByRole("heading", { name: "本机还没有案例", exact: true }).waitFor();
  check("library read can recover without a scan", true);
  await blockedLibrary.close();

  console.log(`ALL-PASS (${passed} browser assertions)`);
} finally {
  await browser?.close().catch(() => undefined);
  for (const response of streamingResponses) response.destroy();
  if (streamingServer?.listening) await new Promise((resolve) => streamingServer.close(resolve));
  try {
    await stopServer();
  } finally {
    reviewer.restore();
  }
}
