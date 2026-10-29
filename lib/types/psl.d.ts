/**
 * psl 1.15.0 的最小类型声明。
 * 该包的 types 位于 node_modules/psl/types/index.d.ts，但其 package.json 的
 * "exports" 未暴露该路径，TS 默认解析不到，这里补齐项目用到的两个函数签名。
 */
declare module "psl" {
  /** 取可注册主域（eTLD+1）；无法解析时返回 null */
  export function get(domain: string): string | null;
  /** 解析域名各组成部分 */
  export function parse(domain: string): {
    tld: string | null;
    sld: string | null;
    domain: string | null;
    subdomain: string | null;
    listed: boolean;
    input: string;
    error?: boolean;
  } | null;
  export function isValid(domain: string): boolean;
}
