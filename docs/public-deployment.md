# 公网评测部署状态

**2026-11-15：已启用直接 IP HTTPS，受邀入口为 [https://43.136.20.106/login](https://43.136.20.106/login)。已恢复 Chromium 沙箱、接入 DeepSeek，并按用户现有材料集成本机案例、导入导出与个人复核；独立部署分支发布正在收口。无需域名或 DNS 配置。**

## 代码与范围

- 远程仓库：`https://github.com/mostny/veripage.git`。
- 本次取回的远程 `main`：`d00605a66561bda2ba75ed221b7e356e5296112f`，比原本地提交领先 6 个提交。
- 部署工作目录：`/workspace/传智杯/veripage-public`；分支：`deploy/public-prep-2026-11-14`。
- 原工作区 `/workspace/传智杯/veripage` 的未提交修改完整保留；按用户最新确认，选择性复制本机案例功能到部署分支，未直接覆盖原目录或合并其全部改动。
- 部署分支额外增加受邀评测登录、接口鉴权、账号生成脚本与部署模板；新增修改尚未提交或推送。
- 同时修复构建追踪将私密 `.env` / 账号文件列入打包清单的问题，仅标记运行时临时文件路径，不改变取证存储行为。

项目为 Next.js 16 / React 19 应用，包含链接检测和文本体检两条线。链接检测经 S0 公网地址准入、静态分析、Playwright 取证、模型分析和知识检索形成 SSE 证据报告。临时截图为单实例内存注册表与本地临时文件，默认保留 15 分钟；新增本机保存会复制报告与可用 PNG 到浏览器 IndexedDB，历史回看不重扫。

## 评测账号

- 登录入口：`/login`；账号：`reviewer`；不开放注册。
- 已生成的随机密码在工作目录的 **`.env.reviewer-account`**，文件权限 `0600`。负责人从该私密文件取出密码，提交比赛评测平台；不要放入 README、截图或公网文件目录。
- `.env` 仅含 scrypt 密码哈希、随机会话签名密钥及运行配置，不含登录明文密码。两个文件均被 Git 与 Docker 构建上下文排除。
- 登录后 HttpOnly、SameSite=Lax 会话有效 12 小时；HTTPS 下使用 Secure Cookie。退出会删除当前浏览器 Cookie。
- 更换密码哈希或会话密钥并重启服务会使旧会话失效。普通退出不提供服务端吊销已复制令牌的功能。
- 所有业务页面要求登录；扫描、文本和临时证据 API 各自在处理输入前校验签名与有效期。写 API 校验 `Origin`，登录接口全实例每分钟最多处理 10 次密码尝试。
- 这是单实例、单受邀账号的评测入口，不是面向公众的多用户系统。

新环境首次初始化：

```bash
pnpm install --frozen-lockfile
node --experimental-strip-types scripts/create-reviewer.mjs reviewer https://43.136.20.106
# 已有 .env 或 .env.reviewer-account 时脚本拒绝覆盖，保留原配置。
```

本机现有账号已经初始化，不需要再次运行生成命令。Bitwarden CLI 已安装，但没有项目令牌配置；本次按用户明确授权，通过官方 OpenCode CLI 定向读取活动 DeepSeek API 连接并注入本机私有 `.env`，未输出密钥、未修改 OpenCode 凭据或写入密码库。

## 当前云主机部署路径

实际采用 **Node 生产模式 + systemd + 独立 Caddy IP HTTPS 入口**。原先 Docker 构建受主机镜像源 DNS 故障阻塞，已改用项目支持的 Node 自托管方式上线登录入口；Docker 不是本次 IP 入口的前置条件。Vercel 基线未适配 Chromium，不作为本次部署目标。

- 公网 IPv4 `43.136.20.106` 来自云主机元数据；外部请求已确认该 IP 的 HTTP 80 与 HTTPS 443 可达。没有把代理出口 IP 当作主机地址。
- 现有 Nginx 1.8.1 未编译 TLS 模块。因此安装官方 Caddy **2.11.9** 至 `/opt/veripage-caddy/caddy`，独立承接 HTTPS；原 Nginx 配置与 80 端口既有路由保持原状。
- `veripage-app.service`：专用非登录系统用户 `veripage`，Next 生产模式，仅监听 **`127.0.0.1:3080`**，启用 `NoNewPrivileges` 与私有临时目录。
- 浏览器运行程序位于 root 所有、应用账号不可修改的 `/opt/veripage-playwright`；私有中文字体位于 `/opt/veripage-fonts`，只通过本站 `FONTCONFIG_FILE` 配置使用，不安装全局字体。
- `veripage-https.service`：独立非登录用户 `veripage-https`，仅授予绑定低端口能力，监听 TCP 443，关闭管理 API、HTTP 自动跳转与 HTTP/3；转发到应用回环端口，支持 SSE。
- 两个服务均已启用开机自启并处于运行状态。主机 UFW 仅新增本站 **IPv4 TCP 443** 规则；未新增 UDP 或其他端口规则。
- 当前 `.env` 中 `VERIPAGE_PUBLIC_ORIGIN=https://43.136.20.106`，权限 `0600`、归应用运行用户；明文评测账号文件仍为 `root:root`、`0600`，HTTPS 进程不能读取应用配置或明文账号文件。
- 源配置：`deploy/Caddyfile`、`deploy/veripage-app.service`、`deploy/veripage-https.service`；实际安装位置分别为 `/etc/veripage/Caddyfile`、`/etc/systemd/system/`。

```bash
cd /workspace/传智杯/veripage-public
systemctl status veripage-app.service veripage-https.service
# 修改模型环境配置后重启应用；修改 HTTPS 配置后校验并重启对应服务
systemctl restart veripage-app.service
node eval/reviewer-auth.http.mjs https://43.136.20.106
```

### IP 证书与自动续期

- 已签发受信任的 Let's Encrypt IP 证书，SAN 为 `43.136.20.106`，签发链为 `Let's Encrypt YE2`。
- 本轮首次签发证书有效期：**2026-11-15 05:35:42 UTC 至 2026-11-21 21:35:41 UTC**。IP 证书采用 `shortlived` profile，约 160 小时有效期。
- 使用 **TLS-ALPN-01 / TCP 443** 完成验证，无需域名、DNS 或占用 Nginx 的 80 端口；显式限定 Let's Encrypt 公共 ACME 签发，不使用付费 CA API。
- Caddy 已启用证书维护与自动续期，已获得 CA 的 ARI 续期窗口；尚未经历未来的实际续期周期，不将「已配置」表述为「已完成续期实测」。
- ACME 账号、证书与私钥保存在 HTTPS 用户私有目录 `/var/lib/veripage-https/data/caddy`，不在 Git 或应用构建上下文中。保持 443 可达、该目录持久保留及 HTTPS 服务运行，续期才能持续工作。

官方依据：[Let's Encrypt IP 证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Caddy ACME profile 与 TLS 配置](https://caddyserver.com/docs/caddyfile/directives/tls)。公网访问必须使用上方 **`https://`** 链接；原 HTTP 80 默认页不改为本站跳转，以保留其他项目行为。

Docker 配置仍保留，端口也仅映射 `127.0.0.1:3080`。当前 Node 服务已使用该端口，不能同时启动同端口的 Docker 实例；将来切换部署方式时先停止当前应用服务。

## 模型与浏览器运行条件：原阻塞已解除

1. **模型**：当前端点 `https://api.deepseek.com`，文本与视觉均为 `deepseek-flash`，显式配置 `VERIPAGE_MODEL_THINKING=disabled`。官方鉴权、模型列表和余额可用状态已验证；原有空配置已补齐。小规模真实调用、完整链接扫描和文本体检接口已成功，历史 StepFun 61 样本结果不作为当前 DeepSeek 检出率。
2. **Chromium 沙箱**：内核审计记录明确显示旧浏览器触发 `unprivileged_userns` 的 `sys_admin` 拒绝。经用户批准，将可信浏览器程序部署到 root 只读固定路径，并添加仅匹配该路径的 `/etc/apparmor.d/veripage-chromium` 兼容规则，沿用系统 Chrome 的 `userns` 授权方式。全局 AppArmor 限制仍为 `1`，`NoNewPrivileges` 保留，`chromiumSandbox=true`，未启用 `--no-sandbox`、未安装 SUID 帮助程序。实际浏览器启动、进程 AppArmor 标签和中文截图均已核验。
3. **凭据最小化**：取证浏览器启动环境过滤 `VERIPAGE_*` 与 `BWS_ACCESS_TOKEN`；已在父进程加载项目凭据后，检查实际 Chromium `/proc/.../environ` 不含这些变量。保留 HOME、PATH 和字体配置。模型上游错误文本也会删除配置密钥的字面值，避免错误反馈回显密钥。

### 仍需明确的边界与交付事项

- **隔离不是全面闭合**：专用 AppArmor 规则为兼容 Chromium 用户命名空间，`flags=(unconfined)` 不提供额外的文件系统/网络细粒度限制；真正的渲染隔离由 Chromium 自身命名空间/seccomp 沙箱承担。采集与模型服务仍同 UID，浏览器权限层面仍可能读取该 UID 的文件；环境过滤不等于完整凭据进程隔离。实际连接 IP 固定、独立出口与弹窗/下载/Service Worker 全面拦截仍未建立。保持受邀、受控评测用途，不宣称面向任意不可信目标的全面隔离。
- **输入与留存**：文本原文先到本站服务器，默认仅将服务端脱敏副本发送给模型；勾选知情选项才发送原文。目标 URL 通过短时内存进入 `/scan`，不写应用导航 query；刷新或离开后不自动重新检测。短期取证产物默认 15 分钟后不可访问；本机报告/PNG/个人意见独立留存在当前浏览器，清理站点数据可能丢失。截图等内容不保证已完全脱敏，不作“输入绝无留存”的承诺。
- **交付材料**：PDF 和视频已由用户确认制作完成，本次不再重制或替换。用户确认材料包含本机案例功能，故选择性集成该功能以便评审复现。源码推送仅限用户批准的独立部署分支，不合并 main。

## 本次验证结果

- 鉴权离线冒烟：**31 项通过**；包含错误密码、篡改/过期会话、配置缺失关闭访问、跨站写拒绝、账号文件权限与拒绝覆盖，新增直接公网 IP 的 HTTPS origin / Secure Cookie / 同源写检查。
- 原有文本线冒烟通过；产物存储与任务隔离 35 项通过；Docker 配置静态断言 6 项通过。
- 路由类型生成及 TypeScript 检查通过；登录代码只读审查未发现重要缺陷。
- Docker 镜像构建：阻塞于主机镜像源 DNS，未启动容器。
- Node 22.23.3 / Next 16.4.3 生产构建通过。首次构建提示临时产物路径追踪整个项目，清单中确实包含 `.env` 与 `.env.reviewer-account`；修复后重新构建无该警告。
- 生产输出追踪检查通过：扫描与证据读取清单分别为 **215 / 116** 项，登录/退出各 116 项，四个清单均不含私密配置或 Git 文件。
- 实际 `next start` 生产 HTTP **23 项通过**，包括生成账号登录、错误密码、Cookie 属性、登出、未登录/伪造会话/跨站写拒绝、真实 JS 资源、缓存控制、S0 阻断与 SSE、临时证据文件写入/读取及任务归属。未调用真实模型。
- 本轮通过公网 **`https://43.136.20.106`** 重跑原有 23 项检查，并补充 `.env` / 明文账号文件对已登录用户也不可经 HTTP 读取的检查，共 **25 项全部通过**；登录 Cookie 实际为 Secure。外部获取 `/login` 得到正确评测表单、TLS 信任验证通过。公网 JS 资源 `/_next/static/chunks/19zbbi9uufwhd.js` 返回 200，27,038 字节，与本地生产产物字节一致。
- Caddy 配置以其实际非 root 服务身份验证通过；systemd unit 验证通过（主机另有既存 `tat_agent` PIDFile 旧路径警告，与本站 unit 无关）。实际证书 SAN/签发者/有效期与服务运行身份均已核验。
- IP HTTPS 部署切片的只读复核未发现重要问题，覆盖 TLS 入口、证书维护配置、两份 service、IP 同源与接口保护；复核未将未来续期视作已发生。
- 受影响文件 ESLint、`git diff --check` 通过。Node 原生 TS 冒烟有包未声明 module 类型的警告，不影响上述测试通过。
- 初次原生截图因桌面窗口不可见失败，root 备用截图也因沙箱不可用失败；现已改为授权的非 root 严格沙箱 Playwright 路线完成实际浏览器验证与截图查看，未降低浏览器隔离。
- 真实公网浏览器链路：完成错误密码反馈、真实评测登录、Secure/HttpOnly Cookie、首页提交、SSE 报告、截图读取、手机无横溢出及退出后保护；`https://example.com/` 的 6 个阶段全部 completed，结果 `no_significant_risk`、证据充分度 `partial`。受控的本站 `/login` 也完成全部阶段，模型标为 `suspicious`；这是对 IP 登录页的功能样本输出，不将其包装成恶意检出成功或当前准确率指标。两次均无未捕获浏览器错误。
- 工作台受控 E2E **11 项通过**，包含双向证据联动、390/360px 布局、意外 EOF、实际点击重试并恢复、截图过期和明确失败提示；使用假 SSE 与假模型端点，不作为真实模型证据。
- 文本页修复客户端/服务端模块边界后，完整受控 E2E **36 项通过**，包含默认脱敏告知、知情原文选项、键盘提交、剪贴板、390/360px 布局、错误反馈、请求取消代际及旧响应不能覆盖新结果；桌面/手机截图已实际查看，中文正常。使用假接口结果，不冒充真实模型输出。
- 真实文本接口：合成手机号/邮箱样本返回 200，约 1.65 秒完成；两类 PII 均替换，模型输出 `undetermined` 并附 3 条保留意见。这是功能验证，不证明 AIGC 识别准确率。
- 集成前生产构建 `4rcGR3Ni6H6RsJhRuamSE` 已通过权限 HTTP 25 项及文本页回归。当前案例功能构建为 `AyYY5iwpZ5rcWRyf-qzOC`，生产构建、类型检查、四份 NFT 隐私检查及 19 个公开 JS 私密字面值检查通过，两个常驻服务运行正常。
- 新增原生 IndexedDB 复核 **14 项**、案例包边界/事务 **26 项**、扩展工作台浏览器 **123 项**通过；已在实际公网浏览器完成一次真实检测→本机保存→个人更正→导出→删除→导入→刷新回看，截图/两条个人意见恢复，模型原判未被覆盖，历史过程没有新扫描或短期产物恢复请求。案例页匿名保护已纳入 **27 项**公网鉴权回归。详见 [评测核对](evaluation-readiness.md)。
- 上一轮临时验证服务已停止；本轮改为上述 systemd 常驻服务，HTTPS 已启用并外部验收。原基于域名且要求 Nginx TLS 模块的模板已由直接 IP Caddy 配置替代。

### 执行记录与后续复核

- `git fetch origin` 成功，独立 worktree 从远程最新版建立；原目录的 31 个已跟踪改动和 22 个未跟踪条目保留。
- 主机没有 PATH 中的 pnpm；用 `npm exec --package=pnpm@11.21.0` 安装锁定依赖，新增会话库 `jose@6.2.17`，未改动全局包管理器。
- 生成账号只输出文件路径和非秘密状态。`.env` 与 `.env.reviewer-account` 均为 `0600`，Compose 元数据检查确认身份变量已注入、模型 Key 尚为空。
- README 首次补丁因远程文案与原工作区不同被保护机制拒绝，未应用；重新读取远程文件后按实际内容更新成功。
- Docker 构建失败后先用 Node 自托管方式验证应用，本轮再以 systemd 常驻部署；Docker 守护进程配置、现有 Nginx 与其他站点保持原状。
- 上一轮浏览器补充观察的临时服务达到工具 120 秒时限后退出，当轮收尾确认 `3080` 无监听并关闭任务标签；本轮 `3080` 已由正式应用服务监听。
- 本轮初始 Let's Encrypt 文档地址返回 404，搜索后改用官方实际页面确认 IP 证书能力。GitHub 发布元数据查询返回 403，改用官方 Caddy 下载接口成功获取 `2.11.9`；未安装 Certbot、未改动 Nginx 来兼容 TLS。
- 新建两个仅用于本站的非登录系统账号、安装两个 systemd unit 和 Caddy 配置，仅新增 IPv4 TCP 443 防火墙规则；证书首次签发成功，自动续期已配置。取证浏览器的真实沙箱启动检查失败，保留该结果为完整链路阻塞。
- 上一项沙箱失败已通过本轮项目专用规则解除；首次模型导出检查错误假设了凭据类型 `api`，随后按当前官方 CLI 元数据 `key` 类型修正，未输出秘密值。一次小样本视觉 JSON 围栏导致测试解析失败，修正后通过。
- 一次生产构建因测试环境映射被 Next 的 `ProcessEnv.NODE_ENV` 类型约束拒绝，已将参数改为准确的只读字符串映射并重建成功。浏览器测试首次通过 CDP 读取已被 UI 取消的 SSE body 失败，改为只读观察同一消费者的 `read()`，不克隆流、不改变取消行为；重试断言曾将框架空 live-announcer 当作应用错误，改为检查 `main` 内真实错误并通过。
- 文本页 E2E 发现页面加载错误：客户端直接从 API Route 导入长度常量，间接载入服务端鉴权依赖；现已提取 `lib/text/constants.ts`，保留服务端常量导出兼容，完成生产重建与 36 项完整浏览器复测。
- 模型选项与上游错误脱敏离线检查通过；构建追踪继续排除私密文件，并对 15 个公开 JS 文件检查配置密钥、会话签名密钥与密码哈希的字面值，未发现嵌入。

复核命令（在部署目录执行）：

```bash
node --experimental-strip-types eval/reviewer-auth.smoke.ts
node --experimental-strip-types eval/text-line.smoke.ts
node --experimental-strip-types eval/artifact-store.smoke.ts
node eval/dockerfile.check.mjs
# 如需重建，在维护窗口先停止应用，构建/追踪检查通过后再启动，避免运行中改写 .next
systemctl stop veripage-app.service
pnpm build && node eval/reviewer-tracing.check.mjs && systemctl start veripage-app.service
# 当前生产服务已运行；直接验证公网 HTTPS，不另起同端口实例
node eval/reviewer-auth.http.mjs https://43.136.20.106
```

最后一条 HTTP 验证会在服务器内读取私密账号文件，仅向明确指定的本站 origin 提交账号，不打印密码；目前使用直接公网 IP，不需要配置域名。
