import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: api } = await loadBundle("tests/support/headless-entry.ts");
fs.mkdirSync(".local", { recursive: true }); const root = fs.mkdtempSync(path.resolve(".local/runtime-identity-"));
const vault = path.join(root, "vault"), directory = path.join(root, "state"), database = path.join(directory, "state.db");
fs.mkdirSync(vault, { mode: 0o700 }); fs.mkdirSync(directory, { mode: 0o700 });
let uid = 1, authorized = true, token = "synthetic-token-1", upgrades = 0, remoteWrites = 0;
const server = createServer((req, res) => {
  if (req.method !== "GET") remoteWrites++;
  if (!authorized || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end("private failure body"); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ code: 1, data: req.url === "/api/user/info" ? { uid } : { list: null, pager: { page: 1, pageSize: 1, totalRows: 0 } } }));
});
server.on("upgrade", (_req, socket) => { upgrades++; socket.destroy(); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const config = { endpoint, token, vault: "synthetic", vaultDirectory: vault, stateDirectory: directory, writingMode: "controlled" };
let owner, state;
try {
  owner = api.OwnedDirectories.acquire(vault, directory); state = new api.StateStore(database, { create: true });
  const identity = new api.IdentityBinding(owner, state, endpoint, "synthetic"); identity.verify({ serviceId: null, subjectId: "1", vaultId: null, vaultName: "synthetic" });
  const snapshots = new api.SnapshotStore(owner.state), before = await snapshots.put(Buffer.from("preserved"), "note");
  owner.vault.write("note.md", Buffer.from("preserved"), "create");
  await new api.DurableOutbox(owner, state, identity).prepare("note.md", null, before, "delete");
  state.close(); state = undefined; owner.close(); owner = undefined;
  const original = fs.readFileSync(database);
  const unchanged = () => { assert.deepEqual(fs.readFileSync(database), original); assert.equal(fs.readFileSync(path.join(vault, "note.md"), "utf8"), "preserved"); assert.equal(upgrades, 0); assert.equal(remoteWrites, 0); };
  uid = 2; await assert.rejects(api.openSyncRuntime(config), { code: "state-identity-mismatch" }); unchanged();
  uid = null; await assert.rejects(api.openSyncRuntime(config), { code: "state-identity-unverified" }); unchanged();
  uid = 1; authorized = false; await assert.rejects(api.openSyncRuntime(config), { code: "remote-read-failed" }); unchanged(); authorized = true;
  for (const extra of [{ endpoint: endpoint + "/replacement" }, { vault: "different" }]) { await assert.rejects(api.openSyncRuntime({ ...config, ...extra }), { code: "state-identity-mismatch" }); unchanged(); }
  const other = path.join(root, "other"); fs.mkdirSync(other, { mode: 0o700 });
  await assert.rejects(api.openSyncRuntime({ ...config, vaultDirectory: other }), { code: "state-identity-mismatch" }); unchanged(); assert.deepEqual(fs.readdirSync(other), []);
  fs.renameSync(vault, path.join(root, "previous")); fs.mkdirSync(vault, { mode: 0o700 });
  await assert.rejects(api.openSyncRuntime(config), { code: "state-identity-mismatch" }); assert.deepEqual(fs.readdirSync(vault), []); assert.deepEqual(fs.readFileSync(database), original);
  fs.rmdirSync(vault); fs.renameSync(path.join(root, "previous"), vault);
  token = "synthetic-rotated-token";
  const runtime = await api.openSyncRuntime({ ...config, token }); assert.equal(runtime.sync.status().pending, 1); await runtime.close(); unchanged();
  assert.equal(fs.readFileSync(database).includes(Buffer.from(token)), false);
  console.log("runtime-identity.test.mjs: startup rejects changed identity before replay, preserves pending/data, and permits same-subject token rotation");
} finally { state?.close(); owner?.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
