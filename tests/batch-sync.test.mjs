import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: { sendSyncInBatches, settleAllBatchSendSessionsOnClose, settleBatchSendSessionOnSyncEnd }, inputs } = await loadBundle("src/lib/sync/batch_sync.ts");
assert.deepEqual(inputs, ["src/lib/sync/batch_sync.ts"]);
function host(window, synchronous = false) {
  const bus = new EventEmitter(), sent = [];
  const websocket = { on: (...args) => bus.on(...args), off: (...args) => bus.off(...args), async SendMessage(action, payload, _before, after) {
    sent.push(payload);
    if (synchronous) bus.emit("BatchAck", { context: "test", batchIndex: payload.batchIndex });
    after?.();
  } };
  return { websocket, syncState: { syncUpChunkNum: 2, pipelineWindowUp: window }, sent, bus };
}
const send = h => sendSyncInBatches(h, "NoteSync", "BatchAck", "test", [1, 2, 3, 4, 5], [6], [], (main, deleted, missing, batchIndex, totalBatches) => ({ main, deleted, missing, batchIndex, totalBatches }));
for (const window of [0, 1, 2]) {
  const h = host(window, true); await send(h);
  assert.deepEqual(h.sent.map(v => v.main), [[1, 2], [3, 4], [5]]); assert.equal(h.bus.listenerCount("BatchAck"), 0);
}
{
  const a = host(2), b = host(2); const pa = send(a), pb = send(b); const failed = assert.rejects(pa);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.sent.length, 2); assert.equal(b.sent.length, 2);
  settleAllBatchSendSessionsOnClose(a.websocket); await failed;
  b.bus.emit("BatchAck", { context: "other", batchIndex: 0 }); assert.equal(b.sent.length, 2);
  b.bus.emit("BatchAck", { context: "test", batchIndex: 1 });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(b.sent.length, 3);
  b.bus.emit("BatchAck", { context: "test", batchIndex: 1 }); b.bus.emit("BatchAck", { context: "test", batchIndex: 0 }); b.bus.emit("BatchAck", { context: "test", batchIndex: 2 });
  await pb; assert.equal(b.bus.listenerCount("BatchAck"), 0);
}
{
  const h = host(2); const p = send(h); settleBatchSendSessionOnSyncEnd(h.websocket, "BatchAck"); await p;
  assert.equal(h.bus.listenerCount("BatchAck"), 0);
}
{
  const h = host(2); h.websocket.SendMessage = async () => { throw new Error("synthetic-send-failure"); };
  await assert.rejects(send(h), /batch-send-failed/); assert.equal(h.bus.listenerCount("BatchAck"), 0);
}
for (const window of [0, 1, 2]) {
  const h = host(window), pending = send(h); const rejected = assert.rejects(pending);
  settleAllBatchSendSessionsOnClose(h.websocket); await rejected;
  assert.equal(h.bus.listenerCount("BatchAck"), 0);
}
console.log("batch-sync.test.mjs: shared legacy/window paths, immediate/duplicate/foreign Acks, separate hosts and cancellation passed");
