/** Artifact TTL/access-control regression; no browser, target URL or model call. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactCookieName, artifactStore, FileArtifactStore } from "../lib/artifacts/store.ts";
import { runScan } from "../lib/agent/orchestrator.ts";
import { handleScanPost } from "../lib/scans/handler.ts";
import { analyzeUrlStatic } from "../lib/tools/url-static.ts";
import type { FetchPageResult } from "../lib/tools/fetch-page.ts";
import type { ChatResult } from "../lib/models.ts";
import { GET as getArtifact } from "../app/api/scans/[id]/artifacts/[artifactId]/route.ts";
import { POST as createScan } from "../app/api/scan/route.ts";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let passed = 0;
function check(name: string, condition: boolean): void {
  assert.ok(condition, name);
  passed += 1;
  console.log(`PASS ${name}`);
}

const metadata = { mediaType: "image/png" as const, width: 1, height: 1 };

// Same-process scan handler -> actual ArtifactStore -> actual artifact GET integration.
{
  const response = await handleScanPost(
    new Request("http://veripage.local/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://integration.example/" }),
    }),
    {
      artifactStore,
      timeoutMs: 1_000,
      runScan: async (_url, emit, context) => {
        const saved = await artifactStore.save(context.taskId, context.sessionToken, onePixelPng, metadata, context.signal);
        emit({ type: "step", step: "gate2-fetch", state: "completed" });
        return {
          id: "integration-case",
          createdAt: new Date().toISOString(),
          inputSummary: { displayUrl: "https://integration.example/", registrableDomain: "integration.example" },
          versions: { reportSchema: "1.0", model: "fixture", prompt: "fixture", policy: "1", knowledge: "none" },
          originalAssessment: {
            risk: "unknown",
            evidenceSufficiency: "insufficient",
            gaps: ["integration fixture"],
            summary: "integration fixture",
            findings: [],
            unknowns: ["integration fixture"],
            recommendedAction: "人工复核",
          },
          coverage: [{ step: "gate2-fetch", state: "completed" }],
          evidence: [{ id: "ev-screenshot", type: "screenshot", capturedAt: new Date().toISOString(), source: "fixture", artifactId: saved.id }],
          artifactIds: [saved.id],
        };
      },
    },
  );
  const cookieHeader = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const fullSetCookie = response.headers.get("set-cookie") ?? "";
  const body = await response.text();
  const events = body.split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const line = block.split(/\r?\n/).find((part) => part.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) as Record<string, unknown> : {};
  });
  const started = events.find((event) => event.type === "started") as { taskId?: string } | undefined;
  const report = events.find((event) => event.type === "report") as { snapshot?: { artifactIds?: string[] } } | undefined;
  const taskId = started?.taskId ?? "";
  const artifactId = report?.snapshot?.artifactIds?.[0] ?? "";
  check("scan handler report binds its saved artifact", response.status === 200 && Boolean(taskId && artifactId));
  check("cookie Secure attribute follows the app origin, not the scanned target URL", /; Secure/i.test(fullSetCookie) === (process.env.NODE_ENV === "production"));
  check("session token stays out of SSE body", Boolean(cookieHeader) && !body.includes(cookieHeader.split("=").slice(1).join("=")));
  const retrieval = await getArtifact(
    new Request(`http://veripage.local/api/scans/${taskId}/artifacts/${artifactId}`, { headers: { cookie: cookieHeader } }),
    { params: Promise.resolve({ id: taskId, artifactId }) },
  );
  check("SSE session cookie retrieves the exact stored artifact end-to-end", retrieval.status === 200 && Buffer.compare(Buffer.from(await retrieval.arrayBuffer()), onePixelPng) === 0);
}

// Failures after a screenshot save must revoke the task and reclaim its quota.
async function abandonedScan(kind: "runner-failure" | "timeout" | "client-cancel"): Promise<void> {
  const requestController = new AbortController();
  let savedArtifactId = "";
  let resolveSaved!: () => void;
  const savedPromise = new Promise<void>((resolve) => { resolveSaved = resolve; });
  const response = await handleScanPost(
    new Request("http://veripage.local/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://abandoned.example/" }),
      signal: requestController.signal,
    }),
    {
      artifactStore,
      timeoutMs: kind === "timeout" ? 150 : 2_000,
      runScan: async (_url, _emit, context) => {
        const saved = await artifactStore.save(context.taskId, context.sessionToken, onePixelPng, metadata, context.signal);
        savedArtifactId = saved.id;
        resolveSaved();
        if (kind === "runner-failure") throw new Error("fixture failed after artifact save");
        return await new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      },
    },
  );
  await savedPromise;
  if (kind === "client-cancel") requestController.abort(new DOMException("fixture disconnect", "AbortError"));
  const body = await response.text();
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const startedLine = body.split(/\r?\n/).find((line) => line.startsWith("data: ") && line.includes('"type":"started"'));
  const taskId = startedLine ? (JSON.parse(startedLine.slice(6)) as { taskId: string }).taskId : "";
  const retrieval = await getArtifact(
    new Request(`http://veripage.local/api/scans/${taskId}/artifacts/${savedArtifactId}`, { headers: { cookie } }),
    { params: Promise.resolve({ id: taskId, artifactId: savedArtifactId }) },
  );
  check(`${kind} removes the saved artifact and revokes its session`, Boolean(taskId && savedArtifactId) && retrieval.status === 404);
  if (kind !== "client-cancel") {
    check(`${kind} emits an explicit failed terminal`, body.includes('"step":"validate","state":"failed"'));
  }
}

await abandonedScan("runner-failure");
await abandonedScan("timeout");
await abandonedScan("client-cancel");

// Scan response creates a scoped HttpOnly cookie without serializing the secret into SSE.
{
  const response = await createScan(new Request("http://veripage.local/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "http://192.168.1.1" }),
  }));
  const setCookie = response.headers.get("set-cookie") ?? "";
  const body = await response.text();
  const started = body.split(/\r?\n/).find((line) => line.startsWith("data: ") && line.includes('"type":"started"'));
  const taskId = started ? (JSON.parse(started.slice(6)) as { taskId: string }).taskId : "";
  const token = setCookie.split(";")[0]?.split("=").slice(1).join("=") ?? "";
  check("scan issues an HttpOnly same-site session cookie scoped to its artifact route", Boolean(taskId && token && setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Strict") && setCookie.includes(`/api/scans/${taskId}/artifacts`)));
  check("session secret never appears in the SSE body", !token || !body.includes(token));
  check("artifact cookie name is task-specific", setCookie.startsWith(`${artifactCookieName(taskId)}=`));
}

// Orchestrator stores captured bytes first, binds the real ID, and never embeds base64 in the report.
{
  const taskId = randomUUID();
  const artifactId = randomUUID();
  const page: FetchPageResult = {
    blocked: false,
    startUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    redirectChain: ["https://example.com/"],
    evidence: [
      { id: "ev-text-1", capturedAt: new Date().toISOString(), type: "text", source: "fixture", title: "Example", text: "Example", truncated: false },
      { id: "ev-forms-2", capturedAt: new Date().toISOString(), type: "forms", source: "fixture", forms: [] },
      { id: "ev-scripts-3", capturedAt: new Date().toISOString(), type: "externalScripts", source: "fixture", domains: [], scripts: [] },
      { id: "ev-screenshot-4", capturedAt: new Date().toISOString(), type: "screenshot", source: "fixture", mimeType: "image/png", encoding: "base64", data: onePixelPng.toString("base64"), width: 1, height: 1, fullPage: true },
    ],
    warnings: [],
    blockedRequests: [],
    elapsedMs: 1,
  };
  let storedBytes = Buffer.alloc(0);
  const snapshot = await runScan(
    "https://example.com/",
    () => undefined,
    {
      artifactSession: { taskId, token: "fixture-session-token" },
      services: {
        guard: async () => ({ allowed: true, resolvedIps: ["93.184.216.34"] }),
        analyzeUrl: () => analyzeUrlStatic("https://example.com/"),
        fetchPage: async () => page,
        visionChat: async () => ({ content: "视觉证据：Example", toolCalls: [] }),
        chat: async (): Promise<ChatResult> => ({
          content: JSON.stringify({ risk: "unknown", evidenceSufficiency: "insufficient", gaps: ["fixture gap"], summary: "fixture", findings: [], unknowns: ["fixture unknown"], recommendedAction: "人工复核" }),
          toolCalls: [],
        }),
        saveArtifact: async (receivedTaskId, receivedToken, bytes, receivedMetadata) => {
          assert.equal(receivedTaskId, taskId);
          assert.equal(receivedToken, "fixture-session-token");
          assert.deepEqual(receivedMetadata, metadata);
          storedBytes = Buffer.from(bytes);
          return { id: artifactId, taskId, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...metadata, byteLength: bytes.byteLength };
        },
      },
    },
  );
  const screenshot = snapshot.evidence.find((evidence) => evidence.type === "screenshot");
  check("orchestrator stores the captured PNG", Buffer.compare(storedBytes, onePixelPng) === 0);
  check("snapshot and screenshot evidence use the saved artifact ID", screenshot?.artifactId === artifactId && snapshot.artifactIds.includes(artifactId));
  check("serialized snapshot does not contain the screenshot base64", !JSON.stringify(snapshot).includes(onePixelPng.toString("base64")));
}

// Real same-origin route accepts the owning session cookie and hides all other cases.
{
  const taskId = randomUUID();
  const session = await artifactStore.createSession(taskId);
  const saved = await artifactStore.save(taskId, session.token, onePixelPng, metadata);
  const request = (cookie?: string) => new Request(
    `http://veripage.local/api/scans/${taskId}/artifacts/${saved.id}`,
    { headers: cookie ? { cookie } : undefined },
  );
  const context = { params: Promise.resolve({ id: taskId, artifactId: saved.id }) };

  const response = await getArtifact(request(`${`vp_scan_${taskId.replaceAll("-", "")}`}=${session.token}`), context);
  check("artifact endpoint returns the owned PNG", response.status === 200 && response.headers.get("content-type") === "image/png");
  check("artifact endpoint disables all shared caching", /private, no-store/.test(response.headers.get("cache-control") ?? ""));
  check("artifact response bytes match the captured PNG", Buffer.compare(Buffer.from(await response.arrayBuffer()), onePixelPng) === 0);

  const unauthenticated = await getArtifact(request(), context);
  check("artifact ID without session cookie returns 404", unauthenticated.status === 404);

  const wrongCookie = await getArtifact(request(`vp_scan_${taskId.replaceAll("-", "")}=wrong-token`), context);
  check("wrong session token returns 404", wrongCookie.status === 404);

  const mismatchedTask = await getArtifact(
    request(`vp_scan_${taskId.replaceAll("-", "") + "x"}=${session.token}`),
    { params: Promise.resolve({ id: randomUUID(), artifactId: saved.id }) },
  );
  check("artifact cannot be fetched under another task ID", mismatchedTask.status === 404);

  const traversal = await getArtifact(
    request(`${`vp_scan_${taskId.replaceAll("-", "")}`}=${session.token}`),
    { params: Promise.resolve({ id: taskId, artifactId: "../../etc/passwd" }) },
  );
  check("malformed artifact IDs return 404", traversal.status === 404);
}

// Isolated store tests cover expiry, capacity and cleanup deterministically.
{
  let now = 10_000;
  const store = new FileArtifactStore({ ttlMs: 100, cleanupIntervalMs: 0, now: () => now });
  try {
    const taskId = randomUUID();
    const session = await store.createSession(taskId);
    const saved = await store.save(taskId, session.token, onePixelPng, metadata);
    check("stored artifact expiry is bounded by its session", Date.parse(saved.expiresAt) === Date.parse(session.expiresAt));
    now += 101;
    check("expiry cleanup removes stale temporary files", await store.cleanup() === 1);
    check("expired artifact is inaccessible", await store.get(taskId, session.token, saved.id) === null);

    const secondTask = randomUUID();
    const secondSession = await store.createSession(secondTask);
    let mismatchRejected = false;
    try {
      await store.save(secondTask, secondSession.token, onePixelPng, { ...metadata, width: 2 });
    } catch {
      mismatchRejected = true;
    }
    check("PNG dimensions are validated against metadata", mismatchRejected);

    let invalidPngRejected = false;
    try {
      await store.save(secondTask, secondSession.token, Buffer.from("not a PNG"), metadata);
    } catch {
      invalidPngRejected = true;
    }
    check("non-PNG artifact payloads are rejected", invalidPngRejected);
  } finally {
    await store.dispose();
  }
}

// Files are private to the service account and the configured store size is enforced.
{
  const parent = await mkdtemp(path.join(tmpdir(), "veripage-artifact-test-"));
  const root = path.join(parent, "private-store");
  const store = new FileArtifactStore({
    rootDirectory: root,
    cleanupIntervalMs: 0,
    maxArtifactBytes: onePixelPng.byteLength + 1,
    maxStoreBytes: onePixelPng.byteLength + 1,
  });
  try {
    const taskId = randomUUID();
    const session = await store.createSession(taskId);
    const saved = await store.save(taskId, session.token, onePixelPng, metadata);
    const [directoryInfo, fileInfo] = await Promise.all([
      stat(root),
      stat(path.join(root, `${saved.id}.png`)),
    ]);
    if (process.platform === "win32") {
      // Windows ACLs do not expose POSIX permission bits through stat().mode.
      // The store is placed under the current user's OS temp directory.
      console.log("SKIP POSIX mode-bit assertions on Windows; temp ACLs are platform-managed.");
    } else {
      check("artifact directory permissions are 0700", (directoryInfo.mode & 0o777) === 0o700);
      check("artifact file permissions are 0600", (fileInfo.mode & 0o777) === 0o600);
    }

    const secondTask = randomUUID();
    const secondSession = await store.createSession(secondTask);
    let capacityRejected = false;
    try {
      await store.save(secondTask, secondSession.token, onePixelPng, metadata);
    } catch {
      capacityRejected = true;
    }
    check("global temporary artifact capacity is enforced", capacityRejected);
  } finally {
    await store.dispose();
    await rm(parent, { recursive: true, force: true });
  }
}

await artifactStore.dispose();
console.log(`ALL-PASS (${passed})`);
