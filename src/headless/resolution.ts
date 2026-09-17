import { Buffer } from "node:buffer";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore, StateMutation } from "./state_store";
import type { IdentityBinding } from "./identity";
import type { SyncPeer } from "./remote";
import type { ConflictRecord, DecisionRecord, FileVersion } from "./state_records";
import { validIdentifier } from "./state_records";
import { SnapshotStore, fullDigest } from "./snapshots";
import { allRecords, DurableOutbox, pathRecordId, sameVersion } from "./outbox";
import { ConflictStore } from "./conflicts";
import { LocalRequests } from "./local_requests";
import type { ExpectedVersion } from "./local_requests";

export interface ConflictDecision {
  schemaVersion: 1;
  decisionId: string;
  conflictId: string;
  action: DecisionRecord["action"];
  expectedLocal: ExpectedVersion | null;
  expectedRemote: ExpectedVersion | null;
  contentBase64?: string;
}
export class ResolutionError extends Error {
  constructor(public readonly code: "invalid-decision" | "decision-id-reused" | "decision-pending" | "resolution-stale" | "conflict-read-limit") { super(code); this.name = "ResolutionError"; }
}
const expected = (version: FileVersion | null): ExpectedVersion | null => version ? { sha256: version.sha256, size: version.size } : null;
const validExpected = (value: ExpectedVersion | null) => value === null || !!value && Object.keys(value).sort().join() === "sha256,size" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size >= 0;
const matchesExpected = (a: ExpectedVersion | null, b: FileVersion | null) => a === null ? b === null : !!b && a.sha256 === b.sha256 && a.size === b.size;
const operationId = (id: string) => pathRecordId(`resolution-upload:${id}`);
const requestId = (id: string) => pathRecordId(`resolution-local:${id}`);

// Called by the coordinator's serialized network queue. The guarded local
// request keeps remote/local revalidation and file application under the same
// Vault mutex as ordinary Bot writes. Remote atomicity remains upstream's.
export class ConflictResolver {
  private snapshots: SnapshotStore;
  private conflicts: ConflictStore;
  private outbox: DurableOutbox;
  constructor(private owner: OwnedDirectories, private state: StateStore, private identity: IdentityBinding, private peer: SyncPeer, private requests: LocalRequests) {
    this.snapshots = new SnapshotStore(owner.state); this.conflicts = new ConflictStore(owner, state); this.outbox = new DurableOutbox(owner, state, identity);
  }
  list(afterId?: string, limit = 100) {
    if (afterId !== undefined && !validIdentifier(afterId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ResolutionError("invalid-decision");
    const records = this.state.list("conflict", { afterId, limit });
    return { schemaVersion: 1, conflicts: records.map(value => value.record), next: records.length === limit ? records.at(-1)!.record.id : null };
  }
  detail(id: string): ConflictRecord { if (!validIdentifier(id)) throw new ResolutionError("invalid-decision"); return this.conflicts.get(id); }
  snapshot(id: string, side: "base" | "local" | "remote", offset: number, length: number) {
    if (!["base", "local", "remote"].includes(side) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) throw new ResolutionError("conflict-read-limit");
    const version = this.detail(id)[side];
    if (!version) return { schemaVersion: 1, version: null, contentBase64: null, next: null };
    if (offset > version.size) throw new ResolutionError("conflict-read-limit");
    const content = this.snapshots.read(version).subarray(offset, offset + length);
    return { schemaVersion: 1, version: expected(version), contentBase64: content.toString("base64"), next: offset + content.length < version.size ? offset + content.length : null };
  }
  private receipt(record: DecisionRecord) {
    return { schemaVersion: 1, decisionId: record.id, conflictId: record.conflictId,
      status: record.status === "confirmed" ? "resolved" : record.status === "stale" ? "stale" : "pending",
      synchronization: record.status === "confirmed" ? "confirmed" : "not-confirmed", nextConflictId: record.nextConflictId };
  }
  decision(id: string) {
    if (!validIdentifier(id)) throw new ResolutionError("invalid-decision");
    const stored = this.state.get("decision", id);
    if (!stored || stored.record.kind !== "decision") throw new ResolutionError("invalid-decision");
    return this.receipt(stored.record);
  }
  async submit(input: ConflictDecision, signal?: AbortSignal) {
    if (!input || input.schemaVersion !== 1 || !validIdentifier(input.decisionId) || !validIdentifier(input.conflictId) ||
        !["merge", "keep-local", "keep-remote", "delete"].includes(input.action) || !validExpected(input.expectedLocal) || !validExpected(input.expectedRemote)) throw new ResolutionError("invalid-decision");
    const fields = ["schemaVersion", "decisionId", "conflictId", "action", "expectedLocal", "expectedRemote", ...(input.action === "merge" ? ["contentBase64"] : [])];
    if (Object.keys(input).length !== fields.length || !fields.every(key => Object.hasOwn(input, key))) throw new ResolutionError("invalid-decision");
    input = { ...input, expectedLocal: input.expectedLocal ? { ...input.expectedLocal } : null, expectedRemote: input.expectedRemote ? { ...input.expectedRemote } : null };
    let bytes: Buffer | undefined;
    if (input.action === "merge") {
      if (typeof input.contentBase64 !== "string" || input.contentBase64.length > 12 * 1024 * 1024) throw new ResolutionError("invalid-decision");
      bytes = Buffer.from(input.contentBase64, "base64");
      if (bytes.toString("base64") !== input.contentBase64) throw new ResolutionError("invalid-decision");
    }
    // Canonical fingerprint is independent of input object property order.
    const fingerprint = fullDigest(Buffer.from(JSON.stringify({ conflictId: input.conflictId, action: input.action,
      local: input.expectedLocal ? { sha256: input.expectedLocal.sha256, size: input.expectedLocal.size } : null,
      remote: input.expectedRemote ? { sha256: input.expectedRemote.sha256, size: input.expectedRemote.size } : null,
      content: bytes ? fullDigest(bytes) : null })));
    const previous = this.state.get("decision", input.decisionId)?.record as DecisionRecord | undefined;
    if (previous && previous.fingerprint !== fingerprint) throw new ResolutionError("decision-id-reused");
    if (!previous) {
      const conflict = this.detail(input.conflictId);
      if (conflict.status !== "open" || !matchesExpected(input.expectedLocal, conflict.local) || !matchesExpected(input.expectedRemote, conflict.remote)) throw new ResolutionError("invalid-decision");
      if (allRecords(this.state, "decision").some(value => {
        if (value.record.kind !== "decision" || !["prepared", "applied"].includes(value.record.status)) return false;
        const previousConflict = this.state.get("conflict", value.record.conflictId)?.record;
        return previousConflict?.kind === "conflict" && previousConflict.path === conflict.path;
      })) throw new ResolutionError("decision-pending");
      await this.peer.authenticate(signal);
      const desired = input.action === "merge" ? await this.snapshots.put(bytes!, conflict.contentKind) : input.action === "keep-local" ? conflict.local : input.action === "keep-remote" ? conflict.remote : null;
      await this.owner.exclusive(async () => {
        this.identity.assertVerified();
        this.state.commit([{ type: "put", expectedRevision: null, record: { formatVersion: 1, kind: "decision", id: input.decisionId, conflictId: conflict.id,
          fingerprint, action: input.action, desired, status: "prepared", nextConflictId: null } }]);
      });
    }
    await this.resume(input.decisionId, signal);
    return this.receipt(this.state.get("decision", input.decisionId)!.record as DecisionRecord);
  }
  async recover(signal?: AbortSignal): Promise<void> {
    for (const value of allRecords(this.state, "decision")) {
      const record = value.record as DecisionRecord;
      if (["prepared", "applied"].includes(record.status)) await this.resume(record.id, signal);
    }
  }
  private async stale(record: DecisionRecord, conflict: ConflictRecord, signal?: AbortSignal): Promise<void> {
    await this.peer.authenticate(signal);
    const remote = await this.peer.read(conflict.path, signal);
    const nextId = pathRecordId(`resolution-stale:${record.id}`);
    if (!this.state.get("conflict", nextId)) await this.conflicts.capture(nextId, conflict.path, remote ? this.snapshots.read(remote) : null, conflict.contentKind,
      conflict.baseStatus === "present" ? { status: "present", version: conflict.base! } : { status: conflict.baseStatus }, true);
    await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      const current = this.state.get("decision", record.id)!;
      const mutations: StateMutation[] = [{ type: "put", expectedRevision: current.revision, record: { ...record, status: "stale", nextConflictId: nextId } }];
      for (const value of allRecords(this.state, "conflict")) if (value.record.kind === "conflict" && value.record.path === conflict.path && value.record.id !== nextId && value.record.status === "open") {
        mutations.push({ type: "put", expectedRevision: value.revision, record: { ...value.record, status: "superseded" } });
      }
      const upload = this.state.get("operation", operationId(record.id));
      if (upload?.record.kind === "operation" && upload.record.status !== "acknowledged") mutations.push({ type: "put", expectedRevision: upload.revision, record: { ...upload.record, status: "cancelled" } });
      const local = this.state.get("local-request", requestId(record.id));
      if (local?.record.kind === "local-request" && local.record.status === "prepared") mutations.push({ type: "put", expectedRevision: local.revision, record: { ...local.record, status: "stale", reason: "source-version" } });
      this.state.commit(mutations);
    });
  }
  private async resume(id: string, signal?: AbortSignal): Promise<void> {
    let record = this.state.get("decision", id)!.record as DecisionRecord;
    if (["confirmed", "stale"].includes(record.status)) return;
    const conflict = this.detail(record.conflictId);
    // Creating the replacement conflict is durable evidence that this decision
    // already became stale, even if the following terminal commit crashed.
    if (this.state.get("conflict", pathRecordId(`resolution-stale:${id}`))) { await this.stale(record, conflict, signal); return; }
    await this.peer.authenticate(signal);
    if (record.status === "prepared") {
      const appliedLocked = () => {
        this.identity.assertVerified();
        const current = this.state.get("decision", id)!;
        const mutations: StateMutation[] = [{ type: "put", expectedRevision: current.revision, record: { ...record, status: "applied" } }];
        for (const value of allRecords(this.state, "operation")) {
          const op = value.record;
          if (op.kind === "operation" && !["acknowledged", "cancelled"].includes(op.status) && (op.path === conflict.path || op.targetPath === conflict.path)) {
            mutations.push({ type: "put", expectedRevision: value.revision, record: { ...op, status: "cancelled" } });
          }
        }
        this.state.commit(mutations);
      };
      const validate = async () => {
        this.identity.assertVerified();
        if (!sameVersion(await this.peer.read(conflict.path, signal), conflict.remote)) throw new ResolutionError("resolution-stale");
        const local = this.owner.vault.readOptional(conflict.path);
        const digest = local === null ? null : fullDigest(local);
        const recovering = this.state.get("local-request", requestId(record.id))?.record;
        const published = recovering?.kind === "local-request" && recovering.decisionId === id && recovering.status === "prepared" && digest === (record.desired?.sha256 ?? null);
        if (!published && digest !== (conflict.local?.sha256 ?? null)) throw new ResolutionError("resolution-stale");
      };
      try {
        if (record.desired === null && conflict.local === null) await this.owner.exclusive(async () => { await validate(); appliedLocked(); });
        else {
          const receipt = await this.requests.submit({ requestId: requestId(record.id), path: conflict.path, contentKind: conflict.contentKind,
            operation: record.desired === null ? "delete" : conflict.local === null ? "create" : "modify", expected: expected(conflict.local),
            ...(record.desired ? { content: this.snapshots.read(record.desired) } : {}) }, validate, id);
          if (receipt.status === "stale") throw new ResolutionError("resolution-stale");
          await this.owner.exclusive(async () => appliedLocked());
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "resolution-stale") throw error;
        await this.stale(record, conflict, signal); return;
      }
      record = this.state.get("decision", id)!.record as DecisionRecord;
    }
    const operation = await this.outbox.prepare(conflict.path, record.desired, conflict.remote, undefined, null, operationId(id));
    if (operation.status !== "acknowledged") {
      try { await this.peer.upload(operation.id, signal); }
      catch (error) {
        if ((error as { code?: string }).code !== "remote-version-changed") throw error;
        await this.stale(record, conflict, signal); return;
      }
    }
    await this.peer.authenticate(signal);
    await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      if (this.state.get("operation", operation.id)?.record.kind !== "operation" || (this.state.get("operation", operation.id)!.record as { status: string }).status !== "acknowledged") throw new ResolutionError("decision-pending");
      const decision = this.state.get("decision", id)!;
      const mutations: StateMutation[] = [{ type: "put", expectedRevision: decision.revision, record: { ...record, status: "confirmed" } }];
      for (const value of allRecords(this.state, "conflict")) if (value.record.kind === "conflict" && value.record.path === conflict.path && value.record.status === "open") {
        mutations.push({ type: "put", expectedRevision: value.revision, record: { ...value.record, status: value.record.id === conflict.id ? "resolved" : "superseded" } });
      }
      this.state.commit(mutations);
    });
  }
}
