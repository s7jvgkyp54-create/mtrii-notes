import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

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

export async function loadPdfDocument(assetId: string, data: ArrayBuffer | Uint8Array) {
  const cached = docCache.get(assetId);
  if (cached) return cached;
  const pdfjs = await getPdfjs();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    const doc = await pdfjs.getDocument({ data: bytes, disableAutoFetch: false }).promise;
    docCache.set(assetId, doc);
    return doc;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/password/i.test(msg)) {
      throw new Error("Tệp PDF có mật khẩu. Ứng dụng chưa hỗ trợ PDF được bảo vệ.");
    }
    throw new Error("Không đọc được PDF. Tệp có thể bị hỏng hoặc chưa được hỗ trợ.");
  }
}

export function evictPdf(assetId: string) {
  const doc = docCache.get(assetId);
  if (doc) {
    void doc.cleanup();
    docCache.delete(assetId);
  }
}

const pageBmp = new Map<string, { bucket: number; bmp: ImageBitmap }>();

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
  if (hit) return hit.bmp;
  const page: PDFPageProxy = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: bucket, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không tạo được canvas để render PDF.");
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const bmp = await createImageBitmap(canvas);
  pageBmp.set(key, { bucket, bmp });
  if (pageBmp.size > 16) {
    const first = pageBmp.keys().next().value;
    if (first) {
      pageBmp.get(first)?.bmp.close();
      pageBmp.delete(first);
    }
  }
  return bmp;
}

export async function pdfPageSizes(doc: PDFDocumentProxy) {
  const sizes: { width: number; height: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const v = page.getViewport({ scale: 1 });
    sizes.push({ width: v.width, height: v.height });
  }
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
