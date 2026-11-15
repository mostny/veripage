/** Offline auth boundaries; no .env, browser or model request. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  authorizeReviewerRequest,
  consumeLoginAttempt,
  createReviewerSession,
  getReviewerConfig,
  reviewerCookieOptions,
  SESSION_MAX_AGE,
  verifyReviewerCredentials,
  verifyReviewerSession,
} from "../lib/auth/reviewer.ts";
import { POST as scan } from "../app/api/scan/route.ts";
import { POST as text } from "../app/api/text/route.ts";
import { GET as artifact } from "../app/api/scans/[id]/artifacts/[artifactId]/route.ts";
import { artifactStore } from "../lib/artifacts/store.ts";
import { installReviewerFixture } from "./reviewer-fixture.ts";

let passed = 0;
function check(name: string, condition: boolean) {
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
  passed += 1;
}
const fixture = await installReviewerFixture();
const realFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls += 1; throw new Error("Offline auth test refuses network calls"); };
try {
  const config = getReviewerConfig();
  assert.ok(config);
  check("generated scrypt format is accepted", Boolean(config));
  check("correct password authenticates", await verifyReviewerCredentials(config.username, "offline-test-password-not-a-real-credential", config));
  check("wrong password is refused", !await verifyReviewerCredentials(config.username, "wrong-password", config));
  check("wrong username is refused", !await verifyReviewerCredentials("unknown-reviewer", "offline-test-password-not-a-real-credential", config));
  const now = Date.now();
  const token = await createReviewerSession(config, now);
  check("signed session is valid", await verifyReviewerSession(token, config, now));
  check("expired session is refused", !await verifyReviewerSession(token, config, now + (SESSION_MAX_AGE + 1) * 1000));
  const pieces = token.split(".");
  pieces[1] = Buffer.from(JSON.stringify({ sub: config.username, exp: 9_999_999_999 })).toString("base64url");
  check("modified session is refused", !await verifyReviewerSession(pieces.join("."), config));
  check("unsigned and malformed tokens are refused", !await verifyReviewerSession("e30.e30.", config) && !await verifyReviewerSession("broken", config));
  check("secret rotation invalidates old sessions", !await verifyReviewerSession(token, { ...config, sessionSecret: "a-different-offline-session-signing-key" }));
  check("password rotation invalidates old sessions", !await verifyReviewerSession(token, { ...config, passwordHash: config.passwordHash.replace(/.$/, config.passwordHash.endsWith("a") ? "b" : "a") }));
  check("production cookie is HttpOnly, Secure, SameSite=Lax and limited to 12 hours", (() => {
    const options = reviewerCookieOptions(config);
    return options.httpOnly && options.secure && options.sameSite === "lax" && options.maxAge === SESSION_MAX_AGE;
  })());

  for (const [name, handler] of [["scan", scan], ["text", text]] as const) {
    const anonymous = new Request(`${config.origin}/api/${name}`, { method: "POST", body: "{invalid JSON" });
    const denied = await handler(anonymous);
    check(`${name} refuses anonymous access before parsing the body`, denied.status === 401 && !anonymous.bodyUsed);
    const crossSite = new Request(`${config.origin}/api/${name}`, {
      method: "POST", headers: { cookie: fixture.cookie, origin: "https://other.example" }, body: "{invalid JSON",
    });
    const csrf = await handler(crossSite);
    check(`${name} refuses cross-origin writes before parsing the body`, csrf.status === 403 && !crossSite.bodyUsed);
    const allowed = await authorizeReviewerRequest(new Request(`${config.origin}/api/${name}`, { method: "POST", headers: fixture.headers }));
    check(`${name} accepts a signed same-origin reviewer session`, allowed === null);
  }
  const deniedArtifact = await artifact(new Request(`${config.origin}/api/scans/x/artifacts/y`), { params: Promise.resolve({ id: "x", artifactId: "y" }) });
  check("artifact reads require reviewer authentication as well as task ownership", deniedArtifact.status === 401);
  check("rejected requests invoke no browser/model network calls", externalCalls === 0);
  process.env.VERIPAGE_SESSION_SECRET = "";
  check("missing auth config closes API access with 503", (await scan(new Request(`${config.origin}/api/scan`, { method: "POST" }))).status === 503);
  process.env.VERIPAGE_SESSION_SECRET = config.sessionSecret;
  process.env.VERIPAGE_PUBLIC_ORIGIN = "https://43.136.20.106";
  const ipConfig = getReviewerConfig();
  check("HTTPS public IP configuration is accepted without a domain", ipConfig?.origin === "https://43.136.20.106");
  check("IP HTTPS cookies retain Secure protection", Boolean(ipConfig && reviewerCookieOptions(ipConfig).secure));
  check("IP-origin authenticated writes pass the origin check", await authorizeReviewerRequest(new Request("https://43.136.20.106/api/scan", {
    method: "POST", headers: { cookie: fixture.cookie, origin: "https://43.136.20.106" },
  })) === null);
  process.env.VERIPAGE_PUBLIC_ORIGIN = "http://public.example";
  check("public HTTP configuration is refused", getReviewerConfig() === null);
  process.env.VERIPAGE_PUBLIC_ORIGIN = config.origin;
  for (let i = 0; i < 10; i += 1) assert.equal(consumeLoginAttempt(1_000), 0);
  check("login derivations are limited to ten per minute", consumeLoginAttempt(1_000) === 60);
  check("login throttle window expires", consumeLoginAttempt(61_001) === 0);

  const directory = await mkdtemp(path.join(tmpdir(), "veripage-account-test-"));
  try {
    const script = path.resolve("scripts/create-reviewer.mjs");
    const run = () => spawnSync(process.execPath, ["--experimental-strip-types", script, "reviewer-test", "https://review.example"], { cwd: directory, encoding: "utf8" });
    const created = run();
    check("account setup succeeds without printing secrets", created.status === 0 && JSON.parse(created.stdout).secretsPrinted === false);
    const account = await readFile(path.join(directory, ".env.reviewer-account"), "utf8");
    const password = /密码：([^\n]+)/.exec(account)?.[1] ?? "";
    check("setup writes a random 24-character password, absent from its output", password.length === 24 && !created.stdout.includes(password));
    const env = await readFile(path.join(directory, ".env"), "utf8");
    check("runtime config contains a password hash, not the plaintext", env.includes("VERIPAGE_REVIEWER_PASSWORD_HASH=scrypt:") && !env.includes(password));
    check("credential files have private 0600 permissions", ((await stat(path.join(directory, ".env"))).mode & 0o777) === 0o600 && ((await stat(path.join(directory, ".env.reviewer-account"))).mode & 0o777) === 0o600);
    check("re-running setup refuses to overwrite credentials", run().status !== 0 && await readFile(path.join(directory, ".env"), "utf8") === env && await readFile(path.join(directory, ".env.reviewer-account"), "utf8") === account);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
} finally {
  fixture.restore();
  globalThis.fetch = realFetch;
  await artifactStore.dispose();
}
console.log(`ALL-PASS (${passed})`);
