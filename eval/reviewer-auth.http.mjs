/** Exercise the intended production server. Credentials stay in this process; no model calls. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = process.argv[2] ?? "http://127.0.0.1:3080";
assert.equal(new URL(origin).origin, origin, "Supply an origin without a path or trailing slash");
const account = await readFile(new URL("../.env.reviewer-account", import.meta.url), "utf8");
const username = /账号：([^\n]+)/.exec(account)?.[1];
const password = /密码：([^\n]+)/.exec(account)?.[1];
assert.ok(username && password, "The private reviewer account file must exist");
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  console.log(`PASS ${name}`);
  passed += 1;
}
const request = (pathname, init = {}) => fetch(`${origin}${pathname}`, { redirect: "manual", ...init });
const login = (body, extraHeaders = {}) => request("/api/auth/login", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...extraHeaders }, body,
});

const anonymousHome = await request("/");
check("anonymous home redirects to login", anonymousHome.status === 307 && new URL(anonymousHome.headers.get("location"), origin).pathname === "/login");
for (const pathname of ["/cases", "/cases/not-a-real-case"]) {
  const protectedPage = await request(pathname);
  check(`${pathname} remains protected before local history rendering`, protectedPage.status === 307 && new URL(protectedPage.headers.get("location"), origin).pathname === "/login");
}
const page = await request("/login");
const html = await page.text();
check("production login page renders its form", page.status === 200 && html.includes("评测登录") && html.includes('autoComplete="current-password"'));
const assetPath = html.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js)"/)?.[1];
assert.ok(assetPath, "Production page must reference a JavaScript asset");
const asset = await request(assetPath);
check("production JavaScript asset is reachable without a session", asset.status === 200 && /javascript/.test(asset.headers.get("content-type") ?? ""));
for (const pathname of ["/api/scan", "/api/text"]) {
  const response = await request(pathname, { method: "POST", body: "{invalid JSON" });
  check(`${pathname} refuses anonymous requests with JSON 401`, response.status === 401 && typeof (await response.json()).error === "string");
}
const artifact = await request("/api/scans/11111111-1111-4111-8111-111111111111/artifacts/22222222-2222-4222-8222-222222222222");
check("anonymous artifact access is refused", artifact.status === 401);
const badLogin = await login(JSON.stringify({ username, password: "intentionally-wrong-test-password" }));
check("wrong password receives generic 401", badLogin.status === 401 && (await badLogin.json()).error === "账号或密码不正确");
check("cross-origin login is refused", (await login(JSON.stringify({ username, password }), { Origin: "https://other.example" })).status === 403);
check("malformed login JSON is refused", (await login("{broken")).status === 400);
check("oversized login body is refused", (await login(" ".repeat(4097))).status === 413);
const signedIn = await login(JSON.stringify({ username, password }));
check("generated reviewer credentials log in", signedIn.status === 200 && (await signedIn.json()).ok === true);
const setCookie = signedIn.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
check("login sets a bounded private cookie", setCookie.includes("HttpOnly") && /SameSite=Lax/i.test(setCookie) && setCookie.includes("Max-Age=43200") && /; Secure/i.test(setCookie) === origin.startsWith("https:"));
const home = await request("/", { headers: { Cookie: cookie } });
check("authenticated reviewer reaches the real home page", home.status === 200 && (await home.text()).includes("待核验链接"));
check("authenticated page is not shared-cacheable", /no-store/.test(home.headers.get("cache-control") ?? ""));
for (const pathname of ["/.env", "/.env.reviewer-account"]) {
  const privateFile = await request(pathname, { headers: { Cookie: cookie } });
  const body = await privateFile.text();
  check(`${pathname} is not served even to an authenticated reviewer`, privateFile.status === 404 && !body.includes(password));
}
const authenticatedText = await request("/api/text", { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: "{}" });
check("authenticated API reaches normal input validation", authenticatedText.status === 400);
const forged = await request("/api/scan", { method: "POST", headers: { Cookie: "vp_reviewer_session=forged", Origin: origin }, body: "{}" });
check("forged cookie cannot invoke scanning", forged.status === 401);
const crossSite = await request("/api/scan", { method: "POST", headers: { Cookie: cookie, Origin: "https://other.example" }, body: "{}" });
check("authenticated cross-site scan is refused", crossSite.status === 403);
const blockedScan = await request("/api/scan", {
  method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({ url: "http://127.0.0.1/?token=OFFLINE_TEST_TOKEN" }),
});
const stream = await blockedScan.text();
const events = stream.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
const report = events.find((event) => event.type === "report")?.snapshot;
check("authenticated scan preserves SSE and blocks a private target without a model", blockedScan.status === 200 && /text\/event-stream/.test(blockedScan.headers.get("content-type") ?? "") && report?.originalAssessment.summary.startsWith("未发起检测") && report.coverage.some((step) => step.step === "gate2-fetch" && step.state === "skipped"));
const taskId = events.find((event) => event.type === "started")?.taskId;
const artifactId = report.artifactIds[0];
const artifactCookie = blockedScan.headers.get("set-cookie")?.split(";")[0];
assert.ok(taskId && artifactId && artifactCookie, "Blocked scan must preserve its minimized URL's raw evidence");
const savedEvidence = await request(`/api/scans/${taskId}/artifacts/${artifactId}`, { headers: { Cookie: `${cookie}; ${artifactCookie}` } });
check("production temp-file write/read preserves evidence after tracing exclusion", savedEvidence.status === 200 && await savedEvidence.text() === "http://127.0.0.1/?token=OFFLINE_TEST_TOKEN");
const notOwner = await request(`/api/scans/${taskId}/artifacts/${artifactId}`, { headers: { Cookie: cookie } });
check("reviewer login alone cannot access another task's evidence", notOwner.status === 404);
const rejectedLogout = await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: "https://other.example" } });
check("cross-site logout is refused", rejectedLogout.status === 403);
const logout = await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin } });
check("logout expires the session cookie", logout.status === 200 && /Max-Age=0/.test(logout.headers.get("set-cookie") ?? ""));
check("cleared-cookie navigation returns to login", (await request("/text")).status === 307);
console.log(`ALL-PASS (${passed}; no credentials printed; no real model calls)`);
