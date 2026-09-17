import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { loadBundle } from "./support/load-bundle.mjs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import vm from "node:vm";
import ts from "typescript";

const { exports: { WebSocketClient }, inputs } = await loadBundle("src/lib/sync/websocket_client.ts");
assert.deepEqual(inputs, ["src/lib/sync/websocket_client.ts"], "Transport must not import an Obsidian dependency graph");
const { exports: { applyAuthorization } } = await loadBundle("src/lib/sync/websocket_auth.ts");

class Socket {
  readyState = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent = [];
  open() { this.readyState = WebSocket.OPEN; this.onopen?.({}); }
  send(data) { assert.equal(this.readyState, WebSocket.OPEN); this.sent.push(data); }
  close() { this.readyState = WebSocket.CLOSED; this.onclose?.({ code: 1000, reason: "", wasClean: true }); }
  message(data) { this.onmessage?.({ data }); }
}

function fixture(options = {}, protobuf = true) {
  const sockets = [];
  const messages = [];
  const counts = [];
  const client = new WebSocketClient({ loadCount: () => 4, saveCount: count => counts.push(count), protobufEnabled: () => protobuf }, {
    getWsUrl: () => "ws://synthetic.invalid",
    onMessage: (_client, action, data) => messages.push({ action, data }),
    autoReconnect: false,
    ...options,
  }, { createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; }, timestamp: () => "synthetic", debug() {}, error() {}, notice() {} });
  return { client, sockets, messages, counts };
}

{
  const f = fixture({ serializeMessage: () => new Uint8Array([8, 1]), deserializeMessage: () => ({ action: "ClientInfo", code: 1 }) });
  await f.client.register();
  assert.deepEqual(f.counts, [5]);
  const socket = f.sockets[0];
  socket.open();
  f.client.Send("Authorization", "synthetic-token");
  f.client.Send("NoteSync", { vault: "synthetic" });
  assert.deepEqual(socket.sent, ["Authorization|synthetic-token", 'NoteSync|{"vault":"synthetic"}']);
  socket.message('NoteModifyAck|{"code":1,"data":{"path":"fixture.md"}}');
  assert.equal(f.messages[0].action, "NoteModifyAck");
  socket.message(new Uint8Array([112, 98, 8, 1]).buffer);
  assert.equal(f.client.useProtobuf, true);
  f.client.Send("NoteSync", {});
  assert.deepEqual([...socket.sent.at(-1)], [112, 98, 8, 1]);
  assert.equal(await f.client.SendBinary(new Uint8Array([7, 8]), "fs"), "sent");
  assert.deepEqual([...socket.sent.at(-1)], [102, 115, 7, 8]);
  f.client.unRegister(true);
  assert.equal(socket.readyState, WebSocket.CLOSED);
}

{
  const f = fixture({ serializeMessage: () => { throw new Error("Synthetic codec error"); } });
  await f.client.register(); f.sockets[0].open(); f.client.useProtobuf = true;
  f.client.Send("NoteSync", { context: "synthetic" });
  assert.equal(f.sockets[0].sent[0], 'NoteSync|{"context":"synthetic"}');
  f.client.unRegister(true);
}

{
  let release;
  const f = fixture({ preConnectProbe: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.client.register();
  f.client.unRegister(true);
  release(true);
  await pending;
  assert.equal(f.sockets.length, 0, "Late preflight completion must not reopen a cancelled client");
}

{
  let release;
  let probes = 0;
  const f = fixture({ preConnectProbe: () => ++probes === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(true) });
  const first = f.client.register();
  const duplicate = f.client.register();
  f.client.unRegister(true);
  const restart = f.client.register();
  release(true);
  await Promise.all([first, duplicate, restart]);
  assert.equal(f.sockets.length, 1, "Explicit restart after cancellation must not be lost behind the old preflight");
  assert.equal(probes, 2);
  f.client.unRegister(true);
}

{
  const f = fixture();
  await f.client.register(); f.sockets[0].open();
  const oldSocket = f.sockets[0];
  const lateMessage = oldSocket.onmessage;
  const lateOpen = oldSocket.onopen;
  oldSocket.bufferedAmount = 6 * 1024 * 1024;
  let callbackCount = 0;
  const text = f.client.SendMessage("NoteSync", {}, undefined, () => callbackCount++);
  const binary = f.client.SendBinary(new Uint8Array([1]), "fs", undefined, () => callbackCount++);
  f.client.unRegister(true);
  await f.client.register(); f.sockets[1].open();
  lateMessage({ data: 'NoteModifyAck|{"code":1}' });
  lateOpen({});
  await Promise.race([Promise.all([text, binary]), delay(1000).then(() => assert.fail("Cancelled buffer wait did not terminate"))]);
  assert.equal(await text, true);
  assert.equal(await binary, "closed");
  assert.equal(f.messages.length, 0);
  assert.equal(f.sockets[1].sent.length, 0, "Old buffered work must not move to a new socket");
  assert.equal(callbackCount, 0);
  f.client.unRegister(true);
}

{
  const f = fixture();
  await f.client.register(); f.sockets[0].open();
  let release;
  class DelayedBlob extends Blob { arrayBuffer() { return new Promise(resolve => { release = resolve; }); } }
  let dispatched = false;
  f.client.registerBinaryHandler("fs", () => { dispatched = true; });
  f.sockets[0].message(new DelayedBlob());
  f.client.unRegister(true);
  release(new Uint8Array([102, 115, 1]).buffer);
  await delay(0);
  assert.equal(dispatched, false, "Late binary conversion must not deliver stale data");
}

for (const enabled of [true, false]) {
  const client = { isAuth: false, useProtobuf: false };
  const state = { negotiated: false };
  assert.equal(applyAuthorization(client, { code: 1, data: { syncUpChunkNum: 100, syncDownChunkNum: 50, pipelineWindowUp: 8, pipelineWindowDown: 4, protobufAck: true } }, state, enabled), true);
  assert.equal(client.isAuth, true);
  assert.equal(client.useProtobuf, enabled);
  assert.deepEqual(state, { negotiated: true, syncUpChunkNum: 100, syncDownChunkNum: 50, pipelineWindowUp: 8, pipelineWindowDown: 4 });
  assert.equal(applyAuthorization(client, { code: 315 }, state, enabled), false);
  assert.equal(client.isAuth, false);
}
// Execute the real plugin adapter against the shared transport, substituting
// only Obsidian host services. Every historical storage key remains readable.
{
  const module = { exports: {} };
  const source = ts.transpileModule(await readFile("src/lib/sync/websocket_obsidian.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { module, exports: module.exports, WebSocket: Socket, require: id => {
    if (id === "./websocket_client") return { WebSocketClient };
    if (id === "obsidian") return { moment: () => ({ format: () => "synthetic" }) };
    if (id === "../utils/helpers") return { dump() {}, dumpError() {}, showSyncNotice() {} };
    throw new Error("Unexpected plugin adapter dependency");
  } });
  const keys = ["fns-synthetic-wsCount", "fast-note-sync-synthetic-wsCount", "fast-note-sync-synthetic-ws-count", "fast-note-sync-ws-count"];
  for (let index = 0; index <= keys.length; index++) {
    const storage = new Map(keys.slice(index).map((key, offset) => [key, String(12 + offset)]));
    const plugin = { app: { vault: { getName: () => "synthetic" }, loadLocalStorage: key => storage.get(key) ?? null, saveLocalStorage: (key, value) => storage.set(key, value) } };
    const client = module.exports.createObsidianWebSocketClient(plugin, { getWsUrl: () => "ws://synthetic.invalid", autoReconnect: false });
    assert.equal(client.count, index < keys.length ? 12 : 0);
    await client.register();
    assert.equal(storage.get(keys[0]), index < keys.length ? "13" : "1");
    client.unRegister(true);
  }
}

{
  const { exports: { connectHeadless } } = await loadBundle("src/headless/connection.ts");
  for (const endpoint of ["invalid", "file:///synthetic", "https://user:secret@synthetic.invalid", "https://synthetic.invalid?token=secret"]) {
    await assert.rejects(connectHeadless({ endpoint, token: "synthetic" }), error => error.code === "invalid-config" && !error.message.includes("secret"));
  }
  // A TCP connection whose WebSocket upgrade never completes must still close
  // at the authentication deadline, without starting a reconnect loop.
  const sockets = new Set();
  const server = createServer();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", () => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(connectHeadless({ endpoint: `http://127.0.0.1:${server.address().port}`, token: "synthetic", timeoutMs: 100 }), error => error.code === "connection-timeout");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  const NativeSocket = globalThis.WebSocket;
  const authSockets = [];
  class AuthSocket extends Socket {
    static CONNECTING = NativeSocket.CONNECTING;
    static OPEN = NativeSocket.OPEN;
    static CLOSING = NativeSocket.CLOSING;
    static CLOSED = NativeSocket.CLOSED;
    constructor() {
      super(); authSockets.push(this);
      queueMicrotask(() => { this.open(); this.message('Authorization|{"code":1}'); });
    }
  }
  globalThis.WebSocket = AuthSocket;
  let connection;
  try {
    let dispatched = false;
    connection = await connectHeadless({ endpoint: "http://synthetic.invalid", token: "synthetic", onMessage: () => { dispatched = true; } });
    authSockets[0].message('Authorization|{"code":315}');
    assert.equal(connection.client.isAuth, false, "A later authentication rejection must close the authenticated connection");
    assert.equal(dispatched, false);
  } finally { connection?.close(); globalThis.WebSocket = NativeSocket; }
}
console.log("websocket-transport.test.mjs: framing, negotiation, cancellation, plugin migration and timeout passed");
