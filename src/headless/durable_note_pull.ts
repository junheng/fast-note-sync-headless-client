import { randomUUID } from "node:crypto";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore } from "./state_store";
import { InitialNotes } from "./initial_notes";
import { DownloadBatch } from "./download_batch";
import { pullNotes } from "./pull_notes";
import type { PullNotesOptions } from "./pull_notes";
import type { NotePullReceipt } from "./note_pull";

// The runtime must validate remote/local identity before calling this receiver.
// Recovery starts a full read (lastTime=0); incomplete pages are never skipped.
export async function durableNotePull(owner: OwnedDirectories, state: StateStore, writingMode: "controlled" | "exclusive",
  options: Omit<PullNotesOptions, "onNote" | "onEnd" | "onPage" | "onAbsent">): Promise<NotePullReceipt & { batchId: string }> {
  const target = new InitialNotes(owner, state, writingMode);
  const batch = new DownloadBatch(state, randomUUID(), "notes");
  try {
    const receipt = await pullNotes({ ...options, onAbsent: options.initialCopy ? path => target.confirmAbsent(path) : undefined, onNote: note => target.accept(note),
      onEnd: async time => { batch.end(time); }, onPage: async index => { batch.page(index); } });
    batch.complete(receipt.pages, receipt.lastTime);
    return { ...receipt, batchId: batch.id };
  } catch (error) {
    // If storage itself failed, retain the last durable receiving state instead
    // of hiding the original failure or pretending interruption was committed.
    try { batch.interrupt(); } catch { /* The next start sees incomplete state. */ }
    throw error;
  }
}
