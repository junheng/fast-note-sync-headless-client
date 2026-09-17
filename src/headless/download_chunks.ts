import { Buffer } from "node:buffer";
import type { SafeDirectory } from "./filesystem";
import { assembleFileChunks } from "../lib/sync/file_protocol";
import { fullDigest } from "./snapshots";
import { PullError } from "./collection_pull";

export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const validSessionId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

// These are disposable transfer bytes, never file applications or checkpoints.
// After a process crash the next full pull discards partial chunks and requests
// a new server session. A server session ID is never reused across connections.
export class DownloadChunks {
  private chunks = new Map<number, string>();
  constructor(private directory: SafeDirectory, readonly sessionId: string, private size: number, private chunkSize: number, private totalChunks: number) {
    if (!validSessionId(sessionId) || !Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD_BYTES ||
      !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_CHUNK_BYTES || !Number.isSafeInteger(totalChunks) || totalChunks < 0 || totalChunks > 10000 || totalChunks !== Math.ceil(size / chunkSize)) throw new PullError("invalid-file-message");
    directory.createDirectories("downloads");
    directory.write(`downloads/${sessionId}.json`, Buffer.from(JSON.stringify({ formatVersion: 1, sessionId, size, chunkSize, totalChunks })), "create");
  }

  static discardInterrupted(directory: SafeDirectory): void {
    if (!directory.hasDirectory("downloads")) return;
    const entries = directory.list("downloads");
    // Fail closed on unexpected files; do not remove unrelated state.
    if (entries.some(name => !/^[0-9a-f-]{36}(?:\.json|-\d+\.chunk)$/.test(name))) throw new PullError("invalid-download-state");
    for (const name of entries) {
      directory.completePublication(`downloads/${name}`);
      directory.remove(`downloads/${name}`);
    }
    directory.discardTemporaryWrites("downloads");
  }

  accept(index: number, input: ArrayBuffer): void {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.totalChunks || input.byteLength !== Math.min(this.chunkSize, this.size - index * this.chunkSize)) throw new PullError("invalid-file-chunk");
    const bytes = new Uint8Array(input), digest = fullDigest(bytes), old = this.chunks.get(index);
    if (old !== undefined) {
      if (old !== digest) throw new PullError("invalid-file-chunk");
      return;
    }
    this.directory.write(`downloads/${this.sessionId}-${index}.chunk`, bytes, "create");
    this.chunks.set(index, digest);
  }

  get complete(): boolean { return this.chunks.size === this.totalChunks; }
  async assemble(): Promise<Uint8Array<ArrayBuffer>> {
    if (!this.complete) throw new PullError("incomplete-file-chunks");
    return await assembleFileChunks(this.size, this.totalChunks, index => {
      const bytes = this.directory.readRange(`downloads/${this.sessionId}-${index}.chunk`, 0, Math.min(this.chunkSize, this.size - index * this.chunkSize), MAX_CHUNK_BYTES);
      if (fullDigest(bytes) !== this.chunks.get(index)) throw new PullError("invalid-file-chunk");
      return Promise.resolve(Uint8Array.from(bytes).buffer);
    });
  }
  clear(): void {
    for (const index of this.chunks.keys()) this.directory.remove(`downloads/${this.sessionId}-${index}.chunk`);
    this.directory.remove(`downloads/${this.sessionId}.json`);
  }
}
