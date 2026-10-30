/**
 * W3 对照实验配置（判定口径与预算纪律，全部写死在这里，报告开头原样引用）
 *
 * 纪律（对应 P3 任务书「成本与稳定性纪律」与主会话补充要求 7）：
 * - 判定阈值在跑数据之前固定，全程一致，不允许跑完再挑有利阈值；
 * - 单组模型调用预算：默认 300 次文本 + 100 次视觉，超限即停并如实记录；
 * - 消融口径：去视觉 = fetcher 不产出截图（视觉闸自然 skipped）；
 *   去知识库 = 注入恒不命中的 kbLookup/ragSearch 桩（等价于知识库置空）。
 */

/** 检出判定：suspicious 及以上计为检出（high / suspicious = 检出） */
export const DETECT_LEVELS = ["suspicious", "high"];

/** 无法判定：模型显式输出 unknown（合法取值，不是失败态，单独统计） */
export const UNDECIDABLE_LEVEL = "unknown";

/** A 组（黑名单+规则）判定规则：黑名单命中 → high；任一静态规则 weight≥3 → suspicious；否则 → no_significant_risk */
export const GROUP_A_RULE = {
  blacklistRisk: "high",
  suspiciousMinWeight: 3,
  defaultRisk: "no_significant_risk",
};

/**
 * 简易黑名单（A 组用）：模拟真实产品中「已被威胁情报/用户上报收录」的已知恶意域。
 * 收录依据 = 数据集样本 JSON 的 blacklist 字段（6 个域），
 * 报告将单独给出「黑名单未命中样本」上的各组表现，防止「优势来自查黑名单」。
 */
export function blacklistHosts(samples) {
  return new Set(
    samples
      .filter((s) => s.blacklist === true)
      .map((s) => new URL(s.url).hostname.toLowerCase()),
  );
}

/** 单组预算上限（模型调用次数） */
export const DEFAULT_BUDGET = { text: 300, vision: 100 };

/** 单样本沙箱代访超时（ms）——比 lib/tools/fetch-page.ts 的 20s 总预算略宽，本地 fixture 无外部依赖 */
export const FETCH_TIMEOUT_MS = 15_000;

/** 五个实验组 */
export const GROUPS = {
  A: { label: "A 黑名单+规则", usesModel: false, note: "闸门①静态规则 + 简易黑名单，不调模型、不访问页面" },
  B: { label: "B 裸多模态模型", usesModel: true, note: "截图 + 页面正文直接问多模态模型是否钓鱼，无证据约束/知识库/修复轮" },
  C: { label: "C 完整 orchestrator", usesModel: true, note: "S0 放行桩 + 本地 fetcher + 全链路 orchestrator（知识库为真函数）" },
  "C-no-vision": { label: "C 消融·去视觉", usesModel: true, note: "fetcher 不产出截图 → 闸门③视觉自然 skipped，其余同 C" },
  "C-no-kb": { label: "C 消融·去知识库", usesModel: true, note: "注入恒不命中 kbLookup/ragSearch 桩（等价知识库置空），其余同 C" },
};

/** 类别中文名（报告用） */
export const CATEGORY_LABELS = {
  official: "正常官网",
  sso: "正常 SSO/授权登录",
  lookalike: "相似域名仿冒",
  visual: "视觉仿冒",
  incomplete: "验证码/失败页",
  injection: "提示注入页",
};

/** 类别期望语义：benign=期望 no_significant_risk；malicious=期望 suspicious 及以上；undecidable=期望 unknown */
export const CATEGORY_EXPECT = {
  official: "benign",
  sso: "benign",
  lookalike: "malicious",
  visual: "malicious",
  injection: "malicious",
  incomplete: "undecidable",
};

/** B 组裸模型提示词（无证据纪律、无知识库、无 URL/域名信息——只给截图与正文） */
export const BARE_MODEL_PROMPT = (pageText) => `你是网页安全审查员。给你一张待核验网页的截图与页面正文文本，请判断该网页是否为钓鱼/欺诈页面。
只依据截图与正文判断。不要假设任何额外信息。

页面正文文本：
<<<
${pageText || "（无正文）"}
>>>

请只输出一个 JSON 对象（无围栏、无解释）：
{"risk": "high" | "suspicious" | "no_significant_risk" | "unknown", "reason": "一句话理由"}
其中 unknown 表示依据不足以下结论。`;
