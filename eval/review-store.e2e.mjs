/**
 * Real-browser IndexedDB review invariants, using the actual TypeScript modules.
 * PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers node eval/review-store.e2e.mjs
 * Run as a non-root user; Chromium sandbox stays enabled.
 * TS is compiled in memory; rewritten dependencies are fixed, inspected local modules.
 * The task-owned loopback server serves only a static fixture, with no model/API calls.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import ts from "typescript";
import { chromium } from "playwright";

async function sourceModule(file, dependencies = {}) {
  const source = await readFile(file, "utf8");
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, url] of Object.entries(dependencies)) js = js.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(url)}`);
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}

const typesUrl = await sourceModule("lib/evidence/types.ts");
const reviewUrl = await sourceModule("lib/cases/review.ts", { "../evidence/types": typesUrl });
const repositoryUrl = await sourceModule("lib/cases/repository.ts", { "./review": reviewUrl });
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>Trusted local review fixture</title><p>Native IndexedDB checks</p>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const checks = await page.evaluate(async ({ repositoryUrl, reviewUrl }) => {
    const api = await import(repositoryUrl);
    const domain = await import(reviewUrl);
    const passed = [];
    const check = (name, ok) => { if (!ok) throw new Error(name); passed.push(name); };
    const rejects = async (run) => {
      try { await run(); } catch (error) { return error; }
      throw new Error("Expected rejection");
    };
    const snapshot = {
      id: "review-store-fixture", createdAt: "2026-11-11T00:00:00.000Z",
      inputSummary: { displayUrl: "https://example.test/", registrableDomain: "example.test" },
      versions: { reportSchema: "1.0", model: "fixture", prompt: "fixture", policy: "fixture", knowledge: "fixture" },
      originalAssessment: { risk: "unknown", evidenceSufficiency: "insufficient", gaps: ["fixture"], summary: "Original machine assessment", findings: [], unknowns: ["fixture"], recommendedAction: "Verify manually" },
      coverage: [], evidence: [], artifactIds: [],
    };
    const record = { id: snapshot.id, snapshot, savedAt: snapshot.createdAt, retention: [] };
    await api.saveCase(record, []);
    const flag = { id: "flag-a", caseId: snapshot.id, createdAt: "2026-11-11T01:00:00.000Z", action: "flag_false_positive", reason: "Need review", actor: "local_user" };
    check("new case has unmarked review status", domain.reviewStatus(await api.listReviewEvents(snapshot.id)) === "unmarked");
    for (const invalid of [
      { ...flag, reason: " " },
      { ...flag, action: ["flag_false_positive"] },
      { ...flag, action: "correct_assessment" },
      { ...flag, humanRisk: "high" },
      { ...flag, actor: "platform_admin" },
      { ...flag, reason: "x".repeat(1001) },
    ]) await rejects(() => api.appendReviewEvent(invalid, null));
    check("invalid reason/action/risk/actor inputs write zero events", (await api.listReviewEvents(snapshot.id)).length === 0);

    const competing = { ...flag, id: "flag-b", reason: "Concurrent review" };
    const attempts = await Promise.allSettled([api.appendReviewEvent(flag, null), api.appendReviewEvent(competing, null)]);
    const events = await api.listReviewEvents(snapshot.id);
    const acceptedFlag = events[0];
    check("concurrent flags against the same revision append exactly one event", attempts.filter((r) => r.status === "fulfilled").length === 1 && events.length === 1 && domain.reviewStatus(events) === "pending");
    const replay = await api.appendReviewEvent(acceptedFlag, null);
    check("replaying the same event ID and payload is idempotent", replay.length === 1);
    await rejects(() => api.appendReviewEvent({ ...acceptedFlag, reason: "Changed replay" }, null));
    check("event ID cannot overwrite an existing opinion", (await api.listReviewEvents(snapshot.id))[0].reason === acceptedFlag.reason);

    const correction = { ...flag, id: "correction", createdAt: "2000-01-01T00:00:00.000Z", action: "correct_assessment", reason: "My local correction", humanRisk: "no_significant_risk" };
    const corrected = await api.appendReviewEvent(correction, acceptedFlag.id);
    check("correction transitions pending to corrected without timestamp sorting", domain.reviewStatus(corrected) === "corrected" && corrected.at(-1).id === correction.id);
    await rejects(() => api.appendReviewEvent({ ...correction, id: "resolve-without-pending" }, correction.id));
    check("closed review cannot be resolved again without reopening", (await api.listReviewEvents(snapshot.id)).length === 2);

    const reopened = { ...flag, id: "reopened", createdAt: "1990-01-01T00:00:00.000Z", reason: "New information" };
    await api.appendReviewEvent(reopened, correction.id);
    const stale = await rejects(() => api.appendReviewEvent({ ...correction, id: "stale-result" }, acceptedFlag.id));
    check("old pending-cycle submissions cannot close a newly reopened cycle", stale.name === "ReviewConflictError" && (await api.listReviewEvents(snapshot.id)).length === 3);
    check("reopening preserves the previous completed correction", domain.latestResolution(await api.listReviewEvents(snapshot.id)).id === correction.id);
    const upheld = { ...flag, id: "upheld", createdAt: "1980-01-01T00:00:00.000Z", action: "uphold_assessment", reason: "Keep original after checking" };
    const complete = await api.appendReviewEvent(upheld, reopened.id);
    check("uphold is a separate appended event in commit order", domain.reviewStatus(complete) === "upheld" && complete.map((e) => e.id).join(",") === [acceptedFlag.id, correction.id, reopened.id, upheld.id].join(","));
    check("personal correction never changes machine assessment", JSON.stringify((await api.getCase(snapshot.id)).snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));

    await api.saveCase({ ...record, snapshot: { ...snapshot, originalAssessment: { ...snapshot.originalAssessment, risk: "high" } } }, []);
    check("save retry preserves original assessment and all review events", (await api.listReviewEvents(snapshot.id)).length === 4 && JSON.stringify((await api.getCase(snapshot.id)).snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));
    const library = await api.readCaseLibrary();
    check("library reads cases and review histories in one consistent transaction", library.records.length === 1 && library.events.length === 4);
    await api.deleteCase(snapshot.id);
    await rejects(() => api.appendReviewEvent({ ...flag, id: "late-flag" }, null));
    check("deletion removes review events and late actions create no orphans", (await api.listReviewEvents(snapshot.id)).length === 0 && (await api.getCase(snapshot.id)) === undefined);
    return passed;
  }, { repositoryUrl, reviewUrl });
  for (const name of checks) console.log(`PASS ${name}`);
  assert.deepEqual(pageErrors, [], "expected domain rejections must not become uncaught page errors");
  console.log(`ALL-PASS (${checks.length} native IndexedDB review assertions)`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
