import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARTIFACT_TTL_MS,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_COUNT,
  MAX_ARTIFACT_STORE_BYTES,
  MAX_SCREENSHOT_PIXELS,
} from "./constants.ts";

export { ARTIFACT_TTL_MS, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_COUNT, MAX_ARTIFACT_STORE_BYTES, MAX_SCREENSHOT_PIXELS } from "./constants.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ArtifactMetadata {
  mediaType: "image/png";
  width: number;
  height: number;
}

export interface ScanArtifactSession {
  taskId: string;
  token: string;
  expiresAt: string;
}

export interface StoredArtifact {
  id: string;
  taskId: string;
  expiresAt: string;
  mediaType: "image/png";
  width: number;
  height: number;
  byteLength: number;
}

export interface RetrievedArtifact extends StoredArtifact {
  bytes: Buffer;
}

export interface ArtifactStore {
  createSession(taskId: string): Promise<ScanArtifactSession>;
  save(
    taskId: string,
    token: string,
    bytes: Uint8Array,
    metadata: ArtifactMetadata,
    signal?: AbortSignal,
  ): Promise<StoredArtifact>;
  get(taskId: string, token: string, artifactId: string): Promise<RetrievedArtifact | null>;
  releaseSessionIfEmpty(taskId: string): Promise<void>;
  removeTask(taskId: string): Promise<void>;
  cleanup(): Promise<number>;
}

export interface FileArtifactStoreOptions {
  ttlMs?: number;
  maxArtifactBytes?: number;
  maxStoreBytes?: number;
  maxArtifacts?: number;
  cleanupIntervalMs?: number;
  /** Tests may supply a dedicated temporary directory. Production defaults to a private mkdtemp directory. */
  rootDirectory?: string;
  now?: () => number;
}

interface SessionRecord {
  tokenHash: Buffer;
  expiresAt: number;
}

interface ArtifactRecord extends Omit<StoredArtifact, "expiresAt"> {
  filePath: string;
  expiresAtMs: number;
}

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 24) return false;
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (!hasPngSignature(bytes)) return null;
  // PNG IHDR is the first chunk; its data begins after signature + length + type.
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/**
 * Process-local registry with private, bounded temp-file storage. Session tokens
 * are never persisted; artifact IDs alone do not grant access.
 */
export class FileArtifactStore implements ArtifactStore {
  private readonly ttlMs: number;
  private readonly maxArtifactBytes: number;
  private readonly maxStoreBytes: number;
  private readonly maxArtifacts: number;
  private readonly now: () => number;
  private readonly configuredRoot?: string;
  private rootPromise?: Promise<string>;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private totalBytes = 0;
  private reservedBytes = 0;
  private reservedCount = 0;

  constructor(options: FileArtifactStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? ARTIFACT_TTL_MS;
    this.maxArtifactBytes = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_ARTIFACT_STORE_BYTES;
    this.maxArtifacts = options.maxArtifacts ?? MAX_ARTIFACT_COUNT;
    this.now = options.now ?? Date.now;
    this.configuredRoot = options.rootDirectory;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? 60_000;
    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        void this.cleanup().catch(() => undefined);
      }, cleanupIntervalMs);
      this.cleanupTimer.unref?.();
    }
  }

  private async rootDirectory(): Promise<string> {
    if (!this.rootPromise) {
      this.rootPromise = (async () => {
        const root = this.configuredRoot
          ? this.configuredRoot
          : await mkdtemp(path.join(tmpdir(), "veripage-artifacts-"));
        await mkdir(root, { recursive: true, mode: 0o700 });
        await chmod(root, 0o700);
        return root;
      })();
    }
    return this.rootPromise;
  }

  async createSession(taskId: string): Promise<ScanArtifactSession> {
    if (!UUID_PATTERN.test(taskId)) throw new Error("Invalid scan task ID");
    await this.cleanup();
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + this.ttlMs;
    this.sessions.set(taskId, { tokenHash: tokenHash(token), expiresAt: expiresAtMs });
    return { taskId, token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  private authorizedSession(taskId: string, token: string): SessionRecord | null {
    if (!UUID_PATTERN.test(taskId) || !token) return null;
    const session = this.sessions.get(taskId);
    if (!session || session.expiresAt <= this.now()) return null;
    const candidate = tokenHash(token);
    return timingSafeEqual(session.tokenHash, candidate) ? session : null;
  }

  async save(
    taskId: string,
    token: string,
    bytes: Uint8Array,
    metadata: ArtifactMetadata,
    signal?: AbortSignal,
  ): Promise<StoredArtifact> {
    signal?.throwIfAborted();
    await this.cleanup();
    const session = this.authorizedSession(taskId, token);
    if (!session) throw new Error("Artifact session is unavailable");
    if (metadata.mediaType !== "image/png") throw new Error("Unsupported artifact media type");
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxArtifactBytes) {
      throw new Error("Artifact exceeds the configured size limit");
    }
    if (
      this.artifacts.size + this.reservedCount >= this.maxArtifacts ||
      this.totalBytes + this.reservedBytes + bytes.byteLength > this.maxStoreBytes
    ) {
      throw new Error("Artifact store capacity is exhausted");
    }

    const buffer = Buffer.from(bytes);
    const dimensions = pngDimensions(buffer);
    if (!dimensions || dimensions.width !== metadata.width || dimensions.height !== metadata.height) {
      throw new Error("Artifact PNG dimensions do not match its metadata");
    }
    if (dimensions.width * dimensions.height > MAX_SCREENSHOT_PIXELS) {
      throw new Error("Artifact exceeds the configured pixel limit");
    }

    this.reservedBytes += buffer.byteLength;
    this.reservedCount += 1;
    let filePath: string | undefined;
    let committed = false;
    try {
      signal?.throwIfAborted();
      const id = randomUUID();
      const root = await this.rootDirectory();
      filePath = path.join(root, `${id}.png`);
      await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      if (this.sessions.get(taskId) !== session || session.expiresAt <= this.now()) {
        throw new Error("Artifact session expired while saving");
      }

      const expiresAtMs = Math.min(session.expiresAt, this.now() + this.ttlMs);
      const record: ArtifactRecord = {
        id,
        taskId,
        filePath,
        expiresAtMs,
        mediaType: metadata.mediaType,
        width: dimensions.width,
        height: dimensions.height,
        byteLength: buffer.byteLength,
      };
      this.artifacts.set(id, record);
      this.totalBytes += buffer.byteLength;
      committed = true;
      return this.publicMetadata(record);
    } finally {
      this.reservedBytes -= buffer.byteLength;
      this.reservedCount -= 1;
      if (!committed && filePath) await rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  async get(taskId: string, token: string, artifactId: string): Promise<RetrievedArtifact | null> {
    await this.cleanup();
    if (!this.authorizedSession(taskId, token) || !UUID_PATTERN.test(artifactId)) return null;
    const record = this.artifacts.get(artifactId);
    if (!record || record.taskId !== taskId || record.expiresAtMs <= this.now()) return null;
    try {
      const bytes = await readFile(record.filePath);
      return { ...this.publicMetadata(record), bytes };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.dropArtifact(artifactId, record);
      return null;
    }
  }

  async releaseSessionIfEmpty(taskId: string): Promise<void> {
    const hasArtifacts = [...this.artifacts.values()].some((artifact) => artifact.taskId === taskId);
    if (!hasArtifacts) this.sessions.delete(taskId);
  }

  async removeTask(taskId: string): Promise<void> {
    this.sessions.delete(taskId);
    for (const [id, artifact] of this.artifacts) {
      if (artifact.taskId !== taskId) continue;
      this.dropArtifact(id, artifact);
      await rm(artifact.filePath, { force: true }).catch(() => undefined);
    }
  }

  async cleanup(): Promise<number> {
    const now = this.now();
    for (const [taskId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(taskId);
    }

    let removed = 0;
    for (const [id, artifact] of this.artifacts) {
      const session = this.sessions.get(artifact.taskId);
      if (artifact.expiresAtMs > now && session && session.expiresAt > now) continue;
      this.dropArtifact(id, artifact);
      removed += 1;
      await rm(artifact.filePath, { force: true }).catch(() => undefined);
    }
    return removed;
  }

  private publicMetadata(record: ArtifactRecord): StoredArtifact {
    return {
      id: record.id,
      taskId: record.taskId,
      expiresAt: new Date(record.expiresAtMs).toISOString(),
      mediaType: record.mediaType,
      width: record.width,
      height: record.height,
      byteLength: record.byteLength,
    };
  }

  private dropArtifact(id: string, record: ArtifactRecord): void {
    if (this.artifacts.get(id) !== record) return;
    this.artifacts.delete(id);
    this.totalBytes = Math.max(0, this.totalBytes - record.byteLength);
  }

  async dispose(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.sessions.clear();
    this.artifacts.clear();
    this.totalBytes = 0;
    if (this.rootPromise) {
      const root = await this.rootPromise.catch(() => undefined);
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
}

type SharedArtifactGlobals = typeof globalThis & {
  __veripageArtifactStore?: FileArtifactStore;
};

const sharedGlobal = globalThis as SharedArtifactGlobals;
export const artifactStore = sharedGlobal.__veripageArtifactStore ??= new FileArtifactStore();

export function artifactCookieName(taskId: string): string {
  return `vp_scan_${taskId.replaceAll("-", "")}`;
}

export function isArtifactUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
