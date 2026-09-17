import { loadBundle } from "./load-bundle.mjs";

// A subprocess fixture: synthetic credentials arrive over stdin, never argv.
let connection;
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16384) throw new Error("Oversized fixture");
  }
  const { exports: { connectHeadless } } = await loadBundle("src/headless/connection.ts");
  connection = await connectHeadless(JSON.parse(input));
  console.log(JSON.stringify({ status: "authenticated", synchronizationStarted: false }));
} catch (error) {
  const code = ["authentication-failed", "connection-failed", "connection-timeout", "invalid-config", "cancelled"].includes(error?.code) ? error.code : "fixture-failed";
  console.error(JSON.stringify({ status: "error", code }));
  process.exitCode = 2;
} finally { connection?.close(); }
