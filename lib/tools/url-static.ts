/**
 * 闸门①：URL 静态分析（纯确定性规则，不访问网络，不调用模型）
 *
 * 输出全部为「观察事实」级证据（level: "fact"），供后续闸门与汇总层引用。
 * 规则命中不代表最终风险结论——最终结论由 Agent 汇总三路证据后给出。
 *
 * 主域解析用维护中的公共后缀列表（psl）实现：少数后缀枚举会把
 * login.example.co.uk 误判成 co.uk、把 www.taobao.com.com.cn 误判成
 * taobao.com.com.cn，PSL 按 eTLD+1 规则给出唯一正确答案。
 */

import { get as getPublicSuffixDomain } from "psl";

export interface StaticFinding {
  /** 证据唯一 id，结论层通过它引用 */
  id: string;
  /** 闸门①产出全部为观察事实 */
  level: "fact";
  /** 人话标题 */
  title: string;
  /** 具体命中内容 / 数值 */
  detail: string;
  /** 规则权重 1（弱信号）~ 5（强信号） */
  weight: number;
}

export interface UrlStaticReport {
  input: string;
  normalizedUrl: string;
  host: string;
  registrableDomain: string;
  findings: StaticFinding[];
  /** 纯规则加权分 0-100，仅代表静态层信号强度 */
  score: number;
  /** 静态层快速路径标志。注意：按框架 v2「默认深扫原则」，主路径始终进入闸门②，此字段仅保留给性能优化场景使用 */
  needsDeepScan: boolean;
}

/** 种子品牌表：正式版由 knowledge/ 白名单库提供（kb-lookup 工具），此处仅内置最小集 */
const KNOWN_BRANDS: Array<{ name: string; domains: string[] }> = [
  { name: "淘宝", domains: ["taobao.com", "tmall.com"] },
  { name: "支付宝", domains: ["alipay.com"] },
  { name: "京东", domains: ["jd.com"] },
  { name: "微信", domains: ["weixin.qq.com", "wx.qq.com"] },
  { name: "腾讯", domains: ["qq.com"] },
  { name: "中国工商银行", domains: ["icbc.com.cn"] },
  { name: "中国建设银行", domains: ["ccb.com"] },
  { name: "中国农业银行", domains: ["abchina.com"] },
  { name: "招商银行", domains: ["cmbchina.com"] },
  { name: "教育部", domains: ["moe.gov.cn"] },
];

const SHORTENERS = new Set([
  "bit.ly", "t.cn", "tinyurl.com", "is.gd", "goo.gl", "shorturl.at",
  "dwz.cn", "urlc.cn", "suo.im", "xhslink.com", "dwz1.com",
]);

const CHEAP_TLDS = new Set(["top", "xyz", "club", "vip", "icu", "click", "link", "work", "rest"]);

/** IPv4 字面量（点分十进制）：不参与后缀解析，原样当作「主域」 */
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * 取「可注册主域」（eTLD+1，域名归属的判定基准）：
 * - IP 字面量（IPv4 点分 / IPv6 带方括号）原样返回，不当域名解析；
 * - 单标签主机名（localhost、内网短名）PSL 无从解析，原样返回；
 * - 其余交给 PSL：正确识别 example.co.uk、com.cn、多级子域与未登记 TLD；
 * - PSL 解析不了（空串 / 非法字符等）时退回 host 本身，绝不返回空串——
 *   上层要用它做「域名归属」判定，空值会被误读成「无主域」。
 */
export function getRegistrableDomain(host: string): string {
  const h = host.trim().toLowerCase();
  if (!h) return host;
  if (IPV4_LITERAL.test(h)) return h;
  // IPv6 字面量：URL.hostname 带方括号（[::1]），剥掉后原样返回
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    if (inner.includes(":")) return inner;
  }
  return getPublicSuffixDomain(h) ?? h;
}

function normalizeInput(input: string): URL {
  const trimmed = input.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme);
}

/** 检测域名标签中的非 ASCII 同形字符（如西里尔 а 冒充拉丁 a）；punycode 域显示为 xn-- */
function checkHomoglyph(host: string): StaticFinding | null {
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return {
      id: "homoglyph:punycode",
      level: "fact",
      title: "域名含 punycode 编码段（xn--）",
      detail: `host=${host}；可能使用国际化域名隐藏同形字符，需展开核对真实字符`,
      weight: 4,
    };
  }
  // 纯 ASCII 域名不可能含视觉混淆字符
  return null;
}

export function analyzeUrlStatic(input: string): UrlStaticReport {
  const url = normalizeInput(input);
  const host = url.hostname.toLowerCase();
  const registrableDomain = getRegistrableDomain(host);
  const findings: StaticFinding[] = [];

  // 规则 1：品牌域编辑距离（如 ta0bao.com ↔ taobao.com）与子域伪装
  for (const brand of KNOWN_BRANDS) {
    for (const official of brand.domains) {
      const officialRegistrable = getRegistrableDomain(official);
      // 1a. 主域整体编辑距离 1~2 → 高疑似仿冒
      const dist = levenshtein(registrableDomain, officialRegistrable);
      if (dist >= 1 && dist <= 2 && registrableDomain !== officialRegistrable) {
        findings.push({
          id: `levenshtein:${officialRegistrable}`,
          level: "fact",
          title: `主域与 ${brand.name} 官方域高度相似`,
          detail: `${registrableDomain} ↔ ${officialRegistrable}，编辑距离=${dist}`,
          weight: 5,
        });
      }
      // 1b. 品牌域作为主机名组成部分出现，但真实主域不同 → 子域伪装（taobao.com.verify-acc.cn）
      const appearsAsLabel =
        host === official ||
        host.startsWith(official + ".") ||
        host.includes("." + official + ".");
      if (appearsAsLabel && registrableDomain !== officialRegistrable) {
        findings.push({
          id: `subdomain-disguise:${officialRegistrable}`,
          level: "fact",
          title: `疑似子域伪装：包含 ${brand.name} 域名但真实主域不同`,
          detail: `host=${host}，真实可注册主域=${registrableDomain}（域名归属以最后段为准）`,
          weight: 5,
        });
      }
    }
  }

  // 规则 2：同形字符 / punycode
  const homoglyph = checkHomoglyph(host);
  if (homoglyph) findings.push(homoglyph);

  // 规则 3：短链接 → 必须展开（闸门②）
  if (SHORTENERS.has(registrableDomain)) {
    findings.push({
      id: "shortener",
      level: "fact",
      title: "短链接域名，最终目标不可见",
      detail: `${registrableDomain} 需跟随重定向展开后判定`,
      weight: 3,
    });
  }

  // 规则 4：主机名为裸 IP
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    findings.push({
      id: "ip-literal",
      level: "fact",
      title: "使用裸 IP 地址而非域名",
      detail: `host=${host}`,
      weight: 3,
    });
  }

  // 规则 5：URL 参数/片段中的注入痕迹（反射型 XSS payload 特征，浅层）
  const qs = (url.search + url.hash).toLowerCase();
  const payloadPatterns = ["<script", "%3cscript", "onerror=", "javascript:", "eval(", "document.cookie"];
  const hit = payloadPatterns.find((p) => qs.includes(p));
  if (hit) {
    findings.push({
      id: "payload-pattern",
      level: "fact",
      title: "URL 参数中包含可疑脚本注入特征",
      detail: `命中模式：${hit}（仅静态痕迹，不等于漏洞证实）`,
      weight: 3,
    });
  }

  // 规则 6：弱信号——非 HTTPS / 廉价 TLD
  if (url.protocol !== "https:") {
    findings.push({
      id: "no-https",
      level: "fact",
      title: "未使用 HTTPS",
      detail: `protocol=${url.protocol.replace(":", "")}`,
      weight: 1,
    });
  }
  const tld = registrableDomain.split(".").pop() ?? "";
  if (CHEAP_TLDS.has(tld)) {
    findings.push({
      id: "cheap-tld",
      level: "fact",
      title: `使用低成本 TLD .${tld}`,
      detail: "钓鱼站点常用，弱信号，需结合其他证据",
      weight: 1,
    });
  }

  const maxScore = 100;
  const raw = findings.reduce((s, f) => s + f.weight, 0) * 10;
  const score = Math.min(maxScore, raw);
  const needsDeepScan =
    findings.some((f) => f.weight >= 3) || findings.length >= 2 || SHORTENERS.has(registrableDomain);

  return {
    input,
    normalizedUrl: url.toString(),
    host,
    registrableDomain,
    findings,
    score,
    needsDeepScan,
  };
}
