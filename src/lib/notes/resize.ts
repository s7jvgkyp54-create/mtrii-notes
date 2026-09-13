import { objectBBox, type BBox, type Pt } from "./geometry.ts";
import type { CanvasObject, TextObject } from "./types.ts";

export type ResizeHandle = "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r";

export type ResizeMode = "text-reflow" | "uniform-scale" | "free-scale";

export interface ResizeTransform {
  origin: Pt;
  scaleX: number;
  scaleY: number;
}

export interface ResizeResult {
  changed: boolean;
  mode: ResizeMode;
  objects: CanvasObject[];
  transform: ResizeTransform;
}

interface ResizeObjectsInput {
  objects: CanvasObject[];
  box: BBox;
  handle: ResizeHandle;
  delta: Pt;
  shiftKey: boolean;
  reflowText: (object: TextObject) => TextObject;
}

const MIN_TEXT_WIDTH = 40;
const MIN_OBJECT_EXTENT = 12;

function handleMovesX(handle: ResizeHandle) {
  return handle.includes("l") || handle.includes("r");
}

function handleMovesY(handle: ResizeHandle) {
  return handle.includes("t") || handle.includes("b");
}

function resizeOrigin(box: BBox, handle: ResizeHandle): Pt {
  return {
    x: handle.includes("l") ? box.x + box.w : box.x,
    y: handle.includes("t") ? box.y + box.h : box.y,
  };
}

/**
 * Existing objects smaller than a modern minimum are allowed to keep their
 * size. The minimum only prevents a resize from making them smaller still.
 */
function minimumScaleForExtent(extent: number, minimum = MIN_OBJECT_EXTENT) {
  if (!Number.isFinite(extent) || extent <= 0) return 1;
  return Math.min(1, minimum / extent);
}

function minimumAxisScale(objects: CanvasObject[], box: BBox, axis: "x" | "y") {
  let minimum = minimumScaleForExtent(axis === "x" ? box.w : box.h);
  for (const object of objects) {
    if (object.type === "text" || object.type === "image") {
      minimum = Math.max(minimum, minimumScaleForExtent(axis === "x" ? object.w : object.h));
      continue;
    }
    const bounds = objectBBox(object);
    const extent = axis === "x" ? bounds.w : bounds.h;
    if (extent > 0) minimum = Math.max(minimum, minimumScaleForExtent(extent));
  }
  return minimum;
}

function minimumUniformScale(objects: CanvasObject[], box: BBox) {
  let minimum = Math.max(minimumAxisScale(objects, box, "x"), minimumAxisScale(objects, box, "y"));
  for (const object of objects) {
    if (object.type === "text") {
      minimum = Math.max(minimum, minimumScaleForExtent(object.fontSize, 8));
    }
  }
  return minimum;
}

function safeScale(target: number, original: number) {
  if (!Number.isFinite(target) || !Number.isFinite(original) || original <= 0) return 1;
  return target / original;
}

function clampScale(scale: number, minimum: number) {
  if (!Number.isFinite(scale)) return 1;
  return Math.max(minimum, scale);
}

export function getResizeMode(
  objects: CanvasObject[],
  handle: ResizeHandle,
  shiftKey: boolean,
): ResizeMode {
  if (objects.length === 1 && objects[0]?.type === "text" && (handle === "l" || handle === "r")) {
    return "text-reflow";
  }

  const hasRotatedImage = objects.some(
    (object) => object.type === "image" && object.rotation % 180 !== 0,
  );
  if (handle.length === 2 && (!shiftKey || hasRotatedImage)) return "uniform-scale";
  return "free-scale";
}

export function calculateResizeTransform(
  objects: CanvasObject[],
  box: BBox,
  handle: ResizeHandle,
  delta: Pt,
  mode: Exclude<ResizeMode, "text-reflow">,
): ResizeTransform {
  const origin = resizeOrigin(box, handle);

  if (mode === "uniform-scale") {
    const diagonal = {
      x: handle.includes("l") ? -box.w : box.w,
      y: handle.includes("t") ? -box.h : box.h,
    };
    const denominator = diagonal.x ** 2 + diagonal.y ** 2;
    const rawScale =
      denominator > 0 ? 1 + (delta.x * diagonal.x + delta.y * diagonal.y) / denominator : 1;
    const scale = clampScale(rawScale, minimumUniformScale(objects, box));
    return { origin, scaleX: scale, scaleY: scale };
  }

  const targetWidth = handle.includes("l")
    ? box.w - delta.x
    : handle.includes("r")
      ? box.w + delta.x
      : box.w;
  const targetHeight = handle.includes("t")
    ? box.h - delta.y
    : handle.includes("b")
      ? box.h + delta.y
      : box.h;

  const scaleX = handleMovesX(handle)
    ? clampScale(safeScale(targetWidth, box.w), minimumAxisScale(objects, box, "x"))
    : 1;
  const scaleY = handleMovesY(handle)
    ? clampScale(safeScale(targetHeight, box.h), minimumAxisScale(objects, box, "y"))
    : 1;
  return { origin, scaleX, scaleY };
}

function scalePointFromOrigin(point: Pt, transform: ResizeTransform): Pt {
  return {
    x: transform.origin.x + (point.x - transform.origin.x) * transform.scaleX,
    y: transform.origin.y + (point.y - transform.origin.y) * transform.scaleY,
  };
}

export function scaleObjectFromResize(
  object: CanvasObject,
  transform: ResizeTransform,
  mode: Exclude<ResizeMode, "text-reflow">,
  reflowText: (object: TextObject) => TextObject,
  scaleTextFont = false,
): CanvasObject {
  const { scaleX, scaleY } = transform;
  if (scaleX === 1 && scaleY === 1) return object;
  const strokeScale = mode === "uniform-scale" ? scaleX : Math.max(scaleX, scaleY);

  if (object.type === "stroke") {
    return {
      ...object,
      width: Math.max(0.35, object.width * strokeScale),
      points: object.points.map((point) => ({
        ...point,
        ...scalePointFromOrigin(point, transform),
      })),
    };
  }

  if (object.type === "shape") {
    const start = scalePointFromOrigin({ x: object.x1, y: object.y1 }, transform);
    const end = scalePointFromOrigin({ x: object.x2, y: object.y2 }, transform);
    return {
      ...object,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      width: Math.max(0.35, object.width * strokeScale),
    };
  }

  const position = scalePointFromOrigin({ x: object.x, y: object.y }, transform);
  if (object.type === "image") {
    return {
      ...object,
      x: position.x,
      y: position.y,
      w: object.w * scaleX,
      h: object.h * scaleY,
    };
  }

  const scaled: TextObject = {
    ...object,
    x: position.x,
    y: position.y,
    w: object.w * scaleX,
    h: object.h * scaleY,
    ...(mode === "uniform-scale" || scaleTextFont
      ? {
          fontSize:
            object.fontSize * (mode === "uniform-scale" ? scaleX : Math.max(scaleX, scaleY)),
        }
      : {}),
  };
  // A free horizontal edge changes the text column, so its height belongs to
  // the shared text layout engine. Uniform scaling is a deliberate object/font
  // scale and retains the same line breaks and proportional height.
  return mode === "free-scale" && !scaleTextFont && scaleX !== 1 ? reflowText(scaled) : scaled;
}

function resizeSingleTextEdge(
  object: TextObject,
  handle: "l" | "r",
  deltaX: number,
  reflowText: (object: TextObject) => TextObject,
) {
  const minimumWidth = Math.min(object.w, MIN_TEXT_WIDTH);
  const width = Math.max(minimumWidth, handle === "l" ? object.w - deltaX : object.w + deltaX);
  if (width === object.w) return object;
  const x = handle === "l" ? object.x + object.w - width : object.x;
  const resized = reflowText({ ...object, x, w: width });
  // Avoid turning a mathematically unchanged 30.8 into
  // 30.799999999999997, which would create a pointless save/Undo entry.
  return Math.abs(resized.h - object.h) < 1e-8 ? { ...resized, h: object.h } : resized;
}

export function resizeCanvasObjects({
  objects,
  box,
  handle,
  delta,
  shiftKey,
  reflowText,
}: ResizeObjectsInput): ResizeResult {
  const mode = getResizeMode(objects, handle, shiftKey);
  if (mode === "text-reflow") {
    const object = objects[0] as TextObject;
    const resized = resizeSingleTextEdge(object, handle as "l" | "r", delta.x, reflowText);
    return {
      changed: resized !== object,
      mode,
      objects: [resized],
      transform: {
        origin: resizeOrigin(box, handle),
        scaleX: safeScale(resized.w, object.w),
        scaleY: 1,
      },
    };
  }

  const transform = calculateResizeTransform(objects, box, handle, delta, mode);
  const scaleTextFont = handle.length === 2;
  return {
    changed: transform.scaleX !== 1 || transform.scaleY !== 1,
    mode,
    transform,
    objects: objects.map((object) =>
      scaleObjectFromResize(object, transform, mode, reflowText, scaleTextFont),
    ),
  };
}

export function canvasObjectArraysEqual(left: CanvasObject[], right: CanvasObject[]) {
  return (
    left.length === right.length &&
    left.every((object, index) => {
      const candidate = right[index];
      return candidate !== undefined && JSON.stringify(object) === JSON.stringify(candidate);
    })
  );
}
