/**
 * 闸门② 沙箱代访冒烟测试
 * 运行：node eval/fetch-page.smoke.ts（需联网 + 已安装 playwright chromium）
 */
import { fetchPage } from "../lib/tools/fetch-page.ts";

let fail = 0;
const check = (name: string, ok: boolean) => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

// --- 用例 1：公网站点正常抓取（example.com） ---
const r1 = await fetchPage("https://example.com");
console.log(`[example.com] blocked=${r1.blocked} error=${r1.error ?? "-"} 跳转链=${r1.redirectChain.length} 证据=${r1.evidence.length} 耗时=${r1.elapsedMs}ms`);
check("未被 S0 拦截", r1.blocked === false);
check("无错误", !r1.error);
check("跳转链长度 ≥1", r1.redirectChain.length >= 1);
const shot = r1.evidence.find((e) => e.type === "screenshot");
check("截图 base64 >1000 字符", !!shot && "data" in shot && shot.data.length > 1000);
const text = r1.evidence.find((e) => e.type === "text");
check("title 含 Example", !!text && "title" in text && /example/i.test(text.title));

// --- 用例 2：内网地址被 S0 拦截（不启动浏览器） ---
const r2 = await fetchPage("http://192.168.1.1");
console.log(`[192.168.1.1] blocked=${r2.blocked} reason=${r2.reason ?? "-"}`);
check("内网地址被拦截", r2.blocked === true);
check("拦截原因非空", typeof r2.reason === "string" && r2.reason.length > 0);

// --- 用例 3：非 http 协议被拒 ---
const r3 = await fetchPage("ftp://example.com/file");
check("非 http 协议被拦截", r3.blocked === true);

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
