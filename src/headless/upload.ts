import { randomUUID } from "node:crypto";
import { connectHeadless } from "./connection";
import type { AuthorizedConnection, ConnectionOptions } from "./connection";
import type { OwnedDirectories } from "./filesystem";
import type { StateStore } from "./state_store";
import type { IdentityBinding, RemoteIdentity } from "./identity";
import type { FileVersion, OperationRecord } from "./state_records";
import { DurableOutbox, sameVersion } from "./outbox";
import { SnapshotStore } from "./snapshots";
import { noteModification } from "../lib/sync/note_protocol";
import { fileUploadCheck, encodeFileChunk, BINARY_PREFIX_FILE_SYNC } from "../lib/sync/file_protocol";
import { hashContent } from "../lib/utils/protocol_hash";
import { CLIENT_TYPE } from "../lib/utils/types";
import { pathMutation, renameMutation } from "../lib/sync/mutation_protocol";

export class UploadError extends Error {
  constructor(public readonly code: "remote-version-changed" | "upload-failed" | "upload-timeout" | "upload-cancelled" | "upload-limit" | "invalid-upload-message") {
    super(code); this.name = "UploadError";
  }
}

export interface UploadOptions extends Omit<ConnectionOptions, "onMessage" | "onDisconnect" | "onFileChunk"> {
  vault: string;
  transferTimeoutMs?: number;
  verifyIdentity(signal: AbortSignal): Promise<RemoteIdentity>;
  // Full bytes must be durably snapshotted by this authenticated readback.
  // A missing hash or unknown/history-expired result must throw, not return null.
  readBack(path: string, signal: AbortSignal): Promise<FileVersion | null>;
}
export interface UploadReceipt { status: "confirmed"; operationId: string; recovered: boolean }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const activeOwners = new WeakSet<OwnedDirectories>();

// One immutable operation per connection. Even an upstream Ack without context
// cannot accidentally acknowledge another operation or a later local version.
// A timeout leaves the sent intent intact; retry checks full remote content first.
export async function uploadOperation(owner: OwnedDirectories, state: StateStore, identity: IdentityBinding,
  operationId: string, options: UploadOptions): Promise<UploadReceipt> {
  if (activeOwners.has(owner)) throw new UploadError("upload-failed");
  identity.assertConnection(options.endpoint, options.vault);
  const stored = state.get("operation", operationId);
  if (!stored || stored.record.kind !== "operation" || stored.record.status === "acknowledged") throw new UploadError("upload-failed");
  const duration = options.transferTimeoutMs ?? 60000;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > 300000) throw new UploadError("upload-limit");
  const outbox = new DurableOutbox(owner, state, identity), snapshots = new SnapshotStore(owner.state);
  const controller = new AbortController();
  let connection: AuthorizedConnection | undefined, active: OperationRecord | undefined;
  let stopped: UploadError | undefined, sent = false, uploadStarted = false, chunksCompleted = false;
  let chunkWork: Promise<void> = Promise.resolve();
  let bytes: Uint8Array = new Uint8Array();
  let infoResolve!: () => void, infoReject!: (error: Error) => void;
  let ackResolve!: () => void, ackReject!: (error: Error) => void;
  const info = new Promise<void>((resolve, reject) => { infoResolve = resolve; infoReject = reject; });
  const ack = new Promise<void>((resolve, reject) => { ackResolve = resolve; ackReject = reject; });
  void info.catch(() => {}); void ack.catch(() => {});
  const fail = (error: UploadError) => {
    if (stopped) return;
    stopped = error; infoReject(error); ackReject(error); controller.abort(); connection?.close(); identity.invalidate();
  };
  const abort = () => fail(new UploadError("upload-cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail(new UploadError("upload-timeout")), duration);
  const live = () => { if (stopped) throw stopped; identity.assertVerified(); };
  activeOwners.add(owner);
  try {
    if (options.signal?.aborted) throw new UploadError("upload-cancelled");
    connection = await connectHeadless({ ...options, signal: controller.signal,
      onDisconnect: () => fail(new UploadError("upload-failed")),
      onMessage: (action, input) => {
        if (stopped) return;
        if (!object(input)) { fail(new UploadError("invalid-upload-message")); return; }
        if (input.vault && input.vault !== options.vault) return;
        if (input.context && input.context !== active?.context) return;
        if (action === "ClientInfo" && !sent) {
          if (typeof input.code === "number" && input.code > 0 && input.code < 300) infoResolve();
          else fail(new UploadError("upload-failed"));
          return;
        }
        if (!sent || !active) return;
        if (typeof input.code !== "number" || input.code < 1 || input.code >= 300) {
          fail(new UploadError(input.code === 530 ? "remote-version-changed" : "upload-failed")); return;
        }
        const data = input.data;
        const resultPath = active.targetPath ?? active.path;
        if (!object(data) || data.path !== resultPath) return;
        const note = active.path.endsWith(".md");
        const ackAction = (note ? "Note" : "File") + (active.action === "delete" ? "DeleteAck" : active.action === "rename" ? "RenameAck" : note ? "ModifyAck" : "UploadAck");
        if (action === ackAction) {
          // A FileUploadCheck can acknowledge already-present content without
          // requesting chunks. Once requested, all chunks must first be sent.
          if (!note && uploadStarted && !chunksCompleted) { fail(new UploadError("invalid-upload-message")); return; }
          ackResolve(); return;
        }
        if (action !== "FileUpload" || note) return;
        if (uploadStarted || data.pathHash !== hashContent(active.path) || typeof data.sessionId !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(data.sessionId) || !Number.isSafeInteger(data.chunkSize) ||
            (data.chunkSize as number) < 1 || (data.chunkSize as number) > 8 * 1024 * 1024) {
          fail(new UploadError("invalid-upload-message")); return;
        }
        uploadStarted = true;
        const chunkSize = data.chunkSize as number, sessionId = data.sessionId;
        const total = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
        if (total > 50000) { fail(new UploadError("upload-limit")); return; }
        chunkWork = (async () => {
          // Restart deliberately requests a fresh server session. Immutable
          // bytes and sent intent survive; unverified chunk offsets do not.
          for (let index = 0; index < total; index++) {
            live();
            const frame = encodeFileChunk(sessionId, index, bytes.subarray(index * chunkSize, (index + 1) * chunkSize));
            const result = await connection!.client.SendBinary(frame, BINARY_PREFIX_FILE_SYNC, undefined,
              () => { if (index === total - 1) chunksCompleted = true; });
            if (result !== "sent") throw new UploadError("upload-failed");
          }
        })().catch(error => fail(error instanceof UploadError ? error : new UploadError("upload-failed")));
      },
    });
    const evidence = await options.verifyIdentity(controller.signal);
    if (stopped) throw stopped;
    await owner.exclusive(async () => identity.verify(evidence));
    const original = stored.record;
    const note = original.path.endsWith(".md");
    if (original.desired && original.desired.size > (note ? 20 : 32) * 1024 * 1024) throw new UploadError("upload-limit");
    if (original.desired) bytes = snapshots.read(original.desired);
    connection.client.Send("ClientInfo", { name: "headless", version: "2.4.0", type: CLIENT_TYPE, isDesktop: true, isLinux: true,
      protobuf: options.protobufEnabled !== false, offlineSyncStrategy: "manualMerge" });
    await info; live();
    const before = await options.readBack(original.path, controller.signal); live();
    const targetBefore = original.targetPath ? await options.readBack(original.targetPath, controller.signal) : null; live();
    const recovered = original.action === "rename" ? before === null && sameVersion(targetBefore, original.desired) : sameVersion(before, original.desired);
    if (!recovered && (!sameVersion(before, original.expectedRemote) || targetBefore !== null)) {
      await outbox.block(operationId); throw new UploadError("remote-version-changed");
    }
    // This commit must finish before either text or binary can leave the client.
    active = await outbox.sent(operationId, randomUUID()); live();
    if (!recovered) {
      const times = { ctime: Date.now(), mtime: Date.now() };
      const payload = original.action === "delete" ? pathMutation(options.vault, active.path)
        : original.action === "rename" ? renameMutation(options.vault, active.path, active.targetPath!) : note
        ? noteModification(options.vault, active.path, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
          active.desired!.protocolHash, active.expectedRemote?.protocolHash ?? null, times)
        : fileUploadCheck(options.vault, active.path, active.desired!.protocolHash, bytes.byteLength, active.expectedRemote?.protocolHash ?? null, times);
      sent = true;
      const action = (note ? "Note" : "File") + (original.action === "delete" ? "Delete" : original.action === "rename" ? "Rename" : note ? "Modify" : "UploadCheck");
      const cancelled = await connection.client.SendMessage(action, { ...payload, context: active.context });
      if (cancelled) throw new UploadError("upload-failed");
      await ack; await chunkWork; live();
    }
    const after = recovered ? (original.action === "rename" ? targetBefore : before)
      : await options.readBack(active.targetPath ?? active.path, controller.signal); live();
    const sourceAfter = active.action === "rename" ? await options.readBack(active.path, controller.signal) : undefined; live();
    if (!sameVersion(after, active.desired)) throw new UploadError("remote-version-changed");
    const confirmed = await outbox.confirm(active.id, active.sessionId!, active.context, after, sourceAfter);
    if (!confirmed) throw new UploadError("upload-failed");
    return { status: "confirmed", operationId: active.id, recovered };
  } catch (error) {
    if (stopped) throw stopped;
    throw error;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    controller.abort(); connection?.close(); await chunkWork; identity.invalidate(); activeOwners.delete(owner);
  }
}
