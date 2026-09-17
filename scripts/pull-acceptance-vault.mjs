import { loadBundle } from "../tests/support/load-bundle.mjs";
// Developer-only wrapper. The container ships the prebuilt CLI, without tests
// or a runtime dependency on esbuild.
const { exports: { runInitialCopy } } = await loadBundle("scripts/lib/initial-copy.mjs");
await runInitialCopy({ acceptance: true });
