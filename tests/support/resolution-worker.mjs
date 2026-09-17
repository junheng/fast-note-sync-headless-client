import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "./load-bundle.mjs";
const { exports: api } = await loadBundle("tests/support/headless-entry.ts");
const input = await new Promise(resolve => process.once("message", resolve));
const owner = api.OwnedDirectories.acquire(input.vault, input.state);
const state = new api.StateStore(path.join(input.state, "state.db"), { create: input.create });
const identity = new api.IdentityBinding(owner, state, "https://example.invalid", "synthetic");
const subject = { serviceId: null, subjectId: "fixture", vaultId: null, vaultName: "synthetic" };
identity.verify(subject);
const snapshots = new api.SnapshotStore(owner.state), outbox = new api.DurableOutbox(owner, state, identity);
const requests = new api.LocalRequests(owner, state, "controlled");
const peer = {
  async authenticate() { identity.verify(subject); },
  async read() { return fs.existsSync(input.remote) ? snapshots.put(fs.readFileSync(input.remote), "note") : null; },
  async upload(id) {
    await this.authenticate(); const op = state.get("operation", id).record, current = await this.read();
    const recovered = api.sameVersion(current, op.desired);
    if (!recovered && !api.sameVersion(current, op.expectedRemote)) throw Object.assign(new Error(), { code: "remote-version-changed" });
    const sent = await outbox.sent(id, "worker-generation");
    if (!recovered) { if (op.desired) fs.writeFileSync(input.remote, snapshots.read(op.desired)); else fs.unlinkSync(input.remote); }
    await outbox.confirm(id, sent.sessionId, sent.context, op.desired); identity.invalidate();
  },
};
const conflicts = new api.ConflictStore(owner, state);
if (!state.get("conflict", "fixture-conflict")) await conflicts.capture("fixture-conflict", "note.md", fs.readFileSync(input.remote), "note", { status: "missing" });
const conflict = conflicts.get("fixture-conflict"), expected = version => version ? { sha256: version.sha256, size: version.size } : null;
const decision = { schemaVersion: 1, decisionId: "fixture-decision", conflictId: conflict.id, action: "merge", expectedLocal: expected(conflict.local), expectedRemote: expected(conflict.remote), contentBase64: Buffer.from("merged").toString("base64") };
const resolver = new api.ConflictResolver(owner, state, identity, peer, requests);
function crash() { fs.writeSync(1, "barrier\n"); process.kill(process.pid, "SIGKILL"); }
function barrier() {
  fs.writeFileSync(input.barrier, "ready");
  const wait = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + 10000;
  while (!fs.existsSync(input.release)) { if (Date.now() > deadline) throw new Error("barrier-timeout"); Atomics.wait(wait, 0, 0, 10); }
}
const write = owner.vault.write.bind(owner.vault);
owner.vault.write = (...args) => { if (input.barrier) barrier(); const result = write(...args); if (input.stage === "published") crash(); return result; };
if (input.mode === "crash") {
  const commit = state.commit.bind(state);
  state.commit = mutations => {
    commit(mutations);
    if (mutations.some(m => m.record && ({ decision: `decision-${m.record.status}`, "local-request": `local-${m.record.status}`, operation: m.record.status })[m.record.kind] === input.stage)) crash();
  };
  await resolver.submit(decision); throw new Error("crash-boundary-not-reached");
}
await requests.recover();
const control = await api.startControl(owner, api.localControlHandler(requests));
process.send({ type: "ready" });
process.on("message", async message => {
  if (message.type === "resolve") { const result = await resolver.submit(decision); process.send({ type: "resolved", result }); }
  if (message.type === "close") { await control.close(); state.close(); owner.close(); process.disconnect(); }
});
