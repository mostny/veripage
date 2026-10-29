/**
 * 快照校验器：把「每条结论都有可定位证据」变成可执行断言
 *
 * 对应 docs/framework.md「证据模型」的程序化校验与「三维报告输出」的一致性要求：
 * - 只校验 JSON 可解析是不够的——结论引用的 evidence id 必须真实存在于证据池
 * - observed_fact / reference 必须至少绑定 1 条证据；inference 允许引用其他 finding
 *   （推理链显式可见），但不得自引用、不得引用不存在的 id
 * - 充分性与缺口清单、无法判断与未知事项、覆盖状态与原因，必须自洽
 *
 * 契约：收集全部错误后一次性返回，不抛异常——调用方（评测 / 报告页）拿到完整清单。
 */

import {
  EVIDENCE_SUFFICIENCIES,
  FINDING_KINDS,
  RISK_LEVELS,
  STEP_STATES,
  type CaseSnapshot,
  type CoverageEntry,
  type EvidenceItem,
  type Finding,
  type FindingKind,
} from "./types.ts"

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/** 运行期输入可能来自 IndexedDB / JSON 导入，按不可信数据防御性取值 */
function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : []
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * 校验一份检测快照的结构与证据绑定。
 * 每条违规收集一条错误字符串；能力所限的软约束（unknown 无 unknown 事项等）
 * 以 `[warn]` 前缀记入同一列表，同样令 ok=false——诚实可见优先于静默通过。
 */
export function validateSnapshot(snapshot: CaseSnapshot): ValidationResult {
  const errors: string[] = []

  const assessment = snapshot?.originalAssessment
  const findings = asArray<Finding>(assessment?.findings)
  const evidence = asArray<EvidenceItem>(snapshot?.evidence)
  const coverage = asArray<CoverageEntry>(snapshot?.coverage)

  // 1. id / 时间 / 输入摘要
  if (!isNonEmptyString(snapshot?.id)) {
    errors.push("snapshot.id 为空")
  }
  if (!isNonEmptyString(snapshot?.createdAt) || Number.isNaN(Date.parse(snapshot.createdAt))) {
    errors.push(`snapshot.createdAt 不是可解析的 ISO 8601 时间: ${String(snapshot?.createdAt)}`)
  }
  if (!isNonEmptyString(snapshot?.inputSummary?.displayUrl)) {
    errors.push("inputSummary.displayUrl 为空")
  }
  if (!isNonEmptyString(snapshot?.inputSummary?.registrableDomain)) {
    errors.push("inputSummary.registrableDomain 为空")
  }

  // 2. 枚举取值
  if (!RISK_LEVELS.includes(assessment?.risk)) {
    errors.push(`originalAssessment.risk 非法取值: ${String(assessment?.risk)}`)
  }
  if (!EVIDENCE_SUFFICIENCIES.includes(assessment?.evidenceSufficiency)) {
    errors.push(
      `originalAssessment.evidenceSufficiency 非法取值: ${String(assessment?.evidenceSufficiency)}`
    )
  }
  for (const f of findings) {
    if (!FINDING_KINDS.includes(f?.kind)) {
      errors.push(`finding[${String(f?.id)}].kind 非法取值: ${String(f?.kind)}`)
    }
  }
  for (let i = 0; i < coverage.length; i++) {
    if (!STEP_STATES.includes(coverage[i]?.state)) {
      errors.push(`coverage[${i}].state 非法取值: ${String(coverage[i]?.state)}`)
    }
  }

  // 3. id 唯一性与证据绑定（本模块核心价值）
  const evidenceIds = new Set<string>()
  for (const e of evidence) {
    if (!isNonEmptyString(e?.id)) {
      errors.push(`存在 id 为空的证据项: ${JSON.stringify(e)}`)
      continue
    }
    if (evidenceIds.has(e.id)) {
      errors.push(`证据 id 重复: ${e.id}`)
    }
    evidenceIds.add(e.id)
  }

  const findingIds = new Set<string>()
  for (const f of findings) {
    if (!isNonEmptyString(f?.id)) {
      errors.push(`存在 id 为空的 finding: ${JSON.stringify(f)}`)
      continue
    }
    if (findingIds.has(f.id)) {
      errors.push(`finding id 重复: ${f.id}`)
    }
    findingIds.add(f.id)
  }

  const needsEvidence = (kind: FindingKind) => kind === "observed_fact" || kind === "reference"
  for (const f of findings) {
    if (!isNonEmptyString(f?.id)) continue
    const refs = asArray<string>(f.evidenceIds)
    if (f.kind === "inference") {
      for (const ref of refs) {
        if (ref === f.id) {
          errors.push(`finding[${f.id}] 引用了自身`)
          continue
        }
        if (!evidenceIds.has(ref) && !findingIds.has(ref)) {
          errors.push(`finding[${f.id}] 引用了不存在的 id: ${String(ref)}`)
        }
      }
    } else if (needsEvidence(f.kind)) {
      if (refs.length === 0) {
        errors.push(`finding[${f.id}] (${f.kind}) 未引用任何证据`)
      }
      for (const ref of refs) {
        if (!evidenceIds.has(ref)) {
          errors.push(`finding[${f.id}] 引用了不存在的证据: ${String(ref)}`)
        }
      }
    }
  }

  // 4. 充分性一致性（无法判断时未知事项必须显式）
  if (assessment?.evidenceSufficiency !== "sufficient" && !asArray(assessment?.gaps).length) {
    errors.push(
      `[warn] evidenceSufficiency 为 ${String(assessment?.evidenceSufficiency)} 但 gaps 为空`
    )
  }
  if (assessment?.risk === "unknown" && !asArray(assessment?.unknowns).length) {
    errors.push("[warn] risk 为 unknown 但 unknowns 为空")
  }

  // 5. 检测覆盖：跳过 / 失败必须给出原因，否则「取证不完整」不可见
  for (let i = 0; i < coverage.length; i++) {
    const c = coverage[i]
    if (!isNonEmptyString(c?.step)) {
      errors.push(`coverage[${i}].step 为空`)
    }
    if ((c?.state === "skipped" || c?.state === "failed") && !isNonEmptyString(c?.reason)) {
      errors.push(`[warn] coverage[${i}] (${String(c?.step)}) 状态为 ${c.state} 但未填写 reason`)
    }
  }

  return { ok: errors.length === 0, errors }
}
