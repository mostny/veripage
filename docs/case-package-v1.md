# 单案例 JSON 包 v1

入口：历史详情的“导出案例包”；本机案例页的“导入案例包”。文件仅在当前浏览器处理，不上传模型或服务器。

## 格式

```text
format: "veripage-case"
version: 1
exportedAt: 可解析时间字符串
record:
  id / snapshot / savedAt / retention
artifacts:
  [{ artifactId, mediaType: "image/png", data: 不带 data: 前缀的 base64 }]
reviews:
  [ReviewEvent，数组顺序就是提交顺序]
```

- JSON 文件 ≤16 MiB；单 PNG ≤8 MiB，头部及实际解码尺寸 ≤16,000,000 像素。
- 每个集合最多 1000 项；普通文本字段最多 262144 个 JS 字符单元，编号最多 256；case id 为最多 128 位的字母数字/下划线/连字符路径标识。
- 快照显式读取声明字段，校验枚举、证据引用、编号及产物关联；未知 JSON 属性不写入本机记录。
- `saved` 记录必须有相同 id、正确字节数的可解码 PNG，且属于截图证据；`missing` 必须说明缺失，`omitted` 不再作为活动产物引用。
- 复核必须属于同一 case，id 不重复，操作顺序合法，`actor=local_user`。更正必须有个人风险，标记/维持不得带个人风险。

## 导出与隐私

导出从一个只读事务读取快照、Blob 和意见，生成规范化副本，不修改本机原判或旧记录。
默认不导出原始 URL 等非截图取证副本；其活动引用从导出副本移除，但证据 id、结论引用和有意省略说明保留。
已知 URL 参数按现有规则最小化；模型结论、截图和个人理由仍可能包含敏感信息，下载前必须确认。文件不加密、不签名，不是平台认证或不可篡改审计。

## 导入与冲突

先完成 JSON/版本/结构/PNG 解码与关系/复核顺序校验，再开启一个写事务提交 cases、artifacts、reviewEvents。
已有 case id 明确拒绝覆盖；复核编号冲突或中途写入失败也整体回滚，不静默合并。
导入按数组顺序重新分配本机自增提交键，保留事件 id、时间和原始机器判断；不按时间戳重排。
不执行 HTML，不加载远程资源，也不因恢复案例重新扫描或训练模型。

实现：`lib/cases/package.ts`。边界/原生 IndexedDB 验证：`eval/case-package.e2e.mjs`；完整浏览器往返流程：`eval/workbench.e2e.mjs`。
