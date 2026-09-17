import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fnsCredentials } from "../scripts/lib/fns-credentials.mjs";

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
  const missingContract = cli(["pull"], config);
  assert.equal(missingContract.status, 2);
  assert.equal(JSON.parse(missingContract.stdout).code, "local-writer-contract-required");
  assert.ok(!fs.existsSync(config.FNS_VAULT_DIR)); assert.ok(!fs.existsSync(config.FNS_STATE_DIR));
  console.log("headless-cli.test.mjs: standalone bundle, token/JSON files, config rejection, no side effects and output privacy passed");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
