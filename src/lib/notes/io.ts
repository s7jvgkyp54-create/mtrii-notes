import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import {
  APP_ID,
  APP_NAME,
  APP_VERSION,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type AssetRecord,
  type CanvasObject,
  type Notebook,
  type PageRecord,
} from "./types";
import { dumpAll, getAsset } from "./db";
import { sha256Hex } from "@/lib/utils";
import { strokeToSvgPath } from "./render";

export const BACKUP_README = `Định dạng sao lưu Notes (.notesbackup)
====================================
Đây là định dạng sao lưu của Notes (com.notes.app), KHÔNG phải định dạng Goodnotes.

Cấu trúc gói ZIP:
  MANIFEST.json     Mô tả phiên bản, thời điểm, số sổ/trang
  README.txt        Tài liệu này
  checksums.json    SHA-256 từng tệp
  data/library.json Thư mục, sổ, trang, đối tượng, dấu trang (nét còn chỉnh sửa được)
  assets/{id}.{ext} PDF gốc, ảnh, âm thanh

formatVersion hiện tại: ${BACKUP_FORMAT_VERSION}
Ứng dụng: ${APP_NAME} ${APP_VERSION}

Cách dùng: trong Notes → Cài đặt → Sao lưu và khôi phục → Nhập bản sao lưu.
Mặc định nhập vào thư viện hiện có (gộp, cấp ID mới) để không ghi đè.
PDF xuất (gộp ghi chú) không thay thế gói .mtriibackup.
`;

function hexRgb(hex: string) {
  const c = hex.replace("#", "");
  return rgb(
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255,
  );
}

function flipY(y: number, pageH: number) {
  return pageH - y;
}

// Rasterize all annotations (strokes, shapes, text, images) onto a canvas
// then embed the result as a PNG layer into the PDF page.
// This approach guarantees the exported PDF is always viewable.
async function rasterizeAnnotations(
  objects: CanvasObject[],
  pageW: number,
  pageH: number,
  scale: number,
): Promise<Uint8Array | null> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(pageW * scale);
    canvas.height = Math.round(pageH * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(scale, scale);

    const { drawStroke, drawShape, drawText } = await import("./render");

    for (const o of objects) {
      if (o.type === "stroke") {
        drawStroke(ctx, o);
      } else if (o.type === "shape") {
        drawShape(ctx, o);
      } else if (o.type === "text") {
        drawText(ctx, o);
      } else if (o.type === "image") {
        try {
          const { getAsset, objectUrlFor } = await import("./db");
          const asset = await getAsset(o.assetId);
          if (!asset) continue;
          const url = objectUrlFor(o.assetId, asset.blob);
          await new Promise<void>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              ctx.save();
              ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
              ctx.rotate((o.rotation * Math.PI) / 180);
              ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
              ctx.restore();
              resolve();
            };
            img.onerror = () => reject(new Error("Cannot load image"));
            img.src = url;
          });
        } catch {
          /* skip missing image */
        }
      }
    }

    const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function drawObjectsOnPdfPage(
  pdfDoc: PDFDocument,
  pdfPage: import("pdf-lib").PDFPage,
  objects: CanvasObject[],
  pageW: number,
  pageH: number,
) {
  if (!objects.length) return;
  // Rasterize at 2x for sharpness
  const png = await rasterizeAnnotations(objects, pageW, pageH, 2);
  if (!png) return;
  try {
    const embedded = await pdfDoc.embedPng(png);
    pdfPage.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pageW,
      height: pageH,
    });
  } catch {
    /* skip if embedding fails */
  }
}

async function rasterizeText(o: Extract<CanvasObject, { type: "text" }>) {
  try {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.ceil(o.w * scale));
    canvas.height = Math.max(2, Math.ceil(o.h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.clearRect(0, 0, o.w, o.h);
    ctx.fillStyle = o.color;
    ctx.font = `${o.fontSize}px "Be Vietnam Pro", sans-serif`;
    ctx.textBaseline = "top";
    o.text.split("\n").forEach((line, i) => {
      ctx.fillText(line, 0, i * o.fontSize * 1.35, o.w);
    });
    const blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

export async function exportNotebookPdf(opts: {
  notebook: Notebook;
  pages: PageRecord[];
  objects: Record<string, CanvasObject[]>;
}): Promise<Uint8Array> {
  const { notebook, pages, objects } = opts;
  let pdf: PDFDocument;
  if (notebook.pdfAssetId) {
    const asset = await getAsset(notebook.pdfAssetId);
    if (!asset) throw new Error("Thiếu tệp PDF gốc trong kho.");
    pdf = await PDFDocument.load(await asset.blob.arrayBuffer(), { ignoreEncryption: true });
  } else {
    pdf = await PDFDocument.create();
    for (const page of pages) {
      pdf.addPage([page.width, page.height]);
    }
  }

  const imageCache = new Map<string, Awaited<ReturnType<PDFDocument["embedPng"]>>>();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const pdfPage = pdf.getPage(Math.min(i, pdf.getPageCount() - 1));
    const pageH = pdfPage.getHeight();
    const objs = objects[page.id] ?? [];

    const embedImage = async (assetId: string) => {
      const obj = objs.find((o) => o.type === "image" && o.assetId === assetId);
      if (!obj || obj.type !== "image") return;
      let img = imageCache.get(assetId);
      if (!img) {
        const asset = await getAsset(assetId);
        if (!asset) return;
        const bytes = new Uint8Array(await asset.blob.arrayBuffer());
        img = asset.mime.includes("png")
          ? await pdf.embedPng(bytes)
          : await pdf.embedJpg(bytes);
        imageCache.set(assetId, img);
      }
      pdfPage.drawImage(img, {
        x: obj.x,
        y: pageH - obj.y - obj.h,
        width: obj.w,
        height: obj.h,
      });
    };

    await drawObjectsOnPdfPage(pdf, pdfPage, objs, pdfPage.getWidth(), pdfPage.getHeight());
  }

  pdf.setTitle(notebook.name);
  pdf.setCreator(`${APP_NAME} ${APP_VERSION}`);
  pdf.setProducer(APP_ID);
  return pdf.save();
}

type LibraryDump = Awaited<ReturnType<typeof dumpAll>>;

function remapIds(dump: LibraryDump): LibraryDump {
  const map = new Map<string, string>();
  const id = (old: string) => {
    const n = map.get(old) ?? crypto.randomUUID();
    map.set(old, n);
    return n;
  };
  const folders = dump.folders.map((f) => ({
    ...f,
    id: id(f.id),
    parentId: f.parentId ? id(f.parentId) : null,
  }));
  const notebooks = dump.notebooks.map((n) => ({
    ...n,
    id: id(n.id),
    folderId: n.folderId ? id(n.folderId) : null,
    pdfAssetId: n.pdfAssetId ? id(n.pdfAssetId) : null,
  }));
  const pages = dump.pages.map((p) => ({
    ...p,
    id: id(p.id),
    notebookId: id(p.notebookId),
  }));
  const pageObjects = dump.pageObjects.map((po) => ({
    pageId: id(po.pageId),
    objects: po.objects.map((o) => {
      const next = { ...o, id: crypto.randomUUID() };
      if (next.type === "image") next.assetId = id(next.assetId);
      return next as CanvasObject;
    }),
  }));
  const assets = dump.assets.map((a) => ({ ...a, id: id(a.id) }));
  const bookmarks = dump.bookmarks.map((b) => ({
    ...b,
    id: id(b.id),
    notebookId: id(b.notebookId),
    pageId: id(b.pageId),
  }));
  return { ...dump, folders, notebooks, pages, pageObjects, assets, bookmarks };
}

export async function buildBackupZip(kind: "full" | "notebook", notebookId?: string) {
  const dump = await dumpAll();
  let data = dump;
  if (kind === "notebook" && notebookId) {
    const nbs = dump.notebooks.filter((n) => n.id === notebookId);
    const pages = dump.pages.filter((p) => p.notebookId === notebookId);
    const pageIds = new Set(pages.map((p) => p.id));
    const pageObjects = dump.pageObjects.filter((p) => pageIds.has(p.pageId));
    const bookmarks = dump.bookmarks.filter((b) => b.notebookId === notebookId);
    const assetIds = new Set<string>();
    nbs.forEach((n) => n.pdfAssetId && assetIds.add(n.pdfAssetId));
    pageObjects.forEach((po) =>
      po.objects.forEach((o) => {
        if (o.type === "image") assetIds.add(o.assetId);
      }),
    );
    data = {
      ...dump,
      folders: dump.folders.filter((f) => nbs.some((n) => n.folderId === f.id)),
      notebooks: nbs,
      pages,
      pageObjects,
      bookmarks,
      assets: dump.assets.filter((a) => assetIds.has(a.id)),
    };
  }

  const zip = new JSZip();
  const libraryJson = JSON.stringify(
    {
      folders: data.folders,
      notebooks: data.notebooks,
      pages: data.pages,
      pageObjects: data.pageObjects.map((p) => ({ pageId: p.pageId, objects: p.objects })),
      bookmarks: data.bookmarks,
      settings: kind === "full" ? data.settings : undefined,
    },
    null,
    2,
  );
  zip.file("data/library.json", libraryJson);

  const checksums: Record<string, string> = {};
  checksums["data/library.json"] = await sha256Hex(new TextEncoder().encode(libraryJson));

  for (const asset of data.assets) {
    const ext = asset.kind === "pdf" ? "pdf" : asset.mime.includes("png") ? "png" : "bin";
    const path = `assets/${asset.id}.${ext}`;
    const buf = await asset.blob.arrayBuffer();
    zip.file(path, buf);
    checksums[path] = await sha256Hex(buf);
  }

  zip.file("checksums.json", JSON.stringify(checksums, null, 2));
  zip.file("README.txt", BACKUP_README);

  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: APP_NAME,
    appVersion: APP_VERSION,
    identifier: APP_ID,
    createdAt: new Date().toISOString(),
    notebookCount: data.notebooks.length,
    pageCount: data.pages.length,
    assetCount: data.assets.length,
    kind,
  };
  zip.file("MANIFEST.json", JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return { blob, manifest };
}

export interface BackupPreview {
  manifest: {
    format: string;
    formatVersion: number;
    app: string;
    appVersion: string;
    createdAt: string;
    notebookCount: number;
    pageCount: number;
    assetCount?: number;
  };
  notebookNames: string[];
  warnings: string[];
  dump: LibraryDump;
}

export async function inspectBackup(file: Blob): Promise<BackupPreview> {
  const zip = await JSZip.loadAsync(file);
  const names = Object.keys(zip.files);
  for (const n of names) {
    if (n.includes("..") || n.startsWith("/") || n.startsWith("\\")) {
      throw new Error("Gói sao lưu chứa đường dẫn không an toàn.");
    }
  }
  const manFile = zip.file("MANIFEST.json");
  if (!manFile) throw new Error("Thiếu MANIFEST.json — không phải gói Notes.");
  const manifest = JSON.parse(await manFile.async("string")) as BackupPreview["manifest"];
  if (manifest.format !== BACKUP_FORMAT) {
    throw new Error("Định dạng không phải .mtriibackup của Notes.");
  }
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Bản sao lưu (định dạng v${manifest.formatVersion}) mới hơn ứng dụng. Hãy nâng cấp Notes rồi nhập lại. Tệp không bị sửa.`,
    );
  }
  const checksumsFile = zip.file("checksums.json");
  const warnings: string[] = [];
  if (checksumsFile) {
    const checksums = JSON.parse(await checksumsFile.async("string")) as Record<string, string>;
    for (const [path, expected] of Object.entries(checksums)) {
      const f = zip.file(path);
      if (!f) {
        warnings.push(`Thiếu tài nguyên: ${path}`);
        continue;
      }
      const buf = await f.async("uint8array");
      const got = await sha256Hex(buf);
      if (got !== expected) warnings.push(`Checksum sai: ${path}`);
    }
  } else {
    warnings.push("Gói không có checksums.json.");
  }
  const libFile = zip.file("data/library.json");
  if (!libFile) throw new Error("Thiếu data/library.json.");
  const lib = JSON.parse(await libFile.async("string")) as {
    folders: LibraryDump["folders"];
    notebooks: Notebook[];
    pages: PageRecord[];
    pageObjects: LibraryDump["pageObjects"];
    bookmarks: LibraryDump["bookmarks"];
    settings?: LibraryDump["settings"];
  };

  const assets: AssetRecord[] = [];
  for (const n of names) {
    if (!n.startsWith("assets/") || n.endsWith("/")) continue;
    const f = zip.file(n);
    if (!f) continue;
    const id = n.slice("assets/".length).replace(/\.[^.]+$/, "");
    const blob = await f.async("blob");
    const ext = n.split(".").pop() ?? "bin";
    const mime =
      ext === "pdf"
        ? "application/pdf"
        : ext === "png"
          ? "image/png"
          : ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : "application/octet-stream";
    const kind = ext === "pdf" ? "pdf" : "image";
    assets.push({
      id,
      kind,
      mime,
      name: n,
      byteLength: blob.size,
      blob,
      createdAt: Date.now(),
    });
  }

  return {
    manifest,
    notebookNames: lib.notebooks.map((n) => n.name),
    warnings,
    dump: {
      folders: lib.folders ?? [],
      notebooks: lib.notebooks,
      pages: lib.pages,
      pageObjects: lib.pageObjects,
      assets,
      bookmarks: lib.bookmarks ?? [],
      settings: lib.settings,
      meta: { importedAt: Date.now() },
    },
  };
}

export function remapBackupDump(dump: LibraryDump) {
  return remapIds(dump);
}
