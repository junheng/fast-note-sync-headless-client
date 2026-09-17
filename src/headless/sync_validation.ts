import { validRelativePath } from "./state_records";
export const validSyncPath = (path: unknown): path is string => validRelativePath(path) && !path.split("/").some(part => [".obsidian", ".git"].includes(part.toLowerCase()));
export const nonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
