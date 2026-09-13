export type LatestWriteStatus = "dirty" | "saving" | "saved" | "error";

export interface VersionedWrite<Key, Value> {
  key: Key;
  value: Value;
  version: number;
}

interface LatestWriteQueueOptions<Key, Value> {
  write: (entries: VersionedWrite<Key, Value>[]) => Promise<void>;
  onStatus?: (status: LatestWriteStatus, error: Error | null) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * A small last-write-wins queue for values whose durable writes must stay in
 * order. Values are coalesced per key, but a value created while an older
 * batch is being written is always drained afterwards.
 */
export class LatestWriteQueue<Key, Value> {
  private readonly writeBatch: LatestWriteQueueOptions<Key, Value>["write"];
  private readonly onStatus: NonNullable<LatestWriteQueueOptions<Key, Value>["onStatus"]>;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LatestWriteQueueOptions<Key, Value>["setTimer"]>;
  private readonly clearTimer: NonNullable<LatestWriteQueueOptions<Key, Value>["clearTimer"]>;
  private readonly pending = new Map<Key, VersionedWrite<Key, Value>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt: number | null = null;
  private drainPromise: Promise<void> | null = null;
  private nextVersion = 0;
  private currentStatus: LatestWriteStatus = "saved";
  private currentError: Error | null = null;

  constructor(options: LatestWriteQueueOptions<Key, Value>) {
    this.writeBatch = options.write;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.debounceMs = options.debounceMs ?? 500;
    this.maxWaitMs = options.maxWaitMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  enqueue(key: Key, value: Value) {
    const version = ++this.nextVersion;
    this.pending.set(key, { key, value, version });
    this.firstPendingAt ??= this.now();
    this.setStatus("dirty", null);
    this.armTimer();
    return version;
  }

  async flush() {
    this.cancelTimer();
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
      });
    }
    await this.drainPromise;
  }

  /**
   * Flush every known revision, run the durable checkpoint, then verify that
   * no newer revision appeared while the checkpoint was awaiting I/O.
   */
  async flushThroughCheckpoint(
    checkpoint: () => Promise<void>,
    collect: () => void = () => undefined,
  ) {
    while (true) {
      collect();
      const targetVersion = this.nextVersion;
      await this.flush();
      await checkpoint();
      collect();
      const snapshot = this.getSnapshot();
      if (
        snapshot.version === targetVersion &&
        snapshot.pending === 0 &&
        !snapshot.writing &&
        snapshot.status === "saved"
      ) {
        return;
      }
    }
  }

  retry() {
    return this.flush();
  }

  getSnapshot() {
    return {
      status: this.currentStatus,
      error: this.currentError,
      pending: this.pending.size,
      version: this.nextVersion,
      writing: this.drainPromise !== null,
    };
  }

  private armTimer() {
    this.cancelTimer();
    const elapsed = this.firstPendingAt === null ? 0 : this.now() - this.firstPendingAt;
    const untilCheckpoint = Math.max(0, this.maxWaitMs - elapsed);
    const delay = Math.min(this.debounceMs, untilCheckpoint);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush().catch(() => {
        // The queue retains the latest values and reports the error through
        // onStatus. A foreground flush/retry still receives the rejection.
      });
    }, delay);
  }

  private cancelTimer() {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private takeLatestBatch() {
    const entries = Array.from(this.pending.values());
    for (const entry of entries) {
      if (this.pending.get(entry.key)?.version === entry.version) this.pending.delete(entry.key);
    }
    this.firstPendingAt = null;
    this.cancelTimer();
    return entries;
  }

  private restoreFailedBatch(entries: VersionedWrite<Key, Value>[]) {
    for (const entry of entries) {
      const newer = this.pending.get(entry.key);
      if (!newer || newer.version < entry.version) this.pending.set(entry.key, entry);
    }
    if (this.pending.size > 0) this.firstPendingAt = this.now();
    // A failure must not spin in the background. A new edit schedules another
    // attempt; otherwise the explicit retry action calls flush().
    this.cancelTimer();
  }

  private async drain() {
    while (this.pending.size > 0) {
      const batch = this.takeLatestBatch();
      this.setStatus("saving", null);
      try {
        await this.writeBatch(batch);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.restoreFailedBatch(batch);
        this.setStatus("error", error);
        throw error;
      }
      // enqueue() may have received a newer version while the batch was in
      // flight. Loop immediately so the older completion can never bless the
      // newer draft as saved.
    }
    this.setStatus("saved", null);
  }

  private setStatus(status: LatestWriteStatus, error: Error | null) {
    this.currentStatus = status;
    this.currentError = error;
    this.onStatus(status, error);
  }
}
