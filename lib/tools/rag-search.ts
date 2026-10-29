/**
 * 工具：rag-search —— 钓鱼案例检索（RAG 的检索端）
 *
 * 与 kb-lookup 的分工：kb-lookup 回答「这个域是谁/是否正常」，
 * rag-search 回答「这段页面文本像不像已知钓鱼手法」。
 * 检索结果只作为参考证据（reference 级）：相似案例证明手法常见，
 * 不证明当前页面恶意；无命中时如实为空，不硬凑。
 */

import { searchRelatedPhishCases, KNOWLEDGE_VERSION, type CaseMatch } from "../knowledge/index.ts";

export interface RagSearchResult {
  matches: CaseMatch[];
  knowledgeVersion: string;
  /** 供 gaps 使用：无命中时说明检索未提供佐证 */
  emptyReason?: string;
}

/** 检索与页面文本相关的钓鱼案例（默认 top 3，阈值由调用方解释） */
export function searchRelatedCases(text: string, topK = 3): RagSearchResult {
  const matches = searchRelatedPhishCases(text, topK);
  return {
    matches,
    knowledgeVersion: KNOWLEDGE_VERSION,
    emptyReason: matches.length === 0 ? "案例库未检索到相似手法（检索无佐证，不代表安全）" : undefined,
  };
}

/** 证据摘要文本（供 buildAnalyzerUserMessage 的 ev-cases 条目使用） */
export function summarizeCaseMatches(result: RagSearchResult): string {
  if (result.matches.length === 0) {
    return `钓鱼案例检索（版本 ${result.knowledgeVersion}）：${result.emptyReason}`;
  }
  const lines = [`钓鱼案例检索（版本 ${result.knowledgeVersion}），命中 ${result.matches.length} 条：`];
  for (const m of result.matches) {
    lines.push(
      `- [${m.case.id}] ${m.case.title}｜相似度 ${(m.score * 100).toFixed(0)}%｜命中特征：${m.matchedIndicators.join("、")}｜手法：${m.case.pattern}`,
    );
  }
  lines.push("注意：相似案例仅说明手法常见，不证明当前页面恶意。");
  return lines.join("\n");
}
