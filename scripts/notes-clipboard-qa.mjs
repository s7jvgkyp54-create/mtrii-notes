#!/usr/bin/env node
// Browser clipboard regression pass. It uses a disposable Chromium context and
// a synthetic notebook only. Clipboard input is written through the real
// navigator.clipboard API and consumed through trusted Ctrl+C/X/V keystrokes;
// this file intentionally never constructs or dispatches a ClipboardEvent.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8080";
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  "Clipboard QA requires a loopback development server",
);

const output = resolve("screenshots");
const reportPath = resolve(output, "notes-clipboard-qa.json");
const failureScreenshot = resolve(output, "notes-clipboard-failure.png");
mkdirSync(output, { recursive: true });

const checks = [];
const errors = [];
const failedRequests = [];
const platformWarnings = [];
const clipboardEvents = [];
const limitations = [
  "The trusted Ctrl+X failure case forces Chromium's real cut-event DataTransfer.setData calls to throw; it verifies browser source/history safety, but is not a real OS/WebView permission denial.",
  "Tauri/native clipboard interaction is intentionally not exercised; this pass refuses desktop runtime and uses disposable browser storage.",
];
const raceInstrumentation = {
  kind: "one-shot held/released createImageBitmap preview decode",
  gatedAssignments: 0,
};
let clipboardCapabilities = null;
let finalResult;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.BROWSER_CHROMIUM_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
// A one-shot, opt-in gate around the next Blob bitmap decode lets
// the race checks hold the first real PNG paste in its decode path. The hook
// does not alter clipboard events or payloads, and is inert unless a test arms
// it immediately before pressing Ctrl+V.
await page.addInitScript(() => {
  const original = globalThis.createImageBitmap?.bind(globalThis);
  if (!original) return;
  globalThis.createImageBitmap = (...args) => {
    if (window.__notesQaHoldNextBitmapDecode && args[0] instanceof Blob) {
      window.__notesQaHoldNextBitmapDecode = false;
      window.__notesQaGatedBitmapDecodes = Number(window.__notesQaGatedBitmapDecodes ?? 0) + 1;
      return new Promise((resolve, reject) => {
        window.__notesQaReleaseHeldBitmapDecode = () => {
          window.__notesQaReleaseHeldBitmapDecode = null;
          original(...args).then(resolve, reject);
        };
      });
    }
    return original(...args);
  };
});
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const detail = `${message.text()} (${message.location().url})`;
  if (
    message.location().url === "https://grok.com/grok-app-builder/extensions.js" &&
    message.text().includes("ERR_BLOCKED_BY_RESPONSE.NotSameOrigin")
  ) {
    platformWarnings.push(detail);
  } else {
    errors.push(detail);
  }
});
page.on("requestfailed", (request) =>
  failedRequests.push({ url: request.url(), error: request.failure()?.errorText }),
);

let notebookId;
let pageId;

async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function attachStore() {
  await page.evaluate(async () => {
    if ("__TAURI_INTERNALS__" in window) {
      throw new Error("Refusing to run browser clipboard QA against Tauri/native storage");
    }
    // Match the exact Vite/HMR module instance mounted by React.
    const loaded = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .findLast((url) => new URL(url).pathname === "/src/lib/notes/store.ts");
    window.__notesQaStore = (await import(loaded ?? "/src/lib/notes/store.ts")).useNotesStore;
    window.__notesQaDb = await import("/src/lib/notes/db.ts");
  });
  await page.waitForFunction(() => window.__notesQaStore?.getState().ready);
}

async function state() {
  return page.evaluate(() => {
    const store = window.__notesQaStore.getState();
    const activePage = store.pages[store.currentPageIndex] ?? store.pages[0];
    const history = store.history[store.activeNotebookId];
    return {
      activeNotebookId: store.activeNotebookId,
      page: activePage,
      pages: store.pages,
      currentPageIndex: store.currentPageIndex,
      objects: activePage ? (store.objectsByPage[activePage.id] ?? []) : [],
      objectsByPage: store.objectsByPage,
      historyPast: history?.past.length ?? 0,
      historyFuture: history?.future.length ?? 0,
      zoom: store.zoom,
      saveStatus: store.saveStatus,
    };
  });
}

async function point(x, y) {
  const box = await page.locator(`[data-page-id="${pageId}"]`).boundingBox();
  assert(box, "The active page must be visible");
  const current = await state();
  return { x: box.x + x * current.zoom, y: box.y + y * current.zoom };
}

async function clickPoint(x, y, options) {
  const target = await point(x, y);
  await page.mouse.click(target.x, target.y, options);
}

async function pageObjects(targetPageId) {
  return page.evaluate(
    (id) => window.__notesQaStore.getState().objectsByPage[id] ?? [],
    targetPageId,
  );
}

async function waitForPageObjectCount(targetPageId, count) {
  await page.waitForFunction(
    ({ id, expected }) =>
      (window.__notesQaStore.getState().objectsByPage[id] ?? []).length === expected,
    { id: targetPageId, expected: count },
  );
}

async function setActivePage(index) {
  await page.evaluate((nextIndex) => {
    window.__notesQaStore.getState().setPageIndex(nextIndex);
  }, index);
  await page.waitForFunction(
    (nextIndex) => window.__notesQaStore.getState().currentPageIndex === nextIndex,
    index,
  );
  await page.waitForTimeout(80);
}

async function screenPointForObjectCenter(targetPageId, objectId) {
  const center = await page.evaluate(
    ({ targetPage, targetObject }) => {
      const store = window.__notesQaStore.getState();
      const object = (store.objectsByPage[targetPage] ?? []).find(
        (candidate) => candidate.id === targetObject,
      );
      if (!object || !("x" in object) || !("y" in object)) return null;
      return { x: object.x + object.w / 2, y: object.y + object.h / 2 };
    },
    { targetPage: targetPageId, targetObject: objectId },
  );
  assert(center, "The pasted object must have selectable page coordinates");
  return screenPointForPagePoint(targetPageId, center.x, center.y);
}

async function screenPointForPagePoint(targetPageId, x, y) {
  const box = await page.locator(`[data-page-id="${targetPageId}"]`).boundingBox();
  assert(box, "The target page must be visible");
  const geometry = await page.evaluate(
    ({ targetPage, pageX, pageY }) => {
      const store = window.__notesQaStore.getState();
      const pageRecord = store.pages.find((candidate) => candidate.id === targetPage);
      if (!pageRecord) return null;
      let display;
      if (pageRecord.rotation === 90) display = { x: pageRecord.height - pageY, y: pageX };
      else if (pageRecord.rotation === 180) {
        display = { x: pageRecord.width - pageX, y: pageRecord.height - pageY };
      } else if (pageRecord.rotation === 270) {
        display = { x: pageY, y: pageRecord.width - pageX };
      } else display = { x: pageX, y: pageY };
      return { display, zoom: store.zoom, pageRecord };
    },
    { targetPage: targetPageId, pageX: x, pageY: y },
  );
  assert(geometry, "The target page geometry must exist");
  return {
    x: box.x + geometry.display.x * geometry.zoom,
    y: box.y + geometry.display.y * geometry.zoom,
  };
}

async function setPageRotation(targetPageId, desiredRotation) {
  await page.evaluate(
    async ({ targetPage, targetRotation }) => {
      for (let turn = 0; turn < 4; turn += 1) {
        const store = window.__notesQaStore.getState();
        const pageRecord = store.pages.find((candidate) => candidate.id === targetPage);
        if (!pageRecord) throw new Error("QA target page no longer exists");
        if (pageRecord.rotation === targetRotation) return;
        await store.rotatePage(targetPage);
      }
      throw new Error("Could not reach requested QA page rotation");
    },
    { targetPage: targetPageId, targetRotation: desiredRotation },
  );
  await page.waitForFunction(
    ({ targetPage, targetRotation }) =>
      window.__notesQaStore.getState().pages.find((candidate) => candidate.id === targetPage)
        ?.rotation === targetRotation,
    { targetPage: targetPageId, targetRotation: desiredRotation },
  );
}

async function assetInventory() {
  return page.evaluate(async () => {
    const dump = await window.__notesQaDb.dumpAll();
    return dump.assets
      .map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        mime: asset.mime,
        byteLength: asset.byteLength,
        blobSize: asset.blob.size,
        blobType: asset.blob.type,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  });
}

async function assetFingerprint(assetId) {
  return page.evaluate(async (id) => {
    const asset = await window.__notesQaDb.getAsset(id);
    if (!asset) return null;
    const bytes = await asset.blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const bitmap = await createImageBitmap(asset.blob);
    const decoded = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return {
      id: asset.id,
      kind: asset.kind,
      mime: asset.mime,
      byteLength: asset.byteLength,
      blobSize: asset.blob.size,
      blobType: asset.blob.type,
      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
      ),
      decoded,
    };
  }, assetId);
}

async function blurActiveElement() {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

async function selectObjects(ids) {
  await blurActiveElement();
  await page.evaluate(
    ({ activePageId, objectIds }) => {
      window.dispatchEvent(
        new CustomEvent("notes-select-objects", {
          detail: { pageId: activePageId, objectIds },
        }),
      );
    },
    { activePageId: pageId, objectIds: ids },
  );
  await page.waitForTimeout(80);
}

async function insertObjects(objects) {
  return page.evaluate(
    ({ activePageId, input }) => {
      const store = window.__notesQaStore.getState();
      const withIds = input.map((object) => ({ ...object, id: crypto.randomUUID() }));
      const current = store.objectsByPage[activePageId] ?? [];
      store.commitObjects(activePageId, [...current, ...withIds], true);
      return withIds;
    },
    { activePageId: pageId, input: objects },
  );
}

async function writeClipboardText(text) {
  return page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
    // Windows normalizes LF to CRLF in the system clipboard. Read the value
    // back so assertions compare with the exact text Chromium will deliver in
    // the trusted paste event, rather than the pre-clipboard JS string.
    return navigator.clipboard.readText();
  }, text);
}

async function writeClipboardPng(width, height) {
  await page.evaluate(
    async ({ imageWidth, imageHeight }) => {
      const canvas = document.createElement("canvas");
      canvas.width = imageWidth;
      canvas.height = imageHeight;
      const context2d = canvas.getContext("2d");
      if (!context2d) throw new Error("2D canvas is unavailable");
      context2d.fillStyle = "#0F766E";
      context2d.fillRect(0, 0, imageWidth, imageHeight);
      context2d.fillStyle = "#F4A261";
      context2d.fillRect(10, 10, imageWidth - 20, imageHeight - 20);
      const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, "image/png"));
      if (!blob) throw new Error("Could not encode the clipboard PNG");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    },
    { imageWidth: width, imageHeight: height },
  );
}

async function waitForObjectCount(count) {
  await page.waitForFunction(
    ({ activePageId, expected }) =>
      (window.__notesQaStore.getState().objectsByPage[activePageId] ?? []).length === expected,
    { activePageId: pageId, expected: count },
  );
}

async function installClipboardObserver() {
  await page.evaluate(() => {
    if (window.__notesClipboardQaObserverInstalled) return;
    window.__notesClipboardQaObserverInstalled = true;
    window.__notesClipboardQaEvents = [];
    for (const type of ["copy", "cut", "paste"]) {
      document.addEventListener(
        type,
        (event) => {
          window.__notesClipboardQaEvents.push({
            type,
            trusted: event.isTrusted,
            types: Array.from(event.clipboardData?.types ?? []),
          });
        },
        true,
      );
    }
  });
}

async function harvestClipboardEvents() {
  const events = await page.evaluate(() => {
    const captured = window.__notesClipboardQaEvents ?? [];
    window.__notesClipboardQaEvents = [];
    return captured;
  });
  clipboardEvents.push(...events);
}

async function currentClipboardEventCount() {
  return page.evaluate(() => (window.__notesClipboardQaEvents ?? []).length);
}

async function clipboardEventsSince(start) {
  return page.evaluate((index) => (window.__notesClipboardQaEvents ?? []).slice(index), start);
}

async function forceNavigatorClipboardWriteRejection() {
  await page.evaluate(() => {
    const clipboard = navigator.clipboard;
    if (!clipboard || window.__notesQaRestoreClipboardWrite) {
      throw new Error("Clipboard write fallback hook cannot be installed");
    }
    const ownDescriptor = Object.getOwnPropertyDescriptor(clipboard, "write");
    window.__notesQaPoisonedClipboardWriteCalls = 0;
    Object.defineProperty(clipboard, "write", {
      configurable: true,
      value: () => {
        window.__notesQaPoisonedClipboardWriteCalls =
          Number(window.__notesQaPoisonedClipboardWriteCalls ?? 0) + 1;
        return Promise.reject(new DOMException("QA poisoned navigator write", "NotAllowedError"));
      },
    });
    window.__notesQaRestoreClipboardWrite = () => {
      if (ownDescriptor) Object.defineProperty(clipboard, "write", ownDescriptor);
      else delete clipboard.write;
      window.__notesQaRestoreClipboardWrite = null;
    };
  });
}

async function restoreNavigatorClipboardWrite() {
  return page.evaluate(() => {
    const calls = Number(window.__notesQaPoisonedClipboardWriteCalls ?? 0);
    const restore = window.__notesQaRestoreClipboardWrite;
    if (typeof restore === "function") restore();
    return calls;
  });
}

async function dataTransferSetDataIsPatchable() {
  return page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(DataTransfer.prototype, "setData");
    return Boolean(descriptor && (descriptor.configurable || descriptor.writable));
  });
}

async function armClipboardSetDataFailure() {
  return page.evaluate(() => {
    if (window.__notesQaRestoreDataTransferSetData) {
      throw new Error("A clipboard DataTransfer failure hook is already installed");
    }
    const prototype = DataTransfer.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "setData");
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new Error("DataTransfer.setData descriptor is unavailable");
    }
    const original = descriptor.value;
    const replacement = function setData(type, value) {
      if (window.__notesQaRejectClipboardSetData) {
        window.__notesQaRejectedClipboardSetDataCount =
          Number(window.__notesQaRejectedClipboardSetDataCount ?? 0) + 1;
        throw new DOMException(`QA rejected ${type}`, "NotAllowedError");
      }
      return original.call(this, type, value);
    };
    Object.defineProperty(prototype, "setData", { ...descriptor, value: replacement });
    window.__notesQaRejectedClipboardSetDataCount = 0;
    window.__notesQaRejectClipboardSetData = true;
    window.__notesQaRestoreDataTransferSetData = () => {
      window.__notesQaRejectClipboardSetData = false;
      Object.defineProperty(prototype, "setData", descriptor);
      window.__notesQaRestoreDataTransferSetData = null;
    };
  });
}

async function restoreClipboardSetData() {
  return page.evaluate(() => {
    const attempts = Number(window.__notesQaRejectedClipboardSetDataCount ?? 0);
    const restore = window.__notesQaRestoreDataTransferSetData;
    if (typeof restore === "function") restore();
    return attempts;
  });
}

async function holdNextBitmapDecode() {
  const before = await page.evaluate(() => Number(window.__notesQaGatedBitmapDecodes ?? 0));
  await page.evaluate(() => {
    if (window.__notesQaReleaseHeldBitmapDecode) {
      throw new Error("A previous QA image gate is still held");
    }
    window.__notesQaHoldNextBitmapDecode = true;
  });
  return before;
}

async function waitForHeldBitmapDecode(before) {
  await page.waitForFunction(
    (previous) => Number(window.__notesQaGatedBitmapDecodes ?? 0) > previous,
    before,
  );
  raceInstrumentation.gatedAssignments += 1;
}

async function releaseHeldBitmapDecode() {
  await page.evaluate(() => {
    const release = window.__notesQaReleaseHeldBitmapDecode;
    if (typeof release !== "function") throw new Error("No QA image decode is being held");
    release();
  });
}

function additions(before, after) {
  const priorIds = new Set(before.map((object) => object.id));
  return after.filter((object) => !priorIds.has(object.id));
}

function assertPreserved(actual, source, keys) {
  for (const key of keys) {
    assert.deepEqual(actual[key], source[key], `Expected copied ${key} to be preserved`);
  }
}

try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await attachStore();

  clipboardCapabilities = await page.evaluate(() => ({
    isSecureContext,
    hasClipboard: Boolean(navigator.clipboard),
    hasReadText: typeof navigator.clipboard?.readText === "function",
    hasWriteText: typeof navigator.clipboard?.writeText === "function",
    hasWrite: typeof navigator.clipboard?.write === "function",
    hasClipboardItem: typeof ClipboardItem === "function",
  }));
  assert.equal(clipboardCapabilities.isSecureContext, true, "Clipboard QA needs a secure context");
  assert.equal(
    clipboardCapabilities.hasWriteText,
    true,
    "navigator.clipboard.writeText is required",
  );
  assert.equal(clipboardCapabilities.hasWrite, true, "navigator.clipboard.write is required");
  assert.equal(clipboardCapabilities.hasClipboardItem, true, "ClipboardItem is required");

  notebookId = await page.evaluate(async () => {
    const store = window.__notesQaStore.getState();
    store.persistSettings({ autoBackup: false, autoCheckUpdates: false });
    return store.createNotebook({
      name: "QA — clipboard thật",
      folderId: null,
      cover: "#0F766E",
      paper: { pattern: "blank", color: "#FFFEFB", lineColor: "#D6D3CD" },
      pageSize: "a4",
      orientation: "portrait",
      pages: 1,
    });
  });
  await page.goto(`${origin}/notebook/${notebookId}`, { waitUntil: "networkidle" });
  await attachStore();
  await page.waitForSelector("[data-page-id] canvas");
  pageId = (await state()).page.id;
  await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.85));
  await page.waitForTimeout(150);

  // Observe only; these listeners never fabricate clipboard events. Trusted
  // flags in the report prove that Chromium generated the events from keys.
  await installClipboardObserver();

  let resizedImage;
  await check(
    "Ctrl+C/V preserves resized and rotated Notes image with the same asset",
    async () => {
      await page.getByRole("button", { name: "Lasso", exact: true }).click();
      await clickPoint(390, 455);
      const beforeExternalPaste = await state();
      await writeClipboardPng(120, 80);
      await page.keyboard.press("Control+V");
      await waitForObjectCount(beforeExternalPaste.objects.length + 1);

      const inserted = additions(beforeExternalPaste.objects, (await state()).objects);
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0].type, "image");
      assert.equal(inserted[0].w, 120);
      assert.equal(inserted[0].h, 80);

      await page.getByRole("button", { name: "Phóng to", exact: true }).click();
      await page.getByRole("button", { name: "Xoay 15 độ", exact: true }).click();
      resizedImage = (await state()).objects.find((object) => object.id === inserted[0].id);
      assert(resizedImage);
      assert.equal(resizedImage.w, 132);
      assert.equal(resizedImage.h, 88);
      assert.equal(resizedImage.rotation, 15);

      const beforeCopyPaste = await state();
      await page.keyboard.press("Control+C");
      await page.keyboard.press("Control+V");
      await waitForObjectCount(beforeCopyPaste.objects.length + 1);
      const pasted = additions(beforeCopyPaste.objects, (await state()).objects);
      assert.equal(pasted.length, 1);
      assert.equal(pasted[0].type, "image");
      assert.notEqual(pasted[0].id, resizedImage.id);
      assertPreserved(pasted[0], resizedImage, ["w", "h", "rotation", "assetId"]);
    },
  );

  await check("Copy button uses the same rich Notes clipboard payload", async () => {
    const selectedImage = (await state()).objects
      .filter((object) => object.type === "image")
      .at(-1);
    assert(selectedImage);
    await selectObjects([selectedImage.id]);
    const copyButton = page.getByRole("button", { name: "Sao chép", exact: true });
    await copyButton.waitFor({ state: "visible" });
    const before = await state();
    await copyButton.click();
    await page.waitForTimeout(120);
    await blurActiveElement();
    await page.keyboard.press("Control+V");
    await waitForObjectCount(before.objects.length + 1);
    const pasted = additions(before.objects, (await state()).objects);
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0].type, "image");
    assert.notEqual(pasted[0].id, selectedImage.id);
    assertPreserved(pasted[0], selectedImage, ["w", "h", "rotation", "assetId"]);
  });

  await check("new external text overrides a previously copied Notes image", async () => {
    const sourceImage = (await state()).objects.find((object) => object.id === resizedImage.id);
    assert(sourceImage);
    await selectObjects([sourceImage.id]);
    await page.keyboard.press("Control+C");

    const externalText = "Tiếng Việt 🙂 từ ứng dụng ngoài\n  giữ nguyên khoảng trắng  ";
    const clipboardText = await writeClipboardText(externalText);
    await clickPoint(430, 610);
    const before = await state();
    const imageCount = before.objects.filter((object) => object.type === "image").length;
    await page.keyboard.press("Control+V");
    await waitForObjectCount(before.objects.length + 1);
    const after = await state();
    const pasted = additions(before.objects, after.objects);
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0].type, "text");
    assert.equal(pasted[0].text, clipboardText);
    assert.equal(after.objects.filter((object) => object.type === "image").length, imageCount);
  });

  let formattedText;
  await check("formatted Notes text survives Ctrl+C/V", async () => {
    [formattedText] = await insertObjects([
      {
        type: "text",
        x: 65,
        y: 255,
        w: 278,
        h: 94,
        text: "Dòng một  có hai khoảng trắng\nDòng hai — tiếng Việt 🙂",
        fontSize: 27,
        color: "#7C3AED",
        align: "center",
        fontFamily: "Segoe UI",
        fontWeight: "bold",
        fontStyle: "italic",
        textDecoration: "underline",
        backgroundColor: "#FDE68A",
        backgroundOpacity: 0.6,
        lineHeight: 1.7,
        rotation: 11,
      },
    ]);
    await selectObjects([formattedText.id]);
    const before = await state();
    await page.keyboard.press("Control+C");
    await page.keyboard.press("Control+V");
    await waitForObjectCount(before.objects.length + 1);
    const pasted = additions(before.objects, (await state()).objects);
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0].type, "text");
    assert.notEqual(pasted[0].id, formattedText.id);
    assertPreserved(pasted[0], formattedText, [
      "text",
      "w",
      "h",
      "fontSize",
      "color",
      "align",
      "fontFamily",
      "fontWeight",
      "fontStyle",
      "textDecoration",
      "backgroundColor",
      "backgroundOpacity",
      "lineHeight",
      "rotation",
    ]);
  });

  await check(
    "text Copy button uses one trusted synchronous copy event without navigator.write",
    async () => {
      const source = (await state()).objects.find((object) => object.id === formattedText.id);
      assert(source?.type === "text");
      await selectObjects([source.id]);
      await writeClipboardText("QA fallback sentinel — must be replaced");
      const eventStart = await currentClipboardEventCount();
      let poisonedWriteCalls = 0;
      await forceNavigatorClipboardWriteRejection();
      try {
        const copyButton = page.getByRole("button", { name: "Sao chép", exact: true });
        await copyButton.waitFor({ state: "visible" });
        await copyButton.click();
        await page.waitForFunction(
          async (expected) =>
            (await navigator.clipboard.readText()).replace(/\r\n?/g, "\n") === expected,
          source.text,
        );
      } finally {
        poisonedWriteCalls = await restoreNavigatorClipboardWrite();
      }

      const fallbackEvents = await clipboardEventsSince(eventStart);
      assert.equal(poisonedWriteCalls, 0, "toolbar copy must not call navigator.clipboard.write");
      assert.deepEqual(
        fallbackEvents.map((event) => event.type),
        ["copy"],
      );
      assert.equal(fallbackEvents[0]?.trusted, true);
      assert.equal(
        (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n?/g, "\n"),
        source.text,
      );

      const before = await state();
      await blurActiveElement();
      await page.keyboard.press("Control+V");
      await waitForObjectCount(before.objects.length + 1);
      const pasted = additions(before.objects, (await state()).objects);
      assert.equal(pasted.length, 1);
      assert.equal(pasted[0].type, "text");
      assert.notEqual(pasted[0].id, source.id);
      assertPreserved(pasted[0], source, [
        "text",
        "w",
        "h",
        "fontSize",
        "color",
        "align",
        "fontFamily",
        "fontWeight",
        "fontStyle",
        "textDecoration",
        "backgroundColor",
        "backgroundOpacity",
        "lineHeight",
        "rotation",
      ]);
    },
  );

  await check(
    "textarea selection uses native replacement and creates no canvas object",
    async () => {
      const [editable] = await insertObjects([
        {
          type: "text",
          x: 70,
          y: 690,
          w: 310,
          h: 48,
          text: "Trước PHẦN_CŨ sau",
          fontSize: 20,
          color: "#1C1917",
          align: "left",
          lineHeight: 1.4,
        },
      ]);
      await selectObjects([editable.id]);
      await page.keyboard.press("Enter");
      const editor = page.getByRole("textbox", { name: "Nội dung hộp chữ" });
      await editor.waitFor({ state: "visible" });
      const initial = await editor.inputValue();
      const start = initial.indexOf("PHẦN_CŨ");
      assert(start >= 0);
      await editor.evaluate(
        (element, range) => {
          element.focus();
          element.setSelectionRange(range.start, range.end);
        },
        { start, end: start + "PHẦN_CŨ".length },
      );
      const replacement = "phần mới 🙂\nhai dòng";
      await writeClipboardText(replacement);
      const countBefore = (await state()).objects.length;
      await editor.press("Control+V");
      assert.equal(await editor.inputValue(), `Trước ${replacement} sau`);
      assert.equal((await state()).objects.length, countBefore);
      await editor.press("Control+Enter");
      await editor.waitFor({ state: "detached" });
      const saved = (await state()).objects.find((object) => object.id === editable.id);
      assert.equal(saved?.text, `Trước ${replacement} sau`);
    },
  );

  await check("search, notebook-name, and dialog input pastes remain native", async () => {
    const before = (await state()).objects;
    const search = page.getByPlaceholder("Tìm trong PDF…");
    await search.fill("Tìm PHẦN_CŨ");
    await search.evaluate((element) => {
      const start = element.value.indexOf("PHẦN_CŨ");
      element.focus();
      element.setSelectionRange(start, start + "PHẦN_CŨ".length);
    });
    await writeClipboardText("nội dung mới 🙂");
    await search.press("Control+V");
    assert.equal(await search.inputValue(), "Tìm nội dung mới 🙂");
    assert.deepEqual((await state()).objects, before);

    // A dialog layered over the live canvas must keep the page paste listener
    // out of its text field.
    await page.getByRole("button", { name: "Xuất", exact: true }).click();
    await page.getByRole("menuitem", { name: "Đổi màu bìa", exact: true }).click();
    const colorDialog = page.getByRole("dialog", { name: "Đổi màu bìa" });
    const dialogInput = colorDialog.getByPlaceholder("#HEXCODE");
    await dialogInput.fill("#ABCDEF");
    await dialogInput.selectText();
    await writeClipboardText("#123456");
    await dialogInput.press("Control+V");
    assert.equal(await dialogInput.inputValue(), "#123456");
    assert.deepEqual((await state()).objects, before);
    await colorDialog.getByRole("button", { name: "Hủy", exact: true }).click();

    // The notebook-name field lives in the library rename dialog. Keep the
    // original name by cancelling after proving native selection replacement.
    await page.getByRole("button", { name: "Thư viện", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");
    const notebookCard = page.locator("article.library-card").filter({
      has: page.getByText("QA — clipboard thật", { exact: true }),
    });
    await notebookCard.waitFor({ state: "visible" });
    await notebookCard.hover();
    await notebookCard.getByRole("button", { name: "Tùy chọn sổ", exact: true }).click();
    await page.getByRole("menuitem", { name: "Đổi tên", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "Đổi tên sổ" });
    const nameInput = renameDialog.locator("input").first();
    await nameInput.fill("Tên PHẦN_CŨ cuối");
    await nameInput.evaluate((element) => {
      const start = element.value.indexOf("PHẦN_CŨ");
      element.focus();
      element.setSelectionRange(start, start + "PHẦN_CŨ".length);
    });
    const pastedName = await writeClipboardText("sổ mới 🙂");
    await nameInput.press("Control+V");
    assert.equal(await nameInput.inputValue(), `Tên ${pastedName} cuối`);
    assert.deepEqual(await pageObjects(pageId), before);
    await renameDialog.getByRole("button", { name: "Hủy", exact: true }).click();

    await notebookCard.locator("button").first().click();
    await page.waitForURL((url) => url.pathname === `/notebook/${notebookId}`);
    await page.waitForFunction(
      (targetNotebookId) => window.__notesQaStore.getState().activeNotebookId === targetNotebookId,
      notebookId,
    );
    await page.waitForSelector(`[data-page-id="${pageId}"] canvas`);
    assert.deepEqual(await pageObjects(pageId), before);
  });

  await check("multi-object paste is one history step and one undo/redo group", async () => {
    const current = await state();
    const groupImage = current.objects.find((object) => object.id === resizedImage.id);
    const groupText = current.objects.find((object) => object.id === formattedText.id);
    assert(groupImage && groupText);
    const sourceSnapshots = structuredClone([groupImage, groupText]);
    const sourceIds = new Set(sourceSnapshots.map((object) => object.id));
    const assetsBefore = await assetInventory();
    await selectObjects([groupImage.id, groupText.id]);
    const before = await state();
    await page.keyboard.press("Control+C");
    await page.keyboard.press("Control+V");
    await waitForObjectCount(before.objects.length + 2);
    const afterPaste = await state();
    const pasted = additions(before.objects, afterPaste.objects);
    assert.equal(pasted.length, 2);
    assert.equal(afterPaste.historyPast, before.historyPast + 1);
    assert.deepEqual(
      pasted.map((object) => object.type),
      [groupImage.type, groupText.type],
    );
    assert.equal(new Set(pasted.map((object) => object.id)).size, pasted.length);
    assert.equal(
      pasted.every((object) => !sourceIds.has(object.id)),
      true,
    );
    assert.equal(pasted[1].x - pasted[0].x, groupText.x - groupImage.x);
    assert.equal(pasted[1].y - pasted[0].y, groupText.y - groupImage.y);
    assertPreserved(pasted[0], groupImage, ["w", "h", "rotation", "assetId"]);
    assertPreserved(pasted[1], groupText, ["text", "w", "h", "fontFamily", "color"]);
    assert.deepEqual(
      sourceSnapshots.map((source) => afterPaste.objects.find((object) => object.id === source.id)),
      sourceSnapshots,
      "multi-object paste must not mutate its sources",
    );
    assert.deepEqual(await assetInventory(), assetsBefore, "rich paste must not duplicate assets");

    const pastedIds = pasted.map((object) => object.id);
    await page.keyboard.press("Control+Z");
    await waitForObjectCount(before.objects.length);
    const afterUndo = await state();
    assert.equal(afterUndo.historyPast, before.historyPast);
    assert.equal(afterUndo.historyFuture > 0, true);
    assert.equal(
      afterUndo.objects.some((object) => pastedIds.includes(object.id)),
      false,
    );
    assert.deepEqual(await assetInventory(), assetsBefore, "Undo must not mutate the asset store");

    await page.keyboard.press("Control+Y");
    await waitForObjectCount(before.objects.length + 2);
    const afterRedo = await state();
    assert.equal(afterRedo.historyPast, before.historyPast + 1);
    assert.deepEqual(
      afterRedo.objects
        .filter((object) => pastedIds.includes(object.id))
        .map((object) => object.id),
      pastedIds,
    );
    assert.deepEqual(await assetInventory(), assetsBefore, "Redo must not duplicate assets");
  });

  if (await dataTransferSetDataIsPatchable()) {
    await check("trusted Ctrl+X write failure preserves the source and history", async () => {
      const [source] = await insertObjects([
        {
          type: "text",
          x: 610,
          y: 170,
          w: 230,
          h: 44,
          text: `QA CUT FAILURE ${crypto.randomUUID()} — giữ nguyên`,
          fontSize: 18,
          color: "#7C2D12",
          align: "left",
          fontWeight: "bold",
          lineHeight: 1.3,
        },
      ]);
      await selectObjects([source.id]);
      await writeClipboardText("QA clipboard sentinel before rejected cut");
      const before = await state();
      const eventStart = await currentClipboardEventCount();
      let rejectedWrites = 0;
      await armClipboardSetDataFailure();
      try {
        await page.keyboard.press("Control+X");
      } finally {
        rejectedWrites = await restoreClipboardSetData();
      }
      await page.waitForTimeout(120);

      const after = await state();
      const events = await clipboardEventsSince(eventStart);
      assert.equal(
        rejectedWrites >= 3,
        true,
        "all clipboard flavors must hit the rejecting writer",
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ["cut"],
      );
      assert.equal(events[0]?.trusted, true);
      assert.deepEqual(after.objects, before.objects);
      assert.deepEqual(
        after.objects.find((object) => object.id === source.id),
        source,
        "a failed trusted cut must leave its source unchanged",
      );
      assert.equal(after.historyPast, before.historyPast);
      assert.equal(after.historyFuture, before.historyFuture);
    });
  } else {
    limitations.push(
      "This Chromium build does not expose a patchable DataTransfer.setData method, so trusted Ctrl+X write-failure behavior remains unit-only in this run.",
    );
    console.log("SKIP trusted Ctrl+X write failure: DataTransfer.setData is not patchable");
  }

  await check(
    "Ctrl+X removes only after clipboard success and Ctrl+V restores a new ID",
    async () => {
      const cutText = `QA CUT ${crypto.randomUUID()} — tiếng Việt`;
      const [source] = await insertObjects([
        {
          type: "text",
          x: 390,
          y: 130,
          w: 180,
          h: 42,
          text: cutText,
          fontSize: 18,
          color: "#B91C1C",
          align: "left",
          fontWeight: "bold",
          lineHeight: 1.35,
        },
      ]);
      await selectObjects([source.id]);
      const beforeCut = await state();
      await page.keyboard.press("Control+X");
      await waitForObjectCount(beforeCut.objects.length - 1);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), cutText);
      assert.equal(
        (await state()).objects.some((object) => object.id === source.id),
        false,
      );

      const beforePaste = await state();
      await page.keyboard.press("Control+V");
      await waitForObjectCount(beforePaste.objects.length + 1);
      const restored = additions(beforePaste.objects, (await state()).objects);
      assert.equal(restored.length, 1);
      assert.equal(restored[0].type, "text");
      assert.equal(restored[0].text, cutText);
      assert.notEqual(restored[0].id, source.id);
    },
  );

  await check("a real PNG overrides a previously copied formatted Notes text object", async () => {
    const source = (await state()).objects.find((object) => object.id === formattedText.id);
    assert(source?.type === "text");
    await selectObjects([source.id]);
    await page.keyboard.press("Control+C");

    const before = await state();
    const textCount = before.objects.filter((object) => object.type === "text").length;
    await writeClipboardPng(78, 52);
    await page.keyboard.press("Control+V");
    await waitForObjectCount(before.objects.length + 1);
    const after = await state();
    const pasted = additions(before.objects, after.objects);
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0].type, "image");
    assert.equal(pasted[0].w, 78);
    assert.equal(pasted[0].h, 52);
    assert.equal(after.objects.filter((object) => object.type === "text").length, textCount);
  });

  await check("copying object A then text object B pastes B from the Copy button", async () => {
    const [objectA, objectB] = await insertObjects([
      {
        type: "text",
        x: 405,
        y: 350,
        w: 185,
        h: 44,
        text: "ĐỐI TƯỢNG A — không được dán",
        fontSize: 17,
        color: "#DC2626",
        align: "left",
        fontFamily: "Arial",
        fontWeight: "normal",
        lineHeight: 1.3,
        rotation: 0,
      },
      {
        type: "text",
        x: 405,
        y: 430,
        w: 205,
        h: 54,
        text: "ĐỐI TƯỢNG B 🙂 — bản mới nhất",
        fontSize: 23,
        color: "#0369A1",
        align: "right",
        fontFamily: "Segoe UI",
        fontWeight: "bold",
        fontStyle: "italic",
        lineHeight: 1.55,
        rotation: 7,
      },
    ]);
    await selectObjects([objectA.id]);
    await page.keyboard.press("Control+C");

    await page.keyboard.press("Escape");
    const objectBCenter = await screenPointForObjectCenter(pageId, objectB.id);
    await page.mouse.click(objectBCenter.x, objectBCenter.y);
    // Selection paints before React's passive copy-listener effect is rebound.
    // Wait one human-scale beat so the button path observes object B.
    await page.waitForTimeout(250);
    const textCopyButton = page.getByRole("button", { name: "Sao chép", exact: true });
    await textCopyButton.waitFor({ state: "visible" });
    const before = await state();
    await textCopyButton.click();
    await page.waitForTimeout(120);
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      objectB.text,
      "The text Copy button must replace the previous clipboard value with object B",
    );
    await blurActiveElement();
    await page.keyboard.press("Control+V");
    await waitForObjectCount(before.objects.length + 1);
    const pasted = additions(before.objects, (await state()).objects);
    assert.equal(pasted.length, 1);
    assert.equal(pasted[0].type, "text");
    assert.notEqual(pasted[0].id, objectB.id);
    assert.notEqual(pasted[0].text, objectA.text);
    assertPreserved(pasted[0], objectB, [
      "text",
      "w",
      "h",
      "fontSize",
      "color",
      "align",
      "fontFamily",
      "fontWeight",
      "fontStyle",
      "lineHeight",
      "rotation",
    ]);
  });

  await check(
    "pasting a real PNG while editing saves the live draft and adds one image",
    async () => {
      const [draftSource] = await insertObjects([
        {
          type: "text",
          x: 76,
          y: 755,
          w: 330,
          h: 42,
          text: "Bản cũ trước khi sửa",
          fontSize: 19,
          color: "#1C1917",
          align: "left",
          fontFamily: "Segoe UI",
          fontWeight: "normal",
          lineHeight: 1.4,
          rotation: 0,
        },
      ]);
      await selectObjects([draftSource.id]);
      await page.keyboard.press("Enter");
      const editor = page.getByRole("textbox", { name: "Nội dung hộp chữ" });
      await editor.waitFor({ state: "visible" });
      const draft = "Bản nháp CHƯA đóng 🙂\n  giữ hai khoảng trắng";
      await editor.fill(draft);
      assert.equal(await editor.inputValue(), draft);

      const before = await state();
      const imageCount = before.objects.filter((object) => object.type === "image").length;
      await writeClipboardPng(92, 57);
      await editor.press("Control+V");
      await waitForObjectCount(before.objects.length + 1);
      await editor.waitFor({ state: "detached" });
      const after = await state();
      const added = additions(before.objects, after.objects);
      assert.equal(added.length, 1);
      assert.equal(added[0].type, "image");
      assert.equal(added[0].w, 92);
      assert.equal(added[0].h, 57);
      assert.equal(
        after.objects.filter((object) => object.type === "image").length,
        imageCount + 1,
      );
      assert.equal(after.objects.find((object) => object.id === draftSource.id)?.text, draft);
    },
  );

  await check("two rapid real pastes survive a deliberately delayed first PNG decode", async () => {
    await page.getByRole("button", { name: "Lasso", exact: true }).click();
    await blurActiveElement();
    await writeClipboardPng(83, 53);
    const gatedBefore = await holdNextBitmapDecode();
    const before = await state();
    const eventStart = await currentClipboardEventCount();
    await page.keyboard.press("Control+V");
    await waitForHeldBitmapDecode(gatedBefore);
    const secondText = await writeClipboardText("Ý định dán thứ hai 🙂 — không bị ghi đè");
    await page.keyboard.press("Control+V");
    await releaseHeldBitmapDecode();
    await waitForObjectCount(before.objects.length + 2);
    // Let any accidentally duplicated async handler finish before taking the
    // final exact count/history snapshot.
    await page.waitForTimeout(700);

    const after = await state();
    const pasted = additions(before.objects, after.objects);
    assert.equal(pasted.length, 2);
    assert.equal(after.objects.length, before.objects.length + 2);
    assert.deepEqual(
      pasted.map((object) => object.type),
      ["image", "text"],
    );
    assert.equal(new Set(pasted.map((object) => object.id)).size, 2);
    const image = pasted.find((object) => object.type === "image");
    const text = pasted.find((object) => object.type === "text");
    assert.equal(image?.w, 83);
    assert.equal(image?.h, 53);
    assert.equal(text?.text, secondText);
    assert.equal(after.historyPast, before.historyPast + 2);
    const pasteEvents = (await clipboardEventsSince(eventStart)).filter(
      (event) => event.type === "paste",
    );
    assert.equal(pasteEvents.length, 2);
    assert.equal(
      pasteEvents.every((event) => event.trusted),
      true,
    );
    assert.deepEqual(
      pasteEvents.map((event) =>
        event.types.some((type) => type.toLowerCase().startsWith("image/")) ||
        event.types.includes("Files")
          ? "image"
          : "text",
      ),
      ["image", "text"],
    );
  });

  let secondPageId;
  await check(
    "an in-flight image paste stays on its captured page after a page switch",
    async () => {
      const pageIds = await page.evaluate(async () => {
        const store = window.__notesQaStore.getState();
        if (store.pages.length < 2) await store.addPage(store.pages.length - 1);
        return window.__notesQaStore.getState().pages.map((candidate) => candidate.id);
      });
      assert(pageIds.length >= 2);
      pageId = pageIds[0];
      secondPageId = pageIds[1];
      await setActivePage(0);
      await page.locator(`[data-page-id="${pageId}"]`).scrollIntoViewIfNeeded();

      const firstBefore = await pageObjects(pageId);
      const secondBefore = await pageObjects(secondPageId);
      await writeClipboardPng(67, 37);
      const gatedBefore = await holdNextBitmapDecode();
      await blurActiveElement();
      await page.keyboard.press("Control+V");
      await waitForHeldBitmapDecode(gatedBefore);

      // Use the actual page thumbnail control while the first decode is pending.
      const secondPageButton = page.locator("aside article").nth(1).locator("button").first();
      await secondPageButton.click();
      await page.waitForFunction((targetId) => {
        const store = window.__notesQaStore.getState();
        return store.pages[store.currentPageIndex]?.id === targetId;
      }, secondPageId);
      await releaseHeldBitmapDecode();
      await waitForPageObjectCount(pageId, firstBefore.length + 1);

      const firstAfter = await pageObjects(pageId);
      const secondAfter = await pageObjects(secondPageId);
      const pasted = additions(firstBefore, firstAfter);
      assert.equal(pasted.length, 1);
      assert.equal(pasted[0].type, "image");
      assert.equal(pasted[0].w, 67);
      assert.equal(pasted[0].h, 37);
      assert.deepEqual(secondAfter, secondBefore);
      assert.equal((await state()).page.id, secondPageId);

      const firstPageButton = page.locator("aside article").first().locator("button").first();
      await firstPageButton.click();
      await page.waitForFunction((targetId) => {
        const store = window.__notesQaStore.getState();
        return store.pages[store.currentPageIndex]?.id === targetId;
      }, pageId);
      await page.locator(`[data-page-id="${pageId}"]`).scrollIntoViewIfNeeded();
    },
  );

  await check(
    "an in-flight image paste stays in its captured notebook after a notebook switch",
    async () => {
      const otherName = `QA — notebook đích ${crypto.randomUUID().slice(0, 8)}`;
      const otherNotebook = await page.evaluate(async (name) => {
        const store = window.__notesQaStore.getState();
        const id = await store.createNotebook({
          name,
          folderId: null,
          cover: "#7C3AED",
          paper: { pattern: "blank", color: "#FFFEFB", lineColor: "#D6D3CD" },
          pageSize: "a4",
          orientation: "portrait",
          pages: 1,
        });
        const payload = await window.__notesQaDb.loadNotebookPayload(id);
        const otherPageId = payload.pages[0]?.id;
        const live = window.__notesQaStore.getState();
        live.persistSettings({
          openTabIds: [...new Set([...live.settings.openTabIds, id])],
        });
        return { id, pageId: otherPageId };
      }, otherName);
      assert(otherNotebook.pageId);
      await page.waitForFunction(
        (targetNotebookId) =>
          window.__notesQaStore.getState().activeNotebookId === targetNotebookId,
        notebookId,
      );

      const sourceBefore = await pageObjects(pageId);
      const otherBefore = await pageObjects(otherNotebook.pageId);
      await writeClipboardPng(81, 49);
      const gatedBefore = await holdNextBitmapDecode();
      await blurActiveElement();
      await page.keyboard.press("Control+V");
      await waitForHeldBitmapDecode(gatedBefore);

      await page.locator("header").getByText(otherName, { exact: true }).click();
      await page.waitForURL((url) => url.pathname === `/notebook/${otherNotebook.id}`);
      await page.waitForFunction(
        (targetNotebookId) =>
          window.__notesQaStore.getState().activeNotebookId === targetNotebookId,
        otherNotebook.id,
      );
      await page.waitForSelector(`[data-page-id="${otherNotebook.pageId}"] canvas`);
      await page.locator(`[data-page-id="${pageId}"]`).waitFor({ state: "detached" });
      await releaseHeldBitmapDecode();
      await waitForPageObjectCount(pageId, sourceBefore.length + 1);

      const sourceAfter = await pageObjects(pageId);
      const otherAfter = await pageObjects(otherNotebook.pageId);
      const pasted = additions(sourceBefore, sourceAfter);
      assert.equal(pasted.length, 1);
      assert.equal(pasted[0].type, "image");
      assert.equal(pasted[0].w, 81);
      assert.equal(pasted[0].h, 49);
      assert.deepEqual(otherAfter, otherBefore);
      assert.equal((await state()).activeNotebookId, otherNotebook.id);
      assert.equal((await state()).page.id, otherNotebook.pageId);

      await page.locator("header").getByText("QA — clipboard thật", { exact: true }).click();
      await page.waitForURL((url) => url.pathname === `/notebook/${notebookId}`);
      await page.waitForFunction(
        (targetNotebookId) =>
          window.__notesQaStore.getState().activeNotebookId === targetNotebookId,
        notebookId,
      );
      await page.waitForSelector(`[data-page-id="${pageId}"] canvas`);
    },
  );

  await check("flushed rich clipboard objects persist across a full reload", async () => {
    const current = await state();
    const sourceImage = current.objects.find((object) => object.id === resizedImage.id);
    const sourceText = current.objects.find((object) => object.id === formattedText.id);
    assert(sourceImage?.type === "image" && sourceText?.type === "text");
    await selectObjects([sourceImage.id, sourceText.id]);
    const before = await pageObjects(pageId);
    await page.keyboard.press("Control+C");
    await page.keyboard.press("Control+V");
    await waitForPageObjectCount(pageId, before.length + 2);
    const pasted = additions(before, await pageObjects(pageId));
    assert.equal(pasted.length, 2);
    const pastedImage = pasted.find((object) => object.type === "image");
    const pastedText = pasted.find((object) => object.type === "text");
    assert(pastedImage?.type === "image");
    assert(pastedText?.type === "text");
    const assetBeforeReload = await assetFingerprint(pastedImage.assetId);
    const inventoryBeforeReload = await assetInventory();
    assert(assetBeforeReload);
    assert.equal(assetBeforeReload.blobSize > 0, true);

    await page.evaluate(async () => {
      await window.__notesQaStore.getState().flushPendingWrites();
    });
    await harvestClipboardEvents();
    await page.reload({ waitUntil: "networkidle" });
    await attachStore();
    await page.waitForFunction(
      ({ targetNotebookId, targetPageId, objectIds }) => {
        const store = window.__notesQaStore.getState();
        const objects = store.objectsByPage[targetPageId] ?? [];
        return (
          store.activeNotebookId === targetNotebookId &&
          objectIds.every((id) => objects.some((object) => object.id === id))
        );
      },
      {
        targetNotebookId: notebookId,
        targetPageId: pageId,
        objectIds: pasted.map((object) => object.id),
      },
    );
    await page.waitForSelector(`[data-page-id="${pageId}"] canvas`);
    await installClipboardObserver();

    const persisted = await pageObjects(pageId);
    const persistedImage = persisted.find((object) => object.id === pastedImage.id);
    const persistedText = persisted.find((object) => object.id === pastedText.id);
    assert(persistedImage?.type === "image");
    assert(persistedText?.type === "text");
    assertPreserved(persistedImage, pastedImage, ["x", "y", "w", "h", "rotation", "assetId"]);
    assertPreserved(persistedText, pastedText, [
      "x",
      "y",
      "text",
      "w",
      "h",
      "fontSize",
      "color",
      "fontFamily",
      "fontWeight",
      "fontStyle",
      "textDecoration",
      "align",
      "backgroundColor",
      "backgroundOpacity",
      "lineHeight",
      "rotation",
    ]);
    assert.deepEqual(persistedImage, pastedImage);
    assert.deepEqual(persistedText, pastedText);
    assert.deepEqual(await assetInventory(), inventoryBeforeReload);
    assert.deepEqual(await assetFingerprint(pastedImage.assetId), assetBeforeReload);
  });

  await check(
    "two zoom and rotation settings preserve exact paste position and selection",
    async () => {
      const targetIndex = await page.evaluate((targetId) => {
        const store = window.__notesQaStore.getState();
        return store.pages.findIndex((candidate) => candidate.id === targetId);
      }, secondPageId);
      assert(targetIndex >= 0);
      pageId = secondPageId;
      await setActivePage(targetIndex);

      const cases = [
        { zoom: 0.55, rotation: 90, anchor: { x: 180, y: 210 }, image: { w: 96, h: 58 } },
        { zoom: 0.9, rotation: 270, anchor: { x: 430, y: 610 }, image: { w: 72, h: 46 } },
      ];
      for (const testCase of cases) {
        await page.evaluate(
          (nextZoom) => window.__notesQaStore.getState().setZoom(nextZoom),
          testCase.zoom,
        );
        await page.waitForFunction(
          (nextZoom) => window.__notesQaStore.getState().zoom === nextZoom,
          testCase.zoom,
        );
        await setPageRotation(pageId, testCase.rotation);

        const pageLocator = page.locator(`[data-page-id="${pageId}"]`);
        await pageLocator.scrollIntoViewIfNeeded();
        const box = await pageLocator.boundingBox();
        const pageRecord = (await state()).page;
        assert(box);
        assert.equal(Math.abs(box.width - pageRecord.height * testCase.zoom) < 1.5, true);
        assert.equal(Math.abs(box.height - pageRecord.width * testCase.zoom) < 1.5, true);

        await page.getByRole("button", { name: "Lasso", exact: true }).click();
        const intended = await screenPointForPagePoint(
          pageId,
          testCase.anchor.x,
          testCase.anchor.y,
        );
        await page.mouse.click(intended.x, intended.y);
        const before = await pageObjects(pageId);
        await writeClipboardPng(testCase.image.w, testCase.image.h);
        await blurActiveElement();
        await page.keyboard.press("Control+V");
        await waitForPageObjectCount(pageId, before.length + 1);
        const pasted = additions(before, await pageObjects(pageId));
        assert.equal(pasted.length, 1);
        assert.equal(pasted[0].type, "image");
        assert.equal(pasted[0].w, testCase.image.w);
        assert.equal(pasted[0].h, testCase.image.h);
        assert.equal(Math.abs(pasted[0].x + pasted[0].w / 2 - testCase.anchor.x) <= 1, true);
        assert.equal(Math.abs(pasted[0].y + pasted[0].h / 2 - testCase.anchor.y) <= 1, true);

        const after = await state();
        assert.equal(after.page.id, pageId);
        assert.equal(after.page.rotation, testCase.rotation);
        assert.equal(after.zoom, testCase.zoom);
        const selectionToolbar = pageLocator.getByLabel("Thao tác vùng chọn");
        await selectionToolbar.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await selectionToolbar.waitFor({ state: "hidden" });
        const center = await screenPointForObjectCenter(pageId, pasted[0].id);
        await page.mouse.click(center.x, center.y);
        await selectionToolbar.waitFor({ state: "visible" });
        await page.keyboard.press("Delete");
        await waitForPageObjectCount(pageId, before.length);
        assert.equal(
          (await pageObjects(pageId)).some((object) => object.id === pasted[0].id),
          false,
        );
      }
    },
  );

  await harvestClipboardEvents();
  const keyboardEvents = clipboardEvents.filter((event) =>
    ["copy", "cut", "paste"].includes(event.type),
  );
  assert(keyboardEvents.length > 0, "Expected browser-generated clipboard events");
  assert.equal(
    keyboardEvents.every((event) => event.trusted),
    true,
    "All observed clipboard events must be trusted browser events",
  );
  assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`);

  finalResult = {
    ok: true,
    checks,
    clipboardCapabilities,
    clipboardEvents,
    raceInstrumentation,
    limitations,
    browserErrors: errors,
    platformWarnings,
    failedRequests,
  };
} catch (error) {
  await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => {});
  finalResult = {
    ok: false,
    checks,
    clipboardCapabilities,
    clipboardEvents,
    raceInstrumentation,
    limitations,
    error: error.stack ?? String(error),
    browserErrors: errors,
    platformWarnings,
    failedRequests,
    screenshot: failureScreenshot,
  };
  process.exitCode = 1;
} finally {
  writeFileSync(reportPath, JSON.stringify(finalResult, null, 2));
  console.log(JSON.stringify(finalResult, null, 2));
  await context.close();
  await browser.close();
}
