import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hashContent } from "../../src/lib/utils/protocol_hash.ts";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function probeNotePull({ endpoint, token, request, onStage, onObserved }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "fns-real-pull-"));
  const fixtures = new Map([["中文/😀.md", "中文😀\r\n"], ["empty.md", ""], ["bom.md", "\ufeffBOM\n"], ["a.md", "first"], ["b.md", "second"], ["c.md", "third"], ["d.md", "fourth"]]);
  async function run(name, protobufEnabled, create = true, crashAtPage = false, crashAtApplicationCommit = false) {
    const base = path.join(root, name), vaultDirectory = path.join(base, "vault"), stateDirectory = path.join(base, "state");
    if (create) { fs.mkdirSync(vaultDirectory, { recursive: true, mode: 0o700 }); fs.mkdirSync(stateDirectory, { mode: 0o700 }); }
    const result = await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, ["tests/support/note-pull-worker.mjs"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" }, timeout: 70000 });
      let stdout = "", stderr = ""; worker.stdout.on("data", data => { stdout += data; }); worker.stderr.on("data", data => { stderr += data; });
      worker.on("error", reject); worker.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      worker.stdin.end(JSON.stringify({ endpoint, token, protobufEnabled, vaultDirectory, stateDirectory, create, crashAtApplicationCommit, crashAtPage }));
    });
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token), "Credential exposed in subprocess output");
    const receipt = JSON.parse(result.stdout); onObserved({ action: "note-pull", ...receipt });
    if (crashAtPage || crashAtApplicationCommit) { assert.equal(result.signal, "SIGKILL"); assert.equal(receipt.stage, crashAtApplicationCommit ? "before-application-commit" : "before-page-commit"); return { ...result, receipt, vaultDirectory }; }
    assert.ok(receipt.sent.every(action => ["ClientInfo", "NoteSync", "NoteSyncPageAck"].includes(action)), "Readonly worker sent a business write");
    return { ...result, receipt, vaultDirectory };
  }
  try {
    onStage("empty"); const empty = await run("empty", false); assert.equal(empty.code, 0); assert.equal(empty.receipt.received, 0);
    for (const [file, content] of fixtures) {
      onStage("seed");
      await request("/api/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vault: "synthetic", path: file, pathHash: hashContent(file), content, contentHash: hashContent(content), ctime: 1700000000000, mtime: 1700000000000 }) });
    }
    const receipts = [];
    for (const protobufEnabled of [false, true]) {
      const name = protobufEnabled ? "protobuf" : "json"; onStage(name);
      const result = await run(name, protobufEnabled);
      assert.equal(result.code, 0, "Independent Node note pull failed"); assert.equal(result.receipt.received, fixtures.size); assert.ok(result.receipt.pages > 1, "Pagination was not exercised");
      assert.equal(result.receipt.checkpointCommitted, true);
      for (const [file, content] of fixtures) assert.equal(digest(fs.readFileSync(path.join(result.vaultDirectory, file))), digest(Buffer.from(content)), "Downloaded full bytes differ");
      onStage(`${name}-repeat`); const repeat = await run(name, protobufEnabled, false);
      assert.equal(repeat.code, 0); assert.equal(repeat.receipt.applications, result.receipt.applications, "Unchanged repeat created a new file application");
      fs.writeFileSync(path.join(result.vaultDirectory, "a.md"), "synthetic-local-edit");
      onStage(`${name}-conflict`); const conflict = await run(name, protobufEnabled, false);
      assert.equal(conflict.code, 2); assert.equal(conflict.receipt.code, "note-conflict"); assert.equal(conflict.receipt.conflicts, 1);
      assert.equal(fs.readFileSync(path.join(result.vaultDirectory, "a.md"), "utf8"), "synthetic-local-edit");
      onStage(`${name}-crash`); await run(`${name}-crash`, protobufEnabled, true, true);
      onStage(`${name}-recover`); const recovered = await run(`${name}-crash`, protobufEnabled, false);
      assert.equal(recovered.code, 0); assert.equal(recovered.receipt.received, fixtures.size); assert.equal(recovered.receipt.applications, fixtures.size);
      for (const [file, content] of fixtures) assert.equal(digest(fs.readFileSync(path.join(recovered.vaultDirectory, file))), digest(Buffer.from(content)));
      onStage(`${name}-publication-crash`); await run(`${name}-publication-crash`, protobufEnabled, true, false, true);
      onStage(`${name}-publication-recover`); const published = await run(`${name}-publication-crash`, protobufEnabled, false);
      assert.equal(published.code, 0); assert.equal(published.receipt.applications, fixtures.size); assert.equal(published.receipt.pendingApplications, 0);
      receipts.push({ encoding: name, notes: fixtures.size, pages: result.receipt.pages, completeBytesMatch: true, idempotentRepeat: true, localConflictPreserved: true, crashRecovery: true, publicationRecovery: true, independentNodeProcess: true, obsidianRuntimeLoaded: false });
    }
    onStage("seed-deleted-history");
    const deleted = { vault: "synthetic", path: "deleted.md", pathHash: hashContent("deleted.md") };
    await request("/api/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...deleted, content: "deleted-fixture", contentHash: hashContent("deleted-fixture"), ctime: 1700000000000, mtime: 1700000000000 }) });
    await request(`/api/note?${new URLSearchParams(deleted)}`, { method: "DELETE" });
    const deletedFile = { vault: "synthetic", path: "deleted.bin", pathHash: hashContent("deleted.bin") };
    const form = new FormData(); for (const [key, value] of Object.entries(deletedFile)) form.set(key, value);
    form.set("file", new Blob([Uint8Array.from([0,255])]), "synthetic.bin");
    await request("/api/file", { method: "POST", body: form });
    await request(`/api/file?${new URLSearchParams(deletedFile)}`, { method: "DELETE" });
    onStage("acceptance-entry");
    const credentials = path.join(root, "synthetic-credentials.json");
    fs.writeFileSync(credentials, JSON.stringify({ api: endpoint, apiToken: token, vault: "synthetic" }), { mode: 0o600 });
    const result = await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, ["scripts/pull-acceptance-vault.mjs", "--credentials-json", credentials], { stdio: ["ignore", "pipe", "pipe"], timeout: 70000 });
      let stdout = "", stderr = ""; worker.stdout.on("data", data => { stdout += data; }); worker.stderr.on("data", data => { stderr += data; });
      worker.on("error", reject); worker.on("close", code => resolve({ code, stdout, stderr }));
    });
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token), "Credential exposed in acceptance entry output");
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
    onObserved({ action: "acceptance-entry", ...receipt });
    assert.match(receipt.runId, /^[0-9a-f-]{36}$/);
    const copy = path.join(homedir(), ".local/share/fns-headless-acceptance/runs", receipt.runId);
    try {
      assert.equal(result.code, 0); assert.equal(receipt.status, "read-complete"); assert.equal(receipt.resumeSupported, false); assert.equal(receipt.remoteWrites, false);
      assert.deepEqual(receipt.completed.map(value => [value.scope, value.received]), [["notes", fixtures.size], ["files", 0]]);
      assert.deepEqual(receipt.completed.map(value => value.absentRemotely), [1, 1]);
      assert.equal(receipt.localFilesVerified, fixtures.size);
      assert.ok(!fs.existsSync(path.join(copy, "vault", "deleted.md"))); assert.ok(!fs.existsSync(path.join(copy, "vault", "deleted.bin")));
      for (const [file, content] of fixtures) assert.equal(digest(fs.readFileSync(path.join(copy, "vault", file))), digest(Buffer.from(content)));
    } finally { if (fs.existsSync(copy)) { assert.equal(fs.realpathSync(copy), copy); fs.rmSync(copy, { recursive: true, force: true }); } }
    return { empty: true, receipts, acceptanceEntry: true };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
