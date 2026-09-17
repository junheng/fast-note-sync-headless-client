import { Buffer } from "node:buffer";
import type { OwnedDirectories } from "./filesystem";
import { fullDigest, SnapshotStore } from "./snapshots";
import type { ContentKind } from "./snapshots";
import { validIdentifier, validRelativePath } from "./state_records";
import type { LocalRequestRecord } from "./state_records";
import type { StateStore } from "./state_store";

export interface ExpectedVersion { sha256: string; size: number }
export interface LocalRequest {
  requestId: string;
  operation: "create" | "modify" | "delete" | "rename";
  path: string;
  expected: ExpectedVersion | null;
  contentKind: ContentKind;
  content?: Uint8Array;
  targetPath?: string;
  targetExpected?: null;
}
export interface LocalReceipt {
  requestId: string;
  status: "applied" | "stale";
  reason: "source-version" | "target-exists" | null;
  version: ExpectedVersion | null;
  synchronization: "not-confirmed";
}
export class LocalRequestError extends Error {
  constructor(public readonly code: "invalid-local-request" | "request-id-reused" | "local-writer-contract-required") {
    super(code);
    this.name = "LocalRequestError";
  }
}

const matches = (bytes: Uint8Array | null, version: ExpectedVersion | null) => bytes === null ? version === null : version !== null && bytes.byteLength === version.size && fullDigest(bytes) === version.sha256;
function validate(request: LocalRequest): void {
  if (!request || !validIdentifier(request.requestId) || !validRelativePath(request.path) ||
      !["create", "modify", "delete", "rename"].includes(request.operation) || !["note", "file"].includes(request.contentKind)) throw new LocalRequestError("invalid-local-request");
  const expected = request.expected;
  if (expected !== null && (!expected || Object.keys(expected).length !== 2 || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 0)) throw new LocalRequestError("invalid-local-request");
  const write = request.operation === "create" || request.operation === "modify";
  const keys = ["requestId", "operation", "path", "expected", "contentKind", ...(write ? ["content"] : []), ...(request.operation === "rename" ? ["targetPath", "targetExpected"] : [])];
  if (Object.keys(request).length !== keys.length || !keys.every(key => Object.hasOwn(request, key)) ||
      (request.operation === "create" ? expected !== null : expected === null) ||
      (write && (!(request.content instanceof Uint8Array) || request.content.byteLength > 128 * 1024 * 1024)) ||
      (request.operation === "rename" && (!validRelativePath(request.targetPath) || request.targetPath === request.path || request.targetExpected !== null))) throw new LocalRequestError("invalid-local-request");
}

export class LocalRequests {
  private snapshots: SnapshotStore;
  constructor(private owner: OwnedDirectories, private state: StateStore, writingMode: "controlled" | "exclusive") {
    if (!["controlled", "exclusive"].includes(writingMode)) throw new LocalRequestError("local-writer-contract-required");
    this.snapshots = new SnapshotStore(owner.state);
  }

  private receipt(record: LocalRequestRecord): LocalReceipt {
    if (record.status === "prepared") throw new LocalRequestError("invalid-local-request");
    return { requestId: record.id, status: record.status, reason: record.reason,
      version: record.after ? { sha256: record.after.sha256, size: record.after.size } : null, synchronization: "not-confirmed" };
  }

  async submit(input: LocalRequest): Promise<LocalReceipt> {
    validate(input);
    const request = { ...input, expected: input.expected ? { sha256: input.expected.sha256, size: input.expected.size } : null, ...(input.content ? { content: Uint8Array.from(input.content) } : {}) };
    const fingerprint = fullDigest(Buffer.from(JSON.stringify({ operation: request.operation, path: request.path, expected: request.expected, contentKind: request.contentKind,
      contentHash: request.content ? fullDigest(request.content) : null, targetPath: request.targetPath ?? null, targetExpected: request.targetExpected ?? null })));
    return await this.owner.exclusive(async () => {
      const prior = this.state.get("local-request", request.requestId);
      if (prior && (prior.record.kind !== "local-request" || prior.record.fingerprint !== fingerprint)) throw new LocalRequestError("request-id-reused");
      await this.recoverLocked();
      if (prior) {
        return this.receipt(this.state.get("local-request", request.requestId)!.record as LocalRequestRecord);
      }
      const current = this.owner.vault.readOptional(request.path);
      const identity = this.owner.vault.fileIdentity(request.path);
      const before = current === null ? null : await this.snapshots.put(current, request.contentKind);
      const after = request.content ? await this.snapshots.put(request.content, request.contentKind) : request.operation === "rename" ? before : null;
      let reason: LocalRequestRecord["reason"] = matches(current, request.expected) ? null : "source-version";
      if (request.targetPath && this.owner.vault.fileIdentity(request.targetPath, request.path) !== null) reason = "target-exists";
      if (!matches(this.owner.vault.readOptional(request.path), before) || this.owner.vault.fileIdentity(request.path) !== identity) reason = "source-version";
      const record: LocalRequestRecord = { formatVersion: 1, kind: "local-request", id: request.requestId, fingerprint, operation: request.operation,
        path: request.path, targetPath: request.targetPath ?? null, contentKind: request.contentKind, before, beforeIdentity: identity, after, status: reason ? "stale" : "prepared", reason };
      this.state.commit([{ type: "put", record, expectedRevision: null }]);
      return this.receipt(reason ? record : await this.applyLocked(record, 1));
    });
  }

  async recover(): Promise<void> { await this.owner.exclusive(() => this.recoverLocked()); }

  private async recoverLocked(): Promise<void> {
    let afterId: string | undefined;
    for (;;) {
      const page = this.state.list("local-request", { afterId, limit: 100 });
      for (const stored of page) {
        if (stored.record.kind === "local-request" && stored.record.status === "prepared") await this.applyLocked(stored.record, stored.revision);
        else if (stored.record.kind === "local-request" && stored.record.status === "applied" && stored.record.operation === "delete") this.owner.vault.finishDeletion(stored.record.path, stored.record.fingerprint, stored.record.beforeIdentity!);
      }
      if (page.length < 100) return;
      afterId = page[page.length - 1].record.id;
    }
  }

  private async applyLocked(record: LocalRequestRecord, revision: number): Promise<LocalRequestRecord> {
    if (record.before) this.snapshots.read(record.before);
    const desired = record.after ? this.snapshots.read(record.after) : null;
    if (record.operation === "create") this.owner.vault.completePublication(record.path);
    const sourceIdentity = this.owner.vault.fileIdentity(record.path, record.targetPath ?? undefined);
    const source = sourceIdentity === null ? null : this.owner.vault.read(record.path);
    let reason: LocalRequestRecord["reason"] = null;
    let done = false;
    if (record.operation === "rename") {
      const targetIdentity = this.owner.vault.fileIdentity(record.targetPath!, record.path);
      done = sourceIdentity === null && targetIdentity === record.beforeIdentity && matches(this.owner.vault.readOptional(record.targetPath!), record.after);
      if (!done && targetIdentity !== null) reason = "target-exists";
    } else if (record.operation === "delete") {
      done = this.owner.vault.deletionStaged(record.path, record.fingerprint, record.beforeIdentity!) || source === null;
    } else {
      done = matches(source, record.after);
    }
    if (!done && !reason && (!matches(source, record.before) || sourceIdentity !== record.beforeIdentity)) reason = "source-version";
    if (!done && !reason) {
      switch (record.operation) {
        case "create": case "modify":
          this.owner.vault.write(record.path, desired!, record.operation === "create" ? "create" : "replace"); break;
        case "delete": this.owner.vault.stageDeletion(record.path, record.fingerprint, record.beforeIdentity!); break;
        case "rename": this.owner.vault.move(record.path, record.targetPath!); break;
      }
      done = true;
    }
    if (done && record.operation !== "delete") this.owner.vault.sync(record.targetPath ?? record.path);
    const parentOf = (value: string) => value.slice(0, value.lastIndexOf("/") + 1);
    if (done && (record.operation === "delete" || (record.operation === "rename" && parentOf(record.path) !== parentOf(record.targetPath!)))) this.owner.vault.syncParent(record.path);
    const next: LocalRequestRecord = { ...record, status: reason ? "stale" : "applied", reason };
    this.state.commit([{ type: "put", record: next, expectedRevision: revision }]);
    if (next.status === "applied" && record.operation === "delete") this.owner.vault.finishDeletion(record.path, record.fingerprint, record.beforeIdentity!);
    return next;
  }
}
