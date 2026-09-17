import { Buffer } from "node:buffer";
import { chmodSync, lstatSync, unlinkSync, openSync, closeSync, fstatSync, constants } from "node:fs";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import type { OwnedDirectories } from "./filesystem";
import type { LocalRequests, LocalRequest } from "./local_requests";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_CLIENTS = 4;
const ERROR_CODES = new Set(["invalid-decision", "decision-id-reused", "decision-pending", "resolution-stale", "conflict-read-limit", "conflict-not-found", "snapshot-invalid", "invalid-local-request", "request-id-reused", "local-writer-contract-required", "invalid-path", "unsafe-path", "identity-mismatch", "case-collision", "filesystem-limit", "filesystem-failed", "state-write-failed", "state-corrupt", "state-limit", "snapshot-corrupt", "snapshot-missing", "snapshot-limit", "snapshot-invalid", "not-found", "already-exists"]);
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

// Linux sockaddr_un has a short pathname limit. Address the same filesystem
// socket through an owned directory descriptor, also pinning its parent inode.
function socketAddress(directory: string, expected?: { device: string; inode: string }): { path: string; close(): void } {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd, { bigint: true });
    if ((stat.mode & BigInt(0o077)) !== BigInt(0) || stat.uid !== BigInt(process.getuid!())) throw new ControlError("control-permissions");
    if (expected && (stat.dev.toString() !== expected.device || stat.ino.toString() !== expected.inode)) throw new ControlError("control-unavailable");
    return { path: `/proc/self/fd/${fd}/control.sock`, close: () => { if (fd !== undefined) { closeSync(fd); fd = undefined; } } };
  } catch (error) { if (fd !== undefined) closeSync(fd); throw error instanceof ControlError ? error : new ControlError("control-unavailable"); }
}
async function liveSocket(directory: string): Promise<boolean> {
  const address = socketAddress(directory);
  try { return await new Promise((resolve, reject) => {
    const socket = createConnection(address.path);
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); reject(new ControlError("control-unavailable")); });
    socket.once("error", (error: { code?: string }) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(new ControlError("control-unavailable"));
    });
  }); } finally { address.close(); }
}

export async function startControl(owner: OwnedDirectories, handler: (request: unknown) => Promise<unknown>): Promise<{ close(): Promise<void> }> {
  owner.state.assertIdentity();
  const directory = owner.state.identity.path;
  const permissions = lstatSync(directory);
  if ((permissions.mode & 0o077) !== 0 || permissions.uid !== process.getuid!()) throw new ControlError("control-permissions");
  const file = `${directory}/control.sock`;
  try {
    const entry = lstatSync(file);
    if (!entry.isSocket() || entry.uid !== process.getuid!() || await liveSocket(directory)) throw new ControlError("control-unavailable");
    unlinkSync(file);
  } catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
  const clients = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  const server = createServer(socket => {
    if (closing || clients.size >= MAX_CLIENTS) { socket.end('{"ok":false,"code":"control-limit"}\n'); return; }
    clients.add(socket);
    const chunks: Buffer[] = [];
    let total = 0, handled = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
    socket.on("data", (bytes: Buffer) => {
      if (closing || handled) { socket.destroy(); return; }
      total += bytes.length;
      if (total > MAX_FRAME) { handled = true; socket.end('{"ok":false,"code":"control-limit"}\n'); return; }
      chunks.push(bytes);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      handled = true;
      const frame = Buffer.concat(chunks);
      if (frame.indexOf(10) !== frame.length - 1) { socket.end('{"ok":false,"code":"invalid-control-request"}\n'); return; }
      socket.setTimeout(0);
      const operation = (async () => {
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
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    });
  });
  const address = socketAddress(directory, owner.state.identity);
  try {
    owner.state.assertIdentity();
    await new Promise<void>((resolve, reject) => { server.once("error", () => reject(new ControlError("control-unavailable"))); server.listen(address.path, resolve); });
    chmodSync(address.path, 0o600);
    owner.state.assertIdentity();
  } catch { server.close(); address.close(); throw new ControlError("control-unavailable"); }
  return {
    close: async () => {
      closing = true;
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(new ControlError("control-unavailable")) : resolve()));
      // An idle or non-reading client must not hold the owner lock forever.
      // Already accepted mutations still finish before state can be closed.
      for (const socket of clients) socket.destroy();
      try { await Promise.all([...pending, stopped]); } finally { address.close(); }
    },
  };
}

export async function sendControl(stateDirectory: string, request: unknown): Promise<unknown> {
  let body: string;
  try { body = JSON.stringify(request) + "\n"; } catch { throw new ControlError("invalid-control-request"); }
  if (Buffer.byteLength(body) > MAX_FRAME) throw new ControlError("control-limit");
  const address = socketAddress(stateDirectory);
  try { return await new Promise((resolve, reject) => {
    const socket = createConnection(address.path);
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
  }); } finally { address.close(); }
}
