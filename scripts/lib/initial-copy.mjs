import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fnsCredentials } from "./fns-credentials.mjs";
import { OwnedDirectories } from "../../src/headless/filesystem.ts";
import { StateStore } from "../../src/headless/state_store.ts";
import { durableNotePull } from "../../src/headless/durable_note_pull.ts";
import { durableFilePull } from "../../src/headless/durable_file_pull.ts";
import { fullDigest } from "../../src/headless/snapshots.ts";

// Both the development acceptance wrapper and the container use this entry.
// Only fresh, explicitly exclusive directories are supported until identity
// binding and resumable synchronization are implemented.
export async function runInitialCopy({ acceptance = false, args = process.argv.slice(2), env = process.env } = {}) {
  // Single-use local acceptance copy, explicitly authorized by the operator.
  // Always starts in a new directory; no old identity, cursor or pending is loaded.
  // This is not the resumable synchronization CLI or a bidirectional acceptance.
  const root = path.join(homedir(), ".local/share/fns-headless-acceptance");
  const runId = randomUUID();
  const receipt = { schemaVersion: 1, runId, scope: "initial-readonly-copy", status: "incomplete", remoteWrites: false, resumeSupported: false, completed: [] };
  const allowed = new Set(["invalid-config", "local-writer-contract-required", "initial-copy-requires-empty-directories", "state-permissions", "invalid-root", "ownership-conflict", "ownership-unavailable", "unsupported-filesystem", "unsafe-path", "not-found", "authentication-failed", "connection-failed", "connection-timeout", "cancelled", "note-pull-limit", "file-pull-limit", "note-pull-failed", "file-pull-failed", "note-pull-timeout", "file-pull-timeout", "note-pull-cancelled", "file-pull-cancelled", "invalid-note-message", "invalid-file-message", "invalid-file-chunk", "file-version-changed", "file-content-hash-mismatch", "file-download-failed", "note-application-failed", "file-application-failed", "filesystem-limit", "state-limit", "readonly-write-required", "deletion-revalidation-required", "untested-server-version", "target-verification-failed"]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  let owner, store, directory;
  try {
    if (!acceptance && args.length === 1 && args[0] === "--help") {
      console.log("Usage: fns-headless [pull] [--credentials-json FILE]\nMode: initial read-only copy; fresh directories only; no resume or remote writes.\nRequired: FNS_ENDPOINT, FNS_VAULT, FNS_TOKEN_FILE (or FNS_CREDENTIALS_FILE), FNS_VAULT_DIR, FNS_STATE_DIR, FNS_LOCAL_WRITER_MODE=exclusive");
      return;
    }
    if (args[0] === "pull") args = args.slice(1);
    const config = fnsCredentials(args, env);
    if (!acceptance && env.FNS_LOCAL_WRITER_MODE !== "exclusive") throw Object.assign(new Error(), { code: "local-writer-contract-required" });
    if (!acceptance && (!env.FNS_VAULT_DIR || !env.FNS_STATE_DIR)) throw Object.assign(new Error(), { code: "invalid-config" });
    const endpoint = new URL(config.endpoint);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Object.assign(new Error(), { code: "invalid-config" });
    async function readMetadata(route) {
      const response = await fetch(config.endpoint.replace(/\/+$/, "") + route, { headers: { "x-client": "ObsidianPlugin", Authorization: `Bearer ${config.token}` }, redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      const reader = response.body.getReader(); const parts = []; let size = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; if ((size += part.value.length) > 1024 * 1024) { await reader.cancel(); throw new Error(); } parts.push(part.value); }
      const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!response.ok || !(value.code > 0 && value.code < 300)) throw Object.assign(new Error(), { code: "target-verification-failed" });
      return value.data;
    }
    const health = await readMetadata("/api/health");
    if (!["3.5.1", "3.6.1"].includes(health?.version)) throw Object.assign(new Error(), { code: "untested-server-version" });
    const subject = await readMetadata("/api/user/info");
    if (!Number.isSafeInteger(subject?.uid) || subject.uid <= 0) throw Object.assign(new Error(), { code: "target-verification-failed" });
    // Check the supplied Vault's read access before issuing a synchronization
    // inventory. No enumeration of other Vaults or fallback to a different name.
    await readMetadata(`/api/notes?${new URLSearchParams({ vault: config.vault, page: "1", pageSize: "1", isRecycle: "false" })}`);
    await readMetadata(`/api/files?${new URLSearchParams({ vault: config.vault, page: "1", pageSize: "1", isRecycle: "false" })}`);
    receipt.serverVersion = health.version;
    let vaultDirectory, stateDirectory;
    if (acceptance) {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(root) !== root || (fs.statSync(root).mode & 0o077)) throw new Error();
      for (let current = root;; current = path.dirname(current)) { if (fs.existsSync(path.join(current, ".git"))) throw new Error(); if (current === path.dirname(current)) break; }
      const runs = path.join(root, "runs"); fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(runs) !== runs || (fs.statSync(runs).mode & 0o077)) throw new Error();
      directory = path.join(runs, runId); fs.mkdirSync(directory, { mode: 0o700 });
      vaultDirectory = path.join(directory, "vault"); stateDirectory = path.join(directory, "state");
      fs.mkdirSync(vaultDirectory, { mode: 0o700 }); fs.mkdirSync(stateDirectory, { mode: 0o700 });
    } else {
      vaultDirectory = env.FNS_VAULT_DIR; stateDirectory = env.FNS_STATE_DIR;
    }
    owner = OwnedDirectories.acquire(vaultDirectory, stateDirectory);
    // Do not reuse state or treat pre-existing files as a confirmed baseline.
    // Include reserved temporary names when checking emptiness.
    if (fs.readdirSync(vaultDirectory).length || fs.readdirSync(stateDirectory).length) throw Object.assign(new Error(), { code: "initial-copy-requires-empty-directories" });
    if ((fs.statSync(stateDirectory).mode & 0o077) !== 0) throw Object.assign(new Error(), { code: "state-permissions" });
    if (!acceptance) directory = stateDirectory;
    store = new StateStore(path.join(stateDirectory, "state.db"), { create: true });
    const counts = {};
    const options = { ...config, initialCopy: true, signal: controller.signal, transferTimeoutMs: 300000, onSend: action => { counts[action] = (counts[action] ?? 0) + 1; } };
    for (const [scope, pull] of [["notes", durableNotePull], ["files", durableFilePull]]) {
      console.log(JSON.stringify({ runId, stage: `reading-${scope}`, remoteWrites: false }));
      const result = await pull(owner, store, "exclusive", options);
      receipt.completed.push({ scope, received: result.received, absentRemotely: result.absentRemotely ?? 0, pages: result.pages, batchCommitted: store.get("batch", result.batchId).record.status === "committed" });
    }
    let afterId, verifiedFiles = 0, copiedBytes = 0;
    for (;;) {
      const applications = store.list("application", { afterId, limit: 1000 });
      for (const { record } of applications) {
        const bytes = owner.vault.read(record.path);
        if (record.status !== "applied" || bytes.length !== record.after.size || fullDigest(bytes) !== record.after.sha256) throw new Error();
        verifiedFiles++; copiedBytes += bytes.length;
      }
      if (applications.length < 1000) break;
      afterId = applications.at(-1).record.id;
    }
    if (verifiedFiles !== receipt.completed.reduce((sum, collection) => sum + collection.received, 0)) throw new Error();
    receipt.localFilesVerified = verifiedFiles; receipt.copiedBytes = copiedBytes;
    receipt.sent = counts;
    receipt.status = "read-complete";
  } catch (error) { receipt.code = allowed.has(error?.code) ? error.code : "acceptance-copy-failed"; process.exitCode = 2; }
  finally {
    try { store?.close(); } catch { receipt.status = "incomplete"; receipt.code = "state-close-failed"; process.exitCode = 2; }
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    if (directory) {
      try {
        if (!acceptance) owner.state.write("receipt.json", Buffer.from(JSON.stringify(receipt, null, 2)), "create");
        else {
          const fd = fs.openSync(path.join(directory, "receipt.json"), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
          try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
      }
      catch { receipt.status = "incomplete"; receipt.code = "receipt-write-failed"; process.exitCode = 2; }
    }
    owner?.close();
    if (!(args.length === 1 && args[0] === "--help")) console.log(JSON.stringify(receipt));
  }

}
