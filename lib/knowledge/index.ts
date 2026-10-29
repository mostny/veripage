/**
 * 知识库加载与检索（M4：身份关系与合法解释）
 *
 * 数据文件（knowledge/*.json，随仓库发布的只读资料，带版本与核验日期）：
 *   - brands.json        已核验品牌官方域白名单
 *   - sso-providers.json 已核验第三方登录 / CDN / 统计服务域（合法解释用）
 *   - phish-cases.json   钓鱼手法案例库（模式级）
 *
 * 纪律：
 *   - 「未收录 ≠ 未授权」：白名单未命中时只说明资料未覆盖，不得据此判恶意
 *   - 检索结果作为证据进入快照时必须带来源与版本（versions.knowledge）
 *   - 用 fs + import.meta.url 读取而非静态 import：同时兼容 Next 服务端与
 *     Node 原生冒烟脚本（ESM 下 JSON 静态 import 需要 import attributes，两端语义不一致）
 */

import { readFileSync } from "node:fs";

export interface BrandEntry {
  id: string;
  name: string;
  officialDomains: string[];
  /** 后缀级白名单（如 gov.cn / edu.cn），与具体官方域二选一或并用 */
  domainSuffixes?: string[];
  category: string;
  source: string;
}

export interface SsoEntry {
  id: string;
  name: string;
  domains: string[];
  kind: "sso" | "cdn" | "analytics";
  source: string;
}

export interface PhishCase {
  id: string;
  title: string;
  pattern: string;
  indicators: string[];
  advice: string;
  source: string;
}

interface BrandsFile { version: string; verifiedAt: string; description: string; entries: BrandEntry[] }
interface SsoFile { version: string; verifiedAt: string; description: string; entries: SsoEntry[] }
interface CasesFile { version: string; verifiedAt: string; description: string; entries: PhishCase[] }

function loadJson<T>(file: string): T {
  const url = new URL(`../../knowledge/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

const brandsFile = loadJson<BrandsFile>("brands.json");
const ssoFile = loadJson<SsoFile>("sso-providers.json");
const casesFile = loadJson<CasesFile>("phish-cases.json");

/** 知识库聚合版本号——进入 CaseSnapshot.versions.knowledge，保证实验可复现 */
export const KNOWLEDGE_VERSION = `${brandsFile.version}+${ssoFile.version}+${casesFile.version}`;
export const KNOWLEDGE_VERIFIED_AT = brandsFile.verifiedAt;

/** 域名归一化：小写、去端口、去首段 www */
function normalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  d = d.replace(/:\d+$/, "");
  if (d.startsWith("www.")) d = d.slice(4);
  return d;
}

/** domain 是否等于 official 或是其子域（login.taobao.com 属于 taobao.com） */
function domainMatches(domain: string, official: string): boolean {
  return domain === official || domain.endsWith(`.${official}`);
}

export interface BrandLookup {
  hit: boolean;
  entry?: BrandEntry;
  matchedOn?: string;
  /** 固定话术：未收录不等于未授权 */
  note: string;
}

/** 按域名查品牌官方域白名单 */
export function lookupBrandByDomain(rawDomain: string): BrandLookup {
  const domain = normalizeDomain(rawDomain);
  for (const entry of brandsFile.entries) {
    for (const official of entry.officialDomains) {
      if (domainMatches(domain, official)) {
        return { hit: true, entry, matchedOn: official, note: `命中「${entry.name}」官方域白名单（${official}）` };
      }
    }
    for (const suffix of entry.domainSuffixes ?? []) {
      if (domain === suffix || domain.endsWith(`.${suffix}`)) {
        return { hit: true, entry, matchedOn: suffix, note: `命中「${entry.name}」后缀白名单（.${suffix}）` };
      }
    }
  }
  return { hit: false, note: "未收录于官方域白名单——未收录不等于未授权，需其他证据判断" };
}

export interface ThirdPartyLookup {
  hit: boolean;
  entry?: SsoEntry;
  matchedOn?: string;
}

/** 按域名查已核验第三方服务（SSO/CDN/统计）——用于「合法解释」 */
export function lookupThirdParty(rawDomain: string): ThirdPartyLookup {
  const domain = normalizeDomain(rawDomain);
  for (const entry of ssoFile.entries) {
    for (const d of entry.domains) {
      if (domainMatches(domain, d)) {
        return { hit: true, entry, matchedOn: d };
      }
    }
  }
  return { hit: false };
}

export interface CaseMatch {
  case: PhishCase;
  /** 0—1：命中 indicator 数 / 该案例 indicator 总数 */
  score: number;
  matchedIndicators: string[];
}

/**
 * 钓鱼案例检索（轻量关键词匹配，离线可跑）。
 * 后续如需语义召回可再升级索引；当前以确定性、可复现优先。
 */
export function searchRelatedPhishCases(text: string, topK = 3): CaseMatch[] {
  const lower = text.toLowerCase();
  const matches: CaseMatch[] = [];
  for (const c of casesFile.entries) {
    const matchedIndicators = c.indicators.filter((ind) => lower.includes(ind.toLowerCase()));
    if (matchedIndicators.length === 0) continue;
    matches.push({ case: c, score: matchedIndicators.length / c.indicators.length, matchedIndicators });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, topK);
}

/** 案例库只读访问（报告引用来源时用） */
export function allPhishCases(): PhishCase[] {
  return casesFile.entries;
}
