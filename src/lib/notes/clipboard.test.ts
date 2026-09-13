import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { afterEach, beforeEach } from "node:test";

// Production source uses bundler-style extensionless imports. Teach the
// direct Node test command how to resolve those imports without changing the
// application module solely for the test runner.
const moduleHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Let Node produce its normal resolution error when no TypeScript
        // sibling exists either.
      }
    }
    return nextResolve(specifier, context);
  },
});
const {
  NOTES_CLIPBOARD_MIME,
  canDeleteCutSource,
  canvasPasteSource,
  cloneNotesClipboardObjects,
  createNotesClipboardPayload,
  parseNotesClipboardPayload,
  readNotesClipboardData,
  resetNotesClipboardForTests,
  serializeNotesClipboardPayload,
  writeNotesClipboardData,
} = await import("./clipboard.ts");
moduleHooks.deregister();
import type { CanvasObject, ImageObject, TextObject } from "./types.ts";

class MemoryClipboard {
  readonly values = new Map<string, string>();
  items: Array<Pick<DataTransferItem, "kind" | "type" | "getAsFile">> = [];
  files: File[] = [];
  private readonly rejectedTypes: Set<string>;

  constructor(rejectedTypes = new Set<string>()) {
    this.rejectedTypes = rejectedTypes;
  }

  get types() {
    return Array.from(this.values.keys());
  }

  setData(type: string, value: string) {
    if (this.rejectedTypes.has(type)) throw new Error(`Clipboard type rejected: ${type}`);
    this.values.set(type, value);
  }

  getData(type: string) {
    return this.values.get(type) ?? "";
  }

  replace(type: string, value: string) {
    this.values.set(type, value);
  }

  remove(type: string) {
    this.values.delete(type);
  }
}

function formattedText(overrides: Partial<TextObject> = {}): TextObject {
  return {
    id: "text-source",
    type: "text",
    x: 37.25,
    y: 81.5,
    w: 286,
    h: 144.75,
    text: "  Tiếng Việt 📝  \nDòng hai\tgiữ khoảng trắng  ",
    fontSize: 23,
    color: "#1D4ED8",
    align: "right",
    fontFamily: "Be Vietnam Pro",
    fontWeight: "bold",
    fontStyle: "italic",
    textDecoration: "underline",
    backgroundColor: "#FACC15",
    backgroundOpacity: 0.42,
    lineHeight: 1.65,
    rotation: 12,
    ...overrides,
  };
}

function resizedImage(overrides: Partial<ImageObject> = {}): ImageObject {
  return {
    id: "image-source",
    type: "image",
    x: 119.5,
    y: 208.25,
    w: 132,
    h: 88,
    rotation: 37,
    assetId: "asset-original-120x80",
    ...overrides,
  };
}

function payloadFor(objects: CanvasObject[]) {
  return createNotesClipboardPayload({
    sourceNotebookId: "notebook-source",
    sourcePageId: "page-source",
    objects,
  });
}

beforeEach(resetNotesClipboardForTests);
afterEach(resetNotesClipboardForTests);

test("round-trips every formatted-text property exactly", () => {
  const text = formattedText();
  const payload = payloadFor([text]);
  const clipboard = new MemoryClipboard();

  const status = writeNotesClipboardData(clipboard, payload);
  assert.equal(status, "rich");
  assert.equal(canDeleteCutSource(status), true);
  const result = canvasPasteSource(clipboard);

  assert.equal(result.kind, "notes");
  if (result.kind !== "notes") return;
  assert.deepEqual(result.payload.objects, [text]);
  assert.notStrictEqual(result.payload.objects, payload.objects);
  assert.notStrictEqual(result.payload.objects[0], payload.objects[0]);
  assert.equal(clipboard.getData("text/plain"), text.text);
});

test("round-trips a resized and rotated image without replacing its asset", () => {
  const image = resizedImage();
  const payload = payloadFor([image]);
  const clipboard = new MemoryClipboard();

  assert.equal(writeNotesClipboardData(clipboard, payload), "rich");
  const read = readNotesClipboardData(clipboard);

  assert.ok(read);
  assert.deepEqual(read.objects, [image]);
  const roundTripped = read.objects[0];
  assert.equal(roundTripped?.type, "image");
  if (roundTripped?.type !== "image") return;
  assert.equal(roundTripped.w, 132);
  assert.equal(roundTripped.h, 88);
  assert.equal(roundTripped.rotation, 37);
  assert.equal(roundTripped.assetId, "asset-original-120x80");
});

test("clones with new IDs while preserving relative positions and source order", () => {
  const source: CanvasObject[] = [
    formattedText({ id: "bottom-text", x: 15, y: 25 }),
    resizedImage({ id: "middle-image", x: 90, y: 130 }),
    formattedText({ id: "top-text", x: 210, y: 310, text: "trên cùng" }),
  ];
  const payload = payloadFor(source);
  const before = structuredClone(payload.objects);

  const copies = cloneNotesClipboardObjects(payload, 18, -11);

  assert.deepEqual(payload.objects, before, "cloning must not mutate the clipboard snapshot");
  assert.deepEqual(
    copies.map((object) => object.type),
    source.map((object) => object.type),
    "array order is the canvas z-order",
  );
  assert.equal(new Set(copies.map((object) => object.id)).size, copies.length);
  for (let index = 0; index < source.length; index += 1) {
    const original = source[index]!;
    const copy = copies[index]!;
    assert.notEqual(copy.id, original.id);
    assert.equal(copy.type, original.type);
    if ((original.type === "text" || original.type === "image") && copy.type === original.type) {
      assert.equal(copy.x, original.x + 18);
      assert.equal(copy.y, original.y - 11);
      assert.equal(copy.w, original.w);
      assert.equal(copy.h, original.h);
    }
  }

  const sourceDelta = {
    x: (source[1] as ImageObject).x - (source[0] as TextObject).x,
    y: (source[1] as ImageObject).y - (source[0] as TextObject).y,
  };
  assert.deepEqual(
    {
      x: (copies[1] as ImageObject).x - (copies[0] as TextObject).x,
      y: (copies[1] as ImageObject).y - (copies[0] as TextObject).y,
    },
    sourceDelta,
  );
});

test("copying B replaces A's active token and rejects A as a Notes source", () => {
  const payloadA = payloadFor([formattedText({ id: "a", text: "A" })]);
  const clipboardA = new MemoryClipboard();
  assert.equal(writeNotesClipboardData(clipboardA, payloadA), "rich");

  const payloadB = payloadFor([resizedImage({ id: "b", assetId: "asset-b" })]);
  const clipboardB = new MemoryClipboard();
  assert.equal(writeNotesClipboardData(clipboardB, payloadB), "rich");

  assert.notEqual(payloadA.token, payloadB.token);
  assert.equal(readNotesClipboardData(clipboardA), null);
  assert.equal(canvasPasteSource(clipboardA).kind, "text");

  const current = canvasPasteSource(clipboardB);
  assert.equal(current.kind, "notes");
  if (current.kind !== "notes") return;
  assert.equal(current.payload.token, payloadB.token);
  assert.equal(current.payload.objects[0]?.id, "b");
});

test("new external text wins even when stale rich image flavors remain", () => {
  const staleImage = payloadFor([resizedImage()]);
  const clipboard = new MemoryClipboard();
  assert.equal(writeNotesClipboardData(clipboard, staleImage), "rich");

  clipboard.replace("text/plain", "Văn bản mới từ ứng dụng khác 🧾");

  assert.equal(readNotesClipboardData(clipboard), null);
  assert.deepEqual(canvasPasteSource(clipboard), {
    kind: "text",
    text: "Văn bản mới từ ứng dụng khác 🧾",
  });
});

test("rejects malformed JSON, unsupported versions, and invalid object schemas", () => {
  const valid = payloadFor([formattedText()]);
  const cases = [
    "{not-json",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, appId: "another.app" }),
    JSON.stringify({ ...valid, token: "" }),
    JSON.stringify({ ...valid, objects: [] }),
    JSON.stringify({ ...valid, objects: [{ ...formattedText(), fontWeight: "extra-bold" }] }),
    JSON.stringify({ ...valid, objects: [{ ...resizedImage(), w: 0 }] }),
    JSON.stringify({ ...valid, objects: [{ id: "unknown", type: "unknown-object" }] }),
  ];

  for (const serialized of cases) {
    assert.equal(parseNotesClipboardPayload(serialized), null, serialized.slice(0, 120));
  }
  assert.deepEqual(parseNotesClipboardPayload(serializeNotesClipboardPayload(valid)), valid);
});

test("custom MIME plus HTML marker resolves to one Notes source, not duplicate image input", () => {
  const image = resizedImage();
  const payload = payloadFor([image]);
  const clipboard = new MemoryClipboard();
  const externalImage = new File([new Uint8Array([1, 2, 3])], "preview.png", { type: "image/png" });
  clipboard.items = [{ kind: "file", type: "image/png", getAsFile: () => externalImage }];

  assert.equal(writeNotesClipboardData(clipboard, payload), "rich");
  assert.ok(clipboard.types.includes(NOTES_CLIPBOARD_MIME));
  assert.ok(clipboard.types.includes("text/html"));

  const source = canvasPasteSource(clipboard);
  assert.equal(source.kind, "notes");
  if (source.kind !== "notes") return;
  assert.equal(source.payload.objects.length, 1);
  assert.deepEqual(source.payload.objects[0], image);

  clipboard.remove(NOTES_CLIPBOARD_MIME);
  const htmlFallback = canvasPasteSource(clipboard);
  assert.equal(htmlFallback.kind, "notes");
  if (htmlFallback.kind !== "notes") return;
  assert.equal(htmlFallback.payload.objects.length, 1);
});

test("a text-only writer exposes plain text and never activates a rich payload", () => {
  const clipboard = new MemoryClipboard(new Set([NOTES_CLIPBOARD_MIME, "text/html"]));
  const payload = payloadFor([formattedText({ text: "Chỉ văn bản" })]);

  const status = writeNotesClipboardData(clipboard, payload);
  assert.equal(status, "text-only");
  assert.equal(canDeleteCutSource(status), false);
  assert.equal(readNotesClipboardData(clipboard), null);
  assert.deepEqual(canvasPasteSource(clipboard), { kind: "text", text: "Chỉ văn bản" });
});

test("a failed writer clears the previous active payload and leaves no stale fallback", () => {
  const oldClipboard = new MemoryClipboard();
  assert.equal(writeNotesClipboardData(oldClipboard, payloadFor([resizedImage()])), "rich");

  const failedClipboard = new MemoryClipboard(
    new Set([NOTES_CLIPBOARD_MIME, "text/html", "text/plain"]),
  );
  const status = writeNotesClipboardData(
    failedClipboard,
    payloadFor([formattedText({ text: "không ghi được" })]),
  );
  assert.equal(status, "failed");
  assert.equal(canDeleteCutSource(status), false);

  assert.equal(readNotesClipboardData(oldClipboard), null);
  assert.deepEqual(canvasPasteSource(failedClipboard), { kind: "none" });
  const missingWriterStatus = writeNotesClipboardData(null, payloadFor([formattedText()]));
  assert.equal(missingWriterStatus, "failed");
  assert.equal(canDeleteCutSource(missingWriterStatus), false);
});

test("a rich marker without text/plain is a failed write and cannot authorize Cut or paste", () => {
  const clipboard = new MemoryClipboard(new Set(["text/plain"]));
  const payload = payloadFor([formattedText({ text: "marker without plain text" })]);

  const status = writeNotesClipboardData(clipboard, payload);

  assert.ok(clipboard.values.has(NOTES_CLIPBOARD_MIME), "the custom marker should have succeeded");
  assert.ok(clipboard.values.has("text/html"), "the HTML marker should have succeeded");
  assert.equal(status, "failed");
  assert.equal(canDeleteCutSource(status), false);
  assert.equal(readNotesClipboardData(clipboard), null);
  assert.deepEqual(canvasPasteSource(clipboard), { kind: "none" });
});

test("oversized and schema-invalid payloads fail before writing or authorizing Cut", () => {
  const oversizedPayload = payloadFor(
    Array.from({ length: 1_001 }, (_, index) =>
      formattedText({ id: `oversized-${index}`, x: index, text: `object ${index}` }),
    ),
  );
  const invalidPayload = payloadFor([resizedImage({ w: 0 })]);

  for (const payload of [oversizedPayload, invalidPayload]) {
    const clipboard = new MemoryClipboard();
    const status = writeNotesClipboardData(clipboard, payload);

    assert.equal(status, "failed");
    assert.equal(canDeleteCutSource(status), false);
    assert.equal(clipboard.values.size, 0, "invalid snapshots must not partially write flavors");
    assert.equal(readNotesClipboardData(clipboard), null);
    assert.deepEqual(canvasPasteSource(clipboard), { kind: "none" });
  }
});

test("a silent no-op clipboard writer cannot authorize Cut or preserve a stale snapshot", () => {
  const previousClipboard = new MemoryClipboard();
  assert.equal(writeNotesClipboardData(previousClipboard, payloadFor([formattedText()])), "rich");

  const silentWriter = {
    types: [] as string[],
    setData() {},
    getData() {
      return "";
    },
  };
  const status = writeNotesClipboardData(silentWriter, payloadFor([resizedImage()]));

  assert.equal(status, "failed");
  assert.equal(canDeleteCutSource(status), false);
  assert.equal(readNotesClipboardData(previousClipboard), null);
  assert.deepEqual(canvasPasteSource(silentWriter), { kind: "none" });
});

test("a stale custom flavor cannot mask the current matching HTML fallback", () => {
  const clipboardA = new MemoryClipboard();
  const payloadA = payloadFor([formattedText({ id: "old-a", text: "A cũ" })]);
  assert.equal(writeNotesClipboardData(clipboardA, payloadA), "rich");

  const clipboardB = new MemoryClipboard();
  const payloadB = payloadFor([formattedText({ id: "new-b", text: "B mới" })]);
  assert.equal(writeNotesClipboardData(clipboardB, payloadB), "rich");

  const mixedClipboard = new MemoryClipboard();
  mixedClipboard.replace(NOTES_CLIPBOARD_MIME, clipboardA.getData(NOTES_CLIPBOARD_MIME));
  mixedClipboard.replace("text/html", clipboardB.getData("text/html"));
  mixedClipboard.replace("text/plain", clipboardB.getData("text/plain"));

  const read = readNotesClipboardData(mixedClipboard);
  assert.ok(read);
  assert.equal(read.token, payloadB.token);
  assert.equal(read.objects[0]?.id, "new-b");
});
