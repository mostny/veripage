# M1—M3 交接任务书（转交队友）

> 制定：2026-10-29 · 基线：`main @ 026fb30` · 规格来源：`docs/improvements/plan.md`（你写的 M1—M6）
> 分工调整：**M1 剩余项 + M2 + M3 由你负责**；M4（知识库接线）由队长负责，不与你冲突。

## 0. 先说已完成的两件事（不用重做）

1. **M1-2 PSL 主域解析已完成并合并**（提交 `42fc6db`）：`getRegistrableDomain` 切换 psl 包，`login.example.co.uk → example.co.uk`、`www.taobao.com.com.cn → com.com.cn`、IP/单标签/方括号 IPv6 均有回归。附带修了一个 typo（`h.endsWith` 写成了不存在的方法，仅在 `[::1]` 形式输入时触发）和 psl 的类型声明（`lib/types/psl.d.ts`）。
2. **IPv4 映射 IPv6 绕过已修**（`6f93928`）：`::ffff:7f00:1` 十六进制写法现在正确判内网。

## 1. 协作契约（先读，避免返工）

- **共享契约已就绪**：`lib/evidence/types.ts` 的 `EvidenceItem` 已加 `artifactId?: string` 字段——M2 的截图产物用它关联，**直接使用，不要再改字段名**
- 事件契约：`{type:"step", step, state, detail?, reason?}`，step 名固定六个（s0-guard / gate1-static / gate2-fetch / gate3-vision / gate3-analyzer / validate），终态 completed/partial/skipped/failed
- **`lib/knowledge/`、`lib/tools/kb-lookup.ts`、`lib/tools/rag-search.ts` 是 M4 领地，不要动**；你改 `orchestrator.ts` 时如需引用知识证据，等 M4 接线（队长负责），你在 gaps/coverage 里留口子即可

## 2. M1 剩余（四项，规格见 plan.md §5 M1-B/M1-C）

| # | 任务 | 落点 |
|---|---|---|
| M1-3 | 无依据结论洗白修复：`observed_fact`/`reference` 但 evidenceIds 为空的 finding 不得静默降级为 inference；一次受预算修复轮，仍无依据则删除该 finding + gaps 记录 + summary 降措辞 | `lib/agent/orchestrator.ts` |
| M1-4 | coverage 双写修复：快照里一步骤只允许一条最终状态 | `lib/agent/orchestrator.ts` |
| M1-5 | SSE 无报告终态：流 EOF 未收到 report 时服务端发明确 failed 终态事件，前端停止转圈并提示中断（与正常报告、HTTP 错误区分） | `app/api/scan/route.ts` + `app/scan/page.tsx` |
| M1-6 | 没采到≠空表单：仅当 DOM 采集确实成功才写 `ev-form-none` 否定证据；采集失败只记 gaps | `lib/agent/orchestrator.ts` |

## 3. M2 截图与短期产物交付（规格见 plan.md §6）

- 新增 `lib/artifacts/*`：`ArtifactStore` 接口（save → {id, expiresAt} / get / cleanup，内存+受限临时目录，TTL 可配）
- `app/api/scans/[id]/artifacts/[artifactId]/route.ts`：短期同源会话隔离访问，随机 UUID 不是访问控制；错误响应不泄漏内容、禁公共缓存
- orchestrator：截图字节写入 ArtifactStore 成功后生成 id，`EvidenceItem.artifactId` 绑定，**去掉"已存 artifacts"假占位**
- fullPage 截图的 height 记录真实尺寸（当前固定写 800 是错的）

## 4. M3 证据工作台（规格见 plan.md §7）

- `app/scan/page.tsx` 拆组件：ReportSummary / CoverageTimeline / ScreenshotViewer / FindingList / EvidencePanel / SaveStatus
- 标志性交互：**点结论→关联证据高亮；点证据→展示关联结论**（先卡片文字定位，截图区域叠层后置）
- 第一屏：一句判断+关键理由+建议操作；风险/充分度/覆盖明确分开
- 响应式：360/390px 与桌面无遮挡无横向溢出；截图惰性展示，不嵌 iframe、不注入原始 HTML
- 空/失败/过期/加载/重试状态齐全；键盘可操作，颜色不是唯一标识

## 5. 验收链（每个 PR 必跑，按序）

```
pnpm exec next typegen → pnpm exec tsc --noEmit → pnpm lint
→ node eval/access-guard.smoke.ts（离线）
→ node eval/url-static.smoke.ts（离线）
→ node eval/orchestrator.smoke.ts（真实 Agnes key，已在 .env）
→ pnpm build
```

新增行为必须配断言（不把只打印的脚本当回归）；困难样本不许移除或降低断言。

## 6. 协作规则

- 从最新 main 切分支（建议 `yan/m2-artifacts`、`yan/m3-workbench` 分开，M1 修复可一个分支）
- 小步提交，一个功能点一个 commit；完成一个里程碑发 PR 给队长 review 后合并
- 合并前 `git fetch` 重新核对远端，不覆盖他人工作
- 碰 orchistrator/route/page 以外的共享文件（models.ts、evidence/、prompts/）先打招呼
