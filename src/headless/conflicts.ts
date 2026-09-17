import type { OwnedDirectories } from "./filesystem";
import { fullDigest, SnapshotStore } from "./snapshots";
import type { ContentKind } from "./snapshots";
import { validIdentifier, validRelativePath } from "./state_records";
import type { ConflictRecord, FileVersion } from "./state_records";
import type { StateStore } from "./state_store";

export type ConflictBase = { status: "missing" | "absent" } | { status: "present"; version: FileVersion };

export class ConflictError extends Error {
  constructor(public readonly code: "invalid-conflict" | "conflict-local-changed" | "conflict-not-found") {
    super(code);
    this.name = "ConflictError";
  }
}

// Capture only: decisions, resolution and remote preconditions are separate
// work. A conflict never selects a winner or advances a synchronization cursor.
export class ConflictStore {
  private snapshots: SnapshotStore;
  constructor(private owner: OwnedDirectories, private state: StateStore) {
    this.snapshots = new SnapshotStore(owner.state);
  }

  async capture(id: string, path: string, remoteInput: Uint8Array | null, kind: ContentKind, baseInput: ConflictBase): Promise<ConflictRecord> {
    if (!validIdentifier(id) || !validRelativePath(path) || !baseInput ||
        !["missing", "absent", "present"].includes(baseInput.status) ||
        (remoteInput !== null && remoteInput.byteLength > 128 * 1024 * 1024)) throw new ConflictError("invalid-conflict");
    const remoteBytes = remoteInput === null ? null : Uint8Array.from(remoteInput);
    const base: ConflictBase = baseInput.status === "present" ? { status: "present", version: { ...baseInput.version } } : { status: baseInput.status };
    return await this.owner.exclusive(async () => {
      if (this.state.get("conflict", id)) throw new ConflictError("invalid-conflict");
      if (base.status === "present") this.snapshots.read(base.version);
      const localBytes = this.owner.vault.readOptional(path);
      if ((localBytes === null ? null : fullDigest(localBytes)) === (remoteBytes === null ? null : fullDigest(remoteBytes))) throw new ConflictError("invalid-conflict");
      const local = localBytes === null ? null : await this.snapshots.put(localBytes, kind);
      const remote = remoteBytes === null ? null : await this.snapshots.put(remoteBytes, kind);
      const current = this.owner.vault.readOptional(path);
      if ((current === null ? null : fullDigest(current)) !== (local?.sha256 ?? null)) throw new ConflictError("conflict-local-changed");
      const record: ConflictRecord = {
        formatVersion: 1, kind: "conflict", id, path, contentKind: kind,
        baseStatus: base.status, base: base.status === "present" ? base.version : null,
        local, remote, status: "open",
      };
      this.state.commit([{ type: "put", record, expectedRevision: null }]);
      return record;
    });
  }

  get(id: string): ConflictRecord {
    const stored = this.state.get("conflict", id);
    if (!stored || stored.record.kind !== "conflict") throw new ConflictError("conflict-not-found");
    const record = stored.record;
    // A damaged/missing snapshot is a recovery failure, never an empty version.
    for (const version of [record.base, record.local, record.remote]) if (version) this.snapshots.read(version);
    return record;
  }
}
