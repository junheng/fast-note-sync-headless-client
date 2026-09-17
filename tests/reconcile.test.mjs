import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: api } = await loadBundle("tests/support/headless-entry.ts");
const { OwnedDirectories, StateStore, IdentityBinding, SnapshotStore, DurableOutbox, SyncCoordinator, sameVersion, allRecords } = api;
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/reconcile-"));
const vault = path.join(root, "vault"), directory = path.join(root, "state");
await mkdir(vault, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
let owner, state, identity, snapshots, outbox, sync, afterUpload;
const files = new Map(), deleted = new Set(); let writes = 0;
const subject = { serviceId: null, subjectId: "fixture", vaultId: null, vaultName: "synthetic" };
const peer = {
  async authenticate() { identity.verify(subject); },
  async inventory() { await this.authenticate(); return { files: new Map(files), deleted: new Set(deleted), noteTime: 1, fileTime: 1 }; },
  async read(file) { return files.get(file) ?? null; },
  async upload(id) {
    await this.authenticate();
    const op = state.get("operation", id).record;
    if (!sameVersion(files.get(op.path) ?? null, op.expectedRemote)) throw Object.assign(new Error(), { code: "remote-version-changed" });
    if (op.targetPath && files.has(op.targetPath)) throw Object.assign(new Error(), { code: "remote-version-changed" });
    const sent = await outbox.sent(id, "fixture-connection");
    if (op.targetPath) { files.delete(op.path); deleted.add(op.path); }
    const target = op.targetPath ?? op.path;
    if (op.desired) { files.set(target, op.desired); deleted.delete(target); } else { files.delete(target); deleted.add(target); }
    writes++;
    if (afterUpload) await afterUpload();
    await outbox.confirm(id, sent.sessionId, sent.context, op.desired, op.targetPath ? null : undefined);
    identity.invalidate();
  },
};
function open(create = false) {
  owner = OwnedDirectories.acquire(vault, directory); state = new StateStore(path.join(directory, "state.db"), { create });
  identity = new IdentityBinding(owner, state, "https://example.invalid", "synthetic");
  snapshots = new SnapshotStore(owner.state); outbox = new DurableOutbox(owner, state, identity);
  sync = new SyncCoordinator(owner, state, identity, peer, "controlled");
}
async function version(text, kind = "note") { return snapshots.put(Buffer.from(text), kind); }
async function edit(file, content, id) {
  const old = owner.vault.readOptional(file), expected = old ? { sha256: api.fullDigest(old), size: old.length } : null;
  const receipt = await sync.requests.submit({ requestId: id, operation: content === null ? "delete" : old ? "modify" : "create", path: file,
    expected, contentKind: file.endsWith(".md") ? "note" : "file", ...(content === null ? {} : { content: Buffer.from(content) }) });
  assert.equal(receipt.status, "applied");
}
try {
  open(true);
  await peer.authenticate();
  files.set("nested/remote.md", await version("remote A"));
  await edit("local.md", "local A", "local-create");
  let result = await sync.once();
  assert.equal(result.status, "synchronized"); assert.equal(result.uploaded, 1); assert.equal(result.downloaded, 1);
  assert.equal(owner.vault.read("nested/remote.md").toString(), "remote A");
  const firstWrites = writes;
  result = await sync.once(); assert.equal(result.status, "synchronized"); assert.equal(writes, firstWrites);
  // Restart and offline deletion are reconciled against the confirmed base.
  state.close(); owner.close(); open();
  await edit("local.md", null, "offline-delete");
  result = await sync.once(); assert.equal(result.status, "synchronized"); assert.equal(files.has("local.md"), false);
  // Absence without retained history must not destroy an unchanged local file.
  files.delete("nested/remote.md");
  result = await sync.once(); assert.equal(result.status, "incomplete"); assert.equal(result.historyUnverified, 1);
  assert.equal(owner.vault.read("nested/remote.md").toString(), "remote A");
  deleted.add("nested/remote.md");
  result = await sync.once(); assert.equal(result.status, "synchronized"); assert.equal(owner.vault.readOptional("nested/remote.md"), null);
  // A new local edit while an older immutable upload is acknowledged remains
  // incomplete until the successor is sent on the next cycle.
  await edit("editing.md", "A", "edit-A");
  afterUpload = async () => { afterUpload = null; await edit("editing.md", "B", "edit-B"); };
  result = await sync.once(); assert.equal(result.status, "incomplete");
  assert.equal(snapshots.read(files.get("editing.md")).toString(), "A");
  assert.equal(outbox.baseline("editing.md").version.sha256, api.fullDigest(Buffer.from("A")));
  result = await sync.once(); assert.equal(result.status, "synchronized");
  assert.equal(snapshots.read(files.get("editing.md")).toString(), "B");
  // Controlled move is one rename intent; its old request is never replayed.
  const before = files.get("editing.md");
  owner.vault.createDirectories("target");
  await sync.requests.submit({ requestId: "move", operation: "rename", path: "editing.md", targetPath: "target/moved.md", targetExpected: null,
    contentKind: "note", expected: { sha256: before.sha256, size: before.size } });
  result = await sync.once(); assert.equal(result.status, "synchronized");
  assert.equal(files.has("editing.md"), false); assert.ok(files.has("target/moved.md"));
  assert.equal(outbox.operations().filter(op => op.action === "rename").length, 1);
  // Simulate the crash boundary after remote bytes land but before the common
  // baseline commit. Recovery must preserve a subsequent local edit.
  files.set("crash.md", await version("downloaded"));
  const commit = state.commit.bind(state);
  state.commit = mutations => {
    if (mutations.some(m => m.record?.kind === "reconcile" && m.record.status === "committed")) throw new Error("injected-crash");
    return commit(mutations);
  };
  await assert.rejects(() => sync.once());
  assert.equal(owner.vault.read("crash.md").toString(), "downloaded");
  state.close(); owner.close(); open();
  await edit("crash.md", "successor", "post-crash-edit");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  assert.equal(snapshots.read(files.get("crash.md")).toString(), "successor");
  // Divergent local/remote edits retain all three versions without upload.
  await edit("crash.md", "local conflict", "conflicting-edit");
  files.set("crash.md", await version("remote conflict"));
  const beforeConflictWrites = writes;
  result = await sync.once(); assert.equal(result.status, "conflict"); assert.equal(writes, beforeConflictWrites);
  const conflict = allRecords(state, "conflict")[0].record;
  assert.equal(snapshots.read(conflict.base).toString(), "successor");
  assert.equal(snapshots.read(conflict.local).toString(), "local conflict");
  assert.equal(snapshots.read(conflict.remote).toString(), "remote conflict");
  state.close(); owner.close(); open();
  result = await sync.once(); assert.equal(result.conflicts, 1); assert.equal(writes, beforeConflictWrites);
  console.log("reconcile.test.mjs: bidirectional cycles, restart, history, rename, concurrent edits and retained conflicts passed");
}
finally { state?.close(); owner?.close(); await rm(root, { recursive: true, force: true }); }
