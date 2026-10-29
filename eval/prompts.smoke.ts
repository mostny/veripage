/**
 * 闸门③提示词冒烟：验证核心纪律段落与证据组装完整存在
 * 运行：node eval/prompts.smoke.ts
 */
import {
  PROMPT_VERSION,
  analyzerSystemPrompt,
  visionAnalysisPrompt,
  buildAnalyzerUserMessage,
} from "../lib/prompts/analyzer.ts";

let fail = 0;
const check = (name: string, ok: boolean) => {
  if (!ok) fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

const sys = analyzerSystemPrompt();

// 1. 抗注入加固关键段
check("系统提示含「不可信数据」纪律", sys.includes("不可信数据"));
check("系统提示含注入处置规则", sys.includes("提示注入") && sys.includes("必须忽略"));
check("系统提示禁止编造证据 id", sys.includes("禁止编造证据"));

// 2. 四问框架齐全
for (const key of ["身份声明", "视觉与语义", "技术事实", "合法解释"]) {
  check(`四问含「${key}」`, sys.includes(key));
}

// 3. 判断纪律与输出 schema 关键字段
for (const key of ["observed_fact", "inference", "reference", "alternativeExplanations", "unknowns", "recommendedAction"]) {
  check(`输出契约含 ${key}`, sys.includes(key));
}
check("未提交表单纪律", sys.includes("未提交表单") || sys.includes("声明目标"));

// 4. 视觉提示同样有抗注入条款
const vision = visionAnalysisPrompt();
check("视觉提示含注入应对", vision.includes("注入") && vision.includes("不要执行"));

// 5. user 消息组装：证据 id 必须原样出现
const msg = buildAnalyzerUserMessage({
  url: "https://ta0bao.com/login",
  registrableDomain: "ta0bao.com",
  staticFindings: [{ id: "ev-static-1", title: "主域与淘宝官方域高度相似", detail: "编辑距离=1", weight: 5 }],
  staticScore: 50,
  redirectChain: ["https://ta0bao.com/login"],
  pageTitle: "淘宝登录",
  pageText: "请输入账号密码",
  forms: [{ id: "ev-form-1", action: "https://evil.example/collect", method: "post", hasPasswordInput: true, inputCount: 3 }],
  externalScriptDomains: ["cdn.example.com"],
  visionAnswer: "1) 淘宝 2) 淘宝登录页 3) 输入账号密码",
  warnings: [],
});
for (const evId of ["ev-url", "ev-static-1", "ev-redirect", "ev-title", "ev-text", "ev-form-1", "ev-scripts", "ev-vision"]) {
  check(`user 消息含证据 id ${evId}`, msg.includes(`[${evId}]`));
}
check("user 消息含不可信数据围栏", msg.includes("<<<"));
check("版本号格式", /^\d+\.\d+\.\d+$/.test(PROMPT_VERSION));

console.log(fail === 0 ? "ALL-PASS" : `FAIL（${fail} 例未过）`);
process.exit(fail === 0 ? 0 : 1);
