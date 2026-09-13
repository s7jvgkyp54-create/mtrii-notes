import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PAGE_CANVAS_PIXELS,
  pageCanvasDpr,
  releaseCanvasBackingStore,
} from "./canvas-memory.ts";

test("page canvas density respects device density and the backing-pixel budget", () => {
  assert.equal(pageCanvasDpr(500, 800, 2), 2);
  const dpr = pageCanvasDpr(2_100, 3_000, 2);
  assert(dpr < 1);
  assert(2_100 * dpr * 3_000 * dpr <= MAX_PAGE_CANVAS_PIXELS + 1);
});

test("huge and extreme-aspect CSS pages never exceed the rounded backing-pixel cap", () => {
  for (const [width, height] of [
    [100_000_000, 100],
    [1_000_000_000_000, 1],
    [Number.MAX_VALUE, 2],
  ] as const) {
    const dpr = pageCanvasDpr(width, height, 2);
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    assert(
      backingWidth * backingHeight <= MAX_PAGE_CANVAS_PIXELS,
      `${width}x${height} at DPR ${dpr} allocated ${backingWidth * backingHeight} pixels`,
    );
  }
});

test("canvas release is idempotent and drops its backing dimensions", () => {
  const canvas = { width: 4_000, height: 3_000 };
  releaseCanvasBackingStore(canvas);
  releaseCanvasBackingStore(canvas);
  assert.deepEqual(canvas, { width: 1, height: 1 });
});
