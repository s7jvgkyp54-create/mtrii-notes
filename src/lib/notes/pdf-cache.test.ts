import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  acquirePdfDocument,
  evictAllPdfs,
  evictPdf,
  getPdfCacheStats,
  installPdfjsForTests,
  renderPdfPageBitmap,
} from "./pdf.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeBitmap {
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

const originalDocument = globalThis.document;
const originalCreateImageBitmap = globalThis.createImageBitmap;
const canvases: Array<{ width: number; height: number; getContext(): object }> = [];
let bitmapFactory = (): FakeBitmap => {
  throw new Error("No bitmap factory installed");
};

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement(tag: string) {
      assert.equal(tag, "canvas");
      const canvas = { width: 0, height: 0, getContext: () => ({}) };
      canvases.push(canvas);
      return canvas;
    },
  },
});
Object.defineProperty(globalThis, "createImageBitmap", {
  configurable: true,
  value: async () => bitmapFactory(),
});

after(() => {
  if (originalDocument === undefined) delete (globalThis as { document?: Document }).document;
  else
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  if (originalCreateImageBitmap === undefined) {
    delete (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
  } else {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: originalCreateImageBitmap,
    });
  }
});

function bitmap(width = 100, height = 80): FakeBitmap {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("document LRU defers destruction while more than three documents are actively leased", async () => {
  const prefix = `doc-lifetime-${crypto.randomUUID()}`;
  const destroyed: number[] = [];
  const destroyFailuresBefore = getPdfCacheStats().pdfDestroyFailures;
  installPdfjsForTests({
    GlobalWorkerOptions: {},
    getDocument(options: { data: Uint8Array }) {
      const marker = options.data[0]!;
      const document = {
        marker,
        numPages: 1,
        async getPage() {
          return { marker };
        },
      };
      return {
        promise: Promise.resolve(document),
        async destroy() {
          destroyed.push(marker);
          if (marker === 4) throw new Error("intentional destroy rejection");
        },
      };
    },
  } as never);

  const leases = await Promise.all(
    [1, 2, 3, 4].map((marker) =>
      acquirePdfDocument(`${prefix}-${marker}`, new Uint8Array([marker])),
    ),
  );
  assert.equal(getPdfCacheStats().documents, 4, "active leases may temporarily exceed idle LRU");
  assert.equal(getPdfCacheStats().activeDocuments, 4);
  assert.equal(getPdfCacheStats().documentReferences, 4);
  assert.equal(destroyed.length, 0, "no active document may be destroyed to satisfy the LRU");

  leases[1]!.release();
  await flushMicrotasks();
  assert.deepEqual(destroyed, [2], "the first released LRU candidate is destroyed");
  assert.equal(getPdfCacheStats().documents, 3);
  const activeDocument = leases[0]!.document as unknown as {
    getPage(pageNumber: number): Promise<{ marker: number }>;
  };
  assert.deepEqual(await activeDocument.getPage(1), { marker: 1 });

  evictPdf(`${prefix}-1`);
  assert.equal(
    destroyed.includes(1),
    false,
    "explicit invalidation retires but does not destroy an active document",
  );
  assert.equal(getPdfCacheStats().retiredActiveDocuments, 1);
  assert.deepEqual(await activeDocument.getPage(1), { marker: 1 });
  leases[0]!.release();
  await flushMicrotasks();
  assert.equal(destroyed.includes(1), true);

  leases[2]!.release();
  leases[3]!.release();
  evictAllPdfs();
  await flushMicrotasks();
  assert.deepEqual(new Set(destroyed), new Set([1, 2, 3, 4]));
  assert.equal(getPdfCacheStats().pdfDestroyFailures, destroyFailuresBefore + 1);
  installPdfjsForTests(null);
});

test("one caller abort does not cancel a shared PDF bitmap render", async () => {
  const cacheKey = `shared-${crypto.randomUUID()}`;
  const rendered = deferred<void>();
  const output = bitmap();
  let getPageCalls = 0;
  let cancelCalls = 0;
  bitmapFactory = () => output;
  const doc = {
    async getPage() {
      getPageCalls += 1;
      return {
        getViewport: () => ({ width: 320, height: 240 }),
        render: () => ({
          promise: rendered.promise,
          cancel: () => {
            cancelCalls += 1;
          },
        }),
      };
    },
  };

  const controller = new AbortController();
  const first = renderPdfPageBitmap(doc as never, 1, 1, 0, cacheKey, controller.signal);
  const second = renderPdfPageBitmap(doc as never, 1, 1, 0, cacheKey);
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  rendered.resolve();
  const secondLease = await second;
  assert.equal(secondLease.bitmap, output);
  assert.equal(getPageCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.deepEqual(canvases.at(-1) && [canvases.at(-1)!.width, canvases.at(-1)!.height], [1, 1]);

  evictPdf(cacheKey);
  assert.equal(output.closed, false, "an active bitmap lease must stay valid through eviction");
  secondLease.release();
  assert.equal(output.closed, true);
});

test("eviction makes a late bitmap stale without deleting its newer generation", async () => {
  const cacheKey = `stale-${crypto.randomUUID()}`;
  const renders = [deferred<void>(), deferred<void>()];
  const outputs = [bitmap(90, 70), bitmap(110, 85)];
  let renderIndex = 0;
  let bitmapIndex = 0;
  let getPageCalls = 0;
  let cancelCalls = 0;
  bitmapFactory = () => outputs[bitmapIndex++]!;
  const doc = {
    async getPage() {
      getPageCalls += 1;
      const ownRender = renders[renderIndex++]!;
      return {
        getViewport: () => ({ width: 300, height: 200 }),
        render: () => ({
          promise: ownRender.promise,
          cancel: () => {
            cancelCalls += 1;
          },
        }),
      };
    },
  };
  const before = getPdfCacheStats();

  const oldRequest = renderPdfPageBitmap(doc as never, 1, 1, 0, cacheKey);
  await flushMicrotasks();
  evictPdf(cacheKey);
  const newRequest = renderPdfPageBitmap(doc as never, 1, 1, 0, cacheKey);
  await flushMicrotasks();

  renders[1]!.resolve();
  const fresh = await newRequest;
  assert.equal(fresh.bitmap, outputs[0]);
  renders[0]!.resolve();
  await assert.rejects(oldRequest, { name: "AbortError" });
  assert.equal(cancelCalls, 1);

  const hit = await renderPdfPageBitmap(doc as never, 1, 1, 0, cacheKey);
  assert.equal(hit.bitmap, fresh.bitmap);
  assert.equal(getPageCalls, 2);
  assert.equal(getPdfCacheStats().bitmapCancellations, before.bitmapCancellations + 1);

  evictPdf(cacheKey);
  assert.equal(outputs[0]!.closed, false, "two active leases still pin the cached bitmap");
  hit.release();
  assert.equal(outputs[0]!.closed, false, "the first lease still pins the bitmap");
  fresh.release();
  assert.equal(outputs[0]!.closed, true);
});

test("PDF bitmap rendering obeys its concurrency limit", async () => {
  const cacheKey = `concurrency-${crypto.randomUUID()}`;
  const renders = Array.from({ length: 6 }, () => deferred<void>());
  let renderIndex = 0;
  let active = 0;
  let peak = 0;
  bitmapFactory = () => bitmap(120, 90);
  const doc = {
    async getPage() {
      const own = renders[renderIndex++]!;
      return {
        getViewport: () => ({ width: 320, height: 240 }),
        render: () => {
          active += 1;
          peak = Math.max(peak, active);
          return {
            promise: own.promise.finally(() => {
              active -= 1;
            }),
            cancel: () => undefined,
          };
        },
      };
    },
  };

  const requests = Array.from({ length: 6 }, (_, index) =>
    renderPdfPageBitmap(doc as never, index + 1, 1, 0, cacheKey),
  );
  await flushMicrotasks();
  assert.equal(renderIndex, 3);
  renders.slice(0, 3).forEach((render) => render.resolve());
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  assert.equal(renderIndex, 6);
  renders.slice(3).forEach((render) => render.resolve());
  const leases = await Promise.all(requests);
  assert.equal(peak, 3);
  assert(getPdfCacheStats().peakBitmapRenders <= 3);
  leases.forEach((lease) => lease.release());
  evictPdf(cacheKey);
});
