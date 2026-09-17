import { randomUUID } from "node:crypto";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore } from "./state_store";
import type { IdentityBinding } from "./identity";
import type { FileVersion, ReconciliationRecord, BaselineRecord, ConflictRecord, CycleRecord } from "./state_records";
import type { SyncPeer, RemoteInventory } from "./remote";
import { SnapshotStore, fullDigest } from "./snapshots";
import { allRecords, DurableOutbox, pathRecordId, sameVersion } from "./outbox";
import { FileApplication } from "./file_application";
import { LocalRequests } from "./local_requests";
import { ConflictStore } from "./conflicts";
import { VaultScanner } from "./scanner";
import { ConflictResolver } from "./resolution";
import type { ConflictDecision } from "./resolution";

export interface SyncStatus {
  schemaVersion: 1;
  status: "synchronized" | "conflict" | "incomplete";
  pending: number;
  conflicts: number;
  historyUnverified: number;
  foldersDeclared: number;
  foldersBlocked: number;
  lastSuccess: number | null;
  uploaded: number;
  downloaded: number;
}
export class ReconcileError extends Error {
  constructor(public readonly code: "sync-cancelled" | "sync-busy" | "sync-local-changed") { super(code); this.name = "ReconcileError"; }
}
const kindOf = (path: string) => path.endsWith(".md") ? "note" as const : "file" as const;

// Full observations are reconciled against durable common versions. The peer
// owns the official protocol; this coordinator owns no second wire protocol.
export class SyncCoordinator {
  readonly requests: LocalRequests;
  readonly resolver: ConflictResolver;
  private snapshots: SnapshotStore;
  private applications: FileApplication;
  private outbox: DurableOutbox;
  private conflicts: ConflictStore;
  private scanner: VaultScanner;
  private running = false;
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next;
  }
  resolve(decision: ConflictDecision, signal?: AbortSignal) {
    const captured = structuredClone(decision);
    return this.serialize(() => this.resolver.submit(captured, signal));
  }
  constructor(private owner: OwnedDirectories, private state: StateStore, private identity: IdentityBinding, private peer: SyncPeer,
    writingMode: "controlled" | "exclusive") {
    this.requests = new LocalRequests(owner, state, writingMode);
    this.snapshots = new SnapshotStore(owner.state); this.applications = new FileApplication(owner, state, writingMode);
    this.outbox = new DurableOutbox(owner, state, identity); this.conflicts = new ConflictStore(owner, state); this.scanner = new VaultScanner(owner, state);
    this.resolver = new ConflictResolver(owner, state, identity, peer, this.requests);
  }
  status(): SyncStatus {
    const pending = this.outbox.operations().filter(op => !["acknowledged", "cancelled"].includes(op.status)).length;
    const conflicts = allRecords(this.state, "conflict").filter(value => value.record.kind === "conflict" && value.record.status === "open").length;
    const cycle = this.state.get("cycle", "latest")?.record as CycleRecord | undefined;
    // A persisted checkpoint describes the previous run, never current health.
    return { schemaVersion: 1, status: conflicts ? "conflict" : "incomplete", pending, conflicts, historyUnverified: 0,
      foldersDeclared: 0, foldersBlocked: 0, lastSuccess: cycle?.completedAt ?? null, uploaded: 0, downloaded: 0 };
  }
  private baselineMutation(path: string, version: FileVersion | null, id: string): Parameters<StateStore["commit"]>[0][number] {
    const old = this.state.get("baseline", pathRecordId(path));
    return { type: "put", expectedRevision: old?.revision ?? null, record: { formatVersion: 1, kind: "baseline", id: pathRecordId(path), path, version, confirmedOperationId: id } };
  }
  private async confirmObserved(path: string, version: FileVersion | null): Promise<void> {
    await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      const bytes = this.owner.vault.readOptional(path);
      if ((bytes === null ? null : fullDigest(bytes)) !== (version?.sha256 ?? null)) throw new ReconcileError("sync-local-changed");
      if (!sameVersion(this.outbox.baseline(path)?.version ?? null, version) || !this.outbox.baseline(path)) {
        this.state.commit([this.baselineMutation(path, version, randomUUID())]);
      }
    });
  }
  private async applyPlan(record: ReconciliationRecord): Promise<boolean> {
    this.identity.assertVerified();
    let applied = false;
    try {
      if (record.after) {
        if (!this.state.get("application", record.id)) await this.applications.prepare(record.id, record.path, this.snapshots.read(record.after), kindOf(record.path), record.before);
        applied = (await this.applications.apply(record.id)).status === "applied";
      } else {
        const before = record.before!;
        applied = (await this.requests.submit({ requestId: record.id, operation: "delete", path: record.path,
          contentKind: kindOf(record.path), expected: { sha256: before.sha256, size: before.size } })).status === "applied";
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "stale-version") throw error;
    }
    await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      const stored = this.state.get("reconcile", record.id)!;
      this.state.commit([
        { type: "put", expectedRevision: stored.revision, record: { ...record, status: applied ? "committed" : "diverged" } },
        ...(applied ? [this.baselineMutation(record.path, record.after, record.id)] : []),
      ]);
    });
    return applied;
  }
  private async receive(path: string, before: FileVersion | null, after: FileVersion | null): Promise<boolean> {
    const record: ReconciliationRecord = { formatVersion: 1, kind: "reconcile", id: randomUUID(), path, before, after, status: "prepared" };
    await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      this.state.commit([{ type: "put", expectedRevision: null, record }]);
    });
    return this.applyPlan(record);
  }
  private async conflict(path: string, remote: FileVersion | null): Promise<void> {
    const current = this.owner.vault.readOptional(path), digest = current === null ? null : fullDigest(current);
    if (digest === (remote?.sha256 ?? null)) return;
    const prior = allRecords(this.state, "conflict").some(value => {
      const conflict = value.record as ConflictRecord;
      return conflict.status === "open" && conflict.path === path && (conflict.local?.sha256 ?? null) === digest && sameVersion(conflict.remote, remote);
    });
    if (prior) return;
    const base = this.outbox.baseline(path);
    await this.conflicts.capture(randomUUID(), path, remote ? this.snapshots.read(remote) : null, kindOf(path),
      !base ? { status: "missing" } : base.version ? { status: "present", version: base.version } : { status: "absent" });
  }
  private async flush(remote: RemoteInventory, signal?: AbortSignal): Promise<number> {
    let count = 0;
    for (const operation of this.outbox.operations()) {
      if (["acknowledged", "cancelled"].includes(operation.status)) continue;
      if (signal?.aborted) throw new ReconcileError("sync-cancelled");
      if (allRecords(this.state, "conflict").some(value => value.record.kind === "conflict" && value.record.status === "open" && value.record.path === operation.path)) continue;
      try {
        await this.peer.upload(operation.id, signal); count++;
        if (operation.action === "rename") { remote.files.delete(operation.path); remote.deleted.add(operation.path); }
        const path = operation.targetPath ?? operation.path;
        if (operation.desired) { remote.files.set(path, operation.desired); remote.deleted.delete(path); }
        else { remote.files.delete(path); remote.deleted.add(path); }
      } catch (error) {
        if ((error as { code?: string }).code !== "remote-version-changed") throw error;
        await this.peer.authenticate(signal);
        await this.outbox.block(operation.id);
        await this.conflict(operation.path, await this.peer.read(operation.path, signal));
      }
      await this.peer.authenticate(signal);
    }
    return count;
  }

  // Folder rows carry no content, so the durable evidence for a local deletion
  // is a previously completed scan that still listed the directory. Creations
  // are idempotent upserts; removals follow the server only while the directory
  // is empty, and every refusal stays observable instead of being forced.
  private async applyFolders(remote: RemoteInventory, local: Set<string>, deletionIntents: Set<string>): Promise<number> {
    let blocked = 0;
    await this.owner.exclusive(async () => {
      this.identity.assertVerified();
      const tolerated = new Set(["already-exists", "not-found", "not-empty", "case-collision", "unsafe-path", "already-exists"]);
      for (const path of [...remote.folders].sort()) {
        if (local.has(path) || deletionIntents.has(path)) continue;
        try {
          if (this.owner.vault.hasDirectory(path)) continue;
          const parent = path.split("/").slice(0, -1).join("/");
          if (parent) this.owner.vault.createDirectories(parent);
          this.owner.vault.createDirectory(path);
        } catch (error) {
          if (!tolerated.has((error as { code?: string }).code ?? "")) throw error;
          blocked++;
        }
      }
      for (const path of [...remote.deletedFolders].sort()) {
        if (!local.has(path) || deletionIntents.has(path)) continue;
        try { this.owner.vault.removeDirectory(path); }
        catch (error) {
          if (!tolerated.has((error as { code?: string }).code ?? "")) throw error;
          blocked++;
        }
      }
    });
    return blocked;
  }

  once(signal?: AbortSignal): Promise<SyncStatus> { return this.serialize(() => this.cycle(signal)); }
  private async cycle(signal?: AbortSignal): Promise<SyncStatus> {
    if (this.running) throw new ReconcileError("sync-busy");
    this.running = true;
    try {
      await this.peer.authenticate(signal);
      await this.requests.recover();
      await this.resolver.recover(signal);
      for (const value of allRecords(this.state, "reconcile")) {
        const record = value.record as ReconciliationRecord;
        if (record.status === "prepared") await this.applyPlan(record);
      }
      // Observe the complete local tree first, then declare this host's folder
      // changes on the same connection that requests the server inventory.
      const previousDirectories = new Set(this.scanner.latest()?.directories ?? []);
      const scan = await this.scanner.scan(signal), local = new Map(scan.files.map(file => [file.path, file.version]));
      const localDirectories = new Set(scan.directories);
      // Directories holding synchronized content are implied on the server, so
      // the folder channel only has to carry directories created since the last
      // complete scan. Upserts are idempotent; a directory that merely became
      // empty follows the server instead of being re-declared.
      const folderUpserts = [...localDirectories].filter(path => !previousDirectories.has(path)).sort();
      const folderDeletions = [...previousDirectories].filter(path => !localDirectories.has(path)).sort();
      const deletionIntents = new Set(folderDeletions);
      const remote = await this.peer.inventory(signal, { folders: folderUpserts, delFolders: folderDeletions });
      let uploaded = await this.flush(remote, signal), downloaded = 0, historyUnverified = 0;
      // Explicit controlled renames are durable intents. A deterministic ID
      // prevents an old local request being replayed after later path reuse.
      for (const value of allRecords(this.state, "local-request")) {
        const request = value.record;
        if (request.kind !== "local-request" || request.operation !== "rename" || request.status !== "applied") continue;
        const id = pathRecordId(`local-rename:${request.id}`);
        if (this.state.get("operation", id) || !local.has(request.targetPath!) || !request.before) continue;
        if (!sameVersion(this.outbox.baseline(request.path)?.version ?? null, request.before) || !sameVersion(remote.files.get(request.path) ?? null, request.before) || remote.files.has(request.targetPath!)) continue;
        await this.outbox.prepare(request.path, request.before, request.before, "rename", request.targetPath, id);
      }
      uploaded += await this.flush(remote, signal);
      const paths = new Set([...local.keys(), ...remote.files.keys(), ...allRecords(this.state, "baseline").map(value => (value.record as BaselineRecord).path)]);
      // Publish replacement destinations before propagating offline deletions.
      const ordered = [...paths].sort((a, b) => Number(!local.has(a)) - Number(!local.has(b)) || a.localeCompare(b));
      for (const path of ordered) {
        if (signal?.aborted) throw new ReconcileError("sync-cancelled");
        if (allRecords(this.state, "conflict").some(value => value.record.kind === "conflict" && value.record.status === "open" && value.record.path === path) ||
            this.outbox.operations().some(op => !["acknowledged", "cancelled"].includes(op.status) && (op.path === path || op.targetPath === path))) continue;
        const here = local.get(path) ?? null, there = remote.files.get(path) ?? null, base = this.outbox.baseline(path);
        if (sameVersion(here, there)) { await this.confirmObserved(path, here); continue; }
        if ((!base && here === null) || base && sameVersion(here, base.version)) {
          if (there === null && !remote.deleted.has(path)) { historyUnverified++; continue; }
          if (await this.receive(path, here, there)) downloaded++;
          else await this.conflict(path, there);
        } else if ((!base && there === null) || base && sameVersion(there, base.version)) {
          await this.outbox.prepare(path, here, there);
          uploaded += await this.flush(remote, signal);
        } else await this.conflict(path, there);
      }
      const foldersBlocked = await this.applyFolders(remote, localDirectories, deletionIntents);
      // The folder channel never echoes a client's own declarations back to
      // it, so a completed declaration (batch acknowledgement included) is the
      // receipt. Empty directories carry no content; a lost declaration is
      // re-sent idempotently by the next cycle.
      const foldersDeclared = folderUpserts.length + folderDeletions.length;
      const status = { ...this.status(), uploaded, downloaded, historyUnverified, foldersDeclared, foldersBlocked };
      // A controlled edit during transfer must remain observable as pending
      // work, even if the last operation's Ack was successful.
      await this.scanner.scan(signal, final => {
        // A directory holding a synchronized file exists on both sides even when
        // the server did not list it separately, so implied parents count. An
        // empty directory carries no content: it is either declared as an
        // upsert or left for the next cycle without blocking completion.
        const implied = new Set<string>();
        for (const path of remote.files.keys()) {
          const parts = path.split("/");
          for (let index = 1; index < parts.length; index++) implied.add(parts.slice(0, index).join("/"));
        }
        const occupied = new Set<string>();
        for (const path of [...final.files.map(file => file.path), ...final.directories]) {
          const parts = path.split("/"); parts.pop();
          while (parts.length) { occupied.add(parts.join("/")); parts.pop(); }
        }
        const localHas = new Set(final.directories);
        const foldersStable = final.directories.every(path => !occupied.has(path) || remote.folders.has(path) || implied.has(path) || deletionIntents.has(path) || folderUpserts.includes(path)) &&
          [...remote.folders].every(path => localHas.has(path) || deletionIntents.has(path));
        const stable = final.files.length === remote.files.size && final.files.every(file => sameVersion(file.version, remote.files.get(file.path) ?? null)) && foldersStable;
        if (!status.pending && !status.conflicts && !historyUnverified && !foldersBlocked && stable) {
          this.identity.assertVerified();
          const previous = this.state.get("cycle", "latest");
          const completedAt = Date.now();
          this.state.commit([{ type: "put", expectedRevision: previous?.revision ?? null, record: {
            formatVersion: 1, kind: "cycle", id: "latest", completedAt, noteTime: remote.noteTime, fileTime: remote.fileTime, fileCount: final.files.length,
          } }]);
          status.lastSuccess = completedAt; status.status = "synchronized";
        }
      });
      return status;
    } finally { this.running = false; }
  }
}
