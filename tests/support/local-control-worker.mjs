import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "./load-bundle.mjs";
const { exports: { OwnedDirectories, StateStore, SnapshotStore, FileApplication, LocalRequests, startControl, localControlHandler, sendControl } } = await loadBundle("tests/support/headless-entry.ts");
const input = await new Promise(resolve => process.once("message", resolve));
if (input.mode === "client") {
  process.send({ type: "sending" });
  const result = await sendControl(input.state, input.request);
  process.send({ type: "result", result });
  process.disconnect();
} else {
  const owner = OwnedDirectories.acquire(input.vault, input.state);
  const store = new StateStore(path.join(input.state, "state.db"));
  const requests = new LocalRequests(owner, store, "controlled");
  function barrier() {
    // Block at the actual synchronous publication boundary. The separate Bot
    // process can connect and queue data but cannot perform filesystem writes.
    fs.writeFileSync(input.barrier, "ready");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(input.release)) {
      if (Date.now() > deadline) throw new Error("Barrier timed out");
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  function crash() { fs.writeSync(1, "barrier\n"); process.kill(process.pid, "SIGKILL"); }
  if (input.mode === "crash") {
    const commit = store.commit.bind(store);
    store.commit = mutations => {
      commit(mutations);
      if (mutations.some(m => m.record?.kind === "local-request" && m.record.status === input.stage)) crash();
    };
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      rename(source, target);
      if (input.stage === "published" && (String(target).includes(".fns-headless-delete-") || String(target).endsWith("/target.md"))) crash();
    };
    await requests.submit(input.request);
    throw new Error("Crash boundary not reached");
  }
  const app = new FileApplication(owner, store, "controlled");
  const snapshots = new SnapshotStore(owner.state);
  const version = await snapshots.put(Buffer.from("original"), "note");
  await app.prepare("remote-1", "note.md", Buffer.from("remote"), "note", version);
  const control = await startControl(owner, localControlHandler(requests));
  process.send({ type: "ready" });
  process.on("message", async message => {
    if (message.type === "apply") {
      const write = owner.vault.write.bind(owner.vault);
      owner.vault.write = (...args) => { if (input.barrier) barrier(); return write(...args); };
      const result = await app.apply("remote-1");
      owner.vault.write = write;
      process.send({ type: "applied", status: result.status });
    } else if (message.type === "rename") {
      const move = owner.vault.move.bind(owner.vault);
      owner.vault.move = (...args) => { barrier(); return move(...args); };
      const result = await requests.submit(message.request);
      owner.vault.move = move;
      process.send({ type: "renamed", status: result.status });
    } else if (message.type === "close") {
      await control.close(); store.close(); owner.close(); process.disconnect();
    }
  });
}
