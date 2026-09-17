import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { hashContentAsync, hashArrayBuffer } from "../lib/utils/protocol_hash";
import { FilesystemError } from "./filesystem";
import type { SafeDirectory } from "./filesystem";
import { validFileVersion } from "./state_records";
import type { FileVersion } from "./state_records";
import { DEFAULT_SNAPSHOT_BYTES, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_FILES } from "./limits";

export const fullDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export type ContentKind = "note" | "file";
interface Budget { bytes: number; files: number; identity: string; limit: number; maxFiles: number }
const budgets = new WeakMap<SafeDirectory, Budget>();
const policies = new WeakMap<SafeDirectory, { limit: number; maxFiles: number }>();

export class SnapshotError extends Error {
  constructor(public readonly code: "snapshot-invalid" | "snapshot-corrupt" | "snapshot-missing" | "snapshot-limit") {
    super(code);
    this.name = "SnapshotError";
  }
}

export class SnapshotStore {
  constructor(private directory: SafeDirectory) {}

  static configure(directory: SafeDirectory, limit = DEFAULT_SNAPSHOT_BYTES, maxFiles = MAX_SNAPSHOT_FILES): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_BYTES || !Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_SNAPSHOT_FILES) throw new SnapshotError("snapshot-limit");
    policies.set(directory, { limit, maxFiles });
    const budget = budgets.get(directory);
    if (budget) { budget.limit = limit; budget.maxFiles = maxFiles; }
  }

  private budget(): Budget {
    let budget = budgets.get(this.directory);
    if (!budget) {
      budget = { ...this.directory.storageUsage("snapshots"), ...(policies.get(this.directory) ?? { limit: DEFAULT_SNAPSHOT_BYTES, maxFiles: MAX_SNAPSHOT_FILES }) };
      budgets.set(this.directory, budget);
    }
    if (this.directory.inspect("snapshots").identity !== budget.identity) throw new SnapshotError("snapshot-corrupt");
    return budget;
  }

  async put(input: Uint8Array, kind: ContentKind): Promise<FileVersion> {
    if (input.byteLength > 128 * 1024 * 1024) throw new SnapshotError("snapshot-limit");
    if (kind !== "note" && kind !== "file") throw new SnapshotError("snapshot-invalid");
    // Take ownership before hashing can yield; a caller editing its input must
    // not create a mixed snapshot or mismatching digest/protocol metadata.
    const bytes = Uint8Array.from(input);
    const sha256 = fullDigest(bytes);
    let protocolHash: string;
    if (kind === "note") {
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw new SnapshotError("snapshot-invalid"); }
      protocolHash = await hashContentAsync(content);
    } else {
      protocolHash = await hashArrayBuffer(bytes.buffer);
    }
    const version = { sha256, size: bytes.byteLength, protocolHash, snapshotId: sha256 };
    try { this.directory.createDirectory("snapshots"); }
    catch (error) {
      if (!(error instanceof FilesystemError) || error.code !== "already-exists") throw error;
      // Accounting opens the directory without following links.
    }
    const relative = `snapshots/${sha256}`;
    const budget = this.budget();
    try {
      this.read(version); this.directory.sync(relative);
      return version;
    } catch (error) { if (!(error instanceof SnapshotError) || error.code !== "snapshot-missing") throw error; }
    if (budget.bytes + bytes.byteLength > budget.limit || budget.files >= budget.maxFiles) throw new SnapshotError("snapshot-limit");
    try { this.directory.write(relative, bytes, "create"); budget.bytes += bytes.byteLength; budget.files++; }
    catch (error) {
      // Publication or fsync may have allocated bytes before failing. The next
      // attempt must account for those bytes, including crash staging names.
      budgets.delete(this.directory);
      if (!(error instanceof FilesystemError) || error.code !== "already-exists") throw error;
      // An existing identifier is reusable only after full content validation.
      this.read(version);
      this.directory.sync(relative);
    }
    return version;
  }

  read(version: FileVersion): Buffer {
    if (!version || !validFileVersion(version)) throw new SnapshotError("snapshot-invalid");
    let bytes: Buffer;
    try {
      this.directory.completePublication(`snapshots/${version.snapshotId}`);
      bytes = this.directory.read(`snapshots/${version.snapshotId}`);
    }
    catch (error) {
      if (error instanceof FilesystemError && error.code === "not-found") throw new SnapshotError("snapshot-missing");
      throw error;
    }
    if (bytes.byteLength !== version.size || fullDigest(bytes) !== version.sha256) throw new SnapshotError("snapshot-corrupt");
    return bytes;
  }
}
