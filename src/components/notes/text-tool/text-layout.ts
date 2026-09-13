import type { TextObject } from "@/lib/notes/types";
import { wrapCanvasText } from "../../../lib/notes/render.ts";

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx() {
  if (!measureCtx && typeof document !== "undefined") {
    measureCtx = document.createElement("canvas").getContext("2d");
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
  const lineHeight = fontSize * lineHeightRatio;
  const ctx = getMeasureCtx();
  if (!ctx) return Math.max(lineHeight, text.split("\n").length * lineHeight);

  ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px "${fontFamily}", "Segoe UI", sans-serif`;
  // Rendering, selection bounds and editing all use identical wrapping. In
  // particular a long URL must increase the box height instead of painting
  // beyond its hit area and covering the next note.
  return Math.max(lineHeight, wrapCanvasText(ctx, text, width).length * lineHeight);
}

export function autoResizeTextObject(object: TextObject): TextObject {
  return {
    ...object,
    h: measureTextHeight(
      object.text,
      object.w,
      object.fontSize,
      object.fontFamily,
      object.fontWeight,
      object.fontStyle,
      object.lineHeight,
    ),
  };
}
