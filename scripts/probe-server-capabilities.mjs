import { probeFilePull } from "../tests/support/probe-file-pull.mjs";
import { probeNotePull } from "../tests/support/probe-note-pull.mjs";
import { probeContainerPull } from "../tests/support/probe-container-pull.mjs";
import { loadBundle } from "../tests/support/load-bundle.mjs";
import { probeWritePreconditions } from "../tests/support/probe-write-preconditions.mjs";
import { probeHeadlessWrite } from "../tests/support/probe-headless-write.mjs";
import { probeReconcile } from "../tests/support/probe-reconcile.mjs";
import * as protocolHash from "../src/lib/utils/protocol_hash.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// This probe owns an ephemeral loopback-only server and never accepts credentials.
const serverVersion = process.argv.includes("--server-version=3.5.1") ? "3.5.1" : "3.6.1";
const image = serverVersion === "3.5.1"
  ? "docker.io/haierkeys/fast-note-sync-service@sha256:9d20a69e22d266fd02c0723d0fde2db29e83c11cbb950251c248f31a191a4e1b"
  : "docker.io/haierkeys/fast-note-sync-service@sha256:15833f15e83cee05794c3fe6028c7e41fd36c787f0d651415cad556579fc379f";
const root = path.resolve(import.meta.dirname, "..");
const name = `fns-capability-${randomUUID()}`;
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const podman = (...args) => execFileSync("podman", args, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quiet = () => {};

function load(relativePath, requireStub) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(path.join(root, relativePath), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, require: requireStub,
    window: { setTimeout, clearTimeout }, setTimeout, clearTimeout,
    WebSocket, ArrayBuffer, Blob, TextEncoder, TextDecoder, URL, console,
  });
  return module.exports;
}

const helpers = load("src/lib/utils/helpers.ts", (id) => {
  if (id === "./protocol_hash") return protocolHash;
  if (id === "obsidian") return { Platform: { isMobile: false }, normalizePath: p => p };
  if (id === "../../i18n/lang") return { $: key => key };
  if (id === "../../main") return {};
  if (id === "../sync/sync_log_manager") return {};
  if (id === "../helpers_obsidian_bypass") return { dump: quiet, dumpError: quiet };
  throw new Error("Unexpected helper dependency");
});
const actions = load("src/lib/sync/websocket_action.ts", () => { throw new Error("Unexpected action dependency"); });
const { CLIENT_TYPE } = load("src/lib/utils/types.ts", () => ({}));
const { WebSocketClient } = load("src/lib/sync/websocket_client.ts", (id) => {
  if (id === "obsidian") return { moment: () => ({ format: () => "synthetic" }) };
  if (id === "../utils/helpers") return { ...helpers, dump: quiet, dumpError: quiet, showSyncNotice: quiet };
  throw new Error("Unexpected transport dependency");
});

let client;
let created = false;
let stage = "create-server";
const observed = [];
mkdirSync(path.join(root, ".local"), { recursive: true, mode: 0o700 });
const configDirectory = mkdtempSync(path.join(root, ".local", "fns-probe-"));
try {
  writeFileSync(path.join(configDirectory, "config.yaml"), `server:\n  run-mode: release\n  http-port: ":9000"\napp:\n  is-return-sussess: true\n${process.argv.includes("--note-pull") || process.argv.includes("--file-pull") ? "  sync-down-chunk-num: 2\n" : ""}user:\n  register-is-enable: true\nsecurity:\n  auth-token-key: ${randomUUID()}\n`, { mode: 0o600 });
  podman("run", "-d", "--pull=never", "--name", name, "--memory", "512m", "--cpus", "2", "-v", `${configDirectory}:/fast-note-sync/config`, "-p", "127.0.0.1::9000", image);
  created = true;
  const address = podman("port", name, "9000");
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = `http://${address}`;
  stage = "health";
  let healthy = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      healthy = health.code === 1 && health.data?.version === serverVersion;
      if (healthy) break;
    } catch { /* The owned server may still be starting. */ }
    await pause(250);
  }
  assert.ok(healthy, "Pinned server did not become healthy");

  let token;
  let clientType = "webgui";
  const headers = () => ({ "x-client": clientType, "User-Agent": "node", ...(token ? { Authorization: `Bearer ${token}` } : {}) });
  async function request(route, options = {}) {
    const response = await fetch(`${base}${route}`, { ...options, headers: { ...headers(), ...options.headers }, signal: AbortSignal.timeout(15000) });
    assert.ok(response.ok, `HTTP status ${response.status}`);
    const result = await response.json();
    assert.ok(result.code > 0 && result.code < 300, `Business status ${result.code}`);
    return result;
  }
  stage = "register";
  const password = randomUUID();
  const user = await request("/api/user/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "fixture@example.com", username: "fixture", password, confirmPassword: password }),
  });
  token = user.data.token;
  assert.ok(token);
  stage = "create-fixture-vault";
  await request("/api/vault", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vault: "synthetic" }),
  });
  stage = "issue-fixture-token";
  const issued = await request("/api/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientType: CLIENT_TYPE, protocol: "*", client: CLIENT_TYPE, function: "*", expiredDays: 1 }),
  });
  token = issued.data.token;
  assert.ok(token);
  clientType = CLIENT_TYPE;

  if (process.argv.includes("--identity-only")) {
    stage = "identity-current-subject";
    const first = await request("/api/user/info");
    const vaults = await request("/api/vault");
    const health = await request("/api/health");
    const fieldNames = value => value && typeof value === "object" ? Object.keys(value).sort() : [];
    const vaultItems = Array.isArray(vaults.data) ? vaults.data : vaults.data?.list;
    assert.ok(first.data && typeof first.data.uid === "number" && Number.isSafeInteger(first.data.uid), "Subject ID was not a safe integer");
    assert.ok(Array.isArray(vaultItems) && vaultItems.length === 1, "Fixture vault identity was not enumerable");
    stage = "identity-token-rotation";
    token = user.data.token; clientType = "webgui";
    const secondToken = await request("/api/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientType: CLIENT_TYPE, protocol: "*", client: CLIENT_TYPE, function: "*", expiredDays: 1 }) });
    token = secondToken.data.token; clientType = CLIENT_TYPE;
    const rotated = await request("/api/user/info");
    const rotatedVaults = await request("/api/vault");
    assert.equal(rotated.data.uid, first.data.uid, "Credential rotation changed the subject");
    const rotatedItems = Array.isArray(rotatedVaults.data) ? rotatedVaults.data : rotatedVaults.data?.list;
    assert.deepEqual(rotatedItems, vaultItems, "Credential rotation changed vault identity");
    console.log(JSON.stringify({ serverVersion, image, subjectFields: fieldNames(first.data), vaultFields: fieldNames(vaultItems[0]), healthFields: fieldNames(health.data), subjectIdSafeInteger: true, sameSubjectCredentialRotation: true, sameVaultCredentialRotation: true, serviceIdentityVerified: false, recoveryGate: "state-identity-unverified" }));
  } else if (process.argv.includes("--container-pull")) {
    const results = await probeContainerPull({ endpoint: base, token, request, onStage: value => { stage = value; } });
    console.log(JSON.stringify({ serverVersion, image, results }));
  } else if (process.argv.includes("--file-pull")) {
    const results = await probeFilePull({ endpoint: base, token, request, onStage: value => { stage = `file-pull-${value}`; }, onObserved: value => observed.push(value) });
    console.log(JSON.stringify({ serverVersion, image, results }));
  } else if (process.argv.includes("--note-pull")) {
    const results = await probeNotePull({ endpoint: base, token, request, onStage: value => { stage = `note-pull-${value}`; }, onObserved: value => observed.push(value) });
    console.log(JSON.stringify({ serverVersion, image, results }));
  } else if (process.argv.includes("--reconcile") || process.argv.includes("--container-sync") || process.argv.includes("--rename-sync")) {
    const results = await probeReconcile({ endpoint: base, token, withContainer: process.argv.includes("--container-sync"), withRename: process.argv.includes("--rename-sync"), onStage: value => { stage = `reconcile-${value}`; } });
    console.log(JSON.stringify({ schemaVersion: 1, serverVersion, scope: "headless-reconciliation", results }));
  } else if (process.argv.includes("--headless-write")) {
    const results = await probeHeadlessWrite({ endpoint: base, token, request, onStage: value => { stage = `headless-write-${value}`; } });
    console.log(JSON.stringify({ serverVersion, image, results, upstreamConcurrencySemantics: true }));
  } else if (process.argv.includes("--write-preconditions")) {
    stage = "write-preconditions";
    const results = await probeWritePreconditions({ endpoint: base, token, headers, actions, onStage: value => { stage = `write-preconditions-${value}`; }, onObserved: value => observed.push(value) });
    console.log(JSON.stringify({ serverVersion, image, results, atomicConditionalDeleteVerified: false, atomicConditionalRenameVerified: false }));
  } else if (process.argv.includes("--connection-only")) {
    stage = "node-connection";
    const { exports: { connectHeadless }, inputs } = await loadBundle(path.join(root, "src/headless/connection.ts"));
    assert.ok(!inputs.some(input => /websocket_obsidian|utils\/helpers\.ts|src\/main\.ts|node_modules\/obsidian/.test(input)), "Node bundle imported plugin runtime");
    for (const protobufEnabled of [false, true]) {
      const controller = new AbortController();
      const messages = [];
      const connection = await connectHeadless({ endpoint: base, token, protobufEnabled, signal: controller.signal, onMessage: (action, data) => messages.push({ action, ...data }) });
      try {
        assert.equal(connection.client.isAuth, true);
        assert.equal(connection.client.useProtobuf, protobufEnabled);
        assert.equal(connection.negotiation.negotiated, true);
        const frames = [];
        connection.client.ws.addEventListener("message", event => frames.push(typeof event.data === "string" ? "json" : "protobuf"));
        connection.client.Send(actions.ClientReceiveInfo, {
          name: "synthetic", version: "2.4.0", type: CLIENT_TYPE,
          isDesktop: true, isLinux: true, protobuf: protobufEnabled, offlineSyncStrategy: "manualMerge",
        });
        for (let attempt = 0; attempt < 250 && !messages.some(message => message.action === actions.ClientInfo); attempt++) await pause(20);
        const info = messages.find(message => message.action === actions.ClientInfo);
        assert.ok(info && info.code > 0 && info.code < 300, "ClientInfo roundtrip failed");
        assert.ok(frames.includes(protobufEnabled ? "protobuf" : "json"), "Expected wire encoding was not observed");
        controller.abort();
        assert.equal(connection.client.isAuth, false);
        assert.equal(connection.client.isRegister, false);
      } finally { connection.close(); }
    }
    await assert.rejects(connectHeadless({ endpoint: base, token: "synthetic-invalid" }), error => error.code === "authentication-failed");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(connectHeadless({ endpoint: base, token, signal: alreadyAborted.signal }), error => error.code === "cancelled");
    const connecting = new AbortController();
    const pending = connectHeadless({ endpoint: base, token, signal: connecting.signal });
    connecting.abort();
    await assert.rejects(pending, error => error.code === "cancelled");
    for (const valid of [true, false]) {
      const result = await new Promise((resolve, reject) => {
        const worker = spawn(process.execPath, [path.join(root, "tests/support/auth-worker.mjs")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
        let stdout = "";
        let stderr = "";
        worker.stdout.on("data", data => { stdout += data; });
        worker.stderr.on("data", data => { stderr += data; });
        worker.on("error", reject);
        worker.on("close", code => resolve({ code, stdout, stderr }));
        worker.stdin.end(JSON.stringify({ endpoint: base, token: valid ? token : "synthetic-invalid" }));
      });
      assert.equal(result.code, valid ? 0 : 2, "Authentication worker returned an unexpected exit code");
      assert.ok(!`${result.stdout}${result.stderr}`.includes(token), "Worker output exposed a credential");
      const status = JSON.parse(valid ? result.stdout : result.stderr);
      assert.equal(status.status, valid ? "authenticated" : "error");
      if (valid) assert.equal(status.synchronizationStarted, false);
      else assert.equal(status.code, "authentication-failed");
    }
    console.log(JSON.stringify({ serverVersion, image, nodeAuthentication: ["json", "protobuf"], clientInfoRoundtrip: ["json", "protobuf"], rejectedCredentials: true, cancellation: ["before-connect", "during-connect", "after-auth"], subprocessExitCodes: { accepted: 0, rejected: 2 }, synchronizationStarted: false }));
  } else {
  stage = "seed-file";
  const before = new Uint8Array(20 * 1024 * 1024);
  const after = before.slice();
  after[6 * 1024 * 1024] = 1;
  const protocolHash = await helpers.hashArrayBuffer(before.buffer);
  assert.equal(await helpers.hashArrayBuffer(after.buffer), protocolHash);
  assert.notEqual(digest(before), digest(after));
  const fixture = { vault: "synthetic", path: "fixture.bin", pathHash: helpers.hashContent("fixture.bin"), ctime: 1700000000000, mtime: 1700000000000 };
  const form = new FormData();
  for (const [key, value] of Object.entries(fixture)) form.set(key, String(value));
  form.set("file", new Blob([before]), "fixture.bin");
  const seeded = await request("/api/file", { method: "POST", body: form });
  assert.equal(seeded.data.contentHash, protocolHash);

  stage = "authenticate-websocket";
  const messages = [];
  const storage = new Map();
  client = new WebSocketClient({
    loadCount: () => storage.get("count") ?? 0,
    saveCount: count => storage.set("count", count),
    protobufEnabled: () => false,
  }, {
    getWsUrl: () => `ws://${address}/api/user/sync?client=${CLIENT_TYPE}&clientName=capability-probe&clientVersion=2.4.0&pv=2&pb=0`,
    onOpen: socket => socket.Send(actions.ClientReceiveAuth, token),
    onMessage: (_socket, action, data) => {
      messages.push({ action, ...data });
      observed.push({ action, code: data.code, contextPresent: Boolean(data.context) });
    },
  }, { createSocket: url => new WebSocket(url), timestamp: () => "synthetic", debug: quiet, error: quiet, notice: quiet });
  async function nextMessage(predicate) {
    for (let attempt = 0; attempt < 500; attempt++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await pause(20);
    }
    throw new Error("Response deadline exceeded");
  }
  await client.register();
  const auth = await nextMessage(message => message.action === actions.ClientReceiveAuth);
  assert.ok(auth.code > 0 && auth.code < 300, `Authentication status ${auth.code}`);
  client.isAuth = true;

  const results = [];
  for (const delta of [0, 1000]) {
    stage = `same-hash-upload-${delta}`;
    const context = `probe-${delta}`;
    client.Send(actions.FileReceiveUploadCheck, { ...fixture, mtime: fixture.mtime + delta, size: after.byteLength, contentHash: protocolHash, context });
    const response = await nextMessage(message => message.context === context);
    assert.ok(response.code > 0 && response.code < 300, `Upload check status ${response.code}`);
    const uploadRequested = response.action === "FileUpload";
    const readback = await fetch(`${base}/api/file?${new URLSearchParams({ vault: fixture.vault, path: fixture.path })}`, { headers: headers(), signal: AbortSignal.timeout(15000) });
    assert.ok(readback.ok);
    const bytes = new Uint8Array(await readback.arrayBuffer());
    assert.equal(bytes.byteLength, before.byteLength);
    assert.equal(digest(bytes), digest(before));
    results.push({ preservedMtime: delta === 0, responseCode: response.code, uploadRequested, remoteMatchesOriginal: true, remoteMatchesEdited: false });
  }
  // Characterize the REST path separately; it is not the plugin's WS upload path
  // and does not establish atomic conditional-write or immutable-read support.
  stage = "rest-same-hash-control";
  form.set("file", new Blob([after]), "fixture.bin");
  await request("/api/file", { method: "POST", body: form });
  const control = await fetch(`${base}/api/file?${new URLSearchParams({ vault: fixture.vault, path: fixture.path })}`, { headers: headers(), signal: AbortSignal.timeout(15000) });
  assert.ok(control.ok);
  const controlBytes = new Uint8Array(await control.arrayBuffer());
  assert.equal(digest(controlBytes), digest(after));
  console.log(JSON.stringify({ serverVersion, image, fixtureBytes: before.byteLength, changedOffset: 6 * 1024 * 1024, protocolHashEqual: true, fullDigestEqual: false, results, restControl: { remoteMatchesEdited: true, atomicConditionalWriteVerified: false, immutableReadVerified: false } }));
  }
} catch (error) {
  // Avoid printing response bodies, credentials, container logs or private paths.
  console.error(`Capability probe failed at ${stage}: ${error instanceof assert.AssertionError ? error.message : "operation failed"}`);
  if (typeof error?.code === "string" && /^[a-z-]{1,60}$/.test(error.code)) console.error(JSON.stringify({ code: error.code }));
  console.error(JSON.stringify({ observed: observed.slice(-10) }));
  process.exitCode = 1;
} finally {
  client?.unRegister(true);
  try {
    if (created) podman("rm", "-f", "-v", name);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
}
