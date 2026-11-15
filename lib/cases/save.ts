import type { CaseSnapshot } from "../evidence/types";
import { validateSnapshot } from "../evidence/validate";
import { MAX_ARTIFACT_BYTES } from "../artifacts/constants";
import { saveCase } from "./repository";
import type { ArtifactRetention, LocalArtifact, StoredCase } from "./types";

/** Download before opening a write transaction; keep sensitive raw-URL artifacts temporary. */
export async function saveCaseSnapshot(snapshot: CaseSnapshot, taskId: string): Promise<StoredCase> {
  const hardErrors = validateSnapshot(snapshot).errors.filter((error) => !error.startsWith("[warn]"));
  if (hardErrors.length > 0) throw new Error("报告结构校验未通过，未保存到本机");

  const screenshots = new Set(snapshot.evidence.filter((item) => item.type === "screenshot").map((item) => item.artifactId));
  const artifacts: LocalArtifact[] = [];
  const retention: ArtifactRetention[] = [];
  for (const artifactId of new Set(snapshot.artifactIds)) {
    if (!screenshots.has(artifactId)) {
      retention.push({ artifactId, state: "omitted", reason: "原始链接等非截图取证副本不作本地长期保存" });
      continue;
    }
    try {
      const response = await fetch(`/api/scans/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`截图暂时不可用（HTTP ${response.status}）`);
      if (response.headers.get("Content-Type")?.split(";")[0] !== "image/png") throw new Error("截图格式不符，未复制到本机");
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > MAX_ARTIFACT_BYTES) throw new Error("截图大小超出保存范围");
      artifacts.push({ caseId: snapshot.id, artifactId, blob });
      retention.push({ artifactId, state: "saved", byteLength: blob.size });
    } catch (error) {
      retention.push({ artifactId, state: "missing", reason: error instanceof Error ? error.message : "截图下载失败" });
    }
  }
  return saveCase({ id: snapshot.id, snapshot, savedAt: new Date().toISOString(), retention }, artifacts);
}
