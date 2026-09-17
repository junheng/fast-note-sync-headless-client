import { hashContent } from "../utils/protocol_hash";
import { sendSyncInBatches } from "./batch_sync";
import type { BatchSyncHost } from "./batch_sync";

export interface FolderItem { path: string; pathHash: string }
export interface FolderSyncData {
  lastTime: number;
  folders: FolderItem[];
  delFolders: FolderItem[];
  missingFolders: FolderItem[];
  context?: string;
}

export const folderItem = (path: string): FolderItem => ({ path, pathHash: hashContent(path) });

// Extracted from the official scan/send pair in `operator.ts`: same action,
// acknowledgement event and payload fields, so both hosts speak one folder
// protocol. The caller owns which deletions carry durable evidence.
export async function sendFolderInventory(host: BatchSyncHost, vault: string, offlineDeleteEnabled: boolean,
  data: FolderSyncData, onLastSent?: () => void): Promise<void> {
  await sendSyncInBatches(host, "FolderSync", "FolderSyncBatchAck", data.context,
    data.folders, offlineDeleteEnabled ? data.delFolders : [], data.missingFolders,
    (mainChunk, delChunk, missingChunk, batchIndex, totalBatches) => ({
      vault, lastTime: data.lastTime, folders: mainChunk, context: data.context,
      batchIndex, totalBatches,
      ...(offlineDeleteEnabled ? { delFolders: delChunk } : {}),
      ...(missingChunk.length > 0 ? { missingFolders: missingChunk } : {}),
    }), onLastSent);
}
