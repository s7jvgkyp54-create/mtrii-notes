import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

let pdfjsMod: typeof import("pdfjs-dist") | null = null;

export async function getPdfjs() {
  if (pdfjsMod) return pdfjsMod;
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")) as { default: string };
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  pdfjsMod = pdfjs;
  return pdfjs;
}

const docCache = new Map<string, PDFDocumentProxy>();
const docPromiseCache = new Map<string, Promise<PDFDocumentProxy>>();
const loadingTaskCache = new Map<string, PDFDocumentLoadingTask>();
const MAX_PDF_DOCUMENTS = 3;

function cachedDocument(assetId: string) {
  const doc = docCache.get(assetId);
  if (!doc) return undefined;
  docCache.delete(assetId);
  docCache.set(assetId, doc);
  return doc;
}

export async function loadPdfDocument(assetId: string, data: ArrayBuffer | Uint8Array) {
  const cached = cachedDocument(assetId);
  if (cached) return cached;
  const pending = docPromiseCache.get(assetId);
  if (pending) return pending;
  const pdfjs = await getPdfjs();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const loadingTask = pdfjs.getDocument({ data: bytes, disableAutoFetch: false });
  loadingTaskCache.set(assetId, loadingTask);
  const loading = loadingTask.promise
    .then((doc) => {
      docCache.set(assetId, doc);
      while (docCache.size > MAX_PDF_DOCUMENTS) {
        const oldest = docCache.keys().next().value as string | undefined;
        if (!oldest || oldest === assetId) break;
        evictPdf(oldest);
      }
      return doc;
    })
    .catch((err) => {
      loadingTaskCache.delete(assetId);
      const msg = err instanceof Error ? err.message : String(err);
      if (/password/i.test(msg)) {
        throw new Error("Tệp PDF có mật khẩu. Ứng dụng chưa hỗ trợ PDF được bảo vệ.");
      }
      throw new Error("Không đọc được PDF. Tệp có thể bị hỏng hoặc chưa được hỗ trợ.");
    })
    .finally(() => docPromiseCache.delete(assetId));
  docPromiseCache.set(assetId, loading);
  return loading;
}

export async function loadStoredPdfDocument(assetId: string) {
  const cached = cachedDocument(assetId);
  if (cached) return cached;
  const pending = docPromiseCache.get(assetId);
  if (pending) return pending;
  const { getAsset } = await import("./db");
  const asset = await getAsset(assetId);
  if (!asset) throw new Error("Không tìm thấy tệp PDF trong kho Notes.");
  return loadPdfDocument(assetId, await asset.blob.arrayBuffer());
}

export function evictPdf(assetId: string) {
  const doc = docCache.get(assetId);
  if (doc) {
    void doc.cleanup();
    docCache.delete(assetId);
  }
  docPromiseCache.delete(assetId);
  const loadingTask = loadingTaskCache.get(assetId);
  if (loadingTask) {
    void loadingTask.destroy();
    loadingTaskCache.delete(assetId);
  }
  for (const [key, entry] of pageBmp) {
    if (!key.startsWith(`${assetId}:`)) continue;
    entry.bmp.close();
    cachedBitmapPixels -= entry.pixels;
    pageBmp.delete(key);
  }
}

interface BitmapCacheEntry {
  bmp: ImageBitmap;
  pixels: number;
}

const pageBmp = new Map<string, BitmapCacheEntry>();
const bitmapPromises = new Map<string, Promise<ImageBitmap>>();
const MAX_BITMAP_ENTRIES = 12;
const MAX_BITMAP_PIXELS = 24_000_000;
let cachedBitmapPixels = 0;

function scaleBucket(scale: number) {
  if (scale < 1.1) return 1;
  if (scale < 1.6) return 1.5;
  if (scale < 2.2) return 2;
  return 2.5;
}

export async function renderPdfPageBitmap(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  rotation: number,
  cacheKey: string,
): Promise<ImageBitmap> {
  const bucket = scaleBucket(scale);
  const key = `${cacheKey}:${pageNumber}:${bucket}:${rotation}`;
  const hit = pageBmp.get(key);
  if (hit) {
    pageBmp.delete(key);
    pageBmp.set(key, hit);
    return hit.bmp;
  }
  const pending = bitmapPromises.get(key);
  if (pending) return pending;

  const rendering = (async () => {
    const page: PDFPageProxy = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: bucket, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Không tạo được canvas để render PDF.");
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const bmp = await createImageBitmap(canvas);
    const pixels = bmp.width * bmp.height;
    pageBmp.set(key, { bmp, pixels });
    cachedBitmapPixels += pixels;
    while (pageBmp.size > MAX_BITMAP_ENTRIES || cachedBitmapPixels > MAX_BITMAP_PIXELS) {
      const oldestKey = pageBmp.keys().next().value as string | undefined;
      if (!oldestKey || oldestKey === key) break;
      const oldest = pageBmp.get(oldestKey);
      oldest?.bmp.close();
      cachedBitmapPixels -= oldest?.pixels ?? 0;
      pageBmp.delete(oldestKey);
    }
    return bmp;
  })().finally(() => bitmapPromises.delete(key));
  bitmapPromises.set(key, rendering);
  return rendering;
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
