// Extracted from operator.ts in upstream 2.4.0. Both hosts use the same
// inventory slicing, batch acknowledgements and upload window implementation.
export interface BatchSyncHost {
  websocket: {
    on(event: string, handler: (...args: unknown[]) => void): void;
    off(event: string, handler: (...args: unknown[]) => void): void;
    SendMessage(action: string, payload: unknown, before?: () => boolean, after?: () => void): Promise<unknown>;
  };
  syncState: { syncUpChunkNum: number; pipelineWindowUp: number };
  debug?: (message: string) => void;
}

/**
 * Upstream stop-and-wait batching for a legacy server or a single batch.
 * Extraction also fixes timer cleanup and awaits the final send; wire payloads
 * and the callback-after-send contract are unchanged.
 */
async function sendSyncInBatchesLegacy<T1, T2, T3>(
  plugin: BatchSyncHost,
  action: string,
  batchAckEvent: string,
  context: string | undefined,
  mainItems: T1[],
  delItems: T2[],
  missingItems: T3[],
  buildPayload: (
    mainChunk: T1[],
    delChunk: T2[],
    missingChunk: T3[],
    batchIndex: number,
    totalBatches: number
  ) => Record<string, unknown>,
  onLastBatchAcked?: () => void,
  syncUpChunkNum = plugin.syncState.syncUpChunkNum
): Promise<void> {
  const maxLen = Math.max(mainItems.length, delItems.length, missingItems.length);
  const totalBatches = Math.max(1, Math.ceil(maxLen / syncUpChunkNum));

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * syncUpChunkNum;
    const end = start + syncUpChunkNum;

    const mainChunk = mainItems.slice(start, end);
    const delChunk = delItems.slice(start, end);
    const missingChunk = missingItems.slice(start, end);

    const isLast = batchIndex === totalBatches - 1;
    const payload = buildPayload(mainChunk, delChunk, missingChunk, batchIndex, totalBatches);

    if (!isLast) {
      // 非最后批：发送并阻塞等待服务端 BatchAck，超时则抛出异常
      // Non-final batch: send and await server BatchAck; throw on timeout
      await new Promise<void>((resolve, reject) => {
        const waiting = legacyWaiters(plugin.websocket);
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          plugin.websocket.off(batchAckEvent, ackHandler);
          waiting.delete(cancel);
          if (error) reject(error); else resolve();
        };
        const cancel = () => finish(new Error("batch-connection-closed"));
        const ackHandler = (data: unknown) => {
          const d = data as { context?: string; batchIndex?: number };
          if (d.context === context && d.batchIndex === batchIndex) finish();
        };
        const timer = setTimeout(() => finish(new Error("batch-ack-timeout")), 15000);
        waiting.add(cancel);
        plugin.websocket.on(batchAckEvent, ackHandler);
        void plugin.websocket.SendMessage(action, payload).catch(() => finish(new Error("batch-send-failed")));
      });
    } else {
      // 最后批：发送后调用回调，交由原有 SyncEnd 流程完成
      // Final batch: send then invoke callback; existing SyncEnd flow handles completion
      await plugin.websocket.SendMessage(action, payload, undefined, () => {
        onLastBatchAcked?.();
      });
    }
  }
}

/**
 * 单个上行批发送会话的滑动窗口状态机（设计稿 §3.2）。
 * nextToSend/inFlight(Map)/acked(Set) 三态；重传 timer 在 SendMessage 真正写入 socket 后启动，
 * 10s 超时 × 最多 3 次重传；SyncEnd 到达视为全部批隐式 ack（settleFromSyncEnd）；
 * 连接断开由 websocket_manager onClose 现有清理处统一调用 settleFromClose 清空 timer。
 *
 * Sliding-window state machine for a single upload batch-send session (design §3.2).
 * nextToSend/inFlight(Map)/acked(Set); retransmit timer starts only after SendMessage actually
 * writes to the socket; 10s timeout x up to 3 retries; SyncEnd implies all-batches-acked
 * (settleFromSyncEnd); connection close is handled by websocket_manager's existing onClose cleanup
 * calling settleFromClose to clear all pending timers.
 */
class BatchSendSession {
  private nextToSend = 0;
  private readonly inFlight = new Map<number, { payload: Record<string, unknown>; retries: number; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly acked = new Set<number>();
  private settled = false;
  private pumping = false;
  private resolveFn!: () => void;
  private rejectFn!: (e: Error) => void;
  public readonly promise: Promise<void>;
  private readonly ackHandler: (...args: unknown[]) => void;

  constructor(
    private readonly plugin: BatchSyncHost,
    private readonly action: string,
    private readonly batchAckEvent: string,
    private readonly context: string | undefined,
    private readonly totalBatches: number,
    private readonly window: number,
    private readonly buildPayloadForIndex: (batchIndex: number) => Record<string, unknown>,
    private readonly onLastBatchSent?: () => void,
  ) {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    this.ackHandler = (data: unknown) => this.onAck(data);
    this.plugin.websocket.on(this.batchAckEvent, this.ackHandler);
    sessions(this.plugin.websocket).set(this.batchAckEvent, this);
    void this.pump().catch(() => this.fail());
  }

  private cleanup(): void {
    if (this.settled) return;
    this.settled = true;
    this.plugin.websocket.off(this.batchAckEvent, this.ackHandler);
    for (const entry of this.inFlight.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    this.inFlight.clear();
    if (sessions(this.plugin.websocket).get(this.batchAckEvent) === this) {
      sessions(this.plugin.websocket).delete(this.batchAckEvent);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
    while (!this.settled && this.nextToSend < this.totalBatches && this.inFlight.size < this.window) {
      const idx = this.nextToSend++;
      await this.sendBatch(idx);
      if (this.settled) return;
      if (idx === this.totalBatches - 1) {
        // 最后一批 send 后调用回调，语义与现状（stop-and-wait 最后批直接发出后调用 onLastBatchAcked）一致
        // Invoke callback right after the final batch is sent, matching the existing
        // stop-and-wait semantics (final batch fires the callback immediately on send, not on ack)
        this.onLastBatchSent?.();
      }
    }
    } finally { this.pumping = false; }
  }

  private fail(): void {
    if (this.settled) return;
    this.cleanup();
    this.rejectFn(new Error("batch-send-failed"));
  }

  private async sendBatch(idx: number, isRetry = false): Promise<void> {
    const payload = isRetry ? this.inFlight.get(idx)?.payload : this.buildPayloadForIndex(idx);
    if (!payload) return;
    if (!isRetry) this.inFlight.set(idx, { payload, retries: 0, timer: null });
    await this.plugin.websocket.SendMessage(this.action, payload);
    if (this.settled || this.acked.has(idx)) return;
    // 重传 timer 从 SendMessage 实际写入 socket 后起算（而非发起时），避免 bufferedAmount 背压
    // 导致 drain 等待期间就被误判超时（设计稿 §3.5 异常路径表）
    // Retransmit timer starts only after SendMessage actually writes to the socket (not when
    // issued), so time spent waiting on bufferedAmount drain doesn't get misjudged as a timeout
    const timer = setTimeout(() => this.onTimeout(idx), 10000);
    const entry = this.inFlight.get(idx);
    if (entry) {
      entry.timer = timer;
    } else {
      this.inFlight.set(idx, { payload, retries: 0, timer });
    }
  }

  private onAck(data: unknown): void {
    if (this.settled) return;
    const d = data as { context?: string; batchIndex?: number };
    if (d.context !== this.context || typeof d.batchIndex !== "number") return;
    const entry = this.inFlight.get(d.batchIndex);
    if (!entry) return; // 已确认过或非本会话在途批次，幂等忽略 / already acked or unknown index, idempotent no-op
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.inFlight.delete(d.batchIndex);
    this.acked.add(d.batchIndex);

    if (this.acked.size >= this.totalBatches) {
      this.cleanup();
      this.resolveFn();
      return;
    }
    void this.pump().catch(() => this.fail());
  }

  private onTimeout(idx: number): void {
    if (this.settled) return;
    const entry = this.inFlight.get(idx);
    if (!entry) return;
    if (entry.retries >= 3) {
      this.cleanup();
      this.rejectFn(new Error(`[BatchSync] ${this.action} batch ${idx}/${this.totalBatches} ack timeout after 3 retries (10s each)`));
      return;
    }
    entry.retries++;
    entry.timer = null;
    this.plugin.debug?.(`[BatchSync] ${this.action} batch ${idx} ack timeout, retry ${entry.retries}/3`);
    void this.sendBatch(idx, true).catch(() => this.fail());
  }

  /** SyncEnd 到达：视为本类型全部批隐式 ack，清空 timer 并成功结束会话 */
  public settleFromSyncEnd(): void {
    if (this.settled) return;
    this.cleanup();
    this.resolveFn();
  }

  /** 连接断开：清空全部 timer，会话直接终止（不再重传，交由重连后新 context 整轮重启） */
  public settleFromClose(): void {
    if (this.settled) return;
    this.cleanup();
    this.rejectFn(new Error(`[BatchSync] ${this.action} session aborted: connection closed`));
  }
}

/** 当前存活的窗口发送会话，按 batchAckEvent（如 "NoteSyncBatchAck"）索引，供 SyncEnd/onClose 钩子定位 */
const activeLegacyWaiters = new WeakMap<object, Set<() => void>>();
function legacyWaiters(socket: object): Set<() => void> {
  let result = activeLegacyWaiters.get(socket);
  if (!result) { result = new Set(); activeLegacyWaiters.set(socket, result); }
  return result;
}
const activeBatchSendSessions = new WeakMap<object, Map<string, BatchSendSession>>();
function sessions(socket: object): Map<string, BatchSendSession> {
  let result = activeBatchSendSessions.get(socket);
  if (!result) { result = new Map(); activeBatchSendSessions.set(socket, result); }
  return result;
}

/**
 * SyncEnd 到达时隐式结束对应类型的在途批发送会话（设计稿 §3.2）。W==0/旧路径下没有会话注册，no-op。
 */
export function settleBatchSendSessionOnSyncEnd(socket: object, batchAckEvent: string): void {
  sessions(socket).get(batchAckEvent)?.settleFromSyncEnd();
}

/**
 * 连接断开时清空所有在途批发送会话的 timer（设计稿 §3.2 异常路径表，挂在 websocket_manager onClose 现有清理处）。
 */
export function settleAllBatchSendSessionsOnClose(socket: object): void {
  for (const cancel of Array.from(legacyWaiters(socket))) cancel();
  for (const session of Array.from(sessions(socket).values())) {
    session.settleFromClose();
  }
}

/**
 * 串行分批发送 WebSocket 同步消息的通用辅助函数，支持同时对主项目、删除项目和缺失项目进行分片对齐发送。
 * W = min(syncState.pipelineWindowUp, 32)：W>0 走滑动窗口状态机（不等 ack 连发最多 W 批在途）；
 * W==0（旧服务端未协商 / 回滚开关）或 totalBatches<=1 快速路径，分发到保留的原 stop-and-wait 实现。
 *
 * Generic helper for serial batch-sending WebSocket sync messages, aligned-slicing main, delete, and missing arrays.
 * W = min(syncState.pipelineWindowUp, 32): W>0 uses the sliding-window state machine (up to W
 * batches in flight without waiting for acks); W==0 (pre-negotiation server / rollback switch) or
 * the totalBatches<=1 fast path dispatches to the preserved original stop-and-wait implementation.
 */
export async function sendSyncInBatches<T1, T2, T3>(
  plugin: BatchSyncHost,
  action: string,
  batchAckEvent: string,
  context: string | undefined,
  mainItems: T1[],
  delItems: T2[],
  missingItems: T3[],
  buildPayload: (
    mainChunk: T1[],
    delChunk: T2[],
    missingChunk: T3[],
    batchIndex: number,
    totalBatches: number
  ) => Record<string, unknown>,
  onLastBatchAcked?: () => void,
  syncUpChunkNum = plugin.syncState.syncUpChunkNum
): Promise<void> {
  if (!Number.isSafeInteger(syncUpChunkNum) || syncUpChunkNum < 1 || syncUpChunkNum > 50000 ||
      !Number.isSafeInteger(plugin.syncState.pipelineWindowUp) || plugin.syncState.pipelineWindowUp < 0) throw new Error("invalid-batch-negotiation");
  const maxLen = Math.max(mainItems.length, delItems.length, missingItems.length);
  const totalBatches = Math.max(1, Math.ceil(maxLen / syncUpChunkNum));
  const W = Math.min(plugin.syncState.pipelineWindowUp, 32);

  // 新旧路径选路点：W<=0（含旧服务端/协商窗口关闭）或单批快速路径 → 保留的原 stop-and-wait 分支
  // Route selection point: W<=0 (incl. pre-negotiation server / window disabled) or the
  // single-batch fast path -> preserved original stop-and-wait branch
  if (W <= 0 || totalBatches <= 1) {
    return sendSyncInBatchesLegacy(plugin, action, batchAckEvent, context, mainItems, delItems, missingItems, buildPayload, onLastBatchAcked, syncUpChunkNum);
  }

  const buildPayloadForIndex = (batchIndex: number): Record<string, unknown> => {
    const start = batchIndex * syncUpChunkNum;
    const end = start + syncUpChunkNum;
    return buildPayload(mainItems.slice(start, end), delItems.slice(start, end), missingItems.slice(start, end), batchIndex, totalBatches);
  };

  const session = new BatchSendSession(plugin, action, batchAckEvent, context, totalBatches, W, buildPayloadForIndex, onLastBatchAcked);
  return session.promise;
}
