import { Buffer } from "node:buffer";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore } from "./state_store";
import type { FileVersion } from "./state_records";
import { IdentityBinding, canonicalEndpoint } from "./identity";
import type { RemoteIdentity } from "./identity";
import { SnapshotStore } from "./snapshots";
import { pullCollection } from "./pull_collection";
import type { PullConnectionOptions } from "./pull_collection";
import { NotePull } from "./note_pull";
import { FilePull } from "./file_pull";
import { uploadOperation } from "./upload";
import { contentListRoute } from "../lib/sync/content_routes";
import { validSyncPath } from "./sync_validation";
import { MAX_VAULT_BYTES } from "./limits";

export interface RemoteInventory {
  files: Map<string, FileVersion>;
  deleted: Set<string>;
  noteTime: number;
  fileTime: number;
}
export interface SyncPeer {
  authenticate(signal?: AbortSignal): Promise<void>;
  inventory(signal?: AbortSignal): Promise<RemoteInventory>;
  read(path: string, signal?: AbortSignal): Promise<FileVersion | null>;
  upload(id: string, signal?: AbortSignal): Promise<void>;
}
export class RemoteError extends Error {
  constructor(public readonly code: "remote-read-failed" | "remote-limit" | "remote-changed" | "state-identity-unverified" | "cancelled") { super(code); this.name = "RemoteError"; }
}
const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === "object" && !Array.isArray(input);

// Credentials remain in memory. No production writes or state restoration may
// precede authenticated identity verification. Missing upstream IDs stay null.
export class UpstreamRemote implements SyncPeer {
  private snapshots: SnapshotStore;
  private options: PullConnectionOptions;
  constructor(private owner: OwnedDirectories, private state: StateStore, private identity: IdentityBinding, options: PullConnectionOptions) {
    this.options = { ...options, endpoint: canonicalEndpoint(options.endpoint) };
    identity.assertConnection(options.endpoint, options.vault);
    this.snapshots = new SnapshotStore(owner.state);
  }

  private async metadata(route: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const timeout = AbortSignal.timeout(15000);
      // Node host boundary; Obsidian's requestUrl is unavailable here.
      const response = await fetch(this.options.endpoint + route, { headers: { "x-client": "ObsidianPlugin", Authorization: `Bearer ${this.options.token}` },
        redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok || !response.body) throw new RemoteError("remote-read-failed");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        if ((size += part.value.byteLength) > 2 * 1024 * 1024) { await reader.cancel(); throw new RemoteError("remote-limit"); }
        chunks.push(part.value);
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!object(result) || typeof result.code !== "number" || result.code < 1 || result.code >= 300) throw new RemoteError("remote-read-failed");
      return result.data;
    } catch (error) {
      if (signal?.aborted) throw new RemoteError("cancelled");
      throw error instanceof RemoteError ? error : new RemoteError("remote-read-failed");
    }
  }

  async remoteIdentity(signal?: AbortSignal): Promise<RemoteIdentity> {
    const subject = await this.metadata("/api/user/info", signal);
    if (!object(subject) || !Number.isSafeInteger(subject.uid) || (subject.uid as number) <= 0) throw new RemoteError("state-identity-unverified");
    // Verify access to the configured name, without requiring privileged Vault
    // enumeration or inventing an independent service/Vault identifier.
    for (const collection of ["notes", "files"] as const) await this.metadata(contentListRoute(collection, this.options.vault, 1, 1), signal);
    return { subjectId: String(subject.uid), serviceId: null, vaultId: null, vaultName: this.options.vault };
  }
  async authenticate(signal?: AbortSignal): Promise<void> {
    this.identity.invalidate();
    const evidence = await this.remoteIdentity(signal);
    await this.owner.exclusive(async () => this.identity.verify(evidence));
  }

  private async collection(collection: "notes" | "files", signal?: AbortSignal, maxBytes = MAX_VAULT_BYTES): Promise<{ files: Map<string, FileVersion>; deleted: Set<string>; lastTime: number; bytes: number }> {
    this.identity.assertVerified();
    const files = new Map<string, FileVersion>(), deleted = new Set<string>();
    let bytes = 0;
    const account = (size: number) => { if ((bytes += size) > maxBytes) throw new RemoteError("remote-limit"); };
    const options = { ...this.options, signal, onAbsent: (path: string) => { deleted.add(path); return Promise.resolve(true); } };
    const receipt = await pullCollection(options, collection, common => collection === "notes"
      ? new NotePull({ ...common, onNote: async note => {
        this.identity.assertVerified(); const content = Buffer.from(note.content); account(content.length);
        files.set(note.path, await this.snapshots.put(content, "note")); return "unchanged";
      } })
      : new FilePull({ ...common, directory: this.owner.state, onFile: async (file, bytes) => {
        this.identity.assertVerified(); account(bytes.length); files.set(file.path, await this.snapshots.put(bytes, "file")); return "unchanged";
      } }));
    this.identity.assertVerified();
    return { files, deleted, lastTime: receipt.lastTime, bytes };
  }

  private async recycled(collection: "notes" | "files", signal?: AbortSignal): Promise<Set<string>> {
    const paths = new Set<string>(); let expected: number | undefined;
    for (let page = 1; page <= 100; page++) {
      const data = await this.metadata(contentListRoute(collection, this.options.vault, page, 100, true), signal);
      if (!object(data) || !object(data.pager) || !Number.isSafeInteger(data.pager.totalRows) ||
          (data.pager.totalRows as number) < 0 || (data.pager.totalRows as number) > 10000) throw new RemoteError("remote-limit");
      const total = data.pager.totalRows as number;
      // Official Go service represents an empty list as JSON null.
      const list = data.list === null && total === 0 ? [] : data.list;
      if (!Array.isArray(list)) throw new RemoteError("remote-read-failed");
      if (expected !== undefined && expected !== total) throw new RemoteError("remote-changed");
      expected = total;
      for (const item of list) {
        if (!object(item) || !validSyncPath(item.path) || paths.has(item.path)) throw new RemoteError("remote-changed");
        paths.add(item.path);
      }
      if (paths.size === total) return paths;
      if (paths.size > total || list.length === 0) throw new RemoteError("remote-changed");
    }
    throw new RemoteError("remote-limit");
  }

  async inventory(signal?: AbortSignal): Promise<RemoteInventory> {
    await this.authenticate(signal);
    const notes = await this.collection("notes", signal), files = await this.collection("files", signal, MAX_VAULT_BYTES - notes.bytes);
    const entries = new Set<string>();
    for (const path of [...notes.files.keys(), ...files.files.keys()]) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        entries.add(parts.slice(0, i).join("/"));
        if (entries.size > 10000) throw new RemoteError("remote-limit");
      }
    }
    // Missing from a complete inventory is not alone a remote deletion intent.
    // Recycle entries are the existing official history evidence; expired
    // history remains explicitly unverified in reconciliation.
    const deleted = new Set([...notes.deleted, ...files.deleted, ...await this.recycled("notes", signal), ...await this.recycled("files", signal)]);
    return { files: new Map([...notes.files, ...files.files]), deleted, noteTime: notes.lastTime, fileTime: files.lastTime };
  }
  async read(path: string, signal?: AbortSignal): Promise<FileVersion | null> {
    if (!validSyncPath(path)) throw new RemoteError("remote-read-failed");
    // Conservative complete readback reuses the official WS download path.
    // It is bounded but intentionally makes no incremental-performance claim.
    const result = await this.collection(path.endsWith(".md") ? "notes" : "files", signal);
    return result.files.get(path) ?? null;
  }
  async upload(id: string, signal?: AbortSignal): Promise<void> {
    await uploadOperation(this.owner, this.state, this.identity, id, { ...this.options, signal,
      verifyIdentity: current => this.remoteIdentity(current), readBack: (path, current) => this.read(path, current) });
  }
}
