import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { loadBundle } from "./load-bundle.mjs";
export async function probeReconcile({ endpoint, token, onStage, withContainer = false }) {
  const { exports: api } = await loadBundle("tests/support/headless-entry.ts");
  const { OwnedDirectories, StateStore, IdentityBinding, UpstreamRemote, SyncCoordinator, fullDigest } = api;
  const root = await mkdtemp(path.resolve(".local/reconcile-service-"));
  const clients = [], results = [];
  async function open(label, create, protobufEnabled) {
    const vault = path.join(root, label, "vault"), directory = path.join(root, label, "state");
    await mkdir(vault, { recursive: true, mode: 0o700 }); await mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = OwnedDirectories.acquire(vault, directory), state = new StateStore(path.join(directory, "state.db"), { create });
    const identity = new IdentityBinding(owner, state, endpoint, "synthetic");
    const peer = new UpstreamRemote(owner, state, identity, { endpoint, token, vault: "synthetic", protobufEnabled });
    const sync = new SyncCoordinator(owner, state, identity, peer, "controlled");
    await peer.authenticate();
    const client = { owner, state, sync, close() { state.close(); owner.close(); } }; clients.push(client); return client;
  }
  let requestNumber = 0;
  async function edit(client, file, bytes) {
    const old = client.owner.vault.readOptional(file);
    assert.equal((await client.sync.requests.submit({ requestId: `request-${++requestNumber}`, operation: bytes === null ? "delete" : old ? "modify" : "create",
      path: file, contentKind: file.endsWith(".md") ? "note" : "file", expected: old ? { sha256: fullDigest(old), size: old.length } : null,
      ...(bytes === null ? {} : { content: bytes }) })).status, "applied");
  }
  async function cycle(client, stage) { onStage(stage); const result = await client.sync.once(); assert.equal(result.status, "synchronized", JSON.stringify(result)); return result; }
  try {
    let a = await open("a", true, false); const b = await open("b", true, true);
    for (const [kind, file, bytes] of [["note", "cycle.md", Buffer.from("synthetic 中文 😀\n")], ["file", "cycle.bin", Buffer.alloc(9 * 1024 * 1024, 61)]]) {
      await edit(a, file, bytes); await cycle(a, `${kind}-upload`); await cycle(b, `${kind}-download`);
      assert.deepEqual(b.owner.vault.read(file), bytes);
      const modified = Buffer.from(bytes); modified[0] = 62;
      await edit(b, file, modified); await cycle(b, `${kind}-modify`); await cycle(a, `${kind}-receive-modify`);
      assert.deepEqual(a.owner.vault.read(file), modified);
      a.close(); a = await open("a", false, false);
      await edit(a, file, null); await cycle(a, `${kind}-offline-delete`); await cycle(b, `${kind}-receive-delete`);
      assert.equal(b.owner.vault.readOptional(file), null);
      const empty = await cycle(a, `${kind}-idempotent`); assert.equal(empty.uploaded, 0); assert.equal(empty.downloaded, 0);
      results.push({ kind, bidirectional: true, restart: true, offlineDelete: true, idempotent: true, fullReadback: true, bytes: bytes.length });
    }
    onStage("cli-once");
    execFileSync(process.execPath, ["scripts/build-headless.mjs"], { stdio: "pipe" });
    const cliVault = path.join(root, "cli-vault"), cliState = path.join(root, "cli-state");
    await mkdir(cliVault, { mode: 0o700 }); await mkdir(cliState, { mode: 0o700 });
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FNS_") && key !== "BW_SESSION")),
      FNS_ENDPOINT: endpoint, FNS_TOKEN: token, FNS_VAULT: "synthetic", FNS_VAULT_DIR: cliVault, FNS_STATE_DIR: cliState,
      FNS_LOCAL_WRITER_MODE: "controlled", FNS_SYNC_INTERVAL_MS: "1000" };
    const once = execFileSync(process.execPath, ["dist/headless/cli.cjs", "once"], { env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(JSON.parse(once).status, "synchronized");
    const daemon = spawn(process.execPath, ["dist/headless/cli.cjs", "daemon"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    daemon.stdout.on("data", bytes => { stdout += bytes; }); daemon.stderr.on("data", bytes => { stderr += bytes; });
    const exited = new Promise(resolve => daemon.once("exit", (code, signal) => resolve({ code, signal })));
    const waitFor = async predicate => {
      const deadline = Date.now() + 60000;
      while (!predicate()) { if (Date.now() > deadline || daemon.exitCode !== null) throw new Error("daemon-probe-failed"); await new Promise(resolve => setTimeout(resolve, 100)); }
    };
    try {
      onStage("cli-daemon-control"); await waitFor(() => stdout.includes('"synchronized"'));
      const receipt = await api.sendControl(cliState, { schemaVersion: 1, action: "local-write", request: {
        requestId: "daemon-write", operation: "create", path: "daemon.md", contentKind: "note", expected: null, contentBase64: Buffer.from("daemon synthetic").toString("base64"),
      } });
      assert.equal(receipt.result.status, "applied");
      const lines = stdout.split("\n").length;
      await waitFor(() => stdout.split("\n").length > lines && stdout.trim().split("\n").at(-1).includes('"synchronized"'));
      await cycle(b, "cli-daemon-readback"); assert.equal(b.owner.vault.read("daemon.md").toString(), "daemon synthetic");
      const status = await api.sendControl(cliState, { schemaVersion: 1, action: "status" }); assert.equal(status.ok, true); assert.equal(status.result.pending, 0);
      // A second process cannot become another writer, even with other state.
      let denied;
      try { execFileSync(process.execPath, ["dist/headless/cli.cjs", "once"], { env, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }); }
      catch (error) { denied = JSON.parse(error.stdout); }
      assert.equal(denied?.code, "ownership-conflict");
      onStage("cli-daemon-stop"); daemon.kill("SIGTERM");
      const timer = setTimeout(() => daemon.kill("SIGKILL"), 10000);
      const stopped = await exited; clearTimeout(timer); assert.equal(stopped.code, 130); assert.equal(stopped.signal, null);
      const resumed = execFileSync(process.execPath, ["dist/headless/cli.cjs", "once"], { env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
      assert.equal(JSON.parse(resumed).status, "synchronized");
      for (const privateValue of [token, endpoint, root, "daemon synthetic", "daemon.md"]) assert.equal((stdout + stderr + resumed).includes(privateValue), false);
      results.push({ cliOnce: true, daemon: true, controlledWrite: true, exclusiveOwnership: true, gracefulStop: true, resumed: true, privateOutput: true });
    } finally { if (daemon.exitCode === null) daemon.kill("SIGKILL"); await exited; }
    if (withContainer) {
      onStage("container-bidirectional");
      const vault = path.join(root, "container-vault"), state = path.join(root, "container-state"), credentials = path.join(root, "container-token");
      await mkdir(vault, { mode: 0o700 }); await mkdir(state, { mode: 0o700 }); await writeFile(credentials, token, { mode: 0o600 });
      await writeFile(path.join(vault, "container.md"), "container synthetic");
      const command = ["run", "--rm", "--pull=never", "--network=host", "--userns=keep-id", "--user", `${process.getuid()}:${process.getgid()}`,
        "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--cpus=2", "--pids-limit=64",
        "--mount", `type=bind,src=${vault},dst=/vault`, "--mount", `type=bind,src=${state},dst=/state`, "--mount", `type=bind,src=${credentials},dst=/run/secrets/token,ro=true`,
        "--env", `FNS_ENDPOINT=${endpoint}`, "--env", "FNS_VAULT=synthetic", "--env", "FNS_TOKEN_FILE=/run/secrets/token", "--env", "FNS_LOCAL_WRITER_MODE=exclusive",
        "localhost/fast-note-sync-headless-client:local", "once"];
      const run = () => {
        const stdout = execFileSync("podman", command, { encoding: "utf8", timeout: 90000, stdio: ["ignore", "pipe", "pipe"] });
        assert.equal(JSON.parse(stdout).status, "synchronized");
        for (const value of [token, root, "container.md", "container synthetic"]) assert.equal(stdout.includes(value), false);
        return JSON.parse(stdout);
      };
      assert.equal(run().uploaded, 1); await cycle(b, "container-upload-readback");
      assert.equal(b.owner.vault.read("container.md").toString(), "container synthetic");
      await edit(b, "container.md", Buffer.from("modified remotely")); await cycle(b, "container-remote-modify");
      assert.equal(run().downloaded, 1); assert.equal((await readFile(path.join(vault, "container.md"))).toString(), "modified remotely");
      assert.equal(run().uploaded, 0);
      results.push({ container: true, nonRoot: true, readOnlyRoot: true, bidirectional: true, restart: true, privateOutput: true });
    }
    return results;
  } finally { for (const client of clients) { try { client.close(); } catch {} } await rm(root, { recursive: true, force: true }); }
}
