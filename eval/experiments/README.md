# W3 三组对照实验（AI 必要性证据）

> 回答评委必问：「相比黑名单和直接让多模态模型看页面，你们多做了什么？」
> 同一测试集跑三套：**A 黑名单+规则 / B 裸多模态模型 / C 完整 orchestrator**，另在 C 上做两组消融（去视觉 / 去知识库）。

## 快速开始

```bash
cd "D:/work/project/传智杯/veripage"

# 小样本试通（每类 1 个，共 6 个样本；模型组走真实 API，花小额真钱）
# ⚠️ 试跑必须加 --tag <名字>：产物落 results/<名字>/，不覆盖 results/ 下已提交的全量产物
node eval/experiments/run-all.mjs --limit 6 --tag trial-xxx

# 全量（三组 + 两组消融；每组单独进程，逐样本增量落盘）
node eval/experiments/run-all.mjs --max-tokens 6000

# 单组重跑（--dir 子目录同样用于隔离，避免覆盖正式产物）
node --env-file=.env eval/experiments/run-group.mjs --group C --max-tokens 6000 --dir trial-single
```

## 文件

| 文件 | 职责 |
|---|---|
| `config.mjs` | 判定阈值、预算、消融口径、A 组规则、B 组提示词（**跑前写死**） |
| `dataset.mjs` | 数据集加载（类别轮转排序）与 URL→fixture 路由 |
| `fixture-server.mjs` | 本地 127.0.0.1 HTTP fixture（`/page/:id` + `/hop/:id/:n` 真实 30x） |
| `local-fetcher.mjs` | Playwright 直连本地 fixture，产出对齐 `PageEvidence` 的取证结果；`withScreenshot=false` 为去视觉变体 |
| `metrics.mjs` | 检出/误报/无法判定/可判定子集/证据支持率等指标（程序校验） |
| `run-group.mjs` | 单组运行器（增量 JSONL + 预算计数 + 实时打印；`--dir 子目录` 隔离产物） |
| `run-all.mjs` | 一键跑五组 + 生成报告（`--tag 名字` 把整轮产物隔离到 `results/<名字>/`） |
| `report.mjs` | 汇总 `results/*.jsonl` → `results/report.md`（`--dir` 指定其他结果目录） |

## 产出（`results/`）

- `<组>.jsonl`：逐样本结果（增量落盘，崩了可断点续看）
- `<组>.summary.json`：该组指标/调用/版本汇总
- `report.md`：三组对比表、消融表、注入组专项、误报 Top5 及原因、成本汇总、黑名单未命中专段、失败样本逐个分析、结论
- `trial-2000budget/`：6 样本试跑原始记录（max_tokens=2000 下的截断证据）

## 纪律

1. **判定阈值跑前写死**（config.mjs）：suspicious 及以上计为检出；unknown 单独统计；A 组规则/黑名单口径见报告第 0 节。
2. **成本纪律**：单组默认 300 次文本 + 100 次视觉调用；实时打印计数；超限即停该组并如实记录（`status=budget-stopped`），不偷偷降样本质量。
3. **实验壳偏离如实披露**（报告 0.4/0.5）：S0 放行桩（fixture 在回环地址）、本地 Playwright fetcher、子资源一律中止不触外网、`--max-tokens` 覆盖编排器硬编码 2000（推理模型截断，试跑证据在 `trial-2000budget/`）。
4. `.env` 与任何 key 不进库；结果文件可入库（比赛材料）。
