import { PDFDocument } from "pdf-lib";
import type { Notebook, PageRecord, CanvasObject } from "./types";
import { drawPaper, drawShape, drawStroke, drawText } from "./render";
import { loadAssetImage } from "./image-cache";

export async function exportRasterPdf(
  opts: {
    notebook: Notebook;
    pages: PageRecord[];
    objects: Record<string, CanvasObject[]>;
  },
  dpi: 150 | 200 | 300,
  onProgress?: (progress: number) => void,
): Promise<Uint8Array> {
  const { notebook, pages, objects } = opts;
  const scale = dpi / 72; // PDF uses 72 points per inch

  // Create an empty PDF
  const pdf = await PDFDocument.create();
  
  // If notebook has a PDF background, we need to extract pages from it as images
  let pdfDocForRender: import("pdfjs-dist").PDFDocumentProxy | null = null;
  if (notebook.pdfAssetId) {
    const { loadStoredPdfDocument } = await import("./pdf");
    pdfDocForRender = await loadStoredPdfDocument(notebook.pdfAssetId);
  }

  const totalPages = pages.length;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const pageObjects = objects[page.id] || [];

    const width = page.width * scale;
    const height = page.height * scale;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2d context for OffscreenCanvas");

    ctx.scale(scale, scale);

    // 1. Draw Paper or PDF Background
    if (pdfDocForRender) {
      const pageIndex = Math.min(i + 1, pdfDocForRender.numPages);
      const pdfPage = await pdfDocForRender.getPage(pageIndex);
      const viewport = pdfPage.getViewport({ scale: scale }); 
      const pdfCanvas = new OffscreenCanvas(viewport.width, viewport.height);
      const pdfCtx = pdfCanvas.getContext("2d")!;
      await pdfPage.render({
        canvasContext: pdfCtx,
        viewport,
      } as any).promise;
      ctx.drawImage(pdfCanvas, 0, 0, page.width, page.height);
    } else {
      drawPaper(ctx as unknown as CanvasRenderingContext2D, page.width, page.height, notebook.defaultPaper);
    }

    // 2. Draw Objects
    const sorted = [...pageObjects].sort((a, b) => {
      // Sort: strokes(highlighter first) -> shapes -> images -> text
      const order = { highlighter: 0, pen: 1, shape: 2, image: 3, text: 4 } as Record<string, number>;
      const getOrder = (o: CanvasObject) => {
        if (o.type === "stroke") return o.tool === "highlighter" ? 0 : 1;
        if (o.type === "shape") return 2;
        if (o.type === "image") return 3;
        if (o.type === "text") return 4;
        return 5;
      };
      return getOrder(a) - getOrder(b);
    });

    for (const o of sorted) {
      if (o.type === "stroke") {
        drawStroke(ctx as unknown as CanvasRenderingContext2D, o);
      } else if (o.type === "shape") {
        drawShape(ctx as unknown as CanvasRenderingContext2D, o);
      } else if (o.type === "text") {
        drawText(ctx as unknown as CanvasRenderingContext2D, o);
      } else if (o.type === "image") {
        try {
          const img = await loadAssetImage(o.assetId);
          ctx.save();
          ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
          ctx.rotate(o.rotation || 0);
          ctx.drawImage(img, -o.w / 2, -o.h / 2, o.w, o.h);
          ctx.restore();
        } catch (e) {
          console.error("Failed to load image for export", e);
        }
      }
    }

    // 3. Add to PDF
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const arrayBuffer = await blob.arrayBuffer();
    const pdfImage = await pdf.embedJpg(arrayBuffer);
    
    const newPage = pdf.addPage([page.width, page.height]);
    newPage.drawImage(pdfImage, {
      x: 0,
      y: 0,
      width: page.width,
      height: page.height,
    });

    if (onProgress) {
      onProgress(Math.round(((i + 1) / totalPages) * 100));
    }
  }

  return await pdf.save();
}
