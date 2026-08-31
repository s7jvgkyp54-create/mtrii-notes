import { useEffect, useRef } from "react";
import type { CanvasObject, PageRecord } from "@/lib/notes/types";
import { useNotesStore } from "@/lib/notes/store";
import { applyPageRotation, displaySize } from "@/lib/notes/geometry";
import { drawPaper, drawShape, drawStroke, drawText } from "@/lib/notes/render";
import { getAsset, objectUrlFor } from "@/lib/notes/db";
import { loadPdfDocument, renderPdfPageBitmap } from "@/lib/notes/pdf";

const imageCache = new Map<string, HTMLImageElement>();

async function imageFor(id: string) {
  const cached = imageCache.get(id);
  if (cached) return cached;
  const asset = await getAsset(id);
  if (!asset) return null;
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      imageCache.set(id, image);
      resolve(image);
    };
    image.onerror = () => resolve(null);
    image.src = objectUrlFor(id, asset.blob);
  });
}

export function PageThumbnail({ page }: { page: PageRecord }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const objects = useNotesStore((state) => state.objectsByPage[page.id] ?? EMPTY);
  const notebook = useNotesStore((state) =>
    state.notebooks.find((item) => item.id === page.notebookId),
  );

  useEffect(() => {
    let cancelled = false;
    async function draw() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const display = displaySize(page);
      const scale = 144 / display.w;
      canvas.width = Math.max(1, Math.round(display.w * scale));
      canvas.height = Math.max(1, Math.round(display.h * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      applyPageRotation(context, page, scale, 1);
      drawPaper(context, page.width, page.height, page.paper);

      if (notebook?.pdfAssetId && page.pdfPage) {
        try {
          const asset = await getAsset(notebook.pdfAssetId);
          if (asset) {
            const document = await loadPdfDocument(
              notebook.pdfAssetId,
              await asset.blob.arrayBuffer(),
            );
            const bitmap = await renderPdfPageBitmap(
              document,
              page.pdfPage,
              scale,
              page.rotation,
              notebook.pdfAssetId,
            );
            if (cancelled) return;
            context.setTransform(1, 0, 0, 1, 0, 0);
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            applyPageRotation(context, page, scale, 1);
          }
        } catch {
          // Trang giấy và lớp ghi chú vẫn hiển thị nếu PDF tạm thời chưa đọc được.
        }
      }

      for (const object of objects) {
        if (object.type === "stroke") drawStroke(context, object);
        else if (object.type === "shape") drawShape(context, object);
        else if (object.type === "text") drawText(context, object);
        else await drawImage(context, object);
      }
    }
    void draw();
    return () => {
      cancelled = true;
    };
  }, [notebook?.pdfAssetId, objects, page]);

  return <canvas ref={canvasRef} className="block h-auto w-full rounded-sm bg-paper" />;
}

async function drawImage(
  context: CanvasRenderingContext2D,
  object: Extract<CanvasObject, { type: "image" }>,
) {
  const image = await imageFor(object.assetId);
  if (!image) return;
  context.save();
  context.translate(object.x + object.w / 2, object.y + object.h / 2);
  context.rotate((object.rotation * Math.PI) / 180);
  context.drawImage(image, -object.w / 2, -object.h / 2, object.w, object.h);
  context.restore();
}

const EMPTY: CanvasObject[] = [];
