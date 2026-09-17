import type { FileSyncData } from "../utils/types";
import type { BatchSyncHost } from "./batch_sync";
import { sendSyncInBatches } from "./batch_sync";

export const BINARY_PREFIX_FILE_SYNC = "00";

// Extracted from operator.handleRequestSend and receiveFileSyncUpdate.
export async function sendFileInventory(host: BatchSyncHost, vault: string, offlineDeleteEnabled: boolean, data: FileSyncData): Promise<void> {
  await sendSyncInBatches(host, "FileSync", "FileSyncBatchAck", data.context,
    data.files, offlineDeleteEnabled ? data.delFiles : [], data.missingFiles,
    (mainChunk, delChunk, missingChunk, batchIndex, totalBatches) => ({
      vault, lastTime: data.lastTime, files: mainChunk, context: data.context, batchIndex, totalBatches,
      ...(offlineDeleteEnabled ? { delFiles: delChunk } : {}),
      ...(missingChunk.length > 0 ? { missingFiles: missingChunk } : {}),
    }));
}

export async function requestFileDownload(socket: Pick<BatchSyncHost["websocket"], "SendMessage">, vault: string, data: { path: string; pathHash: string }): Promise<void> {
  await socket.SendMessage("FileChunkDownload", { vault, path: data.path, pathHash: data.pathHash });
}

// The transport has already removed the two-byte file prefix. The remaining
// header is a 36-byte session ID and an unsigned big-endian chunk index.
export function decodeFileChunk(binaryData: ArrayBuffer): { sessionId: string; chunkIndex: number; chunkData: ArrayBuffer } {
  if (binaryData.byteLength < 40) throw new Error("invalid-file-chunk");
  return {
    sessionId: new TextDecoder().decode(new Uint8Array(binaryData, 0, 36)),
    chunkIndex: new DataView(binaryData, 36, 4).getUint32(0, false),
    chunkData: binaryData.slice(40),
  };
}

// Extracted from receiveFileUpload, paired with the download frame decoder.
export function encodeFileChunk(sessionId: string, index: number, chunk: Uint8Array): Uint8Array<ArrayBuffer> {
  const sessionIdBytes = new TextEncoder().encode(sessionId);
  if (sessionIdBytes.byteLength !== 36 || !Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error("invalid-file-chunk");
  const frame = new Uint8Array(40 + chunk.byteLength);
  frame.set(sessionIdBytes, 0);
  new DataView(frame.buffer).setUint32(36, index, false);
  frame.set(chunk, 40);
  return frame;
}

// Shared assembly from handleFileChunkDownloadComplete. Storage and resource
// limits belong to the host; all expected bytes must exist before publication.
export async function assembleFileChunks(size: number, totalChunks: number, read: (index: number) => Promise<ArrayBuffer | undefined>): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (let index = 0; index < totalChunks; index++) {
    const chunk = await read(index);
    if (!chunk || offset + chunk.byteLength > size) throw new Error("incomplete-file-chunks");
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  if (offset !== size) throw new Error("incomplete-file-chunks");
  return bytes;
}
