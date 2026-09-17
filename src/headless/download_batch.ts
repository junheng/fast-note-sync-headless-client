import type { StateStore } from "./state_store";
import type { BatchRecord, SessionRecord } from "./state_records";

export class DownloadBatchError extends Error {
  constructor(public readonly code: "invalid-download-batch" | "incomplete-download-batch") { super(code); this.name = "DownloadBatchError"; }
}

// Persistent completion policy, separate from the plugin's visual progress.
// A transfer provides its fully verified page count only after all callbacks
// have finished. End alone never moves the checkpoint into committed state.
export class DownloadBatch {
  constructor(private state: StateStore, readonly id: string, collection: "notes" | "files" | "folders") {
    const session: SessionRecord = { formatVersion: 1, kind: "session", id, generation: 0, status: "active" };
    const batch: BatchRecord = { formatVersion: 1, kind: "batch", id, sessionId: id, collection, checkpointBefore: 0, checkpointTarget: null, expectedPages: null,
      completedPages: [], pendingOperationIds: [], endReceived: false, status: "receiving" };
    state.commit([{ type: "put", record: session, expectedRevision: null }, { type: "put", record: batch, expectedRevision: null }]);
  }

  private load(): { record: BatchRecord; revision: number } {
    const value = this.state.get("batch", this.id);
    if (!value || value.record.kind !== "batch") throw new DownloadBatchError("invalid-download-batch");
    return { record: value.record, revision: value.revision };
  }

  end(lastTime: number): void {
    const { record, revision } = this.load();
    if (record.status !== "receiving" || !Number.isSafeInteger(lastTime) || lastTime < 0 || (record.endReceived && record.checkpointTarget !== lastTime)) throw new DownloadBatchError("invalid-download-batch");
    if (record.endReceived) return;
    this.state.commit([{ type: "put", record: { ...record, checkpointTarget: lastTime, endReceived: true }, expectedRevision: revision }]);
  }

  page(index: number): void {
    const { record, revision } = this.load();
    if (record.status !== "receiving" || !Number.isSafeInteger(index) || index < 0 || index >= 10000) throw new DownloadBatchError("invalid-download-batch");
    if (record.completedPages.includes(index)) return;
    this.state.commit([{ type: "put", record: { ...record, completedPages: [...record.completedPages, index] }, expectedRevision: revision }]);
  }

  complete(pages: number, lastTime: number): void {
    const { record, revision } = this.load();
    if (!Number.isSafeInteger(pages) || pages < 0 || pages > 10000 || !record.endReceived || record.checkpointTarget !== lastTime ||
        record.completedPages.length !== pages || record.completedPages.some(index => index >= pages) || record.pendingOperationIds.length > 0 || record.status !== "receiving") throw new DownloadBatchError("incomplete-download-batch");
    const session = this.state.get("session", this.id);
    if (!session || session.record.kind !== "session" || session.record.status !== "active") throw new DownloadBatchError("invalid-download-batch");
    this.state.commit([{ type: "put", record: { ...record, expectedPages: pages, status: "committed" }, expectedRevision: revision },
      { type: "put", record: { ...session.record, status: "completed" }, expectedRevision: session.revision }]);
  }

  interrupt(): void {
    const { record, revision } = this.load();
    if (record.status !== "receiving") return;
    const session = this.state.get("session", this.id);
    if (!session || session.record.kind !== "session") throw new DownloadBatchError("invalid-download-batch");
    this.state.commit([{ type: "put", record: { ...record, status: "blocked" }, expectedRevision: revision },
      { type: "put", record: { ...session.record, status: "interrupted" }, expectedRevision: session.revision }]);
  }
}
