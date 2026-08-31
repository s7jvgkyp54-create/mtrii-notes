import type { CanvasObject, ImageObject, PageRecord, ShapeObject, StrokeObject, StrokePoint, TextObject } from "./types";

export type Pt = { x: number; y: number };

export function dist(a: Pt, b: Pt) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function displaySize(page: PageRecord) {
  if (page.rotation === 90 || page.rotation === 270) {
    return { w: page.height, h: page.width };
  }
  return { w: page.width, h: page.height };
}

/** Map display-space points (after rotation) back to page coordinates. */
export function displayToPage(dx: number, dy: number, page: PageRecord): Pt {
  const { width: w, height: h, rotation } = page;
  switch (rotation) {
    case 90:
      return { x: dy, y: h - dx };
    case 180:
      return { x: w - dx, y: h - dy };
    case 270:
      return { x: w - dy, y: dx };
    default:
      return { x: dx, y: dy };
  }
}

export function applyPageRotation(
  ctx: CanvasRenderingContext2D,
  page: PageRecord,
  zoom: number,
  dpr: number,
) {
  const s = dpr * zoom;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  const { width: w, height: h, rotation } = page;
  if (rotation === 90) ctx.transform(0, 1, -1, 0, h, 0);
  else if (rotation === 180) ctx.transform(-1, 0, 0, -1, w, h);
  else if (rotation === 270) ctx.transform(0, -1, 1, 0, 0, w);
}

export function pointToSeg(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function strokeMinDist(p: Pt, pts: StrokePoint[]) {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return dist(p, pts[0]!);
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) {
    m = Math.min(m, pointToSeg(p, pts[i - 1]!, pts[i]!));
  }
  return m;
}

export function pointInPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    const hit =
      a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function objectBBox(o: CanvasObject): BBox {
  if (o.type === "stroke") {
    const xs = o.points.map((p) => p.x);
    const ys = o.points.map((p) => p.y);
    const pad = o.width;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return {
      x: minX,
      y: minY,
      w: Math.max(...xs) - minX + pad,
      h: Math.max(...ys) - minY + pad,
    };
  }
  if (o.type === "text" || o.type === "image") {
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
  const x = Math.min(o.x1, o.x2);
  const y = Math.min(o.y1, o.y2);
  return { x, y, w: Math.abs(o.x2 - o.x1), h: Math.abs(o.y2 - o.y1) };
}

export function unionBBox(objects: CanvasObject[]): BBox | null {
  if (!objects.length) return null;
  let x = Infinity,
    y = Infinity,
    r = -Infinity,
    b = -Infinity;
  for (const o of objects) {
    const box = objectBBox(o);
    x = Math.min(x, box.x);
    y = Math.min(y, box.y);
    r = Math.max(r, box.x + box.w);
    b = Math.max(b, box.y + box.h);
  }
  return { x, y, w: r - x, h: b - y };
}

export function hitTest(o: CanvasObject, p: Pt, slop = 4): boolean {
  if (o.type === "stroke") {
    return strokeMinDist(p, o.points) <= o.width / 2 + slop;
  }
  if (o.type === "text" || o.type === "image") {
    return p.x >= o.x && p.x <= o.x + o.w && p.y >= o.y && p.y <= o.y + o.h;
  }
  if (o.shape === "line" || o.shape === "arrow") {
    return pointToSeg(p, { x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }) <= o.width + slop;
  }
  const box = objectBBox(o);
  if (o.shape === "ellipse") {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const rx = box.w / 2 || 1;
    const ry = box.h / 2 || 1;
    const v = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2;
    return v <= 1.15;
  }
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

export function objectInLasso(o: CanvasObject, poly: Pt[]) {
  if (o.type === "stroke") {
    if (o.points.length === 0) return false;
    const inside = o.points.filter((pt) => pointInPoly(pt, poly)).length;
    return inside >= Math.max(1, Math.floor(o.points.length * 0.45));
  }
  const box = objectBBox(o);
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  return pointInPoly(c, poly);
}

export function erasePartial(stroke: StrokeObject, p: Pt, radius: number): StrokeObject[] {
  const segs: StrokePoint[][] = [[]];
  for (const pt of stroke.points) {
    if (dist(pt, p) <= radius + stroke.width / 2) {
      if (segs[segs.length - 1]!.length) segs.push([]);
    } else {
      segs[segs.length - 1]!.push(pt);
    }
  }
  return segs
    .filter((s) => s.length > 0)
    .map((points) => ({
      ...stroke,
      id: crypto.randomUUID(),
      points,
    }));
}

export function translateObject(o: CanvasObject, dx: number, dy: number): CanvasObject {
  if (o.type === "stroke") {
    return { ...o, points: o.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
  }
  if (o.type === "text" || o.type === "image") {
    return { ...o, x: o.x + dx, y: o.y + dy };
  }
  return { ...o, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy };
}

export function scaleObjects(objects: CanvasObject[], box: BBox, nx: number, ny: number, nw: number, nh: number) {
  const sx = box.w === 0 ? 1 : nw / box.w;
  const sy = box.h === 0 ? 1 : nh / box.h;
  return objects.map((o) => mapPoints(o, (x, y) => ({ x: nx + (x - box.x) * sx, y: ny + (y - box.y) * sy })));
}

export function rotateObjects(objects: CanvasObject[], cx: number, cy: number, rad: number) {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return objects.map((o) =>
    mapPoints(o, (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    }),
  );
}

function mapPoints(o: CanvasObject, fn: (x: number, y: number) => Pt): CanvasObject {
  if (o.type === "stroke") {
    return { ...o, points: o.points.map((p) => ({ ...p, ...fn(p.x, p.y) })) };
  }
  if (o.type === "text") {
    const tl = fn(o.x, o.y);
    const br = fn(o.x + o.w, o.y + o.h);
    return textFromCorners(o, tl, br);
  }
  if (o.type === "image") {
    const tl = fn(o.x, o.y);
    const br = fn(o.x + o.w, o.y + o.h);
    return {
      ...o,
      x: Math.min(tl.x, br.x),
      y: Math.min(tl.y, br.y),
      w: Math.abs(br.x - tl.x),
      h: Math.abs(br.y - tl.y),
    } satisfies ImageObject;
  }
  const a = fn(o.x1, o.y1);
  const b = fn(o.x2, o.y2);
  return { ...o, x1: a.x, y1: a.y, x2: b.x, y2: b.y } satisfies ShapeObject;
}

function textFromCorners(o: TextObject, a: Pt, b: Pt): TextObject {
  return {
    ...o,
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

export function recolor(o: CanvasObject, color: string): CanvasObject {
  if (o.type === "stroke" || o.type === "shape" || o.type === "text") return { ...o, color };
  return o;
}

export function cloneObject(o: CanvasObject, dx = 16, dy = 16): CanvasObject {
  const moved = translateObject(o, dx, dy);
  return { ...moved, id: crypto.randomUUID() };
}

export function snapShape(shape: ShapeObject["shape"], x1: number, y1: number, x2: number, y2: number) {
  if (shape === "line" || shape === "arrow") {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const ang = Math.atan2(dy, dx);
    const snapped = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return { x1, y1, x2: x1 + Math.cos(snapped) * len, y2: y1 + Math.sin(snapped) * len };
  }
  const side = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  const sx = x2 >= x1 ? 1 : -1;
  const sy = y2 >= y1 ? 1 : -1;
  return { x1, y1, x2: x1 + side * sx, y2: y1 + side * sy };
}
