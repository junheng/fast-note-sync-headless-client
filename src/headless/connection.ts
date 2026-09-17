import { BINARY_PREFIX_FILE_SYNC } from "../lib/sync/file_protocol";
import { WebSocketClient } from "../lib/sync/websocket_client";
import { applyAuthorization, sendAuthorization } from "../lib/sync/websocket_auth";
import type { SyncNegotiation } from "../lib/sync/websocket_auth";
import { ClientReceiveAuth } from "../lib/sync/websocket_action";
import { CLIENT_TYPE } from "../lib/utils/types";
import { enSendDTOToProtobuf, deReceivePacket } from "../pb/protobuf_mapper";

export interface ConnectionOptions {
  endpoint: string;
  token: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  protobufEnabled?: boolean;
  onMessage?: (action: string, data: unknown) => void;
  onDisconnect?: () => void;
  onFileChunk?: (data: ArrayBuffer | Blob) => void;
}

export interface AuthorizedConnection {
  client: WebSocketClient;
  negotiation: SyncNegotiation;
  close(): void;
}

export class ConnectionError extends Error {
  constructor(public readonly code: "invalid-config" | "authentication-failed" | "connection-failed" | "connection-timeout" | "cancelled", public readonly serverCode?: number) {
    super(code);
    this.name = "ConnectionError";
  }
}

// This establishes an authenticated transport only. No sync operators, remote
// writes, checkpoint restoration or local file application are started here.
export async function connectHeadless(options: ConnectionOptions): Promise<AuthorizedConnection> {
  let url: URL;
  try { url = new URL(options.endpoint); } catch { throw new ConnectionError("invalid-config"); }
  const timeoutMs = options.timeoutMs ?? 10000;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    !options.token || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new ConnectionError("invalid-config");
  }
  if (options.signal?.aborted) throw new ConnectionError("cancelled");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/user/sync`;
  url.search = new URLSearchParams({
    lang: "en", client: CLIENT_TYPE, clientName: "headless", clientVersion: "2.4.0",
    protocol: "protobuf", pv: "2", pb: options.protobufEnabled === false ? "0" : "1",
  }).toString();

  return await new Promise<AuthorizedConnection>((resolve, reject) => {
    let settled = false;
    let counter = 0;
    let timeout: ReturnType<typeof setTimeout>;
    const negotiation: SyncNegotiation = { negotiated: false };
    const close = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      client.unRegister(true);
    };
    const fail = (error: ConnectionError) => {
      if (!settled) { settled = true; reject(error); }
      close();
    };
    const abort = () => fail(new ConnectionError("cancelled"));
    const client = new WebSocketClient({
      loadCount: () => counter,
      saveCount: count => { counter = count; },
      protobufEnabled: () => options.protobufEnabled !== false,
    }, {
      getWsUrl: count => {
        url.searchParams.set("count", String(count));
        return url.toString();
      },
      autoReconnect: false,
      onOpen: socket => sendAuthorization(socket, options.token),
      onClose: () => { fail(new ConnectionError("connection-failed")); options.onDisconnect?.(); },
      onMessage: (socket, action, data) => {
        if (action === ClientReceiveAuth) {
          if (!data || typeof data !== "object" || !("code" in data) || typeof data.code !== "number") {
            fail(new ConnectionError("authentication-failed"));
            return;
          }
          if (!applyAuthorization(socket, data as { code: number; data?: Record<string, unknown> }, negotiation, options.protobufEnabled !== false)) {
            fail(new ConnectionError("authentication-failed", data.code));
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          socket.notifyStatusChange(true);
          resolve({ client: socket, negotiation, close });
        } else if (socket.isAuth) {
          options.onMessage?.(action, data);
        }
      },
      serializeMessage: enSendDTOToProtobuf,
      deserializeMessage: data => ({ ...deReceivePacket(data) }),
    }, {
      createSocket: address => new WebSocket(address),
      timestamp: () => new Date().toISOString(),
      debug: () => {}, error: () => {}, notice: () => {},
    });
    client.registerBinaryHandler(BINARY_PREFIX_FILE_SYNC, data => { if (client.isAuth) options.onFileChunk?.(data); });
    timeout = setTimeout(() => fail(new ConnectionError("connection-timeout")), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    void client.register().catch(() => fail(new ConnectionError("connection-failed")));
  });
}
