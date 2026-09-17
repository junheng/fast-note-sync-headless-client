import { loadBundle } from "./load-bundle.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { vault, state, hold } = JSON.parse(input);
const { exports: { OwnedDirectories } } = await loadBundle("src/headless/filesystem.ts");
try {
  const owner = OwnedDirectories.acquire(vault, state);
  process.stdout.write(JSON.stringify({ status: "owned" }) + "\n");
  if (hold) setInterval(() => {}, 1000);
  else owner.close();
} catch (error) {
  process.stdout.write(JSON.stringify({ status: "rejected", code: error.code }) + "\n");
  process.exitCode = 2;
}
