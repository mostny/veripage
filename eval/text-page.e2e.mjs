/**
 * Production-browser journey for the text line (/text) with a mocked /api/text.
 * Build first, then run: node eval/text-page.e2e.mjs
 * Pattern follows eval/workbench.e2e.mjs (free port -> next start -> Playwright).
 * No external target navigation and no model/API credential are used.
 *
 * Audit regressions covered here:
 * - F01: default submission sends no allowRawInput (redacted-only), explicit opt-in sends true
 * - F05: while A is pending, switching input to B and resubmitting must end with B's
 *   response only — the stale A response must never overwrite it, and Ctrl+Enter
 *   auto-repeats during loading are ignored
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
  const submittedBodies = [];
  await page.route("**/api/text", (route) => {
    submittedBodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(fixture),
    });
  });

  // 1. 首屏渲染 + 空状态
  await page.goto(`http://127.0.0.1:${port}/text`);
  await page.getByRole("heading", { level: 1 }).waitFor();
  check("text page renders heading and textarea", await page.locator("#text-input").count() === 1 && (await page.getByRole("heading", { level: 1 }).textContent()).includes("检测台"));
  check("empty state hint shown before analysis", await page.locator("#empty-hint").count() === 1);
  check("no result regions before analysis", await page.locator("#aigc-result").count() === 0 && await page.locator("#redaction-result").count() === 0);

  // 1b. F01 知情选择：提交前明示「默认仅发送脱敏文本」，复选框默认关闭
  check("raw-input note explains redacted-only default before submission",
    (await page.locator("#raw-input-note").textContent()).includes("默认只把") && (await page.locator("#raw-input-note").textContent()).includes("脱敏后的文本"));
  check("raw-input opt-in checkbox defaults to off", await page.locator("#raw-input-checkbox").isChecked() === false);

  // 2. 键盘提交（Ctrl+Enter）出结果
  await page.locator("#text-input").fill(input);
  await page.locator("#text-input").press("Control+Enter");
  await page.locator("#aigc-result").waitFor();
  check("keyboard Ctrl+Enter submits and renders results", await page.locator("#aigc-result").count() === 1 && await page.locator("#redaction-result").count() === 1);
  check("F01 default submission omits allowRawInput (redacted-only)",
    submittedBodies.length === 1 && submittedBodies[0].text === input && submittedBodies[0].allowRawInput === undefined,
    JSON.stringify(submittedBodies.at(-1)));

  // 2b. F01 显式 opt-in：勾选后才带 allowRawInput: true
  await page.locator("#raw-input-checkbox").check();
  await page.getByRole("button", { name: "开始分析" }).click();
  await page.locator("#aigc-result").waitFor();
  check("F01 opt-in submission carries allowRawInput: true",
    submittedBodies.length === 2 && submittedBodies[1].allowRawInput === true,
    JSON.stringify(submittedBodies.at(-1)));
  await page.locator("#raw-input-checkbox").uncheck();

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
  check("loading indicator states redacted-only mode by default",
    (await loadingPage.locator("#loading-indicator").textContent()).includes("仅发送脱敏文本"));
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

  // 9. F05 竞态回归：A pending 时改 B 提交，B 先回、A 后回，最终必须是 B 的响应
  //    修复前：无代际保护时 A 的迟到响应会覆盖 B 的结果（审计复现 finalDisplayedResultIsA=true）
  const racePage = await context.newPage();
  const raceErrors = [];
  racePage.on("pageerror", (error) => raceErrors.push(error.message));
  const RACE_A = "第一次提交的文本 A，包含 marker-alpha 内容。";
  const RACE_B = "用户改成第二次提交的文本 B，包含 marker-beta 内容。";
  const fixtureFor = (marker) => ({
    ...fixture,
    aigc: { ...fixture.aigc, signals: [marker] },
  });
  const raceSubmissions = [];
  let releaseA;
  const aGate = new Promise((resolve) => { releaseA = resolve; });
  await racePage.route("**/api/text", async (route) => {
    const body = route.request().postDataJSON();
    raceSubmissions.push(body.text);
    const isA = body.text === RACE_A;
    const response = {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(fixtureFor(isA ? "race-marker-A" : "race-marker-B")),
    };
    if (isA) {
      // A 挂起：等到 B 的响应已被页面渲染后才放行（此时 A 早已被 abort）
      await aGate;
      await route.fulfill(response).catch(() => undefined);
    } else {
      await route.fulfill(response);
    }
  });

  await racePage.goto(`http://127.0.0.1:${port}/text`);
  await racePage.locator("#text-input").fill(RACE_A);
  await racePage.getByRole("button", { name: "开始分析" }).click();
  await racePage.locator("#loading-indicator").waitFor({ state: "visible" });

  // loading 中的键盘提交（自动重复）必须被忽略：不得产生第三次请求
  await racePage.locator("#text-input").press("Control+Enter");
  check("F05: Ctrl+Enter during loading is ignored (no extra submission)",
    raceSubmissions.length === 1 && raceSubmissions[0] === RACE_A,
    `submissions=${raceSubmissions.length}`);

  // 改输入为 B 并再次提交（按钮在 loading 中仍可重新提交，取消 A）
  await racePage.locator("#text-input").fill(RACE_B);
  await racePage.getByRole("button", { name: /分析中/ }).click();
  await racePage.locator("#aigc-result").waitFor();
  check("F05: both submissions reached the API (A then B)",
    raceSubmissions.length === 2 && raceSubmissions[1] === RACE_B,
    `submissions=${raceSubmissions.length}`);

  // B 先回：结果必须是 B 的响应
  const raceResultText = await racePage.locator("#aigc-result").textContent();
  check("F05: displayed result is B's response", raceResultText.includes("race-marker-B") && !raceResultText.includes("race-marker-A"));

  // 释放 A：迟到的 A 响应（即使侥幸送达）也不得覆盖 B 的结果
  releaseA();
  await racePage.waitForTimeout(400);
  const finalResultText = await racePage.locator("#aigc-result").textContent();
  check("F05: late stale A response never overwrites B's result",
    finalResultText.includes("race-marker-B") && !finalResultText.includes("race-marker-A"));
  check("F05: input stays B after the race", (await racePage.locator("#text-input").inputValue()) === RACE_B);
  check("F05: loading cleared after B's result (stale A cannot resurrect it)", await racePage.locator("#loading-indicator").count() === 0);
  check("F05: no uncaught page errors during the race", raceErrors.length === 0, raceErrors.join("; "));
  await racePage.close();

  console.log(`ALL-PASS (${passed} browser assertions)`);
} finally {
  await browser?.close().catch(() => undefined);
  await stopServer();
}
