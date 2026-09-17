// Shared WSResponse mapping from WebSocketManager. Wire item page indexes are
// one-based; page-control payloads carry their own zero-based pageIndex.
export function syncPayload(envelope: { data?: unknown; context?: string; pageIndex?: number }): unknown {
  const rawPageIndex = typeof envelope.pageIndex === "number" ? envelope.pageIndex : 0;
  const pageIndex = rawPageIndex > 0 ? rawPageIndex - 1 : undefined;
  if (typeof envelope.data !== "object" || envelope.data === null) return envelope.data;
  return { ...envelope.data, ...(envelope.context ? { context: envelope.context } : {}), ...(pageIndex !== undefined ? { pageIndex } : {}) };
}

// Extracted from FastSync.sendSyncPageAck, including the initial -1 request.
export function sendPageAcknowledgement(socket: { Send(action: string, payload: unknown): void }, type: "note" | "file" | "setting" | "folder", vault: string, context: string, pageIndex: number): void {
  const action = { note: "NoteSyncPageAck", file: "FileSyncPageAck", setting: "SettingSyncPageAck", folder: "FolderSyncPageAck" }[type];
  socket.Send(action, { context, vault, pageIndex });
}
