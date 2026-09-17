import { Buffer } from "node:buffer";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import type { OwnedDirectories } from "./filesystem";
import type { LocalRequests, LocalRequest } from "./local_requests";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_CLIENTS = 4;
const ERROR_CODES = new Set(["invalid-local-request", "request-id-reused", "local-writer-contract-required", "invalid-path", "unsafe-path", "identity-mismatch", "case-collision", "filesystem-limit", "filesystem-failed", "state-write-failed", "state-corrupt", "state-limit", "snapshot-corrupt", "snapshot-missing", "snapshot-limit", "snapshot-invalid", "not-found", "already-exists"]);
export class ControlError extends Error {
  constructor(public readonly code: "invalid-control-request" | "control-unavailable" | "control-permissions" | "control-limit" | "control-timeout") { super(code); this.name = "ControlError"; }
}

export function localControlHandler(requests: LocalRequests): (input: unknown) => Promise<unknown> {
  return async input => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ControlError("invalid-control-request");
    const envelope = input as Record<string, unknown>;
    if (Object.keys(envelope).length !== 3 || envelope.schemaVersion !== 1 || envelope.action !== "local-write" || !envelope.request || typeof envelope.request !== "object" || Array.isArray(envelope.request)) throw new ControlError("invalid-control-request");
    const data = { ...(envelope.request as Record<string, unknown>) };
    if ("contentBase64" in data) {
      if (typeof data.contentBase64 !== "string") throw new ControlError("invalid-control-request");
      const bytes = Buffer.from(data.contentBase64, "base64");
      if (bytes.toString("base64") !== data.contentBase64 || "content" in data) throw new ControlError("invalid-control-request");
      delete data.contentBase64;
      data.content = bytes;
    }
    return await requests.submit(data as unknown as LocalRequest);
  };
}

async function liveSocket(file: string): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(file);
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); reject(new ControlError("control-unavailable")); });
    socket.once("error", (error: { code?: string }) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(new ControlError("control-unavailable"));
    });
  });
}

export async function startControl(owner: OwnedDirectories, handler: (request: unknown) => Promise<unknown>): Promise<{ close(): Promise<void> }> {
  owner.state.assertIdentity();
  const directory = owner.state.identity.path;
  const permissions = lstatSync(directory);
  if ((permissions.mode & 0o077) !== 0 || permissions.uid !== process.getuid!()) throw new ControlError("control-permissions");
  const file = `${directory}/control.sock`;
  if (Buffer.byteLength(file) > 100) throw new ControlError("control-limit");
  try {
    const entry = lstatSync(file);
    if (!entry.isSocket() || entry.uid !== process.getuid!() || await liveSocket(file)) throw new ControlError("control-unavailable");
    unlinkSync(file);
  } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    if (clients.size >= MAX_CLIENTS) { socket.end('{"ok":false,"code":"control-limit"}\n'); return; }
    clients.add(socket);
    const chunks: Buffer[] = [];
    let total = 0, handled = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    socket.on("data", (bytes: Buffer) => {
      if (handled) { socket.destroy(); return; }
      total += bytes.length;
      if (total > MAX_FRAME) { handled = true; socket.end('{"ok":false,"code":"control-limit"}\n'); return; }
      chunks.push(bytes);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      handled = true;
      const frame = Buffer.concat(chunks);
      if (frame.indexOf(10) !== frame.length - 1) { socket.end('{"ok":false,"code":"invalid-control-request"}\n'); return; }
      socket.setTimeout(0);
      void (async () => {
        try {
          owner.vault.assertIdentity(); owner.state.assertIdentity();
          const input = JSON.parse(frame.subarray(0, -1).toString("utf8")) as unknown;
          const result = await handler(input);
          socket.end(JSON.stringify({ ok: true, result }) + "\n");
        } catch (error) {
          const candidate = (error as { code?: string }).code;
          const code = error instanceof SyntaxError ? "invalid-control-request" : error instanceof ControlError ? error.code : candidate && ERROR_CODES.has(candidate) ? candidate : "operation-failed";
          socket.end(JSON.stringify({ ok: false, code }) + "\n");
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", () => reject(new ControlError("control-unavailable"))); server.listen(file, resolve); });
  try { chmodSync(file, 0o600); }
  catch { server.close(); throw new ControlError("control-permissions"); }
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new ControlError("control-unavailable")) : resolve()));
    },
  };
}

export async function sendControl(stateDirectory: string, request: unknown): Promise<unknown> {
  let body: string;
  try { body = JSON.stringify(request) + "\n"; } catch { throw new ControlError("invalid-control-request"); }
  if (Buffer.byteLength(body) > MAX_FRAME) throw new ControlError("control-limit");
  return await new Promise((resolve, reject) => {
    const socket = createConnection(`${stateDirectory}/control.sock`);
    const chunks: Buffer[] = [];
    let total = 0;
    socket.setTimeout(30000, () => { socket.destroy(); reject(new ControlError("control-timeout")); });
    socket.once("error", () => reject(new ControlError("control-unavailable")));
    socket.once("connect", () => socket.write(body));
    socket.on("data", (bytes: Buffer) => {
      total += bytes.length;
      if (total > MAX_FRAME) { socket.destroy(); reject(new ControlError("control-limit")); return; }
      chunks.push(bytes);
    });
    socket.once("end", () => {
      socket.destroy();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
      catch { reject(new ControlError("control-unavailable")); }
    });
  });
}
