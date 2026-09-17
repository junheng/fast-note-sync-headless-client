import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBundle } from "./support/load-bundle.mjs";

const { exports: { OwnedDirectories, SafeDirectory } } = await loadBundle("src/headless/filesystem.ts");
const root = fs.mkdtempSync(path.join(tmpdir(), "fns-filesystem-"));
const vault = path.join(root, "vault"), state = path.join(root, "state"), state2 = path.join(root, "state2"), vault2 = path.join(root, "vault2"), outside = path.join(root, "outside");
for (const directory of [vault, state, state2, vault2, outside]) fs.mkdirSync(directory, { mode: 0o700 });
const expect = (fn, code) => assert.throws(fn, error => error.code === code && error.message === code);
const bytes = value => Buffer.from(value);
let owner;
let child;
async function worker(vaultPath, statePath, hold = false) {
  const process = spawn(globalThis.process.execPath, ["tests/support/ownership-worker.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((resolve, reject) => { process.on("exit", (code, signal) => resolve({ code, signal })); process.on("error", reject); });
  const timer = setTimeout(() => process.kill("SIGKILL"), 10000);
  const result = await new Promise((resolve, reject) => {
    let output = "";
    process.on("error", reject);
    process.on("exit", () => { if (!output.includes("\n")) reject(new Error("Ownership worker failed before receipt")); });
    process.stdout.on("data", data => {
      output += data;
      if (output.includes("\n")) resolve(JSON.parse(output.trim()));
    });
    process.stdin.end(JSON.stringify({ vault: vaultPath, state: statePath, hold }));
  }).finally(() => clearTimeout(timer));
  return { process, result, exited };
}
try {
  owner = OwnedDirectories.acquire(vault, state);
  owner.vault.write("synthetic.md", bytes("original"), "create");
  assert.equal(owner.vault.read("synthetic.md").toString(), "original");
  owner.vault.write("synthetic.md", bytes("replacement"), "replace");
  assert.equal(owner.vault.read("synthetic.md").toString(), "replacement");
  expect(() => owner.vault.write("synthetic.md", bytes("lost"), "create"), "already-exists");
  assert.equal(owner.vault.read("synthetic.md").toString(), "replacement");
  owner.vault.createDirectory("nested");
  owner.vault.write("nested/note.md", bytes("nested"), "create");
  assert.deepEqual(owner.vault.list("nested"), ["note.md"]);
  expect(() => owner.vault.read("synthetic.md", 1), "filesystem-limit");
  assert.equal(owner.vault.readRange("synthetic.md", 2, 4).toString(), "plac");
  assert.equal(owner.vault.readRange("synthetic.md", 11, 0).length, 0);
  for (const [start, length] of [[-1, 1], [0, 12], [10, 2], [Number.MAX_SAFE_INTEGER, 1]]) expect(() => owner.vault.readRange("synthetic.md", start, length), "filesystem-limit");
  const originalRead = fs.readSync;
  let replacedLeaf = false;
  fs.readSync = function(...args) {
    const count = originalRead.apply(this, args);
    if (!replacedLeaf) {
      replacedLeaf = true;
      fs.renameSync(path.join(vault, "synthetic.md"), path.join(vault, "previous.md"));
      fs.writeFileSync(path.join(vault, "synthetic.md"), "replacement");
    }
    return count;
  };
  try { expect(() => owner.vault.readRange("synthetic.md", 0, 4), "filesystem-failed"); }
  finally { fs.readSync = originalRead; }

  for (const relative of ["../outside/note.md", "/outside.md", "C:\\outside.md", "nested/../synthetic.md", "nested//note.md", "nested/./note.md", "bad\0name", ".fns-headless-private", "trailing."]) {
    expect(() => owner.vault.write(relative, bytes("must-not-write"), "create"), "invalid-path");
  }
  expect(() => OwnedDirectories.acquire(vault, path.join(vault, "nested")), "invalid-root");

  for (const [v, s] of [[vault, state2], [vault2, state]]) {
    const rejected = await worker(v, s);
    assert.deepEqual(rejected.result, { status: "rejected", code: "ownership-conflict" });
    assert.equal((await rejected.exited).code, 2);
  }
  assert.equal(fs.readdirSync(state2).length, 0, "Rejected owner must not create state");

  fs.writeFileSync(path.join(outside, "note.md"), "external-preserved");
  fs.symlinkSync(path.join(outside, "note.md"), path.join(vault, "link.md"));
  fs.symlinkSync(outside, path.join(vault, "link-dir"));
  expect(() => owner.vault.read("link.md"), "unsafe-path");
  expect(() => owner.vault.write("link.md", bytes("escaped"), "replace"), "unsafe-path");
  expect(() => owner.vault.write("link-dir/note.md", bytes("escaped"), "replace"), "unsafe-path");
  fs.linkSync(path.join(outside, "note.md"), path.join(vault, "hardlink.md"));
  expect(() => owner.vault.read("hardlink.md"), "unsafe-path");
  expect(() => owner.vault.write("hardlink.md", bytes("escaped"), "replace"), "unsafe-path");

  fs.writeFileSync(path.join(vault, "Case.md"), "case");
  expect(() => owner.vault.write("case.md", bytes("case"), "create"), "case-collision");
  // A read-only lookup treats a differently cased sibling as absent; it never
  // returns the variant's bytes, and publishing still refuses the variant.
  assert.equal(owner.vault.readOptional("case.md"), null);
  assert.equal(owner.vault.readOptional("Case.md").toString(), "case");
  fs.writeFileSync(path.join(vault, "case.md"), "collision");
  expect(() => owner.vault.list(), "case-collision");
  fs.unlinkSync(path.join(vault, "case.md"));
  fs.writeFileSync(path.join(vault, "é.md"), "unicode");
  expect(() => owner.vault.write("e\u0301.md", bytes("collision"), "create"), "case-collision");

  // Replace an intermediate directory after its descriptor has been opened.
  // The real filesystem calls still execute; only the timing is injected.
  const originalOpen = fs.openSync;
  let replaced = false;
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (!replaced && typeof file === "string" && file.startsWith("/proc/self/fd/") && file.endsWith("/nested")) {
      replaced = true;
      fs.renameSync(path.join(vault, "nested"), path.join(vault, "nested-original"));
      fs.symlinkSync(outside, path.join(vault, "nested"));
    }
    return fd;
  };
  try { expect(() => owner.vault.write("nested/note.md", bytes("escaped"), "replace"), "identity-mismatch"); }
  finally { fs.openSync = originalOpen; }
  assert.ok(replaced);
  assert.equal(fs.readFileSync(path.join(outside, "note.md"), "utf8"), "external-preserved");
  assert.equal(fs.readFileSync(path.join(vault, "nested-original/note.md"), "utf8"), "nested");

  // A partial temporary write must not publish a new target or replace one.
  const originalWrite = fs.writeSync;
  fs.writeSync = () => { throw Object.assign(new Error("synthetic-disk-full"), { code: "ENOSPC" }); };
  try {
    expect(() => owner.vault.write("failed-create.md", bytes("partial"), "create"), "filesystem-failed");
    expect(() => owner.vault.write("synthetic.md", bytes("partial"), "replace"), "filesystem-failed");
  } finally { fs.writeSync = originalWrite; }
  assert.equal(fs.existsSync(path.join(vault, "failed-create.md")), false);
  assert.equal(owner.vault.read("synthetic.md").toString(), "replacement");
  assert.ok(!fs.readdirSync(vault).some(name => name.startsWith(".fns-headless-")));

  fs.renameSync(vault, `${vault}-old`);
  fs.mkdirSync(vault);
  expect(() => owner.vault.read("synthetic.md"), "identity-mismatch");
  owner.close(); owner = null;
  const alias = path.join(root, "alias");
  fs.symlinkSync(vault, alias);
  expect(() => SafeDirectory.open(alias), "unsafe-path");

  child = await worker(vault, state, true);
  assert.equal(child.result.status, "owned");
  expect(() => OwnedDirectories.acquire(vault, state2), "ownership-conflict");
  child.process.kill("SIGKILL");
  assert.equal((await child.exited).signal, "SIGKILL");
  child = null;
  owner = OwnedDirectories.acquire(vault, state2);
  owner.close(); owner = null;
  console.log("filesystem.test.mjs: confined I/O, replacements, collisions, independent owners and crash release passed");
} finally {
  owner?.close();
  child?.process.kill("SIGKILL");
  fs.rmSync(root, { recursive: true, force: true });
}
