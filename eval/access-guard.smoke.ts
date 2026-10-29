/**
 * S0 访问边界冒烟测试
 * 运行：node eval/access-guard.smoke.ts（Node 24 原生剥离 TS 类型）
 * 含真实 DNS 解析用例（baidu.com / localhost），需联网
 */
import { assertPublicHttpUrl, isPrivateIp } from "../lib/guard/access.ts";

let fail = 0;
const check = (name: string, got: boolean, expect: boolean) => {
  const ok = got === expect;
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}（期望 ${expect}，实际 ${got}）`);
};

// --- isPrivateIp 纯函数直测（不联网） ---
const ipCases: Array<[string, boolean]> = [
  ["172.16.0.1", true],
  ["8.8.8.8", false],
  ["100.64.1.1", true], // CGNAT
  ["::ffff:192.168.0.1", true], // IPv4 映射
  ["169.254.169.254", true], // 云元数据
  ["1.1.1.1", false],
];
for (const [ip, expect] of ipCases) check(`isPrivateIp(${ip})`, isPrivateIp(ip), expect);

// --- assertPublicHttpUrl（含 DNS 解析） ---
const urlCases: Array<[string, boolean, string]> = [
  ["http://127.0.0.1:8080", false, "回环 IP"],
  ["http://192.168.1.1", false, "内网 IP"],
  ["file:///etc/passwd", false, "非 http 协议"],
  ["https://[::1]/", false, "IPv6 回环"],
  ["http://169.254.169.254/latest/meta-data", false, "云元数据端点"],
  ["http://10.0.0.5/admin", false, "内网 10 段"],
  ["http://localhost", false, "localhost 解析到回环"],
  ["https://www.baidu.com", true, "公网站点（真实 DNS）"],
];
for (const [url, expect, label] of urlCases) {
  const r = await assertPublicHttpUrl(url);
  check(`${label} ${url}`, r.allowed, expect);
}

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
