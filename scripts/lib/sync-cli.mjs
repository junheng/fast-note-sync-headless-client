import path from "node:path";
import { fnsCredentials } from "./fns-credentials.mjs";
import { runInitialCopy } from "./initial-copy.mjs";
import { openSyncRuntime } from "../../src/headless/runtime.ts";
import { sendControl } from "../../src/headless/control.ts";
import { OwnedDirectories } from "../../src/headless/filesystem.ts";
import { StateStore } from "../../src/headless/state_store.ts";
import { allRecords } from "../../src/headless/outbox.ts";

const codes = new Set(["invalid-config", "local-writer-contract-required", "state-permissions", "invalid-root", "ownership-conflict", "ownership-unavailable", "unsupported-filesystem", "unsafe-path", "not-found", "authentication-failed", "connection-failed", "connection-timeout", "cancelled", "state-identity-mismatch", "state-identity-unverified", "state-corrupt", "state-format-unsupported", "state-write-failed", "state-limit", "snapshot-limit", "snapshot-corrupt", "snapshot-missing", "filesystem-limit", "scan-failed", "scan-changed", "scan-limit", "scan-cancelled", "sync-cancelled", "sync-local-changed", "remote-read-failed", "remote-changed", "remote-limit", "remote-version-changed", "upload-failed", "upload-timeout", "operation-unconfirmed", "operation-limit", "note-pull-failed", "file-pull-failed", "file-content-hash-mismatch", "note-pull-limit", "file-pull-limit", "control-unavailable", "control-limit", "control-timeout"]);
const output = value => console.log(JSON.stringify(value));
const invalid = () => { throw Object.assign(new Error(), { code: "invalid-config" }); };
async function input() {
  const chunks = []; let size = 0;
  for await (const part of process.stdin) { if ((size += part.length) > 16 * 1024 * 1024) invalid(); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { invalid(); }
}
function offlineStatus(env) {
  if (!env.FNS_VAULT_DIR || !env.FNS_STATE_DIR) invalid();
  const owner = OwnedDirectories.acquire(env.FNS_VAULT_DIR, env.FNS_STATE_DIR); let state;
  try {
    state = new StateStore(path.join(env.FNS_STATE_DIR, "state.db"));
    const conflicts = allRecords(state, "conflict").length, pending = allRecords(state, "operation").filter(v => v.record.status !== "acknowledged").length;
    return { schemaVersion: 1, status: conflicts ? "conflict" : "incomplete", running: false, pending, conflicts, lastSuccess: state.get("cycle", "latest")?.record.completedAt ?? null };
  } finally { state?.close(); owner.close(); }
}
async function pause(ms, signal) {
  if (signal.aborted) return;
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true });
  });
}
export async function runSyncCli({ args = process.argv.slice(2), env = process.env } = {}) {
  if (args[0] === "pull") return runInitialCopy({ args, env });
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: fns-headless <once|daemon|status|local-write|pull> [--credentials-json FILE]\n" +
      "once: bidirectional sync and durable confirmation; daemon: repeat sync with local control socket.\n" +
      "status: query owner or last checkpoint; local-write: JSON request on stdin, through running owner.\n" +
      "pull: initial read-only copy, fresh directories only.\n" +
      "Required for sync: FNS_ENDPOINT, FNS_VAULT, FNS_TOKEN_FILE (or FNS_CREDENTIALS_FILE), FNS_VAULT_DIR, FNS_STATE_DIR, FNS_LOCAL_WRITER_MODE=controlled|exclusive\n" +
      "Optional: FNS_SYNC_INTERVAL_MS=5000 (1000..3600000), FNS_PROTOBUF=true|false. Exit: 0 completed, 2 conflict/incomplete/error, 130 cancelled."); return;
  }
  const controller = new AbortController(), abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  let runtime;
  try {
    const [command, ...rest] = args;
    if (["status", "local-write"].includes(command)) {
      if (rest.length || !env.FNS_STATE_DIR) invalid();
      if (command === "local-write") {
        const response = await sendControl(env.FNS_STATE_DIR, { schemaVersion: 1, action: "local-write", request: await input() });
        output(response); if (!response.ok) process.exitCode = 2;
      } else {
        let response;
        try { response = await sendControl(env.FNS_STATE_DIR, { schemaVersion: 1, action: "status" }); }
        catch (error) { if (error.code !== "control-unavailable") throw error; }
        if (response) { output(response); if (!response.ok) process.exitCode = 2; }
        else output(offlineStatus(env));
      }
      return;
    }
    if (!["once", "daemon"].includes(command)) invalid();
    const config = fnsCredentials(rest, env);
    if (!["controlled", "exclusive"].includes(env.FNS_LOCAL_WRITER_MODE)) throw Object.assign(new Error(), { code: "local-writer-contract-required" });
    if (!env.FNS_VAULT_DIR || !env.FNS_STATE_DIR || env.FNS_PROTOBUF && !["true", "false"].includes(env.FNS_PROTOBUF)) invalid();
    const interval = Number(env.FNS_SYNC_INTERVAL_MS ?? 5000);
    if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 3600000) invalid();
    runtime = await openSyncRuntime({ ...config, vaultDirectory: env.FNS_VAULT_DIR, stateDirectory: env.FNS_STATE_DIR,
      writingMode: env.FNS_LOCAL_WRITER_MODE, protobufEnabled: env.FNS_PROTOBUF !== "false", signal: controller.signal, transferTimeoutMs: 300000 });
    if (command === "daemon") await runtime.listen();
    let failures = 0;
    do {
      try {
        const receipt = await runtime.sync.once(controller.signal); output({ ...receipt, scope: "bidirectional-files", remoteAtomicConditions: "upstream", fullSamplingAudit: "not-performed" }); failures = 0;
        if (command === "once") { if (receipt.status !== "synchronized") process.exitCode = 2; break; }
      } catch (error) {
        if (command === "once" || controller.signal.aborted || ++failures >= 8 || ["state-identity-mismatch", "state-corrupt", "state-format-unsupported"].includes(error.code)) throw error;
        output({ schemaVersion: 1, status: "incomplete", code: codes.has(error.code) ? error.code : "sync-failed", retry: failures });
      }
      await pause(Math.min(60000, interval * 2 ** failures), controller.signal);
    } while (!controller.signal.aborted);
    if (controller.signal.aborted) process.exitCode = 130;
  } catch (error) {
    output({ schemaVersion: 1, status: "incomplete", code: controller.signal.aborted ? "cancelled" : codes.has(error?.code) ? error.code : "sync-failed" });
    process.exitCode = controller.signal.aborted ? 130 : 2;
  } finally {
    try { await runtime?.close(); } catch { output({ schemaVersion: 1, status: "incomplete", code: "state-close-failed" }); process.exitCode = 2; }
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}
