// WebSocket 连接常量
const RECONNECT_BASE_DELAY = 1000; // 重连基础延迟 (毫秒)
const NON_RECONNECT_REASONS = new Set([
  "AuthorizationFaild",
  "ClientClose",
  "kicked by admin",
  "TokenRotatedOrRevoked",
  "broadcast failed"
]);

export interface WebSocketConnectionState {
  loadCount(): number;
  saveCount(count: number): void;
  protobufEnabled(): boolean;
}

export interface WebSocketHost {
  createSocket(url: string): WebSocket;
  timestamp(): string;
  debug(...values: unknown[]): void;
  error(...values: unknown[]): void;
  notice(message: string): void;
}

export interface WebSocketClientOptions {
  getWsUrl: (count: number) => string;
  preConnectProbe?: () => Promise<boolean>;
  autoReconnect?: boolean;
  
  onOpen?: (client: WebSocketClient) => void;
  onClose?: (client: WebSocketClient, code: number, reason: string) => void;
  onMessage?: (client: WebSocketClient, action: string, data: unknown) => void;
  onActivity?: () => void;

  serializeMessage?: (action: string, payload: unknown) => Uint8Array;
  deserializeMessage?: (data: Uint8Array) => { action: string; [key: string]: unknown };
}

export class WebSocketClient {
  public ws: WebSocket;
  private state: WebSocketConnectionState;
  private host: WebSocketHost;
  private generation = 0;
  private options: WebSocketClientOptions;

  public isOpen = false;
  public isAuth = false;
  public useProtobuf = false;
  public checkConnection: ReturnType<typeof setTimeout>;
  public checkReConnectTimeout: ReturnType<typeof setTimeout>;
  public timeConnect = 0;
  // 是否已经在本轮重连失败序列中提示过用户（首次达到原上限第 16 次时提示一次，重连成功后重置）
  private hasNotifiedReconnectFailure = false;
  public count = 0;
  private registerPromise: Promise<void> | null = null;
  public isRegister = true;
  
  private statusListeners: Set<(status: boolean) => void> = new Set();
  private activityListeners: Set<() => void> = new Set();
  private binaryHandlers = new Map<string, (data: ArrayBuffer | Blob) => void>();

  constructor(state: WebSocketConnectionState, options: WebSocketClientOptions, host: WebSocketHost) {
    this.state = state;
    this.options = options;
    this.host = host;
    this.count = state.loadCount();
  }

  public registerBinaryHandler(prefix: string, handler: (data: ArrayBuffer | Blob) => void) {
    if (prefix.length !== 2) {
      this.host.error("Binary handler prefix must be exactly 2 characters");
      return;
    }
    this.binaryHandlers.set(prefix, handler);
  }

  public addStatusListener(listener: (status: boolean) => void) {
    this.statusListeners.add(listener);
    if (this.isRegister) {
      listener(this.isOpen);
    }
  }

  public removeStatusListener(listener: (status: boolean) => void) {
    this.statusListeners.delete(listener);
  }

  public notifyStatusChange(status: boolean) {
    this.statusListeners.forEach(listener => listener(status));
  }

  public addActivityListener(listener: () => void) {
    this.activityListeners.add(listener);
  }

  public notifyActivity() {
    this.activityListeners.forEach(fn => fn());
    this.options.onActivity?.();
  }

  public isConnected(): boolean {
    return this.isOpen;
  }

  public async register() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      this.host.debug("WebSocket already connecting or open, skipping register");
      return;
    }

    if (this.registerPromise) {
      const generation = this.generation;
      await this.registerPromise;
      // A request made after cancellation may start a fresh connection once
      // the old probe finishes. Requests preceding cancellation stay cancelled.
      if (generation !== this.generation || this.isRegister) return;
    }

    this.registerPromise = this._doRegister(++this.generation);
    try {
      await this.registerPromise;
    } finally {
      this.registerPromise = null;
    }
  }

  private async _doRegister(generation: number) {
    if (this.ws) {
      this.cleanupWebSocket(this.ws);
    }

    this.isRegister = true;

    if (this.options.preConnectProbe) {
      const isHealthy = await this.options.preConnectProbe();
      if (generation !== this.generation) return;
      if (!isHealthy) {
        this.host.debug("Health check failed before ws connect, scheduling reconnect...");
        this.isOpen = false;
        this.notifyStatusChange(false);
        this.checkReconnect();
        return;
      }
    }

    const wsUrl = this.options.getWsUrl(this.count);
    if (/^wss?:\/\/.+/i.test(wsUrl)) {
      this.ws = this.host.createSocket(wsUrl);
      const socket = this.ws;
      const isCurrent = () => this.ws === socket && generation === this.generation;
      this.ws.binaryType = "arraybuffer";
      this.count++;
      this.state.saveCount(this.count);

      this.ws.onerror = (error: Event) => {
        if (!isCurrent()) return;
        this.host.debug("WebSocket error:", {
          timestamp: this.host.timestamp(),
          url: wsUrl,
          readyState: this.ws.readyState,
          error: error
        });
        this.notifyStatusChange(false);
      };

      this.ws.onopen = (e: Event): void => {
        if (!isCurrent()) return;
        this.timeConnect = 0;
        this.hasNotifiedReconnectFailure = false;
        this.isAuth = false;
        this.useProtobuf = false;
        this.isOpen = true;
        this.host.debug("Service connected", {
          timestamp: this.host.timestamp(),
          url: wsUrl
        });
        this.options.onOpen?.(this);
      };

      this.ws.onclose = (e: CloseEvent) => {
        if (!isCurrent()) return;
        this.isAuth = false;
        this.useProtobuf = false;
        this.isOpen = false;
        this.notifyStatusChange(false);

        this.host.debug("Service close details:", {
          timestamp: this.host.timestamp(),
          code: e.code,
          reason: e.reason,
          wasClean: e.wasClean,
          timeConnect: this.timeConnect,
          isRegister: this.isRegister
        });

        if (NON_RECONNECT_REASONS.has(e.reason)) {
          this.isRegister = false;
        }

        this.options.onClose?.(this, e.code, e.reason);

        if (this.isRegister && !NON_RECONNECT_REASONS.has(e.reason)) {
          this.checkReconnect();
        }
        this.host.debug("Service close");
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (!isCurrent()) return;
        if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
          void (async () => {
            let buf: ArrayBuffer;
            if (event.data instanceof Blob) {
              buf = await event.data.arrayBuffer();
            } else {
              buf = event.data as ArrayBuffer;
            }
            if (!isCurrent() || buf.byteLength < 2) return;

            const prefixBytes = new Uint8Array(buf.slice(0, 2));
            const prefixStr = new TextDecoder().decode(prefixBytes);

            const handler = this.binaryHandlers.get(prefixStr);
            if (handler) {
              const rest = buf.slice(2);
              handler(rest);
              this.notifyActivity();
            } else if (prefixStr === "pb") {
              try {
                const rest = buf.slice(2);
                const view = new Uint8Array(rest);
                if (this.options.deserializeMessage) {
                  const result = this.options.deserializeMessage(view);
                  
                  // Only upgrade to Protobuf if the setting is enabled locally
                  // 仅在本地设置启用时才升级为 Protobuf
                  if (result.action === "ClientInfo" && this.state.protobufEnabled()) {
                    this.useProtobuf = true;
                    this.host.debug("WS Client upgraded to Protobuf successfully");
                  }
                  
                  this.options.onMessage?.(this, result.action, result);
                }
              } catch (err) {
                this.host.error("Failed to decode incoming Protobuf message:", err);
              }
            } else {
              this.host.debug("No handler for binary prefix:", prefixStr);
            }
          })();

          return;
        }

        const fullMsg = event.data as string;
        let msgData: string = fullMsg;
        let msgAction: string = "";
        const index = fullMsg.indexOf("|");
        if (index !== -1) {
          msgData = fullMsg.slice(index + 1);
          msgAction = fullMsg.slice(0, index);
        }
        try {
          const data: unknown = JSON.parse(msgData);
          this.options.onMessage?.(this, msgAction, data);
        } catch (err) {
          this.host.error("Failed to parse incoming JSON message:", err);
        }
      };
    }
  }

  private cleanupWebSocket(ws: WebSocket) {
    if (!ws) return;

    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;

    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Cleanup");
      }
    } catch (e) {
      this.host.error("Error closing WebSocket:", e);
    }
  }

  public unRegister(setUnregistered = false) {
    this.generation++;
    clearTimeout(this.checkReConnectTimeout);
    this.timeConnect = 0;
    this.hasNotifiedReconnectFailure = false;
    this.isOpen = false;
    this.isAuth = false;
    this.useProtobuf = false;
    if (setUnregistered) {
      this.isRegister = false;
    }

    if (this.ws) {
      this.cleanupWebSocket(this.ws);
      this.ws = null as unknown as WebSocket;
    }

    this.notifyStatusChange(false);
    this.host.debug("Service unregister");
  }

  public checkReconnect() {
    if (this.options.autoReconnect === false || !this.isRegister) return;
    clearTimeout(this.checkReConnectTimeout);
    // 不再设硬上限：超过原上限（15 次）后仍持续重试，退避延迟封顶 30 分钟；
    // 首次达到原上限时提示用户一次，之后静默在后台继续重试
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.timeConnect++;

      if (this.timeConnect === 16 && !this.hasNotifiedReconnectFailure) {
        this.hasNotifiedReconnectFailure = true;
        this.host.notice("同步连接持续失败，将继续在后台重试");
      }

      // Delay backoff: first 3 times 1s, then exponential growth up to 30 min
      const delay = this.timeConnect <= 3
        ? RECONNECT_BASE_DELAY
        : Math.min(RECONNECT_BASE_DELAY * Math.pow(2, this.timeConnect - 3), 1800000);

      this.host.debug(`Service waiting reconnect: ${this.timeConnect}, delay: ${delay}ms`);

      const generation = this.generation;
      this.checkReConnectTimeout = setTimeout(() => {
        if (generation !== this.generation || !this.isRegister) return;
        void this.register();
      }, delay);
    }
  }

  public triggerReconnect() {
    this.host.debug("Triggering manual reconnect due to network change");
    this.timeConnect = 0;
    this.hasNotifiedReconnectFailure = false;
    clearTimeout(this.checkReConnectTimeout);
    void this.register();
  }

  private async waitForBufferDrain(maxBufferSize = 5 * 1024 * 1024): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const socket = this.ws;
    while (this.ws === socket && socket.readyState === WebSocket.OPEN && socket.bufferedAmount > maxBufferSize) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  public async SendMessage(action: string, data: unknown, before?: () => boolean, after?: () => void) {
    if (before && before()) {
      return true; // Cancelled
    }

    const socket = this.ws;
    await this.waitForBufferDrain();

    if (this.ws !== socket || !socket || socket.readyState !== WebSocket.OPEN) return true;
    this.Send(action, data, () => {
      after?.();
      this.notifyActivity();
    });
  }

  public Send(action: string, data: unknown, after?: () => void) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.host.debug(`Service not connected, message dropped (will rely on next sync cycle): ${action}`);
      return;
    }

    if (this.useProtobuf && this.options.serializeMessage) {
      try {
        let payloadObj: unknown = data;
        if (typeof data === "string") {
          try {
            payloadObj = JSON.parse(data) as unknown;
          } catch {
            payloadObj = data;
          }
        }
        const bytes = this.options.serializeMessage(action, payloadObj);
        const prefixBytes = new TextEncoder().encode("pb");
        const bytesWithPrefix = new Uint8Array(prefixBytes.length + bytes.length);
        bytesWithPrefix.set(prefixBytes);
        bytesWithPrefix.set(bytes, prefixBytes.length);
        this.ws.send(bytesWithPrefix);
      } catch (err) {
        this.host.error(`Failed to serialize Protobuf message for action: ${action}`, err);
        // Fallback to text JSON
        this.sendTextFallback(action, data);
      }
    } else {
      this.sendTextFallback(action, data);
    }
    after?.();
  }

  private sendTextFallback(action: string, data: unknown) {
    if (typeof data === "string") {
      this.ws.send(action + "|" + data);
    } else {
      this.ws.send(action + "|" + JSON.stringify(data));
    }
  }

  /**
   * 发送二进制分片。返回值细化为三态，避免"连接已断开未发送"和"发送成功"
   * 都返回 false 而无法区分（分片假成功问题）：
   * - 'sent': 已实际写入 WebSocket
   * - 'cancelled': 被调用方 before() 钩子主动取消
   * - 'closed': 连接不可用，未发送
   */
  public async SendBinary(data: ArrayBuffer | Uint8Array, prefix: string, before?: () => boolean, after?: () => void): Promise<'sent' | 'cancelled' | 'closed'> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return 'closed';
    }

    if (!prefix || prefix.length !== 2) {
      return 'closed';
    }

    if (before && before()) {
      return 'cancelled';
    }

    const socket = this.ws;
    await this.waitForBufferDrain();

    // 等待缓冲区排空期间连接可能已断开，发送前再次确认，避免对已关闭的 socket 调用 send()
    // Connection may have dropped while waiting for the buffer to drain; re-check before sending
    if (this.ws !== socket || !socket || socket.readyState !== WebSocket.OPEN) {
      return 'closed';
    }

    const prefixBytes = new TextEncoder().encode(prefix);
    let dataToSend: Uint8Array;

    if (data instanceof Uint8Array) {
      dataToSend = new Uint8Array(prefixBytes.length + data.length);
      dataToSend.set(prefixBytes);
      dataToSend.set(data, prefixBytes.length);
    } else {
      const dataView = new Uint8Array(data);
      dataToSend = new Uint8Array(prefixBytes.length + dataView.length);
      dataToSend.set(prefixBytes);
      dataToSend.set(dataView, prefixBytes.length);
    }

    this.ws.send(dataToSend);
    after?.();
    this.notifyActivity();
    return 'sent';
  }
}
