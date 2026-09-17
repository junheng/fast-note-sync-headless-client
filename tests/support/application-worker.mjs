import fs from "node:fs";
import path from "node:path";
import { loadBundle } from "./load-bundle.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { vault, state, stage, create } = JSON.parse(input);
const { exports: { OwnedDirectories, StateStore, SnapshotStore, FileApplication } } = await loadBundle("tests/support/headless-entry.ts");
const owner = OwnedDirectories.acquire(vault, state);
const store = new StateStore(path.join(state, "state.db"));
const snapshots = new SnapshotStore(owner.state);
const application = new FileApplication(owner, store, "exclusive");
function crash() {
  fs.writeSync(1, "barrier\n");
  process.kill(process.pid, "SIGKILL");
}
const expected = create ? null : await snapshots.put(Buffer.from("original"), "note");
await application.prepare("apply-1", "note.md", Buffer.from("target"), "note", expected);
if (stage === "prepared") crash();
const realSync = fs.fsyncSync;
fs.fsyncSync = function(fd) {
  realSync(fd);
  if (stage === "temporary" && fs.realpathSync(`/proc/self/fd/${fd}`).startsWith(`${vault}/.fns-headless-`)) crash();
};
const realRename = fs.renameSync;
fs.renameSync = function(source, target) {
  realRename(source, target);
  if (stage === "published" && target.endsWith("/note.md")) crash();
};
const realLink = fs.linkSync;
fs.linkSync = function(source, target) {
  realLink(source, target);
  if (stage === "published" && target.endsWith("/note.md")) crash();
};
await application.apply("apply-1");
if (stage === "committed") crash();
throw new Error("Requested crash boundary was not reached");
