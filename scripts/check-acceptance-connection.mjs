import { fnsCredentials } from "./lib/fns-credentials.mjs";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { loadBundle } from "../tests/support/load-bundle.mjs";

// Credentials come from Node --env-file or an explicitly supplied JSON file.
// This program never prints an endpoint/token or performs a business write.
const root = path.join(homedir(), ".local", "share", "fns-headless-acceptance");
const allowedErrors = new Set(["invalid-config", "authentication-failed", "connection-failed", "connection-timeout", "cancelled"]);
let connection;
let receipt = { schemaVersion: 1, authenticated: false, synchronization: "not-run", code: "connection-failed" };
try {
  const config = fnsCredentials();
  const { exports: { connectHeadless } } = await loadBundle(path.resolve(import.meta.dirname, "../src/headless/connection.ts"));
  connection = await connectHeadless({ endpoint: config.endpoint, token: config.token });
  receipt = { schemaVersion: 1, authenticated: true, synchronization: "not-run", protobuf: connection.client.useProtobuf };
} catch (error) {
  receipt.code = allowedErrors.has(error?.code) ? error.code : "connection-failed";
  process.exitCode = 2;
} finally { connection?.close(); }
try {
  fs.writeFileSync(path.join(root, "receipts", "connection.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
} catch { process.exitCode = 2; receipt = { schemaVersion: 1, code: "receipt-write-failed", synchronization: "not-run" }; }
console.log(JSON.stringify(receipt));
