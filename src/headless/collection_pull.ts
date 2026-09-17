import { validSyncPath } from "./sync_validation";
import { hashContent } from "../lib/utils/protocol_hash";
import { Buffer } from "node:buffer";
import type { BatchSyncHost } from "../lib/sync/batch_sync";
import { sendNoteInventory } from "../lib/sync/note_protocol";
import { sendFileInventory } from "../lib/sync/file_protocol";
import { folderItem, sendFolderInventory } from "../lib/sync/folder_protocol";
import { sendPageAcknowledgement, syncPayload } from "../lib/sync/sync_protocol";
import { validIdentifier } from "./state_records";
import { MAX_VAULT_BYTES } from "./limits";

interface Page { total: number; last: boolean; items: Map<string, string>; completed: boolean }
type Sender = BatchSyncHost["websocket"] & { Send(action: string, data: unknown): void };
export type PullCollection = "notes" | "files" | "folders";
const actionPrefix = (collection: PullCollection) => collection === "notes" ? "NoteSync" : collection === "files" ? "FileSync" : "FolderSync";
const kindOf = (collection: PullCollection) => collection === "notes" ? "note" : collection === "files" ? "file" : "folder";
export class PullError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "PullError"; }
}
export interface PullReceipt<C extends PullCollection> { scope: C; received: number; pages: number; lastTime: number; remoteWrites: false; absentRemotely?: number }
export interface PullOptions {
  socket: Sender; vault: string; context: string; syncUpChunkNum: number; pipelineWindowUp: number; pipelineWindowDown: number;
  onAbsent?(path: string): Promise<boolean>;
  onRename?(oldPath: string, path: string): Promise<"applied" | "unchanged">;
  onPage?(index: number): Promise<void>;
  onEnd?(lastTime: number, count: number): Promise<void>;
  startFolders?: { folders: string[]; delFolders: string[] };
}
interface PreparedItem { path: string; digest: string; byteLength: number; apply: () => Promise<"applied" | "unchanged" | "conflict"> }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// Conservative completion policy around the upstream inventory/page protocol.
// This component owns no files or credentials. Callbacks must finish durable
// application before resolving; a completed transfer is not a full Vault sync.
export class CollectionPull<C extends PullCollection> {
  readonly done: Promise<PullReceipt<C>>;
  private resolve!: (receipt: PullReceipt<C>) => void;
  private reject!: (error: PullError) => void;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private started = false;
  private pages = new Map<number, Page>();
  private paths = new Map<string, string>();
  private target: { count: number; time: number } | null = null;
  private queued = 0;
  private queuedBytes = 0;
  private watermark = -1;
  private lastPage: number | null = null;
  private received = 0;
  private receivedBytes = 0;
  private absentRemotely = 0;

  constructor(private collection: C, private options: PullOptions & {
    prepareItem(data: Record<string, unknown>, pageIndex: number): Promise<PreparedItem>;
  }) {
    if (!options.vault || options.vault.length > 256 || !validIdentifier(options.context)) throw this.error("invalid-message");
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.done.catch(() => {});
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) throw this.error("pull-failed");
    this.started = true;
    try {
      // Empty inventory and no deletion list request complete remote contents
      // without publishing local files or deriving deletion from their absence.
      const host = { websocket: this.options.socket, syncState: this.options };
      const data = { context: this.options.context, lastTime: 0 };
      if (this.collection === "notes") await sendNoteInventory(host, this.options.vault, false, { ...data, notes: [], delNotes: [], missingNotes: [] });
      else if (this.collection === "files") await sendFileInventory(host, this.options.vault, false, { ...data, files: [], delFiles: [], missingFiles: [] });
      else {
        // The folder inventory carries this host's own folders and its
        // evidence-backed deletions in the same official message the plugin
        // sends; a missing caller payload stays an empty read-only request.
        const start = this.options.startFolders ?? { folders: [], delFolders: [] };
        await sendFolderInventory(host, this.options.vault, true, { ...data,
          folders: start.folders.map(folderItem), delFolders: start.delFolders.map(folderItem), missingFolders: [] });
      }
    } catch { this.fail(this.error("pull-failed")); }
  }

  accept(action: string, input: unknown): void {
    if (this.stopped || !this.started) return;
    if (!object(input)) { this.fail(this.error("invalid-message")); return; }
    if (input.vault && input.vault !== this.options.vault) return;
    if (input.context && input.context !== this.options.context) return;
    if (!integer(input.code) || input.code <= 0 || input.code >= 300) { this.fail(this.error("pull-failed")); return; }
    if (input.context !== this.options.context) return;
    const prefix = actionPrefix(this.collection);
    if (!action.startsWith(prefix)) return;
    action = action.slice(prefix.length);
    // Account for queued text before starting any asynchronous hash or write.
    if (input.pageIndex !== undefined && !integer(input.pageIndex)) { this.fail(this.error("invalid-message")); return; }
    const data = syncPayload(input);
    const size = object(data) && typeof data.content === "string" ? Buffer.byteLength(data.content) : 0;
    if (++this.queued > 10000 || (this.queuedBytes += size) > 64 * 1024 * 1024) { this.fail(this.error("pull-limit")); return; }
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      if (!object(data)) throw this.error("invalid-message");
      await this.handle(action, data);
    }).catch(error => {
      const code = (error as { code?: string }).code;
      this.fail(error instanceof PullError ? error : code && ["snapshot-limit", "remote-limit"].includes(code) ? new PullError(code) : this.error("application-failed"));
    })
      .finally(() => { this.queued--; this.queuedBytes -= size; });
  }

  private error(suffix: string): PullError {
    const kind = kindOf(this.collection);
    return new PullError(suffix === "invalid-message" ? `invalid-${kind}-message` : `${kind}-${suffix}`);
  }
  cancel(code?: string): void { this.fail(code ? new PullError(code) : this.error("pull-cancelled")); }
  async drain(): Promise<void> { await this.queue; }
  private fail(error: PullError): void { if (!this.stopped) { this.stopped = true; this.reject(error); } }

  private async handle(action: string, data: Record<string, unknown>): Promise<void> {
    if (action === "BatchAck") return;
    if (action === "NeedPush") throw new PullError("readonly-write-required");
    if ((action === "Delete" && !this.options.onAbsent) || (action === "Rename" && !this.options.onRename)) throw new PullError("deletion-revalidation-required");
    if (action === "End") {
      const counts = ["needUploadCount", "needModifyCount", "needSyncMtimeCount", "needDeleteCount"].map(key => data[key] ?? 0);
      if (!counts.every(integer) || !integer(data.lastTime)) throw this.error("invalid-message");
      // Folders are declared by this host in the same message that requests the
      // server inventory, so a folder pull never needs an extra upload round.
      if (counts[0] !== 0 && this.collection !== "folders") throw new PullError("readonly-write-required");
      if (counts[2] !== 0 || (counts[3] !== 0 && !this.options.onAbsent)) throw new PullError("deletion-revalidation-required");
      const count = counts[1] + counts[3];
      if (count > 10000) throw this.error("pull-limit");
      if (this.target && (this.target.count !== count || this.target.time !== data.lastTime)) throw this.error("invalid-message");
      if (!this.target) {
        this.target = { count, time: data.lastTime };
        await this.options.onEnd?.(data.lastTime, count);
        if (this.stopped) return;
        if (count > 0) sendPageAcknowledgement(this.options.socket, kindOf(this.collection), this.options.vault, this.options.context, -1);
      }
    } else if (action === "Page") {
      if (!integer(data.pageIndex) || data.pageIndex >= 10000 || !integer(data.totalCount) || data.totalCount > 10000 || typeof data.isLast !== "boolean") throw this.error("invalid-message");
      const old = this.pages.get(data.pageIndex);
      if (old && (old.total !== data.totalCount || old.last !== data.isLast)) throw this.error("invalid-message");
      if (data.isLast) {
        if (this.lastPage !== null && this.lastPage !== data.pageIndex) throw this.error("invalid-message");
        this.lastPage = data.pageIndex;
      }
      if (!old) this.pages.set(data.pageIndex, { total: data.totalCount, last: data.isLast, items: new Map(), completed: false });
    } else if (action === "Rename") {
      if (!validSyncPath(data.oldPath) || !validSyncPath(data.path) || data.oldPathHash !== hashContent(data.oldPath) ||
          data.pathHash !== hashContent(data.path) || data.oldPath === data.path) throw this.error("invalid-message");
      const oldPath = data.oldPath, path = data.path;
      let index = data.pageIndex;
      if (index === undefined && this.options.pipelineWindowDown === 0) index = this.watermark + 1;
      if (!integer(index) || !this.pages.has(index)) throw this.error("invalid-message");
      const page = this.pages.get(index)!;
      const previous = this.paths.get(path);
      if (page.items.has(path)) { if (page.items.get(path) !== `rename:${oldPath}`) throw this.error("invalid-message"); return; }
      if (previous !== undefined || page.items.size >= page.total || this.received >= 10000) throw this.error("invalid-message");
      const result = await this.options.onRename!(oldPath, path);
      if (result !== "applied" && result !== "unchanged") throw this.error("application-failed");
      page.items.set(path, `rename:${oldPath}`); this.paths.set(path, `rename:${oldPath}`); this.received++;
    } else if (action === "Delete" || action === (this.collection === "files" ? "Update" : "Modify")) {
      let index = data.pageIndex;
      if (index === undefined && this.options.pipelineWindowDown === 0) index = this.watermark + 1;
      if (!integer(index) || !this.pages.has(index)) throw this.error("invalid-message");
      const absent = action === "Delete";
      let item: PreparedItem;
      if (absent) {
        if (!validSyncPath(data.path) || data.pathHash !== hashContent(data.path) || !integer(data.lastTime) || !this.options.onAbsent) throw this.error("invalid-message");
        const path = data.path;
        item = { path, digest: `absent:${data.lastTime}`, byteLength: 0, apply: async () => {
          if (!await this.options.onAbsent!(path)) throw new PullError("deletion-revalidation-required");
          return "unchanged";
        } };
      } else item = await this.options.prepareItem(data, index);
      const { path, digest, byteLength, apply } = item;
      const page = this.pages.get(index)!;
      const previous = this.paths.get(path);
      if (page.items.has(path)) {
        if (page.items.get(path) !== digest) throw this.error("invalid-message");
        return;
      }
      if (previous !== undefined || page.items.size >= page.total || this.received >= 10000) throw this.error("invalid-message");
      if (this.stopped) return;
      if (!integer(byteLength) || (this.receivedBytes += byteLength) > MAX_VAULT_BYTES) throw this.error("pull-limit");
      const result = await apply();
      if (result === "conflict") throw this.error("conflict");
      if (result !== "applied" && result !== "unchanged") throw this.error("application-failed");
      page.items.set(path, digest); this.paths.set(path, digest); this.received++;
      if (absent) this.absentRemotely++;
    } else throw this.error("invalid-message");
    if (this.stopped) return;
    for (;;) {
      const index = this.watermark + 1, page = this.pages.get(index);
      if (!page || page.items.size !== page.total) break;
      await this.options.onPage?.(index);
      if (this.stopped) return;
      page.completed = true; this.watermark = index;
      if (!page.last) sendPageAcknowledgement(this.options.socket, kindOf(this.collection), this.options.vault, this.options.context, index);
    }
    if (!this.target) return;
    if (this.received > this.target.count) throw this.error("invalid-message");
    const allPages = this.target.count === 0 ? this.pages.size === 0 : this.lastPage !== null && this.watermark === this.lastPage && this.pages.size === this.lastPage + 1;
    if (allPages && this.received === this.target.count) {
      this.stopped = true;
      this.resolve({ scope: this.collection, received: this.received - this.absentRemotely, ...(this.absentRemotely ? { absentRemotely: this.absentRemotely } : {}), pages: this.pages.size, lastTime: this.target.time, remoteWrites: false });
    }
  }
}
