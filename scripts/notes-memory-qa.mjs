#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8080";
const label = process.argv[3] ?? "current";
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  "Notes memory QA requires an isolated loopback browser context",
);

const outputDir = resolve("screenshots");
mkdirSync(outputDir, { recursive: true });
const reportPath = resolve(outputDir, `notes-memory-${label}.json`);
const errors = [];
const warnings = [];

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.BROWSER_CHROMIUM_EXECUTABLE }
    : {}),
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const detail = `${message.text()} (${message.location().url})`;
  if (
    message.location().url === "https://grok.com/grok-app-builder/extensions.js" &&
    message.text().includes("ERR_BLOCKED_BY_RESPONSE.NotSameOrigin")
  ) {
    warnings.push(detail);
  } else {
    errors.push(detail);
  }
});

await page.addInitScript(() => {
  const probe = {
    createdObjectUrls: 0,
    revokedObjectUrls: 0,
    liveObjectUrls: new Set(),
    blobImageAssignments: 0,
    completedBlobImageLoads: 0,
    failedBlobImageLoads: 0,
    activeBlobImageLoads: 0,
    peakBlobImageLoads: 0,
  };
  window.__notesMemoryProbe = probe;

  const originalCreate = URL.createObjectURL.bind(URL);
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const url = originalCreate(blob);
    probe.createdObjectUrls += 1;
    probe.liveObjectUrls.add(url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    probe.revokedObjectUrls += 1;
    probe.liveObjectUrls.delete(String(url));
    return originalRevoke(url);
  };

  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (!descriptor?.get || !descriptor.set || !descriptor.configurable) return;
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    ...descriptor,
    get: descriptor.get,
    set(value) {
      if (String(value).startsWith("blob:")) {
        probe.blobImageAssignments += 1;
        probe.activeBlobImageLoads += 1;
        probe.peakBlobImageLoads = Math.max(probe.peakBlobImageLoads, probe.activeBlobImageLoads);
        let settled = false;
        const settle = (ok) => {
          if (settled) return;
          settled = true;
          probe.activeBlobImageLoads = Math.max(0, probe.activeBlobImageLoads - 1);
          if (ok) probe.completedBlobImageLoads += 1;
          else probe.failedBlobImageLoads += 1;
        };
        this.addEventListener("load", () => settle(true), { once: true });
        this.addEventListener("error", () => settle(false), { once: true });
      }
      descriptor.set.call(this, value);
    },
  });
});

async function attachModules() {
  await page.evaluate(async () => {
    if ("__TAURI_INTERNALS__" in window) {
      throw new Error("Refusing to run memory QA against native Notes storage");
    }
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    const moduleUrl = (pathname) =>
      resources.findLast((url) => new URL(url).pathname === pathname) ?? pathname;
    window.__notesMemoryStore = (await import(moduleUrl("/src/lib/notes/store.ts"))).useNotesStore;
    window.__notesMemoryDb = await import(moduleUrl("/src/lib/notes/db.ts"));
    window.__notesMemoryCache = await import(moduleUrl("/src/lib/notes/image-cache.ts"));
    window.__notesMemoryIo = await import(moduleUrl("/src/lib/notes/io.ts"));
    window.__notesMemoryRaster = await import(moduleUrl("/src/lib/notes/raster-pdf-export.ts"));
    window.__notesMemoryPdf = await import(moduleUrl("/src/lib/notes/pdf.ts"));
  });
  await page.waitForFunction(() => window.__notesMemoryStore?.getState().ready);
}

async function createFixture() {
  return page.evaluate(async () => {
    const store = window.__notesMemoryStore.getState();
    const db = window.__notesMemoryDb;
    store.persistSettings({ autoBackup: false, autoCheckUpdates: false, pageMode: "continuous" });

    const createBook = async (name, pageCount, hueOffset) => {
      const notebookId = await store.createNotebook({
        name,
        folderId: null,
        cover: "#0F766E",
        paper: { pattern: "blank", color: "#FFFEFB", lineColor: "#D6D3CD" },
        pageSize: "a4",
        orientation: "portrait",
        pages: pageCount,
      });
      const payload = await db.loadNotebookPayload(notebookId);
      const canvas = document.createElement("canvas");
      canvas.width = 1536;
      canvas.height = 1024;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Synthetic image canvas is unavailable");
      const encode = (index) => {
        context.fillStyle = `hsl(${(hueOffset + index * 31) % 360} 42% 34%)`;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#FFFEFB";
        context.fillRect(96, 96, canvas.width - 192, canvas.height - 192);
        context.fillStyle = "#0F766E";
        context.font = "700 160px sans-serif";
        context.fillText(`${name} ${index + 1}`, 150, 560);
        return new Promise((resolveBlob, reject) =>
          canvas.toBlob(
            (blob) => (blob ? resolveBlob(blob) : reject(new Error("Synthetic PNG encode failed"))),
            "image/png",
          ),
        );
      };

      const sharedId = crypto.randomUUID();
      const sharedBlob = await encode(pageCount + 1);
      await db.putAsset({
        id: sharedId,
        kind: "image",
        mime: "image/png",
        name: `${name}-shared.png`,
        byteLength: sharedBlob.size,
        blob: sharedBlob,
        createdAt: Date.now(),
      });

      const entries = [];
      const uniqueIds = [];
      const uniqueObjectIds = [];
      const sharedObjectIds = [];
      for (let index = 0; index < payload.pages.length; index += 1) {
        const assetId = crypto.randomUUID();
        const blob = await encode(index);
        await db.putAsset({
          id: assetId,
          kind: "image",
          mime: "image/png",
          name: `${name}-${index + 1}.png`,
          byteLength: blob.size,
          blob,
          createdAt: Date.now(),
        });
        uniqueIds.push(assetId);
        const targetPage = payload.pages[index];
        const uniqueObjectId = crypto.randomUUID();
        const sharedObjectId = crypto.randomUUID();
        uniqueObjectIds.push(uniqueObjectId);
        sharedObjectIds.push(sharedObjectId);
        entries.push({
          pageId: targetPage.id,
          objects: [
            {
              id: uniqueObjectId,
              type: "image",
              x: 36,
              y: 72,
              w: 250,
              h: 167,
              rotation: 0,
              assetId,
            },
            {
              id: sharedObjectId,
              type: "image",
              x: 310,
              y: 360,
              w: 220,
              h: 147,
              rotation: 0,
              assetId: sharedId,
            },
          ],
        });
      }
      await db.putObjectsBatch(entries);
      return {
        id: notebookId,
        name,
        pageIds: payload.pages.map((candidate) => candidate.id),
        uniqueIds,
        uniqueObjectIds,
        sharedObjectIds,
        sharedId,
      };
    };

    const large = await createBook("QA bộ nhớ 40 trang", 40, 20);
    const second = await createBook("QA chuyển sổ 12 trang", 12, 190);
    store.persistSettings({ openTabIds: [large.id, second.id], pageMode: "continuous" });
    await store.flushPendingWrites();
    return { large, second };
  });
}

async function sample(name) {
  return page.evaluate((sampleName) => {
    const cache = window.__notesMemoryCache.getImageCacheStats();
    const urls = window.__notesMemoryDb.getObjectUrlStats();
    const probe = window.__notesMemoryProbe;
    const canvases = [...document.querySelectorAll("canvas")];
    const memory = performance.memory;
    return {
      name: sampleName,
      at: Date.now(),
      cache,
      urls,
      probe: {
        createdObjectUrls: probe.createdObjectUrls,
        revokedObjectUrls: probe.revokedObjectUrls,
        liveObjectUrls: probe.liveObjectUrls.size,
        blobImageAssignments: probe.blobImageAssignments,
        completedBlobImageLoads: probe.completedBlobImageLoads,
        failedBlobImageLoads: probe.failedBlobImageLoads,
        activeBlobImageLoads: probe.activeBlobImageLoads,
        peakBlobImageLoads: probe.peakBlobImageLoads,
      },
      canvases: {
        count: canvases.length,
        backingPixels: canvases.reduce((total, canvas) => total + canvas.width * canvas.height, 0),
        pageLayerCount: document.querySelectorAll('[data-notes-canvas="interaction"]').length,
      },
      memory: memory
        ? {
            usedJsHeapBytes: memory.usedJSHeapSize,
            totalJsHeapBytes: memory.totalJSHeapSize,
          }
        : null,
    };
  }, name);
}

async function scrollBook(book, rounds) {
  const roundSamples = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const id of book.pageIds) {
      await page.locator(`[data-page-id="${id}"]`).scrollIntoViewIfNeeded();
      await page.waitForTimeout(35);
    }
    await page.waitForTimeout(500);
    roundSamples.push(await sample(`scroll-round-${round + 1}`));
  }
  return roundSamples;
}

async function clickNotebook(name) {
  const tab = page.getByText(name, { exact: true }).first();
  await tab.click();
  await page.waitForURL(/\/notebook\//);
  await attachModules();
  await page.waitForSelector("[data-page-id]");
}

async function waitForPageImage(targetPageId) {
  await page.waitForFunction((pageId) => {
    const surface = document.querySelector(`[data-page-id="${pageId}"]`);
    const canvas = surface?.querySelectorAll("canvas")[1];
    const pageRecord = window.__notesMemoryStore
      .getState()
      .pages.find((candidate) => candidate.id === pageId);
    if (!(canvas instanceof HTMLCanvasElement) || !pageRecord || canvas.width <= 1) return false;
    const context = canvas.getContext("2d");
    if (!context) return false;
    const x = Math.max(
      0,
      Math.min(canvas.width - 1, Math.round((46 * canvas.width) / pageRecord.width)),
    );
    const y = Math.max(
      0,
      Math.min(canvas.height - 1, Math.round((82 * canvas.width) / pageRecord.width)),
    );
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    return alpha > 0 && (red < 235 || green < 235 || blue < 235);
  }, targetPageId);
}

async function assetFingerprint(assetId) {
  return page.evaluate(async (id) => {
    const asset = await window.__notesMemoryDb.getAsset(id);
    if (!asset) return null;
    const bytes = await asset.blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      byteLength: asset.byteLength,
      blobSize: asset.blob.size,
      sha256: [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join(""),
    };
  }, assetId);
}

async function runLifecycleChecks(book) {
  const firstPageId = book.pageIds[0];
  const secondPageId = book.pageIds[1];
  const uniqueAssetId = book.uniqueIds[0];
  const uniqueObjectId = book.uniqueObjectIds[0];
  const sharedObjectId = book.sharedObjectIds[0];
  const originalFingerprint = await assetFingerprint(uniqueAssetId);
  assert(originalFingerprint, "The unique durable image asset must exist before lifecycle checks");

  await page.locator(`[data-page-id="${firstPageId}"]`).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.__notesMemoryStore.getState().setPageIndex(0));
  await waitForPageImage(firstPageId);

  const removedUnique = await page.evaluate(
    async ({ pageId, objectId }) => {
      const store = window.__notesMemoryStore.getState();
      const before = store.objectsByPage[pageId] ?? [];
      store.commitObjects(
        pageId,
        before.filter((object) => object.id !== objectId),
        true,
      );
      await store.flushPendingWrites();
      window.__notesMemoryCache.trimUnusedAssetImages(true);
      return {
        beforeCount: before.length,
        afterCount: window.__notesMemoryStore.getState().objectsByPage[pageId]?.length ?? 0,
      };
    },
    { pageId: firstPageId, objectId: uniqueObjectId },
  );
  assert.equal(removedUnique.afterCount, removedUnique.beforeCount - 1);
  await page.waitForTimeout(450);
  assert.deepEqual(
    await assetFingerprint(uniqueAssetId),
    originalFingerprint,
    "Evicting an unused decoded image must not alter its durable blob",
  );

  await page.evaluate(async () => {
    const store = window.__notesMemoryStore.getState();
    store.undo();
    await store.flushPendingWrites();
  });
  await waitForPageImage(firstPageId);
  assert.equal(
    await page.evaluate(
      ({ pageId, objectId }) =>
        window.__notesMemoryStore
          .getState()
          .objectsByPage[pageId]?.some((object) => object.id === objectId) ?? false,
      { pageId: firstPageId, objectId: uniqueObjectId },
    ),
    true,
    "Undo must restore an image after its transient decode was evicted",
  );

  await page.evaluate(async () => {
    const store = window.__notesMemoryStore.getState();
    store.redo();
    await store.flushPendingWrites();
  });
  assert.equal(
    await page.evaluate(
      ({ pageId, objectId }) =>
        window.__notesMemoryStore
          .getState()
          .objectsByPage[pageId]?.some((object) => object.id === objectId) ?? false,
      { pageId: firstPageId, objectId: uniqueObjectId },
    ),
    false,
    "Redo must remove the image object without deleting its asset",
  );
  assert.deepEqual(await assetFingerprint(uniqueAssetId), originalFingerprint);
  await page.evaluate(async () => {
    const store = window.__notesMemoryStore.getState();
    store.undo();
    await store.flushPendingWrites();
  });
  await waitForPageImage(firstPageId);

  const sharedResult = await page.evaluate(
    async ({
      firstPageId: pageId,
      secondPageId: otherPageId,
      sharedObjectId: objectId,
      sharedId,
    }) => {
      const store = window.__notesMemoryStore.getState();
      const before = store.objectsByPage[pageId] ?? [];
      store.commitObjects(
        pageId,
        before.filter((object) => object.id !== objectId),
        true,
      );
      await store.flushPendingWrites();
      const state = window.__notesMemoryStore.getState();
      const otherPageStillReferencesAsset = (state.objectsByPage[otherPageId] ?? []).some(
        (object) => object.type === "image" && object.assetId === sharedId,
      );
      const durableAssetStillExists = Boolean(await window.__notesMemoryDb.getAsset(sharedId));
      state.undo();
      await state.flushPendingWrites();
      return { otherPageStillReferencesAsset, durableAssetStillExists };
    },
    {
      firstPageId,
      secondPageId,
      sharedObjectId,
      sharedId: book.sharedId,
    },
  );
  assert.equal(sharedResult.otherPageStillReferencesAsset, true);
  assert.equal(sharedResult.durableAssetStillExists, true);
  await waitForPageImage(firstPageId);

  const exportResult = await page.evaluate(
    async ({ notebookId, firstPageId, lastPageId }) => {
      const state = window.__notesMemoryStore.getState();
      const notebook = state.notebooks.find((candidate) => candidate.id === notebookId);
      if (!notebook) throw new Error("Synthetic notebook disappeared before export");
      const selectedPages = [firstPageId, lastPageId].map((pageId) => {
        const record = state.pages.find((candidate) => candidate.id === pageId);
        if (!record) throw new Error(`Missing export page ${pageId}`);
        return record;
      });
      const progress = [];
      const trimTimer = setInterval(
        () => window.__notesMemoryCache.trimUnusedAssetImages(true),
        15,
      );
      try {
        const bytes = await window.__notesMemoryRaster.exportRasterPdf(
          {
            notebook,
            pages: selectedPages,
            objects: Object.fromEntries(
              selectedPages.map((record) => [record.id, state.objectsByPage[record.id] ?? []]),
            ),
          },
          150,
          (value) => progress.push(value),
        );
        const signature = new TextDecoder().decode(bytes.slice(0, 5));
        const trailer = new TextDecoder().decode(bytes.slice(-32));
        const pdfjs = await window.__notesMemoryPdf.getPdfjs();
        const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
        const rendered = await loadingTask.promise;
        const imagePixels = [];
        try {
          for (let pageNumber = 1; pageNumber <= rendered.numPages; pageNumber += 1) {
            const pdfPage = await rendered.getPage(pageNumber);
            const viewport = pdfPage.getViewport({ scale: 1 });
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Cannot inspect raster export canvas");
            await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
            imagePixels.push([...context.getImageData(46, 82, 1, 1).data]);
            canvas.width = 1;
            canvas.height = 1;
          }
        } finally {
          await loadingTask.destroy();
        }
        return { byteLength: bytes.byteLength, signature, trailer, progress, imagePixels };
      } finally {
        clearInterval(trimTimer);
      }
    },
    {
      notebookId: book.id,
      firstPageId,
      lastPageId: book.pageIds.at(-1),
    },
  );
  assert.equal(exportResult.signature, "%PDF-");
  assert(exportResult.trailer.includes("%%EOF"));
  assert(exportResult.byteLength > 1_000, "Raster export must contain real PDF bytes");
  assert.deepEqual(exportResult.progress, [50, 100]);
  assert.equal(exportResult.imagePixels.length, 2);
  assert(
    exportResult.imagePixels.every(
      ([red, green, blue, alpha]) => alpha > 0 && (red < 220 || green < 220 || blue < 220),
    ),
    "Both an onscreen and an offscreen exported page must contain its image pixels",
  );
  assert.deepEqual(
    await assetFingerprint(uniqueAssetId),
    originalFingerprint,
    "Export must not mutate the durable source image",
  );

  const backupResult = await page.evaluate(
    async ({ notebookId, assetId }) => {
      const built = await window.__notesMemoryIo.buildBackupZip("notebook", notebookId);
      const inspected = await window.__notesMemoryIo.inspectBackup(built.blob);
      const asset = inspected.dump.assets.find((candidate) => candidate.id === assetId);
      if (!asset) throw new Error("Verified backup omitted a referenced image asset");
      const bytes = await asset.blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return {
        zipBytes: built.blob.size,
        manifest: built.manifest,
        warnings: inspected.warnings,
        assetIds: inspected.dump.assets.map((candidate) => candidate.id),
        asset: {
          byteLength: asset.byteLength,
          blobSize: asset.blob.size,
          sha256: [...new Uint8Array(digest)]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join(""),
        },
      };
    },
    { notebookId: book.id, assetId: uniqueAssetId },
  );
  assert(backupResult.zipBytes > 1_000, "Backup must contain real ZIP bytes");
  assert.equal(backupResult.manifest.assetCount, book.uniqueIds.length + 1);
  assert.deepEqual(backupResult.warnings, []);
  assert.deepEqual(
    [...backupResult.assetIds].sort(),
    [...book.uniqueIds, book.sharedId].sort(),
    "Backup must include every referenced asset, including the shared one",
  );
  assert.deepEqual(backupResult.asset, originalFingerprint);

  await page.evaluate(() => window.__notesMemoryCache.trimUnusedAssetImages(true));
  await page.waitForTimeout(450);
  const cacheAfterExplicitTrim = await sample("after-explicit-trim");

  await page.reload({ waitUntil: "networkidle" });
  await attachModules();
  await page.evaluate(() => {
    window.__notesMemoryStore.getState().setZoom(0.55);
    window.__notesMemoryStore.getState().setPageIndex(0);
  });
  await page.waitForSelector(`[data-page-id="${firstPageId}"] canvas`);
  await page.locator(`[data-page-id="${firstPageId}"]`).scrollIntoViewIfNeeded();
  await waitForPageImage(firstPageId);
  assert.deepEqual(
    await assetFingerprint(uniqueAssetId),
    originalFingerprint,
    "Reload after cache eviction must render from unchanged durable storage",
  );

  return {
    uniqueDeleteUndoRedo: true,
    sharedReferencePreserved: true,
    exportResult,
    backupResult: {
      zipBytes: backupResult.zipBytes,
      assetCount: backupResult.manifest.assetCount,
    },
    originalFingerprint,
    cacheAfterExplicitTrim,
    reloadRendered: true,
  };
}

async function probeHighResolutionImages() {
  await page.goto(origin, { waitUntil: "networkidle" });
  await attachModules();
  await page.waitForTimeout(450);
  await page.evaluate(() => window.__notesMemoryCache.trimUnusedAssetImages(true));

  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4096;
    canvas.height = 4096;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("High-resolution probe canvas is unavailable");
    const assetIds = [];
    for (let index = 0; index < 8; index += 1) {
      context.fillStyle = `hsl(${index * 41} 58% 38%)`;
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "white";
      context.font = "700 320px sans-serif";
      context.fillText(`4K ${index + 1}`, 400, 2200);
      const blob = await new Promise((resolveBlob, reject) =>
        canvas.toBlob(
          (value) => (value ? resolveBlob(value) : reject(new Error("4K PNG encode failed"))),
          "image/png",
        ),
      );
      const id = crypto.randomUUID();
      assetIds.push(id);
      await window.__notesMemoryDb.putAsset({
        id,
        kind: "image",
        mime: "image/png",
        name: `memory-4k-${index + 1}.png`,
        byteLength: blob.size,
        blob,
        createdAt: Date.now(),
      });
    }
    canvas.width = 1;
    canvas.height = 1;

    const fingerprint = async (id) => {
      const asset = await window.__notesMemoryDb.getAsset(id);
      const bytes = await asset.blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return {
        size: asset.blob.size,
        sha256: [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join(""),
      };
    };
    const beforeFingerprint = await fingerprint(assetIds[0]);
    const leases = assetIds.map((id) =>
      window.__notesMemoryCache.acquireAssetImage(id, "visible", 512),
    );
    await Promise.all(leases.map((lease) => lease.promise));
    const whilePinned = window.__notesMemoryCache.getImageCacheStats();
    for (const lease of leases) lease.release();
    window.__notesMemoryCache.trimUnusedAssetImages(true);
    const afterTrim = window.__notesMemoryCache.getImageCacheStats();
    const afterFingerprint = await fingerprint(assetIds[0]);
    return {
      count: assetIds.length,
      sourceWidth: 4096,
      sourceHeight: 4096,
      fullDecodeEstimateBytes: assetIds.length * 4096 * 4096 * 4,
      requestedPreviewDimension: 512,
      whilePinned,
      afterTrim,
      durableFingerprintUnchanged:
        beforeFingerprint.size === afterFingerprint.size &&
        beforeFingerprint.sha256 === afterFingerprint.sha256,
    };
  });

  assert.equal(result.count, 8);
  assert(
    result.whilePinned.estimatedDecodedBytes <= result.count * 512 * 512 * 4,
    "4K canvas previews must decode to their requested bounded tier",
  );
  assert(result.whilePinned.peakConcurrent <= result.whilePinned.maxConcurrent);
  assert.equal(result.afterTrim.entries, 0);
  assert.equal(result.durableFingerprintUnchanged, true);
  return result;
}

async function runAsyncDecodeRaceChecks(fixture) {
  const staleIds = fixture.large.uniqueIds.slice(20, 32);
  await page.evaluate((assetIds) => {
    window.__notesMemoryCache.trimUnusedAssetImages(true);
    const originalCreateImageBitmap = globalThis.createImageBitmap.bind(globalThis);
    globalThis.createImageBitmap = (...args) =>
      new Promise((resolveBitmap, reject) => {
        window.setTimeout(() => {
          void originalCreateImageBitmap(...args).then(resolveBitmap, reject);
        }, 500);
      });
    const before = window.__notesMemoryCache.getImageCacheStats();
    const leases = assetIds.map((id) =>
      window.__notesMemoryCache.acquireAssetImage(id, "near", 512),
    );
    window.__notesMemoryRace = {
      before,
      leases,
      originalCreateImageBitmap,
      settled: Promise.allSettled(leases.map((lease) => lease.promise)),
    };
  }, staleIds);
  await page.waitForFunction(() => window.__notesMemoryCache.getImageCacheStats().activeLoads > 0);

  // A real route change unmounts the old PageSurfaces while their decodes are
  // still delayed. The manual leases below represent the same outstanding set
  // and are released at the route boundary.
  await clickNotebook(fixture.second.name);
  const result = await page.evaluate(async (validAssetId) => {
    const race = window.__notesMemoryRace;
    try {
      for (const lease of race.leases) lease.release();
      window.__notesMemoryCache.trimUnusedAssetImages(true);
      const fresh = window.__notesMemoryCache.acquireAssetImage(validAssetId, "visible", 512);
      const freshImage = await fresh.promise;
      const freshWidth = freshImage.naturalWidth || freshImage.width;
      const oldResults = await race.settled;
      fresh.release();

      const missingId = `missing-${crypto.randomUUID()}`;
      const retryFailures = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const missing = window.__notesMemoryCache.acquireAssetImage(missingId, "visible", 512);
        try {
          await missing.promise;
          retryFailures.push("unexpected-success");
        } catch (error) {
          retryFailures.push(error instanceof Error ? error.message : String(error));
        } finally {
          missing.release();
        }
      }
      const after = window.__notesMemoryCache.getImageCacheStats();
      window.__notesMemoryCache.trimUnusedAssetImages(true);
      return {
        staleRequests: oldResults.length,
        staleRejected: oldResults.filter((entry) => entry.status === "rejected").length,
        freshWidth,
        retryFailures,
        cancellationsDelta: after.cancellations - race.before.cancellations,
        failuresDelta: after.failures - race.before.failures,
        peakConcurrent: after.peakConcurrent,
        maxConcurrent: after.maxConcurrent,
      };
    } finally {
      globalThis.createImageBitmap = race.originalCreateImageBitmap;
      delete window.__notesMemoryRace;
    }
  }, fixture.second.uniqueIds.at(-1));

  assert.equal(result.staleRejected, result.staleRequests);
  assert(result.cancellationsDelta >= result.staleRequests);
  assert.equal(result.retryFailures.length, 2);
  assert(result.retryFailures.every((message) => message !== "unexpected-success"));
  assert(result.failuresDelta >= 2, "A failed asset must be retried rather than cached forever");
  assert(result.freshWidth > 0);
  assert(result.peakConcurrent <= result.maxConcurrent);
  await page.locator(`[data-page-id="${fixture.second.pageIds[0]}"]`).scrollIntoViewIfNeeded();
  await waitForPageImage(fixture.second.pageIds[0]);
  await clickNotebook(fixture.large.name);
  return result;
}

let fixture;
const samples = [];
let lifecycle;
let highResolutionProbe;
let asyncRaceChecks;
const startedAt = Date.now();
try {
  await page.goto(origin, { waitUntil: "networkidle" });
  await attachModules();
  fixture = await createFixture();
  await page.goto(`${origin}/notebook/${fixture.large.id}`, { waitUntil: "networkidle" });
  await attachModules();
  await page.evaluate(() => window.__notesMemoryStore.getState().setZoom(0.55));
  await page.waitForSelector("[data-page-id] canvas");

  samples.push(await sample("fixture-open"));
  samples.push(...(await scrollBook(fixture.large, 3)));

  const revisitStarted = Date.now();
  await page.locator(`[data-page-id="${fixture.large.pageIds[0]}"]`).scrollIntoViewIfNeeded();
  await waitForPageImage(fixture.large.pageIds[0]);
  const revisitLatencyMs = Date.now() - revisitStarted;
  samples.push(await sample("large-revisited"));

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await clickNotebook(fixture.second.name);
    await page
      .locator(`[data-page-id="${fixture.second.pageIds.at(-1)}"]`)
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    samples.push(await sample(`switch-${cycle + 1}-second`));
    await clickNotebook(fixture.large.name);
    await page.locator(`[data-page-id="${fixture.large.pageIds[0]}"]`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(350);
    samples.push(await sample(`switch-${cycle + 1}-large`));
  }

  asyncRaceChecks = await runAsyncDecodeRaceChecks(fixture);
  lifecycle = await runLifecycleChecks(fixture.large);
  samples.push(lifecycle.cacheAfterExplicitTrim);
  samples.push(await sample("after-reload"));
  highResolutionProbe = await probeHighResolutionImages();

  if (label !== "baseline") {
    const settled = samples.filter((entry) => entry.name !== "fixture-open");
    for (const entry of settled) {
      assert(
        entry.cache.estimatedDecodedBytes <= entry.cache.maxBytes,
        `${entry.name}: decoded cache exceeded its byte budget`,
      );
      assert(
        entry.cache.entries <= entry.cache.maxEntries,
        `${entry.name}: decoded cache exceeded its entry budget`,
      );
      assert.equal(entry.probe.failedBlobImageLoads, 0, `${entry.name}: an image decode failed`);
    }
    const finalProbe = samples.at(-1).probe;
    assert(
      finalProbe.peakBlobImageLoads <= samples.at(-1).cache.maxConcurrent,
      `Peak image decode concurrency ${finalProbe.peakBlobImageLoads} exceeded the scheduler limit`,
    );
    assert.equal(finalProbe.activeBlobImageLoads, 0);
    assert.equal(finalProbe.liveObjectUrls, 0, "All transient Blob URLs must be revoked when idle");
    const scrollSamples = samples.filter((entry) => entry.name.startsWith("scroll-round-"));
    const priorCanvasPixels = Math.max(
      ...scrollSamples.slice(0, -1).map((entry) => entry.canvases.backingPixels),
    );
    assert(
      scrollSamples.at(-1).canvases.backingPixels <= priorCanvasPixels,
      "Canvas backing stores must plateau across repeated full-book traversal",
    );
    assert(revisitLatencyMs < 2_000, `Image revisit took ${revisitLatencyMs} ms`);
  }

  const report = {
    label,
    origin,
    durationMs: Date.now() - startedAt,
    fixture: {
      largePages: fixture.large.pageIds.length,
      secondPages: fixture.second.pageIds.length,
      decodedImageWidth: 1536,
      decodedImageHeight: 1024,
      estimatedBytesPerDecodedImage: 1536 * 1024 * 4,
      largeDistinctAssets: fixture.large.uniqueIds.length + 1,
      secondDistinctAssets: fixture.second.uniqueIds.length + 1,
    },
    revisitLatencyMs,
    samples,
    lifecycle,
    highResolutionProbe,
    asyncRaceChecks,
    errors,
    warnings,
    limitations: [
      "Decoded byte totals are width × height × 4 estimates and exclude browser/GPU overhead.",
      "performance.memory is Chromium JavaScript heap only; this run does not claim native desktop RAM.",
      "The disposable browser context contains synthetic QA notebooks only.",
    ],
  };
  assert.deepEqual(errors, [], `Browser errors: ${errors.join(" | ")}`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close();
  await browser.close();
}
