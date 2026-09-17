import { DatabaseSync } from "node:sqlite";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { validIdentifier, validRecordKind, validStateRecord } from "./state_records";
import type { RecordKind, StateRecord } from "./state_records";

const FORMAT_VERSION = 1;
const APPLICATION_ID = 0x464e5348;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_RECORDS = 50000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_MUTATIONS = 1000;
const checksum = (payload: string) => createHash("sha256").update(payload).digest("hex");

export class StateError extends Error {
  constructor(public readonly code: "state-exists" | "state-missing" | "state-corrupt" | "state-format-unsupported" | "state-write-failed" | "state-read-failed" | "state-closed" | "state-invalid-record" | "state-revision-conflict" | "state-limit") {
    super(code);
    this.name = "StateError";
  }
}

export interface StoredRecord {
  record: StateRecord;
  revision: number;
}

export type StateMutation =
  | { type: "put"; record: StateRecord; expectedRevision: number | null }
  | { type: "delete"; kind: RecordKind; id: string; expectedRevision: number };

type Row = Record<string, unknown>;

function decode(row: Row): StoredRecord {
  if (row.format_version !== FORMAT_VERSION) throw new StateError("state-format-unsupported");
  if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > MAX_RECORD_BYTES ||
      typeof row.digest !== "string" || checksum(row.payload) !== row.digest ||
      !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) throw new StateError("state-corrupt");
  let record: unknown;
  try { record = JSON.parse(row.payload); } catch { throw new StateError("state-corrupt"); }
  if (!validStateRecord(record) || record.kind !== row.kind || record.id !== row.id) throw new StateError("state-corrupt");
  return { record, revision: row.revision as number };
}

// The runtime must acquire Vault AND external-state ownership before opening
// this component. SQLite transactions do not replace the Vault writer lock.
// Store creation is explicit; an empty/corrupt existing file is never reset.
export class StateStore {
  private database: DatabaseSync;
  private closed = false;

  constructor(file: string, options: { create?: boolean } = {}) {
    let database: DatabaseSync | undefined;
    try {
      if (!isAbsolute(file)) throw new StateError("state-read-failed");
      if (options.create) {
        let fd: number;
        try { fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
        catch (error) {
          if ((error as { code?: string }).code === "EEXIST") throw new StateError("state-exists");
          throw new StateError("state-write-failed");
        }
        closeSync(fd);
      } else {
        try {
          const stat = lstatSync(file);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0) throw new StateError("state-corrupt");
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") throw new StateError("state-missing");
          throw error;
        }
      }
      database = new DatabaseSync(file, { timeout: 1000, allowExtension: false, defensive: true });
      this.database = database;
      if (options.create) {
        database.exec(`
          PRAGMA journal_mode = DELETE;
          PRAGMA synchronous = FULL;
          BEGIN IMMEDIATE;
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = ${FORMAT_VERSION};
          CREATE TABLE records (
            kind TEXT NOT NULL, id TEXT NOT NULL,
            format_version INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
            payload TEXT NOT NULL, digest TEXT NOT NULL,
            PRIMARY KEY (kind, id)
          ) STRICT;
          COMMIT;
        `);
        // Persist the directory entry as well as SQLite's committed content.
        const directory = openSync(dirname(file), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      const version = database.prepare("PRAGMA user_version").get()?.user_version;
      const application = database.prepare("PRAGMA application_id").get()?.application_id;
      if (version !== FORMAT_VERSION || application !== APPLICATION_ID) throw new StateError("state-format-unsupported");
      const integrity = database.prepare("PRAGMA quick_check").all();
      if (integrity.length !== 1 || integrity[0].quick_check !== "ok") throw new StateError("state-corrupt");
      this.checkLimits();
      for (const row of database.prepare("SELECT * FROM records").iterate()) decode(row);
      // Keep the small metadata DB in rollback-journal mode. Snapshot bytes
      // live outside SQLite, avoiding unbounded WAL/checkpoint growth.
      const mode = database.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode;
      if (mode !== "delete") throw new StateError("state-write-failed");
      database.exec("PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;");
    } catch (error) {
      try { database?.close(); } catch { /* Preserve the original failure. */ }
      if (error instanceof StateError) throw error;
      throw new StateError(options.create ? "state-write-failed" : "state-corrupt");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new StateError("state-closed");
  }

  private checkLimits(): void {
    const size = this.database.prepare("SELECT count(*) AS count, coalesce(sum(length(CAST(payload AS BLOB))), 0) AS bytes FROM records").get();
    if (!size || Number(size.count) > MAX_RECORDS || Number(size.bytes) > MAX_TOTAL_BYTES) throw new StateError("state-limit");
  }

  get(kind: RecordKind, id: string): StoredRecord | null {
    this.assertOpen();
    if (!validRecordKind(kind) || !validIdentifier(id)) throw new StateError("state-invalid-record");
    try {
      const row = this.database.prepare("SELECT * FROM records WHERE kind = ? AND id = ?").get(kind, id);
      return row ? decode(row) : null;
    } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError("state-read-failed");
    }
  }

  list(kind: RecordKind, options: { afterId?: string; limit?: number } = {}): StoredRecord[] {
    this.assertOpen();
    const limit = options.limit ?? 100;
    if (!validRecordKind(kind) || !Number.isInteger(limit) || limit < 1 || limit > 1000 ||
        (options.afterId !== undefined && !validIdentifier(options.afterId))) throw new StateError("state-invalid-record");
    try {
      return this.database.prepare("SELECT * FROM records WHERE kind = ? AND id > ? ORDER BY id LIMIT ?")
        .all(kind, options.afterId ?? "", limit).map(decode);
    } catch (error) {
      if (error instanceof StateError) throw error;
      throw new StateError("state-read-failed");
    }
  }

  // One bounded synchronous transaction; no asynchronous callback can escape
  // its lifetime. Side effects must happen only after this returns successfully.
  commit(mutations: StateMutation[]): void {
    this.assertOpen();
    if (mutations.length < 1 || mutations.length > MAX_MUTATIONS) throw new StateError("state-limit");
    const seen = new Set<string>();
    const prepared = mutations.map(mutation => {
      if (!mutation || !["put", "delete"].includes(mutation.type)) throw new StateError("state-invalid-record");
      const kind = mutation.type === "put" ? mutation.record?.kind : mutation.kind;
      const id = mutation.type === "put" ? mutation.record?.id : mutation.id;
      if (!validRecordKind(kind) || !validIdentifier(id) ||
          (mutation.expectedRevision !== null && (!Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 1 || mutation.expectedRevision >= Number.MAX_SAFE_INTEGER)) ||
          (mutation.type === "delete" && mutation.expectedRevision === null)) throw new StateError("state-invalid-record");
      const key = `${kind}/${id}`;
      if (seen.has(key)) throw new StateError("state-invalid-record");
      seen.add(key);
      let payload: string | null = null;
      if (mutation.type === "put") {
        if (!validStateRecord(mutation.record)) throw new StateError("state-invalid-record");
        payload = JSON.stringify(mutation.record);
        if (Buffer.byteLength(payload) > MAX_RECORD_BYTES) throw new StateError("state-limit");
      }
      return { kind, id, payload, expectedRevision: mutation.expectedRevision };
    });
    try {
      this.database.exec("BEGIN IMMEDIATE");
      for (const item of prepared) {
        const current = this.database.prepare("SELECT * FROM records WHERE kind = ? AND id = ?").get(item.kind, item.id);
        const revision = current ? decode(current).revision : null;
        if (revision !== item.expectedRevision) throw new StateError("state-revision-conflict");
        if (item.payload === null) {
          this.database.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(item.kind, item.id);
        } else {
          this.database.prepare(`INSERT INTO records (kind, id, format_version, revision, payload, digest) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (kind, id) DO UPDATE SET format_version = excluded.format_version, revision = excluded.revision, payload = excluded.payload, digest = excluded.digest`)
            .run(item.kind, item.id, FORMAT_VERSION, (revision ?? 0) + 1, item.payload, checksum(item.payload));
        }
      }
      this.checkLimits();
      this.database.exec("COMMIT");
    } catch (error) {
      try { if (this.database.isTransaction) this.database.exec("ROLLBACK"); }
      catch { this.close(); }
      if (error instanceof StateError) throw error;
      throw new StateError("state-write-failed");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.database.close(); } catch { throw new StateError("state-write-failed"); }
  }
}
