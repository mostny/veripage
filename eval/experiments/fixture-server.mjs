/**
 * 本地 fixture HTTP 服务器（W3 对照实验专用）
 *
 * 手法参考 eval/workbench.e2e.mjs（起本地服务承载页面）与 eval/m4-knowledge.smoke.ts
 * （随机端口 127.0.0.1 HTTP fixture）。全部样本由本地服务承载：
 *   GET /page/:id      返回样本 HTML（httpStatus 默认 200，404/500 样本按样本声明返回）
 *   GET /hop/:id/:n    302 跳转到下一跳（最后一跳跳到 /page/:id），实现真实多级跳转链
 *
 * 纪律：不访问任何外部站点；所有脚本/图片等子资源由 fetcher 的 route 拦截直接中止，
 * 只采集 DOM 中的声明式事实（script[src] 列表），不产生真实外网请求。
 */

import { createServer } from "node:http";

export function startFixtureServer(samples) {
  const byId = new Map(samples.map((s) => [s.id, s]));

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }

    if (parts[0] === "page" && parts.length === 2) {
      const sample = byId.get(parts[1]);
      if (!sample) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("fixture not found");
        return;
      }
      res.writeHead(sample.httpStatus, { "content-type": "text/html; charset=utf-8" });
      res.end(sample.html);
      return;
    }

    if (parts[0] === "hop" && parts.length === 3) {
      const sample = byId.get(parts[1]);
      const index = Number(parts[2]);
      if (!sample || !Number.isInteger(index) || index < 0 || index > sample.hops.length) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("fixture hop not found");
        return;
      }
      const next = index < sample.hops.length - 1 ? `/hop/${sample.id}/${index + 1}` : `/page/${sample.id}`;
      res.writeHead(302, { Location: next, "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>redirecting to ${next}</body></html>`);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
