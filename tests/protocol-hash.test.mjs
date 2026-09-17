import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as hashes from "../src/lib/utils/protocol_hash.ts";

// Golden outputs were generated from the unmodified release 2.4.0 helper at
// f2b15c09d34e621d2d97ad526fdee03460bac151, not from the extracted module.
const textVectors = [
  ["", "0"], ["abc", "96354"], ["中文", "646394"], ["😀", "1772899"],
  ["line\nnext\r\n", "-2041306650"], ["a".repeat(262145), "1740636257"],
];
const binaryVectors = [
  [0, "0"], [1, "7"], [1024, "2141085696"],
  [10485759, "-1059129417"], [10485760, "1526726656"],
  [10485761, "58720256"], [15728641, "58720256"], [20971520, "142606336"],
];
const source = readFileSync(new URL("../src/lib/utils/helpers.ts", import.meta.url), "utf8");
let currentBytes;
let failRange = false;
let rangeCalls = 0;
let fullReads = 0;
const quiet = () => {};
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module, exports: module.exports,
  window: { setTimeout, clearTimeout }, AbortController,
  require: id => {
    if (id === "./protocol_hash") return hashes;
    if (id === "obsidian") return { Platform: { isMobile: false } };
    if (id === "../../i18n/lang") return { $: key => key };
    if (id === "../../main" || id === "../sync/sync_log_manager") return {};
    if (id === "../helpers_obsidian_bypass") return {
      dump: quiet, dumpError: quiet,
      nativeFetch: async (_url, options) => {
        rangeCalls++;
        if (failRange) throw new Error("Synthetic range failure");
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
        return { status: 206, arrayBuffer: async () => currentBytes.slice(Number(start), Number(end) + 1).buffer };
      },
    };
    throw new Error("Unexpected helper dependency");
  },
});
const plugin = module.exports;
const app = { vault: { adapter: {
  stat: async () => ({ size: currentBytes.byteLength }),
  getResourcePath: () => "synthetic://fixture",
  readBinary: async () => { fullReads++; return currentBytes.slice().buffer; },
} } };

for (const [text, expected] of textVectors) {
  assert.equal(hashes.hashContent(text), expected);
  assert.equal(await hashes.hashContentAsync(text), expected);
  assert.equal(plugin.hashContent(text), expected);
  assert.equal(await plugin.hashContentAsync(text), expected);
}
assert.equal(plugin.hashContent, hashes.hashContent, "Plugin must consume the shared implementation");
let yields = 0;
await hashes.hashContentAsync("a".repeat(262145), async () => { yields++; });
assert.equal(yields, 1);
await hashes.hashArrayBuffer(new ArrayBuffer(524289), async () => { yields++; });
assert.equal(yields, 2);
await assert.rejects(hashes.hashContentAsync("a".repeat(262145), async () => { throw new Error("Synthetic cancellation"); }), /Synthetic cancellation/);

const directory = await mkdtemp(path.join(tmpdir(), "fns-hash-"));
try {
  for (const [size, expected] of binaryVectors) {
    currentBytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) currentBytes[i] = (i * 31 + (i >>> 8) * 17 + 7) & 255;
    assert.equal(await hashes.hashArrayBuffer(currentBytes.buffer), expected);
    assert.equal(await plugin.hashArrayBuffer(currentBytes.buffer), expected);
    rangeCalls = 0;
    fullReads = 0;
    assert.equal(await plugin.hashFileAsync(app, "fixture.bin"), expected);
    assert.equal(rangeCalls, size > 10485760 ? 3 : 0);
    assert.equal(fullReads, size > 10485760 ? 0 : 1);

    const file = path.join(directory, "fixture.bin");
    await writeFile(file, currentBytes);
    const handle = await open(file, "r");
    try {
      const ranges = [];
      assert.equal(await hashes.hashFileContent(size, {
        readAll: async () => {
          const buffer = await handle.readFile();
          return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        },
        readRange: async (offset, length) => {
          ranges.push([offset, length]);
          const bytes = new Uint8Array(length);
          let consumed = 0;
          while (consumed < length) {
            const { bytesRead } = await handle.read(bytes, consumed, length - consumed, offset + consumed);
            assert.ok(bytesRead > 0, "Synthetic file ended before the requested range");
            consumed += bytesRead;
          }
          return bytes.buffer;
        },
      }), expected);
      if (size === 20971520) assert.deepEqual(ranges, [[0, 5242880], [7864320, 5242880], [15728640, 5242880]]);
    } finally { await handle.close(); }
  }

  failRange = true;
  fullReads = 0;
  assert.equal(await plugin.hashFileAsync(app, "fixture.bin"), "142606336");
  assert.equal(fullReads, 1, "Preserve the upstream full-read fallback");
  assert.equal(await plugin.hashFileAsync({ vault: { adapter: { stat: async () => null } } }, "missing.bin"), "0");
  await assert.rejects(hashes.hashFileContent(20971520, {
    readRange: async () => { throw new Error("Synthetic range failure"); },
    readAll: async () => { throw new Error("Synthetic read failure"); },
  }), /Synthetic read failure/);

  // Characterize the accepted upstream limitation; do not fix the wire hash.
  const modified = currentBytes.slice();
  modified[6291456] ^= 1;
  assert.equal(await hashes.hashArrayBuffer(modified.buffer), "142606336");
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  assert.notEqual(digest(modified), digest(currentBytes));
} finally { await rm(directory, { recursive: true, force: true }); }

console.log("protocol-hash.test.mjs: stable vectors and both host paths passed");
