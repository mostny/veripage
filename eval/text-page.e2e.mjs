/**
 * Production-browser journey for the text line (/text) with a mocked /api/text.
 * Build first, then run: node eval/text-page.e2e.mjs
 * Pattern follows eval/workbench.e2e.mjs (free port -> next start -> Playwright).
 * No external target navigation and no model/API credential are used.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
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

/** Windows 上没有进程组信号：组杀失败后退回按 pid 杀，再不行用 taskkill /T /F 杀整树 */
async function stopServer() {
  if (server.exitCode !== null) return;
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

let serverOutput = "";
const startupTimer = setTimeout(() => server.kill("SIGTERM"), 40_000);
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

// --- 固定样本：输入含手机号与邮箱，mock 返回与服务端同构的结果 -------------
const input = "联系电话 13800138000，邮箱 test@example.com，请尽快回复。";
const phoneStart = input.indexOf("13800138000");
const emailStart = input.indexOf("test@example.com");
const fixture = {
  aigc: {
    isAigc: true,
    confidence: 0.82,
    conclusion: "likely_aigc",
    signals: ["句式节奏过于均衡", "缺少口语化停顿与个人化细节"],
    caveats: ["检测本身存在不确定性，结果仅为特征倾向", "短样本下置信度有限"],
    promptVersion: "1.0.0",
    model: "fixture-model",
    repaired: false,
  },
  redaction: {
    redactedText: "联系电话 [手机号已脱敏]，邮箱 [邮箱已脱敏]，请尽快回复。",
    hits: [
      { type: "phone", label: "手机号", start: phoneStart, end: phoneStart + 11 },
      { type: "email", label: "邮箱", start: emailStart, end: emailStart + "test@example.com".length },
    ],
    counts: { "id-card": 0, phone: 1, "bank-card": 0, email: 1 },
    note: "正则匹配，可能存在漏检/误报，敏感信息外发前请人工复核",
  },
};

let browser;
let passed = 0;
const check = (name, condition, detail = "") => {
  assert.ok(condition, `${name}${detail ? ` (${detail})` : ""}`);
  passed += 1;
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/text", (route) => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(fixture),
  }));

  // 1. 首屏渲染 + 空状态
  await page.goto(`http://127.0.0.1:${port}/text`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  check("text page renders heading and textarea", await page.locator("#text-input").count() === 1 && (await page.getByRole("heading", { level: 1 }).textContent()).includes("检测台"));
  check("empty state hint shown before analysis", await page.locator("#empty-hint").count() === 1);
  check("no result regions before analysis", await page.locator("#aigc-result").count() === 0 && await page.locator("#redaction-result").count() === 0);

  // 2. 键盘提交（Ctrl+Enter）出结果
  await page.locator("#text-input").fill(input);
  await page.locator("#text-input").press("Control+Enter");
  await page.locator("#aigc-result").waitFor();
  check("keyboard Ctrl+Enter submits and renders results", await page.locator("#aigc-result").count() === 1 && await page.locator("#redaction-result").count() === 1);

  // 3. AIGC 判定区：倾向 + 置信度 + signals + caveats（不做确定性断言）
  check("aigc verdict shows tendency wording", (await page.locator("#aigc-result").textContent()).includes("具有 AI 生成特征"));
  check("aigc verdict shows confidence percent", (await page.locator("#aigc-result").textContent()).includes("置信度 82%"));
  check("aigc verdict lists model caveats", (await page.locator("#aigc-result").textContent()).includes("结果仅为特征倾向"));
  check("aigc verdict carries uncertainty disclaimer", (await page.locator("#aigc-result").textContent()).includes("AI 检测本身存在不确定性"));
  check("aigc verdict does not assert certainty", !/这是 AI 写的|100%/.test(await page.locator("#aigc-result").textContent()));

  // 4. 脱敏结果区：命中清单（类型+区间，无原值）+ 占位符替换 + 复制
  const redactionText = await page.locator("#redaction-result").textContent();
  check("hit list shows types and intervals without original values",
    redactionText.includes("手机号") && redactionText.includes("邮箱") && redactionText.includes(`位置 ${phoneStart}–${phoneStart + 11}`) &&
    !redactionText.includes("13800138000") && !redactionText.includes("test@example.com"));
  const redactedText = await page.locator("#redacted-text").textContent();
  check("redacted text replaces PII with placeholders",
    redactedText === fixture.redaction.redactedText && !redactedText.includes("13800138000") && !redactedText.includes("test@example.com"));
  check("redaction carries the honest-boundary note", redactionText.includes("人工复核"));

  await page.getByRole("button", { name: "复制脱敏文本" }).click();
  await page.getByRole("button", { name: "已复制" }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  check("copy button copies the redacted text", clipboard === fixture.redaction.redactedText);

  // 5. 360 / 390px 无横向溢出
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 820 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`text page fits ${width}px viewport`, overflow <= 0, `horizontal overflow ${overflow}px`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // 6. 首页入口卡片可达
  await page.goto(`http://127.0.0.1:${port}/`);
  const entry = page.locator('a[href="/text"]');
  await entry.waitFor();
  check("home page has a text-line entry card", (await entry.textContent()).includes("AIGC 识别"));
  await entry.click();
  await page.waitForURL(new RegExp(`/text$`));
  await page.getByRole("heading", { level: 1 }).waitFor();
  check("entry card navigates to /text", new URL(page.url()).pathname === "/text");
  check("no uncaught page errors during the journey", pageErrors.length === 0, pageErrors.join("; "));

  // 7. 加载态：延迟响应期间必须可见，结果到达后消失
  const loadingPage = await context.newPage();
  await loadingPage.route("**/api/text", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(fixture),
    });
  });
  await loadingPage.goto(`http://127.0.0.1:${port}/text`);
  await loadingPage.locator("#text-input").fill(input);
  await loadingPage.getByRole("button", { name: "开始分析" }).click();
  await loadingPage.locator("#loading-indicator").waitFor({ state: "visible" });
  check("loading state is visible while the request is in flight", true);
  await loadingPage.locator("#aigc-result").waitFor();
  check("loading state clears once results arrive", await loadingPage.locator("#loading-indicator").count() === 0);
  await loadingPage.close();

  // 8. 错误态：502 明确错误，且不渲染任何「默认人类所写」结论
  const errorPage = await context.newPage();
  await errorPage.route("**/api/text", (route) => route.fulfill({
    status: 502,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ error: "AIGC 判定两次输出均无法解析为合法 JSON（或缺少 caveats 字段），已停止判定" }),
  }));
  await errorPage.goto(`http://127.0.0.1:${port}/text`);
  await errorPage.locator("#text-input").fill(input);
  await errorPage.getByRole("button", { name: "开始分析" }).click();
  await errorPage.locator("#analyze-error").waitFor();
  check("error state surfaces the explicit 502 message", (await errorPage.locator("#analyze-error").textContent()).includes("无法解析"));
  check("failed analysis renders no verdict at all", await errorPage.locator("#aigc-result").count() === 0 && await errorPage.locator("#redaction-result").count() === 0);
  check("failed analysis leaves the loading state", await errorPage.locator("#loading-indicator").count() === 0);
  await errorPage.close();

  console.log(`ALL-PASS (${passed} browser assertions)`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer();
}
