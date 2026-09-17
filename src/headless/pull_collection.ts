import { randomUUID } from "node:crypto";
import { connectHeadless } from "./connection";
import type { ConnectionOptions } from "./connection";
import { PullError } from "./collection_pull";
import type { CollectionPull, PullOptions, PullReceipt } from "./collection_pull";
import { CLIENT_TYPE } from "../lib/utils/types";

export interface PullConnectionOptions extends Omit<ConnectionOptions, "onMessage" | "onDisconnect" | "onFileChunk"> {
  vault: string;
  initialCopy?: boolean;
  onAbsent?(path: string): Promise<boolean>;
  onRename?(oldPath: string, path: string): Promise<"applied" | "unchanged">;
  onEnd?(lastTime: number, count: number): Promise<void>;
  onPage?(index: number): Promise<void>;
  onSend?(action: string): void;
  startFolders?: { folders: string[]; delFolders: string[] };
  transferTimeoutMs?: number;
}
// Network transfer only. Durable consumers must validate their identity first.
export async function pullCollection<C extends "notes" | "files" | "folders">(options: PullConnectionOptions, collection: C, create: (options: PullOptions) => CollectionPull<C> & { acceptBinary?(data: ArrayBuffer | Blob): void }): Promise<PullReceipt<C>> {
  const prefix = collection === "notes" ? "note" : collection === "files" ? "file" : "folder";
  const actionPrefix = collection === "notes" ? "Note" : collection === "files" ? "File" : "Folder";
  const duration = options.transferTimeoutMs ?? 60000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300000) throw new PullError(`invalid-${prefix}-message`);
  let pull: (CollectionPull<C> & { acceptBinary?(data: ArrayBuffer | Blob): void }) | undefined;
  let infoResolve!: () => void;
  let infoReject!: (error: PullError) => void;
  const info = new Promise<void>((resolve, reject) => { infoResolve = resolve; infoReject = reject; });
  void info.catch(() => {});
  const controller = new AbortController();
  const stop = (timeout: boolean) => {
    const code = timeout ? `${prefix}-pull-timeout` : `${prefix}-pull-cancelled`;
    pull?.cancel(code); infoReject(new PullError(code)); controller.abort();
  };
  const abort = () => stop(false);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(true), duration);
  let connection: Awaited<ReturnType<typeof connectHeadless>> | undefined;
  // Batch senders register acknowledgement listeners on this host. The folder
  // inventory can exceed one chunk, so messages are dispatched to them too.
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const dispatch = (action: string, data: unknown) => {
    for (const handler of listeners.get(action) ?? []) handler(data);
  };
  try {
    if (options.signal?.aborted) throw new PullError(`${prefix}-pull-cancelled`);
    connection = await connectHeadless({ ...options, signal: controller.signal,
      onDisconnect: () => stop(false),
      onFileChunk: data => pull?.acceptBinary?.(data),
      onMessage: (action, data) => {
        if (action === "ClientInfo") {
          const code = (data as { code?: number } | null)?.code;
          if (typeof code === "number" && code > 0 && code < 300) infoResolve();
          else infoReject(new PullError(`${prefix}-pull-failed`));
        } else { dispatch(action, data); pull?.accept(action, data); }
      },
    });
    const client = connection.client;
    const allow = (action: string) => {
      if (!["ClientInfo", `${actionPrefix}Sync`, `${actionPrefix}SyncPageAck`, ...(collection === "files" ? ["FileChunkDownload"] : [])].includes(action)) throw new PullError("readonly-write-required");
      if (controller.signal.aborted || !client.isAuth || client.ws?.readyState !== WebSocket.OPEN) throw new PullError(`${prefix}-pull-cancelled`);
      options.onSend?.(action);
    };
    const socket = {
      Send: (action: string, data: unknown) => { allow(action); client.Send(action, data); },
      SendMessage: async (action: string, data: unknown, before?: () => boolean, after?: () => void) => { allow(action); return await client.SendMessage(action, data, before, after); },
      on: (event: string, handler: (...args: unknown[]) => void) => { const set = listeners.get(event) ?? new Set(); set.add(handler); listeners.set(event, set); },
      off: (event: string, handler: (...args: unknown[]) => void) => { listeners.get(event)?.delete(handler); },
    };
    socket.Send("ClientInfo", { name: "headless", version: "2.4.0", type: CLIENT_TYPE, isDesktop: true, isLinux: true, protobuf: options.protobufEnabled !== false, offlineSyncStrategy: "manualMerge" });
    await info;
    const negotiated = connection.negotiation;
    pull = create({ socket, vault: options.vault, context: randomUUID(), syncUpChunkNum: negotiated.syncUpChunkNum ?? 200,
      pipelineWindowUp: negotiated.pipelineWindowUp ?? 0, pipelineWindowDown: negotiated.pipelineWindowDown ?? 0,
      onAbsent: options.onAbsent ? path => options.onAbsent!(path) : undefined,
      onRename: options.onRename ? (oldPath, path) => options.onRename!(oldPath, path) : undefined,
      startFolders: options.startFolders,
      onEnd: (time, count) => options.onEnd?.(time, count) ?? Promise.resolve(), onPage: index => options.onPage?.(index) ?? Promise.resolve() });
    await pull.start();
    return await pull.done;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    pull?.cancel(); await pull?.drain(); connection?.close();
  }
}
