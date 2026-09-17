import type { NoteSyncData } from "../utils/types";
import type { BatchSyncHost } from "./batch_sync";
import { sendSyncInBatches } from "./batch_sync";
import { hashContent } from "../utils/protocol_hash";

// Shared request construction from noteModify and receiveNoteUpload. Durability,
// conflict policy and Ack handling remain responsibilities of each host.
export function noteModification(vault: string, path: string, content: string, contentHash: string,
  baseHash: string | null, times: { ctime: number; mtime: number }) {
  return { vault, ...times, path, pathHash: hashContent(path), content, contentHash,
    ...(baseHash !== null ? { baseHash } : { baseHashMissing: true }) };
}

// The NoteSync branch of operator.handleRequestSend, shared by both hosts.
export async function sendNoteInventory(host: BatchSyncHost, vault: string, offlineDeleteEnabled: boolean, data: NoteSyncData, onLastSent?: () => void): Promise<void> {
  await sendSyncInBatches(host, "NoteSync", "NoteSyncBatchAck", data.context,
    data.notes, offlineDeleteEnabled ? data.delNotes : [], data.missingNotes,
    (mainChunk, delChunk, missingChunk, batchIndex, totalBatches) => ({
      vault, lastTime: data.lastTime, notes: mainChunk, context: data.context,
      batchIndex, totalBatches,
      ...(offlineDeleteEnabled ? { delNotes: delChunk } : {}),
      ...(missingChunk.length > 0 ? { missingNotes: missingChunk } : {}),
    }), onLastSent);
}

export interface NoteContentHost {
  hasFile(path: string): boolean;
  hasFolder(path: string): boolean;
  createFolder(path: string): Promise<unknown>;
  modify(path: string, content: string, times: { ctime?: number; mtime?: number }): Promise<unknown>;
  create(path: string, content: string, times: { ctime?: number; mtime?: number }): Promise<unknown>;
}

// The content-application branch of receiveNoteSyncModify. Each caller must
// hold its host's version/ownership guard through application and state commit.
export async function writeNoteContent(host: NoteContentHost, path: string, data: { content: string; ctime: number; mtime: number }): Promise<void> {
  const times = { ...(data.ctime > 0 && { ctime: data.ctime }), ...(data.mtime > 0 && { mtime: data.mtime }) };
  if (host.hasFile(path)) {
    await host.modify(path, data.content, times);
  } else {
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder !== "" && !host.hasFolder(folder)) {
      try { await host.createFolder(folder); }
      catch (error) { if (!host.hasFolder(folder)) throw error; }
    }
    await host.create(path, data.content, times);
  }
}
