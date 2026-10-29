import { get as getPublicSuffixDomain } from "psl";
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
export function withPsl(host) {
  const h = host.trim().toLowerCase();
  console.log("[DBG2] typeof h =", typeof h, "startsWith:", typeof h.startsWith, "endsWith:", typeof h.endsWith);
  if (!h) return host;
  if (IPV4_LITERAL.test(h)) return h;
  // IPv6 字面量：URL.hostname 带方括号（[::1]），剥掉后原样返回
  if (h.startsWith("[") && h.endsWith("]")) {
    const inner = h.slice(1, -1);
    if (inner.includes(":")) return inner;
  }
  return getPublicSuffixDomain(h) ?? h;
}
console.log("direct:", JSON.stringify(withPsl("[::1]")));
