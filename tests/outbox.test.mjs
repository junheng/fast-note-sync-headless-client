import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";

const { exports: { OwnedDirectories, StateStore, IdentityBinding, SnapshotStore, DurableOutbox } } = await loadBundle("tests/support/headless-entry.ts");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/outbox-"));
const vault = path.join(root, "vault"), stateDirectory = path.join(root, "state"), database = path.join(stateDirectory, "state.db");
const remote = { serviceId: "fixture-service", subjectId: "fixture-user", vaultId: "fixture-vault", vaultName: "fixture" };
let owner, state;
const rejection = (fn, code) => assert.rejects(fn, error => error.code === code && error.message === code);
function bind() { const identity = new IdentityBinding(owner, state, "https://example.invalid", "fixture"); identity.verify(remote); return identity; }
try {
  await mkdir(vault, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  owner = OwnedDirectories.acquire(vault, stateDirectory); state = new StateStore(database, { create: true });
  let identity = bind(), outbox = new DurableOutbox(owner, state, identity), snapshots = new SnapshotStore(owner.state);
  const a = await snapshots.put(Buffer.from("version A"), "note"), b = await snapshots.put(Buffer.from("version B"), "note");
  await rejection(() => outbox.prepare(".obsidian/config.json", a, null), "invalid-operation");
  await rejection(() => outbox.prepare("source.md", b, a, "rename", "target.md"), "invalid-operation");
  await rejection(() => outbox.prepare("source.md", a, a, "rename", "target.bin"), "invalid-operation");
  const first = await outbox.prepare("synthetic.md", a, null);
  assert.deepEqual(await outbox.prepare("synthetic.md", a, null), first);
  const sentA = await outbox.sent(first.id, "connection-1");
  const next = await outbox.prepare("synthetic.md", b, a);
  await rejection(() => outbox.sent(next.id, "connection-1"), "operation-order");
  assert.equal(await outbox.confirm(first.id, "wrong-generation", sentA.context, a), false);
  assert.equal(await outbox.confirm(first.id, "connection-1", "unknown-context", a), false);
  await rejection(() => outbox.confirm(first.id, "connection-1", sentA.context, b), "operation-unconfirmed");
  assert.equal(outbox.baseline("synthetic.md"), null);
  owner.vault.write("synthetic.md", Buffer.from("version B"), "create");
  assert.equal(await outbox.confirm(first.id, "connection-1", sentA.context, a), true);
  assert.equal(outbox.baseline("synthetic.md").version.sha256, a.sha256);
  assert.equal(state.get("operation", next.id).record.status, "pending");
  const sentB = await outbox.sent(next.id, "connection-1");
  assert.equal(await outbox.confirm(first.id, "connection-1", sentA.context, a), false, "Duplicate old Ack cannot revert progress");
  state.close(); owner.close();
  owner = OwnedDirectories.acquire(vault, stateDirectory); state = new StateStore(database);
  identity = bind(); outbox = new DurableOutbox(owner, state, identity); snapshots = new SnapshotStore(owner.state);
  assert.equal(state.get("operation", next.id).record.status, "sent");
  const retried = await outbox.sent(next.id, "connection-2");
  assert.notEqual(retried.context, sentB.context);
  assert.equal(await outbox.confirm(next.id, "connection-1", sentB.context, b), false);
  assert.equal(await outbox.confirm(next.id, "connection-2", retried.context, b), true);
  assert.equal(outbox.baseline("synthetic.md").version.sha256, b.sha256);
  assert.equal(owner.vault.read("synthetic.md").toString(), "version B");

  // Actual rollback-journal creation failure: no send may follow a failed
  // intent/sent transition, and prior confirmed baseline must survive restart.
  assert.notEqual(process.getuid(), 0);
  await chmod(stateDirectory, 0o500);
  let networkWrites = 0;
  try {
    await rejection(async () => { await outbox.prepare("another.md", a, null); networkWrites++; }, "state-write-failed");
    assert.equal(networkWrites, 0);
  } finally { await chmod(stateDirectory, 0o700); }
  const last = await outbox.prepare("another.md", a, null);
  await chmod(stateDirectory, 0o500);
  try {
    await rejection(async () => { await outbox.sent(last.id, "connection-2"); networkWrites++; }, "state-write-failed");
    assert.equal(networkWrites, 0);
    assert.equal(state.get("operation", last.id).record.status, "pending");
  } finally { await chmod(stateDirectory, 0o700); }
  const move = await outbox.prepare("source.md", a, a, "rename", "target.md");
  const targetEdit = await outbox.prepare("target.md", b, a);
  await rejection(() => outbox.sent(targetEdit.id, "connection-2"), "operation-order");
  const sentMove = await outbox.sent(move.id, "connection-2");
  await rejection(() => outbox.confirm(move.id, "connection-2", sentMove.context, a), "operation-unconfirmed");
  await rejection(() => outbox.confirm(move.id, "connection-2", sentMove.context, a, a), "operation-unconfirmed");
  assert.equal(outbox.baseline("source.md"), null, "Target readback alone cannot prove source removal");
  assert.equal(await outbox.confirm(move.id, "connection-2", sentMove.context, a, null), true);
  assert.equal(outbox.baseline("source.md").version, null);
  assert.equal(outbox.baseline("target.md").version.sha256, a.sha256);
  identity.invalidate();
  await rejection(() => outbox.sent(last.id, "connection-3"), "state-identity-unverified");
  assert.equal(outbox.baseline("synthetic.md").version.sha256, b.sha256);
  console.log("outbox.test.mjs: immutable versions, successor edits, reordered Ack, restart and real persistence failures passed");
} finally { state?.close(); owner?.close(); await rm(root, { recursive: true, force: true }); }
