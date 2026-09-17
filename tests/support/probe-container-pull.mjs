import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hashContent } from "../../src/lib/utils/protocol_hash.ts";

// Runs only against the disposable server owned by probe-server-capabilities.
export async function probeContainerPull({ endpoint, token, request, onStage }) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "fns-container-pull-"));
  const vault = path.join(root, "vault"), state = path.join(root, "state"), tokenFile = path.join(root, "token");
  const image = "localhost/fast-note-sync-headless-client:local";
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const fixtures = new Map([["中文/😀.md", Buffer.from("中文😀\r\n")], ["empty.md", Buffer.alloc(0)], ["attachment.bin", Buffer.from([0,255,128,42])], ["empty.bin", Buffer.alloc(0)]]);
  fs.mkdirSync(vault, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 }); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  async function run(extra = [], command = ["pull"]) {
    const name = `fns-client-probe-${randomUUID()}`;
    const args = ["run", "--rm", "--pull=never", "--name", name, "--network=host", "--userns=keep-id", "--user", `${process.getuid()}:${process.getgid()}`,
      "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--cpus=2", "--pids-limit=64",
      "--mount", `type=bind,src=${vault},dst=/vault`, "--mount", `type=bind,src=${state},dst=/state`, "--mount", `type=bind,src=${tokenFile},dst=/run/secrets/token,ro=true`,
      "--env", `FNS_ENDPOINT=${endpoint}`, "--env", "FNS_VAULT=synthetic", "--env", "FNS_TOKEN_FILE=/run/secrets/token", "--env", "FNS_LOCAL_WRITER_MODE=exclusive",
      ...extra, image, ...command];
    try {
      const result = await new Promise((resolve, reject) => {
        const worker = spawn("podman", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 90000 });
        let stdout = "", stderr = "";
        worker.stdout.on("data", bytes => { stdout += bytes; }); worker.stderr.on("data", bytes => { stderr += bytes; });
        worker.on("error", reject); worker.on("close", code => resolve({ code, stdout, stderr }));
      });
      for (const value of [token, ...fixtures.keys()]) assert.ok(!`${result.stdout}${result.stderr}`.includes(value), "Private value exposed by container");
      assert.ok(result.stdout.trim().startsWith("{"), "Container did not return a sanitized receipt");
      return { code: result.code, receipt: JSON.parse(result.stdout.trim().split("\n").at(-1)) };
    } finally {
      await new Promise(resolve => { const cleanup = spawn("podman", ["rm", "--force", name], { stdio: "ignore", timeout: 15000 }); cleanup.on("error", resolve); cleanup.on("close", resolve); });
    }
  }
  try {
    onStage("seed-container-fixtures");
    for (const [file, bytes] of fixtures) {
      if (file.endsWith(".md")) {
        const content = bytes.toString("utf8");
        await request("/api/note", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vault: "synthetic", path: file, pathHash: hashContent(file), content, contentHash: hashContent(content), ctime: 1700000000000, mtime: 1700000000000 }) });
      } else {
        const form = new FormData(); form.set("vault", "synthetic"); form.set("path", file); form.set("pathHash", hashContent(file)); form.set("file", new Blob([bytes]), "fixture.bin");
        await request("/api/file", { method: "POST", body: form });
      }
    }
    onStage("container-config-gate");
    const denied = await run(["--env", "FNS_LOCAL_WRITER_MODE="]);
    assert.equal(denied.code, 2); assert.equal(denied.receipt.code, "local-writer-contract-required");
    assert.deepEqual(fs.readdirSync(vault), []); assert.deepEqual(fs.readdirSync(state), []);
    onStage("container-readonly-copy");
    const result = await run();
    assert.equal(result.code, 0, `Container copy failed: ${result.receipt.code}`);
    assert.equal(result.receipt.status, "read-complete"); assert.equal(result.receipt.remoteWrites, false); assert.equal(result.receipt.resumeSupported, false);
    assert.equal(result.receipt.localFilesVerified, fixtures.size);
    assert.deepEqual(result.receipt.completed.map(value => [value.scope, value.received, value.batchCommitted]), [["notes",2,true],["files",2,true]]);
    for (const [file, bytes] of fixtures) assert.equal(digest(fs.readFileSync(path.join(vault,file))), digest(bytes));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,"receipt.json"))), result.receipt);
    assert.ok(Object.keys(result.receipt.sent).every(action => ["ClientInfo", "NoteSync", "NoteSyncPageAck", "FileSync", "FileSyncPageAck", "FileChunkDownload"].includes(action)));
    onStage("container-restart-gate");
    const before = fs.readFileSync(path.join(state,"receipt.json"));
    const repeated = await run(); assert.equal(repeated.code,2); assert.equal(repeated.receipt.code,"initial-copy-requires-empty-directories");
    assert.deepEqual(fs.readFileSync(path.join(state,"receipt.json")),before);
    for (const [file, bytes] of fixtures) assert.equal(digest(fs.readFileSync(path.join(vault,file))),digest(bytes));
    onStage("container-json-credentials");
    fs.renameSync(vault,path.join(root,"previous-vault")); fs.renameSync(state,path.join(root,"previous-state"));
    fs.mkdirSync(vault,{mode:0o700}); fs.mkdirSync(state,{mode:0o700});
    const jsonFile=path.join(root,"credentials.json"); fs.writeFileSync(jsonFile,JSON.stringify({api:endpoint,apiToken:token,vault:"synthetic"}),{mode:0o600});
    const jsonResult=await run(["--mount",`type=bind,src=${jsonFile},dst=/run/secrets/fns.json,ro=true`,"--env","FNS_ENDPOINT=","--env","FNS_VAULT=","--env","FNS_TOKEN_FILE=","--env","FNS_CREDENTIALS_FILE=/run/secrets/fns.json"]);
    assert.equal(jsonResult.code,0); assert.equal(jsonResult.receipt.localFilesVerified,fixtures.size);
    for (const [file, bytes] of fixtures) assert.equal(digest(fs.readFileSync(path.join(vault,file))),digest(bytes));
    return { container: true, nonRoot: true, readOnlyRoot: true, configuredEndpointAndBindMounts: true, notes: 2, attachments: 2, completeBytesMatch: true, durableReceipt: true, existingDirectoriesPreserved: true, missingWriterContractRejected: true, tokenAndJsonFiles: true, remoteWrites: false };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
