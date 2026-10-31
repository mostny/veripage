# VeriPage 最新主线代码审计与验收报告

> 核验任务开始：2026-10-30；报告整理发布：2026-10-31
>
> 审计提交：**`19b2ee9ee3d28d91fbe3034615d7b8916d8887cc`**（main，合并 PR #10）
>
> 对照基线：上一轮交付的 M3 `69ae591594a2c936f1b8e3009b4dda3352e6c4e1`
>
> 报告分支：`audit/2026-10-30-latest-verification`
>
> 本报告审查固定提交；审计脚本、日志摘录和截图是附属证据，没有修改受测业务代码或原实验结果。

## 一、结论

**整体不予“无条件验收”。工程构建、现有回归、受控页面演示和 Docker 本地运行通过；隐私外发、实验产物保护及任意不可信目标的执行隔离仍有需优先处理的问题。**

| 验收对象 | 结论 | 证据边界 |
| --- | --- | --- |
| 安装、类型、ESLint、生产构建 | 通过 | 原锁文件；Next 16.4.3；无业务源码修改 |
| M1—M3 合并后的既有行为 | 已有回归通过 | 证据、SSE、artifact 与工作台测试；仍有本次补充发现的证据边界缺口 |
| M4 知识接线 | 有条件通过 | 本地知识确实进入报告；完整 hostname、来源等级和证据摘录存在缺陷 |
| 文本 AIGC/脱敏 | 基本交互通过，隐私与异常路径不通过 | 原文传模、响应竞态、取消传播及重叠脱敏问题已复现 |
| 已提交 61 样本 × 5 组统计 | 内部一致性通过 | 每组完整唯一；重新计算核心 summary 一致；不等于独立证明真实 API 调用或语义正确 |
| 实验复跑与报告生成 | 不通过稳健性验收 | 试跑可能清空正式产物；错误/重复/混批处理有缺口；部分结论超出证据 |
| Docker 包装 | 构建/启动通过，中文截图不通过 | 镜像内 214 个受测源/数据文件哈希一致；镜像缺少中文字库，见 F17 |
| 任意不可信 URL 的公开检测服务 | 暂不放行 | Chromium 关闭沙箱，运行用户为 root，未建立连接级 DNS/网络出口隔离；未做远程攻击实验 |

优先级定义：P1 为可能导致敏感信息非预期外发、正式产物损坏或不安全公开执行的问题；P2 为具体功能、证据或验收可靠性缺陷；P3 为较低频配置/文档问题。本次未确认 P0。

## 二、版本、范围与执行环境

- 审计开始时 `main` 的 PR #3/#5/#6/#7/#8/#10/#11/#12/#13/#14 均已合并；没有开放的 PR/Issue。审计目标由 Git 与 GitHub 分支 API 双重确认。
- 相对上一轮 M3，主要新增 M4 知识接线、文本 AIGC/脱敏、61 页 fixture 与五组实验、`--tag/--dir` 隔离、可配置分析 token 上限、Docker/Vercel 配置及 README。
- 环境：Linux，Node **22.23.3**，npm **10.9.9**，pnpm **11.21.0**；Next **16.4.3**，React **19.3.0**，Playwright **1.64.1**；Docker **27.5.1**。
- 仅检查了模型配置“是否存在”：本机 `VERIPAGE_AGNES_BASE_URL`、`VERIPAGE_AGNES_API_KEY` 均缺失，`.env/.env.local/.env.production/.env.production.local` 均不存在。没有读取凭据值。
- 没有运行真实模型实验，没有重新生成或覆盖 `eval/experiments/results/`。新增诊断均使用假模型、内存数据或已提交 JSONL 的只读复算。
- 安全/代码审查与功能验收分开；三段只读审查结果经主会话的关键复现和运行检查整合。

## 三、已执行验收

### 3.1 安装与静态检查

| 检查 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | 通过；无需修改依赖/锁文件 |
| `next typegen` | 通过 |
| `tsc --noEmit --incremental false` | 通过 |
| 全量 `eslint .` | 通过 |
| `next build` | 通过；生成 `/`、`/scan`、`/text`，注册三个 API 路由族 |

### 3.2 已有 smoke：11 个脚本，289 个断言通过

| 脚本 | 通过断言数 |
| --- | ---: |
| `eval/evidence.smoke.ts` | 5 |
| `eval/prompts.smoke.ts` | 25 |
| `eval/url-static.smoke.ts` | 29 |
| `eval/access-guard.smoke.ts` | 17 |
| `eval/knowledge.smoke.ts` | 23 |
| `eval/m1-regressions.smoke.ts` | 23 |
| `eval/scan-sse.smoke.ts` | 13 |
| `eval/artifact-store.smoke.ts` | 30 |
| `eval/evidence-relations.smoke.ts` | 5 |
| `eval/m4-knowledge.smoke.ts` | 55 |
| `eval/text-line.smoke.ts` | 64 |

注意：access-guard 含真实 DNS 查询，M4 使用本地 HTTP fixture。**text-line 自称全离线但有一个装桩前可进入真实模型的用例，见 F04。** 本次环境没有真实模型配置；随后又用外层网络拦截桩安全复现该缺口，不能把此脚本的“绿”视为全离线保证。

### 3.3 生产模式浏览器：32 个断言通过

- `eval/workbench.e2e.mjs`：**9 项**，含 cookie 随截图请求发送、推理链定位、反向联动、360/390px 无横向溢出、无报告 EOF、服务端失败、截图过期。
- `eval/text-page.e2e.mjs`：**23 项**，含入口、空/加载/成功/502 状态、Ctrl+Enter、结果复制和 360/390px 布局。
- 两者均启动并关闭本任务拥有的 loopback `next start`，API 用 fixture 拦截。它们证明前端交互，不是实际模型判断质量或生产浏览器取证的完整证明。
- 已读取[桌面工作台截图](images/workbench-desktop.png)与[手机工作台截图](images/workbench-mobile.png)。审阅时使用本机已核验的 Noto CJK 字体补充中文显示，未将字体打入产品。截图中的页面/报告均为明确的合成 fixture。

### 3.4 Docker：真实构建与 9 个运行检查通过

- 构建命令：`docker build --progress=plain --tag veripage-audit:19b2ee9 --label org.opencontainers.image.revision=19b2ee9ee3d28d91fbe3034615d7b8916d8887cc .`，设置 240 秒外层时限，实际成功完成。
- 镜像：`sha256:52a22f828171cbe1b6cc18c2ca817aae26d8020e0670264c441c6b5450ff9e7e`；容器 Node **22.23.4**。
- 对镜像中的 app/lib/knowledge/eval 及必要配置共 **214 个文件**逐一与 Git 审计提交做 SHA-256 比对，**0 差异**。
- 运行使用 `--network none`，不映射端口、不注入模型凭据。受控内存页生成 PNG，`/`、`/scan`、`/text` 可达；非法 JSON、缺文本、缺模型配置、内网 guard 拒绝及无会话产物访问按预期返回，共 **9 项**。
- 浏览器检查为已授权的可信本地 fixture、显式 reduced-isolation `--no-sandbox`；不把这项检查解释成安全沙箱验收。容器运行 UID 实测为 **0**。
- 另做了不注入任何字体的中文采集检查：容器 `fc-list :lang=zh` 为空，实际 PNG 中中文为方框，见 F17。这说明“浏览器可启动”尚不足以验收中文多模态取证。
- 构建下载官方基础镜像、依赖和 Chromium；容器运行没有外网。没有执行 compose 公网发布、Vercel 部署或真实目标扫描。

## 四、需优先修复的发现

### F01 · P1：脱敏结果安全不等于原文未外发

**位置：** `app/api/text/route.ts:37–42`，`lib/text/aigc.ts:131–145`，`lib/prompts/text.ts:43–48`；链接输入另见 `lib/prompts/analyzer.ts:118`。

路由先生成脱敏副本，随后仍调用 `detectAigc(text)`；原始手机号、邮箱完整进入模型请求。提交前页面仅强调“本地正则”，原文外发边界说明在成功后才出现。链接线的 `token` 参数也原样进入分析输入和报告。

**实测：** 全局 fetch 先被假模型替换；提交合成手机号/邮箱，模型 body 两项原值均存在，响应的脱敏副本则均已遮盖。合成 URL token 也保留在模型输入中。没有向供应商发送这些输入。

**建议：** 提供独立的本地脱敏路径；AIGC 默认使用最小化文本，或在提交前明确说明原文外发并让用户选择。URL 日志/传模/展示按用途最小化。不主张实际供应商已保存或泄漏原文——本次只证明本地发出请求的内容。

### F02 · P1：试跑参数仍能清空正式实验产物

**位置：** `eval/experiments/run-all.mjs:19–40,63–64`；`run-group.mjs:44–81`；`report.mjs:608–613`。

- `--tag .` / `--tag ./`、`--dir .` 通过检查，规范化后仍指向正式 results 目录。
- `--dir trial --out ../A` 会定位到正式 `results/A.jsonl`；`--out` 没有路径约束。
- `--limit 6 --tag` 缺少值时直接退回正式目录。
- 报告生成器/已提交报告仍推荐不带 tag 的 `--limit 6` 命令。

**实测：** 执行实际 runner 的参数/写入前缀，但所有 mkdir/write 在 VM 中拦截；观察到向正式 A/C 文件写空字符串的调用，**实际写入 0 次**。

**建议：** 所有必需参数先验证；试跑输出必须严格位于隔离子目录，不能等于根目录；out 只接受文件名；已有文件默认拒绝覆盖或要求显式 overwrite，并同步修正复现命令。另有 `--limit oops → NaN → 全 61 样本`、`--max-text oops → NaN → 预算比较失效`，应在调用模型或清空文件前拒绝。

### F03 · P1（存量发布阻断）：真实不可信目标的执行隔离没有建立

**位置：** `lib/tools/fetch-page.ts:275–286,293–331`，`lib/guard/access.ts:217–238`，`Dockerfile:33–76`，`docker-compose.yml:14–20`。

Chromium 显式 `--no-sandbox`；Docker 未切非 root 用户，容器 UID=0 已实测。浏览器由持有模型配置的服务直接启动，未设置独立最小环境；Node DNS 检查后由 Chromium 自行连接，60 秒缓存不等于固定实际连接 IP。普通 route 拦截也未建立完整的网络出口/写请求、弹窗、下载、Service Worker 等执行边界。

**结论限制：** 这是配置与调用关系确认的边界缺失，**没有进行浏览器漏洞利用、DNS 重绑定攻击或私网访问实验**。Docker/guard 的基本功能通过，不能替代不可信站点安全隔离。

**建议：** 在接受任意公网目标前，建立非 root、保留浏览器沙箱、无模型凭据的采集进程与受限网络出口，并用实际连接记录验证跳转/子资源边界。当前适合受控 fixture 演示，不能以“隔离取证”文案作安全保证。

## 五、其他明确缺陷

### F04 · P2：标为全离线的 smoke 在装桩前到达模型

**位置：** `eval/text-line.smoke.ts:285–287`；假端点、假 Key 和 fetch 桩直到 `291–310` 才安装。

恰好 20,000 字符用例直接调用生产路由。有真实配置时会尝试实际模型请求，且成功响应也会令断言通过。

**实测：** 子进程先装外层拒绝联网的 fetch、只配假值，再导入原 smoke；得到 `AUDIT_PRE_STUB_MODEL_CALLS=1`，原测试仍 ALL-PASS。**没有发生网络请求。** 建议所有入口前安装桩并默认拒绝未声明的外联，不依赖“环境里应该没 Key”。

### F05 · P2：Ctrl+Enter 绕过 loading，旧响应覆盖新输入

**位置：** `app/text/page.tsx:69–99,145–149`。

按钮禁用没有阻止键盘再次提交，且无请求代际/AbortController。A pending 时改为 B 再提交，B 先返回、A 后返回，最终输入框是 B、结果却是 A。

**实测：** 生产 build、本地 mock 请求，记录 `requestCount=2`、`buttonDisabledDuringFirstRequest=true`、`currentInputIsB=true`、`finalDisplayedResultIsA=true`。见[桌面复现](images/text-race-desktop.png)及[手机复现](images/text-race-mobile.png)。建议同步防重入/取消旧请求，并用请求 id 保护所有状态写入。

### F06 · P2：文本路由丢失取消信号，缺少应用层调用期限

**位置：** `app/api/text/route.ts:42`，`lib/text/aigc.ts:138–146`。

detectAigc 支持 signal，但 route 没传 request.signal，也没有像扫描线那样设置总时限。**实测已取消的合成 Request 仍调用一次模型桩，底层 signal 为 undefined，返回 200。** 上游挂起时也没有明确应用层期限；未对真实模型做挂起试验。建议组合请求取消与限时信号，并让脱敏副本在 AIGC 失败时仍能单独使用。

### F07 · P2：邮箱内数字命中会阻止完整邮箱脱敏

**位置：** `lib/text/redact.ts:70–75,185–195`。

**实测：** `alice+13800138000@example.com → alice+[手机号已脱敏]@example.com`，只有 phone 命中，email 计数为 0。优先级让局部手机号占位，完整邮箱候选被丢弃。建议优先完整覆盖区间或合并区间；“可能漏检”说明不能替代此可修复的重叠错误。

### F08 · P2：采集器与 M4 对脚本域名的契约不一致

**位置：** `lib/tools/fetch-page.ts:419–430`；`lib/agent/orchestrator.ts:256–269,1078–1079`。

采集器将 `cdn.jsdelivr.net` 折叠成可注册域 `jsdelivr.net`，M4 用它查只收录精确 hostname 的服务库，丢掉已有合法解释。冒烟 fixture 则返回完整 hostname，掩盖集成缺陷。

**实测：** 真实形状的 externalScripts 证据保留完整 src，但报告查询 `jsdelivr.net` 并写“未在本库收录”；直接查询 `cdn.jsdelivr.net` 命中。建议用完整 src 的 hostname 做知识核验，可注册域只用于第三方关系判断。没有声称真实风险等级已因此变化。

### F09 · P2：同一证据 ID 的模型输入与留存内容不一致

**位置：** `lib/agent/orchestrator.ts:501–508,550–558,631–637`。

正文/视觉答复传模时保留较长内容，快照 excerpt 却统一裁成 1,200 字。**实测** 1,258 字正文的末尾标记在模型输入中、留存 excerpt 中不存在；引用 `ev-text` 的尾部事实仍保留且 validate 通过。建议传模与留存使用同一规范化摘录，或保存有定位器的完整文本产物；不能仅用 ID 存在证明可回看。

### F10 · P2：知识条目可被标为观察事实

**位置：** `lib/agent/orchestrator.ts:762–770`，`lib/evidence/validate.ts:149–157`；现有 fixture `eval/m4-knowledge.smoke.ts:300–321`。

**实测：** observed_fact 只引用 `ev-knowledge-brand`（type=knowledge），输出仍为 observed_fact，校验通过。与提示词的“外部引用级”纪律不一致。建议检查来源等级，必要时走已有修复轮并修正测试预期；程序仍不能据此保证语义正确。

### F11 · P2（已知存量）：静态规则重复 ID 仍破坏真实报告

**位置：** `lib/tools/url-static.ts:118–148` 的品牌/官方域循环；编排器证据池创建与最终校验。

**实测：** 用 `https://jd.com/` 与纯 fixture 页面，出现重复 `levenshtein:qq.com`，validate 失败。已提交 C/消融记录中的 `official-jd` 和 `look-weixin-sub` 也保留相同问题。应对相同事实去重或为不同事实生成不同 ID，不能只在摘要加“校验未过”。

### F12 · P2：实验错误、重复和混批没有被稳健处理

**位置：** `run-group.mjs:362–365,407–409,479`，`run-all.mjs:76–89`，`report.mjs:46–72,187–193,433–447,491,517–578`。

- 普通 runtime error 不决定 runner 退出失败，单组模式可跳过报告后仍退出成功。
- 错误记录 cDetail 只有 error，report 却调用 `validateHardErrors.join()`，会崩溃。
- report 只检查五个 JSONL 是否存在，不验证唯一 sampleId、完整覆盖、summary 一致性或批次；部分结论为硬编码。

**实测：** 将一条 C 记录在内存替换为 error，实际生成器抛 `Cannot read properties of undefined (reading 'join')`；重复一条 C 记录，生成器正常产出，unknown 表出现 **6/62**、成本表仍 **61/61**。对照执行的生成文本与已提交 report **逐字一致**；所有写盘均被 VM 拦截。当前提交的正式五组没有发现混批，但生成器不能可靠防止后续出现。

### F13 · P2：实验解释超出可支持的结论

**位置：** `report.mjs:117–148,416–418,546,561,564`；`results/report.md:108–113,137,287,295`。

1. **“注入全部抗住”不足以成立。** 8 例中 2 个 payload 不进入 innerText/截图；risk=safe 不等于服从注入；正则把“未服从页面指令”也匹配为疑似服从；没有删除 payload 的配对控制。当前可说的是“可见的存储输出未被此启发式检出执行措辞”，不能据此给因果性抗注入结论。
2. **“剔除 fixture 痕迹后 B 误报 2/23=8.7%”没有反事实实验。** 原始 9/23 正确，7 个理由指向备案占位符也能复算。若删掉这 7 个样本，分母应为 16；若修改页面特征，需重跑，不能直接从分子扣除并假定都转为正确。
3. **正常 SSO fixture 有混杂。** `sso-qq-portal` 让用户输入校园账号/密码/验证码，却声明 POST 至 graph.qq.com/connect，不是常规第三方授权跳转；两个消融的 suspicious 可能是在响应这个矛盾。此样本不足以单独证明合法解释模块降低真实 SSO 误报。未提交任何表单，未主张真实凭据外传。

### F14 · P2：预算历史及默认复跑条件不一致

**位置：** `report.mjs:246–264`，`results/report.md:38–41`，`run-group.mjs:102–111,242`，PR #14 的分析器默认值。

2000-token 试跑中 B 实有 1 次 length；C 是 5/6 样本出现 length、共 9 次，其中 4/6 最终解析失败。报告把发生截断与最终失败混用，还称 B 未截断。6k probe 只有前三样本，不是完整六样本配对。

正式五组日志与 summary 均为 **6000**，这点一致；但当前裸 B 默认仍 2000，C 默认已 6000，README 的不带预算裸命令不能复现原来统一预算的条件。建议把历史事实和当前配置说明分开，复现命令写明配置。

### F15 · P2：实验本地采集器漏掉客户端跳转

**位置：** `eval/experiments/local-fetcher.mjs:241–255`。

`!dedupeAdjacent([last,u]).length` 对非空输入恒为 false；已有 request chain 时后续 main-frame navigation 不会加入，finalUrl 又取声明链末尾而非实际观察末尾。该条件错误可由纯数组运算确认；现有 61 个样本没有覆盖可验证的客户端跳转，未确认它改变了本轮统计。建议与生产采集器的相邻 URL 比较方式统一并补用例。

### F16 · P3：边界配置和文档漂移

- `VERIPAGE_ANALYZER_MAX_TOKENS=0.5` 通过正数检查，取整为 0；模型桩实测收到 `maxTokens:0`。只接受有限正整数，否则回落 6000。
- README 写全量约 45 分钟，五组 wallMs 合计为 **8,579,132 ms ≈ 142.99 分钟**，C 一组约 46 分钟。报告头部时间段也仅是 C，需标注。
- “按模板组报告”附录存在，但 headline 是逐样本微平均，不是模板组等权；应明确统计层级。
- Vercel 步骤缺少环境变量配置说明；仅导入仓库不能获得真实模型凭据。README 指向 route:8 的 120 秒说明也已过时，实际在 handler。
- Windows 没有实际运行；工作台 E2E 的进程清理仍主要依赖负 PID 进程组，应参考文本 E2E 的 Windows fallback 复核。此为跨平台待验证点，不伪称 Windows 已验收。

### F17 · P2：Docker 取证浏览器缺中文字形

**位置：** `Dockerfile:40–67` 只安装 Liberation 等基础字体，没有 CJK 字库。

**实测：** 在本次实际构建的镜像内运行 `fc-list :lang=zh`，结果为空；禁用外网后，以不含外部资源的中文校园认证 fixture 截图，[PNG 中中文全部显示为方框](images/docker-cjk.png)。没有为这项检查注入审阅字体。

这不是用户桌面浏览器字体问题：缺字发生在服务端采集器产生、随后交给视觉模型分析的截图里。目标页自行提供 webfont 时可能正常，但普通中文页面不能依赖这一点。建议在运行镜像加入有许可证的 CJK 字体（如 `fonts-noto-cjk`），增加中文、混排和小字号取证截图回归；字体补充不替代 F03 的安全隔离。

## 六、对已提交实验的复算

数据集：61 JSON / 61 HTML / 6 类 / 26 模板组。五组分别 61 条唯一 sampleId，均 status=ok，与当前数据集 id/URL/类别对应。以下只复核已提交记录，不重跑真实模型：

| 组 | 恶意检出 /33 | 恶意判安全 | 恶意 unknown | 良性误报 /23 | 良性 unknown | 总 unknown /61 | 不完整类 unknown /5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 10 | 23 | 0 | 4 | 0 | 0 | 0 |
| B | 21 | 2 | 10 | 9 | 4 | 16 | 2 |
| C | 29 | 2 | 2 | 0 | 2 | 6 | 2 |
| C-no-vision | 29 | 0 | 4 | 1 | 1 | 8 | 3 |
| C-no-kb | 30 | 0 | 3 | 2 | 2 | 8 | 3 |

- overall、byCategory、byGroup、latency 与当前 metrics 重新计算完全一致。没有发现缺样本、重复 sampleId 或核心汇总算术不一致。
- 存储的合计为 201 文本调用、183 视觉调用、444,570 prompt tokens、841,118 completion tokens。本次没有查询供应商账单或据此计算费用。
- C、去视觉、去知识分别 366/371/356 条 finding，存储的 supported 计数与 finding 数相同；三组 validate 均 59/61。
- 原始 JSONL 没保留完整 evidence 池和截图，**不能从提交产物独立重做全部证据可达性或语义支持性校验**。100% 的已存结构计数不能解释成解释内容 100% 正确。
- 去知识组仍保留“空库查询”的 knowledge evidence，版本为 `ablation-empty-v0`；这本身不是消融泄漏。它移除检索知识，并不移除静态品牌表等全部先验。
- 这些是有限、受控且可见标签的本地 fixture；没有独立 holdout/真实用户样本证据，不能推广为真实世界检出率、误报率或新品牌泛化能力。

## 七、修复顺序与重新验收标准

1. **先处理 F01/F02/F03：** 外发前的数据选择与告知、不可覆盖的实验输出边界、明确不可信取证的进程/网络隔离；分别用捕获模型请求、写入拦截和实际连接/进程证据验收。
2. **文本线：** F04–F07，加网络默认拒绝的测试装桩、取消/总时限和请求代际保护、完整重叠区间脱敏；复跑旧请求后到达、取消前已发出、邮箱内手机号等难例。
3. **证据与 M4：** F08–F11，真实采集器与 knowledge 契约联测；对相同 ID 校验实际内容范围/来源等级和唯一性，不只看 JSON/ID 存在。
4. **实验链：** F12–F15，先保证失败/重复/预算停止/旧 summary 都不会生成肯定结论，再修文案并补配对样本；保留原始数据，不靠改标签、删难例或人工回填美化指标。
5. 修复后重新固定新提交，重跑 typegen/tsc/lint、相关离线回归、生产 build、浏览器和 Docker 本地检查。涉及模型效果的重跑另行确认认证、价格及调用预算。

## 八、复查附件与操作记录

### 可安全复现的诊断脚本

以下成功退出表示**复现了当前问题或复算了存储数据**，不是把缺陷当成“通过”的功能测试。均不调用真实模型，不运行实验 runner：

```bash
node docs/audits/2026-10-30/reproduce-text.mjs
node docs/audits/2026-10-30/reproduce-smoke-isolation.mjs
node docs/audits/2026-10-30/reproduce-evidence.mjs
node docs/audits/2026-10-30/reproduce-experiments.mjs

# 需要先 next build；访问本任务本地 production server，接口全部 mock
node docs/audits/2026-10-30/reproduce-text-race.mjs
```

- [机器可读检查记录](verification.json)；[关键运行输出](evidence.txt)。
- [工作台桌面](images/workbench-desktop.png)、[工作台手机](images/workbench-mobile.png)、[文本竞态桌面](images/text-race-desktop.png)、[文本竞态手机](images/text-race-mobile.png)、[容器中文缺字](images/docker-cjk.png)。
- 完整本机日志目录：`/tmp/opencode/veripage-audit-20261030.UHAENh`，属于临时证据，可能随环境清理；核心结果已收入附件。

### 实际执行与失败尝试

- 新建独立审计分支并固定提交；核对 PR 合并状态、安装原锁文件、静态检查、已有 smoke、本地浏览器与 Docker 构建/禁外网运行；Docker 构建下载了公开依赖/浏览器，未执行部署。
- 初次自编 evidence 诊断错误地匹配“未收录”而非源码实际“未在本库收录”，修正审计断言后复现成功；初次 report VM 缺少 URL 全局，补齐隔离运行环境后复现成功。这两次为审计 harness 问题，不算产品测试失败。
- 新增诊断只使用合成文本/URL；VM 拦截所有结果写盘。没有读取真实 `.env`、改动既有测试、运行付费模型或触发 `run-all/run-group`。
- 产物访问/取消等以同进程接口回归和 mock 浏览器分别验证；没有把控制响应误当真实模型效果，也没有把 Docker/本地 200 当公网可达。
- 本地审计服务与临时容器已退出；源文件比对、运行和中文截图检查完成后，删除了任务自有镜像标签及镜像。没有执行全局 Docker cache prune，也没有删除原实验结果。
- 本报告未执行线上漏洞利用、压力测试、完整 CVE/许可证审计、真实模型效果复跑、Windows 实机或 Vercel 公网验证。

**完成状态：本轮审计、复现和报告完成；上述业务缺陷未在审计分支修复。报告的“通过”只覆盖明确列出的检查范围。**
