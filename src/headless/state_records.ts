import { Buffer } from "node:buffer";

// Durable metadata contains references to external immutable snapshots, never
// credentials or note bodies. Protocol operators own transition validation.
export interface FileVersion {
  sha256: string;
  size: number;
  protocolHash: string;
  snapshotId: string;
}

interface RecordHeader {
  formatVersion: 1;
  id: string;
}

export interface BindingRecord extends RecordHeader {
  kind: "binding";
  endpoint: string;
  serviceId: string | null;
  subjectId: string;
  vaultId: string | null;
  vaultName: string;
  directory: { path: string; device: string; inode: string };
}

export interface OperationRecord extends RecordHeader {
  kind: "operation";
  path: string;
  action: "create" | "modify" | "delete" | "rename";
  targetPath: string | null;
  status: "pending" | "sent" | "blocked" | "acknowledged";
  base: FileVersion | null;
  desired: FileVersion | null;
  expectedRemote: FileVersion | null;
  sessionId: string | null;
  context: string;
  sequence?: number;
}

export interface BaselineRecord extends RecordHeader {
  kind: "baseline";
  path: string;
  version: FileVersion | null;
  confirmedOperationId: string;
}

export interface BatchRecord extends RecordHeader {
  kind: "batch";
  sessionId: string;
  collection: "notes" | "files" | "folders";
  checkpointBefore: number;
  checkpointTarget: number | null;
  expectedPages: number | null;
  completedPages: number[];
  pendingOperationIds: string[];
  endReceived: boolean;
  status: "receiving" | "blocked" | "committed";
}

export interface SessionRecord extends RecordHeader {
  kind: "session";
  generation: number;
  status: "active" | "interrupted" | "completed";
}

export interface ApplicationRecord extends RecordHeader {
  kind: "application";
  path: string;
  contentKind: "note" | "file";
  before: FileVersion | null;
  after: FileVersion;
  observed: FileVersion | null;
  status: "prepared" | "applied" | "diverged";
}

export interface ConflictRecord extends RecordHeader {
  kind: "conflict";
  path: string;
  contentKind: "note" | "file";
  baseStatus: "missing" | "absent" | "present";
  base: FileVersion | null;
  local: FileVersion | null;
  remote: FileVersion | null;
  status: "open";
}

export interface LocalRequestRecord extends RecordHeader {
  kind: "local-request";
  fingerprint: string;
  operation: "create" | "modify" | "delete" | "rename";
  path: string;
  targetPath: string | null;
  contentKind: "note" | "file";
  before: FileVersion | null;
  beforeIdentity: string | null;
  after: FileVersion | null;
  status: "prepared" | "applied" | "stale";
  reason: "source-version" | "target-exists" | null;
}

export interface ScanRecord extends RecordHeader {
  kind: "scan";
  manifest: FileVersion;
  fileCount: number;
  directoryCount: number;
  byteCount: number;
}

export interface ReconciliationRecord extends RecordHeader {
  kind: "reconcile";
  path: string;
  before: FileVersion | null;
  after: FileVersion | null;
  status: "prepared" | "committed" | "diverged";
}
export interface CycleRecord extends RecordHeader {
  kind: "cycle";
  completedAt: number;
  noteTime: number;
  fileTime: number;
  fileCount: number;
}
export type StateRecord = BindingRecord | OperationRecord | BaselineRecord | BatchRecord | SessionRecord | ApplicationRecord | ConflictRecord | LocalRequestRecord | ScanRecord | ReconciliationRecord | CycleRecord;
export type RecordKind = StateRecord["kind"];

const digestPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const validIdentifier = (value: unknown): value is string => typeof value === "string" && identifierPattern.test(value);
export const RECORD_KINDS: RecordKind[] = ["binding", "operation", "baseline", "batch", "session", "application", "conflict", "local-request", "scan", "reconcile", "cycle"];
export const validRecordKind = (value: unknown): value is RecordKind => RECORD_KINDS.includes(value as RecordKind);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

// Reject noncanonical paths; do not silently normalize an intent into a
// different path. Filesystem identity and symlink checks belong to the host.
export function validRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 &&
    !/[\\:*?"<>|]/.test(value) && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part));
}

function fields(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

export function validFileVersion(value: unknown): value is FileVersion | null {
  if (value === null) return true; // Missing baseline and deletion are explicit.
  return object(value) && fields(value, ["sha256", "size", "protocolHash", "snapshotId"]) &&
    typeof value.sha256 === "string" && digestPattern.test(value.sha256) &&
    integer(value.size) && typeof value.protocolHash === "string" && /^-?\d{1,11}$/.test(value.protocolHash) &&
    value.snapshotId === value.sha256;
}

export function validStateRecord(value: unknown): value is StateRecord {
  if (!object(value) || value.formatVersion !== 1 || !validIdentifier(value.id) || !validRecordKind(value.kind)) return false;
  const header = ["formatVersion", "id", "kind"];
  switch (value.kind) {
    case "reconcile":
      return fields(value, [...header, "path", "before", "after", "status"]) && validRelativePath(value.path) &&
        validFileVersion(value.before) && validFileVersion(value.after) && (value.before !== null || value.after !== null) &&
        ["prepared", "committed", "diverged"].includes(value.status as string);
    case "cycle":
      return fields(value, [...header, "completedAt", "noteTime", "fileTime", "fileCount"]) && value.id === "latest" &&
        integer(value.completedAt) && integer(value.noteTime) && integer(value.fileTime) && integer(value.fileCount) && value.fileCount <= 10000;
    case "binding":
      return fields(value, [...header, "endpoint", "serviceId", "subjectId", "vaultId", "vaultName", "directory"]) &&
        value.id === "identity" && typeof value.endpoint === "string" && value.endpoint.length <= 4096 &&
        (value.serviceId === null || validIdentifier(value.serviceId)) && validIdentifier(value.subjectId) && (value.vaultId === null || validIdentifier(value.vaultId)) &&
        typeof value.vaultName === "string" && value.vaultName.length > 0 && value.vaultName.length <= 1024 &&
        object(value.directory) && fields(value.directory, ["path", "device", "inode"]) &&
        typeof value.directory.path === "string" && value.directory.path.startsWith("/") && value.directory.path.length <= 4096 &&
        typeof value.directory.device === "string" && /^\d+$/.test(value.directory.device) &&
        typeof value.directory.inode === "string" && /^\d+$/.test(value.directory.inode);
    case "scan":
      return fields(value, [...header, "manifest", "fileCount", "directoryCount", "byteCount"]) && value.manifest !== null && validFileVersion(value.manifest) &&
        integer(value.fileCount) && integer(value.directoryCount) && value.fileCount + value.directoryCount <= 10000 && integer(value.byteCount) && value.byteCount <= 256 * 1024 * 1024;
    case "operation":
      return fields(value, [...header, "path", "action", "targetPath", "status", "base", "desired", "expectedRemote", "sessionId", "context", ...(Object.hasOwn(value, "sequence") ? ["sequence"] : [])]) &&
        (value.sequence === undefined || integer(value.sequence) && value.sequence > 0) &&
        validRelativePath(value.path) && ["create", "modify", "delete", "rename"].includes(value.action as string) &&
        ["pending", "sent", "blocked", "acknowledged"].includes(value.status as string) &&
        validFileVersion(value.base) && validFileVersion(value.desired) && validFileVersion(value.expectedRemote) &&
        (value.action === "delete" ? value.desired === null : value.desired !== null) &&
        (value.action === "rename" ? validRelativePath(value.targetPath) && value.targetPath !== value.path : value.targetPath === null) &&
        (value.sessionId === null || validIdentifier(value.sessionId)) && validIdentifier(value.context);
    case "baseline":
      return fields(value, [...header, "path", "version", "confirmedOperationId"]) && validRelativePath(value.path) &&
        validFileVersion(value.version) && validIdentifier(value.confirmedOperationId);
    case "batch": {
      if (!fields(value, [...header, "sessionId", "collection", "checkpointBefore", "checkpointTarget", "expectedPages", "completedPages", "pendingOperationIds", "endReceived", "status"])) return false;
      const pages = value.completedPages;
      const pending = value.pendingOperationIds;
      return validIdentifier(value.sessionId) && ["notes", "files", "folders"].includes(value.collection as string) &&
        integer(value.checkpointBefore) && (value.checkpointTarget === null || integer(value.checkpointTarget)) &&
        (value.expectedPages === null || integer(value.expectedPages)) &&
        Array.isArray(pages) && pages.length <= 10000 && pages.every(integer) && new Set(pages).size === pages.length &&
        (value.expectedPages === null || pages.every(page => page < (value.expectedPages as number))) &&
        Array.isArray(pending) && pending.length <= 10000 && pending.every(validIdentifier) && new Set(pending).size === pending.length &&
        typeof value.endReceived === "boolean" && ["receiving", "blocked", "committed"].includes(value.status as string) &&
        (value.status !== "committed" || (value.endReceived && value.checkpointTarget !== null && value.expectedPages === pages.length && pending.length === 0));
    }
    case "session":
      return fields(value, [...header, "generation", "status"]) && integer(value.generation) &&
        ["active", "interrupted", "completed"].includes(value.status as string);
    case "application":
      return fields(value, [...header, "path", "contentKind", "before", "after", "observed", "status"]) && validRelativePath(value.path) &&
        ["note", "file"].includes(value.contentKind as string) && validFileVersion(value.before) && value.after !== null &&
        validFileVersion(value.after) && validFileVersion(value.observed) && ["prepared", "applied", "diverged"].includes(value.status as string) &&
        (value.status === "diverged" || value.observed === null);
    case "conflict":
      return fields(value, [...header, "path", "contentKind", "baseStatus", "base", "local", "remote", "status"]) &&
        validRelativePath(value.path) && ["note", "file"].includes(value.contentKind as string) && value.status === "open" &&
        ["missing", "absent", "present"].includes(value.baseStatus as string) && validFileVersion(value.base) &&
        (value.baseStatus === "present" ? value.base !== null : value.base === null) &&
        validFileVersion(value.local) && validFileVersion(value.remote) &&
        value.local?.sha256 !== value.remote?.sha256;
    case "local-request":
      return fields(value, [...header, "fingerprint", "operation", "path", "targetPath", "contentKind", "before", "beforeIdentity", "after", "status", "reason"]) &&
        typeof value.fingerprint === "string" && digestPattern.test(value.fingerprint) && validRelativePath(value.path) &&
        ["create", "modify", "delete", "rename"].includes(value.operation as string) && ["note", "file"].includes(value.contentKind as string) &&
        validFileVersion(value.before) && validFileVersion(value.after) &&
        (value.before === null ? value.beforeIdentity === null : typeof value.beforeIdentity === "string" && /^\d+:\d+$/.test(value.beforeIdentity)) &&
        (value.operation === "rename" ? validRelativePath(value.targetPath) && value.targetPath !== value.path : value.targetPath === null) &&
        ["prepared", "applied", "stale"].includes(value.status as string) &&
        (value.status === "stale" ? ["source-version", "target-exists"].includes(value.reason as string) : value.reason === null) &&
        (value.status === "stale" || (value.operation === "delete" ? value.after === null && value.before !== null : value.after !== null));
  }
}
