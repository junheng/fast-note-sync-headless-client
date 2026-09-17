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
const files = new Map(), deleted = new Set(), folders = new Set(), deletedFolders = new Set(); let writes = 0;
const subject = { serviceId: null, subjectId: "fixture", vaultId: null, vaultName: "synthetic" };
const peer = {
  async authenticate() { identity.verify(subject); },
  async inventory(_signal, folderChanges) {
    await this.authenticate();
    // The service applies the declared folder inventory before answering.
    for (const path of folderChanges?.folders ?? []) folders.add(path);
    for (const path of folderChanges?.delFolders ?? []) { folders.delete(path); deletedFolders.add(path); }
    return { files: new Map(files), deleted: new Set(deleted), folders: new Set(folders), deletedFolders: new Set(deletedFolders), noteTime: 1, fileTime: 1 };
  },
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
  result = await sync.once(); assert.equal(result.status, "synchronized", JSON.stringify(result)); assert.equal(owner.vault.readOptional("nested/remote.md"), null);
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
  // Clear the retained conflict so the rename scenarios below start clean.
  assert.equal((await sync.resolve({ schemaVersion: 1, decisionId: "clear-retained", conflictId: conflict.id, action: "keep-remote",
    expectedLocal: { sha256: conflict.local.sha256, size: conflict.local.size },
    expectedRemote: { sha256: conflict.remote.sha256, size: conflict.remote.size } })).status, "resolved");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  // Unreliable offline recognition of a rename publishes the new path before
  // the old one is removed; absence alone never authorizes the deletion.
  await edit("offline-a.md", "offline rename", "offline-rename-base");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  const uploads = [];
  const peerUpload = peer.upload;
  peer.upload = async function (id, signal) {
    const operation = state.get("operation", id).record;
    uploads.push(operation.targetPath ? `rename:${operation.path}` : operation.desired ? `put:${operation.path}` : `delete:${operation.path}`);
    return await peerUpload.call(this, id, signal);
  };
  owner.vault.createDirectories("offline-moved");
  owner.vault.move("offline-a.md", "offline-moved/offline-b.md");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  assert.deepEqual(uploads, ["put:offline-moved/offline-b.md", "delete:offline-a.md"]);
  assert.equal(files.has("offline-a.md"), false);
  assert.equal(snapshots.read(files.get("offline-moved/offline-b.md")).toString(), "offline rename");
  peer.upload = peerUpload;
  // A remote case-only rename cannot be represented as two coexisting names
  // locally. The authoritative removal and the verified target must both land,
  // and later cycles must not fail on the retired name.
  await edit("nested/case.md", "case synthetic", "case-base");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  assert.ok(files.has("nested/case.md"));
  files.set("nested/Case.md", files.get("nested/case.md"));
  files.delete("nested/case.md"); deleted.add("nested/case.md");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  assert.equal(owner.vault.read("nested/Case.md").toString(), "case synthetic");
  assert.equal(owner.vault.readOptional("nested/case.md"), null);
  assert.equal(owner.vault.fileIdentity("nested/case.md", "nested/Case.md"), null);
  const afterCaseRename = writes;
  result = await sync.once(); assert.equal(result.status, "synchronized"); assert.equal(writes, afterCaseRename);
  assert.equal(owner.vault.read("nested/Case.md").toString(), "case synthetic");
  // A remote directory move arrives as one path change per file; missing target
  // parents are created and each path keeps its own version check.
  await edit("folder/one.md", "one", "folder-one");
  await edit("folder/two.md", "two", "folder-two");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  for (const name of ["one.md", "two.md"]) {
    files.set(`moved-folder/${name}`, files.get(`folder/${name}`));
    files.delete(`folder/${name}`); deleted.add(`folder/${name}`);
  }
  result = await sync.once(); assert.equal(result.status, "synchronized");
  assert.equal(owner.vault.read("moved-folder/one.md").toString(), "one");
  assert.equal(owner.vault.read("moved-folder/two.md").toString(), "two");
  assert.equal(owner.vault.readOptional("folder/one.md"), null);
  assert.equal(owner.vault.readOptional("folder/two.md"), null);
  // Empty directories travel over the official folder channel: a local
  // creation is declared, echoed by the service and confirmed next cycle.
  owner.vault.createDirectories("empty-local/nested-empty");
  result = await sync.once(); assert.equal(result.status, "synchronized", JSON.stringify(result));
  assert.ok(folders.has("empty-local") && folders.has("empty-local/nested-empty"));
  // A folder created on another client lands locally as an empty directory.
  folders.add("remote-empty");
  result = await sync.once(); assert.equal(result.status, "synchronized", JSON.stringify(result));
  assert.ok(owner.vault.hasDirectory("remote-empty"));
  // Local removal is declared with the previous complete scan as evidence.
  owner.vault.removeDirectory("empty-local/nested-empty");
  owner.vault.removeDirectory("empty-local");
  result = await sync.once(); assert.equal(result.status, "synchronized", JSON.stringify(result));
  assert.equal(folders.has("empty-local"), false); assert.equal(folders.has("empty-local/nested-empty"), false);
  assert.ok(deletedFolders.has("empty-local"));
  // A server-side folder removal is only followed while the directory is empty.
  owner.vault.createDirectories("blocked-folder");
  await edit("blocked-folder/keep.md", "keep", "blocked-folder-keep");
  result = await sync.once(); assert.equal(result.status, "synchronized", JSON.stringify(result));
  folders.delete("blocked-folder"); deletedFolders.add("blocked-folder");
  result = await sync.once(); assert.equal(result.status, "incomplete", JSON.stringify(result));
  assert.equal(result.foldersBlocked, 1); assert.ok(owner.vault.hasDirectory("blocked-folder"));
  await edit("blocked-folder/keep.md", null, "blocked-folder-delete");
  result = await sync.once(); assert.equal(result.status, "synchronized", JSON.stringify(result));
  assert.equal(owner.vault.hasDirectory("blocked-folder"), false);
  // A local rename against a concurrent remote modification keeps the remote
  // version and publishes the moved bytes instead of overwriting either side.
  await edit("rename-source.md", "rename base", "rename-vs-modify-base");
  result = await sync.once(); assert.equal(result.status, "synchronized");
  const renameVersion = files.get("rename-source.md");
  owner.vault.createDirectories("rename-target");
  assert.equal((await sync.requests.submit({ requestId: "rename-vs-modify", operation: "rename", path: "rename-source.md",
    targetPath: "rename-target/moved.md", targetExpected: null, contentKind: "note",
    expected: { sha256: renameVersion.sha256, size: renameVersion.size } })).status, "applied");
  files.set("rename-source.md", await version("remote modified"));
  const beforeRenameUpload = writes;
  result = await sync.once(); assert.equal(result.status, "conflict");
  assert.equal(owner.vault.read("rename-target/moved.md").toString(), "rename base");
  assert.equal(snapshots.read(files.get("rename-target/moved.md")).toString(), "rename base");
  const renameConflict = allRecords(state, "conflict").map(value => value.record).find(value => value.path === "rename-source.md");
  assert.equal(renameConflict.local, null);
  assert.equal(snapshots.read(renameConflict.remote).toString(), "remote modified");
  assert.ok(writes > beforeRenameUpload);
  // A remote rename onto a path that already holds different local content is a
  // conflict; the occupied target is never deleted or overwritten first.
  await edit("collision-target.md", "local target", "collision-target-local");
  files.set("collision-target.md", await version("remote renamed"));
  deleted.add("collision-source.md");
  const beforeCollisionWrites = writes;
  result = await sync.once(); assert.equal(result.status, "conflict");
  assert.equal(owner.vault.read("collision-target.md").toString(), "local target");
  assert.equal(writes, beforeCollisionWrites);
  const collision = allRecords(state, "conflict").map(value => value.record).find(value => value.path === "collision-target.md");
  assert.equal(snapshots.read(collision.local).toString(), "local target");
  assert.equal(snapshots.read(collision.remote).toString(), "remote renamed");
  console.log("reconcile.test.mjs: bidirectional cycles, restart, history, rename, offline ordering, case rename, directory move, target collision and retained conflicts passed");
}
finally { state?.close(); owner?.close(); await rm(root, { recursive: true, force: true }); }
