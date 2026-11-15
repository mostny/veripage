/** One-time, user-authorized import of the active DeepSeek connection. Never prints credentials. */
import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";

let stage = "读取已授权的 DeepSeek 连接";
try {
  const rows = JSON.parse(execFileSync("opencode", ["auth", "export", "deepseek", "--log-level", "none"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }));
  const active = rows.filter((row) => row.integrationID === "deepseek" && row.active);
  if (active.length !== 1 || active[0].value?.type !== "key" || !active[0].value.key) throw new Error();
  const key = active[0].value.key;
  const headers = { Authorization: `Bearer ${key}` };
  stage = "验证官方端点鉴权与模型能力";
  const models = await fetch("https://api.deepseek.com/models", { headers, signal: AbortSignal.timeout(30_000) });
  const catalog = await models.json();
  if (!models.ok || !catalog.data.some((model) => model.id === "deepseek-flash")) throw new Error();
  stage = "验证余额可用状态";
  const balance = await fetch("https://api.deepseek.com/user/balance", { headers, signal: AbortSignal.timeout(30_000) });
  const account = await balance.json();
  if (!balance.ok || account.is_available !== true) throw new Error();
  stage = "写入项目私密运行配置";
  let contents = await readFile(".env", "utf8");
  const values = {
    VERIPAGE_AGNES_BASE_URL: "https://api.deepseek.com",
    VERIPAGE_AGNES_API_KEY: key,
    VERIPAGE_TEXT_MODEL: "deepseek-flash",
    VERIPAGE_VISION_MODEL: "deepseek-flash",
    VERIPAGE_MODEL_THINKING: "disabled",
  };
  for (const [name, value] of Object.entries(values)) {
    // Escape dotenv expansion as well as quotes/newlines without exposing the value in argv/logs.
    const line = `${name}=${JSON.stringify(value).replace(/\$/g, "\\$")}`;
    const pattern = new RegExp(`^${name}=.*$`, "m");
    contents = pattern.test(contents) ? contents.replace(pattern, () => line) : `${contents.trimEnd()}\n${line}\n`;
  }
  await writeFile(".env", contents);
  await chmod(".env", 0o600);
  console.log(JSON.stringify({ provider: "deepseek", endpoint: "https://api.deepseek.com", textModel: "deepseek-flash", visionModel: "deepseek-flash", thinking: "disabled", credentialsPrinted: false, inferenceCalls: 0 }));
} catch {
  console.error(`DeepSeek 接入失败（${stage}）；未输出凭据或原始错误，请核对活动连接及项目配置。`);
  process.exitCode = 1;
}
