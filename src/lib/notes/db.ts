import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  AppSettings,
  AssetRecord,
  BackupRecord,
  Bookmark,
  CanvasObject,
  Folder,
  Notebook,
  PageRecord,
  StoredDocumentContent,
  NoteLink,
  NoteVersion,
} from "./types";
import * as desktop from "./desktop-db";
import { normalizeSettings } from "./validation";

interface NotesDB extends DBSchema {
  folders: { key: string; value: Folder };
  notebooks: { key: string; value: Notebook };
  pages: { key: string; value: PageRecord; indexes: { "by-notebook": string } };
  pageObjects: { key: string; value: { pageId: string; objects: CanvasObject[] } };
  assets: { key: string; value: AssetRecord };
  bookmarks: { key: string; value: Bookmark; indexes: { "by-notebook": string } };
  kv: { key: string; value: unknown };
  backups: { key: string; value: BackupRecord };
  documents: { key: string; value: StoredDocumentContent };
  note_links: { key: string; value: NoteLink; indexes: { "by-source": string; "by-target": string } };
  note_versions: { key: string; value: NoteVersion; indexes: { "by-note": string } };
}

const DB_NAME = "notes-app";
const DB_VERSION = 2;

export interface LibraryDump {
  folders: Folder[];
  notebooks: Notebook[];
  pages: PageRecord[];
  pageObjects: { pageId: string; objects: CanvasObject[] }[];
  assets: AssetRecord[];
  bookmarks: Bookmark[];
  settings: AppSettings | undefined;
  meta: Record<string, unknown> | undefined;
}

let dbPromise: Promise<IDBPDatabase<NotesDB>> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<NotesDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("folders", { keyPath: "id" });
          db.createObjectStore("notebooks", { keyPath: "id" });
          const pages = db.createObjectStore("pages", { keyPath: "id" });
          pages.createIndex("by-notebook", "notebookId");
          db.createObjectStore("pageObjects", { keyPath: "pageId" });
          db.createObjectStore("assets", { keyPath: "id" });
          const bm = db.createObjectStore("bookmarks", { keyPath: "id" });
          bm.createIndex("by-notebook", "notebookId");
          db.createObjectStore("kv");
          db.createObjectStore("backups", { keyPath: "id" });
        }
        if (oldVersion < 2) {
          db.createObjectStore("documents", { keyPath: "noteId" });
          
          const noteLinks = db.createObjectStore("note_links", { keyPath: "id" });
          noteLinks.createIndex("by-source", "sourceNoteId");
          noteLinks.createIndex("by-target", "targetNoteId");
          
          const noteVersions = db.createObjectStore("note_versions", { keyPath: "id" });
          noteVersions.createIndex("by-note", "noteId");
        }
      },
    });
  }
  return dbPromise;
}

export async function initializeStorage() {
  if (desktop.isDesktopRuntime()) return desktop.initializeStorage();
  await getDb();
}

export async function loadSettingsAndMeta(options?: { safeMode?: boolean }) {
  if (desktop.isDesktopRuntime()) return desktop.loadSettingsAndMeta(options);
  const database = await getDb();
  const [settingsResult, metaResult] = await Promise.allSettled([
    database.get("kv", "settings"),
    database.get("kv", "meta"),
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
        ? (metaResult.value as Record<string, unknown>)
        : {},
    warnings,
  };
}

export async function loadLibraryRecords() {
  if (desktop.isDesktopRuntime()) return desktop.loadLibraryRecords();
  const database = await getDb();
  const [folders, notebooks] = await Promise.all([
    database.getAll("folders"),
    database.getAll("notebooks"),
  ]);
  return { folders, notebooks };
}

export async function loadLibrary() {
  const [library, startup] = await Promise.all([loadLibraryRecords(), loadSettingsAndMeta()]);
  return { ...library, settings: startup.settings, meta: startup.meta };
}

export async function loadStartupData(options?: { safeMode?: boolean }) {
  if (desktop.isDesktopRuntime()) return desktop.loadStartupData(options);
  const [library, startup] = await Promise.all([
    loadLibraryRecords(),
    loadSettingsAndMeta(options),
  ]);
  return { ...library, ...startup };
}

export async function putFolder(folder: Folder) {
  if (desktop.isDesktopRuntime()) return desktop.putFolder(folder);
  await (await getDb()).put("folders", folder);
}
export async function delFolder(id: string) {
  if (desktop.isDesktopRuntime()) return desktop.delFolder(id);
  await (await getDb()).delete("folders", id);
}
export async function putNotebook(nb: Notebook) {
  if (desktop.isDesktopRuntime()) return desktop.putNotebook(nb);
  await (await getDb()).put("notebooks", nb);
}
export async function delNotebook(id: string) {
  if (desktop.isDesktopRuntime()) return desktop.delNotebook(id);
  await (await getDb()).delete("notebooks", id);
}
export async function putPage(page: PageRecord) {
  if (desktop.isDesktopRuntime()) return desktop.putPage(page);
  await (await getDb()).put("pages", page);
}
export async function putPagesBatch(pages: PageRecord[]) {
  if (pages.length === 0) return;
  if (desktop.isDesktopRuntime()) return desktop.putPagesBatch(pages);
  const database = await getDb();
  const tx = database.transaction("pages", "readwrite");
  await Promise.all(pages.map((page) => tx.store.put(page)));
  await tx.done;
}
export async function delPage(id: string) {
  if (desktop.isDesktopRuntime()) return desktop.delPage(id);
  const db = await getDb();
  await db.delete("pages", id);
  await db.delete("pageObjects", id);
}
export async function putObjects(pageId: string, objects: CanvasObject[]) {
  if (desktop.isDesktopRuntime()) return desktop.putObjects(pageId, objects);
  await (await getDb()).put("pageObjects", { pageId, objects });
}
export async function putObjectsBatch(entries: { pageId: string; objects: CanvasObject[] }[]) {
  if (entries.length === 0) return;
  if (desktop.isDesktopRuntime()) return desktop.putObjectsBatch(entries);
  const database = await getDb();
  const tx = database.transaction("pageObjects", "readwrite");
  await Promise.all(
    entries.map(({ pageId, objects }) => tx.store.put({ pageId, objects })),
  );
  await tx.done;
}
export async function putAsset(asset: AssetRecord) {
  if (desktop.isDesktopRuntime()) return desktop.putAsset(asset);
  await (await getDb()).put("assets", asset);
}
export async function getAsset(id: string) {
  if (desktop.isDesktopRuntime()) return desktop.getAsset(id);
  return (await getDb()).get("assets", id);
}
export async function delAsset(id: string) {
  if (desktop.isDesktopRuntime()) return desktop.delAsset(id);
  await (await getDb()).delete("assets", id);
}
export async function putBookmark(b: Bookmark) {
  if (desktop.isDesktopRuntime()) return desktop.putBookmark(b);
  await (await getDb()).put("bookmarks", b);
}
export async function delBookmark(id: string) {
  if (desktop.isDesktopRuntime()) return desktop.delBookmark(id);
  await (await getDb()).delete("bookmarks", id);
}
export async function putSettings(s: AppSettings) {
  if (desktop.isDesktopRuntime()) return desktop.putSettings(s);
  await (await getDb()).put("kv", s, "settings");
}
export async function putMeta(meta: Record<string, unknown>) {
  if (desktop.isDesktopRuntime()) return desktop.putMeta(meta);
  await (await getDb()).put("kv", meta, "meta");
}

export async function putDocument(noteId: string, doc: StoredDocumentContent) {
  if (desktop.isDesktopRuntime()) return desktop.putDocument(noteId, doc);
  await (await getDb()).put("documents", doc); // the store expects the object to have the keyPath (which we set to noteId, so doc should contain noteId)
  // Wait, let's just pass noteId directly if the store doesn't have a keyPath that matches.
}
export async function getDocument(noteId: string): Promise<StoredDocumentContent | undefined> {
  if (desktop.isDesktopRuntime()) return desktop.getDocument(noteId);
  return (await getDb()).get("documents", noteId);
}

export async function putNoteVersion(version: NoteVersion) {
  if (desktop.isDesktopRuntime()) return desktop.putNoteVersion(version);
  await (await getDb()).put("note_versions", version);
}

export async function getNoteVersions(noteId: string): Promise<NoteVersion[]> {
  if (desktop.isDesktopRuntime()) return desktop.getNoteVersions(noteId);
  const db = await getDb();
  const allVersions = await db.getAllFromIndex("note_versions", "by-note", noteId);
  return allVersions.sort((a, b) => b.createdAt - a.createdAt);
}
export async function delDocument(noteId: string) {
  if (desktop.isDesktopRuntime()) return desktop.delDocument(noteId);
  await (await getDb()).delete("documents", noteId);
}
export async function putBackup(rec: BackupRecord) {
  if (desktop.isDesktopRuntime()) return desktop.putBackup(rec);
  await (await getDb()).put("backups", rec);
}
export async function delBackup(id: string) {
  if (desktop.isDesktopRuntime()) return desktop.delBackup(id);
  await (await getDb()).delete("backups", id);
}
export async function listBackups() {
  if (desktop.isDesktopRuntime()) return desktop.listBackups();
  const all = await (await getDb()).getAll("backups");
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadNotebookPayload(notebookId: string) {
  if (desktop.isDesktopRuntime()) return desktop.loadNotebookPayload(notebookId);
  const db = await getDb();
  const pages = (await db.getAllFromIndex("pages", "by-notebook", notebookId)).sort(
    (a, b) => a.index - b.index,
  );
  const objects: Record<string, CanvasObject[]> = {};
  await Promise.all(
    pages.map(async (p) => {
      const doc = await db.get("pageObjects", p.id);
      objects[p.id] = doc?.objects ?? [];
    }),
  );
  const bookmarks = await db.getAllFromIndex("bookmarks", "by-notebook", notebookId);
  return { pages, objects, bookmarks };
}

export async function dumpAll(): Promise<LibraryDump> {
  if (desktop.isDesktopRuntime()) return desktop.dumpAll();
  const db = await getDb();
  const [folders, notebooks, pages, pageObjects, assets, bookmarks, settings, meta] =
    await Promise.all([
      db.getAll("folders"),
      db.getAll("notebooks"),
      db.getAll("pages"),
      db.getAll("pageObjects"),
      db.getAll("assets"),
      db.getAll("bookmarks"),
      db.get("kv", "settings"),
      db.get("kv", "meta"),
    ]);
  return {
    folders,
    notebooks,
    pages,
    pageObjects,
    assets,
    bookmarks,
    settings: settings as AppSettings | undefined,
    meta: meta as Record<string, unknown> | undefined,
  };
}

export async function replaceAll(data: LibraryDump) {
  if (desktop.isDesktopRuntime()) return desktop.replaceAll(data);
  const db = await getDb();
  const tx = db.transaction(
    ["folders", "notebooks", "pages", "pageObjects", "assets", "bookmarks", "kv"],
    "readwrite",
  );
  await Promise.all([
    tx.objectStore("folders").clear(),
    tx.objectStore("notebooks").clear(),
    tx.objectStore("pages").clear(),
    tx.objectStore("pageObjects").clear(),
    tx.objectStore("assets").clear(),
    tx.objectStore("bookmarks").clear(),
  ]);
  for (const f of data.folders) await tx.objectStore("folders").put(f);
  for (const n of data.notebooks) await tx.objectStore("notebooks").put(n);
  for (const p of data.pages) await tx.objectStore("pages").put(p);
  for (const o of data.pageObjects) await tx.objectStore("pageObjects").put(o);
  for (const a of data.assets) await tx.objectStore("assets").put(a);
  for (const b of data.bookmarks) await tx.objectStore("bookmarks").put(b);
  if (data.settings) await tx.objectStore("kv").put(data.settings, "settings");
  if (data.meta) await tx.objectStore("kv").put(data.meta, "meta");
  await tx.done;
}

export async function mergeDump(data: LibraryDump) {
  if (desktop.isDesktopRuntime()) return desktop.mergeDump(data);
  const db = await getDb();
  const tx = db.transaction(
    ["folders", "notebooks", "pages", "pageObjects", "assets", "bookmarks"],
    "readwrite",
  );
  for (const f of data.folders) await tx.objectStore("folders").put(f);
  for (const n of data.notebooks) await tx.objectStore("notebooks").put(n);
  for (const p of data.pages) await tx.objectStore("pages").put(p);
  for (const o of data.pageObjects) await tx.objectStore("pageObjects").put(o);
  for (const a of data.assets) await tx.objectStore("assets").put(a);
  for (const b of data.bookmarks) await tx.objectStore("bookmarks").put(b);
  await tx.done;
}

export async function storageEstimate() {
  if (desktop.isDesktopRuntime()) return desktop.storageEstimate();
  if (navigator.storage?.estimate) {
    const e = await navigator.storage.estimate();
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}

export function isNativeStorage() {
  return desktop.isDesktopRuntime();
}

export async function openDataFolder() {
  if (!desktop.isDesktopRuntime()) {
    throw new Error("Chỉ bản Windows mới có thể mở thư mục dữ liệu.");
  }
  await desktop.openDataFolder();
}

export async function flushStorage() {
  if (desktop.isDesktopRuntime()) {
    await desktop.flushStorage();
  }
}

const urlCache = new Map<string, string>();
const MAX_OBJECT_URLS = 48;

export function objectUrlFor(id: string, blob: Blob) {
  const existing = urlCache.get(id);
  if (existing) {
    urlCache.delete(id);
    urlCache.set(id, existing);
    return existing;
  }
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  while (urlCache.size > MAX_OBJECT_URLS) {
    const oldest = urlCache.keys().next().value as string | undefined;
    if (!oldest || oldest === id) break;
    revokeObjectUrl(oldest);
  }
  return url;
}

export function revokeObjectUrl(id: string) {
  const u = urlCache.get(id);
  if (u) {
    URL.revokeObjectURL(u);
    urlCache.delete(id);
  }
}

export async function getPomodoroSession() {
  if (desktop.isDesktopRuntime()) return desktop.getPomodoroSession();
  return null;
}

export async function getPomodoroHistory() {
  if (desktop.isDesktopRuntime()) return desktop.getPomodoroHistory();
  return [];
}

export async function putPomodoroSession(session: import("./types").PomodoroSession | null) {
  if (desktop.isDesktopRuntime()) return desktop.putPomodoroSession(session);
}

export async function putPomodoroRecord(record: import("./types").PomodoroRecord) {
  if (desktop.isDesktopRuntime()) return desktop.putPomodoroRecord(record);
}

export async function clearPomodoroHistory() {
  if (desktop.isDesktopRuntime()) return desktop.clearPomodoroHistory();
}
