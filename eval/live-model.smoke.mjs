/** Two explicitly opted-in real calls, using sanitized fixtures only. Never prints credentials. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chat, visionChat } from "../lib/models.ts";

assert.ok(process.argv[2] === "--live" && process.argv[3] && process.argv[4], "Usage: node --experimental-strip-types --env-file=.env eval/live-model.smoke.mjs --live <fixture.png> <new-result.json>");
assert.ok(process.env.VERIPAGE_TEXT_MODEL === "deepseek-flash" && process.env.VERIPAGE_VISION_MODEL === "deepseek-flash", "This bounded smoke is for the configured DeepSeek Flash model");
assert.ok(process.env.VERIPAGE_MODEL_THINKING === "disabled", "Explicit non-thinking configuration is required for this smoke");
// Match production's JSON normalization: a Markdown fence is formatting, not a failed inference.
const parseJson = (content) => JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"));
const textPrompt = 'Return exactly this JSON object and nothing else: {"ok":true}';
const text = await chat([{ role: "user", content: textPrompt }], { maxTokens: 64, temperature: 0, signal: AbortSignal.timeout(45_000) });
console.log(JSON.stringify({ stage: "text", response: text.content, usage: text.usage ?? null }));
assert.ok(parseJson(text.content).ok === true, "Text completion must return the requested JSON");
const visionPrompt = "请读取图片中的蓝色标题，返回仅含 title 字段的 JSON 对象，不要推测，不要添加其他文字。";
const image = await readFile(process.argv[3]);
const vision = await visionChat(visionPrompt, image.toString("base64"), { maxTokens: 256, temperature: 0, signal: AbortSignal.timeout(45_000) });
console.log(JSON.stringify({ stage: "vision", response: vision.content, usage: vision.usage ?? null }));
const title = parseJson(vision.content).title;
assert.ok(typeof title === "string" && title.includes("网鉴") && title.includes("取证运行检查"), "Vision completion must read the actual Chinese fixture heading");
const result = {
  checkedAt: new Date().toISOString(), model: "deepseek-flash", thinking: "disabled", realInferenceCalls: 2,
  text: { prompt: textPrompt, response: text.content, usage: text.usage ?? null, passed: true },
  vision: { prompt: visionPrompt, fixture: "trusted-local-Chinese-runtime-fixture", response: vision.content, usage: vision.usage ?? null, passed: true },
  credentialValuesPrinted: false,
};
await writeFile(process.argv[4], JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify(result, null, 2));
