/**
 * 实验壳参数与产物路径守卫（审计 2026-10-30 F02/F12）
 *
 * 纯函数、零 IO，可被单测直接导入（guards.test.mjs）：
 * - 数值参数必须是有限正整数（--limit oops → NaN → 全量 61 样本、--max-text oops → 预算比较失效，都在打开/清空任何文件之前拒绝）；
 * - 试跑隔离（--tag/--dir）规范化后必须严格位于 results/ 内的子目录（拒绝 "." / "./" / ".." / 绝对路径 / "results" 本身 / 越出 results 的路径）；
 * - --out 只接受纯文件名（拒绝任何路径分隔符，防 --dir trial --out ../A 定位到正式 results/A.jsonl）；
 * - 已有目标产物默认拒绝覆盖，除非显式 --overwrite（由调用方配合 existsSync 使用）。
 */

import path from "node:path";

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardError";
  }
}

/**
 * 运行器退出码（审计 F12：runtime error 必须决定 runner 退出码）：
 * 有 error 记录 → 4（即使同时预算停止）；仅预算停止 → 3（如实记录不算失败，但 run-all 会提示）；全部成功 → 0。
 */
export function runnerExitCode({ errorCount = 0, budgetStopped = false } = {}) {
  if (errorCount > 0) return 4;
  if (budgetStopped) return 3;
  return 0;
}

/**
 * 有限正整数校验：接受数字或纯数字字符串；NaN / Infinity / 小数 / 0 / 负数 / 空值一律拒绝。
 * @returns {number}
 */
export function parseFinitePositiveInt(raw, name) {
  if (raw === null || raw === undefined || raw === "") {
    throw new GuardError(`${name} 缺少数值（收到空值）`);
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new GuardError(`${name} 必须是有限正整数，收到：${JSON.stringify(String(raw))}`);
  }
  return n;
}

/**
 * 试跑隔离子目录名校验（--tag / --dir）：
 * 只接受 results/ 内的普通相对子目录名——拒绝绝对路径、".."、"."、"./"、"results" 本身及空值。
 * 允许多级嵌套（如 trial/a），最终是否越界由 resolveIsolatedDir 用规范化路径判定。
 * @returns {string} 原样返回通过的子目录名
 */
export function validateIsolationSegment(segment, name) {
  if (typeof segment !== "string" || segment.trim() === "") {
    throw new GuardError(`${name} 只接受 results/ 内的普通子目录名（如 trial-xxx），收到空值`);
  }
  if (segment.trim() !== segment) {
    throw new GuardError(`${name} 首尾含空白，拒绝：${JSON.stringify(segment)}`);
  }
  if (path.isAbsolute(segment)) {
    throw new GuardError(`${name} 只接受 results/ 内的相对子目录名，拒绝绝对路径：${JSON.stringify(segment)}`);
  }
  const parts = segment.split(/[\\/]/);
  if (parts.includes("..")) {
    throw new GuardError(`${name} 拒绝包含 .. 的路径：${JSON.stringify(segment)}`);
  }
  if (parts.includes(".") || parts.includes("")) {
    throw new GuardError(
      `${name} 只接受普通子目录名（不能是 "."、"./" 或含空段），拒绝：${JSON.stringify(segment)}（"." 规范化后等于正式 results 根目录）`,
    );
  }
  if (parts.includes("results")) {
    throw new GuardError(`${name} 拒绝名为 "results" 的段，避免与正式产物目录混淆：${JSON.stringify(segment)}`);
  }
  return segment;
}

/**
 * --out 只接受纯文件名（无路径分隔符、不是 "." / ".."、非空）。
 * @returns {string} 去掉 .jsonl 后缀前的原样文件名
 */
export function validateOutName(out) {
  if (typeof out !== "string" || out.trim() === "") {
    throw new GuardError("--out 只接受纯文件名（如 --out C-retry），收到空值");
  }
  if (/[\\/]/.test(out) || out.includes("\0")) {
    throw new GuardError(`--out 只接受纯文件名、不含路径分隔符，拒绝：${JSON.stringify(out)}（防 --dir trial --out ../A 定位到正式 results/A.jsonl）`);
  }
  if (out === "." || out === "..") {
    throw new GuardError(`--out 拒绝特殊路径名：${JSON.stringify(out)}`);
  }
  if (out.trim() !== out) {
    throw new GuardError(`--out 首尾含空白，拒绝：${JSON.stringify(out)}`);
  }
  return out;
}

/**
 * 把隔离子目录规范化到绝对路径，并断言它**严格位于** resultsRoot 内部（不等于根、不越出）。
 * - "." / "./" → 等于 resultsRoot → 拒绝（这正是试跑清空正式产物的攻击面）；
 * - "../x" / "a/../../x" → 越出 resultsRoot → 拒绝。
 * @returns {string} 规范化后的绝对目录路径
 */
export function resolveIsolatedDir(resultsRoot, segment) {
  const root = path.resolve(resultsRoot);
  const resolved = path.resolve(root, segment);
  if (resolved === root) {
    throw new GuardError(`隔离目录规范化后等于正式产物目录本身，拒绝：${JSON.stringify(segment)} → ${root}`);
  }
  const insideRoot = resolved.startsWith(root + path.sep);
  if (!insideRoot) {
    throw new GuardError(`隔离目录规范化后越出正式产物目录，拒绝：${JSON.stringify(segment)} → ${resolved}（root=${root}）`);
  }
  return resolved;
}

/**
 * 通用参数解析守卫（run-all / run-group 共用骨架）：
 * - 未知 --flag 一律报错（防 --tag 写错成 --tg 时静默落回正式目录）；
 * - 需要取值的 flag 缺值（位于末尾或下一个 token 也是 flag）一律报错（防 --limit 6 --tag 静默退回正式目录）；
 * - 布尔 flag 不取值。
 * 返回 { args, error }，error 为 null 表示通过；不抛异常，便于 runner 打印用法后 exit 2。
 */
export function parseFlagArgs(argv, { valueKeys, booleanKeys, flagsLabel }) {
  const args = {};
  const known = new Set([...valueKeys, ...booleanKeys]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("--")) {
      return { args, error: `${flagsLabel}：无法识别的参数 ${JSON.stringify(token)}（本脚本只接受 ${[...known].map((k) => `--${k}`).join(" / ")}）` };
    }
    const key = token.replace(/^--/, "");
    if (!known.has(key)) {
      return { args, error: `${flagsLabel}：无法识别的参数 ${token}（拼写错误的隔离参数会静默落回正式产物目录，一律拒绝）` };
    }
    if (booleanKeys.includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || (typeof value === "string" && value.startsWith("--"))) {
      return { args, error: `${flagsLabel}：参数 --${key} 缺少值（其后是另一个参数或已到末尾；缺值时会静默退回正式产物目录，一律拒绝）` };
    }
    args[key] = value;
    i += 1;
  }
  return { args, error: null };
}
