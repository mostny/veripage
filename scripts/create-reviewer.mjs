/** Create a single invited-review account. Never print passwords or overwrite existing config. */
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { hashReviewerPassword } from "../lib/auth/reviewer.ts";

const username = process.argv[2] ?? "reviewer";
const origin = process.argv[3] ?? "http://127.0.0.1:3080";
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/.test(username)) {
  throw new Error("账号应为 2–64 位字母、数字、下划线、点或连字符，首位为字母或数字");
}
const url = new URL(origin);
if (url.origin !== origin || url.username || url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
  throw new Error("公网 origin 必须为 HTTPS，不带路径/尾斜杠；HTTP 仅允许本机回环地址");
}
const envPath = path.resolve(".env");
const accountPath = path.resolve(".env.reviewer-account");
const password = randomBytes(18).toString("base64url");
const passwordHash = await hashReviewerPassword(password);
const secret = randomBytes(32).toString("base64url");

// Open exclusively before writing: a second run must not replace an existing account or model key.
const accountFile = await open(accountPath, "wx", 0o600);
let envFile;
try {
  envFile = await open(envPath, "wx", 0o600);
} catch (error) {
  await accountFile.close();
  await unlink(accountPath);
  throw error;
}
try {
  await envFile.writeFile([
    "# Private runtime configuration; excluded from Git and Docker build contexts.",
    `VERIPAGE_REVIEWER_USERNAME=${username}`,
    `VERIPAGE_REVIEWER_PASSWORD_HASH=${passwordHash}`,
    `VERIPAGE_SESSION_SECRET=${secret}`,
    `VERIPAGE_PUBLIC_ORIGIN=${origin}`,
    "# Configure an authorized model endpoint/key before full-chain evaluation.",
    "VERIPAGE_AGNES_BASE_URL=",
    "VERIPAGE_AGNES_API_KEY=",
    "VERIPAGE_TEXT_MODEL=",
    "VERIPAGE_VISION_MODEL=",
    "VERIPAGE_ANALYZER_MAX_TOKENS=6000",
    "VERIPAGE_TEXT_MAX_TOKENS=6000",
    "",
  ].join("\n"));
  await accountFile.writeFile([
    "网鉴 VeriPage · 受邀评测账号（私密，不得上传到公网或 Git）",
    `账号：${username}`,
    `密码：${password}`,
    "登录路径：/login",
    `当前验证地址：${origin}/login`,
    "公网部署后以最终 HTTPS 地址为准（支持直接 IP）；每次登录有效 12 小时。",
    "",
  ].join("\n"));
} finally {
  await Promise.all([envFile.close(), accountFile.close()]);
}
console.log(JSON.stringify({ username, origin, envPath, accountPath, mode: "0600", secretsPrinted: false }, null, 2));
