import type { TextObject } from "@/lib/notes/types";

let measureCanvas: HTMLCanvasElement | null = null;
let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx() {
  if (!measureCanvas) {
    measureCanvas = document.createElement("canvas");
    measureCtx = measureCanvas.getContext("2d");
  }
  return measureCtx;
}

export function measureTextHeight(
  text: string,
  width: number,
  fontSize: number,
  fontFamily: string = "Be Vietnam Pro",
  fontWeight: string = "normal",
  fontStyle: string = "normal",
  lineHeightRatio: number = 1.4,
): number {
  if (!text) return fontSize * 1.5;

  const ctx = getMeasureCtx();
  if (!ctx) return fontSize * 1.5;

  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;

  const lines = text.split("\n");
  let totalLines = 0;

  for (const line of lines) {
    if (line === "") {
      totalLines++;
      continue;
    }
    
    let currentLine = "";
    const words = line.split(" ");
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine = currentLine + (currentLine ? " " : "") + word;
      const metrics = ctx.measureText(testLine);
      const testWidth = metrics.width;
      
      if (testWidth > width && i > 0) {
        totalLines++;
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    totalLines++;
  }

  // Calculate total height based on line height ratio
  // Usually line height in CSS is fontSize * lineHeightRatio
  const computedLineHeight = fontSize * lineHeightRatio;
  // Add a small buffer (e.g., 0.5 * fontSize) to match textarea's native padding/buffer
  return Math.max(fontSize * 1.5, totalLines * computedLineHeight + fontSize * 0.2);
}

export function autoResizeTextObject(object: Extract<TextObject, { type: "text" }>): Extract<TextObject, { type: "text" }> {
  const newHeight = measureTextHeight(
    object.text,
    object.w,
    object.fontSize,
    object.fontFamily,
    object.fontWeight,
    object.fontStyle,
    object.lineHeight || 1.4
  );
  
  return { ...object, h: newHeight };
}
