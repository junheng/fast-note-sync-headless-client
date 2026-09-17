import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: { FilePull, DownloadChunks, OwnedDirectories }, inputs } = await loadBundle("tests/support/headless-entry.ts");
const { exports: { hashContent, hashArrayBuffer } } = await loadBundle("src/lib/utils/protocol_hash.ts");
assert.ok(!inputs.some(value => /src\/main|operator_file|obsidian\/|utils\/helpers\.ts/.test(value)));
const root = fs.mkdtempSync(path.join(tmpdir(), "fns-file-pull-"));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const packet = (id, index, data) => { const bytes = Buffer.alloc(40 + data.length); bytes.write(id, 0, 36); bytes.writeUInt32BE(index, 36); bytes.set(data, 40); return Uint8Array.from(bytes).buffer; };
const owners = [];
async function fixture(options = {}) {
  const base = path.join(root, randomUUID()); fs.mkdirSync(base); const vault = path.join(base, "vault"), state = path.join(base, "state"); fs.mkdirSync(vault, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  const owner = OwnedDirectories.acquire(vault, state); owners.push(owner);
  const sent = [], applied = [], pages = [];
  const socket = { on() {}, off() {}, Send(action, data) { sent.push({ action, data }); }, async SendMessage(action, data) { this.Send(action, data); } };
  const pull = new FilePull({ socket, vault: "synthetic", context: "round-1", syncUpChunkNum: 2, pipelineWindowUp: 2, pipelineWindowDown: 2,
    directory: owner.state, async onFile(file, bytes) { applied.push({ file, bytes }); return "applied"; }, async onPage(index) { pages.push(index); }, ...options });
  const message = (action, data, pageIndex, context = "round-1") => pull.accept(action, { code: 1, vault: "synthetic", context, data, ...(pageIndex === undefined ? {} : { pageIndex }) });
  const end = count => message("FileSyncEnd", { lastTime: 100, needModifyCount: count });
  const page = (index, total, last) => message("FileSyncPage", { pageIndex: index, totalCount: total, isLast: last });
  async function file(bytes = Buffer.from([0, 255, 1, 128, 42]), name = "nested/data.bin") {
    const data = { path: name, pathHash: hashContent(name), contentHash: await hashArrayBuffer(Uint8Array.from(bytes).buffer), size: bytes.length, ctime: 1, mtime: 2, lastTime: 3 };
    message("FileSyncUpdate", data, 1); await tick();
    return { ...data, sessionId: randomUUID(), chunkSize: 2, totalChunks: Math.ceil(bytes.length / 2) };
  }
  const metadata = data => message("FileSyncChunkDownload", data, undefined, "");
  return { owner, pull, sent, applied, pages, message, end, page, file, metadata, state };
}
try {
  {
    const f = await fixture(); await f.pull.start(); f.end(0); assert.equal((await f.pull.done).received, 0);
  }
  {
    let release; const barrier = new Promise(resolve => { release = resolve; });
    const f = await fixture({ async onFile(file, bytes) { f.applied.push({ file, bytes }); await barrier; return "applied"; } });
    await f.pull.start(); f.end(1); f.page(0, 1, true); const data = await f.file(); f.metadata(data);
    f.pull.acceptBinary(packet(data.sessionId, 2, [42])); f.pull.acceptBinary(packet(data.sessionId, 0, [0, 255])); f.pull.acceptBinary(packet(data.sessionId, 0, [0, 255]));
    await tick(); assert.equal(f.applied.length, 0); assert.deepEqual(f.pages, []);
    f.pull.acceptBinary(packet(data.sessionId, 1, [1, 128])); await tick(); assert.equal(f.applied.length, 1); assert.deepEqual(f.pages, []);
    f.pull.acceptBinary(packet(data.sessionId, 1, [1, 128])); await tick();
    release(); assert.equal((await f.pull.done).received, 1); assert.deepEqual(f.pages, [0]); assert.deepEqual(Buffer.from(f.applied[0].bytes), Buffer.from([0,255,1,128,42]));
    assert.ok(f.sent.every(m => ["FileSync", "FileSyncPageAck", "FileChunkDownload"].includes(m.action))); assert.deepEqual(f.owner.state.hasDirectory("downloads") ? f.owner.state.list("downloads") : [], []);
  }
  for (const mode of ["missing", "duplicate-changed", "wrong-session", "changed-version", "oversized-frame", "bad-hash", "disk-full"]) {
    const f = await fixture(); await f.pull.start(); f.end(1); f.page(0, 1, true); const data = await f.file();
    f.metadata(mode === "changed-version" ? { ...data, size: data.size + 1 } : data);
    if (mode === "disk-full") { const write = f.owner.state.write.bind(f.owner.state); f.owner.state.write = (name, ...args) => { if (name.endsWith(".chunk")) throw new Error("synthetic-private-disk-full"); return write(name, ...args); }; }
    if (mode === "oversized-frame") f.pull.acceptBinary(new ArrayBuffer(8 * 1024 * 1024 + 41));
    else f.pull.acceptBinary(packet(mode === "wrong-session" ? randomUUID() : data.sessionId, 0, mode === "bad-hash" ? [2,3] : [0,255]));
    if (mode === "duplicate-changed") f.pull.acceptBinary(packet(data.sessionId, 0, [1,2]));
    if (mode === "bad-hash") { f.pull.acceptBinary(packet(data.sessionId, 1, [1,128])); f.pull.acceptBinary(packet(data.sessionId, 2, [42])); }
    await tick(); assert.equal(f.applied.length, 0); assert.deepEqual(f.pages, []);
    if (mode === "missing") f.pull.cancel("file-pull-timeout");
    await assert.rejects(f.pull.done, error => {
      assert.ok(!error.message.includes("synthetic-private"));
      if (mode === "changed-version") assert.equal(error.code, "file-version-changed");
      if (mode === "bad-hash") assert.equal(error.code, "file-content-hash-mismatch");
      return true;
    }); f.pull.cancel(); await f.pull.drain();
    DownloadChunks.discardInterrupted(f.owner.state); assert.deepEqual(f.owner.state.hasDirectory("downloads") ? f.owner.state.list("downloads") : [], []);
  }
  {
    const f = await fixture(); await f.pull.start(); f.end(1); f.page(0,1,true); const data = await f.file(Buffer.alloc(0)); f.metadata(data);
    assert.equal((await f.pull.done).received, 1); assert.equal(f.applied[0].bytes.length, 0);
  }
  for (const action of ["FileUpload", "FileSyncNeedPush", "FileSyncDelete", "FileSyncRename"]) {
    const f = await fixture(); await f.pull.start(); f.message(action, {}); await assert.rejects(f.pull.done); assert.deepEqual(f.sent.map(m => m.action), ["FileSync"]);
  }
  {
    const f = await fixture(); const session = new DownloadChunks(f.owner.state, randomUUID(), 5, 2, 3); session.accept(2, Uint8Array.from([42]).buffer);
    await assert.rejects(session.assemble(), { code: "incomplete-file-chunks" });
    // Simulate a killed atomic publication plus an unpublished temporary file.
    const chunk = path.join(f.state, `downloads/${session.sessionId}-2.chunk`);
    fs.linkSync(chunk, path.join(f.state, `downloads/.fns-headless-${randomUUID()}`));
    fs.writeFileSync(path.join(f.state, `downloads/.fns-headless-${randomUUID()}`), "partial");
    DownloadChunks.discardInterrupted(f.owner.state); assert.deepEqual(fs.readdirSync(path.join(f.state, "downloads")), []);
  }
  for (const absent of [true, false]) {
    const f = await fixture({ onAbsent: async () => absent }); await f.pull.start();
    f.message("FileSyncEnd", { lastTime: 100, needModifyCount: 0, needDeleteCount: 1 }); f.page(0, 1, true);
    f.message("FileSyncDelete", { path: "deleted.bin", pathHash: hashContent("deleted.bin"), lastTime: 99 }, 1);
    if (absent) { const receipt = await f.pull.done; assert.equal(receipt.received, 0); assert.equal(receipt.absentRemotely, 1); }
    else await assert.rejects(f.pull.done, { code: "deletion-revalidation-required" });
    assert.deepEqual(f.applied, []);
  }
  console.log("file-pull.test.mjs: shared frames, reordered/duplicate/missing chunks, delayed publication, empty files, stale sessions, corruption, storage failure and readonly gates passed");
} finally { for (const owner of owners) owner.close(); fs.rmSync(root, { recursive: true, force: true }); }
