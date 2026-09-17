import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: api } = await loadBundle("tests/support/headless-entry.ts");
const { OwnedDirectories, StateStore, SnapshotStore, VaultScanner, LocalRequests, fullDigest } = api;
fs.mkdirSync(".local", { recursive: true }); const root = fs.mkdtempSync(path.resolve(".local/resources-"));
let owner, state;
function fixture(name) {
  const base = path.join(root, name), vault = path.join(base, "vault"), directory = path.join(base, "state");
  fs.mkdirSync(vault, { recursive: true, mode: 0o700 }); fs.mkdirSync(directory, { mode: 0o700 });
  return { vault, directory, database: path.join(directory, "state.db") };
}
function open(f, create = false) { owner = OwnedDirectories.acquire(f.vault, f.directory); state = new StateStore(f.database, { create }); }
function close() { state.close(); owner.close(); state = undefined; owner = undefined; }
try {
  const f = fixture("quota"); open(f, true); SnapshotStore.configure(owner.state, 6, 2);
  let snapshots = new SnapshotStore(owner.state);
  const a = await snapshots.put(Buffer.from("AAA"), "note"), b = await snapshots.put(Buffer.from("BBB"), "note");
  assert.deepEqual(await new SnapshotStore(owner.state).put(Buffer.from("AAA"), "note"), a);
  await assert.rejects(snapshots.put(Buffer.from("C"), "note"), { code: "snapshot-limit" });
  SnapshotStore.configure(owner.state, 100, 2);
  await assert.rejects(snapshots.put(Buffer.alloc(0), "note"), { code: "snapshot-limit" });
  owner.vault.write("note.md", Buffer.from("AAA"), "create");
  const requests = new LocalRequests(owner, state, "controlled");
  await assert.rejects(requests.submit({ requestId: "no-space", operation: "modify", path: "note.md", contentKind: "note", expected: { sha256: a.sha256, size: a.size }, content: Buffer.from("CCC") }), { code: "snapshot-limit" });
  assert.equal(owner.vault.read("note.md").toString(), "AAA"); assert.equal(state.get("local-request", "no-space"), null);
  assert.equal(snapshots.read(b).toString(), "BBB");
  // A crash's two-name publication is one allocated inode, and remains
  // recoverable even at the exact quota boundary.
  const alias = path.join(f.directory, "snapshots", `.fns-headless-${randomUUID()}`);
  fs.linkSync(path.join(f.directory, "snapshots", a.snapshotId), alias);
  close(); open(f); SnapshotStore.configure(owner.state, 6, 2); snapshots = new SnapshotStore(owner.state);
  assert.equal((await snapshots.put(Buffer.from("AAA"), "note")).sha256, a.sha256); assert.equal(fs.existsSync(alias), false);
  const orphan = path.join(f.directory, "snapshots", `.fns-headless-${randomUUID()}`); fs.writeFileSync(orphan, "orphan");
  close(); open(f); SnapshotStore.configure(owner.state, 12, 100); snapshots = new SnapshotStore(owner.state);
  await assert.rejects(snapshots.put(Buffer.from("D"), "note"), { code: "snapshot-limit" });
  assert.equal(fs.readFileSync(orphan, "utf8"), "orphan"); assert.equal(snapshots.read(a).toString(), "AAA");
  close();
  const failed = fixture("failed-publication"); open(failed, true); SnapshotStore.configure(owner.state, 6, 100);
  snapshots = new SnapshotStore(owner.state);
  const write = owner.state.write.bind(owner.state);
  owner.state.write = (...args) => { write(...args); throw new Error("synthetic-fsync-failure"); };
  await assert.rejects(snapshots.put(Buffer.from("AAA"), "note"), /synthetic-fsync-failure/);
  owner.state.write = write;
  await snapshots.put(Buffer.from("BBB"), "note");
  await assert.rejects(snapshots.put(Buffer.from("C"), "note"), { code: "snapshot-limit" });
  close();
  const large = fixture("scan"); open(large, true);
  const scanner = new VaultScanner(owner, state); await scanner.scan();
  // Sparse fixtures exercise actual full reads beyond the old 256 MiB cap
  // without allocating a gigabyte of duplicate disk blocks.
  for (let i = 0; i < 9; i++) { const file = path.join(large.vault, `${i}.bin`); fs.writeFileSync(file, ""); fs.truncateSync(file, 32 * 1024 * 1024); }
  const manifest = await scanner.scan(); assert.equal(manifest.files.length, 9); assert.equal(state.get("scan", "latest").record.byteCount, 288 * 1024 * 1024);
  const accepted = state.get("scan", "latest");
  for (let i = 9; i < 33; i++) { const file = path.join(large.vault, `${i}.bin`); fs.writeFileSync(file, ""); fs.truncateSync(file, 32 * 1024 * 1024); }
  await assert.rejects(scanner.scan(), { code: "scan-limit" }); assert.deepEqual(state.get("scan", "latest"), accepted);
  assert.equal(state.list("operation").length, 0); assert.equal(fullDigest(owner.vault.read("0.bin")), manifest.files[0].version.sha256);
  console.log("resources.test.mjs: shared/restarted quotas, publication aliases, orphan accounting, preserved local writes and 288 MiB / 1 GiB scan boundaries passed");
} finally { state?.close(); owner?.close(); fs.rmSync(root, { recursive: true, force: true }); }
