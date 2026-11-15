import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { SignJWT, jwtVerify } from "jose";

export const REVIEWER_COOKIE = "vp_reviewer_session";
export const SESSION_MAX_AGE = 12 * 60 * 60;
const deriveKey = promisify(scrypt);

export interface ReviewerConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  origin: string;
}

/** Missing or invalid deployment configuration closes access; there is no anonymous fallback. */
export function getReviewerConfig(): ReviewerConfig | null {
  const username = process.env.VERIPAGE_REVIEWER_USERNAME ?? "";
  const passwordHash = process.env.VERIPAGE_REVIEWER_PASSWORD_HASH ?? "";
  const sessionSecret = process.env.VERIPAGE_SESSION_SECRET ?? "";
  const origin = process.env.VERIPAGE_PUBLIC_ORIGIN ?? "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/.test(username) ||
      !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash) ||
      sessionSecret.length < 32) return null;
  try {
    const url = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    // Plain HTTP is only for loopback verification, never for public password submission.
    if (url.origin !== origin || url.username || url.password ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) return null;
  } catch {
    return null;
  }
  return { username, passwordHash, sessionSecret, origin };
}

export async function hashReviewerPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}

export async function verifyReviewerCredentials(
  username: string,
  password: string,
  config: ReviewerConfig,
): Promise<boolean> {
  const [, salt, expected] = config.passwordHash.split(":");
  const actual = await deriveKey(password, salt, 64) as Buffer;
  // Derive the key even for a wrong username, so both failures have the same response path.
  return timingSafeEqual(actual, Buffer.from(expected, "hex")) && username === config.username;
}

function passwordVersion(config: ReviewerConfig): string {
  return createHash("sha256").update(config.passwordHash).digest("hex");
}

export async function createReviewerSession(config: ReviewerConfig, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  return new SignJWT({ passwordVersion: passwordVersion(config) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(config.username)
    .setIssuer("veripage")
    .setAudience("veripage-reviewer")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_MAX_AGE)
    .sign(new TextEncoder().encode(config.sessionSecret));
}

export async function verifyReviewerSession(
  token: string | undefined,
  config: ReviewerConfig,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.sessionSecret), {
      algorithms: ["HS256"],
      issuer: "veripage",
      audience: "veripage-reviewer",
      requiredClaims: ["sub", "iat", "exp", "passwordVersion"],
      currentDate: new Date(now),
    });
    return payload.sub === config.username && payload.passwordVersion === passwordVersion(config);
  } catch {
    return false;
  }
}

export function reviewerToken(request: Request): string | undefined {
  return request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REVIEWER_COOKIE}=`))
    ?.slice(REVIEWER_COOKIE.length + 1);
}

export function reviewerCookieOptions(config: ReviewerConfig) {
  return {
    httpOnly: true,
    secure: config.origin.startsWith("https:"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

export function authError(error: string, status: number, headers: HeadersInit = {}): Response {
  const response = Response.json({ error }, { status, headers });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export function isSameOrigin(request: Request, config: ReviewerConfig): boolean {
  return request.headers.get("origin") === config.origin;
}

/** API routes authorize themselves too: protection does not depend on the Proxy matcher. */
export async function authorizeReviewerRequest(request: Request): Promise<Response | null> {
  const config = getReviewerConfig();
  if (!config) return authError("评测账号尚未配置，请联系项目负责人", 503);
  if (!await verifyReviewerSession(reviewerToken(request), config)) {
    return authError("请先登录评测账号，或重新登录已过期的会话", 401);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !isSameOrigin(request, config)) {
    return authError("请求来源不匹配，请从本站页面操作", 403);
  }
  return null;
}

// One self-hosted instance, at most ten password derivations per minute (including successes).
let loginWindowEnd = 0;
let loginAttempts = 0;
export function consumeLoginAttempt(now = Date.now()): number {
  if (now >= loginWindowEnd) {
    loginWindowEnd = now + 60_000;
    loginAttempts = 0;
  }
  if (loginAttempts >= 10) return Math.ceil((loginWindowEnd - now) / 1000);
  loginAttempts += 1;
  return 0;
}
