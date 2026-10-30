/**
 * 文本第二条线冒烟：AIGC 判定 + 隐私脱敏（全离线）
 * 运行：node eval/text-line.smoke.ts（Node 24 原生剥离 TS 类型）
 *
 * 纪律：
 * - 四类 PII 各至少 2 正例 1 负例，宁漏不错报的边界逐条断言
 * - AIGC 解析失败重试路径用可注入的假 chat 驱动，不发真实请求、不花真钱
 * - 路由 400/502 路径直接调用 POST 处理函数；模型端点用「假地址 + 桩 fetch」双保险
 *   （桩内的 API Key 是显而易见的假值，不是任何真实凭据）
 */
import { redactPii, PII_PLACEHOLDERS, REDACTION_NOTE } from "../lib/text/redact.ts";
import {
  AIGC_RETRY_HINT,
  AigcUnavailableError,
  CONFIDENCE_FLOOR,
  detectAigc,
  parseAigcVerdict,
  type ChatFn,
} from "../lib/text/aigc.ts";
import {
  TEXT_PROMPT_VERSION,
  buildTextAnalysisUserMessage,
  textAnalysisSystemPrompt,
} from "../lib/prompts/text.ts";
import { MAX_TEXT_LENGTH, POST } from "../app/api/text/route.ts";

let fail = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `（${extra}）` : ""}`);
};

// ---------------------------------------------------------------------------
// 1. 四类 PII：正例 / 负例 / 边界
// ---------------------------------------------------------------------------

// 两个校验位合法的身份证号（GB 11643 MOD 11-2）
const ID_VALID_1 = "11010519491231002X";
const ID_VALID_2 = "440305199003071236";
// 两个 Luhn 合法的银行卡号
const BANK_VALID_1 = "6210000000000003";
const BANK_VALID_2 = "6225880212100003";

const cases: Array<{ name: string; text: string; type: string; hit: boolean; original?: string }> = [
  // 身份证：正例
  { name: "身份证正例①", text: `证件号 ${ID_VALID_1} 请核对`, type: "id-card", hit: true, original: ID_VALID_1 },
  { name: "身份证正例②", text: `身份证号：${ID_VALID_2}。`, type: "id-card", hit: true, original: ID_VALID_2 },
  // 身份证：负例（校验位错 / 出生日期非法 / 长数字串内嵌）
  { name: "身份证负例·校验位错误", text: "证号 110105194912310021 错", type: "id-card", hit: false },
  { name: "身份证负例·出生日期非法", text: "证号 11010519491331002X 错", type: "id-card", hit: false },
  { name: "身份证负例·18位随机串", text: "单号 123456789012345678 结束", type: "id-card", hit: false },
  { name: "身份证负例·嵌在更长数字串中", text: `编号 99${ID_VALID_1} 结束`, type: "id-card", hit: false },
  // 手机号：正例
  { name: "手机号正例①", text: "联系 13800138000 即可", type: "phone", hit: true, original: "13800138000" },
  { name: "手机号正例②", text: "电话：15912345678。", type: "phone", hit: true, original: "15912345678" },
  // 手机号：负例（号段非法 / 位数不足 / 位数过多 / 嵌在数字串中）
  { name: "手机号负例·号段非法", text: "号码 12345678901 错", type: "phone", hit: false },
  { name: "手机号负例·位数不足", text: "号码 1380013800 错", type: "phone", hit: false },
  { name: "手机号负例·位数过多", text: "号码 138001380001 错", type: "phone", hit: false },
  { name: "手机号负例·嵌在数字串中", text: "串 213800138000 结束", type: "phone", hit: false },
  // 银行卡：正例
  { name: "银行卡正例①", text: `卡号 ${BANK_VALID_1} 收款`, type: "bank-card", hit: true, original: BANK_VALID_1 },
  { name: "银行卡正例②", text: `卡号：${BANK_VALID_2}。`, type: "bank-card", hit: true, original: BANK_VALID_2 },
  // 银行卡：负例（Luhn 不过 / 位数不足 / 15位一代证不误标）
  { name: "银行卡负例·Luhn不过", text: "卡号 6210000000000001 错", type: "bank-card", hit: false },
  { name: "银行卡负例·位数不足", text: "卡号 621000000000003 错", type: "bank-card", hit: false },
  { name: "银行卡负例·15位一代身份证", text: "老证 330102800101001 结束", type: "bank-card", hit: false },
  // 邮箱：正例
  { name: "邮箱正例①", text: "邮箱 test@example.com 回复", type: "email", hit: true, original: "test@example.com" },
  { name: "邮箱正例②", text: "邮箱：first.last+tag@sub.example.co.uk。", type: "email", hit: true, original: "first.last+tag@sub.example.co.uk" },
  // 邮箱：负例（无顶级域 / 内网无点分域名）
  { name: "邮箱负例·无顶级域", text: "邮箱 user@example 错", type: "email", hit: false },
  { name: "邮箱负例·内网无点分域名", text: "邮箱 a@localhost 结束", type: "email", hit: false },
];

for (const c of cases) {
  const r = redactPii(c.text);
  const hit = r.hits.find((h) => h.type === c.type);
  const ok = c.hit
    ? hit !== undefined &&
      c.original !== undefined &&
      // 位置区间对应原文切片（不是脱敏后文本——那里已被占位符替换）
      c.text.slice(hit.start, hit.end) === c.original &&
      !r.redactedText.includes(c.original) &&
      r.redactedText.includes(PII_PLACEHOLDERS[c.type as keyof typeof PII_PLACEHOLDERS])
    : hit === undefined && r.redactedText === c.text;
  check(
    `${c.name}（${c.hit ? "应命中" : "不应命中"}）`,
    ok,
    c.hit ? `命中区间 [${hit?.start}, ${hit?.end})` : `实际命中 ${r.hits.map((h) => h.type).join(",") || "无"}`,
  );
}

// 命中清单绝不回显原值（证据纪律：只给类型 + 位置区间）
{
  const mixed = `身份证 ${ID_VALID_1}，手机 13800138000，卡号 ${BANK_VALID_1}，邮箱 test@example.com。`;
  const r = redactPii(mixed);
  const serialized = JSON.stringify(r.hits);
  check(
    "混合文本四类全命中且原值不外泄",
    r.hits.length === 4 &&
      r.counts["id-card"] === 1 &&
      r.counts.phone === 1 &&
      r.counts["bank-card"] === 1 &&
      r.counts.email === 1 &&
      !serialized.includes(ID_VALID_1) &&
      !serialized.includes("13800138000") &&
      !serialized.includes(BANK_VALID_1) &&
      !serialized.includes("test@example.com") &&
      !r.redactedText.includes(ID_VALID_1) &&
      !r.redactedText.includes(BANK_VALID_1),
    `命中 ${r.hits.map((h) => `${h.type}[${h.start},${h.end})`).join(" ")}`,
  );
  check("命中区间半开且与原文切片对齐", r.hits.every((h) => mixed.slice(h.start, h.end).length === h.end - h.start));
  check("脱敏说明文案固定", r.note === REDACTION_NOTE);
}

// 18 位身份证即使碰巧过 Luhn 也不得被误标签成银行卡
{
  const idLikeBank = "11010519491231002X";
  const r = redactPii(`证号 ${idLikeBank} 卡号 ${BANK_VALID_1}`);
  check(
    "身份证与银行卡同场不串标签",
    r.counts["id-card"] === 1 && r.counts["bank-card"] === 1,
    JSON.stringify(r.counts),
  );
}

// 空输入 / 无敏感信息输入
{
  const empty = redactPii("");
  check("空文本返回空结果", empty.hits.length === 0 && empty.redactedText === "");
  const clean = redactPii("今天天气不错，适合出门散步。");
  check("无敏感信息文本零命中", clean.hits.length === 0 && clean.redactedText === "今天天气不错，适合出门散步。");
}

// ---------------------------------------------------------------------------
// 2. AIGC 提示词契约（caveats 必填、禁确定性断言、抗注入）
// ---------------------------------------------------------------------------

{
  const sys = textAnalysisSystemPrompt();
  check("提示词含输出 schema 四字段", ["isAigc", "confidence", "signals", "caveats"].every((k) => sys.includes(k)));
  check("提示词强制 caveats 非空", sys.includes("必须为非空"));
  check("提示词禁止确定性断言", sys.includes("禁止确定性断言") && sys.includes("这是 AI 写的"));
  check("提示词要求低置信度不得拔高", sys.includes("不得为了给出结论而拔高"));
  check("提示词含不可信数据与注入纪律", sys.includes("不可信数据") && sys.includes("提示注入"));
  check("提示词含短样本无法判定纪律", sys.includes("样本不足，无法判定"));
  check("提示词版本号格式", /^\d+\.\d+\.\d+$/.test(TEXT_PROMPT_VERSION));
  const user = buildTextAnalysisUserMessage("一段待检测文本");
  check("user 消息用围栏包裹不可信文本", user.includes("<<<") && user.includes("一段待检测文本") && user.includes("不可信数据"));
}

// ---------------------------------------------------------------------------
// 3. AIGC 解析 / 重试路径（假 chat，离线）
// ---------------------------------------------------------------------------

const GOOD_JSON = JSON.stringify({ isAigc: true, confidence: 0.82, signals: ["句式过于均衡"], caveats: ["短样本存在不确定性"] });
const GARBAGE = "抱歉，我不能完成这个任务。";

function fakeChat(responses: string[]): { fn: ChatFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: ChatFn = async (messages) => {
    calls.push(messages.map((m) => (typeof m.content === "string" ? m.content : "[多模态]")));
    const content = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { content, toolCalls: [] };
  };
  return { fn, calls };
}

{
  // 解析器：围栏 / 前后废话 / 坏结构
  check("解析围栏 JSON", parseAigcVerdict(`\`\`\`json\n${GOOD_JSON}\n\`\`\``)?.isAigc === true);
  check("解析带前后废话的 JSON", parseAigcVerdict(`好的，结果如下：\n${GOOD_JSON}\n以上。`)?.isAigc === true);
  check("解析拒绝非对象 JSON", parseAigcVerdict("[1,2,3]") === null);
  check("解析拒绝缺 caveats", parseAigcVerdict(JSON.stringify({ isAigc: true, confidence: 0.5, signals: [], caveats: [] })) === null);
  check("解析拒绝 isAigc 非布尔", parseAigcVerdict(JSON.stringify({ isAigc: "yes", confidence: 0.5, signals: [], caveats: ["x"] })) === null);
  check("解析拒绝置信度越界", parseAigcVerdict(JSON.stringify({ isAigc: true, confidence: 500, signals: [], caveats: ["x"] })) === null);
  check("解析接受百分制置信度", parseAigcVerdict(JSON.stringify({ isAigc: true, confidence: 82, signals: [], caveats: ["x"] }))?.confidence === 0.82);
  check("解析拒绝纯文本", parseAigcVerdict(GARBAGE) === null);
}

{
  // 一次成功
  const { fn, calls } = fakeChat([GOOD_JSON]);
  const v = await detectAigc("一段文本", { chat: fn });
  check("一次成功：字段与结论", v.isAigc === true && v.confidence === 0.82 && v.conclusion === "likely_aigc" && v.repaired === false && v.caveats.length === 1);
  check("一次成功：只调用一次", calls.length === 1);
  check("一次成功：带提示词版本", v.promptVersion === TEXT_PROMPT_VERSION);
}

{
  // 首次乱码 → 纠偏重试 → 成功
  const { fn, calls } = fakeChat([GARBAGE, GOOD_JSON]);
  const v = await detectAigc("一段文本", { chat: fn });
  check("纠偏重试后成功且标记 repaired", v.isAigc === true && v.repaired === true);
  check("纠偏重试共两次调用", calls.length === 2);
  check("第二次调用附带纠偏提示", calls[1][calls[1].length - 1] === AIGC_RETRY_HINT && AIGC_RETRY_HINT.includes("caveats"));
}

{
  // 两次都乱码 → 抛错，绝不默认「人类所写」
  const { fn, calls } = fakeChat([GARBAGE, GARBAGE]);
  let thrown: unknown;
  try {
    await detectAigc("一段文本", { chat: fn });
  } catch (err) {
    thrown = err;
  }
  check("两次解析失败抛 AigcUnavailableError", thrown instanceof AigcUnavailableError && calls.length === 2);
  check(
    "失败信息明确且不含默认判定",
    thrown instanceof Error && thrown.message.includes("两次") && thrown.message.includes("不会") && !/是人类写的/.test(thrown.message),
  );
}

{
  // caveats 缺失同样走重试后失败（契约：必须带 caveats）
  const noCaveats = JSON.stringify({ isAigc: true, confidence: 0.9, signals: ["x"], caveats: [] });
  const { fn } = fakeChat([noCaveats, noCaveats]);
  let thrown: unknown;
  try {
    await detectAigc("一段文本", { chat: fn });
  } catch (err) {
    thrown = err;
  }
  check("缺 caveats 视为无效输出并最终失败", thrown instanceof AigcUnavailableError);
}

{
  // 低置信度 → undetermined
  const low = JSON.stringify({ isAigc: false, confidence: 0.3, signals: [], caveats: ["样本不足，无法判定"] });
  const { fn } = fakeChat([low]);
  const v = await detectAigc("短文本", { chat: fn });
  check(`低置信度结论为无法判定（阈值 ${CONFIDENCE_FLOOR}）`, v.conclusion === "undetermined");
}

{
  // 模型调用本身失败 → 包装成 AigcUnavailableError
  const boom: ChatFn = async () => {
    throw new Error("Agnes 返回 HTTP 500：upstream error");
  };
  let thrown: unknown;
  try {
    await detectAigc("一段文本", { chat: boom });
  } catch (err) {
    thrown = err;
  }
  check("模型调用失败被明确包装", thrown instanceof AigcUnavailableError && thrown.message.includes("模型调用失败"));
}

// ---------------------------------------------------------------------------
// 4. 路由契约：400 校验 / 200 全链路 / 502 明确失败
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, raw?: string): Request {
  return new Request("http://127.0.0.1:3000/api/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

async function callRoute(body: unknown, raw?: string): Promise<Response> {
  return POST(makeRequest(body, raw));
}

{
  const bad = await callRoute(null, "{ 不是 JSON");
  check("非 JSON 请求体 → 400", bad.status === 400);
  const missing = await callRoute({});
  check("缺 text 参数 → 400", missing.status === 400);
  const blank = await callRoute({ text: "   " });
  check("空白 text → 400", blank.status === 400);
  const wrongType = await callRoute({ text: 123 });
  check("text 非字符串 → 400", wrongType.status === 400);

  const over = await callRoute({ text: "a".repeat(MAX_TEXT_LENGTH + 1) });
  const overBody = (await over.json()) as { error?: string };
  check(
    `超过 ${MAX_TEXT_LENGTH} 字符 → 400 且错误明确`,
    over.status === 400 && typeof overBody.error === "string" && overBody.error.includes(String(MAX_TEXT_LENGTH)),
    overBody.error,
  );
  const exact = await callRoute({ text: "a".repeat(MAX_TEXT_LENGTH) });
  // 恰好等于上限：不应被长度拦（此处无模型桩，预期走到 502，但绝不是 400）
  check("恰好等于上限不被长度拦截", exact.status !== 400, `实际 HTTP ${exact.status}`);
}

// --- 带桩 fetch 的全链路（不发任何真实请求） ---
const realFetch = globalThis.fetch;
const savedBase = process.env.VERIPAGE_AGNES_BASE_URL;
const savedKey = process.env.VERIPAGE_AGNES_API_KEY;
const savedModel = process.env.VERIPAGE_TEXT_MODEL;
// 假端点 + 假 Key：即使桩失效也只会连本地拒绝端口，不外泄任何真实凭据
process.env.VERIPAGE_AGNES_BASE_URL = "http://127.0.0.1:1/v1";
process.env.VERIPAGE_AGNES_API_KEY = "smoke-fake-key-not-a-real-credential";
delete process.env.VERIPAGE_TEXT_MODEL;

const modelBodies: string[] = [];
/** 桩按调用序号返回的模型输出；每个测试场景自行设置 */
let modelResponses: string[] = [GARBAGE];
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.body) modelBodies.push(String(init.body));
  const payload = modelResponses[Math.min(modelBodies.length - 1, modelResponses.length - 1)];
  return new Response(
    JSON.stringify({ choices: [{ message: { content: payload }, finish_reason: "stop" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;

try {
  {
    // 200 全链路：模型首次乱码、纠偏后成功；脱敏本地完成
    modelBodies.length = 0;
    modelResponses = [GARBAGE, GOOD_JSON];
    const res = await callRoute({ text: "联系电话 13800138000，邮箱 test@example.com。" });
    const body = (await res.json()) as {
      aigc?: { isAigc: boolean; conclusion: string; repaired: boolean; caveats: string[] };
      redaction?: { redactedText: string; hits: Array<{ type: string }>; note: string };
    };
    check(
      "200：AIGC + 脱敏全链路",
      res.status === 200 &&
        body.aigc?.isAigc === true &&
        body.aigc?.conclusion === "likely_aigc" &&
        body.aigc?.repaired === true &&
        body.aigc?.caveats.length > 0 &&
        body.redaction?.hits.length === 2 &&
        !body.redaction?.redactedText.includes("13800138000") &&
        !body.redaction?.redactedText.includes("test@example.com") &&
        body.redaction?.redactedText.includes("[手机号已脱敏]") &&
        body.redaction?.redactedText.includes("[邮箱已脱敏]"),
      `命中 ${body.redaction?.hits.map((h) => h.type).join(",")}`,
    );
    check("发给模型的 system 提示含 caveats 契约", modelBodies.length === 2 && JSON.parse(modelBodies[0]).messages[0].content.includes("caveats"));
  }
  {
    // 两次都乱码 → 502 明确错误（不许静默返回人类所写）
    modelBodies.length = 0;
    modelResponses = [GARBAGE, GARBAGE];
    const res = await callRoute({ text: "一段足够长的普通文本，用于触发两次解析失败的场景。" });
    const body = (await res.json()) as { error?: string };
    check(
      "502：两次解析失败返回明确错误",
      res.status === 502 && typeof body.error === "string" && body.error.includes("两次") && body.error.includes("无法解析"),
      body.error,
    );
    check("502 场景实际发起两次模型调用", modelBodies.length === 2);
  }
} finally {
  globalThis.fetch = realFetch;
  if (savedBase === undefined) delete process.env.VERIPAGE_AGNES_BASE_URL;
  else process.env.VERIPAGE_AGNES_BASE_URL = savedBase;
  if (savedKey === undefined) delete process.env.VERIPAGE_AGNES_API_KEY;
  else process.env.VERIPAGE_AGNES_API_KEY = savedKey;
  if (savedModel === undefined) delete process.env.VERIPAGE_TEXT_MODEL;
  else process.env.VERIPAGE_TEXT_MODEL = savedModel;
}

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
