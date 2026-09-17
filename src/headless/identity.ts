import type { OwnedDirectories } from "./filesystem";
import type { StateStore } from "./state_store";
import type { BindingRecord, RecordKind } from "./state_records";
import { validIdentifier } from "./state_records";

export class IdentityError extends Error {
  constructor(public readonly code: "state-identity-mismatch" | "state-identity-unverified" | "invalid-config") {
    super(code); this.name = "IdentityError";
  }
}

export interface RemoteIdentity { serviceId: string | null; subjectId: string; vaultId: string | null; vaultName: string }

export function canonicalEndpoint(input: string): string {
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch { throw new IdentityError("invalid-config"); }
}

// A guard is invalidated on disconnect. Its remote evidence must come from the
// authenticated service, never from a token digest or an operator-chosen label.
export class IdentityBinding {
  private verified = false;
  private endpoint: string;
  constructor(private owner: OwnedDirectories, private state: StateStore, endpoint: string, private vaultName: string) {
    this.endpoint = canonicalEndpoint(endpoint);
    if (!vaultName || vaultName.length > 1024) throw new IdentityError("invalid-config");
    this.checkLocal();
  }

  private checkLocal(): BindingRecord | null {
    this.owner.vault.assertIdentity(); this.owner.state.assertIdentity();
    const stored = this.state.get("binding", "identity");
    if (!stored) return null;
    const record = stored.record;
    const directory = this.owner.vault.identity;
    if (record.kind !== "binding" || record.endpoint !== this.endpoint || record.vaultName !== this.vaultName ||
        record.directory.path !== directory.path || record.directory.device !== directory.device || record.directory.inode !== directory.inode) {
      throw new IdentityError("state-identity-mismatch");
    }
    return record;
  }

  verify(remote: RemoteIdentity): void {
    this.verified = false;
    if (!remote || (remote.serviceId !== null && !validIdentifier(remote.serviceId)) || !validIdentifier(remote.subjectId) ||
        (remote.vaultId !== null && !validIdentifier(remote.vaultId)) || remote.vaultName !== this.vaultName) {
      throw new IdentityError("state-identity-unverified");
    }
    const prior = this.checkLocal();
    if (prior) {
      if (prior.serviceId !== remote.serviceId || prior.subjectId !== remote.subjectId || prior.vaultId !== remote.vaultId) throw new IdentityError("state-identity-mismatch");
    } else {
      // In particular, do not adopt the unbound state of an initial-copy preview.
      const kinds: RecordKind[] = ["binding", "operation", "baseline", "batch", "session", "application", "conflict", "local-request", "scan"];
      if (kinds.some(kind => this.state.list(kind, { limit: 1 }).length)) throw new IdentityError("state-identity-unverified");
      this.state.commit([{ type: "put", expectedRevision: null, record: {
        formatVersion: 1, kind: "binding", id: "identity", endpoint: this.endpoint,
        serviceId: remote.serviceId, subjectId: remote.subjectId, vaultId: remote.vaultId, vaultName: remote.vaultName,
        directory: { ...this.owner.vault.identity },
      } }]);
    }
    this.verified = true;
  }

  invalidate(): void { this.verified = false; }
  assertConnection(endpoint: string, vaultName: string): void {
    if (canonicalEndpoint(endpoint) !== this.endpoint || vaultName !== this.vaultName) throw new IdentityError("state-identity-mismatch");
    this.checkLocal();
  }
  assertVerified(): void {
    if (!this.verified) throw new IdentityError("state-identity-unverified");
    this.checkLocal();
  }
}
