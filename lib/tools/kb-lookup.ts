/**
 * 工具：kb-lookup —— 域名结构化查询（白名单 / 第三方服务）
 *
 * 供编排器在「有界补证」轮调用：当页面声称身份与域名可能不一致、
 * 或出现跨域脚本/表单目标需要判断是否有正常解释时，查一次知识库。
 * 输出为证据就绪结构（带 note/source/version），失败返回查询失败而不是猜测。
 */

import { lookupBrandByDomain, lookupThirdParty, KNOWLEDGE_VERSION } from "../knowledge/index.ts";

export interface KbLookupResult {
  domain: string;
  brand: ReturnType<typeof lookupBrandByDomain>;
  thirdParty: ReturnType<typeof lookupThirdParty>;
  /** 知识库版本（随证据进快照 versions.knowledge） */
  knowledgeVersion: string;
}

/**
 * 查询一个域名（可注册主域或完整主机名均可）：
 *  - brand：是否命中品牌官方域白名单（身份核验）
 *  - thirdParty：是否命中已核验 SSO/CDN/统计域（合法解释）
 */
export function kbLookupDomain(domain: string): KbLookupResult {
  return {
    domain,
    brand: lookupBrandByDomain(domain),
    thirdParty: lookupThirdParty(domain),
    knowledgeVersion: KNOWLEDGE_VERSION,
  };
}

/** 证据摘要文本（供 buildAnalyzerUserMessage 的 ev-knowledge 条目使用） */
export function summarizeKbLookup(result: KbLookupResult): string {
  const lines: string[] = [`知识库查询（版本 ${result.knowledgeVersion}）：`];
  lines.push(`- 品牌白名单：${result.brand.hit ? result.brand.note : result.brand.note}`);
  if (result.thirdParty.hit && result.thirdParty.entry) {
    lines.push(
      `- 第三方服务：命中已核验「${result.thirdParty.entry.name}」（${result.thirdParty.entry.kind}，${result.thirdParty.matchedOn}）——跨域脚本/资源属正常技术现象，不单独作为恶意证据`,
    );
  } else {
    lines.push("- 第三方服务：未收录（未收录不等于未授权）");
  }
  return lines.join("\n");
}
