/**
 * Agnes API 适配层冒烟测试（lib/models.ts）
 * 运行：node --env-file=.env eval/models.smoke.ts
 *
 * 四项用例对应 docs/model-notes.md 的实测能力矩阵：
 *   1. chat        非流式文本
 *   2. chatStream  流式 SSE（跨网络块缓冲 + 增量文本）
 *   3. chat tools  Function Calling（tool_calls 解析）
 *   4. visionChat  image_url 视觉输入
 */
import {
  assertModelConfig,
  chat,
  chatStream,
  visionChat,
} from "../lib/models.ts";
import type { ChatOptions, ToolDef } from "../lib/models.ts";

// 1x1 红色像素 PNG
const RED_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const getWeatherTool: ToolDef = {
  type: "function",
  function: {
    name: "get_weather",
    description: "查询指定城市的实时天气",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "城市名，如：北京" } },
      required: ["city"],
    },
  },
};

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fail += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` | ${detail}` : ""}`);
};

// 配置校验：缺失时快速失败并给出修复说明
assertModelConfig();

// --- 用例 1：chat 非流式文本 ---
try {
  const opts: ChatOptions = { maxTokens: 64 };
  const r = await chat([{ role: "user", content: "用一句话回答：1+1等于几？" }], opts);
  console.log(`[chat] content=${JSON.stringify(r.content)} finish=${r.finishReason ?? "-"} usage=${JSON.stringify(r.usage ?? null)} toolCalls=${r.toolCalls.length}`);
  check("content 非空", r.content.trim().length > 0);
  check('content 含 "2"', r.content.includes("2"), JSON.stringify(r.content.slice(0, 80)));
} catch (e) {
  console.log(`[chat] 异常：${e instanceof Error ? e.message : String(e)}`);
  check("chat 调用成功", false);
}

// --- 用例 2：chatStream 流式 ---
try {
  let text = "";
  let deltaCount = 0;
  let finishReason: string | undefined;
  for await (const ev of chatStream(
    [{ role: "user", content: "从1数到5" }],
    { maxTokens: 128 },
  )) {
    if (ev.type === "delta") {
      deltaCount += 1;
      text += ev.text;
    } else if (ev.type === "done") {
      finishReason = ev.finishReason;
    }
  }
  console.log(`[chatStream] deltas=${deltaCount} text=${JSON.stringify(text)} finish=${finishReason ?? "-"}`);
  check("delta 事件 ≥2", deltaCount >= 2, `实际 ${deltaCount}`);
  check('拼接文本含 "3"', text.includes("3"), JSON.stringify(text.slice(0, 80)));
} catch (e) {
  console.log(`[chatStream] 异常：${e instanceof Error ? e.message : String(e)}`);
  check("chatStream 调用成功", false);
}

// --- 用例 3：tools Function Calling ---
try {
  const r = await chat(
    [{ role: "user", content: "北京今天天气如何？请调用工具" }],
    { tools: [getWeatherTool], maxTokens: 256 },
  );
  const call = r.toolCalls[0];
  console.log(`[tools] toolCalls=${JSON.stringify(r.toolCalls)} content=${JSON.stringify(r.content.slice(0, 80))}`);
  check("toolCalls[0].name === get_weather", call?.name === "get_weather", call?.name ?? "(无)");
  let city = "";
  let parsed = false;
  try {
    const args = JSON.parse(call?.arguments ?? "{}") as { city?: string };
    city = args.city ?? "";
    parsed = true;
  } catch {
    parsed = false;
  }
  check("arguments 可解析为 JSON", parsed, call?.arguments?.slice(0, 80) ?? "(无)");
  check('city 含 "北京"', city.includes("北京"), city || "(无)");
} catch (e) {
  console.log(`[tools] 异常：${e instanceof Error ? e.message : String(e)}`);
  check("tools 调用成功", false);
}

// --- 用例 4：vision 视觉输入 ---
try {
  const r = await visionChat("这张图是什么颜色？一个词", RED_PIXEL_BASE64, {
    maxTokens: 64,
  });
  console.log(`[vision] content=${JSON.stringify(r.content)} usage=${JSON.stringify(r.usage ?? null)}`);
  check("content 非空", r.content.trim().length > 0);
  check('回复含 "红"', r.content.includes("红"), JSON.stringify(r.content.slice(0, 80)));
} catch (e) {
  console.log(`[vision] 异常：${e instanceof Error ? e.message : String(e)}`);
  check("vision 调用成功", false);
}

console.log(fail === 0 ? "ALL-PASS" : `FAIL(${fail})`);
process.exit(fail === 0 ? 0 : 1);
