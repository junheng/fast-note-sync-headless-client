import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: { OwnedDirectories, StateStore, LocalRequests, fullDigest, startControl, localControlHandler, sendControl, startLocalRuntime } } = await loadBundle("tests/support/headless-entry.ts");
const root = fs.mkdtempSync(path.join(tmpdir(), "fns-control-"));
const children = new Set();
const version = text => ({ sha256: fullDigest(Buffer.from(text)), size: Buffer.byteLength(text) });
const modification = id => ({ schemaVersion: 1, action: "local-write", request: { requestId: id, operation: "modify", path: "note.md", expected: version("original"), contentKind: "note", contentBase64: Buffer.from("bot").toString("base64") } });
function fixture(name) {
  const base = path.join(root, name); fs.mkdirSync(base);
  const vault = path.join(base, "v"), state = path.join(base, "s");
  fs.mkdirSync(vault, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(path.join(vault, "note.md"), "original");
  new StateStore(path.join(state, "state.db"), { create: true }).close();
  return { vault, state, barrier: path.join(base, "barrier"), release: path.join(base, "release") };
}
function worker(input) {
  const child = fork("tests/support/local-control-worker.mjs", [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  const messages = [], waiters = [];
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  child.on("message", message => { messages.push(message); for (const wake of waiters.splice(0)) wake(); });
  const closed = new Promise(resolve => child.on("close", (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); }));
  child.send(input);
  return { child, messages, closed, async take(type) {
    const deadline = Date.now() + 15000;
    while (!messages.some(m => m.type === type)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Worker did not produce ${type}: ${stderr}`);
      await Promise.race([new Promise(resolve => waiters.push(resolve)), delay(30)]);
    }
    return messages.find(m => m.type === type);
  } };
}
async function atBarrier(f) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(f.barrier)) { assert.ok(Date.now() < deadline, "Must reach the deterministic filesystem boundary"); await delay(10); }
}
try {
  {
    const base = path.join(root, "startup"); fs.mkdirSync(base);
    const vault = path.join(base, "v"), state = path.join(base, "s");
    fs.mkdirSync(vault, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
    await assert.rejects(startLocalRuntime({ vaultDirectory: vault, stateDirectory: state, createState: true }), e => e.code === "local-writer-contract-required");
    assert.deepEqual(fs.readdirSync(vault), []); assert.deepEqual(fs.readdirSync(state), []);
    const runtime = await startLocalRuntime({ vaultDirectory: vault, stateDirectory: state, createState: true, writingMode: "exclusive" });
    await assert.rejects(startLocalRuntime({ vaultDirectory: vault, stateDirectory: state, writingMode: "exclusive" }), e => e.code === "ownership-conflict");
    const request = { schemaVersion: 1, action: "local-write", request: { requestId: "startup-1", operation: "create", path: "note.md", expected: null, contentKind: "note", contentBase64: Buffer.from("created").toString("base64") } };
    const receipt = await sendControl(state, request); assert.equal(receipt.result.status, "applied");
    await Promise.all([runtime.close(), runtime.close()]);
    const restarted = await startLocalRuntime({ vaultDirectory: vault, stateDirectory: state, writingMode: "controlled" });
    assert.deepEqual(await sendControl(state, request), receipt); await restarted.close();
  }
  for (const remoteFirst of [true, false]) {
    const f = fixture(remoteFirst ? "remote-first" : "bot-first");
    const service = worker({ ...f, mode: "owner", barrier: remoteFirst ? f.barrier : null }); await service.take("ready");
    if (remoteFirst) { service.child.send({ type: "apply" }); await atBarrier(f); }
    const bot = worker({ mode: "client", state: f.state, request: modification("bot-1") }); await bot.take("sending");
    if (remoteFirst) {
      await delay(100);
      assert.ok(!bot.messages.some(m => m.type === "result"));
      assert.equal(fs.readFileSync(path.join(f.vault, "note.md"), "utf8"), "original");
      fs.writeFileSync(f.release, "release");
    }
    const result = (await bot.take("result")).result;
    assert.equal(result.ok, true); assert.equal(result.result.status, remoteFirst ? "stale" : "applied");
    if (!remoteFirst) service.child.send({ type: "apply" });
    assert.equal((await service.take("applied")).status, remoteFirst ? "applied" : "diverged");
    assert.equal(fs.readFileSync(path.join(f.vault, "note.md"), "utf8"), remoteFirst ? "remote" : "bot");
    service.child.send({ type: "close" }); assert.equal((await service.closed).code, 0); assert.equal((await bot.closed).code, 0);
  }
  {
    const f = fixture("target-race");
    const service = worker({ ...f, mode: "owner" }); await service.take("ready");
    service.child.send({ type: "rename", request: { requestId: "rename-1", operation: "rename", path: "note.md", targetPath: "target.md", targetExpected: null, contentKind: "note", expected: version("original") } });
    await atBarrier(f);
    const bot = worker({ mode: "client", state: f.state, request: { schemaVersion: 1, action: "local-write", request: { requestId: "create-1", operation: "create", path: "target.md", expected: null, contentKind: "note", contentBase64: Buffer.from("bot").toString("base64") } } });
    await bot.take("sending"); assert.equal(fs.existsSync(path.join(f.vault, "target.md")), false);
    fs.writeFileSync(f.release, "release");
    assert.equal((await service.take("renamed")).status, "applied");
    assert.equal((await bot.take("result")).result.result.status, "stale");
    assert.equal(fs.readFileSync(path.join(f.vault, "target.md"), "utf8"), "original");
    service.child.send({ type: "close" }); assert.equal((await service.closed).code, 0); await bot.closed;
  }
  for (const operation of ["delete", "rename"]) for (const stage of ["prepared", "published", "applied"]) for (const successor of [false, true]) {
    const f = fixture(`${operation}-${stage}-${successor}`);
    const request = { requestId: "crash-1", operation, path: "note.md", expected: version("original"), contentKind: "note", ...(operation === "rename" ? { targetPath: "target.md", targetExpected: null } : {}) };
    const child = worker({ ...f, mode: "crash", request, stage });
    const result = await child.closed;
    assert.equal(result.signal, "SIGKILL", result.stderr); assert.equal(result.stdout, "barrier\n");
    if (successor && stage !== "prepared") fs.writeFileSync(path.join(f.vault, "note.md"), "original", { flag: "wx" });
    const owner = OwnedDirectories.acquire(f.vault, f.state), store = new StateStore(path.join(f.state, "state.db"));
    try {
      const requests = new LocalRequests(owner, store, "controlled");
      const receipt = await requests.submit(request);
      // The exact same bytes recreated at the old pathname are a successor,
      // never authorization to delete or rename it again.
      if (successor && stage !== "prepared") assert.equal(owner.vault.read("note.md").toString(), "original");
      else assert.equal(owner.vault.readOptional("note.md"), null);
      assert.ok(["applied", "stale"].includes(receipt.status));
      assert.deepEqual(await requests.submit(request), receipt);
      if (operation === "rename") assert.equal(owner.vault.read("target.md").toString(), "original");
      assert.equal(store.list("baseline").length, 0);
    } finally { store.close(); owner.close(); }
  }
  {
    const f = fixture("permissions");
    const owner = OwnedDirectories.acquire(f.vault, f.state), store = new StateStore(path.join(f.state, "state.db"));
    let control;
    try {
      const requests = new LocalRequests(owner, store, "controlled");
      fs.chmodSync(f.state, 0o755);
      await assert.rejects(startControl(owner, localControlHandler(requests)), e => e.code === "control-permissions");
      fs.chmodSync(f.state, 0o700);
      control = await startControl(owner, localControlHandler(requests));
      assert.equal(fs.statSync(path.join(f.state, "control.sock")).mode & 0o777, 0o600);
      await assert.rejects(startControl(owner, localControlHandler(requests)), e => e.code === "control-unavailable");
      const invalid = await sendControl(f.state, { secret: "synthetic-content-must-not-leak" });
      assert.deepEqual(invalid, { ok: false, code: "invalid-control-request" });
    } finally { await control?.close(); store.close(); owner.close(); }
  }
  console.log("local-control.test.mjs: independent Bot processes, deterministic publication barriers, 12 kill/retry cases and socket permissions passed");
} finally { for (const child of children) child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); }
