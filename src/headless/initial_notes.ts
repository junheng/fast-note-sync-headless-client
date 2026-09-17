import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore } from "./state_store";
import type { PulledNote } from "./note_pull";
import type { ContentKind } from "./snapshots";
import type { ApplicationRecord } from "./state_records";
import { FileApplication, ApplicationError } from "./file_application";
import { ConflictStore } from "./conflicts";
import { fullDigest } from "./snapshots";

// Initial admission only, for a caller that has already verified its target
// identity. No previous checkpoint or remote write is inferred from local files.
export class InitialContents {
  private application: FileApplication;
  private conflicts: ConflictStore;
  private interrupted = new Map<string, ApplicationRecord[]>();
  constructor(private owner: OwnedDirectories, state: StateStore, writingMode: "controlled" | "exclusive") {
    this.application = new FileApplication(owner, state, writingMode);
    this.conflicts = new ConflictStore(owner, state);
    let afterId: string | undefined;
    for (;;) {
      const records = state.list("application", { afterId, limit: 1000 });
      for (const value of records) {
        const record = value.record;
        if (record.kind === "application" && record.status === "prepared") {
          const existing = this.interrupted.get(record.path) ?? [];
          existing.push(record); this.interrupted.set(record.path, existing);
        }
      }
      if (records.length < 1000) break;
      afterId = records[records.length - 1].record.id;
    }
  }
  async confirmAbsent(path: string): Promise<boolean> {
    return await this.owner.exclusive(async () => this.owner.vault.readOptional(path) === null);
  }
  async acceptBytes(path: string, input: Uint8Array, kind: ContentKind): Promise<"applied" | "unchanged" | "conflict"> {
    const bytes = Uint8Array.from(input);
    const digest = fullDigest(bytes);
    // Reuse an interrupted initial publication only after a fresh remote read
    // has verified the same desired full version. Never replay stale content.
    const pending = this.interrupted.get(path)?.find(record => record.before === null && record.contentKind === kind && record.after.sha256 === digest);
    if (pending) {
      const result = await this.application.apply(pending.id);
      if (result.status === "applied") return "applied";
      await this.conflicts.capture(randomUUID(), path, bytes, kind, { status: "missing" });
      return "conflict";
    }
    const current = await this.owner.exclusive(async () => {
      this.owner.vault.completePublication(path);
      return this.owner.vault.readOptional(path);
    });
    if (current !== null && fullDigest(current) === fullDigest(bytes)) return "unchanged";
    if (current !== null) {
      await this.conflicts.capture(randomUUID(), path, bytes, kind, { status: "missing" });
      return "conflict";
    }
    const id = randomUUID();
    try { await this.application.prepare(id, path, bytes, kind, null); }
    catch (error) {
      if (!(error instanceof ApplicationError) || error.code !== "stale-version") throw error;
      await this.conflicts.capture(randomUUID(), path, bytes, kind, { status: "missing" });
      return "conflict";
    }
    const applied = await this.application.apply(id);
    if (applied.status === "diverged") {
      await this.conflicts.capture(randomUUID(), path, bytes, kind, { status: "missing" });
      return "conflict";
    }
    return "applied";
  }
}

export class InitialNotes extends InitialContents {
  async accept(note: PulledNote): Promise<"applied" | "unchanged" | "conflict"> {
    return await this.acceptBytes(note.path, Buffer.from(note.content), "note");
  }
}
