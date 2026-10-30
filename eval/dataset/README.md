# W3 对照实验数据集（本地 fixture）

> 61 个样本 / 6 类 / 26 个模板组。全部由本地 HTTP fixture 承载（`eval/experiments/fixture-server.mjs`），
> **不访问任何外部真实站点**——既不稳又慢，还花钱。

## 结构

```
eval/dataset/
  samples/<id>.json   每个样本一个 JSON
  pages/<id>.html     样本页面（本地 fixture 内容）
```

样本 JSON 字段：

| 字段 | 说明 |
|---|---|
| `id` | 样本唯一 id |
| `group` | 模板/站点组（同模板同站点归同组，评分按组报告，防重复样本灌水） |
| `category` | official / sso / lookalike / visual / incomplete / injection |
| `url` | 公开 URL（闸门①分析与 fetcher 映射的唯一键；fixture 在本地，URL 是对外呈现的地址） |
| `expectRisk` | 期望判定：良性类 `no_significant_risk`，恶意类 `suspicious`（即 suspicious 及以上），取证不完整类 `unknown` |
| `page` | 相对本目录的 HTML 路径 |
| `hops` | 可选：公开跳转链（不含起始 URL，含最终落地 URL）；本地用真实 30x 逐跳实现 |
| `blacklist` | 可选 true：该域在 A 组简易黑名单内（模拟已被威胁情报收录的已知恶意域，共 6 个） |
| `httpStatus` | 可选：fixture 返回的 HTTP 状态（404/500 样本用） |
| `notes` | 样本设计意图 |

## 类别与规模（取任务书各类别下限，合计 61）

| 类别 | 数量 | 期望 | 说明 |
|---|---|---|---|
| 正常官网 official | 15 | no_significant_risk | 真域名 + fixture 仿写首页；其中 jd.com / abchina.com / cmbchina.com 会命中闸门①编辑距离误报（真实规则缺陷，如实入集） |
| 正常 SSO/授权登录 sso | 8 | no_significant_risk | 指向已收录 SSO 提供方的登录/跳转（QQ/GitHub/微信/微博/Google/CDN），含 1 个短链展开到官网的合法解释样本 |
| 相似域名仿冒 lookalike | 15 | suspicious+ | 编辑距离 1-2 / 子域伪装 / 多级后缀 / punycode 同形 / 品牌+安全词分层；6 个在黑名单内 |
| 视觉仿冒 visual | 10 | suspicious+ | 同模板换 logo/配色，域名与官方无关（闸门①零命中，只能靠视觉+内容） |
| 验证码/失败页 incomplete | 5 | unknown | 验证码拦截 / 404 / 空页 / 500 / 纯 JS 渲染（考「取证不完整」的诚实度） |
| 提示注入页 injection | 8 | suspicious+ | 正文可见注入 4 + 隐藏文本注入 4（display:none / font-size:0+透明 / HTML 注释 / 白字白底） |

## 运行方式

见 `../experiments/README.md`。加载顺序按类别轮转，`--limit 6` 的小样本试跑天然每类 1 个。
