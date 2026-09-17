import { ClientReceiveAuth } from "./websocket_action";

export interface AuthorizationResponse {
  code: number;
  data?: Record<string, unknown> | null;
}

export interface SyncNegotiation {
  syncUpChunkNum?: number;
  syncDownChunkNum?: number;
  pipelineWindowUp?: number;
  pipelineWindowDown?: number;
  negotiated: boolean;
}

interface AuthorizationTarget {
  isAuth: boolean;
  useProtobuf: boolean;
}

export function sendAuthorization(client: { Send(action: string, data: unknown): void }, token: string): void {
  client.Send(ClientReceiveAuth, token);
}

// Extracted from WebSocketManager: authentication and pv2 negotiation must be
// applied before either host dispatches sync work. Authentication is not sync.
export function applyAuthorization(
  client: AuthorizationTarget,
  response: AuthorizationResponse,
  state: SyncNegotiation,
  protobufEnabled: boolean,
): boolean {
  if (!Number.isFinite(response.code) || response.code <= 0 || response.code >= 300) {
    client.isAuth = false;
    return false;
  }
  client.isAuth = true;
  const negotiation = response.data;
  if (negotiation) {
    let negotiated = false;
    for (const field of ["syncUpChunkNum", "syncDownChunkNum", "pipelineWindowUp", "pipelineWindowDown"] as const) {
      if (typeof negotiation[field] === "number") {
        state[field] = negotiation[field];
        negotiated = true;
      }
    }
    state.negotiated = negotiated;
    if (negotiation.protobufAck === true && protobufEnabled) client.useProtobuf = true;
  }
  return true;
}
