# 模型端点说明与实测记录

> 当前端点（2026-10-30 起）：**StepFun**（OpenAI 兼容协议）
> - Base URL：`https://api.stepfun.com/step_plan/v1`（`lib/models.ts` 在其后拼接 `/chat/completions`）
> - 模型：`step-5-preview`（文本补全 / 视觉 `image_url` / 工具调用 / 流式 SSE）
> - 环境变量名保持历史命名 `VERIPAGE_AGNES_*`（理由见「端点切换记录」）；真实 Key 只在 gitignored 的 `.env`

## 端点切换记录（2026-10-30）

| 项 | 原（2026-10-29 实测） | 现（2026-10-30 起） |
|---|---|---|
| 端点 | `https://api.agnes-ai.cn/v1` | `https://api.stepfun.com/step_plan/v1` |
| 模型 | `agnes-2.5-flash` / `agnes-2.5-pro` | `step-5-preview`（文本/视觉/预留三者同名） |
| 协议 | OpenAI 兼容 | OpenAI 兼容（不变） |

- **切换不动代码**：`lib/models.ts` 只依赖 OpenAI 兼容协议（Bearer 认证 + `/chat/completions` + 标准 SSE chunk + `image_url` 视觉输入），端点与模型全部走环境变量，换端点不需要改任何源码。
- **变量名不改名**（仍为 `VERIPAGE_AGNES_*`）：在飞分支（P1/P2/P3）都在用旧名，此时改名会给跨分支合并制造冲突；名字里的 "AGNES" 只是历史命名，`.env.example` 注释与 README 均已注明实际端点是 StepFun。
- **任何 OpenAI 兼容端点都可替换**（包括换回 Agnes）：只改 `.env` 的 `VERIPAGE_AGNES_BASE_URL` / `VERIPAGE_AGNES_API_KEY` / `VERIPAGE_TEXT_MODEL` / `VERIPAGE_VISION_MODEL` / `VERIPAGE_PRO_MODEL`。

## StepFun 端点的实测证据

- **W3 实验全量运行（61 样本）走真实端点**：分支 `yan/w3-experiments` 的实验报告（`eval/experiments/results/report.md，draft PR #9 审核中，未合并 main`）记载：模型调用用真实 `chat` / `visionChat`（即 `.env` 指向的 StepFun 端点），全量快照 `versions.model = step-5-preview`、`prompt = 1.1.0`，文本与视觉两路均正常产出并完成三组对照 + 两组消融。
- **已知限制（同一报告 §0.5，如实记录）**：`step-5-preview` 为推理模型（先 reasoning 后 content），编排器主分析硬编码 `maxTokens=2000`（`lib/agent/orchestrator.ts`）时 6 样本试跑有 4 个 `finish=length`、JSON 被截断只能走 `risk=unknown` 兜底；实验全量改用 `--max-tokens 6000` 跑（判定口径未放宽）。**「把主分析 max_tokens 改为可配置」是已知待办，本文件仅记录，不在部署任务中改被测实现。**

## 历史实测：Agnes 端点（2026-10-29，保留作能力基线与方法论）

> 以下矩阵是切换前对 `api.agnes-ai.cn/v1` 的实测，证明「一个 OpenAI 兼容模型同时覆盖文本+视觉+工具+流式」这一选型假设成立；该结论对任何同类端点（含 StepFun）同样适用，故保留。
> 可复跑：`node --env-file=.env eval/env-check.mjs`

### 结论矩阵（agnes-2.5-flash）

| 能力 | 结果 | 证据 |
|---|---|---|
| 文本补全 | ✅ 200 | 回复"正常" |
| 流式 SSE | ✅ 200 | 首帧 `data: {"object":"chat.completion.chunk",...}`，标准 OpenAI chunk 格式 |
| Function Calling | ✅ 200 | 正确返回 `tool_calls`，参数 `{"city":"北京"}` 与 schema 吻合 |
| 视觉输入（image_url） | ✅ 200 | 1×1 红色像素图正确识别为"红色" |

**一个模型同时覆盖文本 + 视觉 + 工具调用 + 流式，无需任何降级方案。**

### 模型可用性（Agnes 侧历史状态）

| 模型 | 状态 |
|---|---|
| agnes-2.5-flash | ✅ 主力（文本/视觉/工具/流式全通过） |
| agnes-2.5-pro | 待验证（预留复杂判断场景，未测） |
| agnes-3.0-flash | ❌ 当时不可用（网关报"无效的令牌"或挂起；同 key 在 2.5-flash 上正常，判定为模型权限/稳定性问题，非 key 问题） |
| agnes-image-2.5-flash | 生图模型（非本项目所需，未测） |

### 架构决策

1. **主力模型一个顶四路**：Agent 循环用原生 Function Calling（无需 JSON 指令循环降级）；视觉核验直接走同一模型的 `image_url` 输入。
2. **前端流式**：标准 SSE chunk，可直接对接 `app/api/scan` 的流式响应。
3. 密钥经 `VERIPAGE_` 前缀环境变量注入（见下）。

## 踩坑记录：环境变量前缀冲突

本机 shell 已存在全局 `AGNES_API_KEY`（Yan Agent 内部视觉中继使用，`cpk-` 前缀、指向另一主机）。Node 的 `--env-file` **不覆盖已存在的环境变量**，导致脚本误用全局 key 报 401"无效的令牌"。

**约定：本项目所有环境变量一律使用 `VERIPAGE_` 前缀**（`VERIPAGE_AGNES_BASE_URL` / `VERIPAGE_AGNES_API_KEY` / `VERIPAGE_TEXT_MODEL` 等），任何宿主环境部署都不会再撞名。
