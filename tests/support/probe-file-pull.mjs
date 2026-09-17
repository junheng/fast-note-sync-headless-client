import { loadBundle } from "./load-bundle.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hashContent, hashArrayBuffer } from "../../src/lib/utils/protocol_hash.ts";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export async function probeFilePull({ endpoint, token, request, onStage, onObserved }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "fns-real-file-pull-"));
  const large = Buffer.alloc(12 * 1024 * 1024 + 1); for (let index = 0; index < large.length; index++) large[index] = (index * 37 + (index >>> 12)) & 255;
  const fixtures = new Map([["nested/中文😀.bin", Buffer.from([0, 255, 128, 13, 10])], ["empty.bin", Buffer.alloc(0)], ["large.bin", large]]);
  async function run(name, protobufEnabled, create = true, crashAtChunk = false, crashAtApplicationCommit = false) {
    const base = path.join(root, name), vaultDirectory = path.join(base, "vault"), stateDirectory = path.join(base, "state");
    if (create) { fs.mkdirSync(vaultDirectory, { recursive: true, mode: 0o700 }); fs.mkdirSync(stateDirectory, { mode: 0o700 }); }
    const result = await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, ["tests/support/note-pull-worker.mjs"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" }, timeout: 70000 });
      let stdout = "", stderr = ""; worker.stdout.on("data", data => { stdout += data; }); worker.stderr.on("data", data => { stderr += data; });
      worker.on("error", reject); worker.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      worker.stdin.end(JSON.stringify({ endpoint, token, protobufEnabled, vaultDirectory, stateDirectory, create, crashAtApplicationCommit, crashAtChunk, scope: "files" }));
    });
    assert.ok(!`${result.stdout}${result.stderr}`.includes(token), "Credential exposed in subprocess output");
    const receipt = JSON.parse(result.stdout); onObserved({ action: "file-pull", ...receipt });
    if (crashAtChunk || crashAtApplicationCommit) { assert.equal(result.signal, "SIGKILL"); assert.equal(receipt.stage, crashAtApplicationCommit ? "before-application-commit" : "after-chunk-write"); return { ...result, receipt, vaultDirectory }; }
    assert.ok(receipt.sent.every(action => ["ClientInfo", "FileSync", "FileSyncPageAck", "FileChunkDownload"].includes(action)), "Readonly worker sent a business write");
    return { ...result, receipt, vaultDirectory };
  }
  try {
    onStage("empty"); const empty = await run("empty", false); assert.equal(empty.code, 0); assert.equal(empty.receipt.received, 0);
    const manifest = [];
    const { exports: { connectHeadless } } = await loadBundle("src/headless/connection.ts");
    const { exports: { encodeFileChunk, BINARY_PREFIX_FILE_SYNC } } = await loadBundle("src/lib/sync/file_protocol.ts");
    const messages = [];
    const seed = await connectHeadless({ endpoint, token, protobufEnabled: false, onMessage: (action, data) => messages.push({ action, ...data }) });
    const response = async predicate => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const index = messages.findIndex(predicate);
        if (index >= 0) { const message = messages.splice(index, 1)[0]; assert.ok(message.code > 0 && message.code < 300, "Fixture upload rejected"); return message; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Fixture upload response deadline exceeded");
    };
    try {
      seed.client.Send("ClientInfo", { name: "synthetic", version: "2.4.0", type: "ObsidianPlugin", isDesktop: true, isLinux: true, protobuf: false, offlineSyncStrategy: "manualMerge" });
      await response(m => m.action === "ClientInfo");
      for (const [file, bytes] of fixtures) {
        onStage("seed-ws"); const contentHash = await hashArrayBuffer(Uint8Array.from(bytes).buffer);
        seed.client.Send("FileUploadCheck", { vault: "synthetic", path: file, pathHash: hashContent(file), contentHash, size: bytes.length, ctime: 1700000000000, mtime: 1700000000000 });
        const upload = await response(m => m.action === "FileUpload");
        const { sessionId, chunkSize } = upload.data;
        assert.ok(typeof sessionId === "string" && Number.isSafeInteger(chunkSize) && chunkSize > 0);
        for (let index = 0; index < Math.max(1, Math.ceil(bytes.length / chunkSize)); index++) {
          const frame = encodeFileChunk(sessionId, index, bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize)));
          assert.equal(await seed.client.SendBinary(frame, BINARY_PREFIX_FILE_SYNC), "sent");
        }
        await response(m => m.action === "FileUploadAck");
        const info = await request(`/api/file/info?${new URLSearchParams({ vault: "synthetic", path: file, pathHash: hashContent(file) })}`);
        assert.equal(info.data.contentHash, contentHash);
        manifest.push({ bytes: bytes.length, sha256: digest(bytes) });
      }
    } finally { seed.close(); }
    const receipts = [];
    for (const protobufEnabled of [false, true]) {
      const name = protobufEnabled ? "protobuf" : "json"; onStage(name);
      const result = await run(name, protobufEnabled);
      assert.equal(result.code, 0, "Independent Node file pull failed"); assert.equal(result.receipt.received, fixtures.size); assert.ok(result.receipt.pages > 1, "Pagination was not exercised");
      assert.equal(result.receipt.checkpointCommitted, true);
      for (const [file, bytes] of fixtures) assert.equal(digest(fs.readFileSync(path.join(result.vaultDirectory, file))), digest(bytes), "Downloaded full bytes differ");
      onStage(`${name}-repeat`); const repeat = await run(name, protobufEnabled, false);
      assert.equal(repeat.code, 0); assert.equal(repeat.receipt.applications, result.receipt.applications, "Unchanged repeat created a new file application");
      fs.writeFileSync(path.join(result.vaultDirectory, "large.bin"), "synthetic-local-edit");
      onStage(`${name}-conflict`); const conflict = await run(name, protobufEnabled, false);
      assert.equal(conflict.code, 2); assert.equal(conflict.receipt.code, "file-conflict"); assert.equal(conflict.receipt.conflicts, 1);
      assert.equal(fs.readFileSync(path.join(result.vaultDirectory, "large.bin"), "utf8"), "synthetic-local-edit");
      onStage(`${name}-crash`); const crashed = await run(`${name}-crash`, protobufEnabled, true, true);
      assert.ok(!fs.existsSync(path.join(crashed.vaultDirectory, "large.bin")), "Partial transfer published a file");
      onStage(`${name}-recover`); const recovered = await run(`${name}-crash`, protobufEnabled, false);
      assert.equal(recovered.code, 0); assert.equal(recovered.receipt.received, fixtures.size); assert.equal(recovered.receipt.applications, fixtures.size);
      for (const [file, bytes] of fixtures) assert.equal(digest(fs.readFileSync(path.join(recovered.vaultDirectory, file))), digest(bytes));
      onStage(`${name}-publication-crash`); await run(`${name}-publication-crash`, protobufEnabled, true, false, true);
      onStage(`${name}-publication-recover`); const published = await run(`${name}-publication-crash`, protobufEnabled, false);
      assert.equal(published.code, 0); assert.equal(published.receipt.applications, fixtures.size); assert.equal(published.receipt.pendingApplications, 0);
      receipts.push({ encoding: name, files: fixtures.size, pages: result.receipt.pages, completeBytesMatch: true, idempotentRepeat: true, localConflictPreserved: true, crashRecovery: true, publicationRecovery: true, independentNodeProcess: true, obsidianRuntimeLoaded: false });
    }
    return { empty: true, manifest, receipts };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
