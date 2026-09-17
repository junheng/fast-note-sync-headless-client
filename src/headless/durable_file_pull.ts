import { randomUUID } from "node:crypto";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore } from "./state_store";
import { InitialContents } from "./initial_notes";
import { DownloadBatch } from "./download_batch";
import { pullCollection } from "./pull_collection";
import type { PullConnectionOptions } from "./pull_collection";
import { FilePull } from "./file_pull";
import type { FilePullReceipt } from "./file_pull";

// Identity must be verified by the runtime before any durable receiver starts.
export async function durableFilePull(owner: OwnedDirectories, state: StateStore, writingMode: "controlled" | "exclusive",
  options: Omit<PullConnectionOptions, "onEnd" | "onPage" | "onAbsent">): Promise<FilePullReceipt & { batchId: string }> {
  const target = new InitialContents(owner, state, writingMode);
  const batch = new DownloadBatch(state, randomUUID(), "files");
  try {
    const receipt = await pullCollection({ ...options, onAbsent: options.initialCopy ? path => target.confirmAbsent(path) : undefined, onEnd: async time => { batch.end(time); }, onPage: async index => { batch.page(index); } }, "files",
      config => new FilePull({ ...config, directory: owner.state, onFile: (file, bytes) => target.acceptBytes(file.path, bytes, "file") }));
    batch.complete(receipt.pages, receipt.lastTime);
    return { ...receipt, batchId: batch.id };
  } catch (error) {
    try { batch.interrupt(); } catch { /* Retain the previous durable state. */ }
    throw error;
  }
}
