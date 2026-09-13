#!/usr/bin/env node
// Browser regression checks for Notes resize. Every run uses a fresh browser
// context and a synthetic notebook; it never attaches to Tauri or user data.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8080";
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  "Resize QA requires a loopback server",
);

const output = resolve("screenshots");
mkdirSync(output, { recursive: true });
const checks = [];
const browserErrors = [];
const failedRequests = [];
const platformWarnings = [];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const detail = `${message.text()} (${message.location().url})`;
  if (
    message.location().url === "https://grok.com/grok-app-builder/extensions.js" &&
    message.text().includes("ERR_BLOCKED_BY_RESPONSE.NotSameOrigin")
  ) {
    platformWarnings.push(detail);
  } else {
    browserErrors.push(detail);
  }
});
page.on("requestfailed", (request) => {
  const url = request.url();
  if (url === "https://grok.com/grok-app-builder/extensions.js") return;
  failedRequests.push({ url, error: request.failure()?.errorText });
});

let notebookId;
let pageId;
let textId;
let imageId;
let finalResult;

async function installStoreBridge() {
  await page.evaluate(async () => {
    if ("__TAURI_INTERNALS__" in window) throw new Error("Refusing to test desktop storage");
    const loaded = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .findLast((url) => new URL(url).pathname === "/src/lib/notes/store.ts");
    window.__notesQaStore = (await import(loaded ?? "/src/lib/notes/store.ts")).useNotesStore;
  });
  await page.waitForFunction(() => window.__notesQaStore.getState().ready);
}

async function state() {
  return page.evaluate((id) => {
    const store = window.__notesQaStore.getState();
    const activePage = store.pages.find((candidate) => candidate.id === id) ?? store.pages[0];
    return {
      objects: store.objectsByPage[activePage.id] ?? [],
      history: store.history[store.activeNotebookId]?.past.length ?? 0,
      zoom: store.zoom,
      page: activePage,
      saveStatus: store.saveStatus,
    };
  }, pageId);
}

function close(actual, expected, message, tolerance = 0.12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} ≠ ${expected}`);
}

function formatting(object) {
  return {
    fontSize: object.fontSize,
    fontFamily: object.fontFamily,
    fontWeight: object.fontWeight,
    fontStyle: object.fontStyle,
    textDecoration: object.textDecoration,
    align: object.align,
    lineHeight: object.lineHeight,
    color: object.color,
    backgroundColor: object.backgroundColor,
    backgroundOpacity: object.backgroundOpacity,
  };
}

function pagePointToDisplay(point, record) {
  if (record.rotation === 90) return { x: record.height - point.y, y: point.x };
  if (record.rotation === 180) return { x: record.width - point.x, y: record.height - point.y };
  if (record.rotation === 270) return { x: point.y, y: record.width - point.x };
  return point;
}

function pageDeltaToDisplay(delta, rotation) {
  if (rotation === 90) return { x: -delta.y, y: delta.x };
  if (rotation === 180) return { x: -delta.x, y: -delta.y };
  if (rotation === 270) return { x: delta.y, y: -delta.x };
  return delta;
}

async function pagePoint(x, y) {
  const snapshot = await state();
  const pageBox = await page.locator(`[data-page-id="${pageId}"]`).boundingBox();
  assert(pageBox, "Page must be visible");
  const display = pagePointToDisplay({ x, y }, snapshot.page);
  return {
    x: pageBox.x + display.x * snapshot.zoom,
    y: pageBox.y + display.y * snapshot.zoom,
  };
}

async function selectObject(object) {
  const center = await pagePoint(object.x + object.w / 2, object.y + object.h / 2);
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(50);
}

function textHandle(handle) {
  return page.locator(
    `[data-page-id="${pageId}"] [data-text-selection-box="${textId}"] [data-resize-handle="${handle}"]`,
  );
}

function objectHandle(handle) {
  return page.locator(
    `[data-page-id="${pageId}"] [data-selection-box="true"] [data-resize-handle="${handle}"]`,
  );
}

async function dragHandle(locator, pageDelta, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  const handle = await locator.boundingBox();
  assert(handle, "Resize handle must be visible");
  const snapshot = await state();
  const delta = pageDeltaToDisplay(pageDelta, snapshot.page.rotation);
  const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  const end = {
    x: start.x + delta.x * snapshot.zoom,
    y: start.y + delta.y * snapshot.zoom,
  };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: options.steps ?? 8 });
  if (options.returnToStart) {
    await page.mouse.move(start.x, start.y, { steps: 8 });
  }
  if (options.cancel) {
    await locator.dispatchEvent("pointercancel", {
      bubbles: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: end.x,
      clientY: end.y,
      buttons: 0,
    });
    await page.mouse.up();
  } else if (options.loseCapture) {
    await locator.evaluate((element) => {
      if (!element.hasPointerCapture(1)) throw new Error("Resize handle did not capture pointer 1");
      element.releasePointerCapture(1);
    });
    await page.mouse.up();
  } else {
    await page.mouse.up();
  }
  await page.waitForTimeout(60);
}

async function setRotation(rotation) {
  await page.evaluate(
    async ({ id, target }) => {
      const store = window.__notesQaStore;
      let current = store.getState().pages.find((candidate) => candidate.id === id)?.rotation;
      for (let guard = 0; current !== target && guard < 4; guard += 1) {
        await store.getState().rotatePage(id);
        current = store.getState().pages.find((candidate) => candidate.id === id)?.rotation;
      }
      if (current !== target) throw new Error(`Could not rotate page to ${target}`);
    },
    { id: pageId, target: rotation },
  );
  await page.waitForTimeout(80);
}

async function setZoom(zoom) {
  await page.evaluate((value) => window.__notesQaStore.getState().setZoom(value), zoom);
  await page.waitForTimeout(80);
}

async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await installStoreBridge();
  notebookId = await page.evaluate(() => {
    const store = window.__notesQaStore.getState();
    store.persistSettings({ autoBackup: false, autoCheckUpdates: false });
    return store.createNotebook({
      name: "QA — đổi kích thước chữ và ảnh",
      folderId: null,
      cover: "#0F766E",
      paper: { pattern: "blank", color: "#FFFEFB", lineColor: "#D6D3CD" },
      pageSize: "a4",
      orientation: "portrait",
      pages: 1,
    });
  });
  await page.goto(`${origin}/notebook/${notebookId}`, { waitUntil: "networkidle" });
  await installStoreBridge();
  await page.waitForSelector("[data-page-id] canvas");
  pageId = (await state()).page.id;
  textId = "qa-resize-text";
  imageId = "qa-resize-image";

  await page.evaluate(
    ({ id, textObjectId }) => {
      const store = window.__notesQaStore.getState();
      store.setZoom(1);
      store.commitObjects(
        id,
        [
          {
            id: textObjectId,
            type: "text",
            x: 70,
            y: 100,
            w: 240,
            h: 30.8,
            text: "Ghi chú",
            fontSize: 22,
            color: "#1C1917",
            align: "right",
            fontFamily: "Be Vietnam Pro",
            fontWeight: "bold",
            fontStyle: "italic",
            textDecoration: "underline",
            backgroundColor: "#FACC15",
            backgroundOpacity: 0.45,
            lineHeight: 1.4,
          },
          {
            id: "qa-marker",
            type: "shape",
            shape: "line",
            x1: 30,
            y1: 60,
            x2: 90,
            y2: 60,
            color: "#0F766E",
            width: 2,
          },
        ],
        false,
      );
    },
    { id: pageId, textObjectId: textId },
  );
  await page.getByRole("button", { name: "Lasso", exact: true }).click();
  await selectObject((await state()).objects.find((object) => object.id === textId));
  await textHandle("r").waitFor({ state: "visible" });

  await check("reported 240 × 30.8 / font 22 regression", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    const history = (await state()).history;
    await dragHandle(textHandle("r"), { x: 100, y: 75 });
    const after = (await state()).objects.find((object) => object.id === textId);
    close(after.w, 340, "Right resize width");
    close(after.h, 30.8, "Right resize height");
    assert.equal(after.x, before.x, "Right handle must keep the left edge fixed");
    assert.deepEqual(formatting(after), formatting(before));
    assert.equal((await state()).history, history + 1, "One resize must add one Undo entry");
  });

  await check("Undo and Redo restore complete text geometry", async () => {
    await page.getByRole("button", { name: "Hoàn tác", exact: true }).click();
    let object = (await state()).objects.find((candidate) => candidate.id === textId);
    close(object.w, 240, "Undo width");
    close(object.h, 30.8, "Undo height");
    assert.equal(object.fontSize, 22);
    await page.getByRole("button", { name: "Làm lại", exact: true }).click();
    object = (await state()).objects.find((candidate) => candidate.id === textId);
    close(object.w, 340, "Redo width");
    close(object.h, 30.8, "Redo height");
    assert.equal(object.fontSize, 22);
    await page.getByRole("button", { name: "Hoàn tác", exact: true }).click();
  });

  await check("left handle keeps the right edge fixed", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    const right = before.x + before.w;
    await dragHandle(textHandle("l"), { x: 80, y: -100 });
    const after = (await state()).objects.find((object) => object.id === textId);
    close(after.w, 160, "Left resize width");
    close(after.x + after.w, right, "Anchored right edge");
    assert.equal(after.fontSize, before.fontSize);
    assert.equal(after.y, before.y);
  });

  await check("handle click and return-to-start drag create no extra history", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    const history = (await state()).history;
    await textHandle("r").click();
    assert.equal((await state()).history, history);
    await dragHandle(textHandle("r"), { x: 60, y: 0 }, { returnToStart: true });
    assert.deepEqual(
      (await state()).objects.find((object) => object.id === textId),
      before,
    );
    assert.equal((await state()).history, history);
  });

  await check("pointercancel restores the pre-drag object", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    const history = (await state()).history;
    await dragHandle(textHandle("r"), { x: 55, y: 0 }, { cancel: true });
    assert.deepEqual(
      (await state()).objects.find((object) => object.id === textId),
      before,
    );
    assert.equal((await state()).history, history);
  });

  await check("lost pointer capture keeps the latest completed preview once", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    const history = (await state()).history;
    await dragHandle(textHandle("r"), { x: 35, y: 0 }, { loseCapture: true });
    const after = (await state()).objects.find((object) => object.id === textId);
    close(after.w, before.w + 35, "Lost-capture final width", 0.3);
    assert.equal((await state()).history, history + 1);
    await page.evaluate(() => window.__notesQaStore.getState().undo());
  });

  await check("fast release consumes the final pointer coordinates", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    await dragHandle(textHandle("r"), { x: 42, y: 0 }, { steps: 1 });
    const after = (await state()).objects.find((object) => object.id === textId);
    close(after.w, before.w + 42, "Fast final width", 0.3);
    await page.evaluate(() => window.__notesQaStore.getState().undo());
  });

  await check("resize merge preserves another object's concurrent change", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    const handle = await textHandle("r").boundingBox();
    const snapshot = await state();
    const start = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 30 * snapshot.zoom, start.y, { steps: 4 });
    await page.evaluate((id) => {
      const store = window.__notesQaStore.getState();
      const objects = store.objectsByPage[id];
      store.commitObjects(
        id,
        objects.map((object) =>
          object.id === "qa-marker" ? { ...object, x1: object.x1 + 7, x2: object.x2 + 7 } : object,
        ),
        false,
      );
    }, pageId);
    await page.mouse.up();
    let snapshotAfter = await state();
    close(
      snapshotAfter.objects.find((object) => object.id === textId).w,
      before.w + 30,
      "Concurrent resize width",
      0.3,
    );
    assert.equal(snapshotAfter.objects.find((object) => object.id === "qa-marker").x1, 37);
    await page.evaluate(() => window.__notesQaStore.getState().undo());
    snapshotAfter = await state();
    close(
      snapshotAfter.objects.find((object) => object.id === textId).w,
      before.w,
      "Concurrent Undo width",
    );
    assert.equal(snapshotAfter.objects.find((object) => object.id === "qa-marker").x1, 37);
  });

  const complexText =
    "Tiếng Việt đậm nghiêng ✨\n\nhttps://example.com/duong-dan-rat-dai-khong-co-khoang-trang/👨‍👩‍👧‍👦\nDòng cuối cùng.\n";
  await page.evaluate(
    async ({ id, objectId, value }) => {
      const store = window.__notesQaStore.getState();
      const moduleUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .findLast(
          (url) => new URL(url).pathname === "/src/components/notes/text-tool/text-layout.ts",
        );
      const { autoResizeTextObject } = await import(
        moduleUrl ?? "/src/components/notes/text-tool/text-layout.ts"
      );
      const objects = store.objectsByPage[id];
      store.commitObjects(
        id,
        objects.map((object) =>
          object.id === objectId
            ? autoResizeTextObject({ ...object, x: 70, y: 100, w: 240, text: value })
            : object,
        ),
        false,
      );
    },
    { id: pageId, objectId: textId, value: complexText },
  );
  await page.waitForTimeout(80);

  await check("narrow and widen share wrapping and height rules", async () => {
    const before = (await state()).objects.find((object) => object.id === textId);
    const beforeFormatting = formatting(before);
    await dragHandle(textHandle("r"), { x: -140, y: 150 });
    const narrow = (await state()).objects.find((object) => object.id === textId);
    close(narrow.w, 100, "Narrow width");
    assert.ok(narrow.h > before.h, "Narrow text must gain enough height for wrapped lines");
    assert.equal(narrow.text, complexText);
    assert.deepEqual(formatting(narrow), beforeFormatting);
    await dragHandle(textHandle("r"), { x: 140, y: -150 });
    const wide = (await state()).objects.find((object) => object.id === textId);
    close(wide.w, 240, "Restored width");
    close(wide.h, before.h, "Restored wrapped height");
    assert.equal(wide.text, complexText);
    assert.deepEqual(formatting(wide), beforeFormatting);
  });

  await check("selection frame and editor caret align after resize", async () => {
    const selection = await page.locator(`[data-text-selection-box="${textId}"]`).boundingBox();
    const object = (await state()).objects.find((candidate) => candidate.id === textId);
    const target = await pagePoint(object.x + 24, object.y + 12);
    await page.mouse.click(target.x, target.y, { clickCount: 2 });
    const editor = page.locator('[data-notes-text-editor="true"]');
    await editor.waitFor({ state: "visible" });
    const editorBox = await editor.boundingBox();
    close(editorBox.x, selection.x, "Editor x", 2);
    close(editorBox.y, selection.y, "Editor y", 2);
    close(editorBox.width, selection.width, "Editor width", 2);
    close(editorBox.height, selection.height, "Editor height", 2);
    const caret = await editor.evaluate((element) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      length: element.value.length,
    }));
    assert.deepEqual(caret, { start: caret.length, end: caret.length, length: caret.length });
    await editor.press("Control+Enter");
    await editor.waitFor({ state: "detached" });
    assert.equal((await state()).objects.find((candidate) => candidate.id === textId).fontSize, 22);
  });

  await check(
    "selection and horizontal resize stay aligned at every zoom and page rotation",
    async () => {
      for (const zoom of [0.5, 1, 1.5]) {
        await setZoom(zoom);
        for (const rotation of [0, 90, 180, 270]) {
          await setRotation(rotation);
          const before = (await state()).objects.find((object) => object.id === textId);
          const selection = await page
            .locator(`[data-text-selection-box="${textId}"]`)
            .boundingBox();
          const expectedWidth = (rotation === 90 || rotation === 270 ? before.h : before.w) * zoom;
          const expectedHeight = (rotation === 90 || rotation === 270 ? before.w : before.h) * zoom;
          close(selection.width, expectedWidth, `Selection width at ${zoom}/${rotation}`, 1);
          close(selection.height, expectedHeight, `Selection height at ${zoom}/${rotation}`, 1);
          await dragHandle(textHandle("r"), { x: 8, y: 0 }, { steps: 2 });
          const after = (await state()).objects.find((object) => object.id === textId);
          close(after.w, before.w + 8, `Resize width at ${zoom}/${rotation}`, 0.5);
          assert.equal(after.x, before.x);
          assert.equal(after.fontSize, before.fontSize);
          await page.evaluate(() => window.__notesQaStore.getState().undo());
        }
      }
      await setRotation(0);
      await setZoom(1);
    },
  );

  await page.evaluate(
    async ({ id, objectId }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 20;
      const context = canvas.getContext("2d");
      context.fillStyle = "#0F766E";
      context.fillRect(0, 0, 400, 20);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const assetId = "qa-resize-asset";
      const db = await import("/src/lib/notes/db.ts");
      await db.putAsset({
        id: assetId,
        kind: "image",
        mime: "image/png",
        name: "qa-thin-image.png",
        byteLength: blob.size,
        blob,
        createdAt: Date.now(),
      });
      const store = window.__notesQaStore.getState();
      store.commitObjects(
        id,
        [
          ...store.objectsByPage[id],
          {
            id: objectId,
            type: "image",
            x: 35,
            y: 500,
            w: 400,
            h: 20,
            rotation: 0,
            assetId,
          },
        ],
        false,
      );
    },
    { id: pageId, objectId: imageId },
  );
  await page.waitForTimeout(120);
  await selectObject((await state()).objects.find((object) => object.id === imageId));
  await objectHandle("br").waitFor({ state: "visible" });

  await check("400 × 20 image corner resize keeps its 20:1 ratio", async () => {
    const before = (await state()).objects.find((object) => object.id === imageId);
    const history = (await state()).history;
    await dragHandle(objectHandle("br"), { x: 100, y: 5 });
    const after = (await state()).objects.find((object) => object.id === imageId);
    close(after.w, 500, "Thin image width", 0.3);
    close(after.h, 25, "Thin image height", 0.3);
    close(after.w / after.h, 20, "Thin image ratio", 0.001);
    assert.equal(after.assetId, before.assetId);
    assert.equal(after.rotation, before.rotation);
    assert.equal((await state()).history, history + 1);
  });

  await check("rotated image exposes only accurate proportional corner resize", async () => {
    await page.evaluate(
      ({ id, objectId }) => {
        const store = window.__notesQaStore.getState();
        store.commitObjects(
          id,
          store.objectsByPage[id].map((object) =>
            object.id === objectId ? { ...object, w: 400, h: 20, rotation: 90 } : object,
          ),
          false,
        );
      },
      { id: pageId, objectId: imageId },
    );
    await page.waitForTimeout(60);
    assert.equal(
      await objectHandle("r").isHidden(),
      true,
      "Rotated image side handle must stay disabled",
    );
    await dragHandle(objectHandle("br"), { x: 5, y: 100 });
    const after = (await state()).objects.find((object) => object.id === imageId);
    close(after.w, 500, "Rotated image width", 0.3);
    close(after.h, 25, "Rotated image height", 0.3);
    close(after.w / after.h, 20, "Rotated image ratio", 0.001);
    assert.equal(after.rotation, 90);
    assert.equal(after.assetId, "qa-resize-asset");
  });

  await check("legacy image below minimum neither jumps nor creates Undo", async () => {
    await page.evaluate(
      ({ id, objectId }) => {
        const store = window.__notesQaStore.getState();
        store.commitObjects(
          id,
          store.objectsByPage[id].map((object) =>
            object.id === objectId
              ? { ...object, x: 360, y: 450, w: 8, h: 4, rotation: 0 }
              : object,
          ),
          false,
        );
      },
      { id: pageId, objectId: imageId },
    );
    await page.waitForTimeout(60);
    const before = (await state()).objects.find((object) => object.id === imageId);
    const history = (await state()).history;
    await objectHandle("br").click();
    await dragHandle(objectHandle("br"), { x: -4, y: -2 });
    assert.deepEqual(
      (await state()).objects.find((object) => object.id === imageId),
      before,
    );
    assert.equal((await state()).history, history);
  });

  await check("autosave and reload preserve the latest resize data", async () => {
    await page.evaluate(
      ({ id, objectId }) => {
        const store = window.__notesQaStore.getState();
        store.commitObjects(
          id,
          store.objectsByPage[id].map((object) =>
            object.id === objectId
              ? { ...object, x: 35, y: 500, w: 400, h: 20, rotation: 90 }
              : object,
          ),
          false,
        );
      },
      { id: pageId, objectId: imageId },
    );
    await page.waitForTimeout(60);
    await dragHandle(objectHandle("br"), { x: 2.5, y: 50 });
    await page.evaluate(() => window.__notesQaStore.getState().flushPendingWrites());
    const before = (await state()).objects;
    await page.reload({ waitUntil: "networkidle" });
    await installStoreBridge();
    await page.waitForSelector(`[data-page-id="${pageId}"] canvas`);
    assert.deepEqual((await state()).objects, before);
    await page.screenshot({ path: resolve(output, "notes-resize-desktop.png"), fullPage: true });
  });

  await check("mobile view keeps the resized page and controls in bounds", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await installStoreBridge();
    await page.waitForSelector(`[data-page-id="${pageId}"] canvas`);
    await page.waitForTimeout(150);
    const metrics = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    assert.ok(
      metrics.document <= metrics.viewport + 1,
      "Mobile document must not overflow horizontally",
    );
    await page.screenshot({ path: resolve(output, "notes-resize-mobile.png"), fullPage: true });
  });

  assert.equal(browserErrors.length, 0, `Browser errors: ${browserErrors.join("; ")}`);
  finalResult = {
    ok: true,
    checks,
    browserErrors,
    platformWarnings,
    failedRequests,
    screenshots: ["notes-resize-desktop.png", "notes-resize-mobile.png"],
  };
} catch (error) {
  await page
    .screenshot({ path: resolve(output, "notes-resize-failure.png"), fullPage: true })
    .catch(() => {});
  finalResult = {
    ok: false,
    checks,
    error: error.stack ?? String(error),
    browserErrors,
    failedRequests,
  };
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(output, "notes-resize-qa.json"), JSON.stringify(finalResult, null, 2));
  console.log(JSON.stringify(finalResult, null, 2));
  await context.close();
  await browser.close();
}
