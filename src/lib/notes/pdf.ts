import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  createDecodedResourceCache,
  type ResourceLease,
  type ResourcePriority,
} from "./decoded-resource-cache.ts";

let pdfjsMod: typeof import("pdfjs-dist") | null = null;

export async function getPdfjs() {
  if (pdfjsMod) return pdfjsMod;
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")) as { default: string };
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  pdfjsMod = pdfjs;
  return pdfjs;
}

/** Test seam for the document lifetime cache; application code must use getPdfjs(). */
export function installPdfjsForTests(pdfjs: typeof import("pdfjs-dist") | null) {
  pdfjsMod = pdfjs;
}

interface PdfDocumentRecord {
  readonly assetId: string;
  readonly generation: number;
  readonly document: PDFDocumentProxy;
  readonly loadingTask: PDFDocumentLoadingTask;
  references: number;
  retired: boolean;
  destroyStarted: boolean;
}

export interface PdfDocumentLease {
  readonly document: PDFDocumentProxy;
  release(): void;
}

const docCache = new Map<string, PdfDocumentRecord>();
const retiredDocuments = new Set<PdfDocumentRecord>();
const docPromiseCache = new Map<string, Promise<PdfDocumentRecord>>();
const storedPdfPromiseCache = new Map<string, Promise<PdfDocumentRecord>>();
const loadingTaskCache = new Map<string, PDFDocumentLoadingTask>();
const destroyedLoadingTasks = new WeakSet<PDFDocumentLoadingTask>();
const pendingDocumentAcquires = new Map<string, number>();
const pdfGenerations = new Map<string, number>();
const MAX_PDF_DOCUMENTS = 3;
let pdfEvictions = 0;
let pdfStaleDiscards = 0;
let pdfFailures = 0;
let pdfDestroyFailures = 0;
let bitmapStaleDiscards = 0;

function generationFor(assetId: string) {
  return pdfGenerations.get(assetId) ?? 0;
}

function advanceGeneration(assetId: string) {
  const next = generationFor(assetId) + 1;
  pdfGenerations.set(assetId, next);
  return next;
}

function abortError(message = "Đã hủy tác vụ PDF không còn được sử dụng.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function cachedDocument(assetId: string) {
  const record = docCache.get(assetId);
  if (!record) return undefined;
  docCache.delete(assetId);
  docCache.set(assetId, record);
  return record;
}

function safeDestroyLoadingTask(task: PDFDocumentLoadingTask) {
  if (destroyedLoadingTasks.has(task)) return;
  destroyedLoadingTasks.add(task);
  try {
    void Promise.resolve(task.destroy()).catch(() => {
      pdfDestroyFailures += 1;
    });
  } catch {
    pdfDestroyFailures += 1;
  }
}

function destroyDocument(record: PdfDocumentRecord) {
  if (record.destroyStarted) return;
  record.destroyStarted = true;
  retiredDocuments.delete(record);
  safeDestroyLoadingTask(record.loadingTask);
}

function retireDocument(record: PdfDocumentRecord) {
  if (record.retired) return;
  record.retired = true;
  if (docCache.get(record.assetId) === record) docCache.delete(record.assetId);
  if (loadingTaskCache.get(record.assetId) === record.loadingTask) {
    loadingTaskCache.delete(record.assetId);
  }
  pdfEvictions += 1;
  if (record.references === 0) destroyDocument(record);
  else retiredDocuments.add(record);
}

function trimDocumentCache() {
  while (docCache.size > MAX_PDF_DOCUMENTS) {
    const candidate = [...docCache.values()].find(
      (record) =>
        record.references === 0 && (pendingDocumentAcquires.get(record.assetId) ?? 0) === 0,
    );
    if (!candidate) return;
    retireDocument(candidate);
  }
}

function addPendingAcquire(assetId: string) {
  pendingDocumentAcquires.set(assetId, (pendingDocumentAcquires.get(assetId) ?? 0) + 1);
}

function removePendingAcquire(assetId: string) {
  const remaining = (pendingDocumentAcquires.get(assetId) ?? 1) - 1;
  if (remaining > 0) pendingDocumentAcquires.set(assetId, remaining);
  else pendingDocumentAcquires.delete(assetId);
}

function leaseDocument(record: PdfDocumentRecord): PdfDocumentLease {
  if (
    record.retired ||
    generationFor(record.assetId) !== record.generation ||
    docCache.get(record.assetId) !== record
  ) {
    throw abortError();
  }
  record.references += 1;
  cachedDocument(record.assetId);
  let released = false;
  return {
    document: record.document,
    release() {
      if (released) return;
      released = true;
      record.references = Math.max(0, record.references - 1);
      if (record.retired && record.references === 0) destroyDocument(record);
      else trimDocumentCache();
    },
  };
}

async function loadPdfDocumentRecord(assetId: string, data: ArrayBuffer | Uint8Array) {
  const cached = cachedDocument(assetId);
  if (cached) return cached;
  const pending = docPromiseCache.get(assetId);
  if (pending) return pending;
  const generation = generationFor(assetId);
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let loadingTaskDisposed = false;
  const disposeLoadingTask = () => {
    if (!loadingTask || loadingTaskDisposed) return;
    loadingTaskDisposed = true;
    safeDestroyLoadingTask(loadingTask);
  };
  const loadingRef: { current?: Promise<PdfDocumentRecord> } = {};
  const loading: Promise<PdfDocumentRecord> = (async () => {
    try {
      const pdfjs = await getPdfjs();
      if (
        generationFor(assetId) !== generation ||
        docPromiseCache.get(assetId) !== loadingRef.current
      ) {
        throw abortError();
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      loadingTask = pdfjs.getDocument({ data: bytes, disableAutoFetch: false });
      loadingTaskCache.set(assetId, loadingTask);
      const doc = await loadingTask.promise;
      if (
        generationFor(assetId) !== generation ||
        docPromiseCache.get(assetId) !== loadingRef.current
      ) {
        pdfStaleDiscards += 1;
        disposeLoadingTask();
        throw abortError();
      }
      const record: PdfDocumentRecord = {
        assetId,
        generation,
        document: doc,
        loadingTask,
        references: 0,
        retired: false,
        destroyStarted: false,
      };
      docCache.set(assetId, record);
      return record;
    } catch (error) {
      const stale =
        generationFor(assetId) !== generation ||
        docPromiseCache.get(assetId) !== loadingRef.current;
      disposeLoadingTask();
      if (stale || (error instanceof Error && error.name === "AbortError")) throw abortError();
      pdfFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (/password/i.test(message)) {
        throw new Error("Tệp PDF có mật khẩu. Ứng dụng chưa hỗ trợ PDF được bảo vệ.");
      }
      throw new Error("Không đọc được PDF. Tệp có thể bị hỏng hoặc chưa được hỗ trợ.");
    } finally {
      if (docPromiseCache.get(assetId) === loadingRef.current) docPromiseCache.delete(assetId);
      if (!docCache.has(assetId) && loadingTaskCache.get(assetId) === loadingTask) {
        loadingTaskCache.delete(assetId);
      }
    }
  })();
  loadingRef.current = loading;
  docPromiseCache.set(assetId, loading);
  return loading;
}

async function loadStoredPdfDocumentRecord(assetId: string) {
  const cached = cachedDocument(assetId);
  if (cached) return cached;
  const pending = docPromiseCache.get(assetId);
  if (pending) return pending;
  const pendingStoredRead = storedPdfPromiseCache.get(assetId);
  if (pendingStoredRead) return pendingStoredRead;
  const generation = generationFor(assetId);
  const readingRef: { current?: Promise<PdfDocumentRecord> } = {};
  const reading: Promise<PdfDocumentRecord> = (async () => {
    try {
      const { getAsset } = await import("./db");
      const asset = await getAsset(assetId);
      if (!asset) throw new Error("Không tìm thấy tệp PDF trong kho Notes.");
      const bytes = await asset.blob.arrayBuffer();
      if (generationFor(assetId) !== generation) throw abortError();
      return loadPdfDocumentRecord(assetId, bytes);
    } finally {
      if (storedPdfPromiseCache.get(assetId) === readingRef.current) {
        storedPdfPromiseCache.delete(assetId);
      }
    }
  })();
  readingRef.current = reading;
  storedPdfPromiseCache.set(assetId, reading);
  return reading;
}

async function acquireDocument(
  assetId: string,
  load: () => Promise<PdfDocumentRecord>,
): Promise<PdfDocumentLease> {
  addPendingAcquire(assetId);
  try {
    const record = await load();
    return leaseDocument(record);
  } finally {
    removePendingAcquire(assetId);
    trimDocumentCache();
  }
}

export function acquirePdfDocument(assetId: string, data: ArrayBuffer | Uint8Array) {
  return acquireDocument(assetId, () => loadPdfDocumentRecord(assetId, data));
}

export function acquireStoredPdfDocument(assetId: string) {
  return acquireDocument(assetId, () => loadStoredPdfDocumentRecord(assetId));
}

export function evictPdf(assetId: string) {
  const hasTransientState =
    docCache.has(assetId) ||
    docPromiseCache.has(assetId) ||
    storedPdfPromiseCache.has(assetId) ||
    loadingTaskCache.has(assetId) ||
    bitmapKeysByAsset.has(assetId);
  if (!hasTransientState) return;
  advanceGeneration(assetId);
  const record = docCache.get(assetId);
  const pendingDocument = docPromiseCache.has(assetId) || storedPdfPromiseCache.has(assetId);
  const loadingTask = loadingTaskCache.get(assetId);
  if (record) retireDocument(record);
  else if (pendingDocument || loadingTask) pdfEvictions += 1;
  docPromiseCache.delete(assetId);
  storedPdfPromiseCache.delete(assetId);
  if (loadingTask && loadingTask !== record?.loadingTask) {
    safeDestroyLoadingTask(loadingTask);
    loadingTaskCache.delete(assetId);
  }
  const keys = bitmapKeysByAsset.get(assetId);
  if (keys) {
    for (const key of keys) {
      bitmapRequests.delete(key);
      bitmapCache.invalidate(key);
    }
    bitmapKeysByAsset.delete(assetId);
  }
}

export function evictAllPdfs() {
  const assetIds = new Set([
    ...docCache.keys(),
    ...docPromiseCache.keys(),
    ...storedPdfPromiseCache.keys(),
    ...loadingTaskCache.keys(),
    ...bitmapKeysByAsset.keys(),
  ]);
  for (const assetId of assetIds) evictPdf(assetId);
}

const MAX_BITMAP_ENTRIES = 12;
const MAX_BITMAP_PIXELS = 24_000_000;
const MAX_SINGLE_BITMAP_PIXELS = 8_000_000;
const MAX_BITMAP_CONCURRENT = 3;

interface BitmapRequest {
  readonly assetId: string;
  readonly generation: number;
  readonly doc: PDFDocumentProxy;
  readonly pageNumber: number;
  readonly scale: number;
  readonly rotation: number;
}

export interface PdfBitmapLease {
  readonly bitmap: ImageBitmap;
  release(): void;
}

const bitmapRequests = new Map<string, BitmapRequest>();
const bitmapKeysByAsset = new Map<string, Set<string>>();

function forgetBitmapKey(assetId: string, key: string) {
  const keys = bitmapKeysByAsset.get(assetId);
  keys?.delete(key);
  if (keys?.size === 0) bitmapKeysByAsset.delete(assetId);
}

function scaleBucket(scale: number) {
  if (scale < 1.1) return 1;
  if (scale < 1.6) return 1.5;
  if (scale < 2.2) return 2;
  return 2.5;
}

const bitmapCache = createDecodedResourceCache<ImageBitmap>({
  maxEntries: MAX_BITMAP_ENTRIES,
  maxBytes: MAX_BITMAP_PIXELS * 4,
  maxConcurrent: MAX_BITMAP_CONCURRENT,
  releaseGraceMs: 150,
  async load(key, signal) {
    const request = bitmapRequests.get(key);
    if (!request || generationFor(request.assetId) !== request.generation) throw abortError();
    let canvas: HTMLCanvasElement | null = null;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    const onAbort = () => renderTask?.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const page = await request.doc.getPage(request.pageNumber);
      if (signal.aborted || generationFor(request.assetId) !== request.generation) {
        throw abortError();
      }
      let viewport = page.getViewport({ scale: request.scale, rotation: request.rotation });
      const initialPixels = Math.max(1, viewport.width * viewport.height);
      if (initialPixels > MAX_SINGLE_BITMAP_PIXELS) {
        const reduction = Math.sqrt(MAX_SINGLE_BITMAP_PIXELS / initialPixels);
        viewport = page.getViewport({
          scale: request.scale * reduction,
          rotation: request.rotation,
        });
      }
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Không tạo được canvas để render PDF.");
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      await renderTask.promise;
      if (signal.aborted || generationFor(request.assetId) !== request.generation) {
        throw abortError();
      }
      const bitmap = await createImageBitmap(canvas);
      if (signal.aborted || generationFor(request.assetId) !== request.generation) {
        bitmap.close();
        bitmapStaleDiscards += 1;
        throw abortError();
      }
      return {
        value: bitmap,
        estimatedBytes: bitmap.width * bitmap.height * 4,
        dispose() {
          bitmap.close();
          forgetBitmapKey(request.assetId, key);
        },
      };
    } catch (error) {
      forgetBitmapKey(request.assetId, key);
      if (
        signal.aborted ||
        generationFor(request.assetId) !== request.generation ||
        (error instanceof Error && error.name === "RenderingCancelledException")
      ) {
        throw abortError();
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (bitmapRequests.get(key) === request) bitmapRequests.delete(key);
      if (canvas) {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
  },
});

function waitForBitmap(
  lease: ResourceLease<ImageBitmap>,
  signal: AbortSignal | undefined,
  release: () => void,
) {
  if (!signal) return lease.promise;
  if (signal.aborted) {
    release();
    return Promise.reject(abortError());
  }
  return new Promise<ImageBitmap>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      release();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void lease.promise.then(
      (bitmap) => {
        cleanup();
        resolve(bitmap);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function renderPdfPageBitmap(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  rotation: number,
  cacheKey: string,
  signal?: AbortSignal,
  priority: ResourcePriority = "visible",
): Promise<PdfBitmapLease> {
  if (signal?.aborted) throw abortError();
  const bucket = scaleBucket(scale);
  const generation = generationFor(cacheKey);
  const key = `${generation}:${cacheKey}:${pageNumber}:${bucket}:${rotation}`;
  if (!bitmapCache.peek(key) && !bitmapRequests.has(key)) {
    bitmapRequests.set(key, {
      assetId: cacheKey,
      generation,
      doc,
      pageNumber,
      scale: bucket,
      rotation,
    });
  }
  const keys = bitmapKeysByAsset.get(cacheKey) ?? new Set<string>();
  keys.add(key);
  bitmapKeysByAsset.set(cacheKey, keys);

  const owned = bitmapCache.acquire(key, priority);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    owned.release();
  };
  try {
    const bitmap = await waitForBitmap(owned, signal, release);
    return { bitmap, release };
  } catch (error) {
    release();
    throw error;
  }
}

export function getPdfCacheStats() {
  const bitmap = bitmapCache.getStats();
  const activeDocuments = [...docCache.values()].filter((record) => record.references > 0).length;
  return {
    documents: docCache.size,
    activeDocuments,
    documentReferences: [...docCache.values(), ...retiredDocuments].reduce(
      (total, record) => total + record.references,
      0,
    ),
    retiredActiveDocuments: retiredDocuments.size,
    pendingDocumentAcquires: [...pendingDocumentAcquires.values()].reduce(
      (total, count) => total + count,
      0,
    ),
    pendingDocuments: docPromiseCache.size,
    pendingStoredReads: storedPdfPromiseCache.size,
    loadingTasks: loadingTaskCache.size,
    bitmaps: bitmap.ready,
    pendingBitmaps: bitmap.queued + bitmap.loading,
    cachedBitmapPixels: Math.floor(bitmap.estimatedBytes / 4),
    estimatedBitmapBytes: bitmap.estimatedBytes,
    maxDocuments: MAX_PDF_DOCUMENTS,
    maxBitmapEntries: MAX_BITMAP_ENTRIES,
    maxBitmapPixels: MAX_BITMAP_PIXELS,
    maxSingleBitmapPixels: MAX_SINGLE_BITMAP_PIXELS,
    maxBitmapConcurrent: MAX_BITMAP_CONCURRENT,
    activeBitmapRenders: bitmap.activeLoads,
    peakBitmapRenders: bitmap.peakConcurrent,
    pdfEvictions,
    pdfStaleDiscards,
    pdfFailures,
    pdfDestroyFailures,
    bitmapEvictions: bitmap.evictions,
    bitmapCancellations: bitmap.cancellations,
    bitmapStaleDiscards,
    bitmapFailures: bitmap.failures,
  };
}

export async function pdfPageSizes(doc: PDFDocumentProxy) {
  const sizes = new Array<{ width: number; height: number }>(doc.numPages);
  let nextPage = 1;
  const workers = Array.from({ length: Math.min(6, doc.numPages) }, async () => {
    while (nextPage <= doc.numPages) {
      const pageNumber = nextPage;
      nextPage += 1;
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      sizes[pageNumber - 1] = { width: viewport.width, height: viewport.height };
    }
  });
  await Promise.all(workers);
  return sizes;
}

export async function pdfOutline(doc: PDFDocumentProxy) {
  try {
    const outline = await doc.getOutline();
    if (!outline) return [];
    const destPage = async (dest: unknown): Promise<number | null> => {
      try {
        const d = typeof dest === "string" ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(d) || !d[0]) return null;
        const idx = await doc.getPageIndex(d[0] as never);
        return idx;
      } catch {
        return null;
      }
    };
    type Item = { title: string; pageIndex: number; items?: Item[] };
    const walk = async (nodes: typeof outline): Promise<Item[]> => {
      const out: Item[] = [];
      for (const n of nodes) {
        const pageIndex = await destPage(n.dest);
        const item: Item = { title: n.title || "Mục", pageIndex: pageIndex ?? 0 };
        if (n.items?.length) item.items = await walk(n.items);
        out.push(item);
      }
      return out;
    };
    return walk(outline);
  } catch {
    return [];
  }
}

export async function searchPdfText(doc: PDFDocumentProxy, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { pageIndex: number; text: string }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ");
    if (text.toLowerCase().includes(q)) {
      hits.push({ pageIndex: i - 1, text: text.slice(0, 180) });
    }
  }
  return hits;
}
