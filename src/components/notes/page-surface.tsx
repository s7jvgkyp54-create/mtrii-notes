import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasObject, PageRecord, StrokeObject, ToolName } from "@/lib/notes/types";
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
  recolor,
  snapShape,
  translateObject,
  unionBBox,
  type Pt,
} from "@/lib/notes/geometry";
import { drawLasso, drawPaper, drawShape, drawStroke, drawText } from "@/lib/notes/render";
import { getAsset, objectUrlFor, putAsset } from "@/lib/notes/db";
import { loadPdfDocument, renderPdfPageBitmap } from "@/lib/notes/pdf";
import { nid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Copy,
  CopyPlus,
  ImagePlus,
  Minus,
  MoveDiagonal2,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

export const OPEN_IMAGE_PICKER_EVENT = "notes:open-image-picker";

const imageCache = new Map<string, HTMLImageElement>();

function loadImage(id: string, url: string) {
  const hit = imageCache.get(id);
  if (hit) return Promise.resolve(hit);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageCache.set(id, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error("Không tải được ảnh"));
    img.src = url;
  });
}

async function readImageSize(blob: Blob) {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight });
      image.onerror = () => reject(new Error("Tệp ảnh không đọc được."));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
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
  const [localObjects, setLocalObjects] = useState<import("@/lib/notes/types").CanvasObject[] | null>(null);
  const localRef = useRef<import("@/lib/notes/types").CanvasObject[] | null>(null);
  
  function updateLocalObjects(next: import("@/lib/notes/types").CanvasObject[] | null) {
      localRef.current = next;
      updateLocalObjects(next);
  }
  const objects = localObjects ?? globalObjects;
  
  useEffect(() => {
    // When global objects change (e.g. from undo or sync), clear local override
    updateLocalObjects(null);
  }, [globalObjects]);
  const tool = useNotesStore((s) => s.tool);
  const penOnly = useNotesStore((s) => s.settings.penOnly);
  const notebook = useNotesStore((s) => s.notebooks.find((n) => n.id === page.notebookId));
  const wrapRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const renderIdRef = useRef(0);
  const drawing = useRef(false);
    const erasingNextRef = useRef<CanvasObject[] | null>(null);
    const dragNextRef = useRef<CanvasObject[] | null>(null);
  const pts = useRef<{ x: number; y: number; p: number }[]>([]);
  const shapeA = useRef<Pt | null>(null);
  const strokeBeforeState = useRef<CanvasObject[] | null>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const baseReady = useRef(false);
  const lastPdfAsset = useRef<string | undefined>(undefined);
  const lastPage = useRef<number | undefined>(undefined);
  const lastZoom = useRef<number>(0);
  const [editing, setEditing] = useState<Extract<CanvasObject, { type: "text" }> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const lastInsertPoint = useRef<Pt>({ x: page.width / 2, y: page.height / 2 });
    const textSaveTimer = useRef<any>(null);
  const resize = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    box: { x: number; y: number; w: number; h: number };
    handle: "tl" | "tr" | "bl" | "br";
    originals: CanvasObject[];
    before: CanvasObject[];
  } | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const drag = useRef<{
    kind: "move" | "lasso";
    last: Pt;
    ids: string[];
  } | null>(null);

  const [isVisible, setIsVisible] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setIsVisible(entries[0].isIntersecting);
      },
      { rootMargin: "1000px" } // Render pages within 1000px of viewport
    );
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);
  
  const disp = displaySize(page);
  const cssW = disp.w * zoom;
  const cssH = disp.h * zoom;
  const selectedObjects = objects.filter((object) => selected.includes(object.id));
  const selectionBounds = unionBBox(selectedObjects);
  const onlyTextSelected =
    selectedObjects.length > 0 && selectedObjects.every((object) => object.type === "text");
  const selectedTextSize = onlyTextSelected
    ? Math.round((selectedObjects[0] as Extract<CanvasObject, { type: "text" }>).fontSize)
    : null;

  const activatePage = useCallback(() => {
    const state = useNotesStore.getState();
    const index = state.pages.findIndex((candidate) => candidate.id === page.id);
    if (index >= 0 && state.currentPageIndex !== index) state.setPageIndex(index);
  }, [page.id]);

  const insertImageFile = useCallback(
    async (file: File, anchor: Pt) => {
      const mime = file.type || "image/png";
      if (!mime.startsWith("image/")) throw new Error("Tệp đã chọn không phải là ảnh.");

      const blob = file.slice(0, file.size, mime);
      const natural = await readImageSize(blob);
      if (!natural.w || !natural.h) throw new Error("Ảnh không có kích thước hợp lệ.");

      const maxW = Math.min(420, page.width * 0.72);
      const maxH = Math.min(520, page.height * 0.64);
      const ratio = Math.min(maxW / natural.w, maxH / natural.h, 1);
      const width = Math.max(12, Math.round(natural.w * ratio));
      const height = Math.max(12, Math.round(natural.h * ratio));
      const padding = 16;
      const x = clamp(
        anchor.x - width / 2,
        padding,
        Math.max(padding, page.width - width - padding),
      );
      const y = clamp(
        anchor.y - height / 2,
        padding,
        Math.max(padding, page.height - height - padding),
      );
      const assetId = nid();

      await putAsset({
        id: assetId,
        kind: "image",
        mime,
        name: file.name || `anh-bang-tam-${new Date().toISOString().replaceAll(":", "-")}.png`,
        byteLength: blob.size,
        blob,
        createdAt: Date.now(),
      });

      const imageId = nid();
      const imageObject: CanvasObject = {
        id: imageId,
        type: "image",
        x,
        y,
        w: width,
        h: height,
        rotation: 0,
        assetId,
      };
      const state = useNotesStore.getState();
      const current = state.objectsByPage[page.id] ?? [];
      state.commitObjects(page.id, [...current, imageObject], true);
      state.setTool({ name: "lasso" });
      setSelected([imageId]);
      return imageId;
    },
    [page.height, page.id, page.width],
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
          for (let index = 0; index < files.length; index += 1) {
            await insertImageFile(files[index]!, {
              x: anchor.x + index * 18,
              y: anchor.y + index * 18,
            });
          }
          toast.success(files.length > 1 ? `Đã thêm ${files.length} ảnh` : "Đã thêm ảnh");
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Không thêm được ảnh.");
        }
      };
      input.click();
    },
    [insertImageFile],
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
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    for (const canvas of [staticRef.current, liveRef.current]) {
      if (!canvas) continue;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    return dpr;
  }, [cssH, cssW]);

  // Draw PDF + paper background onto the base canvas (only when pdf/zoom changes)
  const redrawBase = useCallback(async () => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
      try {
        const asset = await getAsset(notebook.pdfAssetId);
        if (asset) {
          const doc = await loadPdfDocument(notebook.pdfAssetId, await asset.blob.arrayBuffer());
          const bmp = await renderPdfPageBitmap(
            doc,
            page.pdfPage,
            zoom * dpr,
            page.rotation,
            notebook.pdfAssetId,
          );
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          ctx.restore();
          applyPageRotation(ctx, page, zoom, dpr);
        }
      } catch {
        /* render paper only */
      }
    }
    baseReady.current = true;
    lastPdfAsset.current = notebook?.pdfAssetId ?? undefined;
    lastPage.current = page.pdfPage ?? undefined;
    lastZoom.current = zoom;
  }, [notebook?.pdfAssetId, page, zoom, cssW, cssH]);

  // Draw just the strokes + selection overlay onto staticRef (very fast, no PDF re-render)
  const redrawStrokes = useCallback(async (overrideObjects?: CanvasObject[]) => {
    const renderId = ++renderIdRef.current;
    const canvas = staticRef.current;
    if (!canvas) return;

    try {
      await document.fonts.ready;
    } catch {
      /* ignore */
    }

    const targetObjects = overrideObjects ?? objects;
    const loadedImages = new Map<string, HTMLImageElement>();
    for (const o of targetObjects) {
      if (o.type === "image") {
        try {
          const cached = imageCache.get(o.assetId);
          if (cached) {
            loadedImages.set(o.id, cached);
          } else {
            const asset = await getAsset(o.assetId);
            if (asset) {
              const img = await loadImage(o.assetId, objectUrlFor(o.assetId, asset.blob));
              loadedImages.set(o.id, img);
            }
          }
        } catch {}
      }
    }

    if (renderId !== renderIdRef.current) return;

    const dpr = sizeCanvases();
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyPageRotation(ctx, page, zoom, dpr);

    for (const o of targetObjects) {
      if (o.type === "stroke") drawStroke(ctx, o);
      else if (o.type === "shape") drawShape(ctx, o);
      else if (o.type === "text") drawText(ctx, o);
      else if (o.type === "image") {
        const img = loadedImages.get(o.id);
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
    if (box) {
      ctx.save();
      ctx.strokeStyle = "#0F766E";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.restore();
    }
  }, [objects, page, selected, sizeCanvases, zoom]);

  // Re-render base (PDF) only when PDF asset, page, or zoom changes
  useEffect(() => {
    const pdfChanged =
      lastPdfAsset.current !== notebook?.pdfAssetId ||
      lastPage.current !== page.pdfPage ||
      Math.abs(lastZoom.current - zoom) > 0.01;
    if (pdfChanged) void redrawBase();
  }, [notebook?.pdfAssetId, page.pdfPage, zoom, redrawBase]);

  // Re-render strokes whenever objects/selection change (cheap operation)
  useEffect(() => {
    void redrawStrokes();
  }, [redrawStrokes]);

  useEffect(() => {
    if (!active) return;
    const onOpenImagePicker = () => openImagePicker();
    window.addEventListener(OPEN_IMAGE_PICKER_EVENT, onOpenImagePicker);
    return () => window.removeEventListener(OPEN_IMAGE_PICKER_EVENT, onOpenImagePicker);
  }, [active, openImagePicker]);

  useEffect(() => {
    if (!active) return;

    const onPaste = (event: ClipboardEvent) => {
      const imageFiles = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));

      if (imageFiles.length) {
        event.preventDefault();
        activatePage();
        void (async () => {
          try {
            for (let index = 0; index < imageFiles.length; index += 1) {
              await insertImageFile(imageFiles[index]!, {
                x: lastInsertPoint.current.x + index * 18,
                y: lastInsertPoint.current.y + index * 18,
              });
            }
            toast.success(
              imageFiles.length > 1
                ? `Đã dán ${imageFiles.length} ảnh từ bảng tạm`
                : "Đã dán ảnh từ bảng tạm",
            );
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Không dán được ảnh.");
          }
        })();
        return;
      }

      const typing =
        event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
      if (typing) return;

      const state = useNotesStore.getState();
      if (!state.clipboard.length) return;
      event.preventDefault();
      const copies = state.clipboard.map((object) => cloneObject(object));
      const current = state.objectsByPage[page.id] ?? [];
      state.commitObjects(page.id, [...current, ...copies], true);
      setSelected(copies.map((copy) => copy.id));
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [activatePage, active, insertImageFile, page.id]);

  const setupLive = () => {
    const canvas = liveRef.current;
    if (!canvas) return null;
    const dpr = sizeCanvases();
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyPageRotation(ctx, page, zoom, dpr);
    return ctx;
  };

  function commit(next: CanvasObject[]) {
    useNotesStore.getState().commitObjects(page.id, next, true);
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
      ev.currentTarget.setPointerCapture(ev.pointerId);
    activatePage();
    if (isDrawBlocked(ev.nativeEvent)) return;
    (ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId);
    const p = toPage(ev);
    lastInsertPoint.current = p;
    const pressure = ev.pressure > 0 ? ev.pressure : 0.5;
    strokeBeforeState.current = useNotesStore.getState().objectsByPage[page.id] ?? objects;

    if (tool.name === "text") {
      const hit = [...objects].reverse().find((o) => o.type === "text" && hitTest(o, p, 2));
      if (hit && hit.type === "text") {
        setEditing(hit);
        return;
      }
      // Create text object but do NOT commit until user types something (avoid blank flash)
      const t: Extract<CanvasObject, { type: "text" }> = {
        id: nid(),
        type: "text",
        x: p.x,
        y: p.y,
        w: 240,
        h: 72,
        text: "",
        fontSize: tool.fontSize,
        color: tool.color,
        align: "left",
      };
      setEditing(t);
      return;
    }

    if (tool.name === "image") {
      openImagePicker(p);
      return;
    }

    if (tool.name === "lasso") {
      const hit = [...objects].reverse().find((o) => hitTest(o, p, 6));
      if (hit && selected.includes(hit.id)) {
        drag.current = { kind: "move", last: p, ids: selected };
        drawing.current = true;
        return;
      }
      if (hit) {
        setSelected([hit.id]);
        drag.current = { kind: "move", last: p, ids: [hit.id] };
        drawing.current = true;
        return;
      }
      drawing.current = true;
      pts.current = [{ ...p, p: 0.5 }];
      drag.current = { kind: "lasso", last: p, ids: [] };
      return;
    }

    if (tool.name === "eraser") {
      drawing.current = true;
      applyEraser(p);
      return;
    }

    if (isShape(tool.name)) {
      drawing.current = true;
      shapeA.current = p;
      pts.current = [{ ...p, p: pressure }];
      return;
    }

    drawing.current = true;
    pts.current = [{ ...p, p: pressure }];
  }

  function onPointerMove(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) {
      if (active) lastInsertPoint.current = toPage(ev);
      return;
    }
    const events = ev.nativeEvent.getCoalescedEvents?.() ?? [ev.nativeEvent];
    for (const e of events) {
      const p = toPage(e);
      const pressure = e.pressure > 0 ? e.pressure : 0.5;
      if (tool.name === "eraser") {
        applyEraser(p);
        continue;
      }
      if (drag.current?.kind === "move") {
        const dx = p.x - drag.current.last.x;
        const dy = p.y - drag.current.last.y;
        drag.current.last = p;
        const ids = new Set(drag.current.ids);
        const next = (useNotesStore.getState().objectsByPage[page.id] ?? objects).map((o) =>
          ids.has(o.id) ? translateObject(o, dx, dy) : o,
        );
        updateLocalObjects(next);
        continue;
      }
      if (drag.current?.kind === "lasso" || isPen(tool.name) || isShape(tool.name)) {
        const last = pts.current[pts.current.length - 1];
        if (last && dist(last, p) < 1.0 / zoom) continue;
        pts.current.push({ ...p, p: pressure });
        const ctx = setupLive();
        if (!ctx) continue;
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
        } else if (isShape(tool.name) && shapeA.current) {
          const b = pts.current[pts.current.length - 1]!;
          drawShape(ctx, {
            id: "live",
            type: "shape",
            shape: tool.name as "line" | "arrow" | "rect" | "ellipse",
            x1: shapeA.current.x,
            y1: shapeA.current.y,
            x2: b.x,
            y2: b.y,
            color: tool.color,
            width: tool.width,
          });
        } else {
          drawLasso(ctx, pts.current);
        }
      }
    }
  }

  function onPointerUp(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    const ctx = setupLive();
    ctx?.clearRect?.(-9999, -9999, 20000, 20000);
    setupLive();

    // Eraser: all intermediate moves were non-undoable; commit once here as a single undo step
    if (tool.name === "eraser") {
      const current = localRef.current ?? useNotesStore.getState().objectsByPage[page.id] ?? objects;
      useNotesStore
        .getState()
        .commitObjects(page.id, current, true, strokeBeforeState.current ?? undefined);
      strokeBeforeState.current = null;
      return;
    }

    if (drag.current?.kind === "move") {
      drag.current = null;
      const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
      useNotesStore
        .getState()
        .commitObjects(page.id, current, true, strokeBeforeState.current ?? undefined);
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

  function applyEraser(p: Pt) {
    const { eraserMode, eraserWidth } = useNotesStore.getState().tool;
    const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
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
    // Apply silently (non-undoable) during move; committed as one undo step on pointer-up
    if (changed) useNotesStore.getState().commitObjects(page.id, next, false);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!active) return;
      const typing =
        e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (typing) return;
      const saveObjects = (next: CanvasObject[]) =>
        useNotesStore.getState().commitObjects(page.id, next, true);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selected.length) {
        const objs = objects
          .filter((o) => selected.includes(o.id))
          .map((o) => cloneObject(o, 0, 0));
        useNotesStore.setState({ clipboard: objs });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && selected.length) {
        const objs = objects
          .filter((o) => selected.includes(o.id))
          .map((o) => cloneObject(o, 0, 0));
        useNotesStore.setState({ clipboard: objs });
        saveObjects(objects.filter((o) => !selected.includes(o.id)));
        setSelected([]);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
        saveObjects(objects.filter((o) => !selected.includes(o.id)));
        setSelected([]);
      }
      if (e.key === "[" && selected.length) {
        const color = useNotesStore.getState().tool.color;
        saveObjects(objects.map((o) => (selected.includes(o.id) ? recolor(o, color) : o)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, objects, page.id, selected]);

  useEffect(
    () => () => {
      resizeCleanup.current?.();
    },
    [],
  );

  const startResizeSession = (event: React.PointerEvent, handle: "tl" | "tr" | "bl" | "br") => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      box: selectionBounds!,
      handle,
      originals: selectedObjects,
      before: useNotesStore.getState().objectsByPage[page.id] ?? objects,
    };
    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      updateResize(moveEvent.pointerId, moveEvent.clientX, moveEvent.clientY);
    };
    const onUp = (upEvent: PointerEvent) => {
      upEvent.preventDefault();
      finishResize(upEvent.pointerId);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    window.addEventListener("pointercancel", onUp, { passive: false });
    resizeCleanup.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  };

  function updateResize(pointerId: number, clientX: number, clientY: number) {
    const session = resize.current;
    if (!session || session.pointerId !== pointerId) return;

    const dx = (clientX - session.startX) / zoom;
    const dy = (clientY - session.startY) / zoom;
    
    let relativeX = 0;
    let relativeY = 0;
    
    if (session.handle === "br") {
      relativeX = dx / Math.max(1, session.box.w);
      relativeY = dy / Math.max(1, session.box.h);
    } else if (session.handle === "tl") {
      relativeX = -dx / Math.max(1, session.box.w);
      relativeY = -dy / Math.max(1, session.box.h);
    } else if (session.handle === "tr") {
      relativeX = dx / Math.max(1, session.box.w);
      relativeY = -dy / Math.max(1, session.box.h);
    } else if (session.handle === "bl") {
      relativeX = -dx / Math.max(1, session.box.w);
      relativeY = dy / Math.max(1, session.box.h);
    }

    const factor = clamp(
      1 + (Math.abs(relativeX) >= Math.abs(relativeY) ? relativeX : relativeY),
      0.15,
      8,
    );
    
    let origin = { x: session.box.x, y: session.box.y };
    if (session.handle === "tl") origin = { x: session.box.x + session.box.w, y: session.box.y + session.box.h };
    else if (session.handle === "tr") origin = { x: session.box.x, y: session.box.y + session.box.h };
    else if (session.handle === "bl") origin = { x: session.box.x + session.box.w, y: session.box.y };

    const originals = new Map(session.originals.map((object) => [object.id, object]));
    const state = useNotesStore.getState();
    const current = state.objectsByPage[page.id] ?? [];
    useNotesStore.setState({
      objectsByPage: {
        ...state.objectsByPage,
        [page.id]: current.map((object) => {
          const original = originals.get(object.id);
          return original ? scaleObjectFromOrigin(original, origin, factor) : object;
        }),
      },
    });
  }

  function finishResize(pointerId: number) {
    const session = resize.current;
    if (!session || session.pointerId !== pointerId) return;
    resizeCleanup.current?.();
    resizeCleanup.current = null;
    resize.current = null;
    const state = useNotesStore.getState();
    state.commitObjects(page.id, state.objectsByPage[page.id] ?? [], true, session.before);
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
        for (let index = 0; index < files.length; index += 1) {
          await insertImageFile(files[index]!, {
            x: anchor.x + index * 18,
            y: anchor.y + index * 18,
          });
        }
        toast.success(files.length > 1 ? `Đã thêm ${files.length} ảnh` : "Đã thêm ảnh");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Không thêm được ảnh.");
      }
    })();
  }

  return (
    <div
      ref={wrapRef}
      className="page-shadow relative bg-paper"
      style={{ width: cssW, height: cssH }}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={onDrop}
    >
      <canvas ref={baseRef} className="pointer-events-none absolute top-0 left-0" />
      <canvas ref={staticRef} className="pointer-events-none absolute top-0 left-0" />
      <canvas
        ref={liveRef}
        className="absolute top-0 left-0 touch-none"
        style={{ width: cssW, height: cssH }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
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
      {selectionBounds && selected.length && page.rotation === 0 ? (
        <div
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
            className="pointer-events-auto absolute -top-3 -left-3 grid size-7 place-items-center rounded-full border-2 border-surface-2 bg-accent text-accent-fg shadow-md touch-none cursor-nwse-resize"
            aria-label="K?o ?? ??i k?ch th??c"
            onPointerDown={(event) => startResizeSession(event, "tl")}
          >
            <MoveDiagonal2 className="size-3.5 rotate-90" />
          </button>
          <button
            type="button"
            className="pointer-events-auto absolute -top-3 -right-3 grid size-7 place-items-center rounded-full border-2 border-surface-2 bg-accent text-accent-fg shadow-md touch-none cursor-nesw-resize"
            aria-label="K?o ?? ??i k?ch th??c"
            onPointerDown={(event) => startResizeSession(event, "tr")}
          >
            <MoveDiagonal2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="pointer-events-auto absolute -bottom-3 -left-3 grid size-7 place-items-center rounded-full border-2 border-surface-2 bg-accent text-accent-fg shadow-md touch-none cursor-nesw-resize"
            aria-label="K?o ?? ??i k?ch th??c"
            onPointerDown={(event) => startResizeSession(event, "bl")}
          >
            <MoveDiagonal2 className="size-3.5" />
          </button>
          <button
            type="button"
            className="pointer-events-auto absolute -right-3 -bottom-3 grid size-7 place-items-center rounded-full border-2 border-surface-2 bg-accent text-accent-fg shadow-md touch-none cursor-nwse-resize"
            aria-label="K?o ?? ??i k?ch th??c"
            onPointerDown={(event) => startResizeSession(event, "br")}
          >
            <MoveDiagonal2 className="size-3.5 rotate-90" />
          </button>
        </div>
      ) : null}
      {editing ? (
          <textarea
            autoFocus
            rows={2}
            placeholder="Nh?p n?i dung?"
            className="absolute resize overflow-auto rounded-md border-2 border-accent bg-surface-2/95 p-2 text-fg outline-none shadow-lg"
            style={{
              left: editing.x * zoom,
              top: editing.y * zoom,
              width: Math.max(120, editing.w * zoom),
              height: Math.max(40, editing.h * zoom),
              fontSize: editing.fontSize * zoom,
              color: editing.color,
              fontFamily: "Be Vietnam Pro, sans-serif",
              zIndex: 50,
              lineHeight: 1.4,
            }}
            defaultValue={editing.text}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(e) => {
              const el = e.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.max(editing.fontSize * 1.5 * zoom, el.scrollHeight)}px`;
              
              if (textSaveTimer.current) clearTimeout(textSaveTimer.current);
              textSaveTimer.current = setTimeout(() => {
                const text = el.value.trimEnd();
                if (!text.trim()) return;
                const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
                const exists = current.some((o) => o.id === editing.id);
                const nextText = {
                  ...editing,
                  text,
                  w: Math.max(120, el.offsetWidth / zoom),
                  h: Math.max(editing.fontSize * 1.5, el.scrollHeight / zoom),
                };
                if (exists) {
                  useNotesStore.getState().commitObjects(page.id, current.map((o) => (o.id === editing.id && o.type === "text" ? nextText : o)), true);
                } else {
                  useNotesStore.getState().commitObjects(page.id, [...current, nextText], true);
                }
              }, 500);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.value = editing.text;
                if (textSaveTimer.current) clearTimeout(textSaveTimer.current);
                event.currentTarget.blur();
              } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              if (textSaveTimer.current) clearTimeout(textSaveTimer.current);
              const text = e.target.value.trimEnd();
              const nextText = {
                ...editing,
                text,
                w: Math.max(120, e.currentTarget.offsetWidth / zoom),
                h: Math.max(editing.fontSize * 1.5, e.currentTarget.scrollHeight / zoom),
              };
              const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
              const exists = current.some((o) => o.id === editing.id);
              if (text.trim()) {
                if (exists) {
                  commit(current.map((o) => (o.id === editing.id && o.type === "text" ? nextText : o)));
                } else {
                  commit([...current, nextText]);
                }
              } else if (exists) {
                commit(current.filter((o) => o.id !== editing.id));
              }
              setEditing(null);
            }}
          />
        ) : null}
      {selectionBounds && selected.length ? (
        <div
          className="selection-toolbar absolute z-30 flex items-center gap-0.5 overflow-x-auto rounded-lg bg-surface-2 p-1 text-fg"
          style={{
            left: Math.min(Math.max(8, selectionBounds.x * zoom), Math.max(8, cssW - 326)),
            top:
              selectionBounds.y * zoom > 54
                ? selectionBounds.y * zoom - 48
                : Math.min(cssH - 46, (selectionBounds.y + selectionBounds.h) * zoom + 8),
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
            onClick={() =>
              useNotesStore.setState({
                clipboard: selectedObjects.map((object) => cloneObject(object, 0, 0)),
              })
            }
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
    </div>
  );
}

const EMPTY: CanvasObject[] = [];

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

function scaleObjectFromOrigin(
  object: CanvasObject,
  origin: { x: number; y: number },
  factor: number,
): CanvasObject {
  const scale = (x: number, y: number) => ({
    x: origin.x + (x - origin.x) * factor,
    y: origin.y + (y - origin.y) * factor,
  });

  if (object.type === "stroke") {
    return {
      ...object,
      width: Math.max(0.35, object.width * factor),
      points: object.points.map((point) => ({ ...point, ...scale(point.x, point.y) })),
    };
  }
  if (object.type === "shape") {
    const start = scale(object.x1, object.y1);
    const end = scale(object.x2, object.y2);
    return {
      ...object,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      width: Math.max(0.35, object.width * factor),
    };
  }

  const position = scale(object.x, object.y);
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
