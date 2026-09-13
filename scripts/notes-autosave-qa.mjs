#!/usr/bin/env node
// Browser-level autosave regression pass. It always uses a disposable browser
// profile and creates synthetic notebooks, never a user's existing Notes data.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8080";
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  "Autosave QA requires a loopback development server",
);

const output = resolve("screenshots");
mkdirSync(output, { recursive: true });
const checks = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.BROWSER_CHROMIUM_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const location = message.location().url;
  if (
    location === "https://grok.com/grok-app-builder/extensions.js" &&
    message.text().includes("ERR_BLOCKED_BY_RESPONSE.NotSameOrigin")
  )
    return;
  // Expected simulated storage errors are asserted through visible state.
  if (
    message.text().includes("[notes] objects-batch") &&
    message.text().includes("QA write failure")
  )
    return;
  errors.push(`${message.text()} (${location})`);
});

let notebookA;
let notebookB;
let pageA;
let textId;
let result;

async function attachStore() {
  await page.evaluate(async () => {
    const loaded = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .findLast((url) => new URL(url).pathname === "/src/lib/notes/store.ts");
    const module = await import(loaded ?? "/src/lib/notes/store.ts");
    window.__notesQaStore = module.useNotesStore;
    window.__notesQaStoreModule = module;
  });
  await page.waitForFunction(() => window.__notesQaStore?.getState().ready);
}

async function state() {
  return page.evaluate(() => {
    const store = window.__notesQaStore.getState();
    const activePage = store.pages[store.currentPageIndex] ?? store.pages[0];
    return {
      activeNotebookId: store.activeNotebookId,
      page: activePage,
      objects: activePage ? (store.objectsByPage[activePage.id] ?? []) : [],
      saveStatus: store.saveStatus,
      saveError: store.saveError,
      history: store.history[store.activeNotebookId]?.past.length ?? 0,
      zoom: store.zoom,
    };
  });
}

async function storedObjects(notebookId, pageId) {
  return page.evaluate(
    async ({ notebookId, pageId }) => {
      const loaded = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .findLast((url) => new URL(url).pathname === "/src/lib/notes/db.ts");
      const db = await import(loaded ?? "/src/lib/notes/db.ts");
      const payload = await db.loadNotebookPayload(notebookId);
      return payload.objects[pageId] ?? [];
    },
    { notebookId, pageId },
  );
}

async function point(pageId, x, y) {
  const box = await page.locator(`[data-page-id="${pageId}"]`).boundingBox();
  assert(box, "Page canvas must be visible");
  const snapshot = await state();
  return { x: box.x + x * snapshot.zoom, y: box.y + y * snapshot.zoom };
}

async function clickPoint(pageId, x, y, options) {
  const target = await point(pageId, x, y);
  await page.mouse.click(target.x, target.y, options);
}

const editor = () => page.getByRole("textbox", { name: "Nội dung hộp chữ" });

async function waitSaved() {
  await page.waitForFunction(() => window.__notesQaStore.getState().saveStatus === "saved");
}

async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function openText(textObject) {
  await page.getByRole("button", { name: "Lasso", exact: true }).click();
  await clickPoint(pageA, textObject.x + Math.min(35, textObject.w / 3), textObject.y + 12, {
    clickCount: 2,
  });
  await editor().waitFor({ state: "visible" });
}

try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await attachStore();
  [notebookA, notebookB] = await page.evaluate(async () => {
    const store = window.__notesQaStore.getState();
    store.persistSettings({ autoBackup: false, autoCheckUpdates: false });
    const create = (name) =>
      store.createNotebook({
        name,
        folderId: null,
        cover: "#0F766E",
        paper: { pattern: "blank", color: "#FFFEFB", lineColor: "#D6D3CD" },
        pageSize: "a4",
        orientation: "portrait",
        pages: 1,
      });
    const ids = await Promise.all([create("QA — autosave A"), create("QA — autosave B")]);
    store.persistSettings({ openTabIds: ids });
    return ids;
  });
  await page.goto(`${origin}/notebook/${notebookA}`, { waitUntil: "networkidle" });
  await attachStore();
  await page.waitForSelector("[data-page-id] canvas");
  await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.85));
  pageA = (await state()).page.id;

  const firstText = "Tự lưu khi vẫn đang nhập\nTiếng Việt có dấu.";
  await check("new focused text autosaves and survives reload", async () => {
    await page.getByRole("button", { name: /^Chữ, cỡ/ }).click();
    await clickPoint(pageA, 70, 100);
    await editor().fill(firstText);
    assert.equal(await editor().evaluate((element) => document.activeElement === element), true);
    assert.equal((await state()).saveStatus, "dirty");
    await waitSaved();
    const beforeReload = await storedObjects(notebookA, pageA);
    const savedText = beforeReload.find(
      (object) => object.type === "text" && object.text === firstText,
    );
    assert(savedText, "Focused draft must reach IndexedDB before blur");
    textId = savedText.id;
    await page.reload({ waitUntil: "networkidle" });
    await attachStore();
    await page.waitForSelector("[data-page-id] canvas");
    assert.equal((await state()).objects.find((object) => object.id === textId)?.text, firstText);
  });

  const editedText = "Nội dung hộp có sẵn đã tự lưu\nDòng thứ hai.";
  await check("existing focused text autosaves and survives reload", async () => {
    const object = (await state()).objects.find((candidate) => candidate.id === textId);
    await openText(object);
    await editor().fill(editedText);
    await waitSaved();
    assert.equal(
      (await storedObjects(notebookA, pageA)).find((object) => object.id === textId)?.text,
      editedText,
    );
    await page.reload({ waitUntil: "networkidle" });
    await attachStore();
    await page.waitForSelector("[data-page-id] canvas");
    assert.equal((await state()).objects.find((object) => object.id === textId)?.text, editedText);
  });

  await check("continuous typing receives a two-second checkpoint", async () => {
    const object = (await state()).objects.find((candidate) => candidate.id === textId);
    await openText(object);
    await page.evaluate(() => {
      window.__qaWriteCount = 0;
      window.__notesQaStoreModule.setObjectWriteInterceptorForTests(async (_entries, persist) => {
        window.__qaWriteCount += 1;
        await persist();
      });
    });
    await editor().fill("Liên tục: ");
    await editor().pressSequentially("1234567890", { delay: 240 });
    assert(
      (await page.evaluate(() => window.__qaWriteCount)) >= 1,
      "Typing must checkpoint before becoming idle",
    );
    assert.equal(await editor().evaluate((element) => document.activeElement === element), true);
    await waitSaved();
    await page.evaluate(() => window.__notesQaStoreModule.setObjectWriteInterceptorForTests(null));
  });

  const slowFinal = "B mới nhất trong khi A còn đang ghi";
  await check("a slow old write cannot overwrite a newer focused draft", async () => {
    await page.evaluate(() => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      window.__qaReleaseSlowWrite = release;
      window.__qaSlowWriteStarted = false;
      let first = true;
      window.__notesQaStoreModule.setObjectWriteInterceptorForTests(async (_entries, persist) => {
        if (first) {
          first = false;
          window.__qaSlowWriteStarted = true;
          await gate;
        }
        await persist();
      });
    });
    await editor().fill("A cũ đang ghi");
    await page.waitForFunction(() => window.__qaSlowWriteStarted === true);
    await editor().fill(slowFinal);
    assert.equal((await state()).saveStatus, "dirty");
    await page.evaluate(() => window.__qaReleaseSlowWrite());
    await waitSaved();
    await page.evaluate(() => window.__notesQaStoreModule.setObjectWriteInterceptorForTests(null));
    assert.equal(
      (await storedObjects(notebookA, pageA)).find((object) => object.id === textId)?.text,
      slowFinal,
    );
  });

  const retryText = "Bản nháp còn nguyên sau lỗi và thử lại";
  await check("failed autosave keeps the draft and the visible retry succeeds", async () => {
    await page.evaluate(() => {
      window.__notesQaStoreModule.setObjectWriteInterceptorForTests(async () => {
        throw new Error("QA write failure");
      });
    });
    await editor().fill(retryText);
    await page.waitForFunction(() => window.__notesQaStore.getState().saveStatus === "error");
    assert.equal(await editor().inputValue(), retryText);
    assert.equal((await state()).objects.find((object) => object.id === textId)?.text, retryText);
    await page.evaluate(() => window.__notesQaStoreModule.setObjectWriteInterceptorForTests(null));
    await page.getByRole("button", { name: /Thử lại/ }).click();
    await waitSaved();
    assert.equal(
      (await storedObjects(notebookA, pageA)).find((object) => object.id === textId)?.text,
      retryText,
    );
  });

  await check("IME composition, multiline paste, and zoom preserve focus and content", async () => {
    const composed = "Gõ tiếng Việt: Trường Sa\n" + "Văn bản dán dài có khoảng trắng. ".repeat(30);
    const object = (await state()).objects.find((candidate) => candidate.id === textId);
    await openText(object);
    await editor().evaluate((element, value) => {
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "Trường" }),
      );
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(element, value);
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertCompositionText",
          isComposing: true,
        }),
      );
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
          keyCode: 229,
          isComposing: true,
        }),
      );
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: value }));
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
      );
    }, composed);
    assert.equal(await editor().count(), 1, "IME Enter must not finish the editor");
    await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.72));
    assert.equal(await editor().inputValue(), composed);
    assert.equal(await editor().evaluate((element) => document.activeElement === element), true);
    await waitSaved();
    assert.equal(
      (await storedObjects(notebookA, pageA)).find((object) => object.id === textId)?.text,
      composed,
    );
    await page.evaluate(() => window.__notesQaStore.getState().setZoom(0.85));
  });

  await check("Escape after an autosave durably restores the session baseline", async () => {
    const baseline = retryText;
    const history = (await state()).history;
    await editor().fill("Bản tạm đã chạm bộ nhớ bền vững");
    await waitSaved();
    await editor().press("Escape");
    await editor().waitFor({ state: "detached" });
    await waitSaved();
    assert.equal((await state()).history, history);
    await page.reload({ waitUntil: "networkidle" });
    await attachStore();
    await page.waitForSelector("[data-page-id] canvas");
    assert.equal((await state()).objects.find((object) => object.id === textId)?.text, baseline);
  });

  const completedText = "Phiên sửa hoàn tất sau nhiều lần tự lưu";
  await check("Ctrl+Enter creates one Undo step and Undo/Redo remain coherent", async () => {
    const object = (await state()).objects.find((candidate) => candidate.id === textId);
    await openText(object);
    const history = (await state()).history;
    await editor().fill("Bản trung gian thứ nhất");
    await waitSaved();
    await editor().fill("Bản trung gian thứ hai");
    await waitSaved();
    await editor().fill(completedText);
    await waitSaved();
    assert.equal((await state()).history, history, "Autosave must not add Undo entries");
    await editor().press("Control+Enter");
    await editor().waitFor({ state: "detached" });
    assert.equal((await state()).history, history + 1, "The completed session needs one Undo entry");
    await page.keyboard.press("Control+Z");
    await waitSaved();
    assert.equal((await state()).objects.find((object) => object.id === textId)?.text, retryText);
    await page.keyboard.press("Control+Y");
    await waitSaved();
    assert.equal((await state()).objects.find((object) => object.id === textId)?.text, completedText);
  });

  const siblingText = "Hộp chữ bên cạnh phải được giữ nguyên";
  await check("autosaving one of multiple text boxes preserves its siblings", async () => {
    await page.getByRole("button", { name: /^Chữ, cỡ/ }).click();
    await clickPoint(pageA, 360, 420);
    await editor().fill(siblingText);
    await editor().press("Control+Enter");
    await editor().waitFor({ state: "detached" });
    await waitSaved();
    const siblingId = (await state()).objects.find(
      (object) => object.type === "text" && object.text === siblingText,
    )?.id;
    assert(siblingId, "The sibling text object must exist");

    const object = (await state()).objects.find((candidate) => candidate.id === textId);
    await openText(object);
    await editor().fill("Chỉ hộp đang sửa thay đổi");
    await waitSaved();
    assert.equal((await state()).objects.find((candidate) => candidate.id === siblingId)?.text, siblingText);
    assert.equal(
      (await storedObjects(notebookA, pageA)).find((candidate) => candidate.id === siblingId)?.text,
      siblingText,
    );
  });

  await check("finishing an autosaved empty edit restores the existing object", async () => {
    const history = (await state()).history;
    await editor().fill("");
    await waitSaved();
    assert.equal(
      (await storedObjects(notebookA, pageA)).some((candidate) => candidate.id === textId),
      false,
      "The empty in-progress revision should be represented honestly in storage",
    );
    await editor().press("Control+Enter");
    await editor().waitFor({ state: "detached" });
    await waitSaved();
    assert.equal((await state()).objects.find((candidate) => candidate.id === textId)?.text, completedText);
    assert.equal(
      (await storedObjects(notebookA, pageA)).find((candidate) => candidate.id === textId)?.text,
      completedText,
    );
    assert.equal((await state()).history, history, "Cancelling the empty edit must not add Undo");
  });

  const switchedText = "Đã flush đúng sổ trước khi chuyển tab";
  await check("switching notebooks flushes the correct object identity", async () => {
    const object = (await state()).objects.find((candidate) => candidate.id === textId);
    await openText(object);
    await editor().fill(switchedText);
    const historyBefore = await page.evaluate(
      ({ notebookA, notebookB }) => ({
        notebookA: window.__notesQaStore.getState().history[notebookA]?.past.length ?? 0,
        notebookB: window.__notesQaStore.getState().history[notebookB]?.past.length ?? 0,
      }),
      { notebookA, notebookB },
    );
    // A programmatic UI click intentionally avoids the normal pointer blur so
    // this also exercises the live-draft collector and unmount cleanup path.
    await page.getByText("QA — autosave B", { exact: true }).evaluate((element) => element.click());
    await page.waitForFunction(
      (id) => window.__notesQaStore.getState().activeNotebookId === id,
      notebookB,
    );
    await page.waitForFunction(
      ({ notebookA, expected }) =>
        (window.__notesQaStore.getState().history[notebookA]?.past.length ?? 0) === expected,
      { notebookA, expected: historyBefore.notebookA + 1 },
    );
    const historyAfter = await page.evaluate(
      ({ notebookA, notebookB }) => ({
        notebookA: window.__notesQaStore.getState().history[notebookA]?.past.length ?? 0,
        notebookB: window.__notesQaStore.getState().history[notebookB]?.past.length ?? 0,
      }),
      { notebookA, notebookB },
    );
    assert.equal(historyAfter.notebookA, historyBefore.notebookA + 1);
    assert.equal(
      historyAfter.notebookB,
      historyBefore.notebookB,
      "Unmount cleanup must not put notebook A's Undo entry in notebook B",
    );
    assert.equal(
      (await state()).objects.some(
        (object) => object.type === "text" && object.text === switchedText,
      ),
      false,
    );
    assert.equal(
      (await storedObjects(notebookA, pageA)).find((object) => object.id === textId)?.text,
      switchedText,
    );
  });

  await page.screenshot({ path: resolve(output, "notes-autosave-desktop.png"), fullPage: true });
  assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`);
  result = { ok: true, checks, browserErrors: errors, screenshot: "notes-autosave-desktop.png" };
} catch (error) {
  await page
    .screenshot({ path: resolve(output, "notes-autosave-failure.png"), fullPage: true })
    .catch(() => undefined);
  result = { ok: false, checks, error: error.stack ?? String(error), browserErrors: errors };
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(output, "notes-autosave-qa.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await context.close();
  await browser.close();
}
