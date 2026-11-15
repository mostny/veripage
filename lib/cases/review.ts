import { RISK_LEVELS, type ReviewEvent, type ReviewStatus } from "../evidence/types";

export const MAX_REVIEW_REASON_LENGTH = 1000;
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  unmarked: "未标记",
  pending: "待复核",
  corrected: "已更正",
  upheld: "维持原判",
};
export const REVIEW_ACTION_LABELS: Record<ReviewEvent["action"], string> = {
  flag_false_positive: "标记待复核",
  correct_assessment: "保存个人更正",
  uphold_assessment: "维持原判",
};

export class ReviewConflictError extends Error {
  constructor() {
    super("复核状态已变化，请重新读取记录并确认后再提交。");
    this.name = "ReviewConflictError";
  }
}

/** Input boundary shared by local commands and the upcoming case-package reader. */
export function assertReviewEvent(event: unknown): asserts event is ReviewEvent {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("复核记录结构无效");
  const value = event as Record<string, unknown>;
  for (const field of ["id", "caseId"] as const) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) throw new Error("复核记录缺少有效编号");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) throw new Error("复核时间无效");
  if (typeof value.reason !== "string" || value.reason.trim().length === 0 || value.reason.length > MAX_REVIEW_REASON_LENGTH) throw new Error("请填写有效复核理由（最多 1000 字符）");
  if (value.actor !== "local_user") throw new Error("复核记录只能是本机使用者意见");
  if (typeof value.action !== "string" || !["flag_false_positive", "correct_assessment", "uphold_assessment"].includes(value.action)) throw new Error("复核操作无效");
  if (value.action === "correct_assessment") {
    if (!RISK_LEVELS.some((risk) => risk === value.humanRisk)) throw new Error("个人更正必须选择有效风险判断");
  } else if (value.humanRisk !== undefined) throw new Error("标记或维持原判不能写入个人风险判断");
}

/** The repository supplies commit order; timestamps are display data, not ordering keys. */
export function reviewStatus(events: readonly ReviewEvent[]): ReviewStatus {
  const last = events.at(-1);
  if (!last) return "unmarked";
  if (last.action === "flag_false_positive") return "pending";
  return last.action === "correct_assessment" ? "corrected" : "upheld";
}

export function latestResolution(events: readonly ReviewEvent[]): ReviewEvent | undefined {
  return events.findLast((event) => event.action !== "flag_false_positive");
}

export function assertReviewTransition(status: ReviewStatus, action: ReviewEvent["action"]): void {
  if (action === "flag_false_positive" ? status === "pending" : status !== "pending") throw new ReviewConflictError();
}
