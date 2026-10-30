# 本地开发与验证说明

> 对应当前 Linux 工作区 `/workspace/传智杯/veripage`。这里的“本地”指本次工作区，不是用户桌面 Windows。
>
> [改进计划](plan.md) · [本次实测基线](baseline-2026-10-29.md)

## 已准备的环境

| 项目 | 当前结果 |
| --- | --- |
| Git | 2.43.0；完整历史；本地分支 `improve/evidence-workbench` |
| Node.js / npm | v22.23.3 / 10.9.9 |
| pnpm | 11.21.0，通过 npm exec 使用；不是全局安装 |
| 依赖 | 原 `pnpm-lock.yaml` frozen 安装完成，Next 16.4.3 / React 19.3.0 / Playwright 1.64.1 |
| 浏览器 | Chromium Headless Shell 156.0.8078.4（Playwright revision 1248）及 FFmpeg |
| 模型凭据 | 本次没有新建或写入密钥文件；真实模型链路未验证 |

## 常用命令

```bash
cd /workspace/传智杯/veripage

# 使用仓库指定 pnpm，无需改全局工具链
npm exec --yes --package=pnpm@11.21.0 -- pnpm --version
npm exec --yes --package=pnpm@11.21.0 -- pnpm install --frozen-lockfile

# 开发服务绑定回环地址；下列是启动命令，不代表服务目前在运行
npm exec --yes --package=pnpm@11.21.0 -- pnpm dev --hostname 127.0.0.1
```

依赖已安装后也可以直接使用项目 CLI，减少 npm exec 的额外查询：

```bash
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1
```

当前准备阶段的临时生产 HTTP 服务已经停止，没有交付公网预览或常驻开发服务。

## 无模型调用的检查顺序

```bash
# LayoutProps 等全局辅助类型由 Next 生成；新克隆时先做这一步
NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next typegen
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js .

# 前三项不访问目标；access-guard 包含 localhost/baidu.com DNS 解析
node eval/evidence.smoke.ts
node eval/prompts.smoke.ts
node eval/url-static.smoke.ts
node eval/access-guard.smoke.ts

# 生产构建。1536 MiB 是本次资源限制，不是框架要求；可按机器资源调整
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536 \
  node node_modules/next/dist/bin/next build

# 需要生产模式时，在构建成功后启动
node node_modules/next/dist/bin/next start --hostname 127.0.0.1
```

`url-static.smoke.ts` 当前只打印六个样例，没有断言；其退出 0 不证明规则的全部预期正确。Node 可能提示 `MODULE_TYPELESS_PACKAGE_JSON`，这是本次已观察到的警告，不是测试失败。不要仅为去掉警告随意改变整个项目模块类型。

## 浏览器准备

```bash
node node_modules/playwright/cli.js install chromium --only-shell
```

本地安装为 headless shell，不含完整有头 Chromium。若后续需要可见浏览器调试，再安装完整 Chromium。

浏览器成功启动不证明取证环境安全。当前源代码仍有 `--no-sandbox`、连接级 DNS/网络隔离等待处理项，见计划 M1。不要为了测试内网站点修改生产访问策略。

## 真实模型与联网测试

以下原有脚本会调用真实模型或访问外站，**不能作为默认离线测试批量运行**：

| 脚本 | 行为 |
| --- | --- |
| `eval/models.smoke.ts` | 多次模型调用，含文本/流式/工具/视觉 |
| `eval/orchestrator.smoke.ts` | 首个 example.com 用例运行取证与模型完整链路 |
| `eval/env-check.mjs` | 模型能力探测，会实际发送请求 |
| `eval/fetch-page.smoke.ts` | 真实浏览器访问 example.com，不调用模型 |

需要真实 AI 验证时，先核对团队选定供应商、认证、价格/剩余额度和本轮调用预算。沿用 `VERIPAGE_` 项目变量，不使用宿主其他任务的同名凭据。

- `.env.example` 是配置模板，示例 Key 不是有效认证。
- Next 自动读取本地环境文件；独立 Node 脚本并不自动加载 Next 环境文件，应使用相应的 `--env-file` 或限定项目的可信运行时注入。
- Key 仅留服务端，不加 `NEXT_PUBLIC_`，不放仓库、导出包、日志或对话。
- 无 Key 时仍可开发页面、离线模型替身、输入拦截和数据契约，不应临时填入其他账户凭据。

## M1—M3 离线回归

```bash
node eval/evidence.smoke.ts
node eval/prompts.smoke.ts
node eval/m1-regressions.smoke.ts
node eval/scan-sse.smoke.ts
node eval/artifact-store.smoke.ts
node eval/evidence-relations.smoke.ts

# 需要先有一份成功的 production build；仅访问 loopback，模型和外站请求均被 fixture 替代
node eval/workbench.e2e.mjs
```

`workbench.e2e.mjs` 会启动并关闭本任务拥有的本地 `next start`，验证桌面/手机视口、截图加载、会话 cookie、键盘选结论、双向证据联动、截图过期、服务端失败和无报告 EOF。它不会导航到待测 URL，也不需要 `.env`。视觉复核可在本机有 Noto Sans CJK SC 时加：

```bash
VERIPAGE_REVIEW_CJK_FONT=/path/to/NotoSansCJKsc-Regular.otf node eval/workbench.e2e.mjs
```

该环境变量只用于 E2E 截图审阅时加载本地字体，不进入应用包。裸 Linux 浏览器可能没有中文字库；缺字截图不作为产品视觉验收依据。

## Git 状态

改进计划和本地基线位于 `docs/improvements/`。`node_modules`、`.next`、`next-env.d.ts` 依照原 `.gitignore` 被忽略。本次任务不需改依赖清单或锁文件。

```bash
git status --short --branch
git diff --stat
git log -1 --oneline
```

首次基线检查里“直接运行 tsc”曾因缺少生成类型报 `LayoutProps` 未定义；按安装版文档执行 typegen 后通过。这是启动检查顺序问题，不是通过删类型或改业务源码规避。
