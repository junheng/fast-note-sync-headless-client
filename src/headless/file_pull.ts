import { CollectionPull, PullError } from "./collection_pull";
import type { PullOptions, PullReceipt } from "./collection_pull";
import type { SafeDirectory } from "./filesystem";
import { validSyncPath, nonnegativeInteger } from "./note_pull";
import { hashContent, hashArrayBuffer } from "../lib/utils/protocol_hash";
import { requestFileDownload, decodeFileChunk } from "../lib/sync/file_protocol";
import { DownloadChunks, MAX_DOWNLOAD_BYTES, MAX_CHUNK_BYTES } from "./download_chunks";

export interface PulledFile { path: string; pathHash: string; contentHash: string; size: number; ctime: number; mtime: number; lastTime: number; pageIndex: number }
export type FilePullReceipt = PullReceipt<"files">;
interface ActiveDownload {
  file: PulledFile; chunks?: DownloadChunks; finished?: boolean;
  resolve(bytes: Uint8Array<ArrayBuffer>): void; reject(error: PullError): void;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

// One requested attachment at a time. Page callbacks wait for the complete file
// while binary frames are handled on a separate, bounded storage queue.
export class FilePull extends CollectionPull<"files"> {
  private active: ActiveDownload | undefined;
  private binaryQueue: Promise<void> = Promise.resolve();
  private queuedBinaryBytes = 0;
  private queuedFrames = 0;
  private cancelled = false;
  private completed = new Map<string, DownloadChunks>();
  private totalChunks = 0;
  constructor(private fileOptions: PullOptions & { directory: SafeDirectory; onFile(file: PulledFile, bytes: Uint8Array): Promise<"applied" | "unchanged" | "conflict"> }) {
    super("files", { ...fileOptions, prepareItem: async (data, pageIndex) => {
      if (!validSyncPath(data.path) || data.path.endsWith(".md") || data.pathHash !== hashContent(data.path) || typeof data.contentHash !== "string" || !/^-?\d{1,10}$/.test(data.contentHash) ||
          !nonnegativeInteger(data.size) || !nonnegativeInteger(data.ctime) || !nonnegativeInteger(data.mtime) || !nonnegativeInteger(data.lastTime)) throw new PullError("invalid-file-message");
      if (data.size > MAX_DOWNLOAD_BYTES) throw new PullError("file-pull-limit");
      const file: PulledFile = { path: data.path, pathHash: data.pathHash, contentHash: data.contentHash, size: data.size, ctime: data.ctime, mtime: data.mtime, lastTime: data.lastTime, pageIndex };
      return { path: file.path, byteLength: file.size, digest: JSON.stringify(file), apply: async () => {
        const bytes = await this.download(file);
        if (this.cancelled) throw new PullError("file-pull-cancelled");
        return await fileOptions.onFile(file, bytes);
      } };
    } });
  }

  override async start(): Promise<void> {
    DownloadChunks.discardInterrupted(this.fileOptions.directory);
    await super.start();
  }

  private async download(file: PulledFile): Promise<Uint8Array<ArrayBuffer>> {
    if (this.active || this.cancelled) throw new PullError("file-pull-failed");
    const ready = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => { this.active = { file, resolve, reject }; });
    void ready.catch(() => {});
    try {
      await requestFileDownload(this.fileOptions.socket, this.fileOptions.vault, file);
      return await ready;
    } finally {
      this.active = undefined;
    }
  }

  override accept(action: string, input: unknown): void {
    if (this.cancelled) return;
    if (action === "FileUpload") {
      if (object(input) && ((input.vault && input.vault !== this.fileOptions.vault) || (input.context && input.context !== this.fileOptions.context))) return;
      this.cancel("readonly-write-required");
      return;
    }
    if (action !== "FileSyncChunkDownload") { super.accept(action, input); return; }
    // Upstream chunk requests omit context. Correlate using this connection's
    // sole requested path and subsequently the server-issued session ID.
    if (object(input) && input.vault && input.vault !== this.fileOptions.vault) return;
    if (object(input) && input.context && input.context !== this.fileOptions.context) return;
    this.enqueue(0, async () => {
      const active = this.active;
      if (!active || !object(input) || !nonnegativeInteger(input.code) || input.code < 1 || input.code >= 300 || !object(input.data)) throw new PullError("invalid-file-message");
      const data = input.data, file = active.file;
      if (data.path !== file.path || data.size !== file.size || data.contentHash !== file.contentHash || data.ctime !== file.ctime || data.mtime !== file.mtime) throw new PullError("file-version-changed");
      if (active.chunks) throw new PullError("invalid-file-message");
      if (!nonnegativeInteger(data.totalChunks) || (this.totalChunks += data.totalChunks) > 50000) throw new PullError("file-pull-limit");
      active.chunks = new DownloadChunks(this.fileOptions.directory, data.sessionId as string, data.size, data.chunkSize as number, data.totalChunks);
      await this.finish(active);
    });
  }

  acceptBinary(data: ArrayBuffer | Blob): void {
    if (this.cancelled) return;
    const length = data instanceof Blob ? data.size : data.byteLength;
    if (length < 40 || length > MAX_CHUNK_BYTES + 40) { this.cancel("invalid-file-chunk"); return; }
    this.enqueue(length, async () => {
      const frame = decodeFileChunk(data instanceof Blob ? await data.arrayBuffer() : data);
      const completed = this.completed.get(frame.sessionId);
      if (completed) { completed.accept(frame.chunkIndex, frame.chunkData); return; }
      const active = this.active;
      if (!active?.chunks || frame.sessionId !== active.chunks.sessionId) throw new PullError("invalid-file-chunk");
      active.chunks.accept(frame.chunkIndex, frame.chunkData);
      await this.finish(active);
    });
  }

  private enqueue(size: number, work: () => Promise<void>): void {
    if (++this.queuedFrames > 10000 || (this.queuedBinaryBytes += size) > 64 * 1024 * 1024) { this.cancel("file-pull-limit"); return; }
    this.binaryQueue = this.binaryQueue.then(async () => { if (!this.cancelled) await work(); })
      .catch(error => this.cancel(error instanceof PullError ? error.code : "file-download-failed"))
      .finally(() => { this.queuedFrames--; this.queuedBinaryBytes -= size; });
  }

  private async finish(active: ActiveDownload): Promise<void> {
    if (!active.chunks?.complete || active.finished) return;
    active.finished = true;
    const bytes = await active.chunks.assemble();
    if (await hashArrayBuffer(bytes.buffer) !== active.file.contentHash) throw new PullError("file-content-hash-mismatch");
    if (this.cancelled) return;
    active.chunks.clear();
    this.completed.set(active.chunks.sessionId, active.chunks);
    active.resolve(bytes);
  }

  override cancel(code = "file-pull-cancelled"): void {
    this.cancelled = true;
    this.active?.reject(new PullError(code));
    super.cancel(code);
  }
  override async drain(): Promise<void> { await this.binaryQueue; await super.drain(); }
}
