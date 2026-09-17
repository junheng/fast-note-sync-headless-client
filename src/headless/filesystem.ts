import { Buffer } from "node:buffer";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, opendirSync, readSync, realpathSync, renameSync, statfsSync,
  unlinkSync, writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { validRelativePath } from "./state_records";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LOCAL_FILESYSTEMS = new Set([0xef53, 0x01021994, 0x9123683e, 0x58465342, 0x794c7630]);
const MAX_ENTRIES = 50000;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const INTERNAL_PREFIX = ".fns-headless-";
const anchor = (fd: number) => `/proc/self/fd/${fd}`;
const folded = (name: string) => name.normalize("NFC").toUpperCase().toLowerCase();

export class FilesystemError extends Error {
  constructor(public readonly code: "unsupported-platform" | "unsupported-filesystem" | "invalid-root" | "invalid-path" | "unsafe-path" | "identity-mismatch" | "ownership-conflict" | "ownership-unavailable" | "case-collision" | "filesystem-limit" | "filesystem-failed" | "filesystem-closed" | "not-found" | "already-exists") {
    super(code);
    this.name = "FilesystemError";
  }
}

export interface DirectoryIdentity {
  path: string;
  device: string;
  inode: string;
}

export interface EntryInfo {
  type: "file" | "directory";
  identity: string;
  size: number;
  ctime: number;
  mtime: number;
  changeTime: string;
}

function failure(error: unknown): never {
  if (error instanceof FilesystemError) throw error;
  const code = (error as { code?: string }).code;
  if (code === "ELOOP" || code === "ENOTDIR") throw new FilesystemError("unsafe-path");
  if (code === "ENOENT") throw new FilesystemError("not-found");
  if (code === "EEXIST") throw new FilesystemError("already-exists");
  throw new FilesystemError("filesystem-failed");
}

function names(fd: number): string[] {
  const directory = opendirSync(anchor(fd));
  const result: string[] = [];
  const seen = new Set<string>();
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (result.length >= MAX_ENTRIES) throw new FilesystemError("filesystem-limit");
      const key = folded(entry.name);
      if (seen.has(key)) throw new FilesystemError("case-collision");
      seen.add(key);
      result.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return result;
}

// Linux adapter: every path component is opened relative to an already-held
// directory descriptor with O_NOFOLLOW. Replacing a parent with a symlink can
// never redirect a subsequent open/rename into its target.
export class SafeDirectory {
  readonly identity: DirectoryIdentity;
  private closed = false;

  private constructor(private fd: number, private root: string) {
    const stat = fstatSync(fd, { bigint: true });
    this.identity = { path: root, device: stat.dev.toString(), inode: stat.ino.toString() };
  }

  static open(root: string): SafeDirectory {
    if (process.platform !== "linux") throw new FilesystemError("unsupported-platform");
    if (!isAbsolute(root) || root === "/" || resolve(root) !== root || root.includes("\0")) throw new FilesystemError("invalid-root");
    let fd: number | undefined;
    try {
      fd = openSync("/", DIRECTORY_FLAGS);
      for (const component of root.slice(1).split("/")) {
        const next = openSync(`${anchor(fd)}/${component}`, DIRECTORY_FLAGS);
        closeSync(fd);
        fd = next;
      }
      if (realpathSync(anchor(fd)) !== root) throw new FilesystemError("identity-mismatch");
      if (!LOCAL_FILESYSTEMS.has(Number(statfsSync(anchor(fd)).type))) throw new FilesystemError("unsupported-filesystem");
      return new SafeDirectory(fd, root);
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      return failure(error);
    }
  }

  assertIdentity(): void {
    if (this.closed) throw new FilesystemError("filesystem-closed");
    try {
      const stat = lstatSync(this.root, { bigint: true });
      if (!stat.isDirectory() || stat.dev.toString() !== this.identity.device || stat.ino.toString() !== this.identity.inode ||
          realpathSync(anchor(this.fd)) !== this.root || realpathSync(this.root) !== this.root) {
        throw new FilesystemError("identity-mismatch");
      }
    } catch (error) {
      if (error instanceof FilesystemError) throw error;
      throw new FilesystemError("identity-mismatch");
    }
  }

  lock(): void {
    this.assertIdentity();
    try {
      // flock belongs to the inherited open-file description and survives the
      // helper's exit while this process retains fd. No stale PID lock files.
      execFileSync("/usr/bin/flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", this.fd], timeout: 5000 });
    } catch (error) {
      if ((error as { status?: number }).status === 1) throw new FilesystemError("ownership-conflict");
      throw new FilesystemError("ownership-unavailable");
    }
  }

  private withParent<T>(relative: string, operation: (fd: number, leaf: string) => T, allowedAlias?: string, checkLeaf = true): T {
    this.assertIdentity();
    if (!validRelativePath(relative) || relative.split("/").some(part => folded(part).startsWith(INTERNAL_PREFIX))) throw new FilesystemError("invalid-path");
    const parts = relative.split("/");
    if (parts.length > 64) throw new FilesystemError("filesystem-limit");
    let fd = this.fd;
    try {
      for (const part of parts.slice(0, -1)) {
        this.checkName(fd, part);
        const next = openSync(`${anchor(fd)}/${part}`, DIRECTORY_FLAGS);
        if (fd !== this.fd) closeSync(fd);
        fd = next;
      }
      const leaf = parts[parts.length - 1];
      if (checkLeaf) this.checkName(fd, leaf, allowedAlias);
      this.assertIdentity();
      this.assertParent(fd, relative);
      return operation(fd, leaf);
    } catch (error) { return failure(error); }
    finally { if (fd !== this.fd) closeSync(fd); }
  }

  private assertParent(fd: number, relative: string): void {
    const index = relative.lastIndexOf("/");
    const expected = index < 0 ? this.root : `${this.root}/${relative.slice(0, index)}`;
    if (realpathSync(anchor(fd)) !== expected) throw new FilesystemError("identity-mismatch");
  }

  private checkName(fd: number, requested: string, allowedAlias?: string): void {
    if (names(fd).some(name => name !== requested && name !== allowedAlias && folded(name) === folded(requested))) throw new FilesystemError("case-collision");
  }

  fileIdentity(relative: string, aliasPath?: string): string | null {
    const parent = relative.slice(0, relative.lastIndexOf("/") + 1);
    const alias = aliasPath && aliasPath.slice(0, aliasPath.lastIndexOf("/") + 1) === parent && folded(aliasPath) === folded(relative) ? aliasPath.slice(parent.length) : undefined;
    try {
      return this.withParent(relative, (parent, leaf) => {
        const stat = lstatSync(`${anchor(parent)}/${leaf}`, { bigint: true });
        if (!stat.isFile() || stat.nlink !== BigInt(1)) throw new FilesystemError("unsafe-path");
        return `${stat.dev}:${stat.ino}`;
      }, alias);
    } catch (error) {
      if (error instanceof FilesystemError && error.code === "not-found") return null;
      throw error;
    }
  }

  remove(relative: string): void {
    this.withParent(relative, (parent, leaf) => {
      const target = `${anchor(parent)}/${leaf}`;
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1) throw new FilesystemError("unsafe-path");
      unlinkSync(target);
      fsyncSync(parent);
    });
  }

  // Keep the deleted inode until its journal commit. A recreated pathname can
  // then never be mistaken for the original after a crash (inode numbers may
  // otherwise be reused immediately by the filesystem).
  deletionStaged(relative: string, key: string, identity: string): boolean {
    try { return this.withParent(relative, parent => {
      const marker = this.deletionMarker(parent, key);
      try {
        const stat = lstatSync(marker, { bigint: true });
        if (!stat.isFile() || stat.nlink !== BigInt(1) || `${stat.dev}:${stat.ino}` !== identity) throw new FilesystemError("identity-mismatch");
        return true;
      } catch (error) { if ((error as { code?: string }).code === "ENOENT") return false; throw error; }
    }, undefined, false); } catch (error) {
      if (error instanceof FilesystemError && error.code === "not-found") return false;
      throw error;
    }
  }

  stageDeletion(relative: string, key: string, identity: string): void {
    this.withParent(relative, (parent, leaf) => {
      const source = `${anchor(parent)}/${leaf}`, marker = this.deletionMarker(parent, key);
      const stat = lstatSync(source, { bigint: true });
      if (!stat.isFile() || stat.nlink !== BigInt(1) || `${stat.dev}:${stat.ino}` !== identity) throw new FilesystemError("identity-mismatch");
      try { lstatSync(marker); throw new FilesystemError("already-exists"); }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      renameSync(source, marker);
      fsyncSync(parent);
    });
  }

  finishDeletion(relative: string, key: string, identity: string): void {
    if (!this.deletionStaged(relative, key, identity)) return;
    this.withParent(relative, parent => { unlinkSync(this.deletionMarker(parent, key)); fsyncSync(parent); }, undefined, false);
  }

  private deletionMarker(parent: number, key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new FilesystemError("invalid-path");
    return `${anchor(parent)}/${INTERNAL_PREFIX}delete-${key}`;
  }

  move(source: string, target: string): void {
    if (source === target) throw new FilesystemError("invalid-path");
    const sourceParent = source.slice(0, source.lastIndexOf("/") + 1);
    const targetParent = target.slice(0, target.lastIndexOf("/") + 1);
    const alias = sourceParent === targetParent && folded(source) === folded(target) ? source.slice(sourceParent.length) : undefined;
    this.withParent(source, (from, sourceLeaf) => this.withParent(target, (to, targetLeaf) => {
      const original = `${anchor(from)}/${sourceLeaf}`, destination = `${anchor(to)}/${targetLeaf}`;
      const stat = lstatSync(original);
      if (!stat.isFile() || stat.nlink !== 1) throw new FilesystemError("unsafe-path");
      try { lstatSync(destination); throw new FilesystemError("already-exists"); }
      catch (error) { if ((error as { code?: string }).code !== "ENOENT") throw error; }
      // The owner mutex covers both source and target checks through commit.
      // Uncooperative same-permission writers are excluded by the Ops contract.
      renameSync(original, destination);
      fsyncSync(from); if (from !== to) fsyncSync(to);
    }, alias));
  }

  read(relative: string, maxBytes = MAX_FILE_BYTES): Buffer {
    return this.readContent(relative, maxBytes);
  }

  inspect(relative: string): EntryInfo {
    return this.withParent(relative, (parent, leaf) => {
      const value = lstatSync(`${anchor(parent)}/${leaf}`, { bigint: true });
      if ((!value.isFile() && !value.isDirectory()) || (value.isFile() && value.nlink !== BigInt(1))) throw new FilesystemError("unsafe-path");
      const size = Number(value.size), ctime = Number((value.birthtimeNs > BigInt(0) ? value.birthtimeNs : value.ctimeNs) / BigInt(1000000)), mtime = Number(value.mtimeNs / BigInt(1000000));
      if (![size, ctime, mtime].every(number => Number.isSafeInteger(number) && number >= 0)) throw new FilesystemError("filesystem-limit");
      return { type: value.isFile() ? "file" : "directory", identity: `${value.dev}:${value.ino}`, size, ctime, mtime, changeTime: value.ctimeNs.toString() };
    });
  }

  readRange(relative: string, start: number, length: number, maxBytes = MAX_FILE_BYTES): Buffer {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(start + length)) throw new FilesystemError("filesystem-limit");
    return this.readContent(relative, maxBytes, { start, length });
  }

  private readContent(relative: string, maxBytes: number, range?: { start: number; length: number }): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_FILE_BYTES) throw new FilesystemError("filesystem-limit");
    return this.withParent(relative, (parent, leaf) => {
      const fd = openSync(`${anchor(parent)}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== BigInt(1)) throw new FilesystemError("unsafe-path");
        if (before.size > BigInt(maxBytes)) throw new FilesystemError("filesystem-limit");
        if (range && range.start + range.length > Number(before.size)) throw new FilesystemError("filesystem-limit");
        const bytes = Buffer.alloc(range?.length ?? Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          const count = readSync(fd, bytes, offset, Math.min(1024 * 1024, bytes.length - offset), (range?.start ?? 0) + offset);
          if (count === 0) throw new FilesystemError("filesystem-failed");
          offset += count;
        }
        const after = fstatSync(fd, { bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new FilesystemError("filesystem-failed");
        const current = lstatSync(`${anchor(parent)}/${leaf}`, { bigint: true });
        if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== BigInt(1) || current.size !== after.size || current.ctimeNs !== after.ctimeNs) throw new FilesystemError("identity-mismatch");
        this.assertIdentity();
        this.assertParent(parent, relative);
        return bytes;
      } finally { closeSync(fd); }
    });
  }

  readOptional(relative: string): Buffer | null {
    try { return this.read(relative); }
    catch (error) {
      if (error instanceof FilesystemError && error.code === "not-found") return null;
      throw error;
    }
  }

  sync(relative: string): void {
    this.withParent(relative, (parent, leaf) => {
      const fd = openSync(`${anchor(parent)}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new FilesystemError("unsafe-path");
        fsyncSync(fd);
        fsyncSync(parent);
      } finally { closeSync(fd); }
    });
  }

  syncParent(relative: string): void {
    this.withParent(relative, parent => fsyncSync(parent), undefined, false);
  }

  // Recover only the known two-name window of our atomic no-replace publish.
  // Arbitrary hard links remain forbidden. Exactly two entries must share the
  // inode, including one reserved temporary name in this same directory. Drop
  // only that redundant name, preserving target bytes even if externally edited.
  // The caller then compares complete content against its durable versions.
  completePublication(relative: string): void {
    try {
      this.withParent(relative, (parent, leaf) => {
        const fd = openSync(`${anchor(parent)}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile()) throw new FilesystemError("unsafe-path");
          if (stat.nlink === 1) return;
          if (stat.nlink !== 2 || stat.size > MAX_FILE_BYTES) throw new FilesystemError("unsafe-path");
          const temporary = names(parent).filter(name => name.startsWith(INTERNAL_PREFIX)).filter(name => {
            const candidate = lstatSync(`${anchor(parent)}/${name}`);
            return candidate.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino;
          });
          if (temporary.length !== 1) throw new FilesystemError("unsafe-path");
          this.assertIdentity(); this.assertParent(parent, relative);
          for (const name of [leaf, temporary[0]]) {
            const current = lstatSync(`${anchor(parent)}/${name}`);
            if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 2) throw new FilesystemError("identity-mismatch");
          }
          unlinkSync(`${anchor(parent)}/${temporary[0]}`);
          fsyncSync(fd); fsyncSync(parent);
        } finally { closeSync(fd); }
      });
    } catch (error) {
      if (!(error instanceof FilesystemError) || error.code !== "not-found") throw error;
    }
  }

  list(relative?: string): string[] {
    const readNames = (fd: number) => names(fd).filter(name => !folded(name).startsWith(INTERNAL_PREFIX));
    if (relative === undefined) {
      this.assertIdentity();
      try { return readNames(this.fd); } catch (error) { return failure(error); }
    }
    return this.withParent(relative, (parent, leaf) => {
      const fd = openSync(`${anchor(parent)}/${leaf}`, DIRECTORY_FLAGS);
      try { return readNames(fd); } finally { closeSync(fd); }
    });
  }

  createDirectory(relative: string): void {
    this.withParent(relative, (parent, leaf) => {
      mkdirSync(`${anchor(parent)}/${leaf}`, { mode: 0o700 });
      fsyncSync(parent);
    });
  }

  // Only for an owner's disposable staging directory after recovering/removing
  // all published files. Live journals and deletion markers are never eligible.
  discardTemporaryWrites(relative: string): void {
    this.withParent(relative, (parent, leaf) => {
      const fd = openSync(`${anchor(parent)}/${leaf}`, DIRECTORY_FLAGS);
      try {
        for (const name of names(fd)) {
          if (!/^\.fns-headless-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue;
          const path = `${anchor(fd)}/${name}`, stat = lstatSync(path);
          if (!stat.isFile() || stat.nlink !== 1) throw new FilesystemError("unsafe-path");
          unlinkSync(path);
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    });
  }

  hasDirectory(relative: string): boolean {
    try { this.list(relative); return true; }
    catch (error) { if (error instanceof FilesystemError && error.code === "not-found") return false; throw error; }
  }

  createDirectories(relative: string): void {
    if (!validRelativePath(relative)) throw new FilesystemError("invalid-path");
    const parts = relative.split("/");
    for (let count = 1; count <= parts.length; count++) {
      const parent = parts.slice(0, count).join("/");
      if (!this.hasDirectory(parent)) this.createDirectory(parent);
    }
  }

  // Host primitive only. Version preconditions and durable recovery intent must
  // be held by the owner before using this in a sync/controlled-write operation.
  write(relative: string, bytes: Uint8Array, mode: "create" | "replace"): void {
    if (bytes.byteLength > MAX_FILE_BYTES) throw new FilesystemError("filesystem-limit");
    this.withParent(relative, (parent, leaf) => {
      const target = `${anchor(parent)}/${leaf}`;
      if (mode === "create") {
        const temporary = `${anchor(parent)}/${INTERNAL_PREFIX}${randomUUID()}`;
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          this.writeBytes(fd, bytes);
          this.assertIdentity();
          this.assertParent(parent, relative);
          this.checkName(parent, leaf);
          // Atomic no-replace publication: an existing path is never opened or
          // overwritten, and partial bytes are never visible at the final name.
          linkSync(temporary, target);
        } finally { closeSync(fd); unlinkSync(temporary); }
        fsyncSync(parent);
        return;
      }
      // Opening first rejects symlinks, directories, special files and hard
      // links. Replacement itself addresses the anchored directory entry.
      const original = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(original);
        if (!stat.isFile() || stat.nlink !== 1) throw new FilesystemError("unsafe-path");
        const temporary = `${anchor(parent)}/${INTERNAL_PREFIX}${randomUUID()}`;
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let renamed = false;
        try {
          this.writeBytes(fd, bytes);
          this.assertIdentity();
          this.assertParent(parent, relative);
          this.checkName(parent, leaf);
          const current = lstatSync(target);
          if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) throw new FilesystemError("identity-mismatch");
          renameSync(temporary, target);
          renamed = true;
          fsyncSync(parent);
        } finally {
          closeSync(fd);
          if (!renamed) unlinkSync(temporary);
        }
      } finally { closeSync(original); }
    });
  }

  private writeBytes(fd: number, bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = writeSync(fd, bytes, offset, Math.min(1024 * 1024, bytes.byteLength - offset));
      if (count === 0) throw new FilesystemError("filesystem-failed");
      offset += count;
    }
    fsyncSync(fd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

export class OwnedDirectories {
  private tail: Promise<void> = Promise.resolve();
  private constructor(readonly vault: SafeDirectory, readonly state: SafeDirectory) {}

  static acquire(vaultPath: string, statePath: string): OwnedDirectories {
    let vault: SafeDirectory | undefined;
    let state: SafeDirectory | undefined;
    try {
      vault = SafeDirectory.open(vaultPath);
      state = SafeDirectory.open(statePath);
      const a = vault.identity, b = state.identity;
      if (a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`) ||
          (a.device === b.device && a.inode === b.inode)) throw new FilesystemError("invalid-root");
      const ordered = [vault, state].sort((left, right) => `${left.identity.device}:${left.identity.inode}`.localeCompare(`${right.identity.device}:${right.identity.inode}`));
      for (const directory of ordered) directory.lock();
      vault.assertIdentity(); state.assertIdentity();
      return new OwnedDirectories(vault, state);
    } catch (error) {
      state?.close(); vault?.close();
      return failure(error);
    }
  }

  close(): void {
    try { this.state.close(); } finally { this.vault.close(); }
  }

  // Every local application entry uses the same owner queue. The lifetime
  // directory locks exclude independent owners; control IPC queues on this lock.
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      this.vault.assertIdentity(); this.state.assertIdentity();
      return await operation();
    } finally { release(); }
  }
}
