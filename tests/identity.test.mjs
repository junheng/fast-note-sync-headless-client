import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";

const { exports: { IdentityBinding, canonicalEndpoint } } = await loadBundle("src/headless/identity.ts");
const { exports: { OwnedDirectories } } = await loadBundle("src/headless/filesystem.ts");
const { exports: { StateStore } } = await loadBundle("src/headless/state_store.ts");
await mkdir(".local", { recursive: true });
const root = await mkdtemp(path.resolve(".local/identity-"));
const vault = path.join(root, "vault"), stateDirectory = path.join(root, "state"), database = path.join(stateDirectory, "state.db");
const remote = { serviceId: "service-1", subjectId: "subject-1", vaultId: "vault-1", vaultName: "synthetic" };
const endpoint = "https://example.invalid/sync";
const expect = (fn, code) => assert.throws(fn, error => error.code === code && error.message === code);
let owner, state;
try {
  await mkdir(vault, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  owner = OwnedDirectories.acquire(vault, stateDirectory);
  state = new StateStore(database, { create: true });
  assert.equal(canonicalEndpoint("https://EXAMPLE.invalid:443/sync/"), endpoint);
  for (const address of ["file:///tmp", "https://user:secret@example.invalid", "https://example.invalid/?token=secret"]) expect(() => canonicalEndpoint(address), "invalid-config");
  let guard = new IdentityBinding(owner, state, endpoint, "synthetic");
  expect(() => guard.assertVerified(), "state-identity-unverified");
  expect(() => guard.verify({ ...remote, serviceId: "" }), "state-identity-unverified");
  assert.equal(state.get("binding", "identity"), null);
  guard.verify(remote); guard.assertVerified();
  const binding = state.get("binding", "identity");
  assert.equal(binding.revision, 1);
  // A pending deletion must remain untouched across all mismatch cases.
  const operation = { formatVersion: 1, kind: "operation", id: "pending-delete", path: "synthetic.md", action: "delete", targetPath: null,
    status: "pending", base: null, desired: null, expectedRemote: null, sessionId: null, context: "delete-context" };
  state.commit([{ type: "put", expectedRevision: null, record: operation }]);
  const before = await readFile(database);
  for (const field of ["serviceId", "subjectId", "vaultId"]) {
    expect(() => guard.verify({ ...remote, [field]: "replacement" }), "state-identity-mismatch");
    expect(() => guard.assertVerified(), "state-identity-unverified");
    assert.deepEqual(await readFile(database), before);
  }
  expect(() => new IdentityBinding(owner, state, "https://different.invalid", "synthetic"), "state-identity-mismatch");
  expect(() => new IdentityBinding(owner, state, endpoint, "different"), "state-identity-mismatch");
  guard.verify(remote); guard.invalidate();
  expect(() => guard.assertVerified(), "state-identity-unverified");
  // Credentials and software versions are deliberately not identity components.
  guard.verify({ ...remote }); guard.assertVerified();
  assert.deepEqual(state.get("binding", "identity"), binding);
  state.close(); owner.close();
  owner = OwnedDirectories.acquire(vault, stateDirectory); state = new StateStore(database);
  guard = new IdentityBinding(owner, state, endpoint, "synthetic");
  expect(() => guard.assertVerified(), "state-identity-unverified");
  guard.verify(remote); guard.assertVerified();
  assert.deepEqual(state.get("operation", "pending-delete").record, operation);
  state.close(); state = null; owner.close(); owner = null;
  await rename(vault, path.join(root, "previous-vault")); await mkdir(vault, { mode: 0o700 });
  owner = OwnedDirectories.acquire(vault, stateDirectory); state = new StateStore(database);
  expect(() => new IdentityBinding(owner, state, endpoint, "synthetic"), "state-identity-mismatch");
  assert.deepEqual(await readFile(database), before);
  state.close(); state = null; owner.close(); owner = null;

  const unbound = path.join(root, "unbound"); await mkdir(unbound, { mode: 0o700 });
  owner = OwnedDirectories.acquire(vault, unbound); state = new StateStore(path.join(unbound, "state.db"), { create: true });
  state.commit([{ type: "put", expectedRevision: null, record: operation }]);
  guard = new IdentityBinding(owner, state, endpoint, "synthetic");
  expect(() => guard.verify(remote), "state-identity-unverified");
  assert.equal(state.get("binding", "identity"), null);
  state.close(); state = null; owner.close(); owner = null;
  const limited = path.join(root, "limited"); await mkdir(limited, { mode: 0o700 });
  owner = OwnedDirectories.acquire(vault, limited); state = new StateStore(path.join(limited, "state.db"), { create: true });
  guard = new IdentityBinding(owner, state, endpoint, "synthetic");
  const official = { ...remote, serviceId: null, vaultId: null };
  guard.verify(official); guard.assertVerified(); guard.invalidate(); guard.verify({ ...official });
  assert.equal(state.get("binding", "identity").record.serviceId, null, "Missing upstream identity is explicit, not fabricated");
  expect(() => guard.verify({ ...official, subjectId: "replacement" }), "state-identity-mismatch");
  console.log("identity.test.mjs: identity changes, reconnect, restart and unbound pending rejection passed");
} finally { state?.close(); owner?.close(); await rm(root, { recursive: true, force: true }); }
