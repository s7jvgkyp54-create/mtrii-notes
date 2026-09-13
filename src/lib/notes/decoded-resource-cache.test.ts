import assert from "node:assert/strict";
import test from "node:test";
import { createDecodedResourceCache, type DecodedResource } from "./decoded-resource-cache.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface TestValue {
  id: string;
}

interface LoadJob {
  key: string;
  signal: AbortSignal;
  deferred: Deferred<DecodedResource<TestValue>>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledLoader() {
  const jobs: LoadJob[] = [];
  return {
    jobs,
    load(key: string, signal: AbortSignal) {
      const job: LoadJob = { key, signal, deferred: deferred() };
      jobs.push(job);
      return job.deferred.promise;
    },
  };
}

function resource(
  id: string,
  estimatedBytes: number,
  disposals: string[],
): DecodedResource<TestValue> {
  return {
    value: { id },
    estimatedBytes,
    dispose() {
      disposals.push(id);
    },
  };
}

test("shares one in-flight load, pins by ref count, and makes release idempotent", async () => {
  const loader = controlledLoader();
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    load: loader.load,
    maxEntries: 4,
    maxBytes: 100,
    maxConcurrent: 2,
  });

  const first = cache.acquire("shared", "background");
  const second = cache.acquire("shared", "visible");
  assert.strictEqual(first.promise, second.promise);
  assert.equal(loader.jobs.length, 1);
  assert.equal(cache.getStats().refs, 2);

  loader.jobs[0]!.deferred.resolve(resource("shared-v1", 20, disposals));
  const value = await first.promise;
  assert.strictEqual(await second.promise, value);
  assert.strictEqual(first.value, value);

  first.release();
  first.release();
  assert.equal(cache.getStats().refs, 1);
  cache.trimUnused({ aggressive: true });
  assert.deepEqual(disposals, [], "a referenced resource must never be evicted");

  second.release();
  assert.equal(second.value, null);
  cache.trimUnused({ aggressive: true });
  assert.deepEqual(disposals, ["shared-v1"]);
  assert.equal(cache.getStats().entries, 0);
});

test("orders queued work export > visible > near > background and supports promotion", async () => {
  const loader = controlledLoader();
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    load: loader.load,
    maxEntries: 20,
    maxBytes: 1_000,
    maxConcurrent: 1,
  });

  const blocker = cache.acquire("blocker", "visible");
  const background = cache.acquire("background", "background");
  const near = cache.acquire("near", "near");
  const visible = cache.acquire("visible", "visible");
  const promoted = cache.acquire("promoted", "background");
  const exported = cache.acquire("export", "export");
  promoted.setPriority("export");
  assert.deepEqual(
    loader.jobs.map((job) => job.key),
    ["blocker"],
  );

  const expected = ["promoted", "export", "visible", "near", "background"];
  loader.jobs[0]!.deferred.resolve(resource("blocker", 1, disposals));
  await blocker.promise;
  for (const key of expected) {
    assert.equal(loader.jobs.at(-1)?.key, key);
    const job = loader.jobs.at(-1)!;
    job.deferred.resolve(resource(key, 1, disposals));
    const lease = { promoted, export: exported, visible, near, background }[key];
    await lease!.promise;
  }

  assert.equal(cache.getStats().peakConcurrent, 1);
  assert.equal(cache.getStats().totalLoads, 6);
  for (const lease of [blocker, background, near, visible, promoted, exported]) lease.release();
  cache.trimUnused({ aggressive: true });
});

test("never exceeds the configured concurrency while draining the queue", async () => {
  const loader = controlledLoader();
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    load: loader.load,
    maxEntries: 10,
    maxBytes: 1_000,
    maxConcurrent: 2,
  });
  const leases = Array.from({ length: 5 }, (_, index) => cache.acquire(`item-${index}`, "visible"));
  assert.equal(loader.jobs.length, 2);
  assert.equal(cache.getStats().activeLoads, 2);

  for (let index = 0; index < leases.length; index += 1) {
    const job = loader.jobs[index]!;
    job.deferred.resolve(resource(job.key, 1, disposals));
    await leases[index]!.promise;
    assert.ok(cache.getStats().activeLoads <= 2);
  }
  assert.equal(loader.jobs.length, 5);
  assert.equal(cache.getStats().peakConcurrent, 2);
  leases.forEach((lease) => lease.release());
  cache.trimUnused({ aggressive: true });
});

test("evicts the least-recently-used unpinned entry to meet the count budget", async () => {
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    async load(key) {
      return resource(key, 4, disposals);
    },
    maxEntries: 2,
    maxBytes: 100,
    maxConcurrent: 2,
  });

  const a = cache.acquire("a", "visible");
  await a.promise;
  a.release();
  const b = cache.acquire("b", "visible");
  await b.promise;
  b.release();
  assert.equal(cache.peek("a")?.id, "a", "peek should refresh LRU recency");

  const c = cache.acquire("c", "visible");
  await c.promise;
  c.release();
  assert.equal(cache.peek("b"), null);
  assert.equal(cache.peek("a")?.id, "a");
  assert.equal(cache.peek("c")?.id, "c");
  assert.deepEqual(disposals, ["b"]);
  assert.equal(cache.getStats().entries, 2);
  cache.trimUnused({ aggressive: true });
});

test("enforces the byte budget but never evicts a pinned oversized resource", async () => {
  const disposals: string[] = [];
  const sizes: Record<string, number> = { a: 6, b: 6, huge: 12 };
  const cache = createDecodedResourceCache<TestValue>({
    async load(key) {
      return resource(key, sizes[key]!, disposals);
    },
    maxEntries: 10,
    maxBytes: 10,
    maxConcurrent: 2,
  });

  const a = cache.acquire("a", "visible");
  await a.promise;
  a.release();
  const b = cache.acquire("b", "visible");
  await b.promise;
  assert.equal(cache.peek("a"), null, "the older unpinned six-byte entry should be evicted");
  b.release();

  const huge = cache.acquire("huge", "visible");
  await huge.promise;
  const pinned = cache.getStats();
  assert.equal(pinned.entries, 1);
  assert.equal(pinned.estimatedBytes, 12);
  assert.equal(pinned.pinnedBytes, 12);
  assert.equal(cache.peek("huge")?.id, "huge");

  huge.release();
  assert.equal(cache.peek("huge"), null, "the oversized entry becomes evictable on release");
  assert.equal(disposals.filter((id) => id === "huge").length, 1);
  cache.trimUnused({ aggressive: true });
});

test("cancels an orphan load and disposes an ignored-abort late result exactly once", async () => {
  const loader = controlledLoader();
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    load: loader.load,
    maxEntries: 4,
    maxBytes: 100,
    maxConcurrent: 2,
  });

  const stale = cache.acquire("asset", "visible");
  const rejected = assert.rejects(stale.promise, { name: "AbortError" });
  stale.release();
  await rejected;
  assert.equal(loader.jobs[0]!.signal.aborted, true);
  assert.equal(cache.getStats().entries, 0);

  const fresh = cache.acquire("asset", "visible");
  assert.equal(loader.jobs.length, 2);
  loader.jobs[0]!.deferred.resolve(resource("stale", 20, disposals));
  await Promise.resolve();
  assert.deepEqual(disposals, ["stale"]);
  assert.equal(cache.peek("asset"), null, "a stale completion must not publish itself");

  loader.jobs[1]!.deferred.resolve(resource("fresh", 20, disposals));
  assert.equal((await fresh.promise).id, "fresh");
  assert.equal(cache.peek("asset")?.id, "fresh");
  assert.equal(cache.getStats().cancellations, 1);
  fresh.release();
  cache.trimUnused({ aggressive: true });
  assert.equal(disposals.filter((id) => id === "fresh").length, 1);
});

test("a stale rejection cannot remove a newer successful generation", async () => {
  const loader = controlledLoader();
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    load: loader.load,
    maxEntries: 4,
    maxBytes: 100,
    maxConcurrent: 2,
  });

  const oldLease = cache.acquire("same", "background");
  const oldRejected = assert.rejects(oldLease.promise, { name: "AbortError" });
  cache.invalidate("same");
  await oldRejected;

  const newLease = cache.acquire("same", "visible");
  loader.jobs[1]!.deferred.resolve(resource("generation-2", 10, disposals));
  await newLease.promise;
  loader.jobs[0]!.deferred.reject(new Error("late generation-1 failure"));
  await Promise.resolve();

  assert.equal(cache.peek("same")?.id, "generation-2");
  assert.equal(
    cache.getStats().failures,
    0,
    "an already-cancelled stale failure is not current failure",
  );
  newLease.release();
  cache.trimUnused({ aggressive: true });
});

test("removes failed loads so a later acquire retries", async () => {
  const disposals: string[] = [];
  let attempts = 0;
  const cache = createDecodedResourceCache<TestValue>({
    async load(key) {
      attempts += 1;
      if (attempts === 1) throw new Error("decode failed");
      return resource(`${key}-retry`, 8, disposals);
    },
    maxEntries: 2,
    maxBytes: 100,
    maxConcurrent: 1,
  });

  const failed = cache.acquire("retry", "visible");
  await assert.rejects(failed.promise, /decode failed/);
  assert.equal(cache.getStats().entries, 0);
  assert.equal(cache.getStats().failures, 1);

  const retry = cache.acquire("retry", "visible");
  assert.equal((await retry.promise).id, "retry-retry");
  assert.equal(attempts, 2);
  retry.release();
  cache.trimUnused({ aggressive: true });
});

test("aggressive trim ignores release grace, cancels queued work, and preserves active refs", async () => {
  const loader = controlledLoader();
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    load: loader.load,
    maxEntries: 10,
    maxBytes: 100,
    maxConcurrent: 1,
    releaseGraceMs: 60_000,
  });

  const active = cache.acquire("active", "visible");
  const queued = cache.acquire("queued", "near");
  const queuedRejected = assert.rejects(queued.promise, { name: "AbortError" });
  queued.release();
  assert.equal(cache.getStats().queued, 1, "the grace window initially retains the orphan");

  cache.trimUnused({ aggressive: true });
  await queuedRejected;
  assert.equal(cache.getStats().entries, 1);
  assert.equal(loader.jobs.length, 1, "cancelled queued work must never call load()");
  assert.equal(cache.getStats().cancellations, 1);

  loader.jobs[0]!.deferred.resolve(resource("active", 5, disposals));
  await active.promise;
  cache.trimUnused({ aggressive: true });
  assert.equal(cache.peek("active")?.id, "active", "aggressive trim still cannot evict a ref");
  active.release();
  cache.trimUnused({ aggressive: true });
  assert.deepEqual(disposals, ["active"]);
});

test("invalidate-all retires generations but defers disposal until active leases release", async () => {
  const disposals: string[] = [];
  const cache = createDecodedResourceCache<TestValue>({
    async load(key) {
      return resource(key, 12, disposals);
    },
    maxEntries: 4,
    maxBytes: 100,
    maxConcurrent: 1,
  });

  const oldLease = cache.acquire("asset", "visible");
  const oldValue = await oldLease.promise;
  cache.invalidateAll();
  assert.equal(oldValue.id, "asset");
  assert.deepEqual(disposals, [], "invalidation must not destroy a resource under its owner");
  assert.deepEqual(
    {
      entries: cache.getStats().entries,
      retired: cache.getStats().retired,
      ready: cache.getStats().ready,
      refs: cache.getStats().refs,
      estimatedBytes: cache.getStats().estimatedBytes,
      pinnedBytes: cache.getStats().pinnedBytes,
    },
    { entries: 1, retired: 1, ready: 1, refs: 1, estimatedBytes: 12, pinnedBytes: 12 },
    "a retired generation must remain visible in memory statistics while its resource is alive",
  );

  const freshLease = cache.acquire("asset", "visible");
  assert.notEqual(await freshLease.promise, oldValue);
  assert.deepEqual(
    {
      entries: cache.getStats().entries,
      retired: cache.getStats().retired,
      ready: cache.getStats().ready,
      refs: cache.getStats().refs,
      estimatedBytes: cache.getStats().estimatedBytes,
      pinnedBytes: cache.getStats().pinnedBytes,
    },
    { entries: 2, retired: 1, ready: 2, refs: 2, estimatedBytes: 24, pinnedBytes: 24 },
  );
  oldLease.release();
  assert.deepEqual(disposals, ["asset"]);
  assert.equal(cache.getStats().retired, 0);
  assert.equal(cache.getStats().entries, 1);
  assert.equal(cache.getStats().estimatedBytes, 12);
  freshLease.release();
  cache.trimUnused({ aggressive: true });
  assert.deepEqual(disposals, ["asset", "asset"]);
});
