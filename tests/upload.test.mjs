import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadBundle } from "./support/load-bundle.mjs";

const { exports: { OwnedDirectories, StateStore, IdentityBinding, SnapshotStore, DurableOutbox, uploadOperation } } = await loadBundle("tests/support/headless-entry.ts");
const NativeSocket = globalThis.WebSocket;
const identityEvidence = { serviceId: "fixture", subjectId: "fixture", vaultId: "fixture", vaultName: "fixture" };
// Synthetic fault harness: remote operations use the official wire fields.
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/upload-"));
let handler, sockets = [];
class Socket {
  static CONNECTING = NativeSocket.CONNECTING;
  static OPEN = NativeSocket.OPEN;
  static CLOSING = NativeSocket.CLOSING;
  static CLOSED = NativeSocket.CLOSED;
  readyState = Socket.CONNECTING;
  bufferedAmount = 0;
  constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = Socket.OPEN; this.onopen?.({}); }); }
  reply(action, data = {}, extra = {}) { this.onmessage?.({ data: `${action}|${JSON.stringify({ code: 1, data, ...extra })}` }); }
  send(payload) {
    assert.equal(this.readyState, Socket.OPEN);
    if (typeof payload !== "string") { handler(this, "binary", payload); return; }
    const split = payload.indexOf("|"), action = payload.slice(0, split);
    if (action === "Authorization") { queueMicrotask(() => this.reply("Authorization")); return; }
    if (action === "ClientInfo") { queueMicrotask(() => this.reply("ClientInfo")); return; }
    handler(this, action, JSON.parse(payload.slice(split + 1)));
  }
  close() { if (this.readyState === Socket.CLOSED) return; this.readyState = Socket.CLOSED; this.onclose?.({ code: 1000 }); }
}
globalThis.WebSocket = Socket;
const rejection = (work, code) => assert.rejects(work, error => error.code === code && error.message === code);
async function fixture(name, work) {
  const directory = path.join(root, name), vault = path.join(directory, "vault"), stateDirectory = path.join(directory, "state");
  await mkdir(vault, { recursive: true, mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  let owner, state, identity, outbox, snapshots;
  function open(create = false) {
    owner = OwnedDirectories.acquire(vault, stateDirectory); state = new StateStore(path.join(stateDirectory, "state.db"), { create });
    identity = new IdentityBinding(owner, state, "https://fixture.invalid", "fixture"); identity.verify(identityEvidence);
    outbox = new DurableOutbox(owner, state, identity); snapshots = new SnapshotStore(owner.state);
  }
  open(true);
  const remote = new Map(), writes = [];
  const f = {
    get owner() { return owner; }, get state() { return state; }, get identity() { return identity; }, get outbox() { return outbox; }, get snapshots() { return snapshots; },
    remote, writes, stateDirectory,
    reopen() { state.close(); owner.close(); open(); },
    run(id, overrides = {}) {
      return uploadOperation(owner, state, identity, id, { endpoint: "https://fixture.invalid", token: "synthetic-secret", vault: "fixture", protobufEnabled: false,
        transferTimeoutMs: 1500, verifyIdentity: async () => identityEvidence,
        readBack: async file => remote.get(file) ?? null, ...overrides });
    },
  };
  handler = (socket, action, payload) => {
    writes.push({ action, payload });
    if (action === "NoteModify") {
      void snapshots.put(Buffer.from(payload.content), "note").then(version => {
        remote.set(payload.path, version); socket.reply("NoteModifyAck", { path: payload.path }, { context: payload.context });
      });
    }
  };
  try { await work(f); }
  finally { await chmod(stateDirectory, 0o700); for (const socket of sockets) socket.close(); sockets = []; state.close(); owner.close(); }
}
try {
  await fixture("successor", async f => {
    const a = await f.snapshots.put(Buffer.from("immutable A"), "note"), b = await f.snapshots.put(Buffer.from("later B"), "note");
    const first = await f.outbox.prepare("fixture.md", a, null);
    let successor;
    handler = (socket, action, payload) => {
      f.writes.push({ action, payload });
      assert.equal(action, "NoteModify"); assert.equal(payload.content, "immutable A");
      assert.equal(f.state.get("operation", first.id).record.status, "sent", "Durable sent version must precede network I/O");
      void (async () => {
        successor = await f.outbox.prepare("fixture.md", b, a);
        f.owner.vault.write("fixture.md", Buffer.from("later B"), "create");
        f.remote.set("fixture.md", a);
        socket.reply("NoteModifyAck", { path: "wrong.md" });
        socket.reply("NoteModifyAck", { path: "fixture.md" }, { context: "old-context" });
        socket.reply("NoteModifyAck", { path: "fixture.md" });
        socket.reply("NoteModifyAck", { path: "fixture.md" });
      })();
    };
    assert.equal((await f.run(first.id)).status, "confirmed");
    assert.equal(f.outbox.baseline("fixture.md").version.sha256, a.sha256);
    assert.equal(f.state.get("operation", successor.id).record.status, "pending");
    assert.equal(f.owner.vault.read("fixture.md").toString(), "later B");
  });

  await fixture("lost-ack", async f => {
    const a = await f.snapshots.put(Buffer.from("persisted remotely"), "note"), op = await f.outbox.prepare("fixture.md", a, null);
    let obsoleteMessage;
    handler = (socket, action) => { assert.equal(action, "NoteModify"); f.writes.push(action); f.remote.set("fixture.md", a); obsoleteMessage = socket.onmessage; };
    await rejection(() => f.run(op.id, { transferTimeoutMs: 80 }), "upload-timeout");
    assert.equal(f.state.get("operation", op.id).record.status, "sent"); assert.equal(f.outbox.baseline("fixture.md"), null);
    f.reopen();
    const receipt = await f.run(op.id, { readBack: async file => {
      obsoleteMessage({ data: 'NoteModifyAck|{"code":1,"data":{"path":"fixture.md"}}' });
      return f.remote.get(file) ?? null;
    } });
    assert.equal(receipt.recovered, true); assert.equal(f.writes.length, 1, "Lost Ack recovery must not resend an already present version");
    assert.equal(f.outbox.baseline("fixture.md").version.sha256, a.sha256);
  });

  for (const mode of ["identity", "endpoint", "remote-changed", "persistence", "wrong-ack", "readback-changed"]) {
    await fixture(mode, async f => {
      const a = await f.snapshots.put(Buffer.from("A"), "note"), b = await f.snapshots.put(Buffer.from("B"), "note");
      const op = await f.outbox.prepare("fixture.md", a, null);
      const options = {}; let expected, writes = 0;
      handler = (socket, action, payload) => {
        writes++;
        socket.reply("NoteModifyAck", { path: mode === "wrong-ack" ? "other.md" : payload.path }, { context: payload.context });
        if (mode === "readback-changed") f.remote.set("fixture.md", b);
      };
      if (mode === "identity") { expected = "state-identity-mismatch"; options.verifyIdentity = async () => ({ ...identityEvidence, subjectId: "different" }); }
      if (mode === "endpoint") { expected = "state-identity-mismatch"; options.endpoint = "https://different.invalid"; }
      if (mode === "remote-changed") { expected = "remote-version-changed"; f.remote.set("fixture.md", b); }
      if (mode === "persistence") {
        expected = "state-write-failed";
        options.readBack = async () => { await chmod(f.stateDirectory, 0o500); return null; };
      }
      if (mode === "wrong-ack") { expected = "upload-timeout"; options.transferTimeoutMs = 80; }
      if (mode === "readback-changed") expected = "remote-version-changed";
      await rejection(() => f.run(op.id, options), expected);
      assert.equal(f.outbox.baseline("fixture.md"), null);
      assert.notEqual(f.state.get("operation", op.id).record.status, "acknowledged");
      assert.equal(writes, ["wrong-ack", "readback-changed"].includes(mode) ? 1 : 0);
    });
  }

  for (const kind of ["note", "file"]) for (const action of ["delete", "rename"]) for (const lostAck of [false, true]) {
    await fixture(`${kind}-${action}-${lostAck}`, async f => {
      const extension = kind === "note" ? "md" : "bin", source = `source.${extension}`, target = `nested/target.${extension}`;
      const version = await f.snapshots.put(Buffer.from("official operation fixture"), kind);
      f.remote.set(source, version);
      const op = await f.outbox.prepare(source, action === "delete" ? null : version, version, action, action === "rename" ? target : null);
      handler = (socket, requestAction, payload) => {
        f.writes.push({ requestAction, payload });
        assert.equal(requestAction, `${kind === "note" ? "Note" : "File"}${action === "delete" ? "Delete" : "Rename"}`);
        assert.equal(payload.path, action === "rename" ? target : source);
        assert.equal(Object.hasOwn(payload, "expectedVersion"), false, "Do not invent upstream CAS fields");
        f.remote.delete(source);
        if (action === "rename") { assert.equal(payload.oldPath, source); f.remote.set(target, version); }
        if (!lostAck) queueMicrotask(() => socket.reply(`${requestAction}Ack`, { path: payload.path }, { context: payload.context }));
      };
      if (lostAck) {
        await rejection(() => f.run(op.id, { transferTimeoutMs: 80 }), "upload-timeout"); f.reopen();
      }
      const receipt = await f.run(op.id);
      assert.equal(receipt.recovered, lostAck); assert.equal(f.writes.length, 1);
      assert.equal(f.outbox.baseline(source).version, null);
      if (action === "rename") assert.equal(f.outbox.baseline(target).version.sha256, version.sha256);
    });
  }

  for (const mode of ["file", "empty", "cancel", "expired-session", "invalid-chunk"]) {
    await fixture(mode, async f => {
      const content = mode === "empty" ? Buffer.alloc(0) : Buffer.from([0, 255, 1, 2, 3, 128, 4, 5, 6]);
      const desired = await f.snapshots.put(content, "file"), op = await f.outbox.prepare("fixture.bin", desired, null);
      const controller = new AbortController(); let session, chunks = [], attempt = 0, requests = [], sessions = [];
      handler = (socket, action, payload) => {
        if (action === "FileUploadCheck") {
          requests.push(payload); session = randomUUID(); sessions.push(session); chunks = []; attempt++;
          assert.equal(payload.contentHash, desired.protocolHash);
          queueMicrotask(() => socket.reply("FileUpload", { path: payload.path, pathHash: payload.pathHash, sessionId: session,
            chunkSize: mode === "invalid-chunk" ? 9 * 1024 * 1024 : 3 }, { context: payload.context }));
        } else {
          assert.equal(action, "binary"); const frame = Buffer.from(payload);
          assert.equal(frame.subarray(0, 2).toString(), "00"); assert.equal(frame.subarray(2, 38).toString(), session);
          assert.equal(frame.readUInt32BE(38), chunks.length); chunks.push(frame.subarray(42));
          if (mode === "cancel" && attempt === 1) { controller.abort(); return; }
          if (chunks.length === Math.max(1, Math.ceil(content.length / 3))) {
            assert.deepEqual(Buffer.concat(chunks), content);
            // The first session is dropped without an Ack: the server never
            // completes it, so the client must time out and ask for a new one.
            if (mode === "expired-session" && attempt === 1) return;
            f.remote.set("fixture.bin", desired);
            setImmediate(() => socket.reply("FileUploadAck", { path: "fixture.bin" }));
          }
        }
      };
      if (mode === "invalid-chunk") {
        await rejection(() => f.run(op.id), "invalid-upload-message"); assert.equal(chunks.length, 0);
      } else {
        if (mode === "cancel") {
          await rejection(() => f.run(op.id, { signal: controller.signal }), "upload-cancelled");
          assert.equal(f.outbox.baseline("fixture.bin"), null); assert.equal(chunks.length, 1);
          f.reopen();
        }
        if (mode === "expired-session") {
          await rejection(() => f.run(op.id, { transferTimeoutMs: 80 }), "upload-timeout");
          assert.equal(f.outbox.baseline("fixture.bin"), null);
          assert.equal(f.state.get("operation", op.id).record.status, "sent");
          assert.equal(f.remote.has("fixture.bin"), false);
          f.reopen();
        }
        assert.equal((await f.run(op.id)).status, "confirmed");
        assert.equal(f.outbox.baseline("fixture.bin").version.sha256, desired.sha256);
        assert.equal(requests.length, ["cancel", "expired-session"].includes(mode) ? 2 : 1);
        if (mode === "expired-session") assert.notEqual(sessions[0], sessions[1], "A retry must request a fresh session");
      }
    });
  }
  console.log("upload.test.mjs: shared note/file transport, durable sends, lost Ack recovery, stale events, cancellation, expired session, official mutations and identity gates passed (synthetic service)");
} finally { globalThis.WebSocket = NativeSocket; await rm(root, { recursive: true, force: true }); }
