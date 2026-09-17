import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/resolution-process-")), children = new Set();
function fixture(name) {
  const directory = path.join(root, name); fs.mkdirSync(directory);
  const vault = path.join(directory, "vault"), state = path.join(directory, "state"), remote = path.join(directory, "remote");
  fs.mkdirSync(vault, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 }); fs.writeFileSync(path.join(vault, "note.md"), "original"); fs.writeFileSync(remote, "remote");
  return { vault, state, remote, barrier: path.join(directory, "barrier"), release: path.join(directory, "release") };
}
function worker(script, input) {
  const child = fork(script, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); children.add(child);
  let stdout = "", stderr = ""; const messages = [];
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; }); child.on("message", message => messages.push(message));
  const closed = new Promise(resolve => child.on("close", (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); }));
  child.send(input);
  return { child, messages, closed, async take(type) {
    const deadline = Date.now() + 15000;
    while (!messages.some(message => message.type === type)) { if (Date.now() > deadline || child.exitCode !== null) throw new Error(`worker-failed: ${stderr}`); await delay(10); }
    return messages.find(message => message.type === type);
  } };
}
const ownerWorker = (f, input) => worker("tests/support/resolution-worker.mjs", { ...f, ...input });
const version = { sha256: createHash("sha256").update("original").digest("hex"), size: 8 };
const botRequest = { schemaVersion: 1, action: "local-write", request: { requestId: "bot-write", operation: "modify", path: "note.md", contentKind: "note", expected: version, contentBase64: Buffer.from("bot").toString("base64") } };
try {
  for (const resolverFirst of [true, false]) {
    const f = fixture(`mutex-${resolverFirst}`), owner = ownerWorker(f, { mode: "owner", create: true, barrier: resolverFirst ? f.barrier : null }); await owner.take("ready");
    if (resolverFirst) {
      owner.child.send({ type: "resolve" }); const deadline = Date.now() + 10000;
      while (!fs.existsSync(f.barrier)) { assert.ok(Date.now() < deadline); await delay(10); }
    }
    const bot = worker("tests/support/local-control-worker.mjs", { mode: "client", state: f.state, request: botRequest }); await bot.take("sending");
    if (resolverFirst) { await delay(100); assert.ok(!bot.messages.some(m => m.type === "result")); assert.equal(fs.readFileSync(path.join(f.vault, "note.md"), "utf8"), "original"); fs.writeFileSync(f.release, "release"); }
    const botResult = (await bot.take("result")).result; assert.equal(botResult.result.status, resolverFirst ? "stale" : "applied");
    if (!resolverFirst) owner.child.send({ type: "resolve" });
    const result = (await owner.take("resolved")).result; assert.equal(result.status, resolverFirst ? "resolved" : "stale");
    assert.equal(fs.readFileSync(path.join(f.vault, "note.md"), "utf8"), resolverFirst ? "merged" : "bot");
    owner.child.send({ type: "close" }); assert.equal((await owner.closed).code, 0); assert.equal((await bot.closed).code, 0);
  }
  for (const stage of ["decision-prepared", "local-prepared", "published", "local-applied", "sent", "acknowledged", "decision-confirmed"]) {
    const f = fixture(stage), crashed = ownerWorker(f, { mode: "crash", create: true, barrier: null, stage });
    const exit = await crashed.closed; assert.equal(exit.signal, "SIGKILL", exit.stderr); assert.equal(exit.stdout, "barrier\n");
    const recovered = ownerWorker(f, { mode: "owner", create: false, barrier: null }); await recovered.take("ready");
    recovered.child.send({ type: "resolve" }); assert.equal((await recovered.take("resolved")).result.status, "resolved");
    assert.equal(fs.readFileSync(path.join(f.vault, "note.md"), "utf8"), "merged"); assert.equal(fs.readFileSync(f.remote, "utf8"), "merged");
    recovered.child.send({ type: "close" }); assert.equal((await recovered.closed).code, 0);
  }
  const f = fixture("stale-after-crash"), crashed = ownerWorker(f, { mode: "crash", create: true, barrier: null, stage: "local-prepared" });
  assert.equal((await crashed.closed).signal, "SIGKILL"); fs.writeFileSync(f.remote, "new remote");
  const recovered = ownerWorker(f, { mode: "owner", create: false, barrier: null }); await recovered.take("ready");
  assert.equal(fs.readFileSync(path.join(f.vault, "note.md"), "utf8"), "original", "Generic request recovery cannot execute stale conflict decisions");
  recovered.child.send({ type: "resolve" }); const stale = (await recovered.take("resolved")).result; assert.equal(stale.status, "stale"); assert.ok(stale.nextConflictId);
  assert.equal(fs.readFileSync(path.join(f.vault, "note.md"), "utf8"), "original"); assert.equal(fs.readFileSync(f.remote, "utf8"), "new remote");
  recovered.child.send({ type: "close" }); assert.equal((await recovered.closed).code, 0);
  console.log("resolution-control.test.mjs: independent Bot ordering, seven SIGKILL boundaries and stale decision recovery passed");
} finally { for (const child of children) child.kill("SIGKILL"); fs.rmSync(root, { recursive: true, force: true }); }
