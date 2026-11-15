/** Real deployed-browser journey. Root forwards only reviewer credentials through stdin to a sandboxed non-root worker. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = "https://43.136.20.106";
const liveScan = process.argv.includes("--live-scan");
const caseJourney = process.argv.includes("--cases");
const liveTarget = process.argv.find((argument) => argument.startsWith("--live-target="))?.slice("--live-target=".length);
assert.ok(!liveTarget || liveScan, "A live target requires explicit --live-scan opt-in");
assert.ok(!caseJourney || liveScan, "The real case round trip requires explicit --live-scan opt-in and screenshot evidence");
const target = liveScan ? liveTarget ?? "https://example.com/" : "http://127.0.0.1/";

if (!process.argv.includes("--worker")) {
  assert.ok(process.getuid?.() === 0, "Run the controller as the deployment owner; it reads the private reviewer file, then drops privileges");
  const account = await readFile(new URL("../.env.reviewer-account", import.meta.url), "utf8");
  const username = /账号：([^\n]+)/.exec(account)?.[1];
  const password = /密码：([^\n]+)/.exec(account)?.[1];
  assert.ok(username && password, "Private reviewer credentials are required");
  const args = [
    `--unit=veripage-browser-e2e-${Date.now()}`, "--wait", "--pipe", "--collect", "--uid=veripage", "--gid=veripage",
    "--property=NoNewPrivileges=yes", "--property=PrivateTmp=yes", "--property=UMask=0077",
    `--working-directory=${process.cwd()}`, "--setenv=HOME=/var/lib/veripage",
    "--setenv=PLAYWRIGHT_BROWSERS_PATH=/opt/veripage-playwright", "--setenv=FONTCONFIG_FILE=/etc/veripage/fonts.conf",
    process.execPath, "--experimental-strip-types", "eval/reviewer-browser.e2e.mjs", "--worker", ...(liveScan ? ["--live-scan"] : []), ...(caseJourney ? ["--cases"] : []), ...(liveTarget ? [`--live-target=${liveTarget}`] : []),
  ];
  const worker = spawn("systemd-run", args, { stdio: ["pipe", "inherit", "inherit"] });
  worker.stdin.on("error", () => undefined); // An early worker failure is reported by its exit status.
  worker.stdin.end(JSON.stringify({ username, password }));
  const code = await new Promise((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
  process.exitCode = code === 0 ? 0 : 1;
} else {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { username, password } = JSON.parse(input);
  const directory = await mkdtemp("/var/lib/veripage/evaluation-round1/public-browser-");
  let stage = "browser_start";
  let browser;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    // Observe the same reads as the UI, without a second request/reader or a cloned stream that changes cancellation.
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        const input = args[0];
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url, location.href).pathname === "/api/scan" && response.body) {
          window.__veripageObservedSse = "";
          const stream = response.body;
          const nativeGetReader = stream.getReader.bind(stream);
          stream.getReader = (...options) => {
            const reader = nativeGetReader(...options);
            const nativeRead = reader.read.bind(reader);
            const decoder = new TextDecoder();
            reader.read = async (...readOptions) => {
              const result = await nativeRead(...readOptions);
              window.__veripageObservedSse += result.done ? decoder.decode() : decoder.decode(result.value, { stream: true });
              return result;
            };
            return reader;
          };
        }
        return response;
      };
    });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    let directTargetRequests = 0;
    let scanRequests = 0;
    let artifactRequests = 0;
    let scanning = false;
    page.on("request", (request) => {
      if (scanning && request.url().startsWith(target)) directTargetRequests += 1;
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/scan" && request.method() === "POST") scanRequests += 1;
      if (pathname.startsWith("/api/scans/")) artifactRequests += 1;
    });
    stage = "anonymous_redirect";
    await page.goto(origin + "/");
    assert.ok(new URL(page.url()).pathname === "/login", "Anonymous navigation must land on login");
    await page.getByRole("heading", { name: "评测登录", exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, "login.png"), fullPage: true });
    stage = "wrong_password_feedback";
    await page.getByLabel("用户名", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill("intentionally-wrong-e2e-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "账号或密码不正确" }).waitFor();
    stage = "reviewer_login";
    await page.getByLabel("密码", { exact: true }).fill(password);
    await Promise.all([page.waitForURL(origin + "/"), page.getByRole("button", { name: "登录", exact: true }).click()]);
    await page.getByRole("button", { name: "退出", exact: true }).waitFor();
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === "vp_reviewer_session");
    assert.ok(session?.secure && session.httpOnly, "Actual browser session must be Secure and HttpOnly");
    await page.screenshot({ path: path.join(directory, "home.png"), fullPage: true });
    stage = "submit_scan";
    scanning = true;
    const responsePromise = page.waitForResponse((response) => response.url() === origin + "/api/scan" && response.request().method() === "POST", { timeout: 130_000 });
    await page.getByLabel("待核验链接", { exact: true }).fill(target);
    await page.getByRole("button", { name: "开始核验", exact: true }).click();
    await page.getByRole("heading", { name: "本次核验结论", exact: true }).waitFor({ timeout: 130_000 });
    stage = "report_validation";
    const response = await responsePromise;
    assert.ok(response.status() === 200, "The real scan API must return SSE successfully");
    const stream = await page.evaluate(() => window.__veripageObservedSse ?? "");
    const events = stream.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    const snapshot = events.find((event) => event.type === "report")?.snapshot;
    if (snapshot) await writeFile(path.join(directory, "report.json"), JSON.stringify(snapshot, null, 2), { flag: "wx", mode: 0o600 });
    assert.ok(snapshot?.originalAssessment && snapshot.coverage, "The UI must present a real server report");
    assert.ok(directTargetRequests === 0, "The reviewer's browser must not navigate to the submitted target while scanning");
    scanning = false;
    if (liveScan) {
      for (const step of ["gate2-fetch", "gate3-vision", "gate3-analyzer", "validate"]) {
        assert.ok(snapshot.coverage.some((item) => item.step === step && item.state === "completed"), `${step} must complete in the real deployed chain`);
      }
      assert.ok(snapshot.evidence.some((item) => item.type === "screenshot" && item.artifactId), "Real browser screenshot evidence is required");
      const image = page.locator('img[alt^="隔离环境采集"]');
      await image.waitFor({ state: "visible" });
      await page.waitForFunction(() => { const image = document.querySelector('img[alt^="隔离环境采集"]'); return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0; });
    } else {
      assert.ok(snapshot.coverage.some((item) => item.step === "gate2-fetch" && item.state === "skipped"), "The no-fee check must block the private target before fetching");
    }
    await page.screenshot({ path: path.join(directory, "report-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Actual report must fit the mobile viewport");
    await page.screenshot({ path: path.join(directory, "report-mobile.png"), fullPage: true });
    if (caseJourney) {
      stage = "local_case_save";
      await page.getByText("已保存到本机", { exact: true }).waitFor();
      assert.ok(!new URL(page.url()).search, "Submitted target must not be serialized into the application navigation query");
      const historyArtifactCount = artifactRequests;
      await page.getByRole("link", { name: "查看本机快照", exact: true }).click();
      await page.getByRole("heading", { name: "历史快照", exact: true }).waitFor();
      const savedImage = page.locator('img[alt^="本机保存"]:visible');
      await savedImage.waitFor();
      await page.waitForFunction(() => [...document.images].some((image) => image.alt.startsWith("本机保存") && image.complete && image.naturalWidth > 0));
      assert.ok((await savedImage.getAttribute("src")).startsWith("blob:"), "History must read retained local bytes");
      const region = page.getByRole("region", { name: "个人复核", exact: true });
      await region.getByText("未标记", { exact: true }).waitFor();
      await region.getByText("填写复核意见和记录", { exact: true }).click();
      await region.getByRole("textbox", { name: /理由/ }).fill("评测合成意见：先通过已知来源核对，标记本机待复核。");
      await region.getByRole("button", { name: "标记待复核", exact: true }).click();
      await region.getByText("待复核", { exact: true }).waitFor();
      const humanRisk = snapshot.originalAssessment.risk === "no_significant_risk" ? "unknown" : "no_significant_risk";
      await region.getByRole("textbox", { name: /理由/ }).fill("评测合成更正意见：仅为本机个人判断，保留模型原始结论。");
      await region.getByRole("combobox", { name: /我的判断/ }).selectOption(humanRisk);
      await region.getByRole("button", { name: "保存个人更正", exact: true }).click();
      await region.getByText("已更正", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(directory, "local-review.png"), fullPage: true });
      stage = "case_package_export";
      page.once("dialog", (dialog) => dialog.accept());
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出案例包", exact: true }).click();
      const download = await downloadPromise;
      const packagePath = path.join(directory, "case-package.json");
      await download.saveAs(packagePath);
      const packet = JSON.parse(await readFile(packagePath, "utf8"));
      assert.ok(packet.format === "veripage-case" && packet.version === 1, "Actual downloaded package must use the supported format");
      assert.ok(JSON.stringify(packet.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment), "Personal correction must not mutate the original model assessment");
      assert.ok(packet.reviews.length === 2 && packet.artifacts.length > 0, "Export must retain both personal events and the real screenshot");
      stage = "case_delete_import_restore";
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByRole("button", { name: "删除本机案例", exact: true }).click();
      await page.getByRole("heading", { name: "本机还没有案例", exact: true }).waitFor();
      await page.getByRole("region", { name: "导入案例包", exact: true }).locator('input[type="file"]').setInputFiles(packagePath);
      await page.getByRole("status").filter({ hasText: "已导入本机案例。" }).waitFor();
      await page.getByRole("link", { name: "查看导入快照", exact: true }).click();
      await page.getByRole("region", { name: "个人复核", exact: true }).getByText("已更正", { exact: true }).waitFor();
      await page.reload();
      await page.getByRole("region", { name: "个人复核", exact: true }).getByText("已更正", { exact: true }).waitFor();
      const restoredImage = page.locator('img[alt^="本机保存"]:visible');
      await restoredImage.waitFor();
      await page.waitForFunction(() => [...document.images].some((image) => image.alt.startsWith("本机保存") && image.complete && image.naturalWidth > 0));
      assert.ok((await restoredImage.getAttribute("src")).startsWith("blob:"), "Imported history must continue to use local image bytes after reload");
      assert.ok(scanRequests === 1 && artifactRequests === historyArtifactCount, "History, review and package round trip must not rescan or recover temporary artifacts remotely");
      await page.screenshot({ path: path.join(directory, "imported-history.png"), fullPage: true });
    }
    stage = "logout";
    await Promise.all([page.waitForURL(origin + "/login"), page.getByRole("button", { name: "退出", exact: true }).click()]);
    await page.goto(origin + "/text");
    assert.ok(new URL(page.url()).pathname === "/login", "Logged-out navigation must be protected");
    assert.ok(pageErrors.length === 0, "No uncaught browser application error is allowed");
    console.log(JSON.stringify({ result: "passed", liveScan, target, localCasesRoundTrip: caseJourney, localProductionBuildId: (await readFile(".next/BUILD_ID", "utf8")).trim(), browserSandbox: true, reviewerLogin: true, wrongPasswordFeedback: true, secureCookie: true, reportRisk: snapshot.originalAssessment.risk, coverage: snapshot.coverage, mobileOverflow: false, uncaughtPageErrors: pageErrors.length, artifacts: directory, credentialsPrinted: false }));
  } catch (error) {
    // Playwright call logs can contain input arguments, so do not print raw exceptions with a password.
    const message = String(error?.message ?? "Unknown error").replaceAll(password, "[REDACTED]").slice(0, 1200);
    console.error(JSON.stringify({ result: "failed", stage, errorType: error?.name ?? "Error", message, artifacts: directory, credentialsPrinted: false }));
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}
