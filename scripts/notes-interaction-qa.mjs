#!/usr/bin/env node
// Development regression checks. Uses a new, disposable browser context and a
// synthetic notebook only; never attaches to Tauri or a personal browser profile.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8080";
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname), "QA requires a loopback development server");
const output = resolve("screenshots");
mkdirSync(output, { recursive: true });
const checks = [];
const errors = [];
const failedRequests = [];
const platformWarnings = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHROMIUM_EXECUTABLE ? { executablePath: process.env.BROWSER_CHROMIUM_EXECUTABLE } : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const detail = `${message.text()} (${message.location().url})`;
  // Same narrowly scoped local branding exception as browser-smoke.mjs.
  if (message.location().url === "https://grok.com/grok-app-builder/extensions.js" && message.text().includes("ERR_BLOCKED_BY_RESPONSE.NotSameOrigin")) platformWarnings.push(detail);
  else errors.push(detail);
});
page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
let notebookId;
let pageId;
let finalResult;

async function state() {
  return page.evaluate(() => {
    const s = window.__notesQaStore.getState();
    return {
      objects: s.objectsByPage[s.pages[0]?.id] ?? [],
      history: s.history[s.activeNotebookId]?.past.length ?? 0,
      zoom: s.zoom,
      page: s.pages[0],
      saveStatus: s.saveStatus,
    };
  });
}
async function readyStore() {
  await page.evaluate(async () => {
    if ("__TAURI_INTERNALS__" in window) throw new Error("Refusing to test desktop storage");
    // Match Vite's active HMR URL; importing a bare path after a hot update
    // creates a different, unhydrated module instance from the one React uses.
    const loaded = performance.getEntriesByType("resource").map((entry) => entry.name)
      .findLast((url) => new URL(url).pathname === "/src/lib/notes/store.ts");
    window.__notesQaStore = (await import(loaded ?? "/src/lib/notes/store.ts")).useNotesStore;
  });
  await page.waitForFunction(() => window.__notesQaStore.getState().ready);
}
async function point(x, y) {
  const box = await page.locator(`[data-page-id="${pageId}"]`).boundingBox();
  assert(box, "Page canvas must be visible");
  const s = await state();
  return { x: box.x + x * s.zoom, y: box.y + y * s.zoom };
}
function pageToDisplayPoint(x, y, record) {
  if (record.rotation === 90) return { x: record.height - y, y: x };
  if (record.rotation === 180) return { x: record.width - x, y: record.height - y };
  if (record.rotation === 270) return { x: y, y: record.width - x };
  return { x, y };
}
async function pageClientPoint(targetPageId, x, y) {
  const box = await page.locator(`[data-page-id="${targetPageId}"]`).boundingBox();
  assert(box, `Page ${targetPageId} must be visible`);
  const snapshot = await page.evaluate((id) => {
    const s = window.__notesQaStore.getState();
    return { page: s.pages.find((candidate) => candidate.id === id), zoom: s.zoom };
  }, targetPageId);
  assert(snapshot.page, `Page ${targetPageId} must exist`);
  const display = pageToDisplayPoint(x, y, snapshot.page);
  return { x: box.x + display.x * snapshot.zoom, y: box.y + display.y * snapshot.zoom };
}
async function allObjectState() {
  return page.evaluate(() => {
    const s = window.__notesQaStore.getState();
    return {
      objects: structuredClone(s.objectsByPage),
      history: s.history[s.activeNotebookId]?.past.length ?? 0,
    };
  });
}
async function selectIds(targetPageId, objectIds) {
  await page.evaluate(({ targetPageId, objectIds }) => {
    window.dispatchEvent(new CustomEvent("notes-select-objects", {
      detail: { pageId: targetPageId, objectIds },
    }));
  }, { targetPageId, objectIds });
  await page.waitForTimeout(40);
}
async function dragFromTo(from, to, options = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: options.steps ?? 10 });
  if (options.cancelPageId) {
    await page.locator(`[data-page-id="${options.cancelPageId}"] [data-notes-canvas="interaction"]`).dispatchEvent("pointercancel", {
      bubbles: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: to.x,
      clientY: to.y,
      buttons: 0,
    });
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
}
function rotatedBox(object) {
  const radians = ((object.rotation ?? 0) * Math.PI) / 180;
  const width = object.w * Math.abs(Math.cos(radians)) + object.h * Math.abs(Math.sin(radians));
  const height = object.w * Math.abs(Math.sin(radians)) + object.h * Math.abs(Math.cos(radians));
  return {
    x: object.x + (object.w - width) / 2,
    y: object.y + (object.h - height) / 2,
    w: width,
    h: height,
  };
}
function visibleLength(start, length, pageLength) {
  return Math.max(0, Math.min(pageLength, start + length) - Math.max(0, start));
}
async function clickPoint(x, y, options) {
  const p = await point(x, y);
  await page.mouse.click(p.x, p.y, options);
}
async function moveObject(object, dx, dy) {
  const from = await point(object.x + object.w / 2, object.y + Math.min(14, object.h / 2));
  const s = await state();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx * s.zoom, from.y + dy * s.zoom, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}
async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${name}`);
}
const editor = () => page.locator('textarea[placeholder="Nhập nội dung…"]');

try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await readyStore();
  notebookId = await page.evaluate(async () => {
    const store = window.__notesQaStore.getState();
    // Fresh contexts receive the app's built-in sample library on first boot.
    store.persistSettings({ autoBackup: false, autoCheckUpdates: false });
    return store.createNotebook({
      name: "QA — chữ và ảnh", folderId: null, cover: "#0F766E",
      paper: { pattern: "blank", color: "#FFFEFB", lineColor: "#D6D3CD" },
      pageSize: "a4", orientation: "portrait", pages: 1,
    });
  });
  await page.goto(`${origin}/notebook/${notebookId}`, { waitUntil: "networkidle" });
  await readyStore();
  await page.waitForSelector("[data-page-id] canvas");
  pageId = (await state()).page.id;
  await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.85));
  await page.waitForTimeout(150);

  let textId;
  const initialText = "Ghi chú thử nghiệm\nThêm chữ và chọn lại dễ dàng.";
  await check("add text and commit by clicking another tool", async () => {
    await page.getByRole("button", { name: /^Chữ, cỡ/ }).click();
    await clickPoint(65, 100);
    await editor().fill(initialText);
    await page.getByRole("button", { name: "Lasso", exact: true }).click();
    await editor().waitFor({ state: "detached" });
    const texts = (await state()).objects.filter((o) => o.type === "text");
    assert.equal(texts.length, 1);
    assert.equal(texts[0].text, initialText);
    textId = texts[0].id;
  });

  await check("reselect and drag already selected text", async () => {
    const before = (await state()).objects.find((o) => o.id === textId);
    await clickPoint(before.x + 30, before.y + 15);
    assert.equal(await editor().count(), 0, "Single click must select without opening editor");
    const selectedHistory = (await state()).history;
    await moveObject(before, 54, 44);
    const after = (await state()).objects.find((o) => o.id === textId);
    assert(Math.abs(after.x - before.x - 54) < 1, "Selected text should follow drag horizontally");
    assert(Math.abs(after.y - before.y - 44) < 1, "Selected text should follow drag vertically");
    assert.equal((await state()).history, selectedHistory + 1, "One drag must create one undo entry");
  });

  const longText = "Ghi chú sau khi sửa\n" + "abcdefghij".repeat(9) + "\nDòng cuối cùng.";
  await check("double click editing hides old canvas text and wraps long words", async () => {
    const object = (await state()).objects.find((o) => o.id === textId);
    await clickPoint(object.x + 40, object.y + 15, { clickCount: 2 });
    await editor().waitFor({ state: "visible" });
    await page.waitForTimeout(120);
    const pixels = await page.evaluate(({ pageId, object }) => {
      const canvas = document.querySelector(`[data-page-id="${pageId}"]`).querySelectorAll("canvas")[1];
      const zoom = window.__notesQaStore.getState().zoom;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      const pixels = canvas.getContext("2d").getImageData(
        Math.ceil((object.x + 3) * zoom * ratio), Math.ceil((object.y + 3) * zoom * ratio),
        Math.max(1, Math.floor((object.w - 6) * zoom * ratio)), Math.max(1, Math.floor((object.h - 6) * zoom * ratio)),
      ).data;
      let visible = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) visible++;
      return visible;
    }, { pageId, object });
    assert.equal(pixels, 0, "Canvas must not keep a duplicate of the text currently being edited");
    await editor().fill(longText);
    const dimensions = await editor().evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth, h: el.offsetHeight }));
    assert(dimensions.scroll <= dimensions.client + 1, "Long words must wrap without horizontal scrolling");
    await editor().press("Control+Enter");
    await editor().waitFor({ state: "detached" });
    const after = (await state()).objects.find((o) => o.id === textId);
    assert.equal(after.text, longText);
    assert(after.h > object.h, "Text bounds must grow to cover the new wrapped lines");
  });

  let imageId;
  await check("native clipboard paste inserts and selects image", async () => {
    await page.getByRole("button", { name: "Lasso", exact: true }).click();
    await clickPoint(385, 470);
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 180; canvas.height = 110;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0F766E"; ctx.fillRect(0, 0, 180, 110);
      ctx.fillStyle = "#F4A261"; ctx.fillRect(20, 20, 140, 70);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    });
    await page.keyboard.press("Control+V");
    await page.waitForFunction(() => Object.values(window.__notesQaStore.getState().objectsByPage).flat().some((o) => o.type === "image"));
    const images = (await state()).objects.filter((o) => o.type === "image");
    assert.equal(images.length, 1);
    imageId = images[0].id;
    await page.getByRole("button", { name: "Kéo để đổi kích thước", exact: true }).last().waitFor({ state: "visible" });
  });

  await check("zoom during editing preserves draft and Escape restores the original", async () => {
    const object = (await state()).objects.find((o) => o.id === textId);
    await clickPoint(object.x + 40, object.y + 15, { clickCount: 2 });
    await editor().fill("Đang gõ tiếng Việt, chưa lưu\n");
    const history = (await state()).history;
    await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.8));
    await page.waitForTimeout(50);
    assert.equal(await editor().inputValue(), "Đang gõ tiếng Việt, chưa lưu\n");
    assert.equal((await state()).history, history);
    await editor().press("Escape");
    assert.equal((await state()).objects.find((o) => o.id === textId).text, longText);
    assert.equal((await state()).history, history);
    await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.85));
    const image = (await state()).objects.find((o) => o.id === imageId);
    await clickPoint(image.x + 30, image.y + 20);
  });

  await check("image drag and no-op resize do not add spurious history", async () => {
    const before = (await state()).objects.find((o) => o.id === imageId);
    const count = (await state()).history;
    await moveObject(before, -20, 35);
    const moved = (await state()).objects.find((o) => o.id === imageId);
    assert(Math.abs(moved.y - before.y - 35) < 1);
    assert.equal((await state()).history, count + 1);
    await page.getByRole("button", { name: "Kéo để đổi kích thước", exact: true }).nth(3).click();
    assert.equal((await state()).history, count + 1, "A resize handle click without movement must not add history");
    const handle = await page.getByRole("button", { name: "Kéo để đổi kích thước", exact: true }).nth(3).boundingBox();
    const zoom = (await state()).zoom;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 45 * zoom, handle.y + handle.height / 2 + 28 * zoom, { steps: 8 });
    await page.mouse.up();
    const resized = (await state()).objects.find((o) => o.id === imageId);
    assert(resized.w > moved.w + 30 && resized.h > moved.h + 15, "Image resize must update both dimensions");
    assert(Math.abs(resized.w / resized.h - moved.w / moved.h) < 0.01, "Corner resize preserves image aspect ratio");
    assert.equal((await state()).history, count + 2);
  });

  await check("text and image roll back exactly at all four outer edges and app toolbar", async () => {
    const toolbar = await page.getByRole("button", { name: "Lasso", exact: true }).boundingBox();
    assert(toolbar, "Notes toolbar must be visible");
    const invalidTargets = [
      { x: 2, y: 450 },
      { x: 1278, y: 450 },
      { x: 640, y: 2 },
      { x: 640, y: 898 },
      { x: toolbar.x + toolbar.width / 2, y: toolbar.y + toolbar.height / 2 },
    ];
    for (const id of [textId, imageId]) {
      const object = (await state()).objects.find((candidate) => candidate.id === id);
      await selectIds(pageId, [id]);
      const from = await point(object.x + object.w / 2, object.y + object.h / 2);
      for (const target of invalidTargets) {
        const before = await allObjectState();
        await dragFromTo(from, target);
        assert.deepEqual(await allObjectState(), before, `${object.type} changed after an invalid drop`);
      }
      const selection = object.type === "text"
        ? page.locator(`[data-page-id="${pageId}"] [data-text-selection-box="${id}"]`)
        : page.locator(`[data-page-id="${pageId}"] [data-selection-box="true"]`);
      assert.equal(await selection.count(), 1, `${object.type} selection should survive invalid drops`);
    }
  });

  await check("pointercancel restores a live drag without history or persistence changes", async () => {
    const object = (await state()).objects.find((candidate) => candidate.id === imageId);
    await selectIds(pageId, [imageId]);
    const from = await point(object.x + object.w / 2, object.y + object.h / 2);
    const before = await allObjectState();
    await dragFromTo(from, { x: from.x + 70, y: from.y + 35 }, { cancelPageId: pageId });
    assert.deepEqual(await allObjectState(), before);
    assert.equal(await page.locator('[data-notes-drag-preview="true"]').count(), 0, "Cancelled preview must be removed");
  });

  await check("same-page drag stays exact at 50%, 100%, 150%, including a scrolled stage", async () => {
    const stage = page.locator('[data-notes-stage="true"]');
    for (const targetZoom of [0.5, 1, 1.5]) {
      await page.evaluate((nextZoom) => window.__notesQaStore.getState().setZoom(nextZoom), targetZoom);
      await page.waitForTimeout(100);
      await stage.evaluate((element, shouldScroll) => {
        element.scrollTop = shouldScroll ? 180 : 0;
        element.scrollLeft = shouldScroll ? 90 : 0;
      }, targetZoom === 1.5);
      await page.waitForTimeout(60);
      if (targetZoom === 1.5) {
        assert((await stage.evaluate((element) => element.scrollTop)) > 0, "The 150% case must exercise a scrolled stage");
      }
      const before = (await state()).objects.find((object) => object.id === imageId);
      const history = (await state()).history;
      await selectIds(pageId, [imageId]);
      const from = await pageClientPoint(pageId, before.x + before.w / 2, before.y + before.h / 2);
      const to = await pageClientPoint(pageId, before.x + before.w / 2 + 12, before.y + before.h / 2 + 9);
      await dragFromTo(from, to, { steps: 5 });
      const after = (await state()).objects.find((object) => object.id === imageId);
      assert(Math.abs(after.x - before.x - 12) < 0.15, `Horizontal drag drifted at zoom ${targetZoom}`);
      assert(Math.abs(after.y - before.y - 9) < 0.15, `Vertical drag drifted at zoom ${targetZoom}`);
      assert.equal((await state()).history, history + 1);
      await page.evaluate(() => window.__notesQaStore.getState().undo());
      assert.deepEqual((await state()).objects.find((object) => object.id === imageId), before);
    }
    await stage.evaluate((element) => {
      element.scrollTop = 0;
      element.scrollLeft = 0;
    });
    await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.85));
    await page.waitForTimeout(100);
  });

  await check("rotated image clamps at the page edge without changing size or asset", async () => {
    await page.evaluate((id) => {
      const s = window.__notesQaStore.getState();
      const sourceId = s.pages[0].id;
      s.commitObjects(sourceId, s.objectsByPage[sourceId].map((object) => (
        object.id === id ? { ...object, rotation: 37 } : object
      )), false);
    }, imageId);
    const before = (await state()).objects.find((candidate) => candidate.id === imageId);
    const history = (await state()).history;
    await selectIds(pageId, [imageId]);
    const from = await point(before.x + before.w / 2, before.y + before.h / 2);
    const pageRecord = (await state()).page;
    const target = await point(pageRecord.width - 1, pageRecord.height - 1);
    await dragFromTo(from, target);
    const after = (await state()).objects.find((candidate) => candidate.id === imageId);
    const box = rotatedBox(after);
    assert(box.x >= -0.05 && box.y >= -0.05);
    assert(box.x + box.w <= pageRecord.width + 0.05);
    assert(box.y + box.h <= pageRecord.height + 0.05);
    assert.equal(after.w, before.w);
    assert.equal(after.h, before.h);
    assert.equal(after.rotation, before.rotation);
    assert.equal(after.assetId, before.assetId);
    assert.equal((await state()).history, history + 1);
    await page.evaluate(() => window.__notesQaStore.getState().undo());
    assert.deepEqual((await state()).objects.find((candidate) => candidate.id === imageId), before);
  });

  await check("oversized objects stay selectable and impossible groups roll back atomically", async () => {
    const originals = (await state()).objects;
    const originalImage = originals.find((object) => object.id === imageId);
    const originalText = originals.find((object) => object.id === textId);
    const record = (await state()).page;
    await page.evaluate(({ id, width, height }) => {
      const s = window.__notesQaStore.getState();
      const sourceId = s.pages[0].id;
      s.commitObjects(sourceId, s.objectsByPage[sourceId].map((object) => (
        object.id === id
          ? { ...object, x: -80, y: -100, w: width + 220, h: height + 260 }
          : object
      )), false);
    }, { id: imageId, width: record.width, height: record.height });
    const oversized = (await state()).objects.find((object) => object.id === imageId);
    const history = (await state()).history;
    await selectIds(pageId, [imageId]);
    const from = await pageClientPoint(pageId, record.width / 2, record.height / 2);
    const to = await pageClientPoint(pageId, 2, 2);
    await dragFromTo(from, to);
    const moved = (await state()).objects.find((object) => object.id === imageId);
    const box = rotatedBox(moved);
    assert(visibleLength(box.x, box.w, record.width) >= 48 - 0.1);
    assert(visibleLength(box.y, box.h, record.height) >= 48 - 0.1);
    assert.equal(moved.w, oversized.w);
    assert.equal(moved.h, oversized.h);
    assert.equal(moved.rotation, oversized.rotation);
    assert.equal(moved.assetId, oversized.assetId);
    assert.equal((await state()).history, history + 1);
    await page.evaluate(() => window.__notesQaStore.getState().undo());

    await page.evaluate(({ textId, imageId }) => {
      const s = window.__notesQaStore.getState();
      const sourceId = s.pages[0].id;
      s.commitObjects(sourceId, s.objectsByPage[sourceId].map((object) => {
        if (object.id === textId) return { ...object, x: 20, y: 100 };
        if (object.id === imageId) return { ...object, x: 1_000, y: 160, w: 180, h: 100 };
        return object;
      }), false);
    }, { textId, imageId });
    await selectIds(pageId, [textId, imageId]);
    const impossibleBefore = await allObjectState();
    const textStart = await pageClientPoint(pageId, 20 + originalText.w / 2, 100 + originalText.h / 2);
    await dragFromTo(textStart, { x: textStart.x + 30, y: textStart.y + 20 });
    assert.deepEqual(await allObjectState(), impossibleBefore, "An impossible group must not move only its visible member");

    await page.evaluate(({ originals }) => {
      const s = window.__notesQaStore.getState();
      s.commitObjects(s.pages[0].id, originals, false);
    }, { originals });
    assert.deepEqual((await state()).objects.find((object) => object.id === imageId), originalImage);
    assert.deepEqual((await state()).objects.find((object) => object.id === textId), originalText);
  });

  await check("a selected group moves by one shared delta and one Undo step", async () => {
    const before = (await state()).objects.filter((object) => [textId, imageId].includes(object.id));
    const history = (await state()).history;
    await selectIds(pageId, [textId, imageId]);
    const anchor = before.find((object) => object.id === textId);
    const from = await point(anchor.x + anchor.w / 2, anchor.y + anchor.h / 2);
    const zoom = (await state()).zoom;
    await dragFromTo(from, { x: from.x + 24 * zoom, y: from.y + 18 * zoom });
    const after = (await state()).objects.filter((object) => [textId, imageId].includes(object.id));
    for (const original of before) {
      const moved = after.find((object) => object.id === original.id);
      assert(Math.abs(moved.x - original.x - 24) < 0.15);
      assert(Math.abs(moved.y - original.y - 18) < 0.15);
    }
    assert.equal((await state()).history, history + 1);
    await page.evaluate(() => window.__notesQaStore.getState().undo());
    const restored = (await state()).objects.filter((object) => [textId, imageId].includes(object.id));
    assert.deepEqual(restored, before);
  });

  await check("drag merge and Undo preserve an unrelated concurrent text edit", async () => {
    const beforeImage = (await state()).objects.find((object) => object.id === imageId);
    const beforeText = (await state()).objects.find((object) => object.id === textId);
    const history = (await state()).history;
    await selectIds(pageId, [imageId]);
    const from = await point(beforeImage.x + beforeImage.w / 2, beforeImage.y + beforeImage.h / 2);
    const zoom = (await state()).zoom;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 18 * zoom, from.y + 12 * zoom, { steps: 6 });
    await page.evaluate(({ id, suffix }) => {
      const s = window.__notesQaStore.getState();
      const sourceId = s.pages[0].id;
      s.commitObjects(sourceId, s.objectsByPage[sourceId].map((object) => (
        object.id === id ? { ...object, text: object.text + suffix } : object
      )), false);
    }, { id: textId, suffix: "\nChỉnh sửa song song." });
    await page.mouse.up();
    await page.waitForTimeout(80);
    const committed = await state();
    assert.equal(committed.objects.find((object) => object.id === textId).text, beforeText.text + "\nChỉnh sửa song song.");
    assert(Math.abs(committed.objects.find((object) => object.id === imageId).x - beforeImage.x - 18) < 0.15);
    assert.equal(committed.history, history + 1);
    await page.evaluate(() => window.__notesQaStore.getState().undo());
    const undone = await state();
    assert.deepEqual(undone.objects.find((object) => object.id === imageId), beforeImage);
    assert.equal(undone.objects.find((object) => object.id === textId).text, beforeText.text + "\nChỉnh sửa song song.");
  });

  await check("rapid text switching commits each draft only once", async () => {
    await page.getByRole("button", { name: /^Chữ, cỡ/ }).click();
    await clickPoint(40, 560);
    await editor().fill("Bản nháp thứ nhất");
    await clickPoint(40, 650);
    await editor().fill("Bản nháp thứ hai");
    await editor().press("Control+Enter");
    const texts = (await state()).objects.filter((o) => o.type === "text");
    assert.equal(texts.filter((o) => o.text === "Bản nháp thứ nhất").length, 1);
    assert.equal(texts.filter((o) => o.text === "Bản nháp thứ hai").length, 1);
    await page.evaluate(() => {
      const s = window.__notesQaStore.getState();
      s.commitObjects(s.pages[0].id, s.objectsByPage[s.pages[0].id].filter((o) => !o.text?.startsWith("Bản nháp")));
    });
    await page.getByRole("button", { name: "Lasso", exact: true }).click();
  });

  await check("cross-page move undo and redo restore both pages without duplicates", async () => {
    await page.evaluate(async (imageId) => {
      const store = window.__notesQaStore;
      await store.getState().addPage();
      const s = store.getState();
      const [source, destination] = s.pages;
      const original = s.objectsByPage[source.id];
      const target = s.objectsByPage[destination.id] ?? [];
      const image = original.find((o) => o.id === imageId);
      s.commitObjectPages({
        [source.id]: original.filter((o) => o.id !== imageId),
        [destination.id]: [...target, { ...image, x: 40, y: 50 }],
      });
      s.undo();
      const undone = store.getState().objectsByPage;
      if (JSON.stringify(undone[source.id]) !== JSON.stringify(original) || undone[destination.id].some((o) => o.id === imageId)) throw Error("Undo duplicated or lost image");
      s.redo();
      const redone = store.getState().objectsByPage;
      if (redone[source.id].some((o) => o.id === imageId) || redone[destination.id].filter((o) => o.id === imageId).length !== 1) throw Error("Redo duplicated image");
      s.undo();
      await store.getState().deletePage(destination.id);
      store.getState().setPageIndex(0);
    }, imageId);
  });

  await check("empty existing text cancels back to its prior value", async () => {
    const object = (await state()).objects.find((o) => o.id === textId);
    const history = (await state()).history;
    await clickPoint(object.x + 40, object.y + 15, { clickCount: 2 });
    await editor().fill("");
    await editor().press("Control+Enter");
    await editor().waitFor({ state: "detached" });
    assert.equal(
      (await state()).objects.find((o) => o.id === textId)?.text,
      longText + "\nChỉnh sửa song song.",
    );
    assert.equal((await state()).history, history, "Cancelling an empty edit must not add history");
  });

  await check("real pointer handles page gaps, mixed sizes, rotations, and atomic repeated Undo/Redo", async () => {
    const pageIds = await page.evaluate(async ({ textId, imageId }) => {
      const store = window.__notesQaStore;
      await store.getState().addPage();
      const s = store.getState();
      const [source, target] = s.pages;
      s.commitObjects(source.id, s.objectsByPage[source.id].map((object) => {
        if (object.id === textId) return { ...object, x: 30, y: 40 };
        if (object.id === imageId) return { ...object, x: 155, y: 200 };
        return object;
      }), false);
      const now = Date.now();
      const patchedSource = { ...source, rotation: 270, updatedAt: now };
      const patchedTarget = {
        ...target,
        width: 419.53,
        height: 595.28,
        rotation: 90,
        updatedAt: now,
      };
      store.setState({
        pages: s.pages.map((record) => (
          record.id === source.id ? patchedSource : record.id === target.id ? patchedTarget : record
        )),
      });
      const db = await import("/src/lib/notes/db.ts");
      await db.putPage(patchedSource);
      await db.putPage(patchedTarget);
      store.getState().persistSettings({ pageMode: "continuous" });
      store.getState().setPageIndex(0);
      store.getState().setZoom(0.4);
      return { sourceId: source.id, targetId: target.id };
    }, { textId, imageId });
    await page.waitForTimeout(240);
    await selectIds(pageIds.sourceId, [textId, imageId]);
    const originals = (await state()).objects.filter((object) => [textId, imageId].includes(object.id));
    const original = originals.find((object) => object.id === imageId);
    const grab = {
      x: original.x + original.w * 0.35,
      y: original.y + original.h * 0.4,
    };
    const from = await pageClientPoint(pageIds.sourceId, grab.x, grab.y);

    const sourceBox = await page.locator(`[data-page-id="${pageIds.sourceId}"]`).boundingBox();
    const targetBox = await page.locator(`[data-page-id="${pageIds.targetId}"]`).boundingBox();
    assert(sourceBox && targetBox && targetBox.y > sourceBox.y + sourceBox.height, "Continuous pages must expose a real gap");
    const gap = {
      x: sourceBox.x + sourceBox.width / 2,
      y: (sourceBox.y + sourceBox.height + targetBox.y) / 2,
    };
    const beforeGap = await allObjectState();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(gap.x, gap.y, { steps: 10 });
    assert.equal(await page.locator('[data-notes-drag-preview="true"]').count(), 1, "Active drag should use one floating preview");
    assert.equal(await page.locator(`[data-page-id="${pageIds.sourceId}"] [data-selection-box="true"]`).count(), 0, "Source selection frame must not duplicate the preview");
    await page.mouse.up();
    await page.waitForTimeout(80);
    assert.deepEqual(await allObjectState(), beforeGap, "A page gap must be an invalid destination");

    const history = (await state()).history;
    const destination = { x: grab.x + 5, y: grab.y + 15 };
    const to = await pageClientPoint(pageIds.targetId, destination.x, destination.y);
    await dragFromTo(from, to, { steps: 14 });
    const moved = await page.evaluate(({ sourceId, targetId }) => {
      const s = window.__notesQaStore.getState();
      return {
        source: s.objectsByPage[sourceId],
        target: s.objectsByPage[targetId],
        history: s.history[s.activeNotebookId].past.length,
      };
    }, pageIds);
    assert(!moved.source.some((object) => [textId, imageId].includes(object.id)), "Source must release the complete group");
    assert.equal(moved.target.filter((object) => object.id === textId).length, 1, "Destination must receive text exactly once");
    assert.equal(moved.target.filter((object) => object.id === imageId).length, 1, "Destination must receive image exactly once");
    const landed = moved.target.find((object) => object.id === imageId);
    assert(landed, "Rotated target page must receive the image");
    assert(Math.abs(landed.x - (destination.x - (grab.x - original.x))) < 0.2, "Off-center horizontal grab point must stay under the pointer");
    assert(Math.abs(landed.y - (destination.y - (grab.y - original.y))) < 0.2, "Off-center vertical grab point must stay under the pointer");
    assert.equal(landed.id, original.id);
    assert.equal(landed.assetId, original.assetId);
    assert.equal(landed.rotation, original.rotation);
    assert.equal(landed.w, original.w);
    assert.equal(landed.h, original.h);
    const sharedDelta = { x: destination.x - grab.x, y: destination.y - grab.y };
    for (const sourceObject of originals) {
      const targetObject = moved.target.find((object) => object.id === sourceObject.id);
      assert(Math.abs(targetObject.x - sourceObject.x - sharedDelta.x) < 0.2);
      assert(Math.abs(targetObject.y - sourceObject.y - sharedDelta.y) < 0.2);
    }
    assert.equal(moved.history, history + 1, "Cross-page drag must create exactly one Undo entry");
    assert.equal(await page.locator(`[data-page-id="${pageIds.targetId}"] [data-selection-box="true"]`).count(), 1, "Moved group should stay selected on its destination page");
    const landedState = structuredClone(moved);

    await page.evaluate(() => window.__notesQaStore.getState().undo());
    let roundTrip = await page.evaluate(({ sourceId, targetId }) => {
      const s = window.__notesQaStore.getState();
      return { source: s.objectsByPage[sourceId], target: s.objectsByPage[targetId] };
    }, pageIds);
    for (const sourceObject of originals) {
      assert.deepEqual(roundTrip.source.find((object) => object.id === sourceObject.id), sourceObject);
      assert(!roundTrip.target.some((object) => object.id === sourceObject.id));
    }
    await page.evaluate(() => window.__notesQaStore.getState().redo());
    roundTrip = await page.evaluate(({ sourceId, targetId }) => {
      const s = window.__notesQaStore.getState();
      return { source: s.objectsByPage[sourceId], target: s.objectsByPage[targetId] };
    }, pageIds);
    assert.deepEqual(roundTrip.source, landedState.source);
    assert.deepEqual(roundTrip.target, landedState.target);
    await page.evaluate(() => {
      const s = window.__notesQaStore.getState();
      s.undo();
      s.redo();
      s.undo();
    });
    roundTrip = await page.evaluate(({ sourceId, targetId }) => {
      const s = window.__notesQaStore.getState();
      return { source: s.objectsByPage[sourceId], target: s.objectsByPage[targetId] };
    }, pageIds);
    for (const sourceObject of originals) {
      assert.deepEqual(roundTrip.source.find((object) => object.id === sourceObject.id), sourceObject);
      assert(!roundTrip.target.some((object) => object.id === sourceObject.id));
    }

    await page.evaluate(async ({ sourceId, targetId }) => {
      const store = window.__notesQaStore;
      store.getState().setPageIndex(0);
      await store.getState().deletePage(targetId);
      const source = store.getState().pages.find((record) => record.id === sourceId);
      const restored = { ...source, rotation: 0, updatedAt: Date.now() };
      store.setState({ pages: store.getState().pages.map((record) => record.id === sourceId ? restored : record) });
      const db = await import("/src/lib/notes/db.ts");
      await db.putPage(restored);
      store.getState().redo();
      if (store.getState().objectsByPage[targetId]) throw new Error("Redo recreated a deleted destination page");
      store.getState().setZoom(0.85);
    }, pageIds);
    await page.waitForTimeout(120);
  });

  await check("reload preserves text and resized image", async () => {
    await page.evaluate(() => window.__notesQaStore.getState().flushPendingWrites());
    const before = (await state()).objects;
    await page.reload({ waitUntil: "networkidle" });
    await readyStore();
    await page.waitForSelector("[data-page-id] canvas");
    assert.deepEqual((await state()).objects, before);
    await page.screenshot({ path: resolve(output, "notes-interaction-desktop.png"), fullPage: true });
  });

  await check("mobile notebook renders without page overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await readyStore();
    await page.waitForSelector("[data-page-id] canvas");
    await page.waitForTimeout(200);
    const metrics = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
    assert(metrics.document <= metrics.viewport + 1, "Mobile document must not overflow horizontally");
    const box = await page.locator(`[data-page-id="${pageId}"]`).boundingBox();
    assert(box.width > 200 && box.width <= 390, "Page should fit mobile viewport");
    await page.screenshot({ path: resolve(output, "notes-interaction-mobile.png"), fullPage: true });
  });

  assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`);
  finalResult = { ok: true, checks, browserErrors: errors, platformWarnings, failedRequests, screenshots: ["notes-interaction-desktop.png", "notes-interaction-mobile.png"] };
} catch (error) {
  await page.screenshot({ path: resolve(output, "notes-interaction-failure.png"), fullPage: true }).catch(() => {});
  finalResult = { ok: false, checks, error: error.stack ?? String(error), browserErrors: errors, failedRequests };
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(output, "notes-interaction-qa.json"), JSON.stringify(finalResult, null, 2));
  console.log(JSON.stringify(finalResult, null, 2));
  await context.close();
  await browser.close();
}
