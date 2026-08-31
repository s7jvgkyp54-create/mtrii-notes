import type {
  AppSettings,
  AssetRecord,
  BackupRecord,
  Bookmark,
  CanvasObject,
  Folder,
  Notebook,
  PageRecord,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

type Entity = "folders" | "notebooks" | "pages" | "pageObjects" | "bookmarks";

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

let initPromise: Promise<void> | null = null;

export function isDesktopRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, args: Record<string, unknown> = {}) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

async function ready() {
  if (!initPromise) initPromise = call<void>("native_initialize");
  return initPromise;
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
  const [folders, notebooks, settingsRaw, meta] = await Promise.all([
    all<Folder>("folders"),
    all<Notebook>("notebooks"),
    kvGet<AppSettings>("settings"),
    kvGet<Record<string, unknown>>("meta"),
  ]);
  return {
    folders,
    notebooks,
    settings: { ...DEFAULT_SETTINGS, ...(settingsRaw ?? {}) },
    meta: meta ?? {},
  };
}

export const putFolder = (folder: Folder) => put("folders", folder.id, folder);
export const delFolder = (id: string) => remove("folders", id);
export const putNotebook = (notebook: Notebook) => put("notebooks", notebook.id, notebook);
export const delNotebook = (id: string) => remove("notebooks", id);
export const putPage = (page: PageRecord) => put("pages", page.id, page);
export const delPage = (id: string) => remove("pages", id);
export const putObjects = (pageId: string, objects: CanvasObject[]) =>
  put("pageObjects", pageId, { pageId, objects });
export const putBookmark = (bookmark: Bookmark) => put("bookmarks", bookmark.id, bookmark);
export const delBookmark = (id: string) => remove("bookmarks", id);
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
