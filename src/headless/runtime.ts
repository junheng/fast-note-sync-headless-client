import { join } from "node:path";
import { lstatSync, existsSync } from "node:fs";
import { OwnedDirectories } from "./filesystem";
import { StateStore } from "./state_store";
import { IdentityBinding } from "./identity";
import { UpstreamRemote } from "./remote";
import type { PullConnectionOptions } from "./pull_collection";
import { SyncCoordinator } from "./reconcile";
import { localControlHandler, startControl, ControlError } from "./control";

export interface RuntimeConfig extends PullConnectionOptions {
  vaultDirectory: string;
  stateDirectory: string;
  writingMode: "controlled" | "exclusive";
}
export class RuntimeError extends Error {
  constructor(public readonly code: "local-writer-contract-required" | "invalid-config" | "state-permissions") { super(code); this.name = "RuntimeError"; }
}
export async function openSyncRuntime(config: RuntimeConfig) {
  if (!["controlled", "exclusive"].includes(config.writingMode)) throw new RuntimeError("local-writer-contract-required");
  if (!config.vaultDirectory || !config.stateDirectory) throw new RuntimeError("invalid-config");
  const owner = OwnedDirectories.acquire(config.vaultDirectory, config.stateDirectory);
  let state: StateStore | undefined, control: Awaited<ReturnType<typeof startControl>> | undefined;
  try {
    if ((lstatSync(config.stateDirectory).mode & 0o077) !== 0) throw new RuntimeError("state-permissions");
    const database = join(config.stateDirectory, "state.db");
    state = new StateStore(database, { create: !existsSync(database) });
    const identity = new IdentityBinding(owner, state, config.endpoint, config.vault);
    const remote = new UpstreamRemote(owner, state, identity, config);
    const sync = new SyncCoordinator(owner, state, identity, remote, config.writingMode);
    // Neither pending replay nor a writable local socket is enabled before the
    // authenticated binding is checked. Failed authentication preserves state.
    await remote.authenticate(config.signal);
    await sync.requests.recover();
    const local = localControlHandler(sync.requests);
    let closing: Promise<void> | undefined;
    return {
      sync,
      async listen(): Promise<void> {
        if (control || closing) throw new ControlError("control-unavailable");
        control = await startControl(owner, async input => {
          if (input && typeof input === "object" && !Array.isArray(input)) {
            const envelope = input as Record<string, unknown>;
            if (Object.keys(envelope).length === 2 && envelope.schemaVersion === 1 && envelope.action === "status") return sync.status();
          }
          return local(input);
        });
      },
      close(): Promise<void> {
        return closing ??= (async () => { await control?.close(); await owner.exclusive(async () => state!.close()); owner.close(); })();
      },
    };
  } catch (error) { state?.close(); owner.close(); throw error; }
}
