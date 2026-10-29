/**
 * 闸门① url-static 冒烟测试
 * 运行：node eval/url-static.smoke.ts（Node 24 原生剥离 TS 类型）
 */
import { analyzeUrlStatic } from "../lib/tools/url-static.ts";

const cases = [
  "https://www.taobao.com",                    // 正常：无命中
  "https://ta0bao.com/login",                  // 编辑距离 1
  "https://taobao.com.verify-acc.cn/user",     // 子域伪装
  "https://bit.ly/3xYz",                       // 短链
  "http://192.168.1.5/pay",                    // 裸 IP + 非 HTTPS
  "https://evil.com/?q=%3Cscript%3Ealert(1)%3C/script%3E", // payload 痕迹
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
