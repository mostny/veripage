/** Strict-sandbox runtime check using only a trusted local fixture; no network or model calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { buildChromiumLaunchPlan } from "../lib/tools/fetch-page.ts";

const browser = await chromium.launch(buildChromiumLaunchPlan(undefined));
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8">
    <style>body{font-family:"Noto Sans CJK SC",sans-serif;background:#f5f6f8;color:#1c2b4a;padding:64px}main{background:white;border:1px solid #e3e7ee;border-radius:12px;padding:40px;max-width:800px}h1{color:#2563eb}p{font-size:22px;line-height:1.8}</style>
    <main><h1>网鉴 VeriPage · 取证运行检查</h1><p>中文证据核验：网页身份、跳转链、表单提交与隐私提示。</p><p>本地受控样本 · Chromium 沙箱开启 · 不访问外部网页</p></main></html>`);
  assert.equal(await page.locator("h1").textContent(), "网鉴 VeriPage · 取证运行检查");
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  const browserProcess = processInfo.find((item) => item.type === "browser");
  assert.ok(browserProcess?.id, "Chromium browser process must exist");
  const profile = (await readFile(`/proc/${browserProcess.id}/attr/current`, "utf8")).trim();
  assert.match(profile, /veripage-chromium/, "The browser must use this project's AppArmor profile");
  const browserEnvironment = await readFile(`/proc/${browserProcess.id}/environ`, "utf8");
  assert.ok(!browserEnvironment.split("\0").some((entry) => entry.startsWith("VERIPAGE_") || entry.startsWith("BWS_ACCESS_TOKEN=")), "Browser environment must not contain application credentials");
  const screenshot = process.argv[2];
  if (screenshot) await page.screenshot({ path: screenshot });
  console.log(JSON.stringify({ browser: await browser.version(), sandboxEnabled: true, appArmorProfile: profile, privateEnvironmentRemoved: true, chineseFixture: "passed", screenshot: screenshot ?? null }));
} finally {
  await browser.close();
}
