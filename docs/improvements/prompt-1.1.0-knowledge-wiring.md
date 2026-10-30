# M4 知识接线变更记录：PROMPT_VERSION 1.0.0 → 1.1.0

> 日期：2026-10-30 · 分支：`yan/m4-knowledge-wiring` · 范围：`lib/agent/orchestrator.ts`、`lib/prompts/analyzer.ts`、`eval/m4-knowledge.smoke.ts`
> 触发：任务书 `P1-m4-knowledge-wiring.md`（知识库此前是孤岛：`lib/knowledge/` 数据与检索工具已就绪，但编排器未调用）。

## 1. 为什么升号

主分析器系统提示与 user 消息的证据契约发生了变化（新增知识证据段与使用边界），
旧提示词下模型不会引用 `ev-knowledge-*` 证据；按「提示词版本进快照 `versions.prompt`、
保证实验可复现」的既有约定，必须升号并在本文记录，否则历史快照无法归因。

## 2. 提示词层变更（`lib/prompts/analyzer.ts`）

- `PROMPT_VERSION`：`1.0.0` → `1.1.0`（lib/prompts/analyzer.ts:11）。
- 系统提示新增「知识库证据的使用边界」小节：四问框架不变，明确知识证据属外部引用
  （`kind="reference"`），「已收录」只证明归属已核验、「未收录」是未知而不是问题、
  相似案例不证明当前页面恶意、未命中方面不产生「无风险」结论。
- 判断纪律补两条：未提交表单不等于凭据已外传；第三方服务未收录不得判「冒用」或「未授权」。
- `AnalyzerEvidenceInput` 新增可选 `knowledge: KnowledgeEvidenceLine[]` 字段，
  `buildAnalyzerUserMessage` 在取证告警之后输出「【知识库证据】」段，逐条带证据 id 与摘要。

## 3. 编排器变更（`lib/agent/orchestrator.ts`）

- `ScanServices` 新增两个可注入缝：`kbLookup`（默认 `lib/tools/kb-lookup.ts` 真函数）、
  `ragSearch`（默认 `lib/tools/rag-search.ts` 真函数）。离线冒烟与 P3 消融实验注入空库/桩
  即依赖此契约。
- `buildEvidence` 产出知识证据，id 固定：
  - `ev-knowledge-brand`：主域品牌白名单归属核验（总是记录，已收录/未收录都是事实）；
  - `ev-knowledge-sso`：表单提交目标/第三方脚本域收录核验（有对象才记录）；
  - `ev-knowledge-cases`：相似历史钓鱼案例检索（有命中才记录）；
  - 补证轮追加：`ev-knowledge-sup-N`。
- 新增一次有界知识补证轮：首次分析输出的 gaps/unknowns 出现
  品牌/授权/白名单/收录/案例/手法/相似/知识库 类字样，且确有新域可查（跳转链/表单/脚本）
  或案例检索未做过时才触发；占用原修复轮额度，总主分析调用 ≤2。补证后仍无依据走
  `finalizeUnsupportedFindings` 降级，不硬猜。
- 快照 `versions.knowledge` 由占位 `"none-v1"` 改为真实 `KNOWLEDGE_VERSION`
  （注入桩时随桩结果报告，便于消融实验区分）。

## 4. 措辞纪律（冒烟按此断言）

「未收录」类证据与摘要只陈述收录事实，不出现「未授权」「冒用」「无风险」字样；
SSO 命中时话术固定为「已收录授权登录/公共服务」。
断言位置：`eval/m4-knowledge.smoke.ts` 的 `assertDiscipline()`（正则 `/未授权|冒用|无风险/`）。

## 5. 复跑方式

```bash
node eval/m4-knowledge.smoke.ts        # 离线：品牌矛盾 / SSO 收录 / 未收录≠未授权 / 案例命中 / 补证轮 ≤2 / 不空转 / 降级 / 空库注入缝
node --env-file=.env eval/orchestrator.smoke.ts   # 真实 key 链路回归
node --env-file=.env eval/models.smoke.ts         # 真实 key 模型可用性
```
