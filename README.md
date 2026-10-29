# 网鉴 VeriPage

> 核验网页「声称的身份」与「实际行为」是否一致的 AI 安全检测台 —— 第九届传智杯 AI WEB 网页开发挑战赛参赛作品。

## 定位

不是"AI 查链接工具"，而是**证据驱动的身份一致性核验系统**：

- **四问框架**：身份声明 / 视觉语义 / 技术事实 / 合法解释
- **三道闸门**：字符串分析（不访问）→ 沙箱代访（Playwright）→ AI 取证（视觉+语义+案例库）
- **证据三级标注**：观察事实 / 风险推断 / 未知事项，每条结论必须绑定证据
- **负责任 AI**：可解释、无依据拒答、"未检出 ≠ 安全"边界声明、人工复核入口

## 快速开始

```bash
pnpm install
pnpm exec playwright install chromium   # 闸门②沙箱浏览器（国内可加 PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/）
cp .env.example .env   # 填入你的 Agnes API Key
pnpm dev
```

## 目录结构

```
app/          页面与 API Routes（检测过程 SSE 流式）
lib/          agent 自适应编排 / tools 六工具 / evidence 证据模型 / prompts
knowledge/    钓鱼案例库 + 官方域名核验白名单（带来源）
testpages/    自建可控靶场页（仿冒/注入样本，标注演示用）
eval/         对照实验脚本 + 测试集 + 结果
docs/         大题框架 / 模型能力实测 / 技术文档源
```

详细设计见 [docs/framework.md](docs/framework.md)。

## 团队

传智杯参赛队伍（同校 1-3 人），开发过程全程保留细粒度 Git 历史。
