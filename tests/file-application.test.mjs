import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { loadBundle } from "./support/load-bundle.mjs";

const { exports: { OwnedDirectories, StateStore, SnapshotStore, FileApplication, fullDigest } } = await loadBundle("tests/support/headless-entry.ts");
const root = fs.mkdtempSync(path.join(tmpdir(), "fns-application-"));
const bytes = value => Buffer.from(value);
const fixture = name => {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  const vault = path.join(directory, "vault"), state = path.join(directory, "state");
  fs.mkdirSync(vault); fs.mkdirSync(state);
  const store = new StateStore(path.join(state, "state.db"), { create: true }); store.close();
  return { vault, state };
};
function open(f) {
  const owner = OwnedDirectories.acquire(f.vault, f.state);
  const store = new StateStore(path.join(f.state, "state.db"));
  return { owner, store, snapshots: new SnapshotStore(owner.state), app: new FileApplication(owner, store, "exclusive"), close() { store.close(); owner.close(); } };
}
async function crashed(f, stage, create) {
  const child = spawn(process.execPath, ["tests/support/application-worker.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const result = new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.on("error", reject);
      child.on("close", (_code, signal) => resolve({ signal, output }));
    });
    child.stdin.end(JSON.stringify({ ...f, stage, create }));
    assert.deepEqual(await result, { signal: "SIGKILL", output: "barrier\n" }, "Crash worker must reach its requested real I/O boundary");
  } finally { clearTimeout(timer); child.kill("SIGKILL"); }
}
try {
  {
    const f = fixture("immutable");
    const h = open(f);
    try {
      assert.throws(() => new FileApplication(h.owner, h.store), error => error.code === "writing-mode-required");
      assert.deepEqual(fs.readdirSync(f.vault), []);
      const input = Buffer.alloc(300000, 65);
      const expected = fullDigest(input);
      const pending = h.snapshots.put(input, "note");
      input.fill(66);
      const snapshot = await pending;
      assert.equal(snapshot.sha256, expected);
      assert.equal(fullDigest(h.snapshots.read(snapshot)), expected);
      assert.deepEqual(await h.snapshots.put(Buffer.alloc(300000, 65), "note"), snapshot);
      await assert.rejects(h.snapshots.put(Buffer.from([0xff]), "note"), error => error.code === "snapshot-invalid");
      const binary = await h.snapshots.put(Buffer.from([0xff]), "file");
      assert.equal(h.snapshots.read(binary)[0], 0xff);
    } finally { h.close(); }
  }
  for (const create of [false, true]) {
    for (const stage of ["prepared", "temporary", "published", "committed"]) {
      const f = fixture(`${create ? "create" : "replace"}-${stage}`);
      if (!create) fs.writeFileSync(path.join(f.vault, "note.md"), "original");
      await crashed(f, stage, create);
      const h = open(f);
      try {
        const before = h.store.get("application", "apply-1").record;
        assert.equal(before.status, stage === "committed" ? "applied" : "prepared");
        const recovered = await h.app.apply("apply-1");
        assert.equal(recovered.status, "applied");
        assert.equal(h.owner.vault.read("note.md").toString(), "target");
        assert.equal(h.snapshots.read(recovered.after).toString(), "target");
        if (!create) assert.equal(h.snapshots.read(recovered.before).toString(), "original");
        const revision = h.store.get("application", "apply-1").revision;
        assert.equal((await h.app.apply("apply-1")).status, "applied");
        assert.equal(h.store.get("application", "apply-1").revision, revision, "Idempotent recovery must not create another receipt");
        assert.equal(h.store.list("baseline").length, 0, "Local application must not invent a confirmed sync baseline");
      } finally { h.close(); }
    }
  }
  for (const create of [true, false]) {
    const f = fixture(`external-after-crash-${create}`);
    if (!create) fs.writeFileSync(path.join(f.vault, "note.md"), "original");
    await crashed(f, "published", create);
    fs.writeFileSync(path.join(f.vault, "note.md"), "external-edit");
    const h = open(f);
    try {
      const result = await h.app.apply("apply-1");
      assert.equal(result.status, "diverged");
      assert.equal(h.owner.vault.read("note.md").toString(), "external-edit");
      if (!create) assert.equal(h.snapshots.read(result.before).toString(), "original");
      assert.equal(h.snapshots.read(result.after).toString(), "target");
      assert.equal(h.snapshots.read(result.observed).toString(), "external-edit");
    } finally { h.close(); }
  }
  {
    const f = fixture("commit-failure");
    fs.writeFileSync(path.join(f.vault, "note.md"), "original");
    let h = open(f);
    try {
      const expected = await h.snapshots.put(bytes("original"), "note");
      await h.app.prepare("apply-1", "note.md", bytes("target"), "note", expected);
      const realRename = fs.renameSync;
      fs.renameSync = function(source, target) { realRename(source, target); if (target.endsWith("/note.md")) fs.chmodSync(f.state, 0o500); };
      try { await assert.rejects(h.app.apply("apply-1"), error => error.code === "state-write-failed"); }
      finally { fs.renameSync = realRename; fs.chmodSync(f.state, 0o700); }
      assert.equal(h.owner.vault.read("note.md").toString(), "target");
      assert.equal(h.store.get("application", "apply-1").record.status, "prepared");
      h.close(); h = open(f);
      assert.equal((await h.app.apply("apply-1")).status, "applied");
    } finally { h.close(); }
  }
  for (const damage of ["missing", "corrupt"]) {
    const f = fixture(damage);
    const h = open(f);
    try {
      const record = await h.app.prepare("apply-1", "note.md", bytes("target"), "note", null);
      const snapshot = path.join(f.state, "snapshots", record.after.snapshotId);
      if (damage === "missing") fs.unlinkSync(snapshot);
      else fs.writeFileSync(snapshot, "damaged");
      await assert.rejects(h.app.apply("apply-1"), error => error.code === `snapshot-${damage}`);
      assert.equal(fs.existsSync(path.join(f.vault, "note.md")), false);
      assert.equal(h.store.get("application", "apply-1").record.status, "prepared");
    } finally { h.close(); }
  }
  {
    const f = fixture("stale");
    fs.writeFileSync(path.join(f.vault, "note.md"), "current");
    const h = open(f);
    try {
      await assert.rejects(h.app.prepare("apply-1", "note.md", bytes("target"), "note", null), error => error.code === "stale-version");
      assert.equal(h.store.list("application").length, 0);
      assert.equal(h.owner.vault.read("note.md").toString(), "current");
    } finally { h.close(); }
  }
  console.log("file-application.test.mjs: immutable snapshots, 8 process-crash windows, divergence and failed commit passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
