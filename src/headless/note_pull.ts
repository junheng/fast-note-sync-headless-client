import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { hashContent, hashContentAsync } from "../lib/utils/protocol_hash";
import { CollectionPull, PullError } from "./collection_pull";
import type { PullOptions, PullReceipt } from "./collection_pull";
import { validSyncPath, nonnegativeInteger } from "./sync_validation";
export { validSyncPath, nonnegativeInteger } from "./sync_validation";
export { PullError as NotePullError } from "./collection_pull";

export interface PulledNote { path: string; content: string; contentHash: string; ctime: number; mtime: number; lastTime: number; pageIndex: number }
export type NotePullReceipt = PullReceipt<"notes">;

export class NotePull extends CollectionPull<"notes"> {
  constructor(options: PullOptions & { onNote(note: PulledNote): Promise<"applied" | "unchanged" | "conflict"> }) {
    super("notes", { ...options, prepareItem: async (data, pageIndex) => {
      if (!validSyncPath(data.path) || !data.path.endsWith(".md") || typeof data.content !== "string" ||
          typeof data.contentHash !== "string" || data.pathHash !== hashContent(data.path) || !nonnegativeInteger(data.ctime) || !nonnegativeInteger(data.mtime) || !nonnegativeInteger(data.lastTime)) throw new PullError("invalid-note-message");
      if (Buffer.byteLength(data.content) > 20 * 1024 * 1024) throw new PullError("note-pull-limit");
      const bytes = Buffer.from(data.content);
      if (bytes.toString("utf8") !== data.content || await hashContentAsync(data.content) !== data.contentHash) throw new PullError("invalid-note-message");
      const note: PulledNote = { path: data.path, content: data.content, contentHash: data.contentHash, ctime: data.ctime, mtime: data.mtime, lastTime: data.lastTime, pageIndex };
      return { path: data.path, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex"), apply: () => options.onNote(note) };
    } });
  }
}
