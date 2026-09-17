import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Execute a real Node bundle without a VM or Obsidian runtime substitute.
export async function loadBundle(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", target: "node24", write: false, metafile: true, logLevel: "silent" });
  const directory = await mkdtemp(path.join(tmpdir(), "fns-node-bundle-"));
  try {
    const file = path.join(directory, "entry.cjs");
    await writeFile(file, result.outputFiles[0].contents);
    return { exports: (await import(pathToFileURL(file).href)).default, inputs: Object.keys(result.metafile.inputs) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
