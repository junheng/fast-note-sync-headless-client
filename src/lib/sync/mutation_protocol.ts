import { hashContent } from "../utils/protocol_hash";

// Shared official note/file deletion and rename payloads. No additional CAS
// fields are invented: concurrency guarantees remain those of the service.
export function pathMutation(vault: string, path: string) {
  return { vault, path, pathHash: hashContent(path) };
}
export function renameMutation(vault: string, oldPath: string, path: string) {
  return { ...pathMutation(vault, path), oldPath, oldPathHash: hashContent(oldPath) };
}
