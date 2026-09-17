import { Buffer } from "node:buffer";
import type { OwnedDirectories, EntryInfo } from "./filesystem";
import type { StateStore } from "./state_store";
import type { FileVersion } from "./state_records";
import { validFileVersion } from "./state_records";
import { SnapshotStore, fullDigest } from "./snapshots";
import { validSyncPath, nonnegativeInteger } from "./note_pull";

export interface ScannedFile { path: string; contentKind: "note" | "file"; version: FileVersion; ctime: number; mtime: number }
export interface ScanManifest { formatVersion: 1; files: ScannedFile[]; directories: string[] }
export class ScanError extends Error {
  constructor(public readonly code: "scan-failed" | "scan-changed" | "scan-limit" | "scan-cancelled" | "scan-corrupt" | "invalid-scan-interval") { super(code); this.name = "ScanError"; }
}
const MAX_ENTRIES = 10000, MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Observation only: missing files are not deletion intents or confirmed remote
// versions. The owner's mutex excludes controlled writes for the entire scan.
// Every file is fully read, regardless of mtime, size, weak hash or watcher events.
export class VaultScanner {
  private snapshots: SnapshotStore;
  constructor(private owner: OwnedDirectories, private state: StateStore) { this.snapshots = new SnapshotStore(owner.state); }

  latest(): ScanManifest | null {
    const stored = this.state.get("scan", "latest");
    if (!stored || stored.record.kind !== "scan") return null;
    try {
      const value = JSON.parse(this.snapshots.read(stored.record.manifest).toString("utf8")) as ScanManifest;
      if (!value || value.formatVersion !== 1 || !Array.isArray(value.files) || !Array.isArray(value.directories) ||
        Object.keys(value).sort().join() !== "directories,files,formatVersion" || value.files.length !== stored.record.fileCount || value.directories.length !== stored.record.directoryCount) throw new ScanError("scan-corrupt");
      const names = new Set<string>(); let size = 0;
      for (const entry of value.files) {
        if (!entry || Object.keys(entry).sort().join() !== "contentKind,ctime,mtime,path,version" || !validSyncPath(entry.path) ||
            entry.contentKind !== (entry.path.endsWith(".md") ? "note" : "file") || !entry.version || !validFileVersion(entry.version) ||
            !nonnegativeInteger(entry.ctime) || !nonnegativeInteger(entry.mtime) || names.has(entry.path)) throw new ScanError("scan-corrupt");
        names.add(entry.path); size += entry.version.size;
      }
      for (const path of value.directories) {
        if (!validSyncPath(path) || names.has(path)) throw new ScanError("scan-corrupt");
        names.add(path);
      }
      if (size !== stored.record.byteCount || names.size > MAX_ENTRIES) throw new ScanError("scan-corrupt");
      return value;
    } catch { throw new ScanError("scan-corrupt"); }
  }

  private tree(signal?: AbortSignal): Map<string, EntryInfo> {
    const entries = new Map<string, EntryInfo>();
    const pending: Array<string | undefined> = [undefined];
    while (pending.length) {
      if (signal?.aborted) throw new ScanError("scan-cancelled");
      const parent = pending.pop();
      for (const name of this.owner.vault.list(parent).sort()) {
        const path = parent ? `${parent}/${name}` : name;
        // Exclude configuration and Git metadata; reject any other invalid path.
        if ([".git", ".obsidian"].includes(name.toLowerCase())) continue;
        if (!validSyncPath(path)) throw new ScanError("scan-failed");
        const entry = this.owner.vault.inspect(path);
        entries.set(path, entry);
        if (entries.size > MAX_ENTRIES) throw new ScanError("scan-limit");
        if (entry.type === "directory") pending.push(path);
      }
    }
    return new Map([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }

  async scan(signal?: AbortSignal): Promise<ScanManifest> {
    try {
      return await this.owner.exclusive(async () => {
        if (signal?.aborted) throw new ScanError("scan-cancelled");
        this.latest(); // A corrupt previous observation must not be hidden.
        const previous = this.state.get("scan", "latest");
        const tree = this.tree(signal);
        const manifest: ScanManifest = { formatVersion: 1, files: [], directories: [] };
        let total = 0;
        for (const [path, entry] of tree) {
          if (signal?.aborted) throw new ScanError("scan-cancelled");
          if (entry.type === "directory") { manifest.directories.push(path); continue; }
          const contentKind = path.endsWith(".md") ? "note" : "file", max = (contentKind === "note" ? 20 : 32) * 1024 * 1024;
          if (entry.size > max || (total += entry.size) > MAX_TOTAL_BYTES) throw new ScanError("scan-limit");
          const bytes = this.owner.vault.read(path, max);
          const version = await this.snapshots.put(bytes, contentKind);
          if (!same(entry, this.owner.vault.inspect(path))) throw new ScanError("scan-changed");
          manifest.files.push({ path, contentKind, version, ctime: entry.ctime, mtime: entry.mtime });
        }
        // A final full pass catches edits to earlier files while hashing later
        // ones yields. External direct writers remain outside the host contract.
        for (const file of manifest.files) {
          if (signal?.aborted) throw new ScanError("scan-cancelled");
          if (fullDigest(this.owner.vault.read(file.path)) !== file.version.sha256) throw new ScanError("scan-changed");
        }
        if (!same([...tree], [...this.tree(signal)])) throw new ScanError("scan-changed");
        const snapshot = await this.snapshots.put(Buffer.from(JSON.stringify(manifest)), "note");
        if (signal?.aborted) throw new ScanError("scan-cancelled");
        // Snapshot hashing can yield, so recheck the tree before committing.
        if (!same([...tree], [...this.tree(signal)])) throw new ScanError("scan-changed");
        if (previous?.record.kind !== "scan" || previous.record.manifest.sha256 !== snapshot.sha256) {
          this.state.commit([{ type: "put", expectedRevision: previous?.revision ?? null,
            record: { formatVersion: 1, kind: "scan", id: "latest", manifest: snapshot, fileCount: manifest.files.length, directoryCount: manifest.directories.length, byteCount: total } }]);
        }
        return manifest;
      });
    } catch (error) { throw error instanceof ScanError ? error : new ScanError("scan-failed"); }
  }

  // Startup scan and periodic reconciliation are authoritative; filesystem
  // notifications may later accelerate this loop but cannot replace it.
  watch(intervalMs: number, onScan: (manifest: ScanManifest) => Promise<void>, onError: (error: ScanError) => void): { close(): Promise<void> } {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 3600000) throw new ScanError("invalid-scan-interval");
    const controller = new AbortController();
    let wake: (() => void) | undefined;
    const running = (async () => {
      while (!controller.signal.aborted) {
        try { const manifest = await this.scan(controller.signal); if (!controller.signal.aborted) await onScan(manifest); }
        catch (error) {
          if (!controller.signal.aborted) {
            try { onError(error instanceof ScanError ? error : new ScanError("scan-failed")); }
            catch { throw new ScanError("scan-failed"); }
          }
        }
        if (controller.signal.aborted) break;
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, intervalMs);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    })();
    void running.catch(() => {});
    return { close: async () => { controller.abort(); wake?.(); await running; } };
  }
}
