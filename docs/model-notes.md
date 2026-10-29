# Agnes 模型能力实测记录

> 实测时间：2026-10-29 · 脚本：`eval/env-check.mjs`（可复跑：`node --env-file=.env eval/env-check.mjs`）
> 端点：`https://api.agnes-ai.cn/v1`（OpenAI 兼容，Bearer 认证）

## 结论矩阵（agnes-2.5-flash）

| 能力 | 结果 | 证据 |
|---|---|---|
| 文本补全 | ✅ 200 | 回复"正常" |
| 流式 SSE | ✅ 200 | 首帧 `data: {"object":"chat.completion.chunk",...}`，标准 OpenAI chunk 格式 |
| Function Calling | ✅ 200 | 正确返回 `tool_calls`，参数 `{"city":"北京"}` 与 schema 吻合 |
| 视觉输入（image_url） | ✅ 200 | 1×1 红色像素图正确识别为"红色" |

**一个模型同时覆盖文本 + 视觉 + 工具调用 + 流式，无需任何降级方案。**

## 模型可用性

| 模型 | 状态 |
|---|---|
| agnes-2.5-flash | ✅ 主力（文本/视觉/工具/流式全通过） |
| agnes-2.5-pro | 待验证（预留复杂判断场景，未测） |
| agnes-3.0-flash | ❌ 当前不可用（网关报"无效的令牌"或挂起；同 key 在 2.5-flash 上正常，判定为模型权限/稳定性问题，非 key 问题） |
| agnes-image-2.5-flash | 生图模型（非本项目所需，未测） |

## 架构决策

1. **主力模型 = agnes-2.5-flash**：Agent 循环用原生 Function Calling（无需 JSON 指令循环降级）；视觉核验直接走同一模型的 image_url 输入。
2. **前端流式**：标准 SSE chunk，可直接对接 `app/api/scan` 的流式响应。
3. 密钥经 `VERIPAGE_` 前缀环境变量注入（见下）。

## 踩坑记录：环境变量前缀冲突

本机 shell 已存在全局 `AGNES_API_KEY`（Yan Agent 内部视觉中继使用，`cpk-` 前缀、指向另一主机）。Node 的 `--env-file` **不覆盖已存在的环境变量**，导致脚本误用全局 key 报 401"无效的令牌"。

**约定：本项目所有环境变量一律使用 `VERIPAGE_` 前缀**（`VERIPAGE_AGNES_BASE_URL` / `VERIPAGE_AGNES_API_KEY` / `VERIPAGE_TEXT_MODEL` 等），任何宿主环境部署都不会再撞名。
