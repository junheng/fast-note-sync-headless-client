import { join } from "node:path";
import { lstatSync, existsSync } from "node:fs";
import { OwnedDirectories } from "./filesystem";
import { StateStore } from "./state_store";
import { IdentityBinding } from "./identity";
import { UpstreamRemote } from "./remote";
import type { PullConnectionOptions } from "./pull_collection";
import { SyncCoordinator } from "./reconcile";
import { localControlHandler, startControl, ControlError } from "./control";
import type { ConflictDecision } from "./resolution";

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
            if (Object.keys(envelope).length === 3 && envelope.schemaVersion === 1 && envelope.request && typeof envelope.request === "object" && !Array.isArray(envelope.request)) {
              const request = envelope.request as Record<string, unknown>;
              if (envelope.action === "conflict-list" && Object.keys(request).every(key => ["afterId", "limit"].includes(key))) return sync.resolver.list(request.afterId as string | undefined, request.limit as number | undefined);
              if (envelope.action === "conflict-detail" && Object.keys(request).join() === "conflictId") return sync.resolver.detail(request.conflictId as string);
              if (envelope.action === "decision-status" && Object.keys(request).join() === "decisionId") return sync.resolver.decision(request.decisionId as string);
              if (envelope.action === "conflict-snapshot" && Object.keys(request).sort().join() === "conflictId,length,offset,side") return sync.resolver.snapshot(request.conflictId as string, request.side as "base" | "local" | "remote", request.offset as number, request.length as number);
              if (envelope.action === "resolve") return sync.resolve(request as unknown as ConflictDecision, config.signal);
            }
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
