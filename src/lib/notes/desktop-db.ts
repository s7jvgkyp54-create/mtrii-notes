import type {
  AppSettings,
  AssetRecord,
  BackupRecord,
  Bookmark,
  CanvasObject,
  Folder,
  Notebook,
  PageRecord
} from "./types";
import { normalizeSettings } from "./validation";
type Entity = "folders" | "notebooks" | "pages" | "pageObjects" | "bookmarks" | "tombstones" | "backups" | "pomodoroHistory" | "documents" | "note_links" | "note_versions";
type AssetPayload = {
  meta: Omit<AssetRecord, "blob">;
  bytes: number[];
};

type BackupPayload = {
  meta: Omit<BackupRecord, "blob">;
  bytes: number[];
};

export type DesktopDump = {
  folders: Folder[];
  notebooks: Notebook[];
  pages: PageRecord[];
  pageObjects: { pageId: string; objects: CanvasObject[] }[];
  assets: AssetRecord[];
  bookmarks: Bookmark[];
  settings: AppSettings | undefined;
  meta: Record<string, unknown> | undefined;
};

type DesktopStartupData = {
  folders: Folder[];
  notebooks: Notebook[];
  settings: AppSettings | null;
  meta: Record<string, unknown> | null;
};

let initPromise: Promise<void> | null = null;

export function isDesktopRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, args: Record<string, unknown> = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function ready() {
  if (!initPromise) {
    initPromise = call<void>("native_initialize").catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

export async function initializeStorage() {
  await ready();
}

async function all<T>(entity: Entity) {
  await ready();
  return call<T[]>("native_get_all", { entity });
}

async function byNotebook<T>(entity: Entity, notebookId: string) {
  await ready();
  return call<T[]>("native_get_by_notebook", { entity, notebookId });
}

async function put(entity: Entity, id: string, value: unknown) {
  await ready();
  await call("native_put_json", { entity, id, value });
}

async function putMany(writes: { entity: Entity; id: string; value: unknown }[]) {
  if (writes.length === 0) return;
  await ready();
  await call("native_put_json_batch", { writes });
}

async function remove(entity: Entity, id: string) {
  await ready();
  await call("native_delete", { entity, id });
}

async function kvGet<T>(key: string) {
  await ready();
  return call<T | null>("native_get_kv", { key });
}

async function kvPut(key: string, value: unknown) {
  await ready();
  await call("native_put_kv", { key, value });
}

export async function loadLibrary() {
  const [library, startup] = await Promise.all([loadLibraryRecords(), loadSettingsAndMeta()]);
  return { ...library, settings: startup.settings, meta: startup.meta };
}

export async function loadSettingsAndMeta(options?: { safeMode?: boolean }) {
  const [settingsResult, metaResult] = await Promise.allSettled([
    kvGet<AppSettings>("settings"),
    kvGet<Record<string, unknown>>("meta"),
  ]);
  const warnings: string[] = [];
  if (settingsResult.status === "rejected") warnings.push("Không đọc được cài đặt; đã dùng mặc định.");
  if (metaResult.status === "rejected") warnings.push("Không đọc được metadata khởi động.");
  return {
    settings: normalizeSettings(
      settingsResult.status === "fulfilled" ? settingsResult.value : undefined,
      options?.safeMode,
    ),
    meta:
      metaResult.status === "fulfilled" && metaResult.value && typeof metaResult.value === "object"
        ? metaResult.value
        : {},
    warnings,
  };
}

export async function loadStartupData(options?: { safeMode?: boolean }) {
  await ready();
  const data = await call<DesktopStartupData>("native_load_startup_data");
  return {
    folders: data.folders,
    notebooks: data.notebooks,
    settings: normalizeSettings(data.settings ?? undefined, options?.safeMode),
    meta: data.meta ?? {},
    warnings: [] as string[],
  };
}

export async function loadLibraryRecords() {
  const [folders, notebooks] = await Promise.all([
    all<Folder>("folders"),
    all<Notebook>("notebooks"),
  ]);
  return { folders, notebooks };
}

export const putFolder = (folder: Folder) => put("folders", folder.id, folder);
export const delFolder = async (id: string) => { await remove("folders", id); await put("tombstones", id, { id, type: "folder", deletedAt: Date.now() }); };
export const putNotebook = (notebook: Notebook) => put("notebooks", notebook.id, notebook);
export const delNotebook = async (id: string) => { await remove("notebooks", id); await put("tombstones", id, { id, type: "notebook", deletedAt: Date.now() }); };
export const putPage = (page: PageRecord) => put("pages", page.id, page);
export const putPagesBatch = (pages: PageRecord[]) =>
  putMany(pages.map((page) => ({ entity: "pages" as const, id: page.id, value: page })));
export const delPage = async (id: string) => { await remove("pages", id); await put("tombstones", id, { id, type: "page", deletedAt: Date.now() }); };
export const putObjects = (pageId: string, objects: CanvasObject[]) =>
  put("pageObjects", pageId, { pageId, objects, updatedAt: Date.now() });
export const putObjectsBatch = (entries: { pageId: string; objects: CanvasObject[] }[]) => {
  const updatedAt = Date.now();
  return putMany(
    entries.map(({ pageId, objects }) => ({
      entity: "pageObjects" as const,
      id: pageId,
      value: { pageId, objects, updatedAt },
    })),
  );
};
export const putBookmark = (bookmark: Bookmark) => put("bookmarks", bookmark.id, bookmark);
export const delBookmark = async (id: string) => { await remove("bookmarks", id); await put("tombstones", id, { id, type: "bookmark", deletedAt: Date.now() }); };
export const putSettings = (settings: AppSettings) => kvPut("settings", settings);
export const putMeta = (meta: Record<string, unknown>) => kvPut("meta", meta);

export async function putAsset(asset: AssetRecord) {
  await ready();
  const { blob, ...meta } = asset;
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await call("native_put_asset", { payload: { meta, bytes } satisfies AssetPayload });
}

export async function getAsset(id: string): Promise<AssetRecord | undefined> {
  await ready();
  const payload = await call<AssetPayload | null>("native_get_asset", { id });
  if (!payload) return undefined;
  return {
    ...payload.meta,
    blob: new Blob([new Uint8Array(payload.bytes)], { type: payload.meta.mime }),
  };
}

export async function delAsset(id: string) {
  await ready();
  await call("native_delete_asset", { id });
}

export async function putBackup(record: BackupRecord) {
  await ready();
  const { blob, ...meta } = record;
  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  await call("native_put_backup", { payload: { meta, bytes } satisfies BackupPayload });
}

export async function delBackup(id: string) {
  await ready();
  await call("native_delete_backup", { id });
}

export async function listBackups() {
  await ready();
  const metas = await call<Omit<BackupRecord, "blob">[]>("native_list_backups");
  const records = await Promise.all(metas.map((meta) => getBackup(meta.id)));
  return records.filter((record): record is BackupRecord => Boolean(record));
}

export async function getBackup(id: string): Promise<BackupRecord | undefined> {
  await ready();
  const payload = await call<BackupPayload | null>("native_get_backup", { id });
  if (!payload) return undefined;
  return {
    ...payload.meta,
    blob: new Blob([new Uint8Array(payload.bytes)], { type: "application/zip" }),
  };
}

export async function loadNotebookPayload(notebookId: string) {
  const [pages, rows, bookmarks] = await Promise.all([
    byNotebook<PageRecord>("pages", notebookId),
    byNotebook<{ pageId: string; objects: CanvasObject[] }>("pageObjects", notebookId),
    byNotebook<Bookmark>("bookmarks", notebookId),
  ]);
  pages.sort((a, b) => a.index - b.index);
  const objects: Record<string, CanvasObject[]> = {};
  for (const row of rows) objects[row.pageId] = row.objects;
  for (const page of pages) objects[page.id] ??= [];
  return { pages, objects, bookmarks };
}

export async function dumpAll(): Promise<DesktopDump> {
  const [folders, notebooks, pages, pageObjects, assetIds, bookmarks, settings, meta] =
    await Promise.all([
      all<Folder>("folders"),
      all<Notebook>("notebooks"),
      all<PageRecord>("pages"),
      all<{ pageId: string; objects: CanvasObject[] }>("pageObjects"),
      call<string[]>("native_list_asset_ids"),
      all<Bookmark>("bookmarks"),
      kvGet<AppSettings>("settings"),
      kvGet<Record<string, unknown>>("meta"),
    ]);
  const assets = (await Promise.all(assetIds.map(getAsset))).filter(
    (asset): asset is AssetRecord => Boolean(asset),
  );
  return { folders, notebooks, pages, pageObjects, assets, bookmarks, settings: settings ?? undefined, meta: meta ?? undefined };
}

async function importDump(data: DesktopDump, replace: boolean) {
  await ready();
  const assets: AssetPayload[] = await Promise.all(
    data.assets.map(async ({ blob, ...meta }) => ({
      meta,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    })),
  );
  await call("native_import_dump", {
    payload: {
      folders: data.folders,
      notebooks: data.notebooks,
      pages: data.pages,
      pageObjects: data.pageObjects,
      assets,
      bookmarks: data.bookmarks,
      settings: data.settings ?? null,
      appMeta: data.meta ?? null,
    },
    replace,
  });
}

export const replaceAll = (data: DesktopDump) => importDump(data, true);
export const mergeDump = (data: DesktopDump) => importDump(data, false);

export async function storageEstimate() {
  await ready();
  const usage = await call<number>("native_storage_usage");
  return { usage, quota: 0 };
}

export async function openDataFolder() {
  await ready();
  await call("native_open_data_folder");
}

export async function flushStorage() {
  await ready();
  await call("native_flush_storage");
}

export const putBackupManifest = (manifest: import("./types").BackupManifest) => put("backups", manifest.backupId, manifest);
export const getBackupManifests = () => all<import("./types").BackupManifest>("backups");
export const getTombstones = () => all<import("./types").Tombstone>("tombstones");

export async function dumpIncremental(lastBackupTime: number): Promise<DesktopDump & { tombstones: import("./types").Tombstone[] }> {
    const full = await dumpAll();
    const tombstones = await getTombstones();
    
    return {
        ...full,
        folders: full.folders.filter(f => f.updatedAt > lastBackupTime),
        notebooks: full.notebooks.filter(n => n.updatedAt > lastBackupTime),
        pages: full.pages.filter(p => p.updatedAt > lastBackupTime),
        // Note: pageObjects has updatedAt injected by putObjects, but types.ts doesn't enforce it yet
        pageObjects: full.pageObjects.filter(po => (po as any).updatedAt > lastBackupTime),
        bookmarks: full.bookmarks.filter(b => (b as any).updatedAt > lastBackupTime),
        tombstones: tombstones.filter(t => t.deletedAt > lastBackupTime)
    };
}

export async function restoreBackupChain(targetBackupId: string) {
  const record = await getBackup(targetBackupId);
  if (!record) throw new Error(`Không tìm thấy bản sao lưu ${targetBackupId}`);
  const { inspectBackup } = await import("./io");
  const preview = await inspectBackup(record.blob);
  await importDump(preview.dump, true);
}

export const putPomodoroRecord = (record: import("./types").PomodoroRecord) => put("pomodoroHistory", record.id, record);
export const getPomodoroHistory = () => all<import("./types").PomodoroRecord>("pomodoroHistory");
export const clearPomodoroHistory = async () => {
    const records = await getPomodoroHistory();
    for (const r of records) await remove("pomodoroHistory", r.id);
};

export const putPomodoroSession = (session: import("./types").PomodoroSession | null) => kvPut("pomodoroSession", session);
export const getPomodoroSession = () => kvGet<import("./types").PomodoroSession>("pomodoroSession");
