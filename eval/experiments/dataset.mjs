/**
 * W3 数据集加载器：eval/dataset/samples/*.json → 结构化样本列表
 *
 * 样本 JSON 字段：{ id, group, category, url, expectRisk, page, hops?, blacklist?, httpStatus?, notes }
 * - page     相对 eval/dataset/ 的 HTML 路径（本地 fixture 承载，不访问外部站点）
 * - hops     公开跳转链（不含起始 URL，含最终落地 URL）；本地 fixture 用真实 30x 逐跳实现
 * - blacklist true = 该域在 A 组简易黑名单内（模拟已被威胁情报收录）
 *
 * 加载顺序按类别轮转（round-robin）：--limit N 的小样本试跑天然覆盖每个类别。
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATASET_DIR = path.resolve(HERE, "..", "dataset");
const SAMPLES_DIR = path.join(DATASET_DIR, "samples");

export function loadDataset() {
  const files = readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const samples = files.map((file) => {
    const raw = JSON.parse(readFileSync(path.join(SAMPLES_DIR, file), "utf8"));
    return {
      ...raw,
      httpStatus: raw.httpStatus ?? 200,
      hops: raw.hops ?? [],
      blacklist: raw.blacklist === true,
      htmlPath: path.join(DATASET_DIR, raw.page),
      html: readFileSync(path.join(DATASET_DIR, raw.page), "utf8"),
    };
  });

  // 完整性校验：id/url 唯一、页面非空、期望值合法
  const seenIds = new Set();
  const seenUrls = new Set();
  for (const s of samples) {
    if (seenIds.has(s.id)) throw new Error(`数据集 id 重复：${s.id}`);
    if (seenUrls.has(s.url)) throw new Error(`数据集 url 重复：${s.url}`);
    seenIds.add(s.id);
    seenUrls.add(s.url);
    if (!["no_significant_risk", "suspicious", "high", "unknown"].includes(s.expectRisk)) {
      throw new Error(`样本 ${s.id} expectRisk 非法：${s.expectRisk}`);
    }
    if (s.html.trim().length === 0) throw new Error(`样本 ${s.id} 页面为空`);
  }

  // 类别轮转排序：official, sso, lookalike, visual, incomplete, injection, official, …
  const byCategory = new Map();
  for (const s of samples) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(s);
  }
  const ordered = [];
  let round = 0;
  for (;;) {
    let any = false;
    for (const list of byCategory.values()) {
      if (round < list.length) {
        ordered.push(list[round]);
        any = true;
      }
    }
    if (!any) break;
    round += 1;
  }
  return ordered;
}

/** 样本 → 本地 fixture 路由（公开 URL 与本地路径的一一映射） */
export function routesFor(sample) {
  const localChain = [];
  for (let i = 0; i < sample.hops.length; i += 1) localChain.push(`/hop/${sample.id}/${i}`);
  localChain.push(`/page/${sample.id}`);
  const publicChain = [sample.url, ...sample.hops];
  if (localChain.length !== publicChain.length) {
    throw new Error(`样本 ${sample.id} 跳转链声明不一致：hops=${sample.hops.length}`);
  }
  return {
    startPath: localChain[0],
    localChain,
    publicChain,
    mapLocalToPublic: (localUrl) => {
      const idx = localChain.findIndex((p) => localUrl.endsWith(p));
      return idx >= 0 ? publicChain[idx] : localUrl;
    },
  };
}

export const DATASET_DIR_PATH = DATASET_DIR;
