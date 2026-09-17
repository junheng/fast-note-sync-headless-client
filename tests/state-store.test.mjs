import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";

const { exports: { StateStore } } = await loadBundle("src/headless/state_store.ts");
const root = await mkdtemp(path.join(tmpdir(), "fns-state-"));
const digest = value => createHash("sha256").update(value).digest("hex");
const version = { sha256: digest("synthetic"), snapshotId: digest("synthetic"), size: 9, protocolHash: "123" };
const operation = { formatVersion: 1, kind: "operation", id: "op-1", path: "synthetic.md", action: "modify", targetPath: null, status: "pending", base: null, desired: version, expectedRemote: null, sessionId: null, context: "op-1" };
const baseline = { formatVersion: 1, kind: "baseline", id: "base-1", path: "synthetic.md", version, confirmedOperationId: "previous-op" };
const batch = { formatVersion: 1, kind: "batch", id: "batch-1", sessionId: "session-1", collection: "notes", checkpointBefore: 0, checkpointTarget: 42, expectedPages: 2, completedPages: [0], pendingOperationIds: ["op-1"], endReceived: true, status: "receiving" };
const session = { formatVersion: 1, kind: "session", id: "session-1", generation: 1, status: "active" };
const put = (record, expectedRevision = null) => ({ type: "put", record, expectedRevision });
const expect = (fn, code) => assert.throws(fn, error => error.code === code && error.message === code);
let store;
async function killAfterBarrier(file, mode, record) {
  const child = spawn(process.execPath, ["tests/support/state-worker.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const result = new Promise((resolve, reject) => {
      let ready = false;
      let output = "";
      child.stdout.on("data", bytes => {
        output += bytes;
        if (output.includes("ready\n")) { ready = true; child.kill("SIGKILL"); }
      });
      child.on("error", reject);
      child.on("exit", (_code, signal) => resolve({ ready, signal }));
    });
    child.stdin.end(JSON.stringify({ file, mode, record }));
    assert.deepEqual(await result, { ready: true, signal: "SIGKILL" });
  } finally { clearTimeout(timer); child.kill("SIGKILL"); }
}
try {
  const file = path.join(root, "state.db");
  expect(() => new StateStore(file), "state-missing");
  store = new StateStore(file, { create: true });
  expect(() => new StateStore(file, { create: true }), "state-exists");
  store.commit([operation, baseline, batch, session].map(record => put(record)));
  for (const record of [operation, baseline, batch, session]) assert.deepEqual(store.get(record.kind, record.id), { record, revision: 1 });
  const loaded = store.get("operation", "op-1");
  loaded.record.status = "acknowledged";
  assert.equal(store.get("operation", "op-1").record.status, "pending", "Returned objects must not mutate durable state");
  store.close();
  expect(() => store.get("operation", "op-1"), "state-closed");
  store = new StateStore(file);
  assert.deepEqual(store.get("batch", "batch-1").record, batch, "End must survive without becoming a committed checkpoint");
  expect(() => store.commit([put({ ...batch, status: "committed" }, 1)]), "state-invalid-record");
  expect(() => store.commit([put({ ...operation, path: "../outside.md" }, 1)]), "state-invalid-record");
  expect(() => store.commit([put({ ...session, token: "synthetic-secret" }, 1)]), "state-invalid-record");
  expect(() => store.commit([put({ ...operation, status: "sent" }, 1), put({ ...baseline, confirmedOperationId: "op-1" }, 99)]), "state-revision-conflict");
  assert.equal(store.get("operation", "op-1").revision, 1, "Failed multi-record commit must roll back earlier writes");
  assert.equal(store.get("baseline", "base-1").record.confirmedOperationId, "previous-op");
  store.commit([put({ ...operation, status: "sent" }, 1), put({ ...session, generation: 2 }, 1)]);
  assert.equal(store.get("operation", "op-1").revision, 2);
  expect(() => store.commit([put(operation, 1)]), "state-revision-conflict");
  store.commit([put({ ...session, id: "session-2" })]);
  assert.deepEqual(store.list("session", { limit: 1 }).map(item => item.record.id), ["session-1"]);
  assert.deepEqual(store.list("session", { afterId: "session-1", limit: 1 }).map(item => item.record.id), ["session-2"]);
  store.close(); store = null;

  await killAfterBarrier(file, "committed", { ...session, id: "committed-before-crash" });
  store = new StateStore(file);
  assert.ok(store.get("session", "committed-before-crash"));
  store.close(); store = null;
  await killAfterBarrier(file, "uncommitted", { ...session, id: "uncommitted-before-crash" });
  store = new StateStore(file);
  assert.equal(store.get("session", "uncommitted-before-crash"), null);
  assert.ok(store.get("session", "committed-before-crash"));
  store.close(); store = null;

  // A real filesystem permission failure prevents journal creation. No send
  // callback runs, and both operation and baseline remain unchanged on restart.
  assert.notEqual(process.getuid?.(), 0, "Permission failure test must run as a non-root user");
  const denied = path.join(root, "denied");
  await mkdir(denied);
  const deniedFile = path.join(denied, "state.db");
  store = new StateStore(deniedFile, { create: true });
  store.commit([put(operation), put(baseline)]);
  await chmod(denied, 0o500);
  let sent = false;
  try {
    expect(() => { store.commit([put({ ...operation, status: "sent" }, 1), put({ ...baseline, confirmedOperationId: "op-1" }, 1)]); sent = true; }, "state-write-failed");
    assert.equal(sent, false);
  } finally { await chmod(denied, 0o700); }
  store.close();
  store = new StateStore(deniedFile);
  assert.deepEqual(store.get("operation", "op-1"), { record: operation, revision: 1 });
  assert.deepEqual(store.get("baseline", "base-1"), { record: baseline, revision: 1 });
  store.close(); store = null;

  for (const [name, mutation, expected] of [
    ["format", db => db.exec("PRAGMA user_version = 99"), "state-format-unsupported"],
    ["record-format", db => db.exec("UPDATE records SET format_version = 99"), "state-format-unsupported"],
    ["checksum", db => db.exec("UPDATE records SET digest = 'wrong'"), "state-corrupt"],
    ["json", db => db.prepare("UPDATE records SET payload = ?, digest = ?").run("{", digest("{")), "state-corrupt"],
    ["schema", db => { const payload = JSON.stringify({ ...session, generation: -1 }); db.prepare("UPDATE records SET payload = ?, digest = ?").run(payload, digest(payload)); }, "state-corrupt"],
  ]) {
    const corrupted = path.join(root, `${name}.db`);
    const seeded = new StateStore(corrupted, { create: true });
    seeded.commit([put(session)]); seeded.close();
    const database = new DatabaseSync(corrupted); mutation(database); database.close();
    const before = await readFile(corrupted);
    expect(() => new StateStore(corrupted), expected);
    assert.deepEqual(await readFile(corrupted), before, "Unsupported/corrupt state must not be rewritten");
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from("synthetic-corrupt-database")]) {
    const corrupted = path.join(root, "broken.db");
    await writeFile(corrupted, bytes);
    expect(() => new StateStore(corrupted), "state-corrupt");
    assert.deepEqual(await readFile(corrupted), bytes);
  }
  console.log("state-store.test.mjs: transactions, restart, process crash, write failure and corruption passed");
} finally {
  store?.close();
  await rm(root, { recursive: true, force: true });
}
