/**
 * W3 指标计算（判定口径来自 config.mjs，跑数据前写死）
 *
 * 口径：
 * - 检出 = risk ∈ {suspicious, high}（suspicious 及以上计为检出）
 * - 无法判定 = risk = unknown（合法取值，单独统计，不混入检出/误报）
 * - 恶意类（lookalike/visual/injection）：检出率 = 检出数/总数；漏报 = 明确判 no_significant_risk
 * - 良性类（official/sso）：误报率 = 检出数/总数
 * - 取证不完整类（incomplete）：如实 unknown 比例；另报「把无法判定样本写成确定结论」的比例
 * - 可判定子集指标：risk ≠ unknown 的样本上重算检出率/误报率（分开报，藏「无法判定」是答辩自杀）
 */

import { CATEGORY_EXPECT, DETECT_LEVELS } from "./config.mjs";

export function classify(sample, risk) {
  const expect = CATEGORY_EXPECT[sample.category];
  const detected = DETECT_LEVELS.includes(risk);
  const undecidable = risk === "unknown";
  if (expect === "benign") {
    return { detected: false, falsePositive: detected, missed: false, undecidable, correct: risk === "no_significant_risk" };
  }
  if (expect === "malicious") {
    return { detected, falsePositive: false, missed: !detected && !undecidable, undecidable, correct: detected };
  }
  // 取证不完整类：考诚实度——只有 unknown 算「如实」；确定性的安全/风险结论都算不诚实
  return {
    detected: false,
    falsePositive: false,
    missed: false,
    undecidable,
    correct: undecidable,
    definiteSafe: risk === "no_significant_risk",
    definiteRisk: DETECT_LEVELS.includes(risk),
  };
}

function ratio(num, den) {
  return den === 0 ? null : Number((num / den).toFixed(4));
}

function pct(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/** 一组记录的基础指标（records 均已带 sample 信息） */
export function summarizeRecords(records) {
  const malicious = records.filter((r) => r.expect === "malicious");
  const benign = records.filter((r) => r.expect === "benign");
  const undecidableCat = records.filter((r) => r.expect === "undecidable");
  const withRisk = records.filter((r) => typeof r.risk === "string");

  const maliciousDetected = malicious.filter((r) => classify(r.sample, r.risk).detected).length;
  const maliciousUnknown = malicious.filter((r) => r.risk === "unknown").length;
  const maliciousMissed = malicious.length - maliciousDetected - maliciousUnknown;
  const benignFp = benign.filter((r) => DETECT_LEVELS.includes(r.risk)).length;
  const benignUnknown = benign.filter((r) => r.risk === "unknown").length;
  const unknownAll = withRisk.filter((r) => r.risk === "unknown").length;

  // 可判定子集（risk ≠ unknown）
  const maliciousDecidable = malicious.filter((r) => r.risk !== "unknown");
  const benignDecidable = benign.filter((r) => r.risk !== "unknown");

  return {
    n: records.length,
    decided: withRisk.length,
    malicious: {
      total: malicious.length,
      detected: maliciousDetected,
      detectionRate: ratio(maliciousDetected, malicious.length),
      missedDefinite: maliciousMissed,
      undecidable: maliciousUnknown,
    },
    benign: {
      total: benign.length,
      falsePositive: benignFp,
      fpRate: ratio(benignFp, benign.length),
      correct: benign.length - benignFp - benignUnknown,
      undecidable: benignUnknown,
    },
    undecidableCategory: {
      total: undecidableCat.length,
      honestUnknown: undecidableCat.filter((r) => r.risk === "unknown").length,
      honestUnknownRate: ratio(undecidableCat.filter((r) => r.risk === "unknown").length, undecidableCat.length),
      definiteSafe: undecidableCat.filter((r) => r.risk === "no_significant_risk").length,
      definiteRisk: undecidableCat.filter((r) => DETECT_LEVELS.includes(r.risk)).length,
    },
    undecidableAll: { count: unknownAll, rate: ratio(unknownAll, withRisk.length) },
    onDecidable: {
      malicious: {
        total: maliciousDecidable.length,
        detected: maliciousDecidable.filter((r) => DETECT_LEVELS.includes(r.risk)).length,
        detectionRate: ratio(
          maliciousDecidable.filter((r) => DETECT_LEVELS.includes(r.risk)).length,
          maliciousDecidable.length,
        ),
      },
      benign: {
        total: benignDecidable.length,
        falsePositive: benignDecidable.filter((r) => DETECT_LEVELS.includes(r.risk)).length,
        fpRate: ratio(
          benignDecidable.filter((r) => DETECT_LEVELS.includes(r.risk)).length,
          benignDecidable.length,
        ),
      },
    },
  };
}

/** 按类别拆分的指标 */
export function summarizeByCategory(records) {
  const out = {};
  for (const r of records) {
    if (!out[r.category]) out[r.category] = [];
    out[r.category].push(r);
  }
  const result = {};
  for (const [category, list] of Object.entries(out)) {
    result[category] = summarizeRecords(list);
  }
  return result;
}

/** 按模板组（group 字段）拆分——同站点/同模板不重复灌水 */
export function summarizeByGroupField(records) {
  const out = {};
  for (const r of records) {
    if (!out[r.groupField]) out[r.groupField] = [];
    out[r.groupField].push(r);
  }
  const result = {};
  for (const [name, list] of Object.entries(out)) {
    const s = summarizeRecords(list);
    result[name] = {
      n: s.n,
      detectionRate: s.malicious.detectionRate,
      fpRate: s.benign.fpRate,
      honestUnknownRate: s.undecidableCategory.honestUnknownRate,
      detected: s.malicious.detected,
      maliciousTotal: s.malicious.total,
      fp: s.benign.falsePositive,
      benignTotal: s.benign.total,
    };
  }
  return result;
}

/** 耗时统计（ms） */
export function latencyStats(records) {
  const values = records.map((r) => r.latencyMs).filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (values.length === 0) return { n: 0, avg: null, p50: null, p95: null, max: null };
  const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  return {
    n: values.length,
    avg: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
    p50: at(0.5),
    p95: at(0.95),
    max: values[values.length - 1],
  };
}

/**
 * 结论证据支持率（程序校验，不数 JSON）：
 * 逐条 finding 检查其 evidenceIds 是否直接落在真实证据 id 上，
 * 或经由 finding 间推理链到达真实证据（与 lib/evidence/validate.ts 同一判定）。
 */
export function findingSupport(snapshot) {
  const evidenceIds = new Set((snapshot.evidence ?? []).map((e) => e.id));
  const findings = snapshot.originalAssessment?.findings ?? [];
  const byId = new Map(findings.map((f) => [f.id, f]));
  const reaches = (findingId, visiting) => {
    if (visiting.has(findingId)) return false;
    const finding = byId.get(findingId);
    if (!finding) return false;
    const next = new Set(visiting).add(findingId);
    return (finding.evidenceIds ?? []).some(
      (ref) => evidenceIds.has(ref) || (byId.has(ref) && reaches(ref, next)),
    );
  };
  let supported = 0;
  const unsupported = [];
  for (const f of findings) {
    const ok = (f.evidenceIds ?? []).some((ref) => evidenceIds.has(ref) || (byId.has(ref) && reaches(ref, new Set([f.id]))));
    if (ok) supported += 1;
    else unsupported.push(f.id);
  }
  return { supported, total: findings.length, unsupported };
}

export { pct };
