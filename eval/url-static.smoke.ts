/**
 * 闸门① url-static 冒烟测试
 * 运行：node eval/url-static.smoke.ts（Node 24 原生剥离 TS 类型）
 *
 * 纪律：全部离线——psl 公共后缀列表是本地数据文件，本文件不发起任何 DNS/网络请求。
 * 覆盖：PSL 主域解析（多级后缀 / com.cn / IP 字面量 / 单标签）+ 既有规则行为不变。
 */
import { analyzeUrlStatic, getRegistrableDomain } from "../lib/tools/url-static.ts";
import { HIDDEN_URL_PARAM_VALUE, minimizeUrlForDisplay } from "../lib/tools/url-display.ts";

let fail = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `（${extra}）` : ""}`);
};

// --- 主域解析（PSL，离线） ------------------------------------------------
const domainCases: Array<[string, string]> = [
  ["login.example.co.uk", "example.co.uk"], // 多级公共后缀：旧枚举法误判成 co.uk
  ["example.co.uk", "example.co.uk"],
  ["deep.sub.login.example.co.uk", "example.co.uk"], // 多级子域仍取 eTLD+1
  ["www.taobao.com.com.cn", "com.com.cn"], // com.cn 是公共后缀，真实主域是 com.com.cn
  ["icbc.com.cn", "icbc.com.cn"],
  ["www.gov.cn", "www.gov.cn"], // gov.cn 为公共后缀，www 已是注册级标签
  ["www.taobao.com", "taobao.com"],
  ["taobao.com.verify-acc.cn", "verify-acc.cn"], // 子域伪装的真实归属
  ["192.168.1.5", "192.168.1.5"], // IPv4 字面量原样返回
  ["127.0.0.1", "127.0.0.1"],
  ["localhost", "localhost"], // 单标签主机名：PSL 无从解析，原样返回
  ["::1", "::1"], // IPv6 字面量
  ["[::1]", "::1"], // URL.hostname 形态（带方括号）
];
for (const [host, expect] of domainCases) {
  const got = getRegistrableDomain(host);
  check(`getRegistrableDomain(${host})`, got === expect, `期望 ${expect}，实际 ${got}`);
}

// --- 规则行为回归（既有断言原样保留，只追加用例） -------------------------
const cases = [
  "https://www.taobao.com",                    // 正常：无命中
  "https://ta0bao.com/login",                  // 编辑距离 1
  "https://taobao.com.verify-acc.cn/user",     // 子域伪装
  "https://www.taobao.com.com.cn/",            // 子域伪装（PSL 主域修正后仍应命中）
  "https://bit.ly/3xYz",                       // 短链
  "http://192.168.1.5/pay",                    // 裸 IP + 非 HTTPS
  "http://127.0.0.1:8080/admin",               // 裸 IP + 非 HTTPS
  "http://localhost:3000/admin",               // 单标签主机名 + 非 HTTPS
  "https://evil.com/?q=%3Cscript%3Ealert(1)%3C/script%3E", // payload 痕迹
  "https://xn--e1afmkfd.xn--p1ai/",            // punycode 同形字符
  "https://evil.top/",                         // 廉价 TLD
  "https://login.example.co.uk/",              // 正常多级后缀站点：无命中
];

for (const c of cases) {
  const r = analyzeUrlStatic(c);
  console.log(`\n[${c}]`);
  console.log(`  主域: ${r.registrableDomain}  静态分: ${r.score}  建议深扫: ${r.needsDeepScan}`);
  for (const f of r.findings) {
    console.log(`  - [w${f.weight}] ${f.title} | ${f.detail}`);
  }
  if (r.findings.length === 0) console.log("  - （无命中）");
}

const reportOf = (u: string) => analyzeUrlStatic(u);
const hasFinding = (u: string, id: string): boolean => reportOf(u).findings.some((f) => f.id === id);

check("主域 login.example.co.uk → example.co.uk", reportOf("https://login.example.co.uk/").registrableDomain === "example.co.uk");
check("主域 www.taobao.com.com.cn → com.com.cn", reportOf("https://www.taobao.com.com.cn/").registrableDomain === "com.com.cn");
check("主域 icbc.com.cn → icbc.com.cn", reportOf("https://icbc.com.cn/").registrableDomain === "icbc.com.cn");
check("主域 192.168.1.5 → 192.168.1.5（IP 字面量）", reportOf("http://192.168.1.5/pay").registrableDomain === "192.168.1.5");
check("主域 localhost → localhost（单标签）", reportOf("http://localhost:3000/admin").registrableDomain === "localhost");

check("www.taobao.com 无命中", reportOf("https://www.taobao.com").findings.length === 0);
check("ta0bao.com 命中品牌编辑距离", hasFinding("https://ta0bao.com/login", "levenshtein:taobao.com"));
check("taobao.com.verify-acc.cn 命中子域伪装", hasFinding("https://taobao.com.verify-acc.cn/user", "subdomain-disguise:taobao.com"));
check("www.taobao.com.com.cn 命中子域伪装", hasFinding("https://www.taobao.com.com.cn/", "subdomain-disguise:taobao.com"));
check("bit.ly 命中短链", hasFinding("https://bit.ly/3xYz", "shortener"));
check("裸 IPv4 命中 ip-literal", hasFinding("http://192.168.1.5/pay", "ip-literal"));
check("http 命中 no-https", hasFinding("http://192.168.1.5/pay", "no-https"));
check("payload 痕迹命中", hasFinding("https://evil.com/?q=%3Cscript%3Ealert(1)%3C/script%3E", "payload-pattern"));
check("punycode 命中同形字符", hasFinding("https://xn--e1afmkfd.xn--p1ai/", "homoglyph:punycode"));
check("廉价 TLD 命中 cheap-tld", hasFinding("https://evil.top/", "cheap-tld"));
check("login.example.co.uk 无命中", reportOf("https://login.example.co.uk/").findings.length === 0);

// --- 静态发现 id 唯一性（审计 F11：重复 id 会破坏真实报告的 validate） -----
for (const c of cases) {
  const ids = reportOf(c).findings.map((f) => f.id);
  check(`[${c}] 静态发现 id 全局唯一`, new Set(ids).size === ids.length, ids.join(","));
}
// jd.com ↔ qq.com：微信（weixin.qq.com）与腾讯（qq.com）折叠到同一可注册域 qq.com，
// 历史上会生成两条同 id 的 levenshtein:qq.com；同 id 视为同一事实只保留一条。
{
  const jd = reportOf("https://jd.com/");
  const qqHits = jd.findings.filter((f) => f.id === "levenshtein:qq.com");
  check("jd.com 命中 levenshtein:qq.com", qqHits.length === 1, `实际 ${qqHits.length} 条`);
  check(
    "jd.com 保留的相似事实内容完整",
    qqHits[0]?.detail.includes("qq.com") && qqHits[0]?.detail.includes("编辑距离") === true,
    qqHits[0]?.detail,
  );
}

// --- URL 展示最小化（审计 F01 链接线部分） --------------------------------
{
  const token = "AUDIT_TOKEN_X";
  const minimized = minimizeUrlForDisplay(`https://example.com/?token=${token}&keep=1`);
  check("凭据样参数值替换为占位", minimized === `https://example.com/?token=${HIDDEN_URL_PARAM_VALUE}&keep=1`, minimized);
  check("最小化结果不含裸 token", !minimized.includes(token));
  const other = minimizeUrlForDisplay("https://example.com/p?session=abcdefgh1234&x=2#frag");
  check("session 长值也被隐藏且保留锚点", other === `https://example.com/p?session=${HIDDEN_URL_PARAM_VALUE}&x=2#frag`, other);
  check("短值不误伤", minimizeUrlForDisplay("https://example.com/?key=1") === "https://example.com/?key=1");
  check("无 query 原样返回", minimizeUrlForDisplay("https://example.com/path") === "https://example.com/path");
  check("普通参数原样保留", minimizeUrlForDisplay("https://example.com/?q=%E4%B8%AD&a=b") === "https://example.com/?q=%E4%B8%AD&a=b");
  check("幂等：对已最小化结果不再改动", minimizeUrlForDisplay(minimized) === minimized);
  check("分片内的伪 query 也可隐藏", minimizeUrlForDisplay("https://example.com/#/callback?access_token=abcdefgh") === `https://example.com/#/callback?access_token=${HIDDEN_URL_PARAM_VALUE}`);
  check("大写参数名命中（大小写不敏感）", !minimizeUrlForDisplay("https://example.com/?Signature=abcdefgh12").includes("abcdefgh12"));
}

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
