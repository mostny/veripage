// Agnes API 能力探测：文本 / 流式 / 工具调用 / 视觉输入
// 用法：node --env-file=.env eval/env-check.mjs
// 密钥只从环境变量读取，不硬编码。

const BASE = process.env.VERIPAGE_AGNES_BASE_URL;
const KEY = process.env.VERIPAGE_AGNES_API_KEY;
const MODEL = process.env.VERIPAGE_TEXT_MODEL || "agnes-2.5-flash";

if (!BASE || !KEY) {
  console.error("缺少 VERIPAGE_AGNES_BASE_URL / VERIPAGE_AGNES_API_KEY 环境变量");
  process.exit(1);
}

const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

async function call(body) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json, raw: text.slice(0, 400) };
}

// 1x1 红色像素 PNG
const RED_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const results = { model: MODEL, base: BASE };

// 1) 基础文本补全
try {
  const r = await call({ model: MODEL, messages: [{ role: "user", content: "回复两个字：正常" }], max_tokens: 20 });
  results.text = { status: r.status, ok: r.status === 200, reply: r.json?.choices?.[0]?.message?.content ?? r.raw };
} catch (e) { results.text = { ok: false, error: String(e) }; }

// 2) 流式 SSE
try {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "从1数到3" }], max_tokens: 20, stream: true }),
  });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const firstChunk = Buffer.from(value).toString("utf8").slice(0, 200);
  results.stream = { status: res.status, ok: res.ok && firstChunk.includes("data:"), firstChunk };
  await reader.cancel();
} catch (e) { results.stream = { ok: false, error: String(e) }; }

// 3) Function Calling
try {
  const r = await call({
    model: MODEL,
    messages: [{ role: "user", content: "北京今天天气如何？请调用工具查询" }],
    tools: [{
      type: "function",
      function: {
        name: "get_weather",
        description: "查询指定城市的实时天气",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    }],
    tool_choice: "auto",
    max_tokens: 200,
  });
  const msg = r.json?.choices?.[0]?.message;
  results.tools = {
    status: r.status,
    ok: !!msg?.tool_calls,
    tool_calls: msg?.tool_calls ?? null,
    fallback_content: msg?.content?.slice(0, 120) ?? r.raw,
  };
} catch (e) { results.tools = { ok: false, error: String(e) }; }

// 4) 视觉输入（image_url）
try {
  const r = await call({
    model: MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "这张1像素图片是什么颜色？一个词回答" },
        { type: "image_url", image_url: { url: RED_PIXEL } },
      ],
    }],
    max_tokens: 30,
  });
  const msg = r.json?.choices?.[0]?.message;
  results.vision = { status: r.status, ok: r.status === 200 && !!msg?.content, reply: msg?.content ?? r.raw };
} catch (e) { results.vision = { ok: false, error: String(e) }; }

console.log(JSON.stringify(results, null, 2));
