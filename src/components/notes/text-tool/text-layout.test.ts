import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wrapCanvasText } from "../../../lib/notes/render.ts";
import { autoResizeTextObject, measureTextHeight } from "./text-layout.ts";

const ctx = {
  measureText(text: string) {
    return { width: Array.from(text).length * 10 } as TextMetrics;
  },
};

describe("canvas text layout", () => {
  it("keeps explicit empty lines and wraps long pasted URLs", () => {
    assert.deepEqual(wrapCanvasText(ctx, "abcdEF\n\nxyz\n", 30), ["abc", "dEF", "", "xyz", ""]);
  });

  it("preserves indentation and repeated internal spaces", () => {
    assert.deepEqual(wrapCanvasText(ctx, "  note   image", 200), ["  note   image"]);
    assert.deepEqual(wrapCanvasText(ctx, "note   image", 70), ["note", "image"]);
  });

  it("keeps whitespace-only paragraphs as empty lines", () => {
    assert.deepEqual(wrapCanvasText(ctx, "first\n   \nlast", 200), ["first", "", "last"]);
  });

  it("never separates Vietnamese combining marks or emoji families", () => {
    const accent = "a\u0306\u0301";
    const family = "👨‍👩‍👧‍👦";
    assert.deepEqual(wrapCanvasText(ctx, accent + accent, 10), [accent, accent]);
    assert.deepEqual(wrapCanvasText(ctx, family + family, 10), [family, family]);
  });

  it("normalizes pasted CRLF and prevents a zero-width loop", () => {
    assert.deepEqual(wrapCanvasText(ctx, "a\r\nb", 0), ["a", "b"]);
  });

  it("uses rendered line count for bounds and does not change text or width", () => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { createElement: () => ({ getContext: () => ctx }) },
    });
    try {
      assert.equal(measureTextHeight("abcdefghij", 30, 20), 112);
      const object = {
        id: "text-layout-test",
        type: "text" as const,
        text: "  abcdef\n",
        x: 10,
        y: 20,
        w: 30,
        h: 1,
        fontSize: 20,
        color: "#000000",
        align: "left" as const,
      };
      const resized = autoResizeTextObject(object);
      assert.equal(resized.h, wrapCanvasText(ctx, object.text, object.w).length * 28);
      assert.equal(resized.text, object.text);
      assert.equal(resized.w, object.w);
      assert.equal(object.h, 1);
    } finally {
      Reflect.deleteProperty(globalThis, "document");
    }
  });
});
