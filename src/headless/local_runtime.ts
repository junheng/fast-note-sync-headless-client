import { join } from "node:path";
import { OwnedDirectories } from "./filesystem";
import { StateStore } from "./state_store";
import { LocalRequests, LocalRequestError } from "./local_requests";
import { localControlHandler, startControl } from "./control";

export interface LocalRuntimeConfig {
  vaultDirectory: string;
  stateDirectory: string;
  writingMode: "controlled" | "exclusive";
  createState?: boolean;
}

// Local owner service only; it makes no network requests and no synchronization
// claims. The sync runtime must additionally verify its remote identity binding.
export async function startLocalRuntime(config: LocalRuntimeConfig): Promise<{ close(): Promise<void> }> {
  if (!config || !["controlled", "exclusive"].includes(config.writingMode)) throw new LocalRequestError("local-writer-contract-required");
  const owner = OwnedDirectories.acquire(config.vaultDirectory, config.stateDirectory);
  let state: StateStore | undefined;
  try {
    state = new StateStore(join(config.stateDirectory, "state.db"), { create: config.createState === true });
    const requests = new LocalRequests(owner, state, config.writingMode);
    await requests.recover();
    const control = await startControl(owner, localControlHandler(requests));
    let closing: Promise<void> | undefined;
    return { close: () => closing ??= (async () => {
      await control.close();
      await owner.exclusive(async () => { state!.close(); });
      owner.close();
    })() };
  } catch (error) { state?.close(); owner.close(); throw error; }
}
