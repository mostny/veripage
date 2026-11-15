/**
 * Actual package modules + native browser IndexedDB; no model/API or remote resources.
 * PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers node eval/case-package.e2e.mjs
 * Run as a non-root user; Chromium sandbox stays enabled.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import ts from "typescript";
import { chromium } from "playwright";

async function sourceModule(file, dependencies = {}) {
  let js = ts.transpileModule(await readFile(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [specifier, url] of Object.entries(dependencies)) js = js.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(url)}`);
  return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}
const typesUrl = await sourceModule("lib/evidence/types.ts");
const reviewUrl = await sourceModule("lib/cases/review.ts", { "../evidence/types": typesUrl });
const repositoryUrl = await sourceModule("lib/cases/repository.ts", { "./review": reviewUrl });
const validationUrl = await sourceModule("lib/evidence/validate.ts", { "./types.ts": typesUrl });
const limitsUrl = await sourceModule("lib/artifacts/constants.ts");
const displayUrl = await sourceModule("lib/tools/url-display.ts");
const packageUrl = await sourceModule("lib/cases/package.ts", {
  "../evidence/types": typesUrl, "../evidence/validate": validationUrl,
  "../artifacts/constants": limitsUrl, "../tools/url-display": displayUrl,
  "./review": reviewUrl, "./repository": repositoryUrl,
});
const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Trusted case package fixture</title>"); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const checks = await page.evaluate(async ({ repositoryUrl, packageUrl, reviewUrl }) => {
    const api = await import(repositoryUrl), parcel = await import(packageUrl), review = await import(reviewUrl);
    const passed = [];
    const check = (name, ok) => { if (!ok) throw new Error(name); passed.push(name); };
    const rejects = async (run) => { try { await run(); } catch (error) { return error; } throw new Error("Expected rejection"); };
    const stamp = "2026-11-11T00:00:00.000Z";
    const token = "SYNTHETIC_PACKAGE_TOKEN_123";
    const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 3;
    canvas.getContext("2d").fillRect(0, 0, 4, 3);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const snapshot = {
      id: "package-fixture", createdAt: stamp,
      inputSummary: { displayUrl: `https://example.test/?token=${token}`, registrableDomain: "example.test" },
      versions: { reportSchema: "1.0", model: "fixture", prompt: "fixture", policy: "fixture", knowledge: "fixture" },
      originalAssessment: { risk: "suspicious", evidenceSufficiency: "partial", gaps: ["fixture"], summary: "Machine original", findings: [{ id: "f-url", statement: "URL observation", kind: "observed_fact", evidenceIds: ["ev-url"], alternativeExplanations: [] }], unknowns: ["fixture"], recommendedAction: "Verify manually" },
      coverage: [{ step: "fixture", state: "completed" }],
      evidence: [{ id: "ev-url", type: "url", capturedAt: stamp, source: "fixture", excerpt: "https://example.test/?token=[已隐藏]", artifactId: "raw-url" }, { id: "ev-shot", type: "screenshot", capturedAt: stamp, source: "fixture", artifactId: "png-1" }],
      artifactIds: ["png-1", "raw-url"],
    };
    await api.saveCase({ id: snapshot.id, snapshot, savedAt: stamp, retention: [{ artifactId: "png-1", state: "saved", byteLength: png.size }, { artifactId: "raw-url", state: "omitted", reason: "Sensitive raw URL not retained" }] }, [{ caseId: snapshot.id, artifactId: "png-1", blob: png }]);
    const flag = { id: "review-flag", caseId: snapshot.id, createdAt: stamp, action: "flag_false_positive", reason: "My reason", actor: "local_user" };
    await api.appendReviewEvent(flag, null);
    await api.appendReviewEvent({ ...flag, id: "review-correct", createdAt: "2000-01-01T00:00:00.000Z", action: "correct_assessment", humanRisk: "unknown" }, flag.id);
    const file = await parcel.createCasePackage(snapshot.id);
    const serialized = await file.text();
    const json = JSON.parse(serialized);
    check("export selects v1 format and preserved PNG/review history", json.format === "veripage-case" && json.version === 1 && json.artifacts.length === 1 && json.reviews.length === 2);
    check("export hides known URL parameters and removes sensitive active artifact references", !serialized.includes(token) && !json.record.snapshot.artifactIds.includes("raw-url") && json.record.snapshot.evidence[0].artifactId === undefined && json.record.retention.some((r) => r.artifactId === "raw-url" && r.state === "omitted"));
    check("export does not mutate original snapshot or machine assessment", JSON.stringify((await api.getCase(snapshot.id)).snapshot) === JSON.stringify(snapshot) && JSON.stringify(json.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment));
    await rejects(() => parcel.importCasePackage(file));
    check("duplicate case import does not replace local data or opinions", JSON.stringify((await api.getCase(snapshot.id)).snapshot) === JSON.stringify(snapshot) && (await api.listReviewEvents(snapshot.id)).length === 2);
    await api.deleteCase(snapshot.id);
    await parcel.importCasePackage(file);
    const restored = await api.readCaseBundle(snapshot.id);
    const bitmap = await createImageBitmap(restored.artifacts[0].blob);
    check("export-delete-import restores report and real image bytes", JSON.stringify(restored.record.snapshot.originalAssessment) === JSON.stringify(snapshot.originalAssessment) && bitmap.width === 4 && bitmap.height === 3 && restored.artifacts[0].blob.size === png.size);
    bitmap.close();
    check("review array order survives import despite backward timestamps", restored.reviews.map((r) => r.id).join(",") === "review-flag,review-correct" && review.reviewStatus(restored.reviews) === "corrected");
    const reexported = JSON.parse(await (await parcel.createCasePackage(snapshot.id)).text());
    check("re-export preserves intentional omission provenance", reexported.record.retention.some((r) => r.artifactId === "raw-url" && r.state === "omitted"));

    const cloneFor = (owner) => {
      const copy = structuredClone(json);
      copy.record.id = owner; copy.record.snapshot.id = owner;
      copy.reviews = copy.reviews.map((event, index) => ({ ...event, id: `${owner}-review-${index}`, caseId: owner }));
      return copy;
    };
    const asFile = (value) => new Blob([JSON.stringify(value)], { type: "application/json" });
    const invalid = [
      ["unknown version", (p) => { p.version = 99; }],
      ["invalid model risk", (p) => { p.record.snapshot.originalAssessment.risk = "definitely-safe"; }],
      ["wrong text type", (p) => { p.record.snapshot.originalAssessment.summary = {}; }],
      ["dangling evidence reference", (p) => { p.record.snapshot.originalAssessment.findings[0].evidenceIds = ["absent"]; }],
      ["unrooted finding cycle", (p) => { p.record.snapshot.originalAssessment.findings = [{ id: "loop-a", kind: "inference", statement: "A", evidenceIds: ["loop-b"], alternativeExplanations: [] }, { id: "loop-b", kind: "inference", statement: "B", evidenceIds: ["loop-a"], alternativeExplanations: [] }]; }],
      ["foreign review owner", (p) => { p.reviews[0].caseId = "different-case"; }],
      ["invalid review sequence", (p) => { p.reviews = [p.reviews[1]]; }],
      ["missing image payload", (p) => { p.artifacts = []; }],
      ["remote or SVG resource", (p) => { p.artifacts[0].mediaType = "image/svg+xml"; p.artifacts[0].data = "https://remote.invalid/resource.svg"; }],
      ["forged PNG", (p) => { p.artifacts[0].data = btoa("not an image"); }],
      ["oversized image dimensions", (p) => { const bytes = Uint8Array.from(atob(p.artifacts[0].data), (c) => c.charCodeAt(0)); new DataView(bytes.buffer).setUint32(16, 100000); new DataView(bytes.buffer).setUint32(20, 100000); p.artifacts[0].data = btoa(String.fromCharCode(...bytes)); }],
      ["image byte count mismatch", (p) => { p.record.retention.find((r) => r.state === "saved").byteLength += 1; }],
      ["duplicate artifact ID", (p) => { p.artifacts.push({ ...p.artifacts[0] }); }],
      ["unlisted artifact reference", (p) => { p.record.snapshot.evidence[0].artifactId = "not-listed"; }],
    ];
    for (const [index, [name, mutate]] of invalid.entries()) {
      const owner = `invalid-${index}`;
      const copy = cloneFor(owner); mutate(copy);
      await rejects(() => parcel.importCasePackage(asFile(copy)));
      check(`reject ${name} before persistent writes`, (await api.getCase(owner)) === undefined && (await api.listReviewEvents(owner)).length === 0 && (await api.getArtifact(owner, "png-1")) === undefined);
    }
    await rejects(() => parcel.readCasePackage(new Blob(["not JSON"])));
    await rejects(() => parcel.readCasePackage(new Blob([" ".repeat(parcel.MAX_CASE_PACKAGE_BYTES + 1)])));
    check("malformed and oversized files are rejected", (await api.readCaseLibrary()).records.length === 1);

    const unknown = cloneFor("unknown-fields");
    unknown.script = "never execute";
    unknown.record.snapshot.originalAssessment.extraPrivateField = "never persist";
    unknown.reviews[0].extraPrivateField = "never persist";
    const selected = await parcel.readCasePackage(asFile(unknown));
    check("unknown JSON properties are not persisted into declared records", !Object.hasOwn(selected.record.snapshot.originalAssessment, "extraPrivateField") && !Object.hasOwn(selected.reviews[0], "extraPrivateField"));

    const dense = cloneFor("dense-graph");
    dense.reviews = [];
    dense.record.snapshot.originalAssessment.findings = Array.from({ length: 70 }, (_, index) => ({ id: `g${index}`, kind: "inference", statement: "Synthetic graph relation", evidenceIds: [...Array.from({ length: 70 }, (_, n) => `g${n}`).filter((id) => id !== `g${index}`), ...(index === 0 ? ["ev-url"] : [])], alternativeExplanations: [] }));
    await parcel.readCasePackage(asFile(dense));
    check("dense cyclic finding graph is validated without recursive path explosion", true);

    const rollback = cloneFor("rollback-case");
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      const request = originalAdd.apply(this, args);
      if (this.name === "artifacts") request.addEventListener("success", () => this.transaction.abort(), { once: true });
      return request;
    };
    try { await rejects(() => parcel.importCasePackage(asFile(rollback))); }
    finally { IDBObjectStore.prototype.add = originalAdd; }
    check("mid-import transaction abort leaves no report, image or review records", (await api.getCase("rollback-case")) === undefined && (await api.getArtifact("rollback-case", "png-1")) === undefined && (await api.listReviewEvents("rollback-case")).length === 0);
    await parcel.importCasePackage(asFile(rollback));
    check("retry after rollback commits one complete bundle", (await api.readCaseBundle("rollback-case")).reviews.length === 2 && (await api.getArtifact("rollback-case", "png-1")) !== undefined);
    return passed;
  }, { repositoryUrl, packageUrl, reviewUrl });
  checks.forEach((name) => console.log(`PASS ${name}`));
  assert.deepEqual(errors, [], "validation and transaction failures must be handled rejections");
  console.log(`ALL-PASS (${checks.length} package boundary/native-IDB assertions)`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
