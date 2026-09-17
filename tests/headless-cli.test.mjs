import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fnsCredentials } from "../scripts/lib/fns-credentials.mjs";
import { FATAL_DAEMON_CODES, MAX_DAEMON_FAILURES, MAX_RETRY_DELAY_MS, retryDelayMs, retryable } from "../scripts/lib/retry-policy.mjs";
import { DatabaseSync } from "node:sqlite";

execFileSync(process.execPath, ["scripts/build-headless.mjs"], { stdio: "pipe" });
const root = fs.mkdtempSync(path.join(tmpdir(), "fns-cli-test-"));
const token = "synthetic-private-token", endpoint = "http://synthetic-private-host", vault = "synthetic-private-vault";
const tokenFile = path.join(root, "token"), jsonFile = path.join(root, "credentials.json");
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FNS_") && key !== "BW_SESSION"));
function cli(args, config = {}) {
  const result = spawnSync(process.execPath, ["dist/headless/cli.cjs", ...args], { env: { ...baseEnv, ...config }, encoding: "utf8", timeout: 15000 });
  assert.ifError(result.error);
  for (const secret of [token, endpoint, vault, root]) assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "Private config leaked through CLI output");
  return result;
}
try {
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
  fs.writeFileSync(jsonFile, JSON.stringify({ api: endpoint, apiToken: token, vault }), { mode: 0o600 });
  const expected = { endpoint, token, vault };
  assert.deepEqual(fnsCredentials([], { FNS_ENDPOINT: endpoint, FNS_VAULT: vault, FNS_TOKEN_FILE: tokenFile }), expected);
  assert.deepEqual(fnsCredentials([], { FNS_CREDENTIALS_FILE: jsonFile }), expected);
  assert.deepEqual(fnsCredentials(["--credentials-json", jsonFile], {}), expected);
  assert.throws(() => fnsCredentials([], { FNS_CREDENTIALS_FILE: jsonFile, FNS_ENDPOINT: endpoint }), { code: "invalid-config" });
  assert.throws(() => fnsCredentials([], { FNS_TOKEN: token, FNS_TOKEN_FILE: tokenFile }), { code: "invalid-config" });
  const link = path.join(root, "link"); fs.symlinkSync(tokenFile, link);
  assert.throws(() => fnsCredentials([], { FNS_ENDPOINT: endpoint, FNS_VAULT: vault, FNS_TOKEN_FILE: link }), { code: "invalid-config" });
  fs.writeFileSync(path.join(root, "oversized"), Buffer.alloc(65537));
  assert.throws(() => fnsCredentials([], { FNS_TOKEN_FILE: path.join(root, "oversized") }), { code: "invalid-config" });
  assert.equal(cli(["--help"]).status, 0);
  for (const args of [[], ["sync"], ["watch"], ["pull", "--unexpected"]]) assert.equal(cli(args).status, 2);
  const config = { FNS_CREDENTIALS_FILE: jsonFile, FNS_VAULT_DIR: path.join(root, "vault"), FNS_STATE_DIR: path.join(root, "state") };
  for (const command of ["pull", "once", "daemon"]) {
    const missingContract = cli([command], config);
    assert.equal(missingContract.status, 2);
    assert.equal(JSON.parse(missingContract.stdout).code, "local-writer-contract-required");
  }
  assert.ok(!fs.existsSync(config.FNS_VAULT_DIR)); assert.ok(!fs.existsSync(config.FNS_STATE_DIR));
  fs.mkdirSync(config.FNS_VAULT_DIR, { mode: 0o700 }); fs.mkdirSync(config.FNS_STATE_DIR, { mode: 0o700 });
  const database = path.join(config.FNS_STATE_DIR, "state.db");
  const db = new DatabaseSync(database); db.exec("PRAGMA user_version=999"); db.close();
  const original = fs.readFileSync(database);
  const unsupported = cli(["once"], { ...config, FNS_LOCAL_WRITER_MODE: "controlled" });
  assert.equal(unsupported.status, 2); assert.equal(JSON.parse(unsupported.stdout).code, "state-format-unsupported");
  assert.deepEqual(fs.readFileSync(database), original); assert.deepEqual(fs.readdirSync(config.FNS_VAULT_DIR), []);
  // Offline status, missing owner and malformed input stay machine-readable and
  // never exit 0; a failure is never reported as a completed synchronization.
  const offline = cli(["status"], config);
  assert.equal(offline.status, 2); assert.equal(JSON.parse(offline.stdout).code, "state-format-unsupported");
  const noOwner = cli(["conflicts"], config);
  assert.equal(noOwner.status, 2); assert.equal(JSON.parse(noOwner.stdout).code, "control-unavailable");
  const badRequest = cli(["local-write"], config);
  assert.equal(badRequest.status, 2); assert.equal(JSON.parse(badRequest.stdout).code, "invalid-config");
  // Bounded reconnect: eight attempts with a capped delay, identity/state
  // failures are fatal instead of retried forever.
  assert.equal(MAX_DAEMON_FAILURES, 8); assert.equal(MAX_RETRY_DELAY_MS, 60000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(n => retryDelayMs(n, 1000)), [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.deepEqual(FATAL_DAEMON_CODES, ["state-identity-mismatch", "state-corrupt", "state-format-unsupported"]);
  for (const code of ["remote-read-failed", "connection-timeout", "upload-timeout"]) assert.equal(retryable(code), true);
  for (const code of FATAL_DAEMON_CODES) assert.equal(retryable(code), false);
  console.log("headless-cli.test.mjs: standalone bundle, token/JSON files, config rejection, exit codes, bounded retry policy, no side effects and output privacy passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
