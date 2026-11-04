/**
 * URL 展示最小化（审计 2026-10-30 F01 的链接线部分）
 *
 * 背景：URL 的 `token=...`、`access_token=...` 等凭据样查询参数曾原样进入
 * 分析器输入与最终报告（lib/prompts/analyzer.ts 的【待核验 URL】行等），
 * 属于把用户提交的敏感值非必要外发给模型/写进报告。
 *
 * 纪律：本工具只负责「展示形态」——传给模型的 URL 文本、人看的报告/日志里的
 * URL，把已知凭据样参数的值替换为 `[已隐藏]` 占位。原始完整 URL 仍按取证需要
 * 保留在证据内部存储（编排器在最小化发生时把原始 URL 存为短期证据产物），
 * 本工具不做任何存储。
 *
 * 实现为纯字符串重写（不经过 URL/URLSearchParams 重组）：
 *  - 未经命名的其他参数原样保留（含原始百分号编码，不改变展示语义）；
 *  - 重复调用幂等：占位值 `[已隐藏]` 长度低于阈值，不会再次改写；
 *  - 解析失败的输入原样返回，绝不因脱敏抛异常。
 */

/** 占位值：保留参数名、只隐藏值，让报告读者知道「这里有一个被隐藏的凭据样参数」 */
export const HIDDEN_URL_PARAM_VALUE = "[已隐藏]";

/**
 * 隐藏阈值：值（解码后）达到该长度才视为凭据样取值。
 * 短值（如 `?key=1`、占位值本身）通常是普通参数或已隐藏标记，保留原样。
 */
const MIN_HIDDEN_VALUE_LENGTH = 8;

/** 凭据样参数名（小写精确匹配；覆盖常见 token/key/签名/口令/会话命名） */
const CREDENTIAL_LIKE_PARAM_NAMES = new Set([
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "session_token",
  "bearer",
  "jwt",
  "api_key",
  "apikey",
  "access_key",
  "accesskey",
  "secret",
  "client_secret",
  "secret_key",
  "password",
  "passwd",
  "pwd",
  "session",
  "session_id",
  "sessionid",
  "sid",
  "signature",
  "sig",
  "sign",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "private_key",
]);

function decodeQueryComponent(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

function isCredentialLikeValue(rawValue: string): boolean {
  return decodeQueryComponent(rawValue).trim().length >= MIN_HIDDEN_VALUE_LENGTH;
}

/**
 * 最小化一个 URL 的展示形态：已知凭据样参数（值足够长时）的值替换为 `[已隐藏]`。
 * 没有 query、或不含凭据样参数时原样返回同一内容。
 */
export function minimizeUrlForDisplay(raw: string): string {
  const queryIndex = raw.indexOf("?");
  if (queryIndex < 0) return raw;
  const hashIndex = raw.indexOf("#", queryIndex);
  const query = raw.slice(queryIndex + 1, hashIndex < 0 ? raw.length : hashIndex);
  const tail = hashIndex < 0 ? "" : raw.slice(hashIndex);

  let changed = false;
  const pairs = query.split("&").map((pair) => {
    if (!pair) return pair;
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    const key = decodeQueryComponent(rawKey).trim().toLowerCase();
    if (CREDENTIAL_LIKE_PARAM_NAMES.has(key) && isCredentialLikeValue(rawValue)) {
      changed = true;
      return `${rawKey}=${HIDDEN_URL_PARAM_VALUE}`;
    }
    return pair;
  });
  return changed ? `${raw.slice(0, queryIndex + 1)}${pairs.join("&")}${tail}` : raw;
}
