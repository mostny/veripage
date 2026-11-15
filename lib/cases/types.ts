import type { CaseSnapshot, ReviewEvent } from "../evidence/types";

export type ArtifactRetention =
  | { artifactId: string; state: "saved"; byteLength: number }
  | { artifactId: string; state: "missing" | "omitted"; reason: string };

export interface StoredCase {
  id: string;
  snapshot: CaseSnapshot;
  savedAt: string;
  retention: ArtifactRetention[];
}

export interface LocalArtifact {
  caseId: string;
  artifactId: string;
  blob: Blob;
}

export interface CaseBundle {
  record: StoredCase;
  artifacts: LocalArtifact[];
  reviews: ReviewEvent[];
}

export type CaseSaveState =
  | { status: "idle" | "saving" | "deleted" }
  | { status: "saved"; record: StoredCase }
  | { status: "error"; message: string };
