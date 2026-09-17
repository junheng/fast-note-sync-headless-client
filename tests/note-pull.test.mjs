import assert from "node:assert/strict";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: { NotePull }, inputs } = await loadBundle("src/headless/note_pull.ts");
const { exports: { hashContent } } = await loadBundle("src/lib/utils/protocol_hash.ts");
assert.ok(!inputs.some(value => /src\/main|operator\.ts|operator_note|obsidian\/|helpers\.ts/.test(value)), "Node transfer must not load Obsidian or plugin runtime");
function fixture(options = {}) {
  const sent = [], applied = [], pages = [];
  const socket = { on() {}, off() {}, Send: (action, data) => sent.push({ action, data }), async SendMessage(action, data, _before, after) { this.Send(action, data); after?.(); } };
  const pull = new NotePull({ socket, vault: "synthetic", context: "round-1", syncUpChunkNum: 2, pipelineWindowUp: 2, pipelineWindowDown: 2,
    async onNote(note) { applied.push(note); return "applied"; }, async onPage(index) { pages.push(index); }, ...options });
  const message = (action, data, pageIndex, context = "round-1") => pull.accept(action, { code: 1, vault: "synthetic", context, data, ...(pageIndex === undefined ? {} : { pageIndex }) });
  const end = count => message("NoteSyncEnd", { lastTime: 100, needModifyCount: count });
  const page = (index, total, last) => message("NoteSyncPage", { pageIndex: index, totalCount: total, isLast: last });
  const note = (file, content, index) => message("NoteSyncModify", { path: file, pathHash: hashContent(file), content, contentHash: hashContent(content), ctime: 1, mtime: 2, lastTime: 3 }, index + 1);
  return { pull, sent, applied, pages, message, end, page, note };
}
{
  const f = fixture(); await f.pull.start(); f.end(0);
  assert.deepEqual(await f.pull.done, { scope: "notes", received: 0, pages: 0, lastTime: 100, remoteWrites: false });
  assert.deepEqual(f.sent.map(m => m.action), ["NoteSync"]);
  assert.deepEqual(f.sent[0].data.notes, []); assert.ok(!Object.hasOwn(f.sent[0].data, "delNotes"));
}
{
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = fixture({ async onNote() { await barrier; return "applied"; } });
  await f.pull.start(); f.end(1); f.page(0, 1, true); f.note("中文😀.md", "中文😀\n", 0);
  let finished = false; void f.pull.done.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, false); assert.deepEqual(f.pages, []);
  release(); assert.equal((await f.pull.done).received, 1); assert.deepEqual(f.pages, [0]);
}
{
  const f = fixture(); await f.pull.start(); f.end(2); f.page(1, 1, true); f.note("b.md", "B", 1); f.note("b.md", "B", 1);
  await f.pull.drain(); assert.deepEqual(f.pages, []);
  f.page(0, 1, false); f.note("a.md", "A", 0);
  assert.equal((await f.pull.done).received, 2); assert.deepEqual(f.pages, [0, 1]); assert.equal(f.applied.length, 2);
  assert.deepEqual(f.sent.filter(m => m.action === "NoteSyncPageAck").map(m => m.data.pageIndex), [-1, 0]);
}
for (const action of ["NoteSyncNeedPush", "NoteSyncDelete", "NoteSyncRename"]) {
  const f = fixture(); await f.pull.start(); f.message(action, { path: "private-fixture.md" });
  await assert.rejects(f.pull.done, e => e.code === (action === "NoteSyncNeedPush" ? "readonly-write-required" : "deletion-revalidation-required"));
  assert.deepEqual(f.sent.map(m => m.action), ["NoteSync"]); assert.equal(f.applied.length, 0);
}
for (const result of ["conflict", "throw"]) {
  const f = fixture({ async onNote() { if (result === "throw") throw new Error("synthetic-private-content"); return result; } });
  await f.pull.start(); f.end(1); f.page(0, 1, true); f.note("n.md", "body", 0);
  await assert.rejects(f.pull.done, e => e.code === (result === "throw" ? "note-application-failed" : "note-conflict") && !e.message.includes("private"));
  assert.deepEqual(f.pages, []);
}
{
  const f = fixture(); await f.pull.start(); f.message("NoteSyncEnd", { lastTime: 50 }, undefined, "stale-round");
  f.end(2); f.page(0, 2, true); f.note("n.md", "first", 0); f.note("n.md", "second", 0);
  await assert.rejects(f.pull.done, e => e.code === "invalid-note-message"); assert.equal(f.applied.length, 1);
}
{
  const f = fixture(); await f.pull.start(); f.end(1); f.page(0, 1, true); f.note("../escape.md", "body", 0);
  await assert.rejects(f.pull.done, e => e.code === "invalid-note-message"); assert.equal(f.applied.length, 0);
}
{
  const f = fixture(); await f.pull.start(); f.end(1); f.pull.cancel(); await assert.rejects(f.pull.done, e => e.code === "note-pull-cancelled");
  f.page(0, 1, true); f.note("n.md", "late", 0); await f.pull.drain(); assert.equal(f.applied.length, 0);
}
for (const absent of [true, false]) {
  const f = fixture({ onAbsent: async () => absent }); await f.pull.start();
  f.message("NoteSyncEnd", { lastTime: 100, needModifyCount: 0, needDeleteCount: 1 }); f.page(0, 1, true);
  f.message("NoteSyncDelete", { path: "deleted.md", pathHash: hashContent("deleted.md"), lastTime: 99 }, 1);
  if (absent) { const receipt = await f.pull.done; assert.equal(receipt.received, 0); assert.equal(receipt.absentRemotely, 1); assert.deepEqual(f.pages, [0]); }
  else { await assert.rejects(f.pull.done, { code: "deletion-revalidation-required" }); assert.deepEqual(f.pages, []); }
  assert.deepEqual(f.applied, []);
}
console.log("note-pull.test.mjs: no Obsidian imports, read-only gate, delayed durable application, reordered/duplicate pages, conflicts and cancellation passed");
