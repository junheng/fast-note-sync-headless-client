import path from "node:path";
import fs from "node:fs";
import { loadBundle } from "./load-bundle.mjs";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
const { exports: { OwnedDirectories, StateStore, durableNotePull, durableFilePull }, inputs } = await loadBundle("tests/support/headless-entry.ts");
if (inputs.some(value => /src\/main|operator\.ts|operator_note|obsidian\/|utils\/helpers\.ts/.test(value))) throw new Error("Plugin runtime dependency found");
const owner = OwnedDirectories.acquire(config.vaultDirectory, config.stateDirectory);
const store = new StateStore(path.join(config.stateDirectory, "state.db"), { create: config.create });
if (config.crashAtPage || config.crashAtApplicationCommit) {
  const commit = store.commit.bind(store);
  store.commit = mutations => {
    if (config.crashAtApplicationCommit && mutations.some(m => m.record?.kind === "application" && m.record.status === "applied")) {
      fs.writeSync(1, '{"stage":"before-application-commit"}\n'); process.kill(process.pid, "SIGKILL");
    }
    if (config.crashAtPage && mutations.some(m => m.record?.kind === "batch" && m.record.completedPages.length === 1)) {
      fs.writeSync(1, '{"stage":"before-page-commit"}\n'); process.kill(process.pid, "SIGKILL");
    }
    commit(mutations);
  };
}
if (config.crashAtChunk) {
  const write = owner.state.write.bind(owner.state);
  owner.state.write = (name, ...args) => {
    write(name, ...args);
    if (name.endsWith(".chunk")) { fs.writeSync(1, '{"stage":"after-chunk-write"}\n'); process.kill(process.pid, "SIGKILL"); }
  };
}
const sent = [];
try {
  const receipt = await (config.scope === "files" ? durableFilePull : durableNotePull)(owner, store, "exclusive", { endpoint: config.endpoint, token: config.token, vault: "synthetic", protobufEnabled: config.protobufEnabled,
    onSend: action => sent.push(action) });
  const batch = store.get("batch", receipt.batchId).record;
  console.log(JSON.stringify({ ...receipt, sent, checkpointCommitted: batch.status === "committed", pendingApplications: store.list("application").filter(value => value.record.status === "prepared").length, conflicts: store.list("conflict").length, applications: store.list("application").length, obsidianRuntimeLoaded: false }));
} catch (error) {
  const code = ["note-conflict", "note-pull-failed", "note-pull-timeout", "invalid-note-message", "file-conflict", "file-pull-failed", "file-pull-timeout", "invalid-file-message", "file-version-changed", "file-download-failed", "invalid-file-chunk"].includes(error?.code) ? error.code : "operation-failed";
  console.log(JSON.stringify({ code, sent, conflicts: store.list("conflict").length, obsidianRuntimeLoaded: false })); process.exitCode = 2;
} finally { store.close(); owner.close(); }
