/** Offline model options regression. Run: node --experimental-strip-types eval/model-options.smoke.ts */
import assert from "node:assert/strict";
import { chat, chatStream } from "../lib/models.ts";
import type { ChatMessage, ChatOptions } from "../lib/models.ts";

const envNames = [
  "VERIPAGE_AGNES_BASE_URL",
  "VERIPAGE_AGNES_API_KEY",
  "VERIPAGE_TEXT_MODEL",
  "VERIPAGE_MODEL_THINKING",
] as const;
const savedEnv = new Map(envNames.map((name) => [name, process.env[name]]));
const savedFetch = globalThis.fetch;
// This endpoint exists only in fake fetch: no sockets or real network are used.
const endpoint = "http://127.0.0.1:1/chat/completions";
const requests: Record<string, unknown>[] = [];
let refuse = false;

try {
  process.env.VERIPAGE_AGNES_BASE_URL = "http://127.0.0.1:1";
  process.env.VERIPAGE_AGNES_API_KEY = "offline-fixture-key";
  process.env.VERIPAGE_TEXT_MODEL = "offline-fixture-model";
  globalThis.fetch = async (input, init) => {
    assert.equal(input, endpoint);
    assert.ok(init);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer offline-fixture-key");
    assert.equal(typeof init.body, "string");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    requests.push(body);
    if (refuse) return new Response("offline fixture denied; credential=offline-fixture-key", { status: 403 });
    if (body.stream) {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    }
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
  };

  const messages: ChatMessage[] = [{ role: "user", content: "offline fixture" }];
  const opts: ChatOptions = {
    temperature: 0,
    maxTokens: 32,
    tools: [{ type: "function", function: { name: "fixture", description: "fixture", parameters: {} } }],
  };
  const expected = {
    model: "offline-fixture-model",
    messages,
    stream: false,
    temperature: 0,
    max_tokens: 32,
    tools: opts.tools,
    tool_choice: "auto",
  };

  for (const thinking of [undefined, "", "   ", "enabled", "disabled"]) {
    if (thinking === undefined) delete process.env.VERIPAGE_MODEL_THINKING;
    else process.env.VERIPAGE_MODEL_THINKING = thinking;
    assert.equal((await chat(messages, opts)).content, "ok");
    assert.deepEqual(requests.at(-1), {
      ...expected,
      ...(thinking?.trim() ? { thinking: { type: thinking } } : {}),
    });
  }
  console.log("PASS unset/empty/enabled/disabled preserve model, temperature, max_tokens and tools");

  process.env.VERIPAGE_MODEL_THINKING = "disabled";
  const streamEvents = [];
  for await (const event of chatStream(messages, opts)) streamEvents.push(event);
  assert.deepEqual(requests.at(-1), { ...expected, stream: true, thinking: { type: "disabled" } });
  assert.deepEqual(streamEvents.map((event) => event.type), ["delta", "done"]);
  console.log("PASS stream uses shared thinking option without changing SSE behavior");

  // A mocked local refusing endpoint exercises HTTP failures, still without network.
  refuse = true;
  await assert.rejects(chat(messages, opts), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 403.*offline fixture denied/);
    assert.ok(error.message.includes("[REDACTED]") && !error.message.includes("offline-fixture-key"));
    return true;
  });
  console.log("PASS upstream errors cannot expose the configured model credential");
  const countBeforeInvalid = requests.length;
  process.env.VERIPAGE_MODEL_THINKING = "invalid-fixture-secret";
  const validateError = (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "VERIPAGE_MODEL_THINKING 配置无效：仅允许 enabled 或 disabled（也可留空）。");
    assert.ok(!error.message.includes("invalid-fixture-secret"));
    return true;
  };
  await assert.rejects(chat(messages, opts), validateError);
  await assert.rejects(chatStream(messages, opts).next(), validateError);
  assert.equal(requests.length, countBeforeInvalid);
  console.log("PASS invalid config fails before fetch without echoing its value; mocked HTTP refusal is surfaced");
} finally {
  globalThis.fetch = savedFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

assert.equal(globalThis.fetch, savedFetch);
for (const [name, value] of savedEnv) assert.equal(process.env[name], value);
console.log("ALL-PASS (fetch and env restored; zero network calls)");
