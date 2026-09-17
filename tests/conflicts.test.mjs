import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";

const { exports: { OwnedDirectories, StateStore, SnapshotStore, ConflictStore } } = await loadBundle("tests/support/headless-entry.ts");
const root = fs.mkdtempSync(path.join(tmpdir(), "fns-conflicts-"));
const vault = path.join(root, "vault"), state = path.join(root, "state");
fs.mkdirSync(vault); fs.mkdirSync(state);
const owner = OwnedDirectories.acquire(vault, state);
let store = new StateStore(path.join(state, "state.db"), { create: true });
const snapshots = new SnapshotStore(owner.state);
let conflicts = new ConflictStore(owner, store);
try {
  owner.vault.write("note.md", Buffer.from("local"), "create");
  const initial = await conflicts.capture("initial", "note.md", Buffer.from("remote"), "note", { status: "missing" });
  assert.equal(initial.baseStatus, "missing");
  assert.equal(initial.base, null);
  assert.equal(initial.status, "open");
  assert.equal(snapshots.read(initial.local).toString(), "local");
  assert.equal(snapshots.read(initial.remote).toString(), "remote");
  assert.equal(owner.vault.read("note.md").toString(), "local");
  assert.equal(store.list("baseline").length, 0);
  store.close(); store = new StateStore(path.join(state, "state.db")); conflicts = new ConflictStore(owner, store);
  assert.deepEqual(conflicts.get("initial"), initial);

  const base = await snapshots.put(Buffer.from("base"), "note");
  const three = await conflicts.capture("three-way", "note.md", Buffer.from("remote"), "note", { status: "present", version: base });
  assert.equal(three.baseStatus, "present");
  assert.equal(snapshots.read(three.base).toString(), "base");
  const deleted = await conflicts.capture("remote-delete", "note.md", null, "note", { status: "present", version: base });
  assert.equal(deleted.remote, null);
  assert.equal(owner.vault.read("note.md").toString(), "local");
  const missing = await conflicts.capture("local-delete", "missing.md", Buffer.from("remote"), "note", { status: "present", version: base });
  assert.equal(missing.local, null);
  assert.equal(owner.vault.readOptional("missing.md"), null);
  const absent = await conflicts.capture("known-absent", "note.md", Buffer.from("remote"), "note", { status: "absent" });
  assert.equal(absent.baseStatus, "absent", "Known absent baseline must differ from missing history");

  owner.vault.write("binary.bin", Buffer.from([0, 255, 1]), "create");
  const binary = await conflicts.capture("binary", "binary.bin", Buffer.from([0, 255, 2]), "file", { status: "missing" });
  assert.deepEqual([...snapshots.read(binary.local)], [0, 255, 1]);
  assert.deepEqual([...snapshots.read(binary.remote)], [0, 255, 2]);
  await assert.rejects(conflicts.capture("equal", "note.md", Buffer.from("local"), "note", { status: "missing" }), error => error.code === "invalid-conflict");
  await assert.rejects(conflicts.capture("escape", "../outside", Buffer.from("remote"), "note", { status: "missing" }), error => error.code === "invalid-conflict");
  await assert.rejects(conflicts.capture("bad-base", "note.md", Buffer.from("remote"), "note", { status: "present", version: { ...base, snapshotId: "../outside" } }), error => error.code === "snapshot-invalid");
  assert.equal(store.get("conflict", "bad-base"), null);
  fs.unlinkSync(path.join(state, "snapshots", initial.remote.snapshotId));
  assert.throws(() => conflicts.get("initial"), error => error.code === "snapshot-missing");
  assert.equal(store.get("conflict", "initial").record.status, "open");
  console.log("conflicts.test.mjs: initial, three-way, deletion, binary and restart preservation passed");
} finally { store.close(); owner.close(); fs.rmSync(root, { recursive: true, force: true }); }
