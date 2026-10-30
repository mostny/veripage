# 网鉴 VeriPage

> 核验网页「声称的身份」与「实际行为」是否一致的 AI 反钓鱼检测台
> 第九届传智杯 AI WEB 网页开发挑战赛 · 参赛作品 · [mostny/veripage](https://github.com/mostny/veripage)

**演示链接**：（部署后补充 —— 仓库已备好 Vercel 与 Docker 两套部署配置，见下文「部署」）

## 一句话定位

用户发来一个链接，我们替用户「点」进去：把**它声称自己是谁**（标题 / Logo / 话术）与**它实际在做什么**（真实域名 / 跳转链 / 表单提交目标 / 第三方脚本）逐条对照，输出一份**每条结论都绑定证据**的三维核验报告。

## 解决什么问题

| 既有方案 | 解决不好的问题 | VeriPage 的答案 |
|---|---|---|
| 黑名单（PhishTank 等） | 只认识已报案 / 已收录的站，0day 仿冒站天然漏网 | 证据核验不依赖历史报案；黑名单只是闸门①里的一条规则 |
| 直接问聊天 AI | 模型打不开链接、看不到页面，只能凭 URL 字面猜 | Playwright 沙箱代访 + 视觉 / 语义 / 技术三路取证 |
| 传统网页取证工具 | 输出原始数据，不判断「在仿冒谁」，普通人看不懂 | 四问框架 + 证据三级标注 + 可解释报告 |

## 检测线现状（以 main 实际代码为准，不夸大）

| 检测线 | 现状 | 合入记录 |
|---|---|---|
| 链接检测线（S0 边界 + 三闸门 + 证据约束报告） | ✅ main 已完整可用 | main 主线（含 M1 修复，PR #3） |
| 知识检索线（品牌白名单 / 钓鱼案例 / SSO 合法解释） | ✅ main 已合并：知识证据进编排器 + 有界补证轮 + `versions.knowledge` | PR #7 / #11 |
| 文本体检线（AIGC 识别 + 隐私脱敏） | ✅ main 已合并：`/text` 页 + `/api/text` + 本地正则脱敏 | PR #8 |
| W3 对照实验（三组 + 两组消融 + 61 样本 fixture） | ✅ main 已合并：数据集 / 实验壳 / 报告 | PR #12 |
| 复核治理线（会话隔离截图产物 + 结论 ↔ 证据联动工作台） | ✅ main 已合并：ArtifactStore + 会话隔离端点 + 双向联动工作台 | PR #5 / #6 |
| 部署配置与本文档 | ✅ 随本 PR 合并（Vercel + Docker 双方案已备，未绑定账号） | `yan/deploy-readme` · PR #10 |
| 实验产物隔离（`--tag` / `--dir`）与主分析 `max_tokens` 可配置 | ✅ main 已合并 | PR #13 / #14 |

### 链接检测线：一次检测发生了什么（main @ 72240b2）

1. **S0 访问边界**（`lib/guard/access.ts`）：协议白名单；域名先解析再校验 IP，拒绝私网 / 链路本地 / 云元数据地址（防 SSRF 与 DNS 重绑定）。被拒则不启动浏览器，步骤如实标记 `skipped`。
2. **闸门① URL 静态分析**（`lib/tools/url-static.ts`）：纯规则、不联网——域名编辑距离、子域伪装拆穿（`taobao.com.xxx.cn` 的真实可注册主域是 `xxx.cn`）、punycode 同形字符、短链展开预判、黑名单比对、URL 参数 payload 痕迹。
3. **闸门② 沙箱代访**（`lib/tools/fetch-page.ts`）：Playwright 无头浏览器以一次性 context 打开目标页，采集**技术事实**级证据——完整跳转链、整页截图、可见正文、表单 action / method / 是否含密码框、第三方域脚本清单；总预算 20s，任何失败都降级为「取证不完整」而不是抛异常。
4. **闸门③ AI 取证**（`lib/agent/orchestrator.ts`）：视觉模型看截图（在仿冒谁）+ 语义模型读 HTML（话术 / 索要行为）+ 知识库比对（合法解释 / 相似案例引用）；JSON 解析失败自动纠偏重试，两次失败输出 `unknown` 兜底。
5. **validate 证据约束**（`lib/evidence/validate.ts`）：每条结论引用的 evidence id 必须真实存在于证据池——「JSON 可解析」不等于「通过」。
6. **三维报告**：风险判断（high / suspicious / no_significant_risk / unknown）× 证据充分程度 × 检测覆盖（每步 completed / partial / skipped / failed + 原因），经 SSE 实时推送到前端步骤时间线。整次检测总预算 120s（`app/api/scan/route.ts:8`）。

## 快速开始（本地完整版）

环境要求：Node ≥ 20.9（Next 16 的要求；部署侧固定 22.x，见 `package.json` 的 `engines`）、pnpm 11。

```bash
git clone https://github.com/mostny/veripage.git
cd veripage
pnpm install
pnpm exec playwright install chromium
# 国内网络可换镜像：PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/
cp .env.example .env   # 填入模型 API Key；真实 Key 只放这里（.env 已被 gitignore）
pnpm dev               # http://localhost:3000
```

### 模型端点与环境变量

当前实际指向 **StepFun**（`https://api.stepfun.com/step_plan/v1`，模型 `step-5-preview`，OpenAI 兼容协议、支持视觉输入）。环境变量名保留历史命名 `VERIPAGE_AGNES_*`（避免与在飞分支改名冲突；名字里的 "AGNES" 只是历史命名，不代表实际端点），**任何 OpenAI 兼容端点都可替换**——只改 `.env`，代码零改动：

| 变量 | 说明 |
|---|---|
| `VERIPAGE_AGNES_BASE_URL` | OpenAI 兼容端点 base（当前 `https://api.stepfun.com/step_plan/v1`，代码在其后拼 `/chat/completions`） |
| `VERIPAGE_AGNES_API_KEY` | 端点 Key。**只放 .env；任何配置文件 / README / 提交里都不出现真实值** |
| `VERIPAGE_TEXT_MODEL` | 文本 / 主分析模型（当前 `step-5-preview`） |
| `VERIPAGE_VISION_MODEL` | 视觉模型，需支持 `image_url` 输入（当前 `step-5-preview`） |
| `VERIPAGE_PRO_MODEL` | 预留的复杂判断模型 |
| `VERIPAGE_ANALYZER_MAX_TOKENS` | 主分析器输出预算，默认 6000（推理模型先产 reasoning，预算太小会截断 JSON） |

端点切换记录与历史实测见 [docs/model-notes.md](docs/model-notes.md)。

### 测试套件

```bash
# 不花模型额度的冒烟（Node 24 原生运行 TS；access-guard / fetch-page 需联网，fetch-page 还需本地 chromium）
for f in access-guard url-static evidence knowledge fetch-page m1-regressions scan-sse prompts; do
  node eval/$f.smoke.ts
done
# 真实端点冒烟（会消耗 Key 额度，需先有 .env）
node --env-file=.env eval/orchestrator.smoke.ts
node --env-file=.env eval/models.smoke.ts
```

类型检查 / lint / 生产构建：

```bash
pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm exec eslint .
rm -rf .next && pnpm build
```

## 部署（两套配置已备好，不绑定任何账号）

### 方案 A：Docker 自托管（完整版，演示首选）

```bash
cp .env.example .env          # 填 Key
docker compose up -d --build  # http://localhost:3000
```

`Dockerfile` 已装齐 Playwright chromium 的系统依赖，浏览器二进制固定在 `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`，容器启动不联网下载；三闸门全链路可用，行为与本地开发一致。代价：需要一台常驻机器（小型 VPS 即可）。

### 方案 B：Vercel（最快上线）

导入仓库即可构建。`vercel.json` 已配置：

- `regions: ["hkg1"]` —— 距国内评委最近的区域，且可正常访问模型端点（若套餐不支持自定义函数区域，Vercel 会忽略该字段用默认区域，不影响功能、只影响延迟）；
- `functions["app/api/scan/route.ts"].maxDuration = 120` —— 与 SSE 总预算一致（`app/api/scan/route.ts:8`）；
- Node 版本经 `package.json` 的 `engines.node` 固定为 22.x（Vercel 的 `vercel.json` schema 已不支持 `nodeVersion` 字段，2026-10-30 核对 openapi.vercel.sh/vercel.json）。

**取舍（如实说明）**：Vercel 函数是 serverless 环境，闸门②的 Playwright **没有开箱支持**——要么引入 `@sparticuz/chromium` 一类 Lambda 浏览器方案（需要改 `lib/tools/fetch-page.ts` 的引入方式，本仓库未做此适配），要么接受闸门②降级：扫描以「取证不完整」如实收尾（coverage 维度可见），不会给出假装完整的报告。另外各套餐对函数时长有上限，若低于 120s，平台会在上限处切断连接，前端显示「检测未完成」而不是假结果。**要完整链路演示，请用方案 A。**

## 架构（Mermaid）

```mermaid
flowchart TD
    U["用户提交链接"] --> R["POST /api/scan · SSE 流式 · 总预算 120s"]
    R --> S0{"S0 访问边界<br/>协议白名单 · 私网/云元数据拒绝 · DNS 重绑定缓解"}
    S0 -- "拒绝" --> B["返回 blocked<br/>不启动浏览器 · 步骤标记 skipped"]
    S0 -- "放行" --> G1["闸门① URL 静态分析（纯规则，不联网）<br/>编辑距离 · 子域伪装 · punycode · 短链 · 黑名单"]
    G1 --> G2["闸门② 沙箱代访（Playwright 无头）<br/>跳转链 · 截图 · 正文 · 表单 action · 第三方脚本"]
    G2 --> G3["闸门③ AI 取证（OpenAI 兼容模型）<br/>视觉看截图 · 语义读 HTML · 知识库比对合法解释"]
    G3 --> V{"validate 证据约束<br/>结论引用的 evidence id 必须真实存在"}
    V --> REP["三维报告<br/>风险判断 × 证据充分程度 × 检测覆盖"]
    REP --> UI["SSE 步骤时间线 + 结论↔证据联动"]

    EV[("证据池<br/>观察事实 / 风险推断 / 未知事项")]
    G2 -. "取证写入" .-> EV
    G3 -. "引用" .-> EV
    V -. "校验" .-> EV
    REP --> SNAP[("CaseSnapshot 快照<br/>versions: reportSchema / model / prompt / policy / knowledge<br/>保证同一案例可复现、可回放")]
```

**证据模型（原创实现重点）**：每条结论三级标注——`observed_fact`（观察事实）/ `inference`（风险推断，标明推理链）/ `reference`（外部引用），全部带 `evidenceIds`，并由 `lib/evidence/validate.ts` 程序化校验引用真实性。快照含 `versions` 版本谱系（reportSchema / model / prompt / policy / knowledge），保证实验可复现与证据回放；人工复核只追加 `ReviewEvent`，**不回填、不改写机器原始判断**。

## 实验数据

W3 三组对照 + 两组消融（A 黑名单+规则 vs B 裸多模态模型 vs C 完整 orchestrator；消融：去视觉 / 去知识库；61 个本地 fixture 样本，不访问外部真实站点）：

- [W3 三组对照实验报告](eval/experiments/results/report.md) —— 已在 main（PR #12）。核心数字：恶意检出 A 30.3% / B 63.6% / **C 87.9%**，良性误报 A 17.4% / B 39.1% / **C 0%**，结论证据支持率 **100%（366/366，程序校验）**；黑名单未命中样本上 A 仅 14.8% vs C 85.2%。复跑方式（走真实模型端点，消耗 Key 额度，全量约 45 分钟）：`node eval/experiments/run-all.mjs`；**试跑必须加 `--tag <名字>`**（产物落 `results/<名字>/`，不碰 `results/` 下已提交的全量产物）。

## 团队与 Git 历史

- **mostny（hhj）**：main 主检出链路全量实现——Next 16 脚手架、S0 访问边界、闸门①②③、模型适配层、证据契约与校验器、编排器 + SSE、前端两页、PSL 主域解析升级、知识库数据层；以及 P1 知识接线 / P2 文本线 / P3 实验 / 部署与文档等分支任务。
- **Fukaki-Ato（fukaki）**：M1 证据与检测生命周期修复（已合并，PR #3）、改进计划与实测基线文档（已合并，PR #1）、M2 会话隔离临时截图产物（PR #5 审核中）、M3 双向联动证据工作台（PR #6 审核中）。
- 全程细粒度 conventional commits（feat / fix / test / docs / chore / refactor），所有合入走 PR + review；两位提交者的本地 git 身份分别为 `hhj <hhj@veripage.local>` 与 `root <root@localhost.localdomain>`（GitHub 账号即上表两人）。

## 已知边界与诚实声明

- **未提交表单 ≠ 凭据已外传**：表单 action 是观察事实，「可能在索取凭据」是推断，两者分开标注。
- **未收录 ≠ 未授权**：白名单 / 案例库未命中只说明资料未覆盖，不得据此判恶意。
- **取证失败如实输出**：访问失败 / 模型失败 / 本地保存失败分别显示；coverage 维度标 `completed / partial / skipped / failed` + 原因；证据不足时输出 `unknown` 与缺口清单，不硬猜。
- **未检出 ≠ 安全**：存储型 / DOM 型 XSS 等运行时行为超出定位，不可靠检出，报告页脚常驻该声明。
- **AIGC 检测本身不确定**：文本线的 AIGC 判定是概率性提示，不构成法律或事实认定。
- **页面内容一律视为不可信数据**：抗提示注入加固 + 自建可控靶场样本验证；演示样本全部本地可控并标注「演示用」。
- **本地复核 ≠ RAG 入库**：误报更正不自动进入检索知识库、不触发任何模型更新；评测只计算机器原始输出。

## 目录结构

```
app/          页面与 API Routes（/api/scan 为 SSE 流式检测接口）
lib/          agent 编排 / tools（url-static · fetch-page · kb-lookup · rag-search）/ evidence 证据模型 / prompts
knowledge/    钓鱼案例库 + 官方域名与 SSO 白名单（JSON 带来源与版本）
eval/         冒烟测试 + W3 对照实验
docs/         大题框架 / 模型端点实测 / 技术文档
```

详细设计见 [docs/framework.md](docs/framework.md)。
