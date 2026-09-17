import { NotePull } from "./note_pull";
import type { PulledNote, NotePullReceipt } from "./note_pull";
import { pullCollection } from "./pull_collection";
import type { PullConnectionOptions } from "./pull_collection";
export interface PullNotesOptions extends PullConnectionOptions {
  onNote(note: PulledNote): Promise<"applied" | "unchanged" | "conflict">;
}
export async function pullNotes(options: PullNotesOptions): Promise<NotePullReceipt> {
  return await pullCollection(options, "notes", config => new NotePull({ ...config, onNote: note => options.onNote(note) }));
}
