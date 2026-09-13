export type ResourcePriority = "export" | "visible" | "near" | "background";

export interface DecodedResource<T> {
  value: T;
  estimatedBytes: number;
  dispose(): void;
}

export interface ResourceLease<T> {
  readonly promise: Promise<T>;
  readonly value: T | null;
  setPriority(priority: ResourcePriority): void;
  release(): void;
}

export interface DecodedResourceCacheStats {
  entries: number;
  retired: number;
  ready: number;
  queued: number;
  loading: number;
  refs: number;
  estimatedBytes: number;
  pinnedBytes: number;
  maxEntries: number;
  maxBytes: number;
  maxConcurrent: number;
  activeLoads: number;
  peakConcurrent: number;
  totalLoads: number;
  failures: number;
  evictions: number;
  cancellations: number;
}

export interface DecodedResourceCache<T> {
  acquire(key: string, priority: ResourcePriority): ResourceLease<T>;
  peek(key: string): T | null;
  invalidate(key: string): void;
  invalidateAll(): void;
  trimUnused(options?: { aggressive?: boolean }): void;
  getStats(): DecodedResourceCacheStats;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

type EntryStatus = "queued" | "loading" | "ready";

interface CacheEntry<T> {
  readonly key: string;
  readonly generation: number;
  readonly enqueueOrder: number;
  readonly controller: AbortController;
  readonly deferred: Deferred<T>;
  readonly leasePriorities: Map<number, ResourcePriority>;
  status: EntryStatus;
  refs: number;
  lastUsed: number;
  resource: DecodedResource<T> | null;
  resourceDisposed: boolean;
  retired: boolean;
  cancelled: boolean;
  graceTimer: ReturnType<typeof setTimeout> | null;
  graceProtected: boolean;
}

const PRIORITY_RANK: Record<ResourcePriority, number> = {
  export: 3,
  visible: 2,
  near: 1,
  background: 0,
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A released lease may intentionally abandon its promise. Keep that normal
  // cancellation path from becoming an unhandled rejection while preserving
  // the rejection for consumers that do await the original promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function abortError() {
  const error = new Error("Decoded resource load was cancelled.");
  error.name = "AbortError";
  return error;
}

function assertPriority(priority: ResourcePriority) {
  if (!(priority in PRIORITY_RANK)) {
    throw new TypeError(`Unknown decoded-resource priority: ${String(priority)}`);
  }
}

function assertCacheOptions(options: {
  maxEntries: number;
  maxBytes: number;
  maxConcurrent: number;
  releaseGraceMs?: number;
}) {
  if (!Number.isInteger(options.maxEntries) || options.maxEntries < 0) {
    throw new RangeError("maxEntries must be a non-negative integer.");
  }
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative finite number.");
  }
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
    throw new RangeError("maxConcurrent must be a positive integer.");
  }
  if (
    options.releaseGraceMs !== undefined &&
    (!Number.isFinite(options.releaseGraceMs) || options.releaseGraceMs < 0)
  ) {
    throw new RangeError("releaseGraceMs must be a non-negative finite number.");
  }
}

/**
 * A generic cache for expensive decoded resources. Persistent source data is
 * deliberately outside this cache: disposing an entry must only release its
 * transient decoded representation.
 */
export function createDecodedResourceCache<T>(options: {
  load: (key: string, signal: AbortSignal) => Promise<DecodedResource<T>>;
  maxEntries: number;
  maxBytes: number;
  maxConcurrent: number;
  releaseGraceMs?: number;
}): DecodedResourceCache<T> {
  assertCacheOptions(options);

  const entries = new Map<string, CacheEntry<T>>();
  // Invalidated generations disappear from `entries` immediately so they can
  // never be acquired again. A ready generation with live leases still owns
  // its decoded resource, though, and must remain part of memory accounting
  // until the final lease releases and disposal completes.
  const retiredEntries = new Set<CacheEntry<T>>();
  const releaseGraceMs = options.releaseGraceMs ?? 0;
  let sequence = 0;
  let leaseSequence = 0;
  let activeLoads = 0;
  let peakConcurrent = 0;
  let totalLoads = 0;
  let failures = 0;
  let evictions = 0;
  let cancellations = 0;

  function touch(entry: CacheEntry<T>) {
    entry.lastUsed = ++sequence;
  }

  function clearGrace(entry: CacheEntry<T>) {
    if (entry.graceTimer !== null) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.graceProtected = false;
  }

  function disposeResourceOnce(entry: CacheEntry<T>, resource = entry.resource) {
    if (!resource || entry.resourceDisposed) return;
    entry.resourceDisposed = true;
    try {
      resource.dispose();
    } catch {
      // Cleanup must remain idempotent and must not corrupt cache bookkeeping.
    } finally {
      retiredEntries.delete(entry);
    }
  }

  function removeCurrent(entry: CacheEntry<T>) {
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
    clearGrace(entry);
    entry.retired = true;
  }

  function cancelPending(entry: CacheEntry<T>) {
    if (entry.cancelled || entry.status === "ready") return;
    entry.cancelled = true;
    cancellations += 1;
    entry.controller.abort();
    entry.deferred.reject(abortError());
  }

  function removeEntry(entry: CacheEntry<T>, reason: "eviction" | "orphan" | "invalidate") {
    if (entry.retired) return;
    removeCurrent(entry);
    if (reason === "eviction") evictions += 1;
    // Retire the generation immediately so nobody new can acquire it, but do
    // not destroy a decoded resource under a caller that already owns a lease.
    if (entry.status === "ready") {
      if (entry.refs === 0) disposeResourceOnce(entry);
      else retiredEntries.add(entry);
    } else cancelPending(entry);
  }

  function estimatedBytes() {
    let total = 0;
    for (const entry of entries.values()) {
      if (entry.status === "ready" && entry.resource && !entry.resourceDisposed) {
        total += entry.resource.estimatedBytes;
      }
    }
    return total;
  }

  function effectivePriority(entry: CacheEntry<T>) {
    let rank = -1;
    for (const priority of entry.leasePriorities.values()) {
      rank = Math.max(rank, PRIORITY_RANK[priority]);
    }
    return rank;
  }

  function nextQueuedEntry() {
    let best: CacheEntry<T> | null = null;
    let bestRank = -1;
    for (const entry of entries.values()) {
      if (entry.status !== "queued" || entry.refs === 0 || entry.retired) continue;
      const rank = effectivePriority(entry);
      if (
        !best ||
        rank > bestRank ||
        (rank === bestRank && entry.enqueueOrder < best.enqueueOrder)
      ) {
        best = entry;
        bestRank = rank;
      }
    }
    return best;
  }

  function isDecodedResource(value: unknown): value is DecodedResource<T> {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<DecodedResource<T>>;
    return (
      typeof candidate.dispose === "function" &&
      typeof candidate.estimatedBytes === "number" &&
      Number.isFinite(candidate.estimatedBytes) &&
      candidate.estimatedBytes >= 0 &&
      "value" in candidate
    );
  }

  function finishFailure(entry: CacheEntry<T>, error: unknown) {
    if (entry.cancelled || entry.retired || entries.get(entry.key) !== entry) return;
    removeCurrent(entry);
    failures += 1;
    entry.deferred.reject(error);
  }

  function finishSuccess(entry: CacheEntry<T>, decoded: DecodedResource<T>) {
    if (!isDecodedResource(decoded)) {
      const maybeDisposable = decoded as Partial<DecodedResource<T>> | null;
      if (typeof maybeDisposable?.dispose === "function") {
        try {
          maybeDisposable.dispose();
        } catch {
          // The invalid result is rejected below regardless of cleanup errors.
        }
      }
      finishFailure(entry, new TypeError("load() returned an invalid decoded resource."));
      return;
    }

    entry.resource = decoded;
    if (entry.cancelled || entry.retired || entries.get(entry.key) !== entry) {
      disposeResourceOnce(entry, decoded);
      return;
    }

    entry.status = "ready";
    touch(entry);
    entry.deferred.resolve(decoded.value);
    trimUnused();
  }

  function completeLoad() {
    activeLoads = Math.max(0, activeLoads - 1);
    pump();
  }

  function start(entry: CacheEntry<T>) {
    if (entry.status !== "queued" || entry.retired || entries.get(entry.key) !== entry) return;
    entry.status = "loading";
    activeLoads += 1;
    totalLoads += 1;
    peakConcurrent = Math.max(peakConcurrent, activeLoads);

    let loading: Promise<DecodedResource<T>>;
    try {
      loading = options.load(entry.key, entry.controller.signal);
    } catch (error) {
      finishFailure(entry, error);
      completeLoad();
      return;
    }

    void Promise.resolve(loading).then(
      (decoded) => {
        finishSuccess(entry, decoded);
        completeLoad();
      },
      (error: unknown) => {
        finishFailure(entry, error);
        completeLoad();
      },
    );
  }

  function pump() {
    while (activeLoads < options.maxConcurrent) {
      const entry = nextQueuedEntry();
      if (!entry) return;
      start(entry);
    }
  }

  function scheduleOrphanHandling(entry: CacheEntry<T>) {
    clearGrace(entry);
    if (entry.retired || entries.get(entry.key) !== entry || entry.refs !== 0) return;

    const handle = () => {
      entry.graceTimer = null;
      entry.graceProtected = false;
      if (entry.retired || entries.get(entry.key) !== entry || entry.refs !== 0) return;
      if (entry.status === "queued" || entry.status === "loading") {
        removeEntry(entry, "orphan");
      } else {
        trimUnused();
      }
    };

    if (releaseGraceMs === 0) {
      handle();
      return;
    }
    entry.graceProtected = true;
    entry.graceTimer = setTimeout(handle, releaseGraceMs);
  }

  function acquire(key: string, priority: ResourcePriority): ResourceLease<T> {
    assertPriority(priority);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        key,
        generation: ++sequence,
        enqueueOrder: sequence,
        controller: new AbortController(),
        deferred: createDeferred<T>(),
        leasePriorities: new Map(),
        status: "queued",
        refs: 0,
        lastUsed: sequence,
        resource: null,
        resourceDisposed: false,
        retired: false,
        cancelled: false,
        graceTimer: null,
        graceProtected: false,
      };
      entries.set(key, entry);
    } else {
      clearGrace(entry);
      touch(entry);
    }

    const ownedEntry = entry;
    const leaseId = ++leaseSequence;
    let leasePriority = priority;
    let released = false;
    ownedEntry.refs += 1;
    ownedEntry.leasePriorities.set(leaseId, priority);
    touch(ownedEntry);

    const lease: ResourceLease<T> = {
      get promise() {
        return ownedEntry.deferred.promise;
      },
      get value() {
        if (
          released ||
          ownedEntry.retired ||
          ownedEntry.status !== "ready" ||
          !ownedEntry.resource ||
          ownedEntry.resourceDisposed
        ) {
          return null;
        }
        return ownedEntry.resource.value;
      },
      setPriority(nextPriority) {
        assertPriority(nextPriority);
        if (released || ownedEntry.retired || entries.get(key) !== ownedEntry) return;
        if (leasePriority === nextPriority) return;
        leasePriority = nextPriority;
        ownedEntry.leasePriorities.set(leaseId, nextPriority);
        touch(ownedEntry);
        pump();
      },
      release() {
        if (released) return;
        released = true;
        ownedEntry.leasePriorities.delete(leaseId);
        ownedEntry.refs = Math.max(0, ownedEntry.refs - 1);
        touch(ownedEntry);
        if (ownedEntry.refs === 0) {
          if (ownedEntry.retired) disposeResourceOnce(ownedEntry);
          else scheduleOrphanHandling(ownedEntry);
        }
      },
    };

    trimUnused();
    pump();
    return lease;
  }

  function peek(key: string) {
    const entry = entries.get(key);
    if (
      !entry ||
      entry.retired ||
      entry.status !== "ready" ||
      !entry.resource ||
      entry.resourceDisposed
    ) {
      return null;
    }
    touch(entry);
    return entry.resource.value;
  }

  function invalidate(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    removeEntry(entry, "invalidate");
    pump();
  }

  function invalidateAll() {
    for (const entry of [...entries.values()]) removeEntry(entry, "invalidate");
    pump();
  }

  function trimUnused(trimOptions: { aggressive?: boolean } = {}) {
    const aggressive = trimOptions.aggressive === true;
    if (aggressive) {
      const unused = [...entries.values()]
        .filter((entry) => entry.refs === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      for (const entry of unused) removeEntry(entry, "eviction");
      pump();
      return;
    }

    while (entries.size > options.maxEntries || estimatedBytes() > options.maxBytes) {
      let oldest: CacheEntry<T> | null = null;
      for (const entry of entries.values()) {
        if (entry.refs !== 0 || entry.graceProtected) continue;
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry;
      }
      if (!oldest) break;
      removeEntry(oldest, "eviction");
    }
    pump();
  }

  function getStats(): DecodedResourceCacheStats {
    let ready = 0;
    let queued = 0;
    let loading = 0;
    let refs = 0;
    let bytes = 0;
    let pinnedBytes = 0;
    for (const entry of [...entries.values(), ...retiredEntries]) {
      refs += entry.refs;
      if (entry.status === "queued") queued += 1;
      else if (entry.status === "loading") loading += 1;
      else {
        ready += 1;
        const entryBytes = entry.resource?.estimatedBytes ?? 0;
        bytes += entryBytes;
        if (entry.refs > 0) pinnedBytes += entryBytes;
      }
    }
    return {
      entries: entries.size + retiredEntries.size,
      retired: retiredEntries.size,
      ready,
      queued,
      loading,
      refs,
      estimatedBytes: bytes,
      pinnedBytes,
      maxEntries: options.maxEntries,
      maxBytes: options.maxBytes,
      maxConcurrent: options.maxConcurrent,
      activeLoads,
      peakConcurrent,
      totalLoads,
      failures,
      evictions,
      cancellations,
    };
  }

  return { acquire, peek, invalidate, invalidateAll, trimUnused, getStats };
}
