type ReleasableCanvas = Pick<HTMLCanvasElement, "width" | "height">;

// One visible A4 page at maximum zoom can otherwise allocate hundreds of MiB
// across its base/static/live layers. This keeps one layer near 24 MiB and, for
// A4 at the supported maximum zoom, remains close to one backing pixel per CSS
// pixel instead of spending memory on invisible supersampling.
export const MAX_PAGE_CANVAS_PIXELS = 6_000_000;

export function pageCanvasDpr(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
) {
  const width = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 1;
  const height = Number.isFinite(cssHeight) && cssHeight > 0 ? cssHeight : 1;
  const requestedDpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cssPixels = width * height;
  const areaBudgetDpr = Number.isFinite(cssPixels)
    ? Math.sqrt(MAX_PAGE_CANVAS_PIXELS / Math.max(1, cssPixels))
    : 0;
  // Each backing dimension is rounded and then clamped to at least one by the
  // canvas owner. The per-axis bound covers extreme aspect ratios where the
  // continuous area formula would assume a sub-pixel short edge.
  const axisBudgetDpr = MAX_PAGE_CANVAS_PIXELS / Math.max(width, height);
  let upper = Math.max(0, Math.min(requestedDpr, 2, areaBudgetDpr, axisBudgetDpr));

  const fitsRoundedBackingStore = (dpr: number) => {
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    return (
      Number.isFinite(backingWidth) &&
      Number.isFinite(backingHeight) &&
      backingWidth <= Math.floor(MAX_PAGE_CANVAS_PIXELS / backingHeight)
    );
  };

  if (fitsRoundedBackingStore(upper)) return upper;

  // Rounding can put an otherwise valid continuous-area result a handful of
  // pixels over budget. Find the greatest safe density without introducing a
  // minimum floor that would break the hard cap on very large pages.
  let lower = 0;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    if (fitsRoundedBackingStore(midpoint)) lower = midpoint;
    else upper = midpoint;
  }
  return lower;
}

/**
 * Drop the bitmap backing store while keeping a valid, reusable canvas node.
 * This only releases transient pixels; page/object data remains in Notes storage.
 */
export function releaseCanvasBackingStore(canvas: ReleasableCanvas | null | undefined) {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
}
