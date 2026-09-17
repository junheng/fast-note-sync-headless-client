import { randomUUID, createHash } from "node:crypto";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore, StoredRecord } from "./state_store";
import type { IdentityBinding } from "./identity";
import { SnapshotStore } from "./snapshots";
import { validFileVersion, validIdentifier } from "./state_records";
import { validSyncPath } from "./sync_validation";
import type { FileVersion, OperationRecord, BaselineRecord, RecordKind } from "./state_records";

export const pathRecordId = (path: string): string => createHash("sha256").update(path).digest("hex");
export const sameVersion = (a: FileVersion | null, b: FileVersion | null): boolean =>
  a === null ? b === null : b !== null && a.sha256 === b.sha256 && a.size === b.size;

export function allRecords(state: StateStore, kind: RecordKind): StoredRecord[] {
  const result: StoredRecord[] = [];
  let afterId: string | undefined;
  for (;;) {
    const page = state.list(kind, { afterId, limit: 1000 });
    result.push(...page);
    if (page.length < 1000) return result;
    afterId = page[page.length - 1].record.id;
  }
}

export class OutboxError extends Error {
  constructor(public readonly code: "invalid-operation" | "operation-not-found" | "operation-order" | "operation-unconfirmed" | "operation-limit") {
    super(code); this.name = "OutboxError";
  }
}

// Network writes are driven only by these durable, immutable versions. An Ack
// is evidence to request a readback; it alone never commits a newer local edit.
export class DurableOutbox {
  private snapshots: SnapshotStore;
  constructor(private owner: OwnedDirectories, private state: StateStore, private identity: IdentityBinding) {
    this.snapshots = new SnapshotStore(owner.state);
  }

  operations(): OperationRecord[] {
    return allRecords(this.state, "operation").map(value => value.record as OperationRecord)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id));
  }

  baseline(path: string): BaselineRecord | null {
    const record = this.state.get("baseline", pathRecordId(path))?.record;
    return record?.kind === "baseline" ? record : null;
  }

  async prepare(path: string, desiredInput: FileVersion | null, remoteInput: FileVersion | null,
    action: OperationRecord["action"] = desiredInput === null ? "delete" : remoteInput === null ? "create" : "modify",
    targetPath: string | null = null, operationId?: string): Promise<OperationRecord> {
    if (!validSyncPath(path) || !validFileVersion(desiredInput) || !validFileVersion(remoteInput) ||
        !["create", "modify", "delete", "rename"].includes(action) || (action === "delete") !== (desiredInput === null) ||
        (action === "rename" ? !validSyncPath(targetPath) || targetPath === path || !remoteInput || !sameVersion(desiredInput, remoteInput) ||
          path.endsWith(".md") !== targetPath.endsWith(".md") : targetPath !== null)) throw new OutboxError("invalid-operation");
    if (operationId !== undefined && !validIdentifier(operationId)) throw new OutboxError("invalid-operation");
    const desired = desiredInput ? { ...desiredInput } : null, expectedRemote = remoteInput ? { ...remoteInput } : null;
    return await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      if (desired) this.snapshots.read(desired);
      if (expectedRemote) this.snapshots.read(expectedRemote);
      const existing = this.operations();
      const identified = operationId ? existing.find(op => op.id === operationId) : undefined;
      if (identified) {
        if (identified.path !== path || identified.action !== action || identified.targetPath !== targetPath ||
            !sameVersion(identified.desired, desired) || !sameVersion(identified.expectedRemote, expectedRemote)) throw new OutboxError("invalid-operation");
        return identified;
      }
      const prior = existing.filter(op => op.path === path && !["acknowledged", "cancelled"].includes(op.status)).at(-1);
      if (!operationId && prior && sameVersion(prior.desired, desired) && sameVersion(prior.expectedRemote, expectedRemote) && prior.action === action && prior.targetPath === targetPath) return prior;
      if (existing.length >= 10000) throw new OutboxError("operation-limit");
      const record: OperationRecord = { formatVersion: 1, kind: "operation", id: operationId ?? randomUUID(), path, action, targetPath,
        status: "pending", base: this.baseline(path)?.version ?? null, desired, expectedRemote,
        sessionId: null, context: randomUUID(), sequence: (existing.at(-1)?.sequence ?? 0) + 1 };
      this.state.commit([{ type: "put", expectedRevision: null, record }]);
      return record;
    });
  }

  async sent(id: string, generation: string): Promise<OperationRecord> {
    if (!validIdentifier(generation)) throw new OutboxError("invalid-operation");
    return await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      const stored = this.state.get("operation", id);
      if (!stored || stored.record.kind !== "operation") throw new OutboxError("operation-not-found");
      const record = stored.record;
      if (["acknowledged", "cancelled"].includes(record.status)) throw new OutboxError("operation-order");
      const paths = new Set([record.path, ...(record.targetPath ? [record.targetPath] : [])]);
      const first = this.operations().find(op => !["acknowledged", "cancelled"].includes(op.status) &&
        (paths.has(op.path) || op.targetPath !== null && paths.has(op.targetPath)));
      if (first?.id !== id) throw new OutboxError("operation-order");
      if (record.desired) this.snapshots.read(record.desired);
      if (record.expectedRemote) this.snapshots.read(record.expectedRemote);
      const next: OperationRecord = { ...record, sessionId: generation, context: randomUUID(), status: "sent" };
      this.state.commit([{ type: "put", record: next, expectedRevision: stored.revision }]);
      return next;
    });
  }

  async block(id: string): Promise<void> {
    await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      const stored = this.state.get("operation", id);
      if (!stored || stored.record.kind !== "operation") throw new OutboxError("operation-not-found");
      if (!["acknowledged", "cancelled"].includes(stored.record.status)) this.state.commit([{ type: "put", record: { ...stored.record, status: "blocked" }, expectedRevision: stored.revision }]);
    });
  }

  async confirm(id: string, generation: string, context: string, remote: FileVersion | null, renameSource?: FileVersion | null): Promise<boolean> {
    return await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      const stored = this.state.get("operation", id);
      if (!stored || stored.record.kind !== "operation") throw new OutboxError("operation-not-found");
      const operation = stored.record;
      if (operation.status !== "sent" || operation.sessionId !== generation || operation.context !== context) return false;
      if (!validFileVersion(remote) || !sameVersion(operation.desired, remote)) throw new OutboxError("operation-unconfirmed");
      if (operation.action === "rename" && renameSource !== null) throw new OutboxError("operation-unconfirmed");
      if (remote) this.snapshots.read(remote);
      // A content-equivalent readback confirms exactly the sent version. The
      // local file is intentionally not read here: it may already be version B.
      const baselinePath = operation.action === "rename" ? operation.targetPath! : operation.path;
      const baseline = this.state.get("baseline", pathRecordId(baselinePath));
      const next: BaselineRecord = { formatVersion: 1, kind: "baseline", id: pathRecordId(baselinePath), path: baselinePath,
        version: operation.desired, confirmedOperationId: operation.id };
      const mutations: Parameters<StateStore["commit"]>[0] = [
        { type: "put", record: { ...operation, status: "acknowledged" }, expectedRevision: stored.revision },
        { type: "put", record: next, expectedRevision: baseline?.revision ?? null },
      ];
      if (operation.action === "rename") {
        const source = this.state.get("baseline", pathRecordId(operation.path));
        mutations.push({ type: "put", record: { ...next, id: pathRecordId(operation.path), path: operation.path, version: null }, expectedRevision: source?.revision ?? null });
      }
      this.state.commit(mutations);
      return true;
    });
  }
}
