import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AssetRecord,
  CanvasObject,
  ImageObject,
  PageRecord,
  StrokeObject,
  TextObject,
  ToolName,
} from "@/lib/notes/types";
import { PEN_COLORS } from "@/lib/notes/types";
import { currentPen, useNotesStore } from "@/lib/notes/store";
import {
  applyPageRotation,
  cloneObject,
  displaySize,
  displayToPage,
  dist,
  erasePartial,
  hitTest,
  objectInLasso,
  pageBBoxToDisplay,
  recolor,
  snapShape,
  unionBBox,
  type Pt,
} from "@/lib/notes/geometry";
import { findPageDropTarget, planCanvasObjectDrop } from "@/lib/notes/drag-drop";
import { drawLasso, drawPaper, drawShape, drawStroke, drawText } from "@/lib/notes/render";
import {
  canvasObjectArraysEqual,
  resizeCanvasObjects,
  type ResizeHandle,
} from "@/lib/notes/resize";
import { delAsset, getAsset, putAsset, subscribeTransientAssetInvalidation } from "@/lib/notes/db";
import { acquireStoredPdfDocument, renderPdfPageBitmap } from "@/lib/notes/pdf";
import {
  acquireAssetImage,
  boundedBitmapOptions,
  IMAGE_PREVIEW_MAX_DIMENSION,
  loadAssetImage,
  readRasterDimensionsFromBytes,
  type AssetImageLease,
} from "@/lib/notes/image-cache";
import { pageCanvasDpr, releaseCanvasBackingStore } from "@/lib/notes/canvas-memory";
import { nid } from "@/lib/utils";
import { TextEditorOverlay } from "./text-tool/text-editor-overlay";
import { TextSelectionOverlay } from "./text-tool/text-selection-overlay";
import { TextContextToolbar } from "./text-tool/text-context-toolbar";
import { autoResizeTextObject } from "./text-tool/text-layout";
import { collectActiveTextDrafts } from "@/lib/notes/text-draft-registry";
import {
  canvasPasteSource,
  canDeleteCutSource,
  cloneNotesClipboardObjects,
  createNotesClipboardPayload,
  type NotesClipboardPayload,
  type NotesClipboardWriteStatus,
  writeNotesClipboardData,
} from "@/lib/notes/clipboard";
import { Button } from "@/components/ui/button";
import { Copy, CopyPlus, ImagePlus, Minus, Plus, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const OPEN_IMAGE_PICKER_EVENT = "notes:open-image-picker";
const IMAGE_PREPARE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function readImageSize(blob: Blob) {
  const header = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  const dimensions = readRasterDimensionsFromBytes(header);
  if (!dimensions) {
    throw new Error("Không thể xác định kích thước ảnh để tạo preview an toàn.");
  }

  if (typeof createImageBitmap !== "function") {
    return { w: dimensions.width, h: dimensions.height };
  }

  // Decode only a tiny, bounded probe. Besides validating the payload, its
  // post-orientation aspect ratio keeps portrait camera photos placed correctly
  // without creating a full-resolution HTMLImageElement just to read metadata.
  const probe = await createImageBitmap(blob, boundedBitmapOptions(dimensions, 256));
  try {
    if (!probe.width || !probe.height || Math.max(probe.width, probe.height) > 256) {
      throw new Error("Tệp ảnh không đọc được trong giới hạn preview an toàn.");
    }
    const largest = Math.max(dimensions.width, dimensions.height);
    return probe.width >= probe.height
      ? { w: largest, h: (largest * probe.height) / probe.width }
      : { w: (largest * probe.width) / probe.height, h: largest };
  } finally {
    probe.close();
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
}

function isEditableTarget(target: Element | null) {
  return Boolean(
    target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'),
  );
}

function isDialogTarget(target: Element | null) {
  return Boolean(target?.closest('[role="dialog"], [aria-modal="true"]'));
}

interface TextEditSession {
  sessionId: string;
  notebookId: string;
  pageId: string;
  objectId: string;
  original: TextObject | null;
  originalIndex: number;
  latest: TextObject;
}

function restoreSessionOriginal(objects: CanvasObject[], session: TextEditSession) {
  const restored = objects.filter((object) => object.id !== session.objectId);
  if (session.original) {
    restored.splice(
      Math.min(Math.max(0, session.originalIndex), restored.length),
      0,
      session.original,
    );
  }
  return restored;
}

export function PageSurface({
  page,
  zoom,
  active,
}: {
  page: PageRecord;
  zoom: number;
  active: boolean;
}) {
  const globalObjects = useNotesStore((s) => s.objectsByPage[page.id] ?? EMPTY);
  const [localObjects, setLocalObjects] = useState<CanvasObject[] | null>(null);
  const localRef = useRef<CanvasObject[] | null>(null);
  const localFrameRef = useRef<number | null>(null);
  const dragPreviewRef = useRef<HTMLCanvasElement>(null);
  const dragPreviewOriginRef = useRef<{ left: number; top: number } | null>(null);
  const dragPreviewOffsetRef = useRef<Pt>({ x: 0, y: 0 });
  const dragPreviewFrameRef = useRef<number | null>(null);
  const [movePreviewActive, setMovePreviewActive] = useState(false);

  function updateLocalObjects(next: CanvasObject[] | null) {
    if (localFrameRef.current !== null) {
      window.cancelAnimationFrame(localFrameRef.current);
      localFrameRef.current = null;
    }
    localRef.current = next;
    setLocalObjects(next);
  }

  function scheduleLocalObjects(next: CanvasObject[]) {
    localRef.current = next;
    if (localFrameRef.current !== null) return;
    localFrameRef.current = window.requestAnimationFrame(() => {
      localFrameRef.current = null;
      setLocalObjects(localRef.current);
    });
  }

  function scheduleDragPreview(offset: Pt) {
    dragPreviewOffsetRef.current = offset;
    if (dragPreviewFrameRef.current !== null) return;
    dragPreviewFrameRef.current = window.requestAnimationFrame(() => {
      dragPreviewFrameRef.current = null;
      const preview = dragPreviewRef.current;
      if (!preview) return;
      const latest = dragPreviewOffsetRef.current;
      preview.style.transform = `translate3d(${latest.x}px, ${latest.y}px, 0)`;
    });
  }

  function clearMovePreview() {
    if (dragPreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(dragPreviewFrameRef.current);
      dragPreviewFrameRef.current = null;
    }
    dragPreviewOffsetRef.current = { x: 0, y: 0 };
    dragPreviewOriginRef.current = null;
    setMovePreviewActive(false);
  }
  const objects = localObjects ?? globalObjects;

  useEffect(() => {
    // When global objects change (e.g. from undo or sync), clear local override
    updateLocalObjects(null);
  }, [globalObjects]);
  useEffect(() => {
    const liveIds = new Set(globalObjects.map((object) => object.id));
    setSelected((current) => {
      const next = current.filter((id) => liveIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [globalObjects]);
  const tool = useNotesStore((s) => s.tool);
  const penOnly = useNotesStore((s) => s.settings.penOnly);
  const notebook = useNotesStore((s) => s.notebooks.find((n) => n.id === page.notebookId));
  const wrapRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const liveFrameRef = useRef<number | null>(null);
  const [imageRevision, setImageRevision] = useState(0);
  const [resourceRevision, setResourceRevision] = useState(0);
  const drawing = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const erasingNextRef = useRef<CanvasObject[] | null>(null);
  const pts = useRef<{ x: number; y: number; p: number }[]>([]);
  const shapeA = useRef<Pt | null>(null);
  const strokeBeforeState = useRef<CanvasObject[] | null>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const baseReady = useRef(false);
  const [editing, setEditing] = useState<Extract<CanvasObject, { type: "text" }> | null>(null);
  const textSessionRef = useRef<TextEditSession | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  // Copy/cut events can be dispatched synchronously from the toolbar before a
  // passive listener effect has been replaced. Keep the selection snapshot
  // current during render so both keyboard and button paths always read the
  // objects the UI actually shows as selected.
  const selectedRef = useRef<string[]>(selected);
  selectedRef.current = selected;
  const [dropActive, setDropActive] = useState(false);
  const lastInsertPoint = useRef<Pt>({ x: page.width / 2, y: page.height / 2 });
  const pasteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pasteRequestRef = useRef(0);
  const copyOutcomeRef = useRef<NotesClipboardWriteStatus | null>(null);
  const copyPayloadOverrideRef = useRef<NotesClipboardPayload | null>(null);
  const resize = useRef<{
    pointerId: number;
    start: Pt;
    box: { x: number; y: number; w: number; h: number };
    handle: ResizeHandle;
    originals: CanvasObject[];
    captureTarget: Element;
    changed: boolean;
  } | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const pendingResizeMove = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    shiftKey: boolean;
  } | null>(null);
  // PageSurface owns leases, never decoded image elements. The shared cache is
  // the single owner of decoded pixels and can release them when this page is far away.
  const imageLeasesRef = useRef(new Map<string, AssetImageLease>());
  const drag = useRef<
    | {
        kind: "move";
        pointerId: number;
        sourcePageId: string;
        sourceNotebookId: string;
        start: Pt;
        ids: string[];
        originals: CanvasObject[];
        active: boolean;
        startClientX: number;
        startClientY: number;
      }
    | {
        kind: "lasso";
        last: Pt;
        ids: string[];
      }
    | null
  >(null);

  const [isVisible, setIsVisible] = useState(active);
  const [isInViewport, setIsInViewport] = useState(active);

  const bindBaseCanvas = useCallback((node: HTMLCanvasElement | null) => {
    if (!node && baseRef.current) releaseCanvasBackingStore(baseRef.current);
    baseRef.current = node;
  }, []);
  const bindStaticCanvas = useCallback((node: HTMLCanvasElement | null) => {
    if (!node && staticRef.current) releaseCanvasBackingStore(staticRef.current);
    staticRef.current = node;
  }, []);
  const bindLiveCanvas = useCallback((node: HTMLCanvasElement | null) => {
    if (!node && liveRef.current) releaseCanvasBackingStore(liveRef.current);
    liveRef.current = node;
    if (node) releaseCanvasBackingStore(node);
  }, []);
  const bindDragPreviewCanvas = useCallback((node: HTMLCanvasElement | null) => {
    if (!node && dragPreviewRef.current) releaseCanvasBackingStore(dragPreviewRef.current);
    dragPreviewRef.current = node;
  }, []);

  useEffect(() => {
    const container = wrapRef.current;
    if (!container) return;
    if (!("IntersectionObserver" in window)) {
      setIsVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = wrapRef.current;
    if (!container || !("IntersectionObserver" in window)) {
      setIsInViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setIsInViewport(entry.isIntersecting), {
      rootMargin: "0px",
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const disp = displaySize(page);
  const cssW = disp.w * zoom;
  const cssH = disp.h * zoom;
  const displayDpr = pageCanvasDpr(cssW, cssH);
  const imageTargetDimension = useCallback(
    (assetId: string) => {
      let target = 1;
      for (const object of globalObjects) {
        if (object.type !== "image" || object.assetId !== assetId) continue;
        target = Math.max(target, object.w * zoom * displayDpr, object.h * zoom * displayDpr);
      }
      return Math.min(IMAGE_PREVIEW_MAX_DIMENSION, Math.ceil(target * 1.1));
    },
    [displayDpr, globalObjects, zoom],
  );
  const selectedObjects = objects.filter((object) => selected.includes(object.id));
  const selectionBounds = unionBBox(selectedObjects);
  const displayBounds = selectionBounds ? pageBBoxToDisplay(selectionBounds, page) : null;
  const onlyTextSelected =
    selectedObjects.length > 0 && selectedObjects.every((object) => object.type === "text");
  const selectedTextSize = onlyTextSelected
    ? Math.round((selectedObjects[0] as Extract<CanvasObject, { type: "text" }>).fontSize)
    : null;
  const pageOverlayStyle: React.CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: page.width * zoom,
    height: page.height * zoom,
    transformOrigin: "top left",
    transform:
      page.rotation === 90
        ? "rotate(90deg) translateY(-100%)"
        : page.rotation === 180
          ? "rotate(180deg) translate(-100%, -100%)"
          : page.rotation === 270
            ? "rotate(270deg) translateX(-100%)"
            : undefined,
    pointerEvents: "none",
    zIndex: 20,
  };

  const activatePage = useCallback(() => {
    const state = useNotesStore.getState();
    const index = state.pages.findIndex((candidate) => candidate.id === page.id);
    if (index >= 0 && state.currentPageIndex !== index) state.setPageIndex(index);
  }, [page.id]);

  const insertImageFiles = useCallback(
    async (files: File[], anchor: Pt, options: { shouldSelect?: () => boolean } = {}) => {
      if (files.length === 0) return [];
      const target = {
        notebookId: page.notebookId,
        pageId: page.id,
        width: page.width,
        height: page.height,
      };

      // Decode the complete batch before touching durable storage. One bad
      // image therefore cannot leave a partial group on the page.
      const prepared = await mapWithConcurrency(
        files,
        IMAGE_PREPARE_CONCURRENCY,
        async (file, index) => {
          const mime = file.type || "image/png";
          if (!mime.startsWith("image/")) throw new Error("Tệp đã chọn không phải là ảnh.");
          const blob = file.slice(0, file.size, mime);
          const natural = await readImageSize(blob);
          if (!natural.w || !natural.h) throw new Error("Ảnh không có kích thước hợp lệ.");

          const maxW = Math.min(420, target.width * 0.72);
          const maxH = Math.min(520, target.height * 0.64);
          const ratio = Math.min(maxW / natural.w, maxH / natural.h, 1);
          const width = Math.max(12, Math.round(natural.w * ratio));
          const height = Math.max(12, Math.round(natural.h * ratio));
          const padding = 16;
          const itemAnchor = { x: anchor.x + index * 18, y: anchor.y + index * 18 };
          const assetId = nid();
          const asset: AssetRecord = {
            id: assetId,
            kind: "image",
            mime,
            name: file.name || `anh-bang-tam-${new Date().toISOString().replaceAll(":", "-")}.png`,
            byteLength: blob.size,
            blob,
            createdAt: Date.now(),
          };
          const object: ImageObject = {
            id: nid(),
            type: "image",
            x: clamp(
              itemAnchor.x - width / 2,
              padding,
              Math.max(padding, target.width - width - padding),
            ),
            y: clamp(
              itemAnchor.y - height / 2,
              padding,
              Math.max(padding, target.height - height - padding),
            ),
            w: width,
            h: height,
            rotation: 0,
            assetId,
          };
          return { asset, object };
        },
      );

      const persisted: string[] = [];
      try {
        for (const item of prepared) {
          await putAsset(item.asset);
          persisted.push(item.asset.id);
        }
        // Warm the shared cache before committing the objects so the first
        // painted frame does not flash an empty image placeholder.
        await Promise.all(prepared.map((item) => loadAssetImage(item.asset.id, "visible")));

        // A deleted target must stay deleted. Switching page/notebook is fine:
        // objectsByPage retains the captured page and history gets the captured notebook.
        const state = useNotesStore.getState();
        if (!Object.prototype.hasOwnProperty.call(state.objectsByPage, target.pageId)) {
          throw new Error("Trang đích không còn tồn tại.");
        }
        const current = state.objectsByPage[target.pageId] ?? [];
        const additions = prepared.map((item) => item.object);
        state.commitObjects(
          target.pageId,
          [...current, ...additions],
          true,
          undefined,
          target.notebookId,
        );

        const currentPage = state.pages[state.currentPageIndex];
        const targetIsStillActive =
          state.activeNotebookId === target.notebookId && currentPage?.id === target.pageId;
        if (wrapRef.current && targetIsStillActive && (options.shouldSelect?.() ?? true)) {
          state.setTool({ name: "lasso" });
          setEditing(null);
          setSelected(additions.map((object) => object.id));
        }
        return additions.map((object) => object.id);
      } catch (error) {
        await Promise.allSettled(persisted.map((assetId) => delAsset(assetId)));
        throw error;
      }
    },
    [page.height, page.id, page.notebookId, page.width],
  );

  const openImagePicker = useCallback(
    (anchor = lastInsertPoint.current) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
      document.body.appendChild(input);

      const cleanup = () => input.remove();
      input.addEventListener("cancel", cleanup, { once: true });
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        cleanup();
        if (!files.length) return;
        try {
          await insertImageFiles(files, anchor);
          toast.success(files.length > 1 ? `Đã thêm ${files.length} ảnh` : "Đã thêm ảnh");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Không thêm được ảnh.");
        }
      };
      input.click();
    },
    [insertImageFiles],
  );

  const toPage = useCallback(
    (ev: { clientX: number; clientY: number }) => {
      const canvas = liveRef.current ?? staticRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const r = canvas.getBoundingClientRect();
      const dx = ((ev.clientX - r.left) / r.width) * disp.w;
      const dy = ((ev.clientY - r.top) / r.height) * disp.h;
      return displayToPage(dx, dy, page);
    },
    [disp.w, disp.h, page],
  );

  const sizeCanvases = useCallback(() => {
    const dpr = pageCanvasDpr(cssW, cssH);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    for (const canvas of [staticRef.current]) {
      if (!canvas) continue;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    return dpr;
  }, [cssH, cssW]);

  // Draw PDF + paper background onto the base canvas (only when pdf/zoom changes)
  const redrawBase = useCallback(
    async (signal?: AbortSignal) => {
      if (!isVisible) return;
      const canvas = baseRef.current;
      if (!canvas) return;
      const dpr = pageCanvasDpr(cssW, cssH);
      const w = Math.max(1, Math.round(cssW * dpr));
      const h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      applyPageRotation(ctx, page, zoom, dpr);
      drawPaper(ctx, page.width, page.height, page.paper);

      if (notebook?.pdfAssetId && page.pdfPage) {
        let documentLease: Awaited<ReturnType<typeof acquireStoredPdfDocument>> | null = null;
        try {
          documentLease = await acquireStoredPdfDocument(notebook.pdfAssetId);
          const bitmapLease = await renderPdfPageBitmap(
            documentLease.document,
            page.pdfPage,
            zoom * dpr,
            page.rotation,
            notebook.pdfAssetId,
            signal,
          );
          try {
            if (signal?.aborted) return;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(bitmapLease.bitmap, 0, 0, canvas.width, canvas.height);
            ctx.restore();
            applyPageRotation(ctx, page, zoom, dpr);
          } finally {
            bitmapLease.release();
          }
        } catch {
          /* render paper only */
        } finally {
          documentLease?.release();
        }
      }
      baseReady.current = true;
    },
    [notebook?.pdfAssetId, page, zoom, cssW, cssH, isVisible],
  );

  // Draw just the strokes + selection overlay onto staticRef (very fast, no PDF re-render)
  const redrawStrokes = useCallback(
    (overrideObjects?: CanvasObject[]) => {
      if (!isVisible) return;
      const canvas = staticRef.current;
      if (!canvas) return;

      const targetObjects = overrideObjects ?? objects;

      const dpr = sizeCanvases();
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      applyPageRotation(ctx, page, zoom, dpr);

      const previewIds =
        movePreviewActive && drag.current?.kind === "move" ? new Set(drag.current.ids) : null;
      for (const o of targetObjects) {
        if (previewIds?.has(o.id)) continue;
        if (o.type === "stroke") drawStroke(ctx, o);
        else if (o.type === "shape") drawShape(ctx, o);
        else if (o.type === "text" && o.id !== editing?.id) drawText(ctx, o);
        else if (o.type === "image") {
          const img = imageLeasesRef.current.get(o.assetId)?.value;
          if (img) {
            ctx.save();
            ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
            ctx.rotate((o.rotation * Math.PI) / 180);
            ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
            ctx.restore();
          } else {
            ctx.strokeStyle = "#b42318";
            ctx.strokeRect(o.x, o.y, o.w, o.h);
          }
        }
      }

      const sel = objects.filter((o) => selected.includes(o.id));
      const box = unionBBox(sel);
      if (box && active && !editing && !movePreviewActive && selectedObjects.length > 1) {
        ctx.save();
        ctx.strokeStyle = "#0F766E";
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1 / zoom;
        ctx.strokeRect(box.x, box.y, box.w, box.h);
        ctx.restore();
      }
    },
    [
      objects,
      page,
      selected,
      sizeCanvases,
      zoom,
      isVisible,
      editing,
      active,
      movePreviewActive,
      selectedObjects.length,
    ],
  );

  useLayoutEffect(() => {
    if (!movePreviewActive || drag.current?.kind !== "move") return;
    const canvas = dragPreviewRef.current;
    if (!canvas) return;
    const session = drag.current;
    const dpr = pageCanvasDpr(cssW, cssH);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyPageRotation(ctx, page, zoom, dpr);

    for (const object of session.originals) {
      if (object.type === "stroke") drawStroke(ctx, object);
      else if (object.type === "shape") drawShape(ctx, object);
      else if (object.type === "text") drawText(ctx, object);
      else {
        const image = imageLeasesRef.current.get(object.assetId)?.value;
        if (image) {
          ctx.save();
          ctx.translate(object.x + object.w / 2, object.y + object.h / 2);
          ctx.rotate((object.rotation * Math.PI) / 180);
          ctx.drawImage(image, -object.w / 2, -object.h / 2, object.w, object.h);
          ctx.restore();
        }
      }
    }

    const box = unionBBox(session.originals);
    if (box) {
      ctx.save();
      ctx.strokeStyle =
        getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim() ||
        "#0F766E";
      ctx.setLineDash([4 / zoom, 3 / zoom]);
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.restore();
    }

    const offset = dragPreviewOffsetRef.current;
    canvas.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
  }, [cssH, cssW, imageRevision, movePreviewActive, page, zoom]);

  // Asset/font loading must never suspend pointer frames or leave the old text
  // painted underneath the editor. PageSurface keeps only idempotent leases;
  // the shared cache remains the sole owner of decoded HTMLImageElements.
  useEffect(() => {
    const leases = imageLeasesRef.current;
    const desired = new Map<string, number>();
    if (isVisible) {
      for (const object of globalObjects) {
        if (object.type !== "image") continue;
        desired.set(object.assetId, imageTargetDimension(object.assetId));
      }
    }

    for (const [assetId, lease] of leases) {
      if (desired.has(assetId)) continue;
      lease.release();
      leases.delete(assetId);
    }

    if (!isVisible) return;
    const priority = active || isInViewport ? "visible" : "near";
    for (const [assetId, requestedMaxDimension] of desired) {
      const existing = leases.get(assetId);
      if (existing && existing.maxDimension >= requestedMaxDimension) {
        existing.setPriority(priority);
        continue;
      }
      existing?.release();
      const lease = acquireAssetImage(assetId, priority, requestedMaxDimension);
      leases.set(assetId, lease);
      void lease.promise
        .then(() => {
          if (imageLeasesRef.current.get(assetId) !== lease) return;
          setImageRevision((revision) => revision + 1);
        })
        .catch(() => {
          // One unavailable asset must not block the rest of the page. A future
          // visibility pass can retry because failures are not cached forever.
          if (imageLeasesRef.current.get(assetId) === lease) {
            lease.release();
            imageLeasesRef.current.delete(assetId);
          }
        });
    }
  }, [active, globalObjects, imageTargetDimension, isInViewport, isVisible, resourceRevision]);

  useEffect(
    () => () => {
      for (const lease of imageLeasesRef.current.values()) lease.release();
      imageLeasesRef.current.clear();
    },
    [],
  );

  useEffect(
    () =>
      subscribeTransientAssetInvalidation((assetId) => {
        const leases = imageLeasesRef.current;
        const affectsImages = assetId === null || leases.has(assetId);
        const affectsPdf = assetId === null || assetId === notebook?.pdfAssetId;
        if (!affectsImages && !affectsPdf) return;
        if (assetId === null) {
          for (const lease of leases.values()) lease.release();
          leases.clear();
        } else {
          leases.get(assetId)?.release();
          leases.delete(assetId);
        }
        baseReady.current = false;
        setResourceRevision((revision) => revision + 1);
      }),
    [notebook?.pdfAssetId],
  );

  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setImageRevision((revision) => revision + 1);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-render base (PDF) only when PDF asset, page, or zoom changes
  useEffect(() => {
    if (!isVisible) return;
    const ac = new AbortController();
    void redrawBase(ac.signal);
    return () => ac.abort();
  }, [notebook?.pdfAssetId, page.pdfPage, zoom, redrawBase, isVisible, resourceRevision]);

  // Re-render strokes whenever objects/selection change (cheap operation)
  useLayoutEffect(() => {
    if (isVisible) redrawStrokes();
  }, [redrawStrokes, isVisible, imageRevision]);

  useEffect(() => {
    if (!isVisible) baseReady.current = false;
  }, [isVisible]);

  useEffect(() => {
    if (active && ["text", "image", "lasso"].includes(tool.name)) return;
    if (drag.current?.kind === "move") {
      drawing.current = false;
      pointerIdRef.current = null;
      drag.current = null;
      strokeBeforeState.current = null;
      clearMovePreview();
      updateLocalObjects(null);
    }
    setEditing(null);
    setSelected([]);
  }, [active, tool.name]);

  useEffect(() => {
    if (!active) return;
    const onOpenImagePicker = () => openImagePicker();
    window.addEventListener(OPEN_IMAGE_PICKER_EVENT, onOpenImagePicker);
    return () => window.removeEventListener(OPEN_IMAGE_PICKER_EVENT, onOpenImagePicker);
  }, [active, openImagePicker]);

  const createPastedTextObject = useCallback(
    (text: string, anchor: Pt) => {
      const toolState = useNotesStore.getState().tool;
      const maxWidth = Math.max(80, Math.min(420, page.width - 32));
      const longestLine = Math.max(
        1,
        ...text.split(/\r\n|\r|\n/).map((line) => Array.from(line).length),
      );
      const width = clamp(
        longestLine * toolState.fontSize * 0.58 + 8,
        Math.min(120, maxWidth),
        maxWidth,
      );
      const base: TextObject = {
        id: nid(),
        type: "text",
        x: clamp(anchor.x, 16, Math.max(16, page.width - width - 16)),
        y: anchor.y,
        w: width,
        h: toolState.fontSize * 1.4,
        text,
        fontSize: toolState.fontSize,
        color: toolState.color,
        align: toolState.textAlign || "left",
        fontFamily: toolState.fontFamily,
        fontWeight: toolState.fontWeight,
        fontStyle: toolState.fontStyle,
        textDecoration: toolState.textDecoration,
        backgroundColor: toolState.textBgColor,
        backgroundOpacity: toolState.textBgOpacity,
        lineHeight: 1.4,
        rotation: 0,
      };
      const resized = autoResizeTextObject(base);
      return {
        ...resized,
        y: clamp(anchor.y, 16, Math.max(16, page.height - resized.h - 16)),
      };
    },
    [page.height, page.width],
  );

  const captureSelection = useCallback(() => {
    const selectedIds = new Set(selectedRef.current);
    if (selectedIds.size === 0) return null;
    const state = useNotesStore.getState();
    const current = state.objectsByPage[page.id] ?? [];
    const snapshot = current.filter((object) => selectedIds.has(object.id));
    if (snapshot.length === 0) return null;
    return {
      state,
      current,
      selectedIds,
      payload: createNotesClipboardPayload({
        sourceNotebookId: page.notebookId,
        sourcePageId: page.id,
        objects: snapshot,
      }),
    };
  }, [page.id, page.notebookId]);

  const copyViaClipboardEvent = useCallback((payload: NotesClipboardPayload) => {
    // A toolbar click has no native text selection. Give execCommand a genuine
    // off-screen DOM range so Chromium/WebView commits the same synchronous
    // copy event used by Ctrl+C, then restore the user's document selection.
    const marker = document.createElement("span");
    marker.textContent = "\u00a0";
    marker.setAttribute("aria-hidden", "true");
    marker.style.cssText = "position:fixed;left:-10000px;top:0;user-select:text";
    document.body.appendChild(marker);
    const selection = window.getSelection();
    const savedRanges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) =>
          selection.getRangeAt(index).cloneRange(),
        )
      : [];
    const range = document.createRange();
    range.selectNodeContents(marker);
    selection?.removeAllRanges();
    selection?.addRange(range);

    copyOutcomeRef.current = null;
    copyPayloadOverrideRef.current = payload;
    try {
      document.execCommand("copy");
    } catch {
      // The copy event handler below owns the user-facing failure state.
    } finally {
      selection?.removeAllRanges();
      savedRanges.forEach((savedRange) => selection?.addRange(savedRange));
      copyPayloadOverrideRef.current = null;
      marker.remove();
    }
    return copyOutcomeRef.current as NotesClipboardWriteStatus | null;
  }, []);

  const requestSelectionCopy = useCallback(() => {
    const captured = captureSelection();
    if (!captured) {
      toast.error("Không có đối tượng để sao chép.");
      return;
    }

    const outcome = copyViaClipboardEvent(captured.payload);
    if (outcome === "rich") toast.success("Đã sao chép");
    else toast.error("Không ghi được vào bảng tạm.");
  }, [captureSelection, copyViaClipboardEvent]);

  useEffect(() => {
    if (!active) return;

    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (isDialogTarget(target)) return;
      const source = canvasPasteSource(event.clipboardData);
      if (source.kind === "none") return;

      const editable = isEditableTarget(target);
      const notesTextEditor = Boolean(target?.closest('[data-notes-text-editor="true"]'));
      if (editable) {
        if (!notesTextEditor) return;
        const notesImageOnly =
          source.kind === "notes" &&
          source.payload.objects.some((object) => object.type === "image") &&
          !source.payload.objects.some((object) => object.type === "text");
        // Plain text—including text copied from a Notes object—belongs at the
        // textarea caret. Images are the one canvas-specific editor fallback.
        if (source.kind !== "images" && !notesImageOnly) return;
      }

      event.preventDefault();
      activatePage();
      const requestId = ++pasteRequestRef.current;
      const anchor = { ...lastInsertPoint.current };
      const targetPage = {
        notebookId: page.notebookId,
        pageId: page.id,
      };
      const preparedText =
        source.kind === "text" ? createPastedTextObject(source.text, anchor) : null;

      if (editable) {
        // Read the live DOM value before blur; IME/input state may be ahead of
        // the latest React render. Blur then closes the text session normally.
        collectActiveTextDrafts();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }

      const task = async () => {
        try {
          if (source.kind === "images") {
            await insertImageFiles(source.files, anchor, {
              shouldSelect: () => pasteRequestRef.current === requestId,
            });
            toast.success(
              source.files.length > 1
                ? `Đã dán ${source.files.length} ảnh từ bảng tạm`
                : "Đã dán ảnh từ bảng tạm",
            );
            return;
          }

          let additions: CanvasObject[];
          if (source.kind === "notes") {
            const assetIds = [
              ...new Set(
                source.payload.objects.flatMap((object) =>
                  object.type === "image" ? [object.assetId] : [],
                ),
              ),
            ];
            if (assetIds.length > 0) {
              const assets = await Promise.all(assetIds.map((assetId) => getAsset(assetId)));
              if (assets.some((asset) => !asset)) {
                throw new Error("Ảnh gốc không còn trong kho Notes.");
              }
              await Promise.all(assetIds.map((assetId) => loadAssetImage(assetId, "visible")));
            }
            additions = cloneNotesClipboardObjects(source.payload, 12 / zoom, 12 / zoom);
          } else {
            additions = [preparedText!];
          }

          const state = useNotesStore.getState();
          if (!Object.prototype.hasOwnProperty.call(state.objectsByPage, targetPage.pageId)) {
            throw new Error("Trang đích không còn tồn tại.");
          }
          const current = state.objectsByPage[targetPage.pageId] ?? [];
          state.commitObjects(
            targetPage.pageId,
            [...current, ...additions],
            true,
            undefined,
            targetPage.notebookId,
          );

          const liveState = useNotesStore.getState();
          const currentPage = liveState.pages[liveState.currentPageIndex];
          if (
            wrapRef.current &&
            pasteRequestRef.current === requestId &&
            liveState.activeNotebookId === targetPage.notebookId &&
            currentPage?.id === targetPage.pageId
          ) {
            liveState.setTool({ name: "lasso" });
            setEditing(null);
            setSelected(additions.map((object) => object.id));
          }
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Không dán được nội dung.");
        }
      };

      // Preserve user ordering across rapid pastes, including a slow bitmap
      // followed immediately by text, while allowing the queue to recover after errors.
      const queued = pasteQueueRef.current.then(task, task);
      pasteQueueRef.current = queued.catch(() => undefined);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [
    activatePage,
    active,
    createPastedTextObject,
    insertImageFiles,
    page.id,
    page.notebookId,
    zoom,
  ]);

  useEffect(() => {
    if (!active) return;

    const writeSelection = (event: ClipboardEvent, cut: boolean) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (isEditableTarget(target) || isDialogTarget(target)) return;
      const captured = captureSelection();
      const payload = copyPayloadOverrideRef.current ?? captured?.payload;
      if (!payload) return;

      const status = writeNotesClipboardData(event.clipboardData, payload);
      copyOutcomeRef.current = status;
      if (status === "failed") {
        toast.error(
          cut ? "Không cắt được vì bảng tạm không ghi được." : "Không ghi được vào bảng tạm.",
        );
        return;
      }

      event.preventDefault();
      if (!canDeleteCutSource(status)) {
        toast.warning("Trình duyệt chỉ cho sao chép chữ thuần; đối tượng gốc vẫn được giữ lại.");
        return;
      }

      if (cut) {
        if (!captured) return;
        captured.state.commitObjects(
          page.id,
          captured.current.filter((object) => !captured.selectedIds.has(object.id)),
          true,
          undefined,
          page.notebookId,
        );
        setSelected([]);
      }
    };

    const onCopy = (event: ClipboardEvent) => writeSelection(event, false);
    const onCut = (event: ClipboardEvent) => writeSelection(event, true);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCut);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCut);
    };
  }, [active, captureSelection, page.id, page.notebookId]);

  const setupLive = () => {
    const canvas = liveRef.current;
    if (!canvas) return null;
    const dpr = pageCanvasDpr(cssW, cssH);
    const width = Math.max(1, Math.round(cssW * dpr));
    const height = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyPageRotation(ctx, page, zoom, dpr);
    return ctx;
  };

  function drawLivePreview() {
    const ctx = setupLive();
    if (!ctx) return;
    if (isPen(tool.name)) {
      const pen = currentPen();
      drawStroke(ctx, {
        id: "live",
        type: "stroke",
        tool: pen.kind,
        color: pen.color,
        width: pen.width,
        points: pts.current,
      });
      return;
    }
    if (isShape(tool.name) && shapeA.current) {
      const end = pts.current.at(-1);
      if (!end) return;
      drawShape(ctx, {
        id: "live",
        type: "shape",
        shape: tool.name as "line" | "arrow" | "rect" | "ellipse",
        x1: shapeA.current.x,
        y1: shapeA.current.y,
        x2: end.x,
        y2: end.y,
        color: tool.color,
        width: tool.width,
      });
      return;
    }
    drawLasso(ctx, pts.current);
  }

  function scheduleLivePreview() {
    if (liveFrameRef.current !== null) return;
    liveFrameRef.current = window.requestAnimationFrame(() => {
      liveFrameRef.current = null;
      drawLivePreview();
    });
  }

  function commit(next: CanvasObject[]) {
    useNotesStore.getState().commitObjects(page.id, next, true);
  }

  const beginTextEditing = useCallback(
    (candidate: TextObject) => {
      const current = useNotesStore.getState().objectsByPage[page.id] ?? [];
      const originalIndex = current.findIndex((object) => object.id === candidate.id);
      const original =
        originalIndex >= 0 && current[originalIndex]?.type === "text"
          ? ({ ...current[originalIndex] } as TextObject)
          : null;
      const latest = original ?? candidate;
      textSessionRef.current = {
        sessionId: nid(),
        notebookId: page.notebookId,
        pageId: page.id,
        objectId: candidate.id,
        original,
        originalIndex,
        latest,
      };
      setEditing(latest);
    },
    [page.id, page.notebookId],
  );

  function stageTextEditingDraft(sessionId: string, draft: TextObject) {
    const session = textSessionRef.current;
    if (
      !session ||
      session.sessionId !== sessionId ||
      session.notebookId !== page.notebookId ||
      session.pageId !== page.id ||
      session.objectId !== draft.id
    )
      return;
    session.latest = draft;
    useNotesStore.getState().stageTextDraft({
      sessionId,
      notebookId: session.notebookId,
      pageId: session.pageId,
      objectId: session.objectId,
      draft,
    });
  }

  function finishTextEditing(sessionId: string, draft: TextObject) {
    const session = textSessionRef.current;
    if (!session || session.sessionId !== sessionId) return;
    stageTextEditingDraft(sessionId, draft);
    const store = useNotesStore.getState();
    const current = store.objectsByPage[session.pageId] ?? [];
    const finalObject = current.find((object) => object.id === session.objectId) ?? null;
    if (JSON.stringify(finalObject) !== JSON.stringify(session.original)) {
      // Autosave updates are intentionally non-undoable. Closing the editor
      // records one object-scoped baseline while preserving unrelated objects
      // that may have changed during the session.
      store.commitObjects(
        session.pageId,
        current,
        true,
        restoreSessionOriginal(current, session),
        session.notebookId,
      );
    }
    textSessionRef.current = null;
    setEditing((activeEditor) => (activeEditor?.id === session.objectId ? null : activeEditor));
  }

  function cancelTextEditing(sessionId: string) {
    const session = textSessionRef.current;
    if (!session || session.sessionId !== sessionId) return;
    const store = useNotesStore.getState();
    const current = store.objectsByPage[session.pageId] ?? [];
    const restored = restoreSessionOriginal(current, session);
    if (JSON.stringify(restored) !== JSON.stringify(current)) {
      // Escape restores the pre-session value even if an intermediate draft
      // has already reached storage. It is not a new Undo step.
      store.commitObjects(session.pageId, restored, false, undefined, session.notebookId);
    }
    textSessionRef.current = null;
    setEditing((activeEditor) => (activeEditor?.id === session.objectId ? null : activeEditor));
  }

  function transformSelection(transform: (object: CanvasObject) => CanvasObject) {
    const ids = new Set(selected);
    commit(objects.map((object) => (ids.has(object.id) ? transform(object) : object)));
  }

  function isDrawBlocked(ev: PointerEvent) {
    if (penOnly && ev.pointerType === "touch") return true;
    if (tool.name === "hand") return true;
    return false;
  }

  function onPointerDown(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (ev.button !== 0 || pointerIdRef.current !== null) return;
    // preventDefault below otherwise leaves the previous editor focused and
    // creates a second text object before its draft has been committed.
    if (document.activeElement instanceof HTMLTextAreaElement) document.activeElement.blur();
    activatePage();
    if (isDrawBlocked(ev.nativeEvent)) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const p = toPage(ev);
    lastInsertPoint.current = p;
    const pressure = ev.pressure > 0 ? ev.pressure : 0.5;
    strokeBeforeState.current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
    const currentObjects = strokeBeforeState.current;

    const startDragSession = (ids: string[]) => {
      const idSet = new Set(ids);
      const originals = currentObjects.filter((object) => idSet.has(object.id));
      if (originals.length !== idSet.size) return;
      drag.current = {
        kind: "move",
        pointerId: ev.pointerId,
        sourcePageId: page.id,
        sourceNotebookId: page.notebookId,
        start: p,
        ids,
        originals,
        active: false,
        startClientX: ev.clientX,
        startClientY: ev.clientY,
      };
      drawing.current = true;
      pointerIdRef.current = ev.pointerId;
    };

    if (tool.name === "text" || tool.name === "image") {
      ev.preventDefault();
      const hit = [...currentObjects]
        .reverse()
        .find((o) => (o.type === "text" || o.type === "image") && hitTest(o, p, 2 / zoom));

      if (hit) {
        if (selected.includes(hit.id)) {
          startDragSession(selected);
        } else {
          setSelected([hit.id]);
          startDragSession([hit.id]);
        }
        return;
      }

      setSelected([]);
      if (tool.name === "image") {
        openImagePicker(p);
        return;
      }

      // Create text object but do NOT commit until user types something (avoid blank flash)
      const t: Extract<CanvasObject, { type: "text" }> = {
        id: nid(),
        type: "text",
        x: clamp(p.x, 0, Math.max(0, page.width - 80)),
        y: clamp(p.y, 0, Math.max(0, page.height - tool.fontSize * 1.4)),
        w: Math.min(240, Math.max(80, page.width - p.x)),
        h: tool.fontSize * 1.4,
        text: "",
        fontSize: tool.fontSize,
        color: tool.color,
        align: tool.textAlign || "left",
        fontFamily: tool.fontFamily,
        fontWeight: tool.fontWeight,
        fontStyle: tool.fontStyle,
        textDecoration: tool.textDecoration,
        backgroundColor: tool.textBgColor,
        backgroundOpacity: tool.textBgOpacity,
      };
      beginTextEditing(t);
      return;
    }

    if (tool.name === "lasso") {
      ev.preventDefault();
      const hit = [...currentObjects].reverse().find((o) => hitTest(o, p, 6 / zoom));

      if (hit && selected.includes(hit.id)) {
        startDragSession(selected);
        return;
      }
      if (hit) {
        setSelected([hit.id]);
        startDragSession([hit.id]);
        return;
      }
      drawing.current = true;
      pointerIdRef.current = ev.pointerId;
      pts.current = [{ ...p, p: 0.5 }];
      drag.current = { kind: "lasso", last: p, ids: [] };
      return;
    }

    if (tool.name === "eraser") {
      drawing.current = true;
      pointerIdRef.current = ev.pointerId;
      erasingNextRef.current = null;
      applyEraser(p);
      return;
    }

    if (isShape(tool.name)) {
      drawing.current = true;
      pointerIdRef.current = ev.pointerId;
      shapeA.current = p;
      pts.current = [{ ...p, p: pressure }];
      return;
    }

    drawing.current = true;
    pointerIdRef.current = ev.pointerId;
    pts.current = [{ ...p, p: pressure }];
  }

  function onPointerMove(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) {
      if (active) lastInsertPoint.current = toPage(ev);
      return;
    }
    if (pointerIdRef.current !== ev.pointerId) return;
    if (
      ev.type === "pointermove" &&
      drag.current?.kind === "move" &&
      ev.pointerType === "mouse" &&
      ev.buttons === 0
    ) {
      onPointerCancel(ev);
      return;
    }
    const coalesced = ev.nativeEvent.getCoalescedEvents?.();
    const events = coalesced?.length ? coalesced : [ev.nativeEvent];
    for (const e of events) {
      const p = toPage(e);
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      if (tool.name === "eraser") {
        applyEraser(p);
        continue;
      }
      if (drag.current?.kind === "move") {
        const session = drag.current;

        if (!session.active) {
          const travelled = Math.hypot(
            e.clientX - session.startClientX,
            e.clientY - session.startClientY,
          );
          if (travelled < DRAG_ACTIVATION_DISTANCE) continue;

          session.active = true;
          const rect = wrapRef.current?.getBoundingClientRect();
          if (rect) {
            dragPreviewOriginRef.current = { left: rect.left, top: rect.top };
            dragPreviewOffsetRef.current = { x: 0, y: 0 };
            setMovePreviewActive(true);
          }
        }

        // The transparent fixed preview is not clipped by the source page, so
        // the real objects and their selection frame stay under the pointer
        // while crossing gray space or another page. DOM writes are one/frame.
        scheduleDragPreview({
          x: e.clientX - session.startClientX,
          y: e.clientY - session.startClientY,
        });
        continue;
      }
      if (drag.current?.kind === "lasso" || isPen(tool.name) || isShape(tool.name)) {
        const last = pts.current[pts.current.length - 1];
        if (last && dist(last, p) < 1.0 / zoom) continue;
        pts.current.push({ ...p, p: pressure });
        scheduleLivePreview();
      }
    }
  }

  function onPointerUp(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || pointerIdRef.current !== ev.pointerId) return;
    if (drag.current?.kind === "move") onPointerMove(ev);
    drawing.current = false;
    pointerIdRef.current = null;
    if (ev.currentTarget.hasPointerCapture(ev.pointerId))
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    if (liveFrameRef.current !== null) {
      window.cancelAnimationFrame(liveFrameRef.current);
      liveFrameRef.current = null;
    }
    releaseCanvasBackingStore(liveRef.current);

    // Eraser: all intermediate moves were non-undoable; commit once here as a single undo step
    if (tool.name === "eraser") {
      const current =
        localRef.current ?? useNotesStore.getState().objectsByPage[page.id] ?? objects;
      useNotesStore
        .getState()
        .commitObjects(page.id, current, true, strokeBeforeState.current ?? undefined);
      erasingNextRef.current = null;
      strokeBeforeState.current = null;
      updateLocalObjects(null);
      return;
    }

    if (drag.current?.kind === "move") {
      const session = drag.current;
      drag.current = null;
      clearMovePreview();
      updateLocalObjects(null);

      // A normal click only selects the object. It must not hide, move, save,
      // or add a redundant undo entry.
      if (!session.active) {
        strokeBeforeState.current = null;
        return;
      }

      const state = useNotesStore.getState();
      const currentPages = new Map(
        state.pages
          .filter((candidate) => candidate.notebookId === session.sourceNotebookId)
          .map((candidate) => [candidate.id, candidate]),
      );
      const sourceStillExists = currentPages.has(session.sourcePageId);
      const surfaces = Array.from(document.querySelectorAll<HTMLElement>("[data-page-id]")).flatMap(
        (element) => {
          const id = element.dataset.pageId;
          const candidate = id ? currentPages.get(id) : undefined;
          return candidate ? [{ page: candidate, rect: element.getBoundingClientRect() }] : [];
        },
      );
      const target = sourceStillExists
        ? findPageDropTarget({ x: ev.clientX, y: ev.clientY }, surfaces)
        : null;

      // Gray background, page gaps, app chrome, a deleted page, or a notebook
      // switch are invalid destinations. The preview simply rolls back and no
      // history/save entry is created.
      if (!target || state.activeNotebookId !== session.sourceNotebookId) {
        strokeBeforeState.current = null;
        return;
      }

      const sourceObjects = state.objectsByPage[session.sourcePageId] ?? [];
      const targetObjects =
        target.page.id === session.sourcePageId
          ? sourceObjects
          : (state.objectsByPage[target.page.id] ?? []);
      const plan = planCanvasObjectDrop({
        sourcePageId: session.sourcePageId,
        targetPage: target.page,
        draggedIds: session.ids,
        sourceOriginals: session.originals,
        sourceObjects,
        targetObjects,
        desiredDelta: {
          x: target.point.x - session.start.x,
          y: target.point.y - session.start.y,
        },
      });

      if (!plan || !plan.changed) {
        strokeBeforeState.current = null;
        return;
      }

      state.commitObjectPages(plan.updates, plan.before, true, session.sourceNotebookId);

      if (target.page.id !== session.sourcePageId) {
        setSelected([]);
        window.dispatchEvent(
          new CustomEvent("notes-select-objects", {
            detail: { pageId: target.page.id, objectIds: session.ids },
          }),
        );
      }
      strokeBeforeState.current = null;
      return;
    }
    if (drag.current?.kind === "lasso") {
      const poly = pts.current;
      const ids = objects.filter((o) => objectInLasso(o, poly)).map((o) => o.id);
      setSelected(ids);
      drag.current = null;
      pts.current = [];
      return;
    }
    if (isShape(tool.name) && shapeA.current) {
      const b = toPage(ev);
      let coords = { x1: shapeA.current.x, y1: shapeA.current.y, x2: b.x, y2: b.y };
      if (ev.shiftKey || tool.shapeSnap) {
        coords = snapShape(
          tool.name as "line" | "arrow" | "rect" | "ellipse",
          coords.x1,
          coords.y1,
          coords.x2,
          coords.y2,
        );
      }
      commit([
        ...objects,
        {
          id: nid(),
          type: "shape",
          shape: tool.name as "line" | "arrow" | "rect" | "ellipse",
          ...coords,
          color: tool.color,
          width: Math.max(1, tool.width),
        },
      ]);
      shapeA.current = null;
      pts.current = [];
      return;
    }
    if (isPen(tool.name) && pts.current.length) {
      const pen = currentPen();
      const stroke: StrokeObject = {
        id: nid(),
        type: "stroke",
        tool: pen.kind,
        color: pen.color,
        width: pen.width,
        points: pts.current,
      };
      commit([...objects, stroke]);
      pts.current = [];
    }
  }

  function onPointerCancel(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (pointerIdRef.current !== ev.pointerId) return;
    drawing.current = false;
    pointerIdRef.current = null;
    drag.current = null;
    clearMovePreview();
    pts.current = [];
    shapeA.current = null;
    erasingNextRef.current = null;
    strokeBeforeState.current = null;
    if (liveFrameRef.current !== null) window.cancelAnimationFrame(liveFrameRef.current);
    liveFrameRef.current = null;
    releaseCanvasBackingStore(liveRef.current);
    updateLocalObjects(null);
  }

  function onDoubleClick(ev: React.MouseEvent<HTMLCanvasElement>) {
    if (!["text", "lasso", "image"].includes(tool.name)) return;
    const current = useNotesStore.getState().objectsByPage[page.id] ?? [];
    const hit = [...current].reverse().find((object) => hitTest(object, toPage(ev), 2 / zoom));
    if (hit?.type !== "text") return;
    ev.preventDefault();
    setSelected([hit.id]);
    beginTextEditing(hit);
  }

  function applyEraser(p: Pt) {
    const { eraserMode, eraserWidth } = useNotesStore.getState().tool;
    const current =
      erasingNextRef.current ??
      localRef.current ??
      useNotesStore.getState().objectsByPage[page.id] ??
      objects;
    const next: CanvasObject[] = [];
    let changed = false;
    for (const o of current) {
      if (o.type !== "stroke") {
        next.push(o);
        continue;
      }
      if (eraserMode === "highlighter" && o.tool !== "highlighter") {
        next.push(o);
        continue;
      }
      const hit = hitTest(o, p, eraserWidth / 2);
      if (!hit) {
        next.push(o);
        continue;
      }
      changed = true;
      if (eraserMode === "partial") {
        next.push(...erasePartial(o, p, eraserWidth / 2));
      }
    }
    if (changed) {
      erasingNextRef.current = next;
      scheduleLocalObjects(next);
    }
  }

  useEffect(() => {
    function onTextStyleChange(e: Event) {
      const customEvent = e as CustomEvent<Partial<import("@/lib/notes/store").ToolState>>;
      const patch = customEvent.detail;

      const applyPatch = (obj: Extract<CanvasObject, { type: "text" }>) =>
        autoResizeTextObject({
          ...obj,
          ...(patch.fontFamily !== undefined && { fontFamily: patch.fontFamily }),
          ...(patch.fontWeight !== undefined && { fontWeight: patch.fontWeight }),
          ...(patch.fontStyle !== undefined && { fontStyle: patch.fontStyle }),
          ...(patch.textDecoration !== undefined && { textDecoration: patch.textDecoration }),
          ...(patch.textAlign !== undefined && { align: patch.textAlign }),
          ...(patch.color !== undefined && { color: patch.color }),
          ...(patch.textBgColor !== undefined && { backgroundColor: patch.textBgColor }),
          ...(patch.textBgOpacity !== undefined && { backgroundOpacity: patch.textBgOpacity }),
          ...(patch.fontSize !== undefined && { fontSize: patch.fontSize }),
        });

      const textSession = textSessionRef.current;
      if (textSession) {
        const nextDraft = applyPatch(textSession.latest);
        textSession.latest = nextDraft;
        setEditing(nextDraft);
        useNotesStore.getState().stageTextDraft({
          sessionId: textSession.sessionId,
          notebookId: textSession.notebookId,
          pageId: textSession.pageId,
          objectId: textSession.objectId,
          draft: nextDraft,
        });
      }

      if (!active || selected.length === 0) return;
      const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
      let changed = false;
      const next = current.map((o) => {
        if (o.type === "text" && selected.includes(o.id) && o.id !== textSession?.objectId) {
          changed = true;
          return applyPatch(o);
        }
        return o;
      });
      if (changed) {
        useNotesStore.getState().commitObjects(page.id, next, true);
      }
    }
    window.addEventListener("notes-text-style-change", onTextStyleChange);

    function onSelectObjects(e: Event) {
      const customEvent = e as CustomEvent<{ pageId: string; objectIds: string[] }>;
      if (customEvent.detail.pageId === page.id) {
        setSelected(customEvent.detail.objectIds);
        activatePage();
      }
    }
    window.addEventListener("notes-select-objects", onSelectObjects);

    return () => {
      window.removeEventListener("notes-text-style-change", onTextStyleChange);
      window.removeEventListener("notes-select-objects", onSelectObjects);
    };
  }, [active, activatePage, objects, page.id, selected]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!active || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const target = e.target instanceof Element ? e.target : null;
      if (isEditableTarget(target) || isDialogTarget(target)) return;
      const saveObjects = (next: CanvasObject[]) =>
        useNotesStore.getState().commitObjects(page.id, next, true);
      if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
        e.preventDefault();
        saveObjects(objects.filter((o) => !selected.includes(o.id)));
        setSelected([]);
      }
      if (e.key === "Escape") setSelected([]);
      if (e.key === "Enter" && selected.length === 1) {
        const object = objects.find((o) => o.id === selected[0]);
        if (object?.type === "text") {
          e.preventDefault();
          beginTextEditing(object);
        }
      }
      if (e.key === "[" && selected.length) {
        const color = useNotesStore.getState().tool.color;
        saveObjects(objects.map((o) => (selected.includes(o.id) ? recolor(o, color) : o)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, beginTextEditing, objects, page.id, selected]);

  useEffect(
    () => () => {
      resizeCleanup.current?.();
      if (liveFrameRef.current !== null) window.cancelAnimationFrame(liveFrameRef.current);
      if (localFrameRef.current !== null) window.cancelAnimationFrame(localFrameRef.current);
      if (dragPreviewFrameRef.current !== null)
        window.cancelAnimationFrame(dragPreviewFrameRef.current);
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
      drawing.current = false;
      pointerIdRef.current = null;
      drag.current = null;
    },
    [],
  );

  const startResizeSession = (event: React.PointerEvent, handle: ResizeHandle) => {
    if (event.button !== 0 || resize.current || !selectionBounds) return;
    event.preventDefault();
    event.stopPropagation();
    const captureTarget = event.currentTarget;
    captureTarget.setPointerCapture(event.pointerId);
    resize.current = {
      pointerId: event.pointerId,
      start: toPage(event),
      box: selectionBounds!,
      handle,
      originals: selectedObjects,
      captureTarget,
      changed: false,
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (resize.current?.pointerId !== moveEvent.pointerId) return;
      moveEvent.preventDefault();
      pendingResizeMove.current = {
        pointerId: moveEvent.pointerId,
        clientX: moveEvent.clientX,
        clientY: moveEvent.clientY,
        shiftKey: moveEvent.shiftKey,
      };
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        const pending = pendingResizeMove.current;
        pendingResizeMove.current = null;
        if (pending)
          updateResize(pending.pointerId, pending.clientX, pending.clientY, pending.shiftKey);
      });
    };
    const onUp = (upEvent: PointerEvent) => {
      if (resize.current?.pointerId !== upEvent.pointerId) return;
      upEvent.preventDefault();
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      pendingResizeMove.current = null;
      if (upEvent.type !== "pointercancel")
        updateResize(upEvent.pointerId, upEvent.clientX, upEvent.clientY, upEvent.shiftKey);
      finishResize(upEvent.pointerId, upEvent.type === "pointercancel");
    };
    const onLostPointerCapture = (lostEvent: Event) => {
      const pointerEvent = lostEvent as PointerEvent;
      if (resize.current?.pointerId !== pointerEvent.pointerId) return;
      // A normal pointerup has already completed and cleared the session before
      // the browser emits lostpointercapture. An unexpected capture loss keeps
      // the latest visible geometry instead of rolling a successful drag back.
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      const pending = pendingResizeMove.current;
      pendingResizeMove.current = null;
      if (pending)
        updateResize(pending.pointerId, pending.clientX, pending.clientY, pending.shiftKey);
      finishResize(pointerEvent.pointerId);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    window.addEventListener("pointercancel", onUp, { passive: false });
    captureTarget.addEventListener("lostpointercapture", onLostPointerCapture);
    resizeCleanup.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      captureTarget.removeEventListener("lostpointercapture", onLostPointerCapture);
    };
  };

  function updateResize(pointerId: number, clientX: number, clientY: number, shiftKey: boolean) {
    const session = resize.current;
    if (!session || session.pointerId !== pointerId) return;

    const point = toPage({ clientX, clientY });
    const dx = point.x - session.start.x;
    const dy = point.y - session.start.y;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
      session.changed = false;
      updateLocalObjects(null);
      return;
    }
    const resized = resizeCanvasObjects({
      objects: session.originals,
      box: session.box,
      handle: session.handle,
      delta: { x: dx, y: dy },
      shiftKey,
      reflowText: autoResizeTextObject,
    });
    session.changed = resized.changed;
    if (!resized.changed) {
      updateLocalObjects(null);
      return;
    }

    const resizedById = new Map(resized.objects.map((object) => [object.id, object]));
    const current = useNotesStore.getState().objectsByPage[page.id] ?? [];
    updateLocalObjects(
      current.map((object) => {
        return resizedById.get(object.id) ?? object;
      }),
    );
  }

  function finishResize(pointerId: number, cancelled = false) {
    const session = resize.current;
    if (!session || session.pointerId !== pointerId) return;
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
    pendingResizeMove.current = null;
    resize.current = null;
    resizeCleanup.current?.();
    resizeCleanup.current = null;
    if (session.captureTarget.hasPointerCapture(pointerId)) {
      session.captureTarget.releasePointerCapture(pointerId);
    }
    const state = useNotesStore.getState();
    const preview = localRef.current;
    if (!cancelled && session.changed && preview) {
      // Merge just the resized objects into the latest page state. This keeps
      // unrelated edits made during the gesture out of both the commit and its
      // Undo baseline.
      const latest = state.objectsByPage[page.id] ?? [];
      const originalsById = new Map(session.originals.map((object) => [object.id, object]));
      const previewById = new Map(
        preview
          .filter((object) => originalsById.has(object.id))
          .map((object) => [object.id, object]),
      );
      const before = latest.map((object) => originalsById.get(object.id) ?? object);
      const next = latest.map((object) => previewById.get(object.id) ?? object);
      const selectedBefore = before.filter((object) => originalsById.has(object.id));
      const selectedNext = next.filter((object) => originalsById.has(object.id));
      if (!canvasObjectArraysEqual(selectedNext, selectedBefore)) {
        state.commitObjects(page.id, next, true, before);
      }
    }
    updateLocalObjects(null);
  }

  function onDragOver(event: React.DragEvent<HTMLDivElement>) {
    const hasFiles = Array.from(event.dataTransfer.items).some((item) => item.kind === "file");
    if (!hasFiles) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDropActive(false);
    activatePage();
    const anchor = toPage(event);
    lastInsertPoint.current = anchor;
    const files = Array.from(event.dataTransfer.files).filter(isImageFile);
    if (!files.length) {
      toast.error("Hãy thả một tệp ảnh vào trang.");
      return;
    }
    void (async () => {
      try {
        await insertImageFiles(files, anchor);
        toast.success(files.length > 1 ? `Đã thêm ${files.length} ảnh` : "Đã thêm ảnh");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Không thêm được ảnh.");
      }
    })();
  }

  const editingSessionId =
    editing && textSessionRef.current?.objectId === editing.id
      ? textSessionRef.current.sessionId
      : null;

  return (
    <div
      ref={wrapRef}
      data-page-id={page.id}
      className={`page-shadow relative bg-paper ${drag.current?.kind === "move" || active ? "z-10" : "z-0"}`}
      style={{ width: cssW, height: cssH }}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={onDrop}
    >
      {isVisible ? (
        <>
          <canvas ref={bindBaseCanvas} className="pointer-events-none absolute top-0 left-0" />
          <canvas ref={bindStaticCanvas} className="pointer-events-none absolute top-0 left-0" />
          <canvas
            ref={bindLiveCanvas}
            data-notes-canvas="interaction"
            className="absolute top-0 left-0 touch-none"
            style={{ width: cssW, height: cssH }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={onPointerCancel}
            onDoubleClick={onDoubleClick}
          />
        </>
      ) : null}
      {movePreviewActive && dragPreviewOriginRef.current && typeof document !== "undefined"
        ? createPortal(
            <canvas
              ref={bindDragPreviewCanvas}
              data-notes-drag-preview="true"
              aria-hidden="true"
              className="pointer-events-none fixed z-50"
              style={{
                left: dragPreviewOriginRef.current.left,
                top: dragPreviewOriginRef.current.top,
                width: cssW,
                height: cssH,
                transform: `translate3d(${dragPreviewOffsetRef.current.x}px, ${dragPreviewOffsetRef.current.y}px, 0)`,
                willChange: "transform",
              }}
            />,
            document.body,
          )
        : null}
      {dropActive ? (
        <div className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-surface-2/90 text-accent">
          <div className="flex flex-col items-center gap-2 px-6 text-center">
            <span className="grid size-12 place-items-center rounded-full bg-accent-soft">
              <ImagePlus className="size-5" />
            </span>
            <p className="text-sm font-semibold">Thả ảnh vào đây</p>
            <p className="text-xs text-muted">Ảnh sẽ được đặt đúng tại vị trí con trỏ</p>
          </div>
        </div>
      ) : null}
      {active &&
      !editing &&
      !movePreviewActive &&
      selectionBounds &&
      selected.length &&
      !onlyTextSelected ? (
        <div style={pageOverlayStyle}>
          <div
            data-selection-box="true"
            className="pointer-events-none absolute z-20 border border-accent"
            style={{
              left: selectionBounds.x * zoom,
              top: selectionBounds.y * zoom,
              width: Math.max(1, selectionBounds.w * zoom),
              height: Math.max(1, selectionBounds.h * zoom),
            }}
          >
            <button
              type="button"
              data-resize-handle="tl"
              className="pointer-events-auto absolute -top-4 -left-4 z-10 grid h-8 w-8 place-items-center touch-none cursor-nwse-resize"
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "tl")}
            >
              <div className="grid size-4 place-items-center rounded-full border-2 border-surface-2 bg-accent shadow-sm" />
            </button>
            <button
              type="button"
              data-resize-handle="tr"
              className="pointer-events-auto absolute -top-4 -right-4 z-10 grid h-8 w-8 place-items-center touch-none cursor-nesw-resize"
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "tr")}
            >
              <div className="grid size-4 place-items-center rounded-full border-2 border-surface-2 bg-accent shadow-sm" />
            </button>
            <button
              type="button"
              data-resize-handle="bl"
              className="pointer-events-auto absolute -bottom-4 -left-4 z-10 grid h-8 w-8 place-items-center touch-none cursor-nesw-resize"
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "bl")}
            >
              <div className="grid size-4 place-items-center rounded-full border-2 border-surface-2 bg-accent shadow-sm" />
            </button>
            <button
              type="button"
              data-resize-handle="br"
              className="pointer-events-auto absolute -bottom-4 -right-4 z-10 grid h-8 w-8 place-items-center touch-none cursor-nwse-resize"
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "br")}
            >
              <div className="grid size-4 place-items-center rounded-full border-2 border-surface-2 bg-accent shadow-sm" />
            </button>
            <button
              type="button"
              data-resize-handle="t"
              className="pointer-events-auto absolute -top-4 left-1/2 -translate-x-1/2 grid h-8 w-8 place-items-center touch-none cursor-ns-resize"
              hidden={selectedObjects.some((o) => o.type === "image" && o.rotation % 180 !== 0)}
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "t")}
            >
              <div className="h-1.5 w-4 rounded-full border border-surface-2 bg-accent shadow-sm" />
            </button>
            <button
              type="button"
              data-resize-handle="b"
              className="pointer-events-auto absolute -bottom-4 left-1/2 -translate-x-1/2 grid h-8 w-8 place-items-center touch-none cursor-ns-resize"
              hidden={selectedObjects.some((o) => o.type === "image" && o.rotation % 180 !== 0)}
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "b")}
            >
              <div className="h-1.5 w-4 rounded-full border border-surface-2 bg-accent shadow-sm" />
            </button>
            <button
              type="button"
              data-resize-handle="l"
              className="pointer-events-auto absolute top-1/2 -left-4 -translate-y-1/2 grid h-8 w-8 place-items-center touch-none cursor-ew-resize"
              hidden={selectedObjects.some((o) => o.type === "image" && o.rotation % 180 !== 0)}
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "l")}
            >
              <div className="h-4 w-1.5 rounded-full border border-surface-2 bg-accent shadow-sm" />
            </button>
            <button
              type="button"
              data-resize-handle="r"
              className="pointer-events-auto absolute top-1/2 -right-4 -translate-y-1/2 grid h-8 w-8 place-items-center touch-none cursor-ew-resize"
              hidden={selectedObjects.some((o) => o.type === "image" && o.rotation % 180 !== 0)}
              aria-label="Kéo để đổi kích thước"
              onPointerDown={(event) => startResizeSession(event, "r")}
            >
              <div className="h-4 w-1.5 rounded-full border border-surface-2 bg-accent shadow-sm" />
            </button>
          </div>
        </div>
      ) : null}
      {active &&
      !editing &&
      !movePreviewActive &&
      selectionBounds &&
      onlyTextSelected &&
      selectedObjects.length === 1 ? (
        <TextSelectionOverlay
          object={selectedObjects[0] as Extract<CanvasObject, { type: "text" }>}
          zoom={zoom}
          rotation={page.rotation}
          pageWidth={page.width}
          pageHeight={page.height}
          onResizeStart={startResizeSession}
        />
      ) : null}
      {editing ? (
        <TextEditorOverlay
          key={editingSessionId ?? editing.id}
          sessionId={editingSessionId ?? editing.id}
          notebookId={page.notebookId}
          pageId={page.id}
          editing={editing}
          zoom={zoom}
          pageWidth={page.width}
          pageHeight={page.height}
          rotation={page.rotation}
          onDraftChange={(draft) => {
            if (editingSessionId) stageTextEditingDraft(editingSessionId, draft);
          }}
          onCommit={(draft) => {
            if (!editingSessionId) return;
            finishTextEditing(editingSessionId, draft);
            if (!draft.text.trim()) {
              setSelected((ids) => ids.filter((id) => id !== draft.id));
            }
          }}
          onCancel={() => {
            if (editingSessionId) cancelTextEditing(editingSessionId);
          }}
        />
      ) : null}
      {active &&
      !editing &&
      !movePreviewActive &&
      selectionBounds &&
      displayBounds &&
      selected.length &&
      (!onlyTextSelected || selectedObjects.length > 1) ? (
        <div
          className="selection-toolbar absolute z-30 flex items-center gap-0.5 overflow-x-auto rounded-lg bg-surface-2 p-1 text-fg"
          style={{
            left: Math.min(Math.max(8, displayBounds.x * zoom), Math.max(8, cssW - 326)),
            top:
              displayBounds.y * zoom > 54
                ? displayBounds.y * zoom - 48
                : Math.min(cssH - 46, (displayBounds.y + displayBounds.h) * zoom + 8),
            maxWidth: Math.max(180, cssW - 16),
          }}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label="Thao tác vùng chọn"
        >
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Sao chép"
            onClick={requestSelectionCopy}
          >
            <Copy className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Nhân bản"
            onClick={() => {
              const copies = selectedObjects.map((object) =>
                cloneObject(object, 12 / zoom, 12 / zoom),
              );
              commit([...objects, ...copies]);
              setSelected(copies.map((object) => object.id));
            }}
          >
            <CopyPlus className="size-4" />
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Thu nhỏ"
            onClick={() =>
              transformSelection((object) => scaleObject(object, selectionBounds, 0.9))
            }
          >
            <Minus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Phóng to"
            onClick={() =>
              transformSelection((object) => scaleObject(object, selectionBounds, 1.1))
            }
          >
            <Plus className="size-4" />
          </Button>
          {onlyTextSelected && selectedTextSize !== null ? (
            <>
              <span className="mx-1 h-5 w-px bg-border" />
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Giảm cỡ chữ"
                onClick={() =>
                  transformSelection((object) =>
                    object.type === "text"
                      ? {
                          ...object,
                          fontSize: clamp(object.fontSize - 2, 8, 96),
                          h: Math.max(20, object.h - 2.7),
                        }
                      : object,
                  )
                }
              >
                <span className="text-xs font-semibold">A−</span>
              </Button>
              <span className="min-w-8 text-center text-xs tabular-nums">{selectedTextSize}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Tăng cỡ chữ"
                onClick={() =>
                  transformSelection((object) =>
                    object.type === "text"
                      ? {
                          ...object,
                          fontSize: clamp(object.fontSize + 2, 8, 96),
                          h: object.h + 2.7,
                        }
                      : object,
                  )
                }
              >
                <span className="text-xs font-semibold">A+</span>
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Xoay 15 độ"
            onClick={() =>
              transformSelection((object) => rotateObject(object, selectionBounds, 15))
            }
          >
            <RotateCw className="size-4" />
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          {PEN_COLORS.slice(0, 4).map((color) => (
            <button
              key={color}
              type="button"
              className="grid size-8 place-items-center rounded-md hover:bg-overlay"
              aria-label={`Đổi màu ${color}`}
              onClick={() => transformSelection((object) => recolor(object, color))}
            >
              <span className="block size-4 rounded-full" style={{ backgroundColor: color }} />
            </button>
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-danger"
            aria-label="Xóa vùng chọn"
            onClick={() => {
              const ids = new Set(selected);
              commit(objects.filter((object) => !ids.has(object.id)));
              setSelected([]);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ) : null}
      {active &&
      !movePreviewActive &&
      onlyTextSelected &&
      selectedObjects.length === 1 &&
      selectionBounds &&
      !editing ? (
        <TextContextToolbar
          object={selectedObjects[0] as Extract<CanvasObject, { type: "text" }>}
          zoom={zoom}
          rotation={page.rotation}
          pageWidth={page.width}
          pageHeight={page.height}
          onUpdate={(patch) => {
            const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
            const updated = current.map((o) =>
              o.id === selected[0] && o.type === "text"
                ? autoResizeTextObject({ ...o, ...patch })
                : o,
            );
            commit(updated);
          }}
          onDelete={() => {
            commit(objects.filter((object) => object.id !== selected[0]));
            setSelected([]);
          }}
          onEdit={() => beginTextEditing(selectedObjects[0] as TextObject)}
          onCopy={requestSelectionCopy}
        />
      ) : null}
    </div>
  );
}

const EMPTY: CanvasObject[] = [];
const DRAG_ACTIVATION_DISTANCE = 4;

function isPen(t: ToolName) {
  return t === "ballpoint" || t === "fountain" || t === "pencil" || t === "highlighter";
}
function isShape(t: ToolName) {
  return t === "line" || t === "arrow" || t === "rect" || t === "ellipse";
}

function scalePoint(x: number, y: number, cx: number, cy: number, factor: number) {
  return { x: cx + (x - cx) * factor, y: cy + (y - cy) * factor };
}

function scaleObject(
  object: CanvasObject,
  box: { x: number; y: number; w: number; h: number },
  factor: number,
): CanvasObject {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (object.type === "stroke") {
    return {
      ...object,
      width: Math.max(0.35, object.width * factor),
      points: object.points.map((point) => ({
        ...point,
        ...scalePoint(point.x, point.y, cx, cy, factor),
      })),
    };
  }
  if (object.type === "shape") {
    const a = scalePoint(object.x1, object.y1, cx, cy, factor);
    const b = scalePoint(object.x2, object.y2, cx, cy, factor);
    return {
      ...object,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      width: Math.max(0.35, object.width * factor),
    };
  }
  const position = scalePoint(object.x, object.y, cx, cy, factor);
  return {
    ...object,
    x: position.x,
    y: position.y,
    w: Math.max(12, object.w * factor),
    h: Math.max(12, object.h * factor),
    ...(object.type === "text" ? { fontSize: Math.max(8, object.fontSize * factor) } : {}),
  };
}

function rotateObject(
  object: CanvasObject,
  box: { x: number; y: number; w: number; h: number },
  degrees: number,
): CanvasObject {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const angle = (degrees * Math.PI) / 180;
  const rotatePoint = (x: number, y: number) => ({
    x: cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle),
    y: cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle),
  });
  if (object.type === "stroke") {
    return {
      ...object,
      points: object.points.map((point) => ({ ...point, ...rotatePoint(point.x, point.y) })),
    };
  }
  if (object.type === "shape") {
    const a = rotatePoint(object.x1, object.y1);
    const b = rotatePoint(object.x2, object.y2);
    return { ...object, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
  const center = rotatePoint(object.x + object.w / 2, object.y + object.h / 2);
  return {
    ...object,
    x: center.x - object.w / 2,
    y: center.y - object.h / 2,
    ...(object.type === "image" ? { rotation: object.rotation + degrees } : {}),
  };
}
