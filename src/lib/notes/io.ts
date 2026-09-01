import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
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

// Rasterize all annotations (strokes, shapes, text, images) onto a canvas
// then embed the result as a PNG layer into the PDF page.
// This approach guarantees the exported PDF is always viewable.
async function drawObjectsOnPdfPage(
  pdfDoc: PDFDocument,
  pdfPage: import("pdf-lib").PDFPage,
  objects: CanvasObject[],
  pageW: number,
  pageH: number,
  imageCache: Map<string, any>,
  customFont: import("pdf-lib").PDFFont | null
) {
  if (!objects.length) return;
  for (const o of objects) {
    if (o.type === "stroke") {
      const path = strokeToSvgPath(o);
      if (path) {
        pdfPage.drawSvgPath(path, {
          x: 0,
          y: pageH,
          color: hexRgb(o.color),
          borderWidth: 0,
          opacity: o.tool === "highlighter" ? 0.5 : 1,
        });
      }
    } else if (o.type === "text") {
      if (customFont) {
        const lines = o.text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          pdfPage.drawText(lines[i], {
            x: o.x,
            y: pageH - o.y - (i * o.fontSize * 1.35) - o.fontSize,
            size: o.fontSize,
            font: customFont,
            color: hexRgb(o.color),
          });
        }
      }
    } else if (o.type === "image") {
      try {
        let img = imageCache.get(o.assetId);
        if (!img) {
          const asset = await getAsset(o.assetId);
          if (!asset) continue;
          const bytes = new Uint8Array(await asset.blob.arrayBuffer());
          img = asset.mime.includes("png")
            ? await pdfDoc.embedPng(bytes)
            : await pdfDoc.embedJpg(bytes);
          imageCache.set(o.assetId, img);
        }
        pdfPage.drawImage(img, {
          x: o.x,
          y: pageH - o.y - o.h,
          width: o.w,
          height: o.h,
        });
      } catch {
        // Skip a single unreadable image while preserving the rest of the export.
      }
    }
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

  pdf.registerFontkit(fontkit);
  let customFont = null;
  try {
    const fontRes = await fetch("/fonts/BeVietnamPro-Regular.ttf");
    const fontBytes = await fontRes.arrayBuffer();
    customFont = await pdf.embedFont(fontBytes);
  } catch (e) {
    console.error("Cannot load font", e);
  }

  const imageCache = new Map<string, any>();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const pdfPage = pdf.getPage(Math.min(i, pdf.getPageCount() - 1));
    const objs = objects[page.id] ?? [];
    await drawObjectsOnPdfPage(pdf, pdfPage, objs, pdfPage.getWidth(), pdfPage.getHeight(), imageCache, customFont);
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
    schemaVersion: 1,
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
    schemaVersion?: number;
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
  if (!Number.isInteger(manifest.formatVersion) || manifest.formatVersion < 1) {
    throw new Error("Phiên bản định dạng sao lưu không hợp lệ.");
  }
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    throw new Error(`Schema dữ liệu v${manifest.schemaVersion} chưa được hỗ trợ.`);
  }
  const checksumsFile = zip.file("checksums.json");
  const warnings: string[] = [];
  if (checksumsFile) {
    const checksums = JSON.parse(await checksumsFile.async("string")) as Record<string, string>;
    const protectedPaths = [
      "data/library.json",
      ...names.filter((name) => name.startsWith("assets/") && !name.endsWith("/")),
    ];
    for (const path of protectedPaths) {
      if (typeof checksums[path] !== "string") {
        throw new Error(`Thiếu checksum cho ${path}.`);
      }
    }
    for (const [path, expected] of Object.entries(checksums)) {
      const f = zip.file(path);
      if (!f) {
        throw new Error(`Thiếu tài nguyên đã khai báo: ${path}.`);
      }
      const buf = await f.async("uint8array");
      const got = await sha256Hex(buf);
      if (got !== expected) throw new Error(`Checksum không khớp: ${path}.`);
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
    tombstones?: import("./types").Tombstone[];
  };
  if (
    !Array.isArray(lib.folders) ||
    !Array.isArray(lib.notebooks) ||
    !Array.isArray(lib.pages) ||
    !Array.isArray(lib.pageObjects) ||
    !Array.isArray(lib.bookmarks)
  ) {
    throw new Error("Cấu trúc data/library.json không hợp lệ.");
  }
  const notebookIds = new Set(lib.notebooks.map((notebook) => notebook?.id));
  const pageIds = new Set(lib.pages.map((page) => page?.id));
  if (
    lib.notebooks.some((notebook) => !notebook?.id || typeof notebook.name !== "string") ||
    lib.pages.some(
      (page) =>
        !page?.id ||
        !notebookIds.has(page.notebookId) ||
        !Number.isFinite(page.index) ||
        !Number.isFinite(page.width) ||
        !Number.isFinite(page.height),
    ) ||
    lib.pageObjects.some(
      (row) => !row?.pageId || !pageIds.has(row.pageId) || !Array.isArray(row.objects),
    )
  ) {
    throw new Error("Dữ liệu sổ hoặc trang trong bản sao lưu không hợp lệ.");
  }

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

  if (
    manifest.notebookCount !== lib.notebooks.length ||
    manifest.pageCount !== lib.pages.length ||
    (manifest.assetCount !== undefined && manifest.assetCount !== assets.length)
  ) {
    throw new Error("Số lượng dữ liệu không khớp với MANIFEST.json.");
  }
  if (manifest.schemaVersion === undefined) {
    warnings.push("Bản sao lưu cũ chưa khai báo schemaVersion; đã kiểm tra bằng cấu trúc tương thích.");
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

export async function buildVerifiedBackupZip(kind: "full" | "notebook", notebookId?: string) {
  const built = await buildBackupZip(kind, notebookId);
  const preview = await inspectBackup(built.blob);
  if (preview.warnings.length > 0) {
    throw new Error(`Bản sao lưu chưa vượt qua kiểm tra: ${preview.warnings.join(" ")}`);
  }
  return built;
}

export function remapBackupDump(dump: LibraryDump) {
  return remapIds(dump);
}
