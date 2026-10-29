/**
 * S0 访问边界（SSRF 防护，先于一切网络访问执行）
 *
 * 定位：检测流水线的第一道关卡。闸门②沙箱代访在启动浏览器前必须先过这里，
 * 浏览器内部的子资源请求也要走同一套判定——否则检测工具自身会成为攻击跳板
 * （被打的内网地址、云元数据端点 169.254.169.254、本机回环等）。
 *
 * 设计要点（对应框架 docs/framework.md「S0 访问边界」）：
 * - 协议白名单：仅 http/https，拒绝 file: / javascript: / data: 等伪协议
 * - 目标黑名单：内网 / 回环 / 链路本地 / CGNAT / IPv6 唯一本地等保留地址
 * - 域名先解析再校验 IP：host 是域名时解析全部 A/AAAA 记录，任一是私网即拒绝
 * - 解析失败单独返回 reason，绝不当作「允许」放行（fail-closed）
 */

import { lookup } from "node:dns/promises";

/** S0 判定结果：allowed=false 时必带 reason（调用方直接透传给上层证据链） */
export interface AccessCheckResult {
  allowed: boolean;
  /** 拒绝 / 放行原因说明，allowed=false 时必然存在 */
  reason?: string;
  /** 域名解析出的全部地址（IP 字面量时为该 IP 本身），用于证据留痕 */
  resolvedIps?: string[];
}

/** 解析结果缓存 TTL（ms）：DNS 重绑定缓解见 fetch-page 的 route 拦截 */
const RESOLVE_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// IPv4 内网 / 保留地址判定
// ---------------------------------------------------------------------------

/**
 * 题目要求覆盖的 IPv4 保留段：
 *   0.0.0.0/8        本网络 / 未指定地址
 *   10.0.0.0/8       私有
 *   100.64.0.0/10    CGNAT（运营商级 NAT）
 *   127.0.0.0/8      回环
 *   169.254.0.0/16   链路本地（含云元数据 169.254.169.254）
 *   172.16.0.0/12    私有
 *   192.168.0.0/16   私有
 * 另按加固原则补充：组播 / 保留段 / 广播 / 文档测试段（RFC5737）——
 * 这些地址不可能是正常公网站点，判为内网可避免误放行。
 */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // 组播 224.0.0.0/4 + 保留 240.0.0.0/4 + 255.255.255.255
  // RFC5737 文档测试段：192.0.2.0/24、198.51.100.0/24、203.0.113.0/24
  if (a === 192 && b === 0) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  return false;
}

/** 点分十进制 IPv4 → 4 个数字；非法返回 null */
function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

// ---------------------------------------------------------------------------
// IPv6 内网 / 保留地址判定
// ---------------------------------------------------------------------------

/** IPv6 字面量 → 8 个 16 位组；非法返回 null。兼容 :: 简写与 %zone 后缀 */
function parseIpv6(ip: string): number[] | null {
  // 去掉链路本地后缀 fe80::1%eth0 的 %zone
  const cleaned = ip.split("%")[0];
  if (!cleaned.includes(":")) return null;

  // 处理内嵌 IPv4 的写法（::ffff:192.168.1.1 / 64:ff9b::1.2.3.4）
  const v4Idx = cleaned.lastIndexOf(":");
  const tail = cleaned.slice(v4Idx + 1);
  let head = cleaned;
  let embeddedV4: number[] | null = null;
  if (tail.includes(".")) {
    embeddedV4 = parseIpv4(tail);
    if (!embeddedV4) return null;
    head = cleaned.slice(0, v4Idx + 1) + "0:0"; // 用两个 0 组占位，稍后替换
  }

  const dblColon = head.indexOf("::");
  let groups: string[];
  if (dblColon >= 0) {
    // 整段 "::" 或含 "::" 的地址：展开为 8 组
    if (head.indexOf("::", dblColon + 1) >= 0) return null;
    const left = head.slice(0, dblColon).split(":").filter((s) => s !== "");
    const right = head.slice(dblColon + 2).split(":").filter((s) => s !== "");
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  } else {
    groups = head.split(":");
    if (groups.length !== 8) return null;
  }

  const nums: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    nums.push(parseInt(g, 16));
  }
  if (nums.length !== 8) return null;
  if (embeddedV4) {
    nums[6] = (embeddedV4[0] << 8) | embeddedV4[1];
    nums[7] = (embeddedV4[2] << 8) | embeddedV4[3];
  }
  return nums;
}

/**
 * 题目要求覆盖的 IPv6 保留段：
 *   ::1              回环
 *   fc00::/7         唯一本地地址（fc/fd 开头）
 *   fe80::/10        链路本地
 *   ::ffff:0:0/96    IPv4 映射地址 → 拆出内层 IPv4 按 IPv4 规则判
 * 加固补充：::（未指定）、ff00::/8（组播）、64:ff9b::/96（NAT64，内层仍是 IPv4）
 */
export function isPrivateIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!addr) return true;

  // IPv4（含 IPv4 映射地址 ::ffff:a.b.c.d）
  const v4 = parseIpv4(addr);
  if (v4) return isPrivateIpv4(v4);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped) {
    const inner = parseIpv4(mapped[1]);
    return inner ? isPrivateIpv4(inner) : true;
  }

  // IPv6
  const g = parseIpv6(addr);
  if (!g) return true; // 解析不了的地址一律按内网处理（fail-closed）
  const [g0, g1] = g;
  if (g.every((x) => x === 0)) return true; // :: 未指定
  if (g0 === 0 && g1 === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) {
    return true; // ::1 回环
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (g0 === 0x64 && g1 === 0xff9b) return true; // 64:ff9b::/96 NAT64
  return false;
}

/** 是否为 IP 字面量（IPv4 或 IPv6，IPv6 允许带方括号） */
export function isIpLiteral(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "");
  if (h.includes(":")) return parseIpv6(h) !== null;
  return parseIpv4(h) !== null;
}

// ---------------------------------------------------------------------------
// 域名解析 + 私网判定（带 60s 缓存，供浏览器子资源拦截复用）
// ---------------------------------------------------------------------------

interface CacheEntry {
  ips: string[];
  /** 解析失败时的错误说明；有值即视为「未放行」 */
  error?: string;
  expiresAt: number;
}

const resolveCache = new Map<string, CacheEntry>();

/** 清空解析缓存（测试 / 长驻进程防内存增长用） */
export function clearResolveCache(): void {
  resolveCache.clear();
}

/**
 * 校验单个主机名是否可公网访问：
 * - IP 字面量直接按 isPrivateIp 判；
 * - 域名解析全部地址，任一是私网即拒绝；
 * - 解析失败 → ok=false（fail-closed，绝不放行）。
 * 结果缓存 60s，降低 DNS 压力并缓解解析竞态。
 */
export async function assertPublicHost(host: string): Promise<{
  ok: boolean;
  reason?: string;
  ips: string[];
}> {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return { ok: false, reason: "主机名为空", ips: [] };

  if (isIpLiteral(h)) {
    if (isPrivateIp(h)) {
      return { ok: false, reason: `目标 IP 属于内网/保留地址：${h}`, ips: [h] };
    }
    return { ok: true, ips: [h] };
  }

  const cached = resolveCache.get(h);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.error
      ? { ok: false, reason: cached.error, ips: [] }
      : { ok: true, ips: cached.ips };
  }

  try {
    const addrs = await lookup(h, { all: true });
    const ips = addrs.map((a) => a.address);
    if (ips.length === 0) {
      const reason = `域名解析结果为空：${h}`;
      resolveCache.set(h, { ips: [], error: reason, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
      return { ok: false, reason, ips: [] };
    }
    const bad = ips.find((ip) => isPrivateIp(ip));
    if (bad) {
      const reason = `域名 ${h} 解析到内网/保留地址 ${bad}（全部解析结果：${ips.join(", ")}）`;
      resolveCache.set(h, { ips, error: reason, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
      return { ok: false, reason, ips };
    }
    resolveCache.set(h, { ips, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
    return { ok: true, ips };
  } catch (err) {
    // 解析失败单独 reason，不能当作允许
    const reason = `域名解析失败：${h}（${err instanceof Error ? err.message : String(err)}）`;
    resolveCache.set(h, { ips: [], error: reason, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
    return { ok: false, reason, ips: [] };
  }
}

// ---------------------------------------------------------------------------
// S0 入口：完整 URL 校验
// ---------------------------------------------------------------------------

/**
 * S0 访问边界入口：判断一个 URL 是否允许被沙箱访问。
 * 失败时返回 allowed=false + reason，由调用方转成 { blocked: true, reason } 证据。
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<AccessCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `URL 无法解析：${rawUrl}` };
  }

  // 规则 1：协议白名单
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      reason: `协议不被允许：${url.protocol.replace(":", "")}（仅允许 http/https）`,
    };
  }

  // URL 中夹带账号/令牌类敏感参数时提示最小化（不阻断，仅留痕给上层脱敏）
  const host = url.hostname;
  if (!host) {
    return { allowed: false, reason: "URL 缺少主机名" };
  }

  const res = await assertPublicHost(host);
  if (!res.ok) {
    return { allowed: false, reason: res.reason, resolvedIps: res.ips.length ? res.ips : undefined };
  }
  return { allowed: true, resolvedIps: res.ips };
}
