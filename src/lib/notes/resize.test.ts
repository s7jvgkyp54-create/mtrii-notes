import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapCanvasText } from "./render.ts";
import { canvasObjectArraysEqual, getResizeMode, resizeCanvasObjects } from "./resize.ts";
import type { CanvasObject, ImageObject, TextObject } from "./types.ts";

const measureContext = {
  measureText(text: string) {
    return { width: Array.from(text).length * 10 } as TextMetrics;
  },
};

function reflowText(object: TextObject): TextObject {
  const lineHeight = object.fontSize * (object.lineHeight ?? 1.4);
  return {
    ...object,
    h: Math.max(
      lineHeight,
      wrapCanvasText(measureContext, object.text, object.w).length * lineHeight,
    ),
  };
}

function text(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: "text",
    type: "text",
    x: 10,
    y: 20,
    w: 240,
    h: 30.8,
    text: "Ghi chú tiếng Việt ✨",
    fontSize: 22,
    color: "#123456",
    align: "right",
    fontFamily: "Be Vietnam Pro",
    fontWeight: "bold",
    fontStyle: "italic",
    textDecoration: "underline",
    backgroundColor: "#ffeeaa",
    backgroundOpacity: 0.6,
    lineHeight: 1.4,
    ...overrides,
  };
}

function image(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id: "image",
    type: "image",
    x: 25,
    y: 30,
    w: 400,
    h: 20,
    rotation: 0,
    assetId: "asset-original",
    ...overrides,
  };
}

function resize(
  objects: CanvasObject[],
  handle: "tl" | "tr" | "bl" | "br" | "t" | "b" | "l" | "r",
  delta: { x: number; y: number },
  shiftKey = false,
) {
  const first = objects[0]!;
  const box =
    first.type === "shape" || first.type === "stroke"
      ? { x: 0, y: 0, w: 1, h: 1 }
      : { x: first.x, y: first.y, w: first.w, h: first.h };
  return resizeCanvasObjects({ objects, box, handle, delta, shiftKey, reflowText });
}

describe("notes resize geometry", () => {
  it("widens a 240 × 30.8 text box without scaling its 22 px font", () => {
    const original = text();
    const result = resize([original], "r", { x: 100, y: 90 });
    const resized = result.objects[0] as TextObject;

    assert.equal(result.mode, "text-reflow");
    assert.equal(resized.x, original.x);
    assert.equal(resized.w, 340);
    assert.ok(Math.abs(resized.h - 30.8) < 1e-8);
    assert.equal(resized.fontSize, 22);
    assert.equal(resized.fontFamily, original.fontFamily);
    assert.equal(resized.fontWeight, original.fontWeight);
    assert.equal(resized.fontStyle, original.fontStyle);
    assert.equal(resized.textDecoration, original.textDecoration);
    assert.equal(resized.align, original.align);
    assert.equal(resized.backgroundColor, original.backgroundColor);
  });

  it("keeps the right edge anchored when the left text handle is dragged", () => {
    const original = text();
    const resized = resize([original], "l", { x: 100, y: -80 }).objects[0] as TextObject;

    assert.equal(resized.x, 110);
    assert.equal(resized.w, 140);
    assert.equal(resized.x + resized.w, original.x + original.w);
    assert.equal(resized.y, original.y);
    assert.equal(resized.fontSize, original.fontSize);
  });

  it("reflows height in both directions while preserving blank lines and content", () => {
    const value = "Đầu dòng\n\nhttps://example.com/duong-dan-rat-dai/👨‍👩‍👧‍👦\n";
    const original = reflowText(text({ text: value }));
    const narrow = resize([original], "r", { x: -140, y: 0 }).objects[0] as TextObject;
    const wide = resize([narrow], "r", { x: 140, y: 0 }).objects[0] as TextObject;

    assert.ok(narrow.h > original.h);
    assert.equal(wide.h, original.h);
    assert.equal(narrow.text, value);
    assert.equal(wide.text, value);
    assert.equal(narrow.fontSize, original.fontSize);
  });

  it("does not force an old text box below 40 px tall up to 40", () => {
    const original = text({ h: 22 });
    const resized = resize([original], "r", { x: 20, y: 200 }).objects[0] as TextObject;

    assert.ok(Math.abs(resized.h - 30.8) < 1e-8);
    assert.notEqual(resized.h, 40);
    assert.equal(resized.fontSize, 22);
  });

  it("keeps a 400 × 20 image proportional when a corner is dragged", () => {
    const original = image();
    const result = resize([original], "br", { x: 200, y: 10 });
    const resized = result.objects[0] as ImageObject;

    assert.equal(result.mode, "uniform-scale");
    assert.equal(resized.w, 600);
    assert.equal(resized.h, 30);
    assert.equal(resized.w / resized.h, 20);
    assert.equal(resized.assetId, original.assetId);
    assert.equal(resized.rotation, original.rotation);
  });

  it("uses one common minimum scale for thin images instead of clamping each axis", () => {
    const original = image();
    const resized = resize([original], "br", { x: -360, y: -18 }).objects[0] as ImageObject;

    assert.equal(resized.w, 240);
    assert.equal(resized.h, 12);
    assert.equal(resized.w / resized.h, 20);
  });

  it("does not enlarge or distort a legacy image that is already below the minimum", () => {
    const original = image({ w: 8, h: 4 });
    const result = resize([original], "br", { x: -4, y: -2 });

    assert.equal(canvasObjectArraysEqual(result.objects, [original]), true);
  });

  it("keeps rotated images proportional even when Shift requests free scaling", () => {
    const original = image({ w: 100, h: 20, rotation: 90 });
    const result = resize([original], "br", { x: 50, y: 10 }, true);
    const resized = result.objects[0] as ImageObject;

    assert.equal(getResizeMode([original], "br", true), "uniform-scale");
    assert.equal(resized.w, 150);
    assert.equal(resized.h, 30);
    assert.equal(resized.rotation, 90);
    assert.equal(resized.assetId, original.assetId);
  });

  it("changes only the dragged axis for an unrotated image edge", () => {
    const original = image();
    const resized = resize([original], "r", { x: 80, y: 500 }).objects[0] as ImageObject;

    assert.equal(resized.w, 480);
    assert.equal(resized.h, 20);
    assert.equal(resized.x, original.x);
    assert.equal(resized.y, original.y);
  });

  it("keeps deliberate Shift-corner group font scaling explicit", () => {
    const originalText = text({ x: 0, y: 0, w: 200, h: 60 });
    const originalImage = image({ x: 0, y: 80, w: 400, h: 20 });
    const result = resizeCanvasObjects({
      objects: [originalText, originalImage],
      box: { x: 0, y: 0, w: 400, h: 100 },
      handle: "br",
      delta: { x: 200, y: 100 },
      shiftKey: true,
      reflowText,
    });
    const resizedText = result.objects[0] as TextObject;

    assert.equal(result.mode, "free-scale");
    assert.equal(resizedText.fontSize, 44);
    assert.equal(resizedText.fontFamily, originalText.fontFamily);
    assert.equal(resizedText.fontWeight, originalText.fontWeight);
    assert.equal(resizedText.fontStyle, originalText.fontStyle);
  });

  it("returns the original values after a drag comes back to its starting point", () => {
    const original = text();
    const result = resize([original], "r", { x: 0, y: 100 });

    assert.equal(canvasObjectArraysEqual(result.objects, [original]), true);
  });
});
