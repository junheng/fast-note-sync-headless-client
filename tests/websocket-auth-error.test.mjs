import * as protocolHash from "../src/lib/utils/protocol_hash.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
function loadModule(relativePath, requireStub) {
  const sourcePath = path.join(root, relativePath);
  const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(transpiled, {
    require: requireStub,
    module,
    exports: module.exports,
    console,
    TextDecoder,
    window: { setTimeout, clearTimeout },
  }, { filename: sourcePath });
  return module.exports;
}

const notices = [];
const logManager = { logReceivedMessage: () => undefined, logSentMessage: () => undefined };
const obsidian = {
  moment: Object.assign(() => ({ format: () => "" }), { locale: () => "zh-cn" }),
  Platform: {},
  Notice: class {},
  normalizePath: (value) => value,
  TFolder: class {},
  App: class {},
};
// Use the real string normalization dependency, mocking only host services.
const helpers = loadModule("src/lib/utils/helpers.ts", (id) => {
  switch (id) {
    case "./protocol_hash": return protocolHash;
    case "obsidian": return obsidian;
    case "../../main": return {};
    case "../../i18n/lang": return { $: (key) => key };
    case "../sync/sync_log_manager":
      return { SyncLogManager: { getInstance: () => logManager } };
    case "../helpers_obsidian_bypass":
      return { dump: () => undefined, dumpError: () => undefined };
    default: throw new Error(`Unexpected helper require: ${id}`);
  }
});
const actions = loadModule("src/lib/sync/websocket_action.ts", (id) => {
  throw new Error(`Unexpected action require: ${id}`);
});
const authorization = loadModule("src/lib/sync/websocket_auth.ts", () => actions);
const syncProtocol = loadModule("src/lib/sync/sync_protocol.ts", () => assert.fail("Unexpected sync protocol dependency"));
const requireStub = (id) => {
  switch (id) {
    case "./sync_protocol": return syncProtocol;
    case "./websocket_auth": return authorization;
    case "obsidian":
      return obsidian;
    case "../utils/helpers":
      return {
        ...helpers,
        showSyncNotice: (...args) => notices.push(args),
      };
    case "./operator_file":
      return {
        handleFileChunkDownload: () => undefined,
        BINARY_PREFIX_FILE_SYNC: "fs",
        clearUploadQueue: () => undefined,
      };
    case "./operator":
      return {
        receiveOperators: {},
        startupSync: () => undefined,
        startupFullSync: () => undefined,
        checkSyncCompletion: () => undefined,
      };
    case "./sync_log_manager":
      return { SyncLogManager: { getInstance: () => logManager } };
    case "../../i18n/lang":
      return { $: (key) => key };
    case "./websocket_action": return actions;
    case "./websocket_obsidian": return { createObsidianWebSocketClient: () => assert.fail("Unexpected connection") };
    case "../../pb/protobuf_mapper": return {};
    case "../utils/types": return {};
    default:
      throw new Error(`Unexpected require: ${id}`);
  }
};

const { formatAuthorizationError, WebSocketManager } = loadModule(
  "src/lib/sync/websocket_manager.ts", requireStub,
);

assert.equal(typeof formatAuthorizationError, "function");

const missingMessage = formatAuthorizationError({ code: 308 });
assert.match(missingMessage, /Code=308/);
assert.match(missingMessage, /Session expired or token has been revoked/);
assert.match(missingMessage, /Please re-import the API configuration/);
assert.doesNotMatch(missingMessage, /undefined/);

const rotated = formatAuthorizationError({ code: 308, details: ["Token has been rotated"] });
assert.match(rotated, /Details=Token has been rotated/);
assert.match(rotated, /Please re-import the API configuration/);

const scopeRestricted = formatAuthorizationError({ code: 315, message: undefined, details: "Permission denied: Handshake" });
assert.match(scopeRestricted, /Authorization token scope is restricted/);
assert.match(scopeRestricted, /Details=Permission denied: Handshake/);
assert.doesNotMatch(scopeRestricted, /Please re-import/);
assert.doesNotMatch(scopeRestricted, /undefined/);

const customMessage = formatAuthorizationError({ code: 399, message: "Custom rejection", details: [null, "", "scope"] });
assert.match(customMessage, /Msg=Custom rejection Details=scope/);
assert.doesNotMatch(customMessage, /Please re-import/);
assert.match(formatAuthorizationError({ code: 399 }), /Msg=Authorization failed/);

// Exercise the actual auth-error dispatch without opening a socket.
const manager = Object.create(WebSocketManager.prototype);
manager.plugin = { currentSyncType: "manual" };
manager.client = { isAuth: false };
manager.StartHandle = () => assert.fail("Rejected authentication must not start sync");
manager.sendClientInfo = () => assert.fail("Rejected authentication must not send client info");
for (const code of [0, 308, 315]) {
  notices.length = 0;
  manager.handleStructuredMessage(actions.ClientReceiveAuth, { code });
  assert.equal(manager.client.isAuth, false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][0], formatAuthorizationError({ code }));
  assert.equal(notices[0][1], 6000);
}

const order = [];
manager.plugin.settings = { protobufEnabled: true };
manager.plugin.syncState = { negotiated: false };
manager.plugin.localStorageManager = { getMetadata: () => undefined, setMetadata: () => undefined };
manager.client.notifyStatusChange = () => order.push("authenticated");
manager.sendClientInfo = () => {
  assert.equal(manager.plugin.syncState.pipelineWindowUp, 8);
  assert.equal(manager.client.useProtobuf, true);
  order.push("client-info");
};
manager.StartHandle = async () => { order.push("sync-start"); };
manager.handleStructuredMessage(actions.ClientReceiveAuth, { code: 1, data: { pipelineWindowUp: 8, protobufAck: true } });
assert.deepEqual(order, ["authenticated", "client-info", "sync-start"]);

console.log("websocket-auth-error.test.mjs: all scenarios passed");
