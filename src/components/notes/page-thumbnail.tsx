import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasObject, PageRecord } from "@/lib/notes/types";
import { useNotesStore } from "@/lib/notes/store";
import { subscribeTransientAssetInvalidation } from "@/lib/notes/db";
import { applyPageRotation, displaySize } from "@/lib/notes/geometry";
import { drawPaper, drawShape, drawStroke, drawText } from "@/lib/notes/render";
import { acquireStoredPdfDocument, renderPdfPageBitmap } from "@/lib/notes/pdf";
import { acquireAssetImage, type AssetImageLease } from "@/lib/notes/image-cache";
import { releaseCanvasBackingStore } from "@/lib/notes/canvas-memory";

const THUMBNAIL_RELEASE_DELAY_MS = 1_200;

function waitForImageLease(lease: AssetImageLease, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<Awaited<AssetImageLease["promise"]>>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void lease.promise.then(
      (image) => {
        cleanup();
        resolve(image);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function PageThumbnail({ page }: { page: PageRecord }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawGenerationRef = useRef(0);
  const [resourceRevision, setResourceRevision] = useState(0);
  const objects = useNotesStore((state) => state.objectsByPage[page.id] ?? EMPTY);
  const notebook = useNotesStore((state) =>
    state.notebooks.find((item) => item.id === page.notebookId),
  );
  const display = displaySize(page);

  const bindCanvas = useCallback((node: HTMLCanvasElement | null) => {
    if (!node && canvasRef.current) releaseCanvasBackingStore(canvasRef.current);
    canvasRef.current = node;
  }, []);

  useEffect(
    () =>
      subscribeTransientAssetInvalidation((assetId) => {
        if (
          assetId === null ||
          assetId === notebook?.pdfAssetId ||
          objects.some((object) => object.type === "image" && object.assetId === assetId)
        ) {
          setResourceRevision((revision) => revision + 1);
        }
      }),
    [notebook?.pdfAssetId, objects],
  );

  useEffect(() => {
    let disposed = false;
    let frame: number | null = null;
    let releaseTimer: number | null = null;
    let controller: AbortController | null = null;
    let intersecting = false;

    const current = (generation: number) =>
      !disposed && !controller?.signal.aborted && drawGenerationRef.current === generation;

    const draw = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      controller?.abort();
      controller = new AbortController();
      const generation = ++drawGenerationRef.current;
      const scale = 144 / display.w;
      canvas.width = Math.max(1, Math.round(display.w * scale));
      canvas.height = Math.max(1, Math.round(display.h * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      applyPageRotation(context, page, scale, 1);
      drawPaper(context, page.width, page.height, page.paper);

      if (notebook?.pdfAssetId && page.pdfPage) {
        let documentLease: Awaited<ReturnType<typeof acquireStoredPdfDocument>> | null = null;
        try {
          documentLease = await acquireStoredPdfDocument(notebook.pdfAssetId);
          if (!current(generation)) return;
          const bitmapLease = await renderPdfPageBitmap(
            documentLease.document,
            page.pdfPage,
            scale,
            page.rotation,
            notebook.pdfAssetId,
            controller.signal,
            "background",
          );
          try {
            if (!current(generation)) return;
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.drawImage(bitmapLease.bitmap, 0, 0, canvas.width, canvas.height);
            applyPageRotation(context, page, scale, 1);
          } finally {
            bitmapLease.release();
          }
        } catch {
          // Trang giấy và lớp ghi chú vẫn hiển thị nếu PDF tạm thời chưa đọc được.
        } finally {
          documentLease?.release();
        }
      }

      for (const object of objects) {
        if (!current(generation)) return;
        if (object.type === "stroke") drawStroke(context, object);
        else if (object.type === "shape") drawShape(context, object);
        else if (object.type === "text") drawText(context, object);
        else {
          const targetDimension = Math.ceil(Math.max(object.w, object.h) * scale * 1.1);
          const lease = acquireAssetImage(object.assetId, "background", targetDimension);
          try {
            const image = await waitForImageLease(lease, controller.signal);
            if (!current(generation)) return;
            context.save();
            context.translate(object.x + object.w / 2, object.y + object.h / 2);
            context.rotate((object.rotation * Math.PI) / 180);
            context.drawImage(image, -object.w / 2, -object.h / 2, object.w, object.h);
            context.restore();
          } catch {
            // Một asset hỏng không chặn các đối tượng còn lại trong thumbnail.
          } finally {
            lease.release();
          }
        }
      }
    };

    const scheduleDraw = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        void draw();
      });
    };

    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!("IntersectionObserver" in window)) {
      scheduleDraw();
    } else {
      const observer = new IntersectionObserver(
        ([entry]) => {
          intersecting = entry.isIntersecting;
          if (entry.isIntersecting) {
            if (releaseTimer !== null) window.clearTimeout(releaseTimer);
            releaseTimer = null;
            scheduleDraw();
            return;
          }
          controller?.abort();
          if (frame !== null) {
            window.cancelAnimationFrame(frame);
            frame = null;
          }
          drawGenerationRef.current += 1;
          if (releaseTimer !== null) window.clearTimeout(releaseTimer);
          releaseTimer = window.setTimeout(() => {
            releaseTimer = null;
            if (!intersecting) releaseCanvasBackingStore(canvasRef.current);
          }, THUMBNAIL_RELEASE_DELAY_MS);
        },
        { rootMargin: "240px 0px" },
      );
      observer.observe(canvas);
      return () => {
        disposed = true;
        observer.disconnect();
        controller?.abort();
        drawGenerationRef.current += 1;
        if (frame !== null) window.cancelAnimationFrame(frame);
        if (releaseTimer !== null) window.clearTimeout(releaseTimer);
      };
    }

    return () => {
      disposed = true;
      controller?.abort();
      drawGenerationRef.current += 1;
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (releaseTimer !== null) window.clearTimeout(releaseTimer);
    };
  }, [display.h, display.w, notebook?.pdfAssetId, objects, page, resourceRevision]);

  return (
    <div
      className="relative w-full overflow-hidden rounded-sm bg-paper"
      style={{ aspectRatio: `${display.w} / ${display.h}` }}
      aria-hidden
    >
      <canvas ref={bindCanvas} className="absolute inset-0 size-full" />
    </div>
  );
}

const EMPTY: CanvasObject[] = [];
