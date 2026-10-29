/**
 * 证据类型契约（核心数据契约）
 *
 * 对应 docs/framework.md「核心数据契约」与「三维报告输出」：
 * - CaseSnapshot 是一次检测的不可变快照，含 versions 保证实验可复现与证据回放
 * - findings[].kind 区分 observed_fact / inference / reference，且全部带 evidenceIds
 *   ——程序化校验见 ./validate.ts，保证「每条结论都有可定位证据」
 * - originalAssessment 不被人工更正覆盖；人的结论单独存 ReviewEvent
 *
 * 本模块只定义结构与常量，不存储截图等大件内容本体（artifactIds 只存外部 id）。
 */

/** 风险判断：无法判断（unknown）是合法取值，不是失败态 */
export type RiskLevel = "high" | "suspicious" | "no_significant_risk" | "unknown"

/** 证据充分程度：非 sufficient 时应附 gaps 缺口清单 */
export type EvidenceSufficiency = "sufficient" | "partial" | "insufficient"

/** 检测覆盖中单个步骤的执行状态 */
export type StepState = "completed" | "partial" | "skipped" | "failed"

/** 人工复核事件的状态标记（由事件流计算，不另建审核库） */
export type ReviewStatus = "unmarked" | "pending" | "corrected" | "upheld"

/** 结论的证据等级：观察事实 / 风险推断 / 外部引用 */
export type FindingKind = "observed_fact" | "inference" | "reference"

export interface Finding {
  id: string
  /** 结论陈述（一句话） */
  statement: string
  kind: FindingKind
  /**
   * 引用的证据 id 列表——observed_fact 与 reference 至少 1 条；
   * inference 允许引用其他 finding id（推理链），两者都校验
   */
  evidenceIds: string[]
  /** 存在的合理替代解释（如"可能是已授权的第三方登录"），可为空数组 */
  alternativeExplanations: string[]
}

export interface EvidenceItem {
  id: string
  type:
    | "url"
    | "redirect"
    | "screenshot"
    | "text"
    | "form"
    | "request"
    | "reputation"
    | "knowledge"
  /** ISO 8601 采集时间 */
  capturedAt: string
  /** 采集方式，如 "playwright:page.screenshot" */
  source: string
  /** 指向具体位置的定位器：文本行号 / 截图区域 / 域名字符串 */
  locator?: string
  /** 内容摘录（截断） */
  excerpt?: string
}

/** 检测覆盖条目：每步骤状态 + 跳过/失败原因 */
export interface CoverageEntry {
  step: string
  state: StepState
  reason?: string
}

/** 三维报告中的前两维（风险判断 + 证据充分程度）及其依据 */
export interface Assessment {
  risk: RiskLevel
  evidenceSufficiency: EvidenceSufficiency
  /** 证据缺口说明，evidenceSufficiency 非 sufficient 时应非空 */
  gaps: string[]
  summary: string
  findings: Finding[]
  /** 无法确认的事项（如"该第三方登录是否获官方授权未知"） */
  unknowns: string[]
  recommendedAction: string
}

/** 版本谱系：保证同一快照可被复现与回放 */
export interface CaseVersions {
  reportSchema: string // 如 "1.0"
  model: string
  prompt: string
  policy: string
  knowledge: string
}

/** 一次检测的完整快照（本地 IndexedDB cases 存储区的记录形态） */
export interface CaseSnapshot {
  /** crypto.randomUUID() */
  id: string
  /** ISO 8601 创建时间 */
  createdAt: string
  inputSummary: { displayUrl: string; registrableDomain: string }
  versions: CaseVersions
  /** 机器原始判断：不被人工更正覆盖 */
  originalAssessment: Assessment
  /** 检测覆盖（第三维） */
  coverage: CoverageEntry[]
  evidence: EvidenceItem[]
  /** 引用的截图等大件的外部 id（本模块不存储内容本体） */
  artifactIds: string[]
}

/** 人工复核事件：只追加，不回填 originalAssessment */
export interface ReviewEvent {
  id: string
  caseId: string
  /** ISO 8601 创建时间 */
  createdAt: string
  action: "flag_false_positive" | "correct_assessment" | "uphold_assessment"
  reason: string
  /** 人工给出的风险判断（action=correct_assessment 时使用） */
  humanRisk?: RiskLevel
  actor: "local_user"
}

export const RISK_LEVELS: readonly RiskLevel[] = [
  "high",
  "suspicious",
  "no_significant_risk",
  "unknown",
]

export const EVIDENCE_SUFFICIENCIES: readonly EvidenceSufficiency[] = [
  "sufficient",
  "partial",
  "insufficient",
]

export const STEP_STATES: readonly StepState[] = [
  "completed",
  "partial",
  "skipped",
  "failed",
]

export const FINDING_KINDS: readonly FindingKind[] = [
  "observed_fact",
  "inference",
  "reference",
]

export const EVIDENCE_TYPES: readonly EvidenceItem["type"][] = [
  "url",
  "redirect",
  "screenshot",
  "text",
  "form",
  "request",
  "reputation",
  "knowledge",
]
