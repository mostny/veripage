/**
 * 报告生成前的实验产物强校验（审计 2026-10-30 F12）
 *
 * 纯函数、零 IO。report.mjs 在写 report.md 之前必须全部通过，任何一项不过都
 * 拒绝生成肯定性结论（明确报错退出，而不是带病出报告）：
 * - 每组每条记录 status 必须是 ok（error / budget-stopped 说明该组未完整成功）；
 * - sampleId 在组内唯一（拒绝重复行）、与当前数据集 id/url/category 一一对应（拒绝跨批/异版混入）；
 * - 记录的 group 字段必须与文件组别一致（拒绝跨组混入）；
 * - 覆盖完整：组内唯一 sampleId 数 = 数据集规模（61）；
 * - summary 与从记录重算的 overall / byCategory / byGroup / latency 完全一致（拒绝旧行+新行的混批产物）。
 */

import { summarizeByCategory, summarizeByGroupField, summarizeRecords, latencyStats } from "./metrics.mjs";

/** 结构化深比较（数字/字符串/布尔/null/数组/普通对象；用于 summary 与重算值的一致性断言） */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * @param {object} input
 * @param {string} input.group 组名（A/B/C/C-no-vision/C-no-kb）
 * @param {Array<object>|null} input.records 该组 JSONL 解析出的记录（null = 文件缺失）
 * @param {object|null} input.summary 该组 summary.json 解析结果（null = 文件缺失）
 * @param {Array<object>} input.samples loadDataset() 全量样本
 * @returns {string[]} 错误列表（空数组 = 通过）
 */
export function validateExperimentSet({ group, records, summary, samples }) {
  const errors = [];
  const prefix = `[${group}]`;
  if (!Array.isArray(records) || records.length === 0) {
    errors.push(`${prefix} 结果记录缺失或为空（先成功跑完该组再生成报告）`);
    return errors;
  }
  if (!summary || typeof summary !== "object") {
    errors.push(`${prefix} summary.json 缺失或不可解析（summary 与记录混批的产物拒绝出报告）`);
    return errors;
  }

  const sampleById = new Map(samples.map((s) => [s.id, s]));
  const seenIds = new Set();
  for (const [index, r] of records.entries()) {
    const at = `${prefix} 第 ${index + 1} 行（sampleId=${r?.sampleId ?? "?"}）`;
    if (!r || typeof r !== "object") {
      errors.push(`${at} 不是合法记录对象`);
      continue;
    }
    if (r.group !== undefined && r.group !== group) {
      errors.push(`${at} 记录组别为 ${JSON.stringify(r.group)}，与文件组别 ${group} 不一致（跨组混入）`);
    }
    if (r.status !== undefined && r.status !== "ok") {
      errors.push(`${at} status=${JSON.stringify(r.status)}（只允许 ok；error/budget-stopped 的组不得生成肯定性报告）`);
    }
    if (typeof r.sampleId !== "string") {
      errors.push(`${at} 缺少 sampleId`);
      continue;
    }
    if (seenIds.has(r.sampleId)) {
      errors.push(`${at} sampleId 重复出现（重复行会被同时计入分子与分母，拒绝出报告）`);
      continue;
    }
    seenIds.add(r.sampleId);
    const sample = sampleById.get(r.sampleId);
    if (!sample) {
      errors.push(`${at} 不在当前数据集（跨批/异版数据混入？）`);
      continue;
    }
    if (r.url !== undefined && r.url !== sample.url) errors.push(`${at} url 与数据集不一致：${r.url} ≠ ${sample.url}`);
    if (r.category !== undefined && r.category !== sample.category) {
      errors.push(`${at} category 与数据集不一致：${r.category} ≠ ${sample.category}`);
    }
  }

  if (seenIds.size !== samples.length) {
    errors.push(`${prefix} 样本覆盖不完整：唯一 sampleId ${seenIds.size} 个，数据集共 ${samples.length} 个`);
  }

  if (summary.group !== undefined && summary.group !== group) {
    errors.push(`${prefix} summary.group=${JSON.stringify(summary.group)} 与文件组别不一致`);
  }
  if (summary.datasetSize !== undefined && summary.datasetSize !== samples.length) {
    errors.push(`${prefix} summary.datasetSize=${summary.datasetSize} ≠ 数据集规模 ${samples.length}`);
  }
  if (summary.budgetStopped === true) {
    errors.push(`${prefix} summary 标记 budgetStopped=true（预算中断的组不得生成肯定性报告）`);
  }

  // summary 与重算一致性（全部 ok 记录 + sample 上下文，与 run-group 落盘时的口径一致）
  const okRecords = records
    .filter((r) => r && r.status === "ok")
    .map((r) => ({ ...r, sample: sampleById.get(r.sampleId) }))
    .filter((r) => r.sample !== undefined);
  if (summary.completed !== undefined && summary.completed !== okRecords.length) {
    errors.push(`${prefix} summary.completed=${summary.completed} ≠ 实际 ok 记录数 ${okRecords.length}`);
  }
  const recomputed = {
    overall: summarizeRecords(okRecords),
    byCategory: summarizeByCategory(okRecords),
    byGroup: summarizeByGroupField(okRecords),
    latency: latencyStats(okRecords),
  };
  for (const [section, value] of Object.entries(recomputed)) {
    if (summary[section] === undefined) {
      errors.push(`${prefix} summary 缺少 ${section} 段`);
    } else if (!deepEqual(value, summary[section])) {
      errors.push(`${prefix} summary.${section} 与按记录重算的结果不一致（记录与 summary 混批/被改动）`);
    }
  }
  return errors;
}
