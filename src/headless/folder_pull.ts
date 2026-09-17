import { createHash } from "node:crypto";
import { hashContent } from "../lib/utils/protocol_hash";
import { CollectionPull, PullError } from "./collection_pull";
import type { PullOptions, PullReceipt } from "./collection_pull";
import { validSyncPath, nonnegativeInteger } from "./sync_validation";
export { PullError as FolderPullError } from "./collection_pull";

export interface PulledFolder { path: string; lastTime: number; pageIndex: number }
export type FolderPullReceipt = PullReceipt<"folders">;

// Folder inventory only carries paths, so a folder item is applied by creating
// an empty directory. Deletions and renames stay authoritative server
// statements; the host decides whether its local state may follow them.
export class FolderPull extends CollectionPull<"folders"> {
  constructor(options: PullOptions & {
    onFolder(folder: PulledFolder): Promise<"applied" | "unchanged">;
  }) {
    super("folders", { ...options, prepareItem: async (data, pageIndex) => {
      if (!validSyncPath(data.path) || data.pathHash !== hashContent(data.path) || !nonnegativeInteger(data.lastTime)) throw new PullError("invalid-folder-message");
      const folder: PulledFolder = { path: data.path, lastTime: data.lastTime, pageIndex };
      return { path: data.path, byteLength: 0, digest: `folder:${createHash("sha256").update(data.path).digest("hex")}`,
        apply: () => options.onFolder(folder) };
    } });
  }
}
