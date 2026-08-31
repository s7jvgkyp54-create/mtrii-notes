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
import { getAsset, objectUrlFor } from "@/lib/notes/db";
import { loadPdfDocument, renderPdfPageBitmap } from "@/lib/notes/pdf";
import { nid } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Copy, CopyPlus, Minus, Plus, RotateCw, Trash2 } from "lucide-react";

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

export function PageSurface({
  page,
  zoom,
  active,
}: {
  page: PageRecord;
  zoom: number;
  active: boolean;
}) {
  const objects = useNotesStore((s) => s.objectsByPage[page.id] ?? EMPTY);
  const tool = useNotesStore((s) => s.tool);
  const penOnly = useNotesStore((s) => s.settings.penOnly);
  const notebook = useNotesStore((s) => s.notebooks.find((n) => n.id === page.notebookId));
  const wrapRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const pts = useRef<{ x: number; y: number; p: number }[]>([]);
  const shapeA = useRef<Pt | null>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const baseReady = useRef(false);
  const lastPdfAsset = useRef<string | undefined>(undefined);
  const lastPage = useRef<number | undefined>(undefined);
  const lastZoom = useRef<number>(0);
  const [editing, setEditing] = useState<Extract<CanvasObject, { type: "text" }> | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const drag = useRef<{
    kind: "move" | "lasso";
    last: Pt;
    ids: string[];
  } | null>(null);

  const disp = displaySize(page);
  const cssW = disp.w * zoom;
  const cssH = disp.h * zoom;
  const selectedObjects = objects.filter((object) => selected.includes(object.id));
  const selectionBounds = unionBBox(selectedObjects);

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
  const redrawStrokes = useCallback(async () => {
    const canvas = staticRef.current;
    if (!canvas) return;
    const dpr = sizeCanvases();
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    applyPageRotation(ctx, page, zoom, dpr);

    try {
      await document.fonts.ready;
    } catch {
      /* ignore */
    }

    for (const o of objects) {
      if (o.type === "stroke") drawStroke(ctx, o);
      else if (o.type === "shape") drawShape(ctx, o);
      else if (o.type === "text") drawText(ctx, o);
      else if (o.type === "image") {
        try {
          const asset = await getAsset(o.assetId);
          if (!asset) continue;
          const img = await loadImage(o.assetId, objectUrlFor(o.assetId, asset.blob));
          ctx.save();
          ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
          ctx.rotate((o.rotation * Math.PI) / 180);
          ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
          ctx.restore();
        } catch {
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
    if (!active) return;
    if (isDrawBlocked(ev.nativeEvent)) return;
    (ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId);
    const p = toPage(ev);
    const pressure = ev.pressure > 0 ? ev.pressure : 0.5;

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
      const clickPos = p;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
      document.body.appendChild(input);
      input.onchange = async () => {
        document.body.removeChild(input);
        const file = input.files?.[0];
        if (!file) return;
        const buf = await file.arrayBuffer();
        const blob = new Blob([buf], { type: file.type });
        // Get natural image dimensions
        const imgUrl = URL.createObjectURL(blob);
        const naturalSize = await new Promise<{w:number;h:number}>((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => resolve({ w: 160, h: 120 });
          img.src = imgUrl;
        });
        URL.revokeObjectURL(imgUrl);
        // Fit image: max 400px wide/tall
        const maxDim = 400;
        const ratio = Math.min(maxDim / naturalSize.w, maxDim / naturalSize.h, 1);
        const iw = Math.round(naturalSize.w * ratio);
        const ih = Math.round(naturalSize.h * ratio);
        const id = nid();
        const { putAsset } = await import("@/lib/notes/db");
        await putAsset({
          id,
          kind: "image",
          mime: file.type,
          name: file.name,
          byteLength: blob.size,
          blob,
          createdAt: Date.now(),
        });
        const imgId = nid();
        const imgObj: CanvasObject = {
          id: imgId,
          type: "image",
          x: clickPos.x - iw / 2,
          y: clickPos.y - ih / 2,
          w: iw,
          h: ih,
          rotation: 0,
          assetId: id,
        };
        const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
        commit([...current, imgObj]);
        // Auto-select so user can immediately move/resize
        setSelected([imgId]);
      };
      input.click();
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
    if (!drawing.current) return;
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
        useNotesStore.getState().commitObjects(page.id, next, false);
        continue;
      }
      if (drag.current?.kind === "lasso" || isPen(tool.name) || isShape(tool.name)) {
        const last = pts.current[pts.current.length - 1];
        if (last && dist(last, p) < 0.35) continue;
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
      const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
      useNotesStore.getState().commitObjects(page.id, current, true);
      return;
    }

    if (drag.current?.kind === "move") {
      drag.current = null;
      const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
      useNotesStore.getState().commitObjects(page.id, current, true);
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
        coords = snapShape(tool.name as "line" | "arrow" | "rect" | "ellipse", coords.x1, coords.y1, coords.x2, coords.y2);
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
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useNotesStore.getState().redo();
        else useNotesStore.getState().undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        useNotesStore.getState().redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selected.length) {
        const objs = objects.filter((o) => selected.includes(o.id)).map((o) => cloneObject(o, 0, 0));
        useNotesStore.setState({ clipboard: objs });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && selected.length) {
        const objs = objects.filter((o) => selected.includes(o.id)).map((o) => cloneObject(o, 0, 0));
        useNotesStore.setState({ clipboard: objs });
        commit(objects.filter((o) => !selected.includes(o.id)));
        setSelected([]);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        const clip = useNotesStore.getState().clipboard;
        if (!clip.length) return;
        const copies = clip.map((o) => cloneObject(o));
        commit([...objects, ...copies]);
        setSelected(copies.map((c) => c.id));
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
        commit(objects.filter((o) => !selected.includes(o.id)));
        setSelected([]);
      }
      if (e.key === "[" && selected.length) {
        const color = useNotesStore.getState().tool.color;
        commit(objects.map((o) => (selected.includes(o.id) ? recolor(o, color) : o)));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, objects, selected]);

  return (
    <div
      ref={wrapRef}
      className="page-shadow relative bg-paper"
      style={{ width: cssW, height: cssH }}
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
      {editing ? (
        <textarea
          autoFocus
          className="absolute resize-none border-2 border-accent bg-surface-2/95 p-1.5 text-fg outline-none shadow-lg"
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
          onBlur={(e) => {
            const text = e.target.value.trim();
            const current = useNotesStore.getState().objectsByPage[page.id] ?? objects;
            const exists = current.some((o) => o.id === editing.id);
            if (text) {
              if (exists) {
                commit(current.map((o) => o.id === editing.id && o.type === "text" ? { ...o, text } : o));
              } else {
                commit([...current, { ...editing, text }]);
              }
            } else if (exists) {
              // Remove empty text objects when cleared
              commit(current.filter((o) => o.id !== editing.id));
            }
            setEditing(null);
          }}
        />
      ) : null}
      {selectionBounds && selected.length ? (
        <div
          className="selection-toolbar absolute z-30 flex items-center gap-0.5 rounded-lg bg-surface-2 p-1 text-fg"
          style={{
            left: Math.min(
              Math.max(8, selectionBounds.x * zoom),
              Math.max(8, cssW - 326),
            ),
            top:
              selectionBounds.y * zoom > 54
                ? selectionBounds.y * zoom - 48
                : Math.min(cssH - 46, (selectionBounds.y + selectionBounds.h) * zoom + 8),
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
              useNotesStore.setState({ clipboard: selectedObjects.map((object) => cloneObject(object, 0, 0)) })
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
              const copies = selectedObjects.map((object) => cloneObject(object, 12 / zoom, 12 / zoom));
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

function scaleObject(object: CanvasObject, box: { x: number; y: number; w: number; h: number }, factor: number): CanvasObject {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (object.type === "stroke") {
    return {
      ...object,
      width: Math.max(0.35, object.width * factor),
      points: object.points.map((point) => ({ ...point, ...scalePoint(point.x, point.y, cx, cy, factor) })),
    };
  }
  if (object.type === "shape") {
    const a = scalePoint(object.x1, object.y1, cx, cy, factor);
    const b = scalePoint(object.x2, object.y2, cx, cy, factor);
    return { ...object, x1: a.x, y1: a.y, x2: b.x, y2: b.y, width: Math.max(0.35, object.width * factor) };
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

function rotateObject(object: CanvasObject, box: { x: number; y: number; w: number; h: number }, degrees: number): CanvasObject {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const angle = (degrees * Math.PI) / 180;
  const rotatePoint = (x: number, y: number) => ({
    x: cx + (x - cx) * Math.cos(angle) - (y - cy) * Math.sin(angle),
    y: cy + (x - cx) * Math.sin(angle) + (y - cy) * Math.cos(angle),
  });
  if (object.type === "stroke") {
    return { ...object, points: object.points.map((point) => ({ ...point, ...rotatePoint(point.x, point.y) })) };
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
