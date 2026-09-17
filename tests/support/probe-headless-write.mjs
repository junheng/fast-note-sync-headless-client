import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { loadBundle } from "./load-bundle.mjs";

// Used only by the launcher that owns a fresh fixed-version local container.
// No invented server capabilities, alternate protocol or production credentials.
export async function probeHeadlessWrite({ endpoint, token, request, onStage }) {
  const { exports: api } = await loadBundle("tests/support/headless-entry.ts");
  const { OwnedDirectories, StateStore, SnapshotStore, IdentityBinding, DurableOutbox, uploadOperation, pullCollection, NotePull, FilePull } = api;
  await mkdir(".local", { recursive: true });
  const root = await mkdtemp(path.resolve(".local/headless-write-"));
  const results = [];
  try {
    for (const protobufEnabled of [false, true]) {
      const variant = protobufEnabled ? "protobuf" : "json", directory = path.join(root, variant);
      const vault = path.join(directory, "vault"), stateDirectory = path.join(directory, "state");
      await mkdir(vault, { recursive: true, mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
      let owner, state, identity, outbox, snapshots;
      async function verifyIdentity() {
        const subject = await request("/api/user/info");
        assert.ok(Number.isSafeInteger(subject.data.uid) && subject.data.uid > 0);
        return { serviceId: null, subjectId: String(subject.data.uid), vaultId: null, vaultName: "synthetic" };
      }
      async function open(create) {
        owner = OwnedDirectories.acquire(vault, stateDirectory); state = new StateStore(path.join(stateDirectory, "state.db"), { create });
        identity = new IdentityBinding(owner, state, endpoint, "synthetic"); identity.verify(await verifyIdentity());
        outbox = new DurableOutbox(owner, state, identity); snapshots = new SnapshotStore(owner.state);
      }
      await open(true);
      try {
        async function readBack(file, signal) {
          const note = file.endsWith(".md"); let found = null;
          const options = { endpoint, token, vault: "synthetic", protobufEnabled, signal, onAbsent: async () => true };
          await pullCollection(options, note ? "notes" : "files", common => note
            ? new NotePull({ ...common, onNote: async item => { if (item.path === file) found = await snapshots.put(Buffer.from(item.content), "note"); return "unchanged"; } })
            : new FilePull({ ...common, directory: owner.state, onFile: async (item, bytes) => { if (item.path === file) found = await snapshots.put(bytes, "file"); return "unchanged"; } }));
          return found;
        }
        async function mutate(file, desired, before, action, target = null) {
          identity.verify(await verifyIdentity());
          const op = await outbox.prepare(file, desired, before, action, target);
          const receipt = await uploadOperation(owner, state, identity, op.id, { endpoint, token, vault: "synthetic", protobufEnabled, verifyIdentity, readBack });
          assert.equal(receipt.status, "confirmed");
          assert.equal(state.get("operation", op.id).record.status, "acknowledged");
          return receipt;
        }
        for (const kind of ["note", "file"]) {
          const ext = kind === "note" ? "md" : "bin", source = `write-${variant}.${ext}`, target = `nested/moved-${variant}.${ext}`;
          const a = await snapshots.put(kind === "note" ? Buffer.from("synthetic 中文 😀 A\n") : Buffer.from([0, 255, 128, 1, 2]), kind);
          const b = await snapshots.put(kind === "note" ? Buffer.from("synthetic 中文 😀 B\n") : Buffer.from([0, 255, 128, 2, 3, 4]), kind);
          onStage(`${variant}-${kind}-create`); await mutate(source, a, null, "create");
          assert.equal((await readBack(source)).sha256, a.sha256);
          onStage(`${variant}-${kind}-modify`); await mutate(source, b, a, "modify");
          assert.equal((await readBack(source)).sha256, b.sha256);
          onStage(`${variant}-${kind}-rename`); await mutate(source, b, b, "rename", target);
          assert.equal(await readBack(source), null); assert.equal((await readBack(target)).sha256, b.sha256);
          onStage(`${variant}-${kind}-restart`); state.close(); owner.close(); await open(false);
          assert.equal(outbox.baseline(target).version.sha256, b.sha256);
          onStage(`${variant}-${kind}-delete`); await mutate(target, null, b, "delete");
          assert.equal(await readBack(target), null); assert.equal(outbox.baseline(target).version, null);
          results.push({ encoding: variant, kind, create: true, modify: true, rename: true, delete: true, fullReadback: true, restart: true, upstreamCodeModified: false });
        }
      } finally { state?.close(); owner?.close(); }
    }
    return results;
  } finally { await rm(root, { recursive: true, force: true }); }
}
