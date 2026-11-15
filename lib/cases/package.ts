import {
  EVIDENCE_SUFFICIENCIES, EVIDENCE_TYPES, FINDING_KINDS, RISK_LEVELS, STEP_STATES,
  type CaseSnapshot, type ReviewEvent,
} from "../evidence/types";
import { validateSnapshot } from "../evidence/validate";
import { MAX_ARTIFACT_BYTES, MAX_SCREENSHOT_PIXELS } from "../artifacts/constants";
import { minimizeUrlForDisplay } from "../tools/url-display";
import { assertReviewEvent, assertReviewTransition, reviewStatus } from "./review";
import { insertCaseBundle, readCaseBundle } from "./repository";
import type { ArtifactRetention, CaseBundle, LocalArtifact } from "./types";

export const MAX_CASE_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 1000;
const MAX_TEXT = 256 * 1024;

interface PackageArtifact { artifactId: string; mediaType: "image/png"; data: string }
interface CasePackageV1 {
  format: "veripage-case";
  version: 1;
  exportedAt: string;
  record: CaseBundle["record"];
  artifacts: PackageArtifact[];
  reviews: ReviewEvent[];
}

function fail(field: string): never { throw new Error(`案例包字段无效：${field}`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, allowEmpty = false, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) fail(field);
  return value;
}
function id(value: unknown, field: string): string {
  const result = text(value, field, false, 256);
  try { encodeURIComponent(result); } catch { fail(field); }
  return result;
}
function caseId(value: unknown): string {
  const result = id(value, "snapshot.id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result)) fail("snapshot.id");
  return result;
}
function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) fail(field);
  return value;
}
function texts(value: unknown, field: string): string[] { return list(value, field).map((item) => text(item, field, true)); }
function ids(value: unknown, field: string): string[] { return list(value, field).map((item) => id(item, field)); }
function time(value: unknown, field: string): string {
  const result = text(value, field, false, 128);
  if (Number.isNaN(Date.parse(result))) fail(field);
  return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const result = choices.find((item) => item === value);
  if (result === undefined) fail(field);
  return result;
}
function unique(values: string[], field: string): void { if (new Set(values).size !== values.length) fail(field); }

/** Select declared fields only; unknown JSON properties never enter persistent records. */
function snapshotFrom(value: unknown): CaseSnapshot {
  const root = object(value, "snapshot");
  const input = object(root.inputSummary, "inputSummary");
  const versions = object(root.versions, "versions");
  const assessment = object(root.originalAssessment, "originalAssessment");
  const snapshot: CaseSnapshot = {
    id: caseId(root.id), createdAt: time(root.createdAt, "createdAt"),
    inputSummary: { displayUrl: text(input.displayUrl, "displayUrl"), registrableDomain: text(input.registrableDomain, "registrableDomain") },
    versions: {
      reportSchema: text(versions.reportSchema, "versions.reportSchema"), model: text(versions.model, "versions.model"),
      prompt: text(versions.prompt, "versions.prompt"), policy: text(versions.policy, "versions.policy"), knowledge: text(versions.knowledge, "versions.knowledge"),
    },
    originalAssessment: {
      risk: choice(assessment.risk, RISK_LEVELS, "risk"),
      evidenceSufficiency: choice(assessment.evidenceSufficiency, EVIDENCE_SUFFICIENCIES, "evidenceSufficiency"),
      gaps: texts(assessment.gaps, "gaps"), summary: text(assessment.summary, "summary", true),
      findings: list(assessment.findings, "findings").map((raw) => {
        const item = object(raw, "finding");
        return { id: id(item.id, "finding.id"), statement: text(item.statement, "finding.statement", true), kind: choice(item.kind, FINDING_KINDS, "finding.kind"), evidenceIds: ids(item.evidenceIds, "finding.evidenceIds"), alternativeExplanations: texts(item.alternativeExplanations, "alternativeExplanations") };
      }),
      unknowns: texts(assessment.unknowns, "unknowns"), recommendedAction: text(assessment.recommendedAction, "recommendedAction", true),
    },
    coverage: list(root.coverage, "coverage").map((raw) => {
      const item = object(raw, "coverage entry");
      return { step: text(item.step, "coverage.step"), state: choice(item.state, STEP_STATES, "coverage.state"), ...(item.reason === undefined ? {} : { reason: text(item.reason, "coverage.reason", true) }) };
    }),
    evidence: list(root.evidence, "evidence").map((raw) => {
      const item = object(raw, "evidence entry");
      return {
        id: id(item.id, "evidence.id"), type: choice(item.type, EVIDENCE_TYPES, "evidence.type"), capturedAt: time(item.capturedAt, "evidence.capturedAt"), source: text(item.source, "evidence.source", true),
        ...(item.locator === undefined ? {} : { locator: text(item.locator, "evidence.locator", true) }),
        ...(item.excerpt === undefined ? {} : { excerpt: text(item.excerpt, "evidence.excerpt", true) }),
        ...(item.artifactId === undefined ? {} : { artifactId: id(item.artifactId, "evidence.artifactId") }),
      };
    }),
    artifactIds: ids(root.artifactIds, "artifactIds"),
  };
  unique(snapshot.artifactIds, "artifactIds 重复");
  try { if (!["http:", "https:"].includes(new URL(snapshot.inputSummary.displayUrl).protocol)) fail("displayUrl"); } catch { fail("displayUrl"); }
  const hardErrors = validateSnapshot(snapshot).errors.filter((error) => !error.startsWith("[warn]"));
  if (hardErrors.length) fail("snapshot 结构或证据引用");
  return snapshot;
}

function reviewsFrom(value: unknown, owner: string): ReviewEvent[] {
  const events: ReviewEvent[] = [];
  for (const raw of list(value, "reviews")) {
    const item = object(raw, "review");
    const event: Record<string, unknown> = {
      id: id(item.id, "review.id"), caseId: caseId(item.caseId), createdAt: time(item.createdAt, "review.createdAt"),
      action: item.action, reason: text(item.reason, "review.reason"), actor: item.actor,
      ...(item.humanRisk === undefined ? {} : { humanRisk: item.humanRisk }),
    };
    assertReviewEvent(event);
    if (event.caseId !== owner) fail("review.caseId");
    try { assertReviewTransition(reviewStatus(events), event.action); } catch { fail("reviews 提交顺序"); }
    events.push(event);
  }
  unique(events.map((event) => event.id), "review.id 重复");
  return events;
}

async function pngFrom(data: unknown): Promise<Blob> {
  const encoded = text(data, "PNG data", false, Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4);
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) fail("PNG base64");
  let binary: string;
  try { binary = atob(encoded); } catch { fail("PNG base64"); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length < 24 || bytes.length > MAX_ARTIFACT_BYTES || ![137,80,78,71,13,10,26,10].every((n, index) => bytes[index] === n) || String.fromCharCode(...bytes.subarray(12,16)) !== "IHDR") fail("PNG 内容");
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width * height > MAX_SCREENSHOT_PIXELS) fail("PNG 尺寸");
  const blob = new Blob([bytes], { type: "image/png" });
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(blob); } catch { fail("PNG 解码"); }
  const pixels = bitmap.width * bitmap.height;
  bitmap.close();
  if (!pixels || pixels > MAX_SCREENSHOT_PIXELS) fail("PNG 尺寸");
  return blob;
}

export async function readCasePackage(file: Blob): Promise<CaseBundle> {
  if (!file.size || file.size > MAX_CASE_PACKAGE_BYTES) throw new Error("案例包必须为不超过 16 MiB 的 JSON 文件");
  let json: unknown;
  try { json = JSON.parse(await file.text()); } catch { throw new Error("文件不是合法 JSON 案例包"); }
  const root = object(json, "root");
  if (root.format !== "veripage-case" || root.version !== 1) throw new Error("不支持的案例包格式或版本");
  time(root.exportedAt, "exportedAt");
  const rawRecord = object(root.record, "record");
  const snapshot = snapshotFrom(rawRecord.snapshot);
  if (rawRecord.id !== snapshot.id) fail("record.id");
  const activeIds = new Set(snapshot.artifactIds);
  const screenshotIds = new Set(snapshot.evidence.filter((item) => item.type === "screenshot").map((item) => item.artifactId));
  for (const item of snapshot.evidence) if (item.artifactId && !activeIds.has(item.artifactId)) fail("evidence.artifactId 关联");
  const retention: ArtifactRetention[] = list(rawRecord.retention, "retention").map((raw) => {
    const item = object(raw, "retention entry");
    const artifactId = id(item.artifactId, "retention.artifactId");
    if (item.state === "saved") {
      if (!activeIds.has(artifactId) || !screenshotIds.has(artifactId) || !Number.isInteger(item.byteLength) || Number(item.byteLength) <= 0 || Number(item.byteLength) > MAX_ARTIFACT_BYTES) fail("saved retention");
      return { artifactId, state: "saved", byteLength: Number(item.byteLength) };
    }
    const state = choice(item.state, ["missing", "omitted"] as const, "retention.state");
    if (state === "omitted" ? activeIds.has(artifactId) : !activeIds.has(artifactId)) fail("retention 关联");
    return { artifactId, state, reason: text(item.reason, "retention.reason") };
  });
  unique(retention.map((item) => item.artifactId), "retention 重复");
  for (const artifactId of activeIds) if (!retention.some((item) => item.artifactId === artifactId)) fail("artifactIds 缺少留存记录");
  const artifacts: LocalArtifact[] = [];
  for (const raw of list(root.artifacts, "artifacts")) {
    const item = object(raw, "artifact");
    const artifactId = id(item.artifactId, "artifact.artifactId");
    const meta = retention.find((entry) => entry.artifactId === artifactId);
    if (item.mediaType !== "image/png" || meta?.state !== "saved") fail("artifact 类型或关联");
    const blob = await pngFrom(item.data);
    if (blob.size !== meta.byteLength) fail("artifact.byteLength");
    artifacts.push({ caseId: snapshot.id, artifactId, blob });
  }
  unique(artifacts.map((item) => item.artifactId), "artifact 重复");
  if (retention.filter((item) => item.state === "saved").length !== artifacts.length) fail("saved artifact 缺失");
  return { record: { id: snapshot.id, snapshot, savedAt: time(rawRecord.savedAt, "savedAt"), retention }, artifacts, reviews: reviewsFrom(root.reviews, snapshot.id) };
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
}

export async function createCasePackage(owner: string): Promise<Blob> {
  const bundle = await readCaseBundle(owner);
  if (!bundle) throw new Error("本机案例已不存在，无法导出");
  const snapshot = structuredClone(bundle.record.snapshot);
  const screenshotIds = new Set(snapshot.evidence.filter((item) => item.type === "screenshot").map((item) => item.artifactId));
  const retention: ArtifactRetention[] = [];
  const artifacts: PackageArtifact[] = [];
  for (const artifactId of new Set(snapshot.artifactIds)) {
    const meta = bundle.record.retention.find((item) => item.artifactId === artifactId);
    const artifact = bundle.artifacts.find((item) => item.artifactId === artifactId);
    if (!screenshotIds.has(artifactId) || meta?.state === "omitted") retention.push({ artifactId, state: "omitted", reason: "原始链接等非截图取证副本未导出" });
    else if (meta?.state === "saved" && artifact) {
      retention.push({ artifactId, state: "saved", byteLength: artifact.blob.size });
      artifacts.push({ artifactId, mediaType: "image/png", data: await base64(artifact.blob) });
    } else retention.push({ artifactId, state: "missing", reason: meta?.state === "missing" ? meta.reason : "本机截图已不可用，未导出图像" });
  }
  for (const item of bundle.record.retention) {
    if (item.state === "omitted" && !snapshot.artifactIds.includes(item.artifactId)) retention.push({ ...item });
  }
  const omitted = new Set(retention.filter((item) => item.state === "omitted").map((item) => item.artifactId));
  snapshot.artifactIds = snapshot.artifactIds.filter((artifactId) => !omitted.has(artifactId));
  for (const evidence of snapshot.evidence) if (evidence.artifactId && omitted.has(evidence.artifactId)) delete evidence.artifactId;
  snapshot.inputSummary.displayUrl = minimizeUrlForDisplay(snapshot.inputSummary.displayUrl);
  const parcel: CasePackageV1 = { format: "veripage-case", version: 1, exportedAt: new Date().toISOString(), record: { id: bundle.record.id, snapshot, savedAt: bundle.record.savedAt, retention }, artifacts, reviews: bundle.reviews };
  const file = new Blob([JSON.stringify(parcel)], { type: "application/json" });
  await readCasePackage(file); // An exported package must satisfy the same boundary as import.
  return file;
}

export async function importCasePackage(file: Blob): Promise<string> {
  const bundle = await readCasePackage(file);
  try { await insertCaseBundle(bundle); }
  catch (error) {
    if (error instanceof DOMException && error.name === "ConstraintError") throw new Error("案例或复核编号已存在，未覆盖任何记录");
    throw error;
  }
  return bundle.record.id;
}
