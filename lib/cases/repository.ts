import type { ArtifactRetention, CaseBundle, LocalArtifact, StoredCase } from "./types";
import type { ReviewEvent } from "../evidence/types";
import { assertReviewEvent, assertReviewTransition, ReviewConflictError, reviewStatus } from "./review";

export const CASE_DATABASE = "veripage-cases";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CASE_DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("cases", { keyPath: "id" }).createIndex("createdAt", "snapshot.createdAt");
      db.createObjectStore("artifacts", { keyPath: ["caseId", "artifactId"] }).createIndex("caseId", "caseId");
      const reviews = db.createObjectStore("reviewEvents", { autoIncrement: true });
      reviews.createIndex("id", "id", { unique: true });
      reviews.createIndex("caseId", "caseId");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/** Queue requests synchronously; resolve only when the entire transaction commits. */
async function transact<T>(stores: string[], mode: IDBTransactionMode, queue: (tx: IDBTransaction, abort: (reason: unknown) => void) => () => T): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let operationError: unknown;
      const abort = (reason: unknown) => { operationError = reason; tx.abort(); };
      tx.onabort = () => reject(operationError ?? tx.error ?? new DOMException("本机存储事务已中止", "AbortError"));
      try {
        const result = queue(tx, abort);
        tx.oncomplete = () => resolve(result());
      } catch (error) {
        abort(error);
      }
    });
  } finally {
    db.close();
  }
}

/** Retrying a partial save may add evidence, but never replaces the original assessment. */
export function saveCase(record: StoredCase, artifacts: LocalArtifact[]): Promise<StoredCase> {
  return transact(["cases", "artifacts"], "readwrite", (tx) => {
    const cases = tx.objectStore("cases");
    const existing = cases.get(record.id);
    let saved = record;
    existing.onsuccess = () => {
      const current: StoredCase | undefined = existing.result;
      if (current) {
        const retention = new Map<string, ArtifactRetention>(current.retention.map((item) => [item.artifactId, item]));
        for (const item of record.retention) {
          if (retention.get(item.artifactId)?.state !== "saved") retention.set(item.artifactId, item);
        }
        saved = { ...current, retention: [...retention.values()] };
      }
      cases.put(saved);
      for (const artifact of artifacts) {
        if (current?.retention.some((item) => item.artifactId === artifact.artifactId && item.state === "saved")) continue;
        tx.objectStore("artifacts").put(artifact);
      }
    };
    return () => saved;
  });
}

export function getCase(id: string): Promise<StoredCase | undefined> {
  return transact(["cases"], "readonly", (tx) => {
    let value: StoredCase | undefined;
    const request = tx.objectStore("cases").get(id);
    request.onsuccess = () => { value = request.result; };
    return () => value;
  });
}

export function listCases(): Promise<StoredCase[]> {
  return transact(["cases"], "readonly", (tx) => {
    let values: StoredCase[] = [];
    const request = tx.objectStore("cases").index("createdAt").getAll();
    request.onsuccess = () => { values = request.result; };
    return () => values.reverse();
  });
}

export function getArtifact(caseId: string, artifactId: string): Promise<LocalArtifact | undefined> {
  return transact(["artifacts"], "readonly", (tx) => {
    let value: LocalArtifact | undefined;
    const request = tx.objectStore("artifacts").get([caseId, artifactId]);
    request.onsuccess = () => { value = request.result; };
    return () => value;
  });
}

export function deleteCase(id: string): Promise<void> {
  return transact(["cases", "artifacts", "reviewEvents"], "readwrite", (tx) => {
    tx.objectStore("cases").delete(id);
    for (const name of ["artifacts", "reviewEvents"]) {
      const store = tx.objectStore(name);
      const request = store.index("caseId").openKeyCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    }
    return () => undefined;
  });
}

/** Index results with equal caseId are ordered by the auto-increment primary key. */
export function listReviewEvents(caseId?: string): Promise<ReviewEvent[]> {
  return transact(["reviewEvents"], "readonly", (tx) => {
    let events: ReviewEvent[] = [];
    const store = tx.objectStore("reviewEvents");
    const request = caseId === undefined ? store.getAll() : store.index("caseId").getAll(IDBKeyRange.only(caseId));
    request.onsuccess = () => { events = request.result; };
    return () => events;
  });
}

export function readCaseLibrary(): Promise<{ records: StoredCase[]; events: ReviewEvent[] }> {
  return transact(["cases", "reviewEvents"], "readonly", (tx) => {
    let records: StoredCase[] = [];
    let events: ReviewEvent[] = [];
    const cases = tx.objectStore("cases").index("createdAt").getAll();
    const reviews = tx.objectStore("reviewEvents").getAll();
    cases.onsuccess = () => { records = cases.result; };
    reviews.onsuccess = () => { events = reviews.result; };
    return () => ({ records: records.reverse(), events });
  });
}

/** Check revision and transition inside the same write transaction as the append. */
export async function appendReviewEvent(event: ReviewEvent, expectedLastEventId: string | null): Promise<ReviewEvent[]> {
  assertReviewEvent(event);
  return transact(["cases", "reviewEvents"], "readwrite", (tx, abort) => {
    let result: ReviewEvent[] = [];
    const existingCase = tx.objectStore("cases").get(event.caseId);
    existingCase.onsuccess = () => {
      if (!existingCase.result) { abort(new Error("本机案例已不存在，未保存复核记录")); return; }
      const store = tx.objectStore("reviewEvents");
      const request = store.index("caseId").getAll(IDBKeyRange.only(event.caseId));
      request.onsuccess = () => {
        const events: ReviewEvent[] = request.result;
        const duplicate = events.find((item) => item.id === event.id);
        if (duplicate) {
          if ((["caseId", "createdAt", "action", "reason", "humanRisk", "actor"] as const).some((field) => duplicate[field] !== event[field])) {
            abort(new Error("复核记录编号已存在，未覆盖原记录"));
          } else result = events;
          return;
        }
        if ((events.at(-1)?.id ?? null) !== expectedLastEventId) { abort(new ReviewConflictError()); return; }
        try { assertReviewTransition(reviewStatus(events), event.action); }
        catch (error) { abort(error); return; }
        store.add(event);
        result = [...events, event];
      };
    };
    return () => result;
  });
}

export function readCaseBundle(id: string): Promise<CaseBundle | undefined> {
  return transact(["cases", "artifacts", "reviewEvents"], "readonly", (tx) => {
    let record: StoredCase | undefined;
    let artifacts: LocalArtifact[] = [];
    let reviews: ReviewEvent[] = [];
    const caseRequest = tx.objectStore("cases").get(id);
    const artifactRequest = tx.objectStore("artifacts").index("caseId").getAll(IDBKeyRange.only(id));
    const reviewRequest = tx.objectStore("reviewEvents").index("caseId").getAll(IDBKeyRange.only(id));
    caseRequest.onsuccess = () => { record = caseRequest.result; };
    artifactRequest.onsuccess = () => { artifacts = artifactRequest.result; };
    reviewRequest.onsuccess = () => { reviews = reviewRequest.result; };
    return () => record ? { record, artifacts, reviews } : undefined;
  });
}

/** Only validated bundles enter here; case identity is never silently merged. */
export function insertCaseBundle(bundle: CaseBundle): Promise<void> {
  return transact(["cases", "artifacts", "reviewEvents"], "readwrite", (tx, abort) => {
    const cases = tx.objectStore("cases");
    const existing = cases.get(bundle.record.id);
    existing.onsuccess = () => {
      if (existing.result) { abort(new Error("本机已有同编号案例，未覆盖任何记录")); return; }
      cases.add(bundle.record);
      for (const artifact of bundle.artifacts) tx.objectStore("artifacts").add(artifact);
      for (const review of bundle.reviews) tx.objectStore("reviewEvents").add(review);
    };
    return () => undefined;
  });
}
