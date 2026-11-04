/**
 * 跳转链合并的纯数组工具（审计 2026-10-30 F15）
 *
 * 与生产采集器 lib/tools/fetch-page.ts 的同名逻辑保持同一比较方式：
 * - sameUrl：忽略末尾斜杠后比较，避免 "https://x.com" 与 "https://x.com/" 被判为两次跳转；
 * - dedupeAdjacent：相邻去重；
 * - mergeNavigationChain：服务端 30x 链（redirectedFrom 反推）+ 客户端跳转（framenavigated 观察）
 *   合并——客户端导航与链尾不同就要**保留**。
 *
 * 历史 bug（F15）：旧写法 `!dedupeAdjacent([last, u]).length` 对非空输入恒为 false，
 * 导致已有 request chain 时后续 main-frame navigation 一律不加入。此模块为纯函数，
 * 由 local-fetcher.mjs 使用、guards.test.mjs 直接单测。
 */

/** 忽略末尾斜杠后比较（与 lib/tools/fetch-page.ts 的 sameUrl 同一比较方式） */
export function sameUrl(a, b) {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** 相邻 URL 去重 */
export function dedupeAdjacent(urls) {
  const out = [];
  for (const u of urls) {
    if (out.length === 0 || !sameUrl(out[out.length - 1], u)) out.push(u);
  }
  return out;
}

/**
 * 合并服务端跳转链与客户端导航观察（与 fetch-page.ts 的合并条件一致）：
 * 链为空，或新导航与链尾不是同一 URL 时，把导航加入链。
 * @param {string[]} serverChain  服务端 30x 链（requestChain(request) 反推）
 * @param {string[]} navigatedUrls 主框架 framenavigated 观察到的导航序列（按时间序）
 * @returns {string[]} 合并并相邻去重后的完整链
 */
export function mergeNavigationChain(serverChain, navigatedUrls) {
  const chain = [...serverChain];
  for (const u of navigatedUrls) {
    if (chain.length === 0 || !sameUrl(chain[chain.length - 1], u)) chain.push(u);
  }
  return dedupeAdjacent(chain);
}
