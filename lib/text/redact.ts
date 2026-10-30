/**
 * 本地正则脱敏（四类 PII，不过模型）
 *
 * 设计纪律（任务书 P2 §2）：宁漏不错报——误伤一个正常数字串比漏一个更伤可信度。
 * 因此每类都配「结构校验」，不是只数位数：
 *   - 身份证号：18 位 + 出生日期合法 + GB 11643 校验位（ISO 7064 MOD 11-2）
 *   - 手机号：11 位 + 号段 1[3-9] + 前后不得再接数字/字母
 *   - 银行卡号：16–19 位 + Luhn 校验；18 位且结构像身份证的一律跳过（避免误标签）
 *   - 邮箱：标准三段式 + 顶级域至少 2 个字母
 *
 * 已知漏检边界（UI 已提示「外发前请人工复核」，此处如实记录，不假装全覆盖）：
 *   - 15 位一代身份证、15 位 Amex 卡
 *   - 带空格/连字符分组的卡号（如 6222 0212 3456 7890）
 *   - 内部网络邮箱（user@localhost，无点分域名）
 *   - 校验位笔误的真实身份证（宁漏不错报的代价）
 *
 * 输出契约：命中清单只含「类型 + 位置区间 [start, end)」，绝不回显原值；
 * 替换只发生在返回给用户的文本里，不声称删除任何服务端数据。
 */

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

export type PiiType = "id-card" | "phone" | "bank-card" | "email";

/** 脱敏占位符（任务书 §2：命中即替换为「[身份证已脱敏]」等） */
export const PII_PLACEHOLDERS: Record<PiiType, string> = {
  "id-card": "[身份证已脱敏]",
  phone: "[手机号已脱敏]",
  "bank-card": "[银行卡已脱敏]",
  email: "[邮箱已脱敏]",
};

/** 展示名（命中清单用） */
export const PII_LABELS: Record<PiiType, string> = {
  "id-card": "身份证号",
  phone: "手机号",
  "bank-card": "银行卡号",
  email: "邮箱",
};

/** UI 固定提示：正则匹配的事实级边界 */
export const REDACTION_NOTE = "正则匹配，可能存在漏检/误报，敏感信息外发前请人工复核";

/** 命中区间：半开区间 [start, end)，与 String.prototype.slice 对齐 */
export interface PiiHit {
  type: PiiType;
  label: string;
  start: number;
  end: number;
}

export interface RedactionResult {
  /** 脱敏后的文本（仅此副本被替换，原始输入不做任何持久化） */
  redactedText: string;
  /** 命中清单：类型 + 位置区间，不含原值 */
  hits: PiiHit[];
  /** 各类型命中计数（四类齐全，便于 UI 展示 0 值） */
  counts: Record<PiiType, number>;
  note: string;
}

interface Candidate {
  type: PiiType;
  start: number;
  end: number;
}

/** 重叠消解优先级：数字小的赢。身份证优先于银行卡（18 位会被两类同时看上） */
const TYPE_PRIORITY: Record<PiiType, number> = {
  "id-card": 0,
  "bank-card": 1,
  phone: 2,
  email: 3,
};

// ---------------------------------------------------------------------------
// 校验原语
// ---------------------------------------------------------------------------

/** 身份证加权因子与校验码表（GB 11643 / ISO 7064 MOD 11-2） */
const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK_CHARS = "10X98765432";

function isValidIdCardChecksum(digits18: string): boolean {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    sum += Number(digits18[i]) * ID_WEIGHTS[i];
  }
  const expected = ID_CHECK_CHARS[sum % 11];
  return digits18[17].toUpperCase() === expected;
}

/** 出生日期段（第 7–14 位）是否为真实存在的日期 */
function isPlausibleBirthdate(digits18: string): boolean {
  const year = Number(digits18.slice(6, 10));
  const month = Number(digits18.slice(10, 12));
  const day = Number(digits18.slice(12, 14));
  if (year < 1900 || year > 2099) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/**
 * 结构像身份证（不验校验位）：行政区划 6 位 + 合法出生日期。
 * 银行卡检测用它排除「校验位笔误的身份证」被误标签成银行卡。
 */
function looksLikeIdCardStructure(digits18: string): boolean {
  return isPlausibleBirthdate(digits18);
}

/** Luhn 校验（银行卡行业标准） */
function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// 四类检测器（返回候选区间，重叠消解在外层）
// ---------------------------------------------------------------------------

const ID_CARD_RE = /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g;
const PHONE_RE = /(?<![\dA-Za-z])1[3-9]\d{9}(?![\dA-Za-z])/g;
const BANK_CARD_RE = /(?<![\dA-Za-z])(\d{16,19})(?![\dA-Za-z])/g;
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

function findIdCards(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(ID_CARD_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    // 宁漏不错报：结构 + 校验位双重确认才算命中
    if (isPlausibleBirthdate(raw) && isValidIdCardChecksum(raw)) {
      out.push({ type: "id-card", start, end: start + raw.length });
    }
  }
  return out;
}

function findPhones(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const start = m.index ?? 0;
    out.push({ type: "phone", start, end: start + m[0].length });
  }
  return out;
}

function findBankCards(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(BANK_CARD_RE)) {
    const raw = m[0];
    const start = m.index ?? 0;
    // 18 位且结构像身份证（出生日期段合法）：更可能是身份证，交给身份证检测器裁决，
    // 避免把身份证误标签成银行卡（即使它碰巧过 Luhn）
    if (raw.length === 18 && looksLikeIdCardStructure(raw)) continue;
    if (isLuhnValid(raw)) {
      out.push({ type: "bank-card", start, end: start + raw.length });
    }
  }
  return out;
}

function findEmails(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const start = m.index ?? 0;
    out.push({ type: "email", start, end: start + m[0].length });
  }
  return out;
}

/** 按优先级消解重叠区间：优先级高的先占位，后到的重叠候选直接丢弃 */
function resolveOverlaps(candidates: Candidate[]): Candidate[] {
  const sorted = [...candidates].sort((a, b) => {
    const p = TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
    return p !== 0 ? p : a.start - b.start;
  });
  const taken: Candidate[] = [];
  for (const c of sorted) {
    const clash = taken.some((t) => c.start < t.end && t.start < c.end);
    if (!clash) taken.push(c);
  }
  return taken.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 对一段文本做四类 PII 脱敏。
 * 纯函数、无 IO、无网络——路由与冒烟测试都直接复用它。
 */
export function redactPii(text: string): RedactionResult {
  const counts: Record<PiiType, number> = { "id-card": 0, phone: 0, "bank-card": 0, email: 0 };
  if (typeof text !== "string" || text.length === 0) {
    return { redactedText: "", hits: [], counts, note: REDACTION_NOTE };
  }

  const selected = resolveOverlaps([
    ...findIdCards(text),
    ...findPhones(text),
    ...findBankCards(text),
    ...findEmails(text),
  ]);

  // 从后往前替换，避免前面的替换移动后面区间的下标
  let redactedText = text;
  const hits: PiiHit[] = [];
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    const c = selected[i];
    redactedText = redactedText.slice(0, c.start) + PII_PLACEHOLDERS[c.type] + redactedText.slice(c.end);
    counts[c.type] += 1;
    hits.unshift({ type: c.type, label: PII_LABELS[c.type], start: c.start, end: c.end });
  }

  return { redactedText, hits, counts, note: REDACTION_NOTE };
}
