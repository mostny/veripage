/**
 * 部署隔离与配置解析的离线单测（审计 2026-10-30 F03 / F16，本轮修复）
 *
 * 运行：node eval/deploy-config.smoke.ts（零网络、不启动真浏览器、不读 .env）
 *
 * - F03：Chromium 启动参数构造（lib/tools/fetch-page.ts buildChromiumLaunchPlan）——
 *   默认保留沙箱：args 不含 --no-sandbox，且必须显式 chromiumSandbox=true
 *   （Playwright 自身默认是 false、会替我们注入 --no-sandbox，只删参数不够）；
 *   仅 VERIPAGE_BROWSER_NO_SANDBOX=1 显式逃生阀时才关沙箱。
 * - F16：VERIPAGE_ANALYZER_MAX_TOKENS 解析（lib/agent/orchestrator.ts
 *   parseAnalyzerMaxTokens）——只接受有限正整数，非法值回落 6000 并打明确警告。
 *
 * Dockerfile / docker-compose.yml 的文件级静态断言见 eval/dockerfile.check.mjs。
 */
import { buildChromiumLaunchPlan, BROWSER_NO_SANDBOX_ENV } from "../lib/tools/fetch-page.ts";
import { parseAnalyzerMaxTokens } from "../lib/agent/orchestrator.ts";

let failures = 0;
function check(name: string, passed: boolean, detail = ""): void {
  if (!passed) failures += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

check("F03 逃生阀环境变量名正确", BROWSER_NO_SANDBOX_ENV === "VERIPAGE_BROWSER_NO_SANDBOX");

// --- F03：Chromium launch 参数（不起真浏览器，纯函数级） ----------------------
{
  const plan = buildChromiumLaunchPlan(undefined);
  check("F03 默认（未设环境变量）：args 不含 --no-sandbox", !plan.args.includes("--no-sandbox"), JSON.stringify(plan.args));
  check(
    "F03 默认：chromiumSandbox 显式开启（Playwright 原生默认 false，不显式开等于没开）",
    plan.chromiumSandbox === true,
  );
  check("F03 默认：headless", plan.headless === true);

  const escaped = buildChromiumLaunchPlan("1");
  check(
    `F03 逃生阀 ${BROWSER_NO_SANDBOX_ENV}=1：args 含 --no-sandbox`,
    escaped.args.includes("--no-sandbox"),
    JSON.stringify(escaped.args),
  );
  check("F03 逃生阀：chromiumSandbox 关闭", escaped.chromiumSandbox === false);

  // 只认严格的 "1"：true/0/空串/带空格等写错形态一律保持沙箱（不静默降级）
  for (const wrong of ["true", "TRUE", "0", "", "yes", " 1", "1 "]) {
    const wrongPlan = buildChromiumLaunchPlan(wrong);
    check(
      `F03 非严格 "1" 写法（${JSON.stringify(wrong)}）不关沙箱`,
      wrongPlan.chromiumSandbox === true && !wrongPlan.args.includes("--no-sandbox"),
    );
  }
}

// --- F16：VERIPAGE_ANALYZER_MAX_TOKENS 只接受有限正整数 ------------------------
{
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };
  const cases: Array<{ raw: string | number | undefined; expected: number; shouldWarn: boolean }> = [
    { raw: "0.5", expected: 6000, shouldWarn: true }, // 审计实测：旧实现取整为 0 传模型
    { raw: "abc", expected: 6000, shouldWarn: true },
    { raw: "-1", expected: 6000, shouldWarn: true },
    { raw: "0", expected: 6000, shouldWarn: true },
    { raw: "6000", expected: 6000, shouldWarn: false },
    { raw: 6000, expected: 6000, shouldWarn: false },
    { raw: "8000", expected: 8000, shouldWarn: false },
    { raw: 8000, expected: 8000, shouldWarn: false },
    { raw: undefined, expected: 6000, shouldWarn: false }, // 未配置=默认，不算错
    { raw: "", expected: 6000, shouldWarn: false }, // 空串视为未配置
  ];
  for (const { raw, expected, shouldWarn } of cases) {
    warnings.length = 0;
    const got = parseAnalyzerMaxTokens(raw, warn);
    check(`F16 VERIPAGE_ANALYZER_MAX_TOKENS=${JSON.stringify(raw)} → ${expected}`, got === expected, `实际 ${got}`);
    check(
      `F16 ${JSON.stringify(raw)} 警告${shouldWarn ? "有且仅一条" : "为 0 条"}（不静默）`,
      shouldWarn ? warnings.length === 1 : warnings.length === 0,
      `实际 ${warnings.length} 条`,
    );
    if (shouldWarn) {
      check(
        `F16 ${JSON.stringify(raw)} 警告内容含变量名、原值与默认值`,
        warnings[0].includes("VERIPAGE_ANALYZER_MAX_TOKENS") &&
          warnings[0].includes(String(raw)) &&
          warnings[0].includes("6000"),
        warnings[0],
      );
    }
  }
}

console.log(failures === 0 ? "ALL-PASS" : `FAIL（${failures} 例未过）`);
process.exit(failures === 0 ? 0 : 1);
