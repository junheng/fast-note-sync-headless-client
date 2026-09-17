import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadBundle } from "./support/load-bundle.mjs";
const { exports: { OwnedDirectories, StateStore, SnapshotStore, VaultScanner, FileApplication, LocalRequests } } = await loadBundle("tests/support/headless-entry.ts");
const root = fs.mkdtempSync(path.join(tmpdir(), "fns-scan-")), vault = path.join(root, "vault"), state = path.join(root, "state");
fs.mkdirSync(vault, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
const owner = OwnedDirectories.acquire(vault, state); let store = new StateStore(path.join(state, "state.db"), { create: true });
let scanner = new VaultScanner(owner, store); let watching;
const file = (manifest, name) => manifest.files.find(entry => entry.path === name);
try {
  owner.vault.createDirectories("nested/empty"); owner.vault.createDirectories(".obsidian");
  owner.vault.write("a.md", Buffer.from("Aa"), "create"); owner.vault.write("nested/中文😀.bin", Buffer.from([0,255,128]), "create"); owner.vault.write(".obsidian/private.json", Buffer.from("excluded"), "create");
  // Use an exact second: Date conversion otherwise loses filesystem sub-ms
  // precision and can shift this test's preserved mtime by one millisecond.
  fs.utimesSync(path.join(vault, "a.md"), 1700000000, 1700000000);
  const original = await scanner.scan(); assert.equal(original.files.length, 2); assert.deepEqual(original.directories, ["nested", "nested/empty"]);
  const first = store.get("scan", "latest"); assert.deepEqual(scanner.latest(), original);
  await scanner.scan(); assert.equal(store.get("scan", "latest").revision, first.revision, "Stable scan must not create a new observation");
  // Same size, mtime and upstream protocol hash; full bytes must detect the edit.
  const stat = fs.statSync(path.join(vault,"a.md")); fs.writeFileSync(path.join(vault,"a.md"),"BB"); fs.utimesSync(path.join(vault,"a.md"), stat.atime, stat.mtime);
  const changed = await scanner.scan(); assert.equal(file(changed,"a.md").version.protocolHash, file(original,"a.md").version.protocolHash);
  assert.equal(file(changed,"a.md").mtime, file(original,"a.md").mtime);
  assert.equal(file(changed,"a.md").version.size, file(original,"a.md").version.size); assert.notEqual(file(changed,"a.md").version.sha256, file(original,"a.md").version.sha256);
  const accepted = store.get("scan", "latest");
  const list = owner.vault.list.bind(owner.vault); owner.vault.list = () => { throw new Error("private-scan-error"); };
  await assert.rejects(scanner.scan(), error => error.code === "scan-failed" && error.message === "scan-failed"); owner.vault.list = list;
  assert.deepEqual(store.get("scan","latest"), accepted);
  // Earlier file changes while a later file is being read. Do not publish a mixed manifest.
  const read = owner.vault.read.bind(owner.vault); let injected = false;
  owner.vault.read = (name,...args) => { const bytes = read(name,...args); if (!injected && name.endsWith(".bin")) { injected = true; fs.writeFileSync(path.join(vault,"a.md"),"CC"); } return bytes; };
  await assert.rejects(scanner.scan(), { code: "scan-changed" }); owner.vault.read = read;
  assert.deepEqual(store.get("scan","latest"), accepted);
  await scanner.scan(); const beforeFailure = store.get("scan","latest");
  owner.vault.write("a.md",Buffer.from("DD"),"replace"); const commit = store.commit.bind(store); store.commit = () => { throw new Error("private-write-error"); };
  await assert.rejects(scanner.scan(), { code: "scan-failed" }); store.commit = commit; assert.deepEqual(store.get("scan","latest"), beforeFailure);
  const controller = new AbortController(); controller.abort(); await assert.rejects(scanner.scan(controller.signal), { code: "scan-cancelled" });
  fs.unlinkSync(path.join(vault,"a.md")); const absent = await scanner.scan(); assert.equal(file(absent,"a.md"),undefined);
  assert.equal(store.list("operation").length,0); assert.equal(store.list("baseline").length,0, "Observed absence cannot become deletion intent or confirmed baseline");
  // Publication echo must not suppress a later Bot edit.
  const application = new FileApplication(owner,store,"controlled"); await application.prepare("echo","echo.md",Buffer.from("remote"),"note",null); await application.apply("echo");
  const echo = await scanner.scan(); const version = file(echo,"echo.md").version;
  const requests = new LocalRequests(owner,store,"controlled");
  await requests.submit({ requestId:"bot-after-echo",operation:"modify",path:"echo.md",content: Buffer.from("local-edit"), contentKind:"note",expected:{sha256:version.sha256,size:version.size} });
  const edited = await scanner.scan(); assert.notEqual(file(edited,"echo.md").version.sha256,version.sha256);
  // No watcher event is delivered: periodic full scans still find a new file.
  const observations=[]; let found; const ready = new Promise(resolve => {found=resolve;});
  watching=scanner.watch(10,async manifest => { observations.push(manifest); if (file(manifest,"unannounced.md")) found(); },error=>{throw error;});
  fs.writeFileSync(path.join(vault,"unannounced.md"),"periodic");
  let timer; try { await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Periodic scan deadline exceeded")),3000);})]); } finally {clearTimeout(timer);}
  await watching.close(); watching=undefined; const count=observations.length; await new Promise(resolve=>setTimeout(resolve,25)); assert.equal(observations.length,count);
  const persisted=scanner.latest(); store.close(); store=new StateStore(path.join(state,"state.db")); scanner=new VaultScanner(owner,store); assert.deepEqual(scanner.latest(),persisted);
  const snapshots=new SnapshotStore(owner.state); assert.equal(snapshots.read(file(persisted,"echo.md").version).toString(),"local-edit");
  fs.symlinkSync(path.join(root,"outside"),path.join(vault,"symlink.md")); await assert.rejects(scanner.scan(),{code:"scan-failed"}); fs.unlinkSync(path.join(vault,"symlink.md"));
  assert.deepEqual(scanner.latest(),persisted);
  console.log("scanner.test.mjs: full-version collision detection, failed/mixed scans, durable restart, no inferred deletion, publication echo and polling without events passed");
} finally {await watching?.close();store.close();owner.close();fs.rmSync(root,{recursive:true,force:true});}
