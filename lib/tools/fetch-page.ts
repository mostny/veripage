/**
 * 闸门②：沙箱代访（Playwright 无头浏览器，机器替人「点」）
 *
 * 职责：在 S0 访问边界（lib/guard/access.ts）之内，用一次性无头浏览器打开目标页，
 * 采集「技术事实」级证据（观察事实，不带模型判断）供闸门③ AI 取证与汇总层引用：
 *   - 完整跳转链（反代钓鱼 / 恶意跳转的核心指纹）
 *   - 整页截图（视觉模型输入）
 *   - 标题 + 可见正文（语义模型输入）
 *   - 表单 action / method / 是否含密码框（凭据索取行为）
 *   - 第三方域脚本清单（反代钓鱼指纹）
 *
 * 安全纪律：
 *   - 导航前先过 S0，被拒则直接返回 blocked，不启动浏览器
 *   - 浏览器内所有子资源同样过 S0（route 拦截 + DNS 重绑定缓解，解析结果缓存 60s）
 *   - 每次调用独立 browser context，无 cookie / 存储残留，用完即关
 *   - 失败只降级不抛异常：返回 { blocked: false, error, partialEvidence }
 */

import { chromium } from "playwright";
import type { BrowserContext, Page, Request, Response, Route } from "playwright";
import { assertPublicHttpUrl, assertPublicHost } from "../guard/access.ts";
import { getRegistrableDomain } from "./url-static.ts";

// ---------------------------------------------------------------------------
// 类型定义（证据结构，全部为「观察事实」级）
// ---------------------------------------------------------------------------

export type PageEvidenceType = "screenshot" | "text" | "forms" | "externalScripts";

interface EvidenceBase {
  /** 证据唯一 id，结论层通过它引用 */
  id: string;
  /** 采集时间（ISO 8601） */
  capturedAt: string;
  type: PageEvidenceType;
  /** 证据来源（采集方式），供回放与审计 */
  source: string;
}

export interface ScreenshotEvidence extends EvidenceBase {
  type: "screenshot";
  mimeType: "image/png";
  encoding: "base64";
  /** 整页截图 base64 字符串 */
  data: string;
  width: number;
  height: number;
  fullPage: true;
}

export interface TextEvidence extends EvidenceBase {
  type: "text";
  title: string;
  /** 可见正文（innerText，已截断） */
  text: string;
  truncated: boolean;
}

/** 单个表单的硬事实：提交到哪、用什么方法、是否索要密码 */
export interface FormFacts {
  action: string;
  method: string;
  hasPasswordInput: boolean;
  inputCount: number;
}

export interface FormsEvidence extends EvidenceBase {
  type: "forms";
  forms: FormFacts[];
}

export interface ExternalScriptFacts {
  src: string;
  domain: string;
}

export interface ExternalScriptsEvidence extends EvidenceBase {
  type: "externalScripts";
  /** 第三方域脚本域名（去重） */
  domains: string[];
  scripts: ExternalScriptFacts[];
}

export type PageEvidence =
  | ScreenshotEvidence
  | TextEvidence
  | FormsEvidence
  | ExternalScriptsEvidence;

/** 被 S0 拦截的子资源事实（证明边界确实在工作） */
export interface BlockedRequestFact {
  url: string;
  host: string;
  reason: string;
}

export interface FetchPageResult {
  /** true = 被 S0 访问边界拒绝，未启动浏览器 */
  blocked: boolean;
  /** blocked 时的拒绝原因 */
  reason?: string;
  /** 非 blocked 的失败原因（超时 / 导航失败 / 超出预算） */
  error?: string;
  startUrl: string;
  finalUrl?: string;
  /** 完整跳转链：起始 URL → … → 最终 URL */
  redirectChain: string[];
  /** 最终 HTML（截断到 MAX_HTML_CHARS） */
  html?: string;
  htmlTruncated?: boolean;
  /** 成功时返回全部证据 */
  evidence: PageEvidence[];
  /** 失败时返回已采集到的部分证据 */
  partialEvidence?: PageEvidence[];
  /** 采集过程中被跳过的步骤及原因（取证不完整要诚实可见） */
  warnings: string[];
  blockedRequests: BlockedRequestFact[];
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// 预算常量
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_REDIRECTS = 10;
const TOTAL_TIMEOUT_MS = 20_000;
const MAX_HTML_CHARS = 50_000;
const MAX_TEXT_CHARS = 3_000;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** 忽略末尾斜杠后比较，避免 "https://x.com" 与 "https://x.com/" 被判为两次跳转 */
function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** 给 Promise 加剩余预算超时；超时视为该步失败，由上层降级处理 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("已超出总超时预算"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`操作超过剩余预算 ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 顺着 redirectedFrom 反推完整 HTTP 跳转链（服务端 30x） */
function requestChain(req: Request): string[] {
  const urls: string[] = [];
  let cur: Request | null = req;
  while (cur) {
    urls.unshift(cur.url());
    cur = cur.redirectedFrom();
  }
  return urls;
}

function dedupeAdjacent(urls: string[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (out.length === 0 || !sameUrl(out[out.length - 1], u)) out.push(u);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 沙箱代访单个 URL。
 * 任何失败都以结构化结果返回，不向调用方抛异常。
 */
export async function fetchPage(rawUrl: string): Promise<FetchPageResult> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  const start = safeUrl(rawUrl.trim());
  if (!start) {
    return {
      blocked: false,
      error: `URL 无法解析：${rawUrl}`,
      startUrl: rawUrl,
      redirectChain: [],
      evidence: [],
      warnings: ["url-parse-failed"],
      blockedRequests: [],
      elapsedMs: elapsed(),
    };
  }
  const startUrl = start.toString();

  // ---- S0 访问边界：拒绝则不启动浏览器 -----------------------------------
  const guard = await assertPublicHttpUrl(startUrl);
  if (!guard.allowed) {
    return {
      blocked: true,
      reason: guard.reason ?? "S0 访问边界拒绝",
      startUrl,
      redirectChain: [],
      evidence: [],
      warnings: [],
      blockedRequests: [],
      elapsedMs: elapsed(),
    };
  }

  // ---- 预算：总超时 20s，最多 10 次跳转 ----------------------------------
  const deadline = startedAt + TOTAL_TIMEOUT_MS;
  const remaining = (): number => deadline - Date.now();

  const evidence: PageEvidence[] = [];
  const warnings: string[] = [];
  const blockedRequests: BlockedRequestFact[] = [];
  let docHops = 0; // 主文档跳转计数（含首次导航）
  let budgetExceeded = false;
  let seq = 0;
  let html: string | undefined;
  let htmlTruncated: boolean | undefined;
  const nextId = (type: PageEvidenceType): string => `ev-${type}-${++seq}`;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      // Windows 下部分环境（管理员 / 容器）沙箱初始化会失败
      args: ["--no-sandbox"],
    });
    // 每次调用独立 context：无 cookie / 存储 / 缓存残留，探测之间互不影响
    context = await browser.newContext({
      viewport: VIEWPORT,
      // 证书异常不作为硬失败：否则自签 / 过期站点直接拿不到任何证据，
      // 证书状态属于「技术事实」，由上层规则层判定，本层只负责把页面取回来
      ignoreHTTPSErrors: true,
    });

    // ---- DNS 重绑定缓解：所有请求（含主文档与子资源）都过 S0 ---------------
    await context.route("**/*", async (route: Route) => {
      const req = route.request();
      const target = safeUrl(req.url());
      if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
        blockedRequests.push({
          url: req.url(),
          host: target?.hostname ?? "",
          reason: "非 http/https 子资源，直接拦截",
        });
        await route.abort();
        return;
      }

      // 主文档跳转预算：超过 MAX_REDIRECTS 立即中断，防跳转炸弹拖垮流水线
      if (req.resourceType() === "document" && req.isNavigationRequest() && req.frame() === page?.mainFrame()) {
        docHops += 1;
        if (docHops > MAX_REDIRECTS + 1) {
          budgetExceeded = true;
          await route.abort();
          return;
        }
      }

      const hostCheck = await assertPublicHost(target.hostname);
      if (!hostCheck.ok) {
        blockedRequests.push({
          url: req.url(),
          host: target.hostname,
          reason: hostCheck.reason ?? "S0 访问边界拒绝",
        });
        await route.abort();
        return;
      }
      await route.continue();
    });

    page = await context.newPage();

    // 客户端跳转（meta refresh / JS location）也记入跳转链
    const navigatedUrls: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page?.mainFrame()) navigatedUrls.push(frame.url());
    });

    // ---- 导航 -------------------------------------------------------------
    let navError: string | null = null;
    let response: Response | null = null;
    try {
      response = await page.goto(startUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1000, remaining()),
      });
    } catch (err) {
      navError = budgetExceeded
        ? `跳转次数超过预算（最多 ${MAX_REDIRECTS} 次）`
        : `导航失败：${errMsg(err)}`;
    }

    // ---- 采集证据：DOM 类先行，截图最后 ------------------------------------
    // 顺序即优先级——一旦超时，已拿到的廉价证据仍可作为 partialEvidence 返回
    const finalUrl = page.url();

    if (remaining() <= 0) {
      warnings.push(`总超时 ${TOTAL_TIMEOUT_MS}ms 已用尽，跳过剩余采集步骤`);
    } else {
      // 1) 标题 + 可见正文
      try {
        const dom = await withDeadline(
          page.evaluate(() => {
            const forms = Array.from(document.forms).map((f) => ({
              action: f.action || "",
              method: (f.method || "get").toLowerCase(),
              hasPasswordInput: f.querySelector('input[type="password"]') !== null,
              inputCount: f.querySelectorAll("input, textarea, select").length,
            }));
            const scripts = Array.from(document.querySelectorAll("script[src]"))
              .map((s) => (s as HTMLScriptElement).src)
              .filter((src) => src.length > 0);
            return {
              title: document.title ?? "",
              bodyText: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"),
              forms,
              scripts,
            };
          }),
          remaining(),
        );
        const capturedAt = new Date().toISOString();
        const t = truncate(dom.bodyText, MAX_TEXT_CHARS);
        evidence.push({
          id: nextId("text"),
          capturedAt,
          type: "text",
          source: "playwright:document.title + document.body.innerText",
          title: dom.title,
          text: t.text,
          truncated: t.truncated,
        });
        evidence.push({
          id: nextId("forms"),
          capturedAt,
          type: "forms",
          source: "playwright:document.forms",
          forms: dom.forms,
        });

        // 第三方域脚本：与最终页面可注册主域不同的脚本域名（去重）
        const pageDomain = (() => {
          const u = safeUrl(finalUrl);
          return u ? getRegistrableDomain(u.hostname) : "";
        })();
        const seen = new Set<string>();
        const thirdParty: ExternalScriptFacts[] = [];
        for (const src of dom.scripts) {
          const u = safeUrl(src);
          if (!u) continue;
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
          source: "playwright:script[src] 与最终页主域比对",
          domains: thirdParty.map((s) => s.domain),
          scripts: thirdParty,
        });
      } catch (err) {
        warnings.push(`DOM 证据采集失败：${errMsg(err)}`);
      }

      // 2) HTML（截断 50000 字符）
      try {
        const raw = await withDeadline(page.content(), remaining());
        const t = truncate(raw, MAX_HTML_CHARS);
        html = t.text;
        htmlTruncated = t.truncated;
      } catch (err) {
        warnings.push(`HTML 采集失败：${errMsg(err)}`);
      }

      // 3) 整页截图
      try {
        const shot = await withDeadline(
          page.screenshot({ fullPage: true, type: "png" }),
          remaining(),
        );
        evidence.push({
          id: nextId("screenshot"),
          capturedAt: new Date().toISOString(),
          type: "screenshot",
          source: "playwright:page.screenshot(fullPage)",
          mimeType: "image/png",
          encoding: "base64",
          data: shot.toString("base64"),
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          fullPage: true,
        });
      } catch (err) {
        warnings.push(`截图采集失败：${errMsg(err)}`);
      }
    }

    // ---- 跳转链：服务端 30x（redirectedFrom 反推）+ 客户端跳转 -------------
    let chain: string[] = response ? requestChain(response.request()) : [];
    for (const u of navigatedUrls) {
      if (chain.length === 0 || !sameUrl(chain[chain.length - 1], u)) chain.push(u);
    }
    chain = dedupeAdjacent(chain);
    if (chain.length === 0) chain = [startUrl];
    else if (!sameUrl(chain[0], startUrl)) chain.unshift(startUrl);

    // ---- 汇总 -------------------------------------------------------------
    if (navError) {
      return {
        blocked: false,
        error: navError,
        startUrl,
        finalUrl,
        redirectChain: chain,
        evidence: [],
        partialEvidence: evidence,
        warnings,
        blockedRequests,
        elapsedMs: elapsed(),
      };
    }

    return {
      blocked: false,
      startUrl,
      finalUrl,
      redirectChain: chain,
      html,
      htmlTruncated,
      evidence,
      warnings,
      blockedRequests,
      elapsedMs: elapsed(),
    };
  } catch (err) {
    // 浏览器启动 / context 创建等阶段的意外失败：同样降级为结构化结果
    return {
      blocked: false,
      error: `沙箱代访失败：${errMsg(err)}`,
      startUrl,
      redirectChain: [startUrl],
      evidence: [],
      partialEvidence: evidence,
      warnings,
      blockedRequests,
      elapsedMs: elapsed(),
    };
  } finally {
    // 隔离性保证：无论成败都关掉本次 context 与浏览器
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
