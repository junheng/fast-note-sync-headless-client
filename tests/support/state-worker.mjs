import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { loadBundle } from "./load-bundle.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { file, mode, record } = JSON.parse(input);
if (mode === "committed") {
  const { exports: { StateStore } } = await loadBundle("src/headless/state_store.ts");
  const store = new StateStore(file);
  store.commit([{ type: "put", record, expectedRevision: null }]);
} else {
  // Exercise actual SQLite hot-journal recovery, including a dirty cache spill.
  const database = new DatabaseSync(file);
  database.exec("PRAGMA cache_size = 1; BEGIN IMMEDIATE");
  const payload = JSON.stringify(record);
  database.prepare("INSERT INTO records VALUES (?, ?, 1, 1, ?, ?)").run(record.kind, record.id, payload, createHash("sha256").update(payload).digest("hex"));
}
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
