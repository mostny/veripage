/**
 * M4 知识库冒烟（离线）：白名单命中语义 + 案例检索排序 + 「未收录≠未授权」纪律
 * 运行：node eval/knowledge.smoke.ts
 */
import {
  KNOWLEDGE_VERSION,
  lookupBrandByDomain,
  lookupThirdParty,
  searchRelatedPhishCases,
} from "../lib/knowledge/index.ts";
import { kbLookupDomain, summarizeKbLookup } from "../lib/tools/kb-lookup.ts";
import { searchRelatedCases, summarizeCaseMatches } from "../lib/tools/rag-search.ts";

let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` | ${detail}` : ""}`);
};

// --- 品牌白名单 ---
check("淘宝官方域命中", lookupBrandByDomain("taobao.com").hit);
check("www 前缀归一化", lookupBrandByDomain("www.taobao.com").hit);
check("官方域子域命中（login.taobao.com）", lookupBrandByDomain("login.taobao.com").hit);
check("仿冒域不命中（ta0bao.com）", !lookupBrandByDomain("ta0bao.com").hit);
check("仿冒域带未收录提示", lookupBrandByDomain("ta0bao.com").note.includes("未收录不等于未授权"));
check("政府后缀命中（example.gov.cn）", lookupBrandByDomain("example.gov.cn").hit);
check("普通域不命中（example.com）", !lookupBrandByDomain("example.com").hit);
check("银行官方域命中（icbc.com.cn）", lookupBrandByDomain("icbc.com.cn").hit);

// --- 第三方服务白名单（合法解释） ---
check("字节 CDN 命中（bytecdn.com）", lookupThirdParty("bytecdn.com").hit);
check("CDN 子域命中（cdn.bytecdn.com）", lookupThirdParty("cdn.bytecdn.com").hit);
check("百度统计命中（hm.baidu.com）", lookupThirdParty("hm.baidu.com").hit);
check("陌生域不命中（evil.example）", !lookupThirdParty("evil.example").hit);

// --- kb-lookup 工具输出 ---
const kb = kbLookupDomain("login.taobao.com");
check("kbLookup 命中品牌且带版本", kb.brand.hit && kb.knowledgeVersion.length > 0, kb.knowledgeVersion);
check("kbLookup 摘要含白名单结论", summarizeKbLookup(kb).includes("淘宝"));
const kbNone = kbLookupDomain("example.com");
check("kbLookup 未命中时摘要含纪律话术", summarizeKbLookup(kbNone).includes("未收录不等于未授权"));

// --- 钓鱼案例检索 ---
const urgent = searchRelatedPhishCases("您的账户存在异常，请在24小时内验证，否则将被冻结，请重新登录");
check("紧迫话术检索到 case-urgency", urgent[0]?.case.id === "case-urgency", urgent[0]?.case.id);
check("命中特征非空", (urgent[0]?.matchedIndicators.length ?? 0) >= 2);
check("相似度在 0—1 之间", (urgent[0]?.score ?? 0) > 0 && (urgent[0]?.score ?? 0) <= 1);

const typo = searchRelatedPhishCases("该页面主域名与品牌高度相似，且为登录页含密码输入框");
check("仿冒模式检索到 case-typosquat", typo.some((m) => m.case.id === "case-typosquat"));

const rag = searchRelatedCases("您的账户存在异常，请在24小时内验证，否则将被冻结");
check("rag-search 命中且摘要含版本", rag.matches.length > 0 && summarizeCaseMatches(rag).includes(KNOWLEDGE_VERSION));
const ragEmpty = searchRelatedCases("今日天气预报：晴，气温25度，适合外出活动");
check("普通文本检索为空", ragEmpty.matches.length === 0);
check("空检索有诚实说明", (ragEmpty.emptyReason ?? "").includes("不代表安全"));

// --- 版本 ---
check("知识库版本号非空", KNOWLEDGE_VERSION.length > 0, KNOWLEDGE_VERSION);

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
