/**
 * 本地 fetcher（W3 对照实验专用）：Playwright 直连本地 fixture 产出 PageEvidence
 *
 * 与 lib/tools/fetch-page.ts 的关系：
 * - 取证字段形状完全对齐（text / forms / externalScripts / screenshot 四类证据，
 *   FetchPageResult 同字段）；采集动作同源（同一次 page.evaluate 拿 title/正文/表单/脚本清单，
 *   fullPage 截图，redirectedFrom + framenavigated 反推跳转链）。
 * - 差异（实验壳偏离，已在 report.md 如实写明）：
 *   1) 不执行 S0 访问边界：fixture 全在 127.0.0.1，真实 S0 会拒绝回环地址；
 *      由 run-group 在 runScan 注入 services.guard 放行桩（见任务书补充要求 1）。
 *   2) 导航目标是本地 fixture：公开 URL（样本 url/hops 声明）与本地路径一一映射，
 *      跳转链按观测到的真实 30x 链回填公开 URL。
 *   3) 非本地子资源（fixture 页面里声明的 CDN 脚本/图片）一律 route 中止，
 *      不发起任何真实外网请求；只把「DOM 中声明了哪些第三方域脚本」当事实采集。
 * - withScreenshot=false 为「去视觉」消融变体：不产出截图证据 → 编排器视觉闸自然 skipped。
 */

import { chromium } from "playwright";
import { getRegistrableDomain } from "../../lib/tools/url-static.ts";

const VIEWPORT = { width: 1280, height: 800 };
const MAX_TEXT_CHARS = 3_000;

function truncate(text, max) {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

function dedupeAdjacent(urls) {
  const out = [];
  for (const u of urls) {
    const prev = out[out.length - 1];
    if (!prev || prev.replace(/\/+$/, "") !== u.replace(/\/+$/, "")) out.push(u);
  }
  return out;
}

function requestChain(req) {
  const urls = [];
  let cur = req;
  while (cur) {
    urls.unshift(cur.url());
    cur = cur.redirectedFrom();
  }
  return urls;
}

/** 把浏览器按本地地址解析出的绝对 form action 换算回「公开落地地址」下解析的结果 */
function publicAction(action, baseUrl, publicFinalUrl) {
  if (!action) return "";
  if (action.startsWith(baseUrl)) {
    const relative = action.slice(baseUrl.length) || "/";
    try {
      return new URL(relative, publicFinalUrl).toString();
    } catch {
      return relative;
    }
  }
  return action;
}

/**
 * @param {object} options
 * @param {string} options.baseUrl       fixture 服务器基址
 * @param {Map<string, object>} options.sampleByUrl  公开 URL → 样本
 * @param {boolean} [options.withScreenshot]          是否产出截图证据（去视觉消融关掉）
 * @param {number} [options.timeoutMs]
 */
export function createLocalFetcher({ baseUrl, sampleByUrl, withScreenshot = true, timeoutMs = 15_000 }) {
  let browser = null;
  const stats = { fetches: 0, abortedSubresources: 0, fetchErrors: 0 };

  async function ensureBrowser() {
    if (browser) return browser;
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    return browser;
  }

  /** @returns {import("../../lib/tools/fetch-page.ts").FetchPageResult} */
  async function fetchLocalPage(rawUrl) {
    stats.fetches += 1;
    const startedAt = Date.now();
    const sample = sampleByUrl.get(rawUrl.trim());
    if (!sample) {
      stats.fetchErrors += 1;
      return {
        blocked: false,
        error: `实验壳找不到 URL 对应的 fixture：${rawUrl}`,
        startUrl: rawUrl,
        redirectChain: [],
        evidence: [],
        warnings: ["fixture-missing"],
        blockedRequests: [],
        elapsedMs: Date.now() - startedAt,
      };
    }

    // 公开链 ↔ 本地链一一映射（dataset.routesFor 已校验长度一致）
    const localChain = [];
    for (let i = 0; i < sample.hops.length; i += 1) localChain.push(`${baseUrl}/hop/${sample.id}/${i}`);
    localChain.push(`${baseUrl}/page/${sample.id}`);
    const publicChain = [sample.url, ...sample.hops];
    const mapLocalToPublic = (localUrl) => {
      const idx = localChain.findIndex((p) => localUrl === p || localUrl.startsWith(`${p}?`));
      return idx >= 0 ? publicChain[idx] : localUrl;
    };

    const evidence = [];
    const warnings = [];
    const blockedRequests = [];
    let seq = 0;
    const nextId = (type) => `ev-${type}-${++seq}`;

    let context = null;
    try {
      const launched = await ensureBrowser();
      context = await launched.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
      // 只允许本地 fixture 请求；其余子资源直接中止（不产生真实外网请求）
      await context.route("**/*", async (route) => {
        const target = route.request().url();
        if (target.startsWith(`${baseUrl}/`)) {
          await route.continue();
          return;
        }
        stats.abortedSubresources += 1;
        blockedRequests.push({
          url: target,
          host: (() => {
            try {
              return new URL(target).hostname;
            } catch {
              return "";
            }
          })(),
          reason: "实验壳：非本地 fixture 子资源，直接中止（不发起真实外网请求）",
        });
        await route.abort();
      });

      const page = await context.newPage();
      const navigatedUrls = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigatedUrls.push(frame.url());
      });

      let navError = null;
      let response = null;
      try {
        response = await page.goto(localChain[0], { waitUntil: "domcontentloaded", timeout: timeoutMs });
      } catch (err) {
        navError = `导航失败：${err instanceof Error ? err.message : String(err)}`;
      }

      if (navError) {
        warnings.push(`目标文档导航失败，未采集页面 DOM/截图：${navError}`);
      } else {
        // 1) 标题 + 可见正文 + 表单 + 脚本清单（与 lib/tools/fetch-page.ts 同一次 evaluate）
        const dom = await page.evaluate(() => {
          const forms = Array.from(document.forms).map((f) => ({
            action: f.action || "",
            method: (f.method || "get").toLowerCase(),
            hasPasswordInput: f.querySelector('input[type="password"]') !== null,
            inputCount: f.querySelectorAll("input, textarea, select").length,
          }));
          const scripts = Array.from(document.querySelectorAll("script[src]"))
            .map((s) => s.src)
            .filter((src) => src.length > 0);
          return {
            title: document.title ?? "",
            bodyText: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"),
            forms,
            scripts,
          };
        });
        const capturedAt = new Date().toISOString();
        // 公开落地地址：第三方域比对与相对 form action 换算都以它为准（本地地址不当主域）
        const publicFinalUrl = publicChain[publicChain.length - 1];
        const t = truncate(dom.bodyText, MAX_TEXT_CHARS);
        evidence.push({
          id: nextId("text"),
          capturedAt,
          type: "text",
          source: "experiment-fetcher:document.title + document.body.innerText",
          title: dom.title,
          text: t.text,
          truncated: t.truncated,
        });
        evidence.push({
          id: nextId("forms"),
          capturedAt,
          type: "forms",
          source: "experiment-fetcher:document.forms",
          // 表单 action 是浏览器按「本地页地址」解析出来的绝对 URL；对第三方域核验而言
          // 必须换算回公开落地地址下解析的结果，否则 /login 这类相对路径会被记成 127.0.0.1 第三方域
          forms: dom.forms.map((f) => ({ ...f, action: publicAction(f.action, baseUrl, publicFinalUrl) })),
        });

        // 2) 第三方域脚本：与「公开最终页」可注册主域比对（本地地址不能当主域，否则同站脚本被误判第三方）
        const pageDomain = getRegistrableDomain(new URL(publicFinalUrl).hostname);
        const seen = new Set();
        const thirdParty = [];
        for (const src of dom.scripts) {
          let u;
          try {
            u = new URL(src);
          } catch {
            continue;
          }
          const domain = getRegistrableDomain(u.hostname);
          if (domain === pageDomain) continue;
          if (seen.has(domain)) continue;
          seen.add(domain);
          thirdParty.push({ src, domain });
        }
        evidence.push({
          id: nextId("externalScripts"),
          capturedAt,
          type: "externalScripts",
          source: "experiment-fetcher:script[src] 与公开最终页主域比对",
          domains: thirdParty.map((s) => s.domain),
          scripts: thirdParty,
        });

        // 3) 整页截图（去视觉消融时不采集）
        if (withScreenshot) {
          const shot = await page.screenshot({ fullPage: true, type: "png" });
          evidence.push({
            id: nextId("screenshot"),
            capturedAt: new Date().toISOString(),
            type: "screenshot",
            source: "experiment-fetcher:page.screenshot(fullPage)",
            mimeType: "image/png",
            encoding: "base64",
            data: shot.toString("base64"),
            width: VIEWPORT.width,
            height: VIEWPORT.height,
            fullPage: true,
          });
        }
      }

      // 4) 跳转链：服务端 30x（redirectedFrom 反推）+ 客户端跳转，映射回公开 URL
      let chain = response ? requestChain(response.request()) : [];
      for (const u of navigatedUrls) {
        if (chain.length === 0 || !dedupeAdjacent([chain[chain.length - 1], u]).length) chain.push(u);
      }
      chain = dedupeAdjacent(chain);
      if (chain.length === 0) chain = [localChain[0]];
      const publicObservedChain = chain.map(mapLocalToPublic);
      if (publicObservedChain[0] !== sample.url) publicObservedChain.unshift(sample.url);

      return {
        blocked: false,
        startUrl: sample.url,
        finalUrl: publicChain[publicChain.length - 1],
        redirectChain: publicObservedChain,
        evidence,
        warnings,
        blockedRequests,
        elapsedMs: Date.now() - startedAt,
        ...(navError ? { error: navError, partialEvidence: evidence } : {}),
      };
    } catch (err) {
      stats.fetchErrors += 1;
      return {
        blocked: false,
        error: `沙箱代访失败：${err instanceof Error ? err.message : String(err)}`,
        startUrl: rawUrl,
        redirectChain: [rawUrl],
        evidence: [],
        partialEvidence: evidence,
        warnings,
        blockedRequests,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  return { fetchPage: fetchLocalPage, stats, close: async () => {
    await browser?.close().catch(() => undefined);
    browser = null;
  } };
}
