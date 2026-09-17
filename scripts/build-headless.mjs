import { build } from "esbuild";
import fs from "node:fs";

const output = "dist/headless/cli.cjs";
const result = await build({ entryPoints: ["scripts/headless-entry.mjs"], outfile: output,
  bundle: true, platform: "node", format: "cjs", target: "node24", metafile: true, write: false });
if (Object.keys(result.metafile.inputs).some(file => /(^|\/)(tests|obsidian)\/|src\/main\.|websocket_obsidian|utils\/helpers\.ts/.test(file))) {
  throw new Error("Headless bundle imported a plugin or test runtime");
}
fs.mkdirSync("dist/headless", { recursive: true });
fs.writeFileSync(output, result.outputFiles[0].contents);
console.log("Headless CLI built: dist/headless/cli.cjs");
