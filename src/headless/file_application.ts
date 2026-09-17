import type { OwnedDirectories } from "./filesystem";
import { SnapshotStore, fullDigest } from "./snapshots";
import type { ContentKind } from "./snapshots";
import { validFileVersion, validIdentifier, validRelativePath } from "./state_records";
import type { ApplicationRecord, FileVersion } from "./state_records";
import type { StateStore } from "./state_store";
import { writeNoteContent } from "../lib/sync/note_protocol";

export class ApplicationError extends Error {
  constructor(public readonly code: "invalid-application" | "stale-version" | "application-not-found" | "writing-mode-required" | "application-version-mismatch") {
    super(code);
    this.name = "ApplicationError";
  }
}

const matches = (bytes: Uint8Array | null, version: FileVersion | null) =>
  bytes === null ? version === null : version !== null && bytes.byteLength === version.size && fullDigest(bytes) === version.sha256;

// Local file application only. An 'applied' receipt does not confirm a remote
// write, commit a synchronization batch or advance the shared baseline.
export class FileApplication {
  private snapshots: SnapshotStore;

  constructor(private owner: OwnedDirectories, private state: StateStore, writingMode: "controlled" | "exclusive") {
    if (writingMode !== "controlled" && writingMode !== "exclusive") throw new ApplicationError("writing-mode-required");
    this.snapshots = new SnapshotStore(owner.state);
  }

  async prepare(id: string, path: string, input: Uint8Array, kind: ContentKind, expected: FileVersion | null): Promise<ApplicationRecord> {
    if (!validIdentifier(id) || !validRelativePath(path) || !validFileVersion(expected) || input.byteLength > 128 * 1024 * 1024) throw new ApplicationError("invalid-application");
    // Copy before waiting for the owner mutex, not only when snapshotting later.
    const desired = Uint8Array.from(input);
    const expectedVersion = expected === null ? null : { ...expected };
    return await this.owner.exclusive(async () => {
      if (this.state.get("application", id)) throw new ApplicationError("invalid-application");
      const current = this.owner.vault.readOptional(path);
      if (!matches(current, expectedVersion)) throw new ApplicationError("stale-version");
      const before = current === null ? null : await this.snapshots.put(current, kind);
      const after = await this.snapshots.put(desired, kind);
      // Hashing can yield. Revalidate before recording an executable intent.
      if (!matches(this.owner.vault.readOptional(path), before)) throw new ApplicationError("stale-version");
      const record: ApplicationRecord = { formatVersion: 1, kind: "application", id, path, contentKind: kind, before, after, observed: null, status: "prepared" };
      this.state.commit([{ type: "put", record, expectedRevision: null }]);
      return record;
    });
  }

  async apply(id: string): Promise<ApplicationRecord> {
    return await this.owner.exclusive(async () => {
      const stored = this.state.get("application", id);
      if (!stored || stored.record.kind !== "application") throw new ApplicationError("application-not-found");
      const record = stored.record;
      if (record.status !== "prepared") return record;
      // Validate both recovery versions before any file side effect.
      const desired = this.snapshots.read(record.after);
      if (record.before) this.snapshots.read(record.before);
      this.owner.vault.completePublication(record.path);
      const current = this.owner.vault.readOptional(record.path);
      let next: ApplicationRecord;
      if (matches(current, record.after)) {
        // Crash after publication but before state commit: make the recognized
        // target durable, then complete the local receipt without rewriting it.
        this.owner.vault.sync(record.path);
        next = { ...record, status: "applied" };
      } else if (matches(current, record.before)) {
        if (record.contentKind === "note") {
          await writeNoteContent({
            hasFile: () => record.before !== null,
            hasFolder: path => this.owner.vault.hasDirectory(path),
            createFolder: path => { this.owner.vault.createDirectories(path); return Promise.resolve(); },
            create: path => { this.owner.vault.write(path, desired, "create"); return Promise.resolve(); },
            modify: path => { this.owner.vault.write(path, desired, "replace"); return Promise.resolve(); },
          }, record.path, { content: desired.toString("utf8"), ctime: 0, mtime: 0 });
        } else {
          const parent = record.path.split("/").slice(0, -1).join("/");
          if (parent) this.owner.vault.createDirectories(parent);
          this.owner.vault.write(record.path, desired, record.before === null ? "create" : "replace");
        }
        if (!matches(this.owner.vault.readOptional(record.path), record.after)) throw new ApplicationError("application-version-mismatch");
        next = { ...record, status: "applied" };
      } else {
        // Keep the external edit and all three snapshots; never replay the old
        // replacement onto an unknown version after a crash or delayed apply.
        const observed = current === null ? null : await this.snapshots.put(current, record.contentKind);
        next = { ...record, observed, status: "diverged" };
      }
      this.state.commit([{ type: "put", record: next, expectedRevision: stored.revision }]);
      return next;
    });
  }
}
