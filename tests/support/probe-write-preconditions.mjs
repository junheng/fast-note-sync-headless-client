import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { loadBundle } from "./load-bundle.mjs";
import { hashContent } from "../../src/lib/utils/protocol_hash.ts";

// Called only by the probe that owns the fresh ephemeral server. These are
// destructive synthetic characterization cases, never runtime sync policy.
export async function probeWritePreconditions({ endpoint, token, headers, actions, onStage, onObserved }) {
  const { exports: { connectHeadless } } = await loadBundle("src/headless/connection.ts");
  const results = [];
  for (const protobufEnabled of [false, true]) {
    const messages = [];
    const connection = await connectHeadless({ endpoint, token, protobufEnabled, onMessage: (action, data) => {
      messages.push({ action, ...data });
      onObserved({ action, code: data.code, contextPresent: Boolean(data.context) });
    } });
    let sequence = 0;
    const variant = protobufEnabled ? "protobuf" : "json";
    const target = path => ({ vault: "synthetic", path, pathHash: hashContent(path) });
    async function response(predicate) {
      for (let count = 0; count < 250; count++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0];
        await pause(20);
      }
      throw new Error("Synthetic response deadline exceeded");
    }
    async function send(action, payload, unscopedErrorCode) {
      const context = `precondition-${variant}-${++sequence}`;
      connection.client.Send(action, { ...payload, context });
      // Only this serialized probe can attribute an unscoped error to its sole
      // request. Runtime pipelined work must not make that assumption.
      return await response(message => message.context === context || (unscopedErrorCode !== undefined && !message.context && message.code === unscopedErrorCode));
    }
    async function read(path) {
      const res = await fetch(`${endpoint}/api/note?${new URLSearchParams(target(path))}`, { headers: headers(), signal: AbortSignal.timeout(5000) });
      assert.ok(res.ok, "Synthetic read HTTP request failed");
      const value = await res.json();
      onObserved({ action: "readback", code: value.code, dataFields: Object.keys(value.data ?? {}) });
      return value;
    }
    async function modify(path, content, baseHash = "") {
      const reply = await send(actions.NoteReceiveModify, { ...target(path), content, contentHash: hashContent(content), baseHash, ctime: 1700000000000, mtime: 1700000000000 + sequence * 1000 });
      return reply;
    }
    function success(reply, action) {
      assert.ok(reply.code > 0 && reply.code < 300 && reply.action === action, "Synthetic operation did not return its expected Ack");
    }
    try {
      onStage(`${variant}-client-info`);
      connection.client.Send(actions.ClientReceiveInfo, { name: "synthetic", version: "2.4.0", type: "ObsidianPlugin", isDesktop: true, isLinux: true, protobuf: protobufEnabled, offlineSyncStrategy: "manualMerge" });
      const info = await response(message => message.action === actions.ClientInfo);
      assert.ok(info.code > 0 && info.code < 300, "ClientInfo negotiation failed");
      const deletedPath = `delete-${variant}.md`;
      onStage(`${variant}-seed-note`);
      success(await modify(deletedPath, "synthetic-original"), actions.NoteModifyAck);
      onStage(`${variant}-read-note`);
      const readBeforeDelete = await read(deletedPath);
      assert.ok(readBeforeDelete.data && typeof readBeforeDelete.data.content === "string", "Readback content missing");
      assert.equal(readBeforeDelete.data.content, "synthetic-original");
      onStage(`${variant}-update-note`);
      success(await modify(deletedPath, "synthetic-new-edit", hashContent("synthetic-original")), actions.NoteModifyAck);
      assert.equal((await read(deletedPath)).data.content, "synthetic-new-edit");
      onStage(`${variant}-stale-modify`);
      const staleModify = await modify(deletedPath, "synthetic-stale-edit", hashContent("synthetic-original"));
      assert.equal(staleModify.code, 530, "manualMerge stale edit did not enter conflict");
      assert.equal((await read(deletedPath)).data.content, "synthetic-new-edit");
      // The delete decision used original content; another edit has now been
      // durably acknowledged. The inherited request has no expected version.
      onStage(`${variant}-stale-delete`);
      const deleted = await send(actions.NoteReceiveDelete, target(deletedPath));
      success(deleted, actions.NoteDeleteAck);
      const afterDelete = await read(deletedPath);
      assert.ok(afterDelete.code >= 300, "Delete race did not remove the current note from normal reads");

      const sourcePath = `source-${variant}.md`, targetPath = `target-${variant}.md`;
      onStage(`${variant}-rename-seed`);
      success(await modify(sourcePath, "synthetic-source"), actions.NoteModifyAck);
      assert.ok((await read(targetPath)).code >= 300, "Rename target must initially be absent");
      // Another writer fills the target after the first writer's preflight.
      success(await modify(targetPath, "synthetic-target-new-edit"), actions.NoteModifyAck);
      onStage(`${variant}-stale-rename`);
      const renamed = await send(actions.NoteReceiveRename, { ...target(targetPath), oldPath: sourcePath, oldPathHash: hashContent(sourcePath) }, 431);
      assert.equal(renamed.code, 431, "Occupied target should be rejected");
      assert.equal((await read(targetPath)).data.content, "synthetic-target-new-edit", "Occupied rename target was changed");
      assert.equal((await read(sourcePath)).data.content, "synthetic-source", "Rejected rename removed its source");

      onStage(`${variant}-stale-rename-source`);
      success(await modify(sourcePath, "synthetic-source-new-edit", hashContent("synthetic-source")), actions.NoteModifyAck);
      const newTarget = `empty-target-${variant}.md`;
      const sourceRename = await send(actions.NoteReceiveRename, { ...target(newTarget), oldPath: sourcePath, oldPathHash: hashContent(sourcePath) });
      success(sourceRename, actions.NoteRenameAck);
      assert.equal((await read(newTarget)).data.content, "synthetic-source-new-edit", "Renamed source readback differs");
      assert.ok((await read(sourcePath)).code >= 300, "Renamed source must leave the old path");
      results.push({ encoding: variant, staleModifyCode: staleModify.code, staleModifyPreservedNewEdit: true, deleteAck: deleted.code, deleteRemovedNewEdit: true, occupiedRenameCode: renamed.code, occupiedRenamePreservedBoth: true, occupiedRenameContextPresent: Boolean(renamed.context), changedSourceRenameAck: sourceRename.code, renamedChangedSource: true });
    } finally { connection.close(); }
  }
  return results;
}
