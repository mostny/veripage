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

// 64x64 不透明纯红 PNG（RGB 色类型 2，无 alpha 通道）。
// 历史教训：此前用 1x1 RGBA 图且 alpha=127（50% 半透明），白底合成后呈粉色，
// step-5-preview 稳定答「粉色」导致「回复含红」断言随机失败。视觉断言必须考核
// 识别能力，不能受图片本身的透明度歧义影响——故用不透明纯红图，断言不变。
const RED_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";

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
// 说明：step-5-preview 是推理模型，会先花掉一部分 token 产 reasoning_content。
// 64 token 实测偶发被推理吃光后截断（finish=length、content="1+"），
// 因此这里与其余用例统一给足预算，让断言考核指令遵循而非截断。
try {
  const opts: ChatOptions = { maxTokens: 512 };
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
    { maxTokens: 512 },
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
  // step-5-preview 是推理模型：maxTokens=64 时整个预算被 reasoning_content 吃光
  // （实测 finish=length、content=""、reasoning_content 107 字符），视觉断言根本没机会执行。
  // 给足预算，让「回复含红」真正考核视觉识别能力，而不是考核截断。
  const r = await visionChat("这张图是什么颜色？一个词", RED_PIXEL_BASE64, {
    maxTokens: 512,
  });
  console.log(
    `[vision] content=${JSON.stringify(r.content)} finish=${r.finishReason ?? "-"} usage=${JSON.stringify(r.usage ?? null)}`,
  );
  check("content 非空", r.content.trim().length > 0);
  check('回复含 "红"', r.content.includes("红"), JSON.stringify(r.content.slice(0, 80)));
} catch (e) {
  console.log(`[vision] 异常：${e instanceof Error ? e.message : String(e)}`);
  check("vision 调用成功", false);
}

console.log(fail === 0 ? "ALL-PASS" : `FAIL(${fail})`);
process.exit(fail === 0 ? 0 : 1);
