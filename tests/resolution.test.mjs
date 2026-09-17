import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: api } = await loadBundle("tests/support/headless-entry.ts");
const { OwnedDirectories, StateStore, IdentityBinding, SnapshotStore, DurableOutbox, SyncCoordinator, sameVersion, fullDigest, allRecords } = api;
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/resolution-"));
let owner, state, identity, snapshots, outbox, sync, readHook, uploadHook, writes = 0;
const files = new Map(), deleted = new Set();
const vault = path.join(root, "vault"), directory = path.join(root, "state");
await mkdir(vault, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
const subject = { serviceId: null, subjectId: "fixture", vaultId: null, vaultName: "synthetic" };
const peer = {
  async authenticate() { identity.verify(subject); },
  async inventory() { await this.authenticate(); return { files: new Map(files), deleted: new Set(deleted), folders: new Set(), deletedFolders: new Set(), noteTime: 1, fileTime: 1 }; },
  async read(file) { if (readHook) await readHook(); return files.get(file) ?? null; },
  async upload(id) {
    await this.authenticate(); const op = state.get("operation", id).record, current = files.get(op.path) ?? null;
    const recovered = sameVersion(current, op.desired);
    if (!recovered && !sameVersion(current, op.expectedRemote)) throw Object.assign(new Error(), { code: "remote-version-changed" });
    const sent = await outbox.sent(id, "fixture-generation");
    if (!recovered) { if (op.desired) files.set(op.path, op.desired); else { files.delete(op.path); deleted.add(op.path); } writes++; }
    if (uploadHook) await uploadHook();
    await outbox.confirm(id, sent.sessionId, sent.context, op.desired); identity.invalidate();
  },
};
function open(create = false) {
  owner = OwnedDirectories.acquire(vault, directory); state = new StateStore(path.join(directory, "state.db"), { create });
  identity = new IdentityBinding(owner, state, "https://example.invalid", "synthetic"); snapshots = new SnapshotStore(owner.state); outbox = new DurableOutbox(owner, state, identity);
  sync = new SyncCoordinator(owner, state, identity, peer, "controlled");
}
let sequence = 0;
const expect = value => value ? { sha256: value.sha256, size: value.size } : null;
async function edit(file, value) {
  const before = owner.vault.readOptional(file), bytes = value === null ? null : Buffer.from(value);
  return sync.requests.submit({ requestId: `edit-${++sequence}`, operation: bytes === null ? "delete" : before ? "modify" : "create", path: file,
    contentKind: file.endsWith(".md") ? "note" : "file", expected: before ? { sha256: fullDigest(before), size: before.length } : null, ...(bytes ? { content: bytes } : {}) });
}
async function conflict(file, local = "local", remote = "remote") {
  await peer.authenticate(); await edit(file, local);
  if (remote !== null) files.set(file, await snapshots.put(Buffer.from(remote), file.endsWith(".md") ? "note" : "file")); else { files.delete(file); deleted.add(file); }
  await sync.once();
  return allRecords(state, "conflict").find(v => v.record.path === file && v.record.status === "open").record;
}
function decision(c, action, content = "merged", id = `decision-${++sequence}`) {
  return { schemaVersion: 1, decisionId: id, conflictId: c.id, action, expectedLocal: expect(c.local), expectedRemote: expect(c.remote),
    ...(action === "merge" ? { contentBase64: Buffer.from(content).toString("base64") } : {}) };
}
try {
  open(true);
  for (const action of ["merge", "keep-local", "keep-remote", "delete"]) {
    const file = `${action}.md`, c = await conflict(file), d = decision(c, action);
    const resolved = await sync.resolve(d); assert.equal(resolved.status, "resolved"); assert.equal(state.get("conflict", c.id).record.status, "resolved");
    const text = action === "merge" ? "merged" : action === "keep-local" ? "local" : action === "keep-remote" ? "remote" : null;
    assert.equal(owner.vault.readOptional(file)?.toString() ?? null, text); assert.equal(files.has(file) ? snapshots.read(files.get(file)).toString() : null, text);
    const count = writes; assert.deepEqual(await sync.resolve({ ...d }), resolved); assert.equal(writes, count);
    await assert.rejects(sync.resolve(decision(c, action === "keep-remote" ? "keep-local" : "keep-remote", "ignored", d.decisionId)), { code: "decision-id-reused" });
    assert.equal((await sync.once()).status, "synchronized");
  }
  const binary = await conflict("binary.bin", Buffer.from([0, 255, 1]), Buffer.from([0, 255, 2]));
  assert.equal((await sync.resolve(decision(binary, "keep-remote"))).status, "resolved");
  assert.deepEqual(owner.vault.read("binary.bin"), Buffer.from([0, 255, 2]));
  for (const localDeletion of [true, false]) {
    const file = `deletion-${localDeletion}.md`;
    await edit(file, "base"); await sync.once();
    await edit(file, localDeletion ? null : "local edit");
    if (localDeletion) files.set(file, await snapshots.put(Buffer.from("remote edit"), "note")); else { files.delete(file); deleted.add(file); }
    await sync.once();
    const current = allRecords(state, "conflict").find(v => v.record.path === file && v.record.status === "open").record;
    assert.equal(current.baseStatus, "present");
    assert.equal((await sync.resolve(decision(current, localDeletion ? "keep-remote" : "delete"))).status, "resolved");
    assert.equal(owner.vault.readOptional(file)?.toString() ?? null, localDeletion ? "remote edit" : null);
  }
  // A full digest catches a changed version even with identical upstream hash.
  let c = await conflict("stale.md", "local", "Aa"), d = decision(c, "merge");
  const changed = await snapshots.put(Buffer.from("BB"), "note"); assert.equal(changed.protocolHash, c.remote.protocolHash); files.set("stale.md", changed);
  let result = await sync.resolve(d); assert.equal(result.status, "stale"); assert.ok(result.nextConflictId); assert.equal(owner.vault.read("stale.md").toString(), "local");
  assert.equal(snapshots.read(sync.resolver.detail(result.nextConflictId).remote).toString(), "BB");
  assert.deepEqual(await sync.resolve(d), result);
  c = sync.resolver.detail(result.nextConflictId); await edit("stale.md", "new local");
  result = await sync.resolve(decision(c, "keep-remote")); assert.equal(result.status, "stale"); assert.equal(owner.vault.read("stale.md").toString(), "new local");
  await sync.resolve(decision(sync.resolver.detail(result.nextConflictId), "keep-local"));
  c = await conflict("converged.md"); d = decision(c, "merge");
  await edit("converged.md", "remote");
  result = await sync.resolve(d); assert.equal(result.status, "stale");
  const equal = sync.resolver.detail(result.nextConflictId); assert.equal(equal.reason, "versions-changed"); assert.equal(equal.local.sha256, equal.remote.sha256);
  await sync.resolve(decision(equal, "keep-remote"));
  // An upload that reached the service but lost its confirmation keeps the
  // conflict open until a restarted owner verifies that exact immutable version.
  c = await conflict("ack.md"); d = decision(c, "merge");
  uploadHook = async () => { uploadHook = null; throw Object.assign(new Error(), { code: "upload-timeout" }); };
  await assert.rejects(sync.resolve(d), { code: "upload-timeout" }); assert.equal(state.get("conflict", c.id).record.status, "open");
  assert.equal(state.get("decision", d.decisionId).record.status, "applied");
  const sentWrites = writes; state.close(); owner.close(); open();
  assert.equal((await sync.once()).status, "synchronized"); assert.equal(writes, sentWrites);
  assert.equal((await sync.resolve(d)).status, "resolved");
  // Crash after the local intent commit, before publication: generic recovery
  // must not apply a resolution without a fresh remote version validation.
  for (const published of [false, true]) {
    const file = `crash-${published}.md`; c = await conflict(file); d = decision(c, "merge");
    const commit = state.commit.bind(state);
    state.commit = mutations => {
      if (mutations.some(m => m.record?.kind === "local-request" && m.record.decisionId && m.record.status === (published ? "applied" : "prepared"))) {
        if (!published) commit(mutations);
        throw new Error("injected-crash");
      }
      return commit(mutations);
    };
    await assert.rejects(sync.resolve(d)); state.close(); owner.close(); open();
    if (!published) files.set(file, await snapshots.put(Buffer.from("changed after crash"), "note"));
    await sync.requests.recover(); assert.equal(owner.vault.read(file).toString(), published ? "merged" : "local");
    result = await sync.resolve(d);
    assert.equal(result.status, published ? "resolved" : "stale");
    if (!published) { assert.equal(owner.vault.read(file).toString(), "local"); await sync.resolve(decision(sync.resolver.detail(result.nextConflictId), "keep-local")); }
  }
  // A Bot request arriving after remote revalidation waits on the same mutex.
  c = await conflict("barrier.md"); d = decision(c, "merge");
  let bot, finished = false;
  readHook = async () => {
    readHook = null;
    bot = edit("barrier.md", "bot").then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(finished, false);
  };
  assert.equal((await sync.resolve(d)).status, "resolved"); assert.equal((await bot).status, "stale"); assert.equal(owner.vault.read("barrier.md").toString(), "merged");
  assert.equal((await sync.once()).status, "synchronized");
  const detail = sync.resolver.detail(c.id), first = sync.resolver.snapshot(c.id, "local", 0, 2), second = sync.resolver.snapshot(c.id, "local", first.next, 1024);
  assert.equal(Buffer.concat([Buffer.from(first.contentBase64, "base64"), Buffer.from(second.contentBase64, "base64")]).toString(), snapshots.read(detail.local).toString());
  assert.throws(() => sync.resolver.snapshot(c.id, "../outside", 0, 1024), { code: "conflict-read-limit" });
  await assert.rejects(sync.resolve({ ...decision(c, "merge"), path: "../outside" }), { code: "invalid-decision" });
  console.log("resolution.test.mjs: four decisions, binary content, stale versions, idempotency, lost Ack, guarded crash recovery and Bot serialization passed");
} finally { state?.close(); owner?.close(); await rm(root, { recursive: true, force: true }); }
