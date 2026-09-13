#!/usr/bin/env node
// Production-bundle regression check. The browser context is disposable and
// only contains a synthetic notebook created through the public UI.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8081";
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  "Production autosave QA requires a loopback preview server",
);

const output = resolve("screenshots");
mkdirSync(output, { recursive: true });
const screenshot = resolve(output, "notes-autosave-built-interaction.png");
const report = resolve(output, "notes-autosave-built-qa.json");
const errors = [];
const checks = [];
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
  errors.push(`${message.text()} (${location})`);
});

async function storedText(pageId, expected) {
  return page.evaluate(
    ({ pageId, expected }) =>
      new Promise((resolveValue, reject) => {
        const request = indexedDB.open("notes-app", 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("pageObjects", "readonly");
          const get = transaction.objectStore("pageObjects").get(pageId);
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            const object = get.result?.objects?.find(
              (candidate) => candidate.type === "text" && candidate.text === expected,
            );
            resolveValue(object?.text ?? null);
          };
          transaction.oncomplete = () => database.close();
        };
      }),
    { pageId, expected },
  );
}

let result;
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Tạo mới", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Tạo sổ mới" });
  await dialog.getByLabel("Tên sổ").fill("QA — production autosave");
  await dialog.getByText("Trắng", { exact: true }).click();
  await dialog.getByRole("button", { name: "Tạo sổ", exact: true }).click();

  await page.waitForURL(/\/notebook\//);
  const pageSurface = page.locator("[data-page-id]").first();
  await pageSurface.locator("canvas").first().waitFor({ state: "visible" });
  const pageId = await pageSurface.getAttribute("data-page-id");
  assert(pageId, "The created notebook must expose its page identity");

  await page.getByRole("button", { name: /^Chữ, cỡ/ }).click();
  const box = await pageSurface.boundingBox();
  assert(box, "The page surface must be visible");
  await page.mouse.click(box.x + 85, box.y + 125);

  const editor = page.getByRole("textbox", { name: "Nội dung hộp chữ" });
  await editor.waitFor({ state: "visible" });
  const text = `Production vẫn tự lưu khi đang nhập — ${Date.now()}`;
  await editor.fill(text);
  assert.equal(
    await editor.evaluate((element) => document.activeElement === element),
    true,
    "The editor must remain focused while autosave runs",
  );
  await page.getByText("Chưa lưu", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("Đã lưu", { exact: true }).waitFor({ state: "visible" });
  checks.push("focused production draft reaches the saved state");

  assert.equal(await storedText(pageId, text), text);
  checks.push("focused production draft is present in IndexedDB before blur");

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(`[data-page-id="${pageId}"] canvas`).first().waitFor({ state: "visible" });
  assert.equal(await storedText(pageId, text), text);
  checks.push("production draft survives reload");

  await page.screenshot({ path: screenshot, fullPage: true });
  assert.equal(errors.length, 0, `Browser errors: ${errors.join("; ")}`);
  result = {
    ok: true,
    checks,
    browserErrors: errors,
    screenshot: "notes-autosave-built-interaction.png",
  };
} catch (error) {
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
  result = {
    ok: false,
    checks,
    error: error.stack ?? String(error),
    browserErrors: errors,
  };
  process.exitCode = 1;
} finally {
  writeFileSync(report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await context.close();
  await browser.close();
}
