import { create } from "zustand";
import { nid } from "@/lib/utils";
import type {
  AppSettings,
  BackupMeta,
  Bookmark,
  CanvasObject,
  Folder,
  LibrarySection,
  Notebook,
  PageRecord,
  PaperStyle,
  PenKind,
  ToolName,
  TocItem,
  EraserMode,
  Orientation,
  PageSizeName,
} from "./types";
import { COVER_COLORS, DEFAULT_PAPER, DEFAULT_SETTINGS, pageDimensions } from "./types";
import type { BackupPreview } from "./io";
import * as db from "./db";
import type { BootStageId } from "./startup";
import { partitionFolders, partitionNotebooks } from "./validation";

export type SaveStatus = "saved" | "saving" | "error";

export interface ToolState {
  name: ToolName;
  color: string;
  width: number;
  highlighterColor: string;
  highlighterWidth: number;
  eraserMode: EraserMode;
  eraserWidth: number;
  fontSize: number;
  shapeSnap: boolean;
}

const defaultTool: ToolState = {
  name: "ballpoint",
  color: "#1C1917",
  width: 2.2,
  highlighterColor: "#FACC15",
  highlighterWidth: 18,
  eraserMode: "stroke",
  eraserWidth: 16,
  fontSize: 22,
  shapeSnap: true,
};

interface HistoryBuf {
  past: { pageId: string; objects: CanvasObject[] }[];
  future: { pageId: string; objects: CanvasObject[] }[];
}

interface NotesState {
  pomodoroSession: import("./types").PomodoroSession | null;
  pomodoroHistory: import("./types").PomodoroRecord[];
  pomodoroTick: number;
  isNavigating: boolean;
  ready: boolean;
  bootError: string | null;
  folders: Folder[];
  notebooks: Notebook[];
  pages: PageRecord[];
  objectsByPage: Record<string, CanvasObject[]>;
  bookmarks: Bookmark[];
  settings: AppSettings;
  saveStatus: SaveStatus;
  saveError: string | null;
  lastSaveAt: number | null;
  storageUsage: number;
  storageQuota: number;
  backups: BackupMeta[];

  section: LibrarySection;
  folderId: string | null;
  query: string;
  sort: "name" | "updated";
  layout: "grid" | "list";
  selecting: boolean;
  selectedIds: string[];
  sidebarOpen: boolean;

  activeNotebookId: string | null;
  currentPageIndex: number;
  zoom: number;
  tool: ToolState;
  clipboard: CanvasObject[];
  history: Record<string, HistoryBuf>;
  toc: TocItem[];
  pdfSearchHits: { pageIndex: number; text: string }[];

  hydrate: (options?: HydrateOptions) => Promise<void>;
  persistSettings: (patch: Partial<AppSettings>) => void;
  refreshStorage: () => Promise<void>;

  setSection: (s: LibrarySection) => void;
  setFolder: (id: string | null) => void;
  setQuery: (q: string) => void;
  setSort: (s: "name" | "updated") => void;
  setLayout: (l: "grid" | "list") => void;
  setSelecting: (v: boolean) => void;
  toggleSelected: (id: string) => void;
  setSidebarOpen: (v: boolean) => void;
  setTool: (patch: Partial<ToolState>) => void;

  createFolder: (name: string, parentId: string | null) => Promise<string>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  createNotebook: (input: {
    name: string;
    folderId: string | null;
    cover: string;
    paper: PaperStyle;
    pageSize: PageSizeName;
    orientation: Orientation;
    pages?: number;
  }) => Promise<string>;
  importPdf: (file: File, folderId?: string | null) => Promise<string>;
  renameNotebook: (id: string, name: string) => Promise<void>;
  duplicateNotebook: (id: string) => Promise<string>;
  toggleFavorite: (id: string) => Promise<void>;
  moveNotebook: (id: string, folderId: string | null) => Promise<void>;
  trashNotebook: (id: string) => Promise<void>;
  restoreNotebook: (id: string) => Promise<void>;
  destroyNotebook: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  setCover: (id: string, color: string) => Promise<void>;

  openNotebook: (id: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  flushPendingWrites: () => Promise<void>;
  setPageIndex: (index: number) => void;
  setZoom: (z: number) => void;
  rememberView: () => void;

  addPage: (after?: number) => Promise<void>;
  duplicatePage: (pageId: string) => Promise<void>;
  deletePage: (pageId: string) => Promise<void>;
  rotatePage: (pageId: string) => Promise<void>;
  setPagePaper: (pageId: string, paper: PaperStyle) => Promise<void>;
  reorderPages: (from: number, to: number) => Promise<void>;

  commitObjects: (
    pageId: string,
    objects: CanvasObject[],
    undoable?: boolean,
    beforeState?: CanvasObject[],
  ) => void;
  undo: () => void;
  redo: () => void;
  addBookmark: (pageId: string, title: string) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;

  exportPdf: (notebookId: string) => Promise<void>;
  exportBackup: (kind: "full" | "notebook", notebookId?: string) => Promise<void>;
  importBackupFile: (
    file: File,
    mode: "merge" | "replace",
  ) => Promise<{ names: string[]; warnings: string[] }>;
  restoreStoredBackup: (backupId: string) => Promise<void>;
  previewBackup: (file: File) => Promise<BackupPreview>;
  runAutoBackup: () => Promise<void>;
  downloadStoredBackup: (id: string) => Promise<void>;
  deleteStoredBackup: (id: string) => Promise<void>;
}

export interface HydrateOptions {
  safeMode?: boolean;
  skipLastSession?: boolean;
  onStage?: (stage: BootStageId, detail?: string) => void;
  onWarning?: (message: string) => void;
}

let writeChain: Promise<void> = Promise.resolve();
let hydratePromise: Promise<void> | null = null;

function enqueue(label: string, task: () => Promise<void>) {
  const run = async () => {
    useNotesStore.setState({ saveStatus: "saving", saveError: null });
    try {
      await task();
      const ts = Date.now();
      useNotesStore.setState({
        saveStatus: "saved",
        lastSaveAt: ts,
        settings: { ...useNotesStore.getState().settings, lastSaveAt: ts },
      });
      await db.putSettings(useNotesStore.getState().settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useNotesStore.setState({ saveStatus: "error", saveError: message });
      console.error(`[notes] ${label}`, err);
    }
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

function patchNb(id: string, partial: Partial<Notebook>) {
  const notebooks = useNotesStore
    .getState()
    .notebooks.map((n) => (n.id === id ? { ...n, ...partial, updatedAt: Date.now() } : n));
  useNotesStore.setState({ notebooks });
  const nb = notebooks.find((n) => n.id === id);
  if (nb) void enqueue("notebook", () => db.putNotebook(nb));
}

let objectsSaveTimeout: any = null;
const pendingSaves = new Map<string, CanvasObject[]>();

async function drainPendingObjectSaves(createMirror = false) {
  if (objectsSaveTimeout) {
    clearTimeout(objectsSaveTimeout);
    objectsSaveTimeout = null;
  }
  const saves = Array.from(pendingSaves, ([pageId, objects]) => ({ pageId, objects }));
  pendingSaves.clear();
  if (saves.length > 0) {
    await enqueue("objects-batch", () => db.putObjectsBatch(saves));
  } else {
    await writeChain;
  }
  if (createMirror) await db.flushStorage();
}

function queueObjectSave(pageId: string, objects: CanvasObject[]) {
  pendingSaves.set(pageId, objects);
  if (objectsSaveTimeout) clearTimeout(objectsSaveTimeout);
  objectsSaveTimeout = setTimeout(() => {
    objectsSaveTimeout = null;
    const saves = Array.from(pendingSaves, ([pendingPageId, savedObjects]) => ({
      pageId: pendingPageId,
      objects: savedObjects,
    }));
    pendingSaves.clear();
    void enqueue("objects-batch", () => db.putObjectsBatch(saves));
  }, 500);
}

export const useNotesStore = create<NotesState>((set, get) => ({
  pomodoroSession: null,
  pomodoroHistory: [],
  pomodoroTick: 0,
  isNavigating: false,
  ready: false,
  bootError: null,
  folders: [],
  notebooks: [],
  pages: [],
  objectsByPage: {},
  bookmarks: [],
  settings: DEFAULT_SETTINGS,
  saveStatus: "saved",
  saveError: null,
  lastSaveAt: null,
  storageUsage: 0,
  storageQuota: 0,
  backups: [],

  section: "all",
  folderId: null,
  query: "",
  sort: "updated",
  layout: "grid",
  selecting: false,
  selectedIds: [],
  sidebarOpen: false,

  activeNotebookId: null,
  currentPageIndex: 0,
  zoom: 1,
  tool: defaultTool,
  clipboard: [],
  history: {},
  toc: [],
  pdfSearchHits: [],

  hydrate: (options = {}) => {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      set({ ready: false, bootError: null });
      try {
        options.onStage?.("database-opened");
        await db.initializeStorage();
        options.onStage?.("migration-complete");

        const startup = await db.loadStartupData({ safeMode: options.safeMode });
        for (const warning of startup.warnings) options.onWarning?.(warning);
        options.onStage?.(
          "settings-loaded",
          options.safeMode ? "Đang dùng cài đặt mặc định tạm thời" : undefined,
        );

        let library = { folders: startup.folders, notebooks: startup.notebooks };
        let meta = startup.meta as { initialized?: boolean };
        if (!meta.initialized && library.folders.length === 0 && library.notebooks.length === 0) {
          const { seedLibrary } = await import("./seed");
          await seedLibrary();
          await db.putMeta({ initialized: true, schemaVersion: 1 });
          await db.putSettings(DEFAULT_SETTINGS);
          library = await db.loadLibraryRecords();
          meta = { initialized: true };
        }

        const folderResult = partitionFolders(library.folders);
        const notebookResult = partitionNotebooks(library.notebooks);
        if (folderResult.quarantined > 0) {
          options.onWarning?.(
            `Đã cô lập ${folderResult.quarantined} thư mục có dữ liệu không hợp lệ.`,
          );
        }
        if (notebookResult.quarantined > 0) {
          options.onWarning?.(
            `Đã cô lập ${notebookResult.quarantined} sổ tay có dữ liệu không hợp lệ.`,
          );
        }
        options.onStage?.(
          "library-loaded",
          `${notebookResult.valid.length} sổ tay, ${folderResult.valid.length} thư mục`,
        );

        const settings = startup.settings;
        settings.openTabIds =
          options.safeMode || options.skipLastSession
            ? []
            : Array.from(
                new Set(
                  settings.openTabIds.filter((tabId) =>
                    notebookResult.valid.some((notebook) => notebook.id === tabId),
                  ),
                ),
              );

        let backups: BackupMeta[] = [];
        let pomodoroSession: import("./types").PomodoroSession | null = null;
        let pomodoroHistory: import("./types").PomodoroRecord[] = [];
        if (!options.safeMode) {
          const [backupResult, sessionResult, historyResult] = await Promise.allSettled([
            db.listBackups(),
            options.skipLastSession ? Promise.resolve(null) : db.getPomodoroSession(),
            db.getPomodoroHistory(),
          ]);
          if (backupResult.status === "fulfilled") {
            backups = backupResult.value.map(({ blob: _blob, ...rest }) => rest);
          } else options.onWarning?.("Không tải được danh sách sao lưu; thư viện vẫn được mở.");
          if (sessionResult.status === "fulfilled") pomodoroSession = sessionResult.value;
          else options.onWarning?.("Không khôi phục được Pomodoro; đã bỏ qua tính năng phụ này.");
          if (historyResult.status === "fulfilled") pomodoroHistory = historyResult.value;
          else options.onWarning?.("Không tải được lịch sử Pomodoro; đã bỏ qua tính năng phụ này.");
        }
        options.onStage?.(
          "session-restored",
          options.safeMode || options.skipLastSession ? "Đã bỏ qua phiên trước" : undefined,
        );

        set({
          pomodoroSession,
          pomodoroHistory,
          ready: true,
          bootError: null,
          folders: folderResult.valid,
          notebooks: notebookResult.valid,
          settings,
          lastSaveAt: settings.lastSaveAt,
          backups,
        });
        document.documentElement.classList.toggle("dark", settings.theme === "dark");
        if (!options.safeMode) {
          void get().refreshStorage().catch(() => undefined);
          void get().runAutoBackup().catch(() => undefined);
        }
        try {
          await navigator.storage?.persist?.();
        } catch {
          /* Optional persistence must never block startup. */
        }
      } catch (err) {
        set({
          bootError: err instanceof Error ? err.message : "Không mở được kho dữ liệu.",
          ready: true,
        });
        throw err;
      }
    })().finally(() => {
      hydratePromise = null;
    });
    return hydratePromise;
  },

  persistSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
    void enqueue("settings", () => db.putSettings(settings));
  },

  refreshStorage: async () => {
    const e = await db.storageEstimate();
    set({ storageUsage: e.usage, storageQuota: e.quota });
  },

  setSection: (section) => set({ section, folderId: null, selectedIds: [], selecting: false }),
  setFolder: (folderId) => set({ folderId, section: "all" }),
  setQuery: (query) => set({ query }),
  setSort: (sort) => set({ sort }),
  setLayout: (layout) => set({ layout }),
  setSelecting: (selecting) => set({ selecting, selectedIds: selecting ? get().selectedIds : [] }),
  toggleSelected: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setTool: (patch) => set({ tool: { ...get().tool, ...patch } }),

  createFolder: async (name, parentId) => {
    const folder: Folder = {
      id: nid(),
      parentId,
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
    };
    set({ folders: [...get().folders, folder] });
    await enqueue("folder", () => db.putFolder(folder));
    return folder.id;
  },

  renameFolder: async (id, name) => {
    const folders = get().folders.map((f) =>
      f.id === id ? { ...f, name, updatedAt: Date.now() } : f,
    );
    set({ folders });
    const f = folders.find((x) => x.id === id);
    if (f) await enqueue("folder", () => db.putFolder(f));
  },

  deleteFolder: async (id) => {
    const folders = get().folders.filter((f) => f.id !== id);
    const notebooks = get().notebooks.map((n) =>
      n.folderId === id ? { ...n, folderId: null, updatedAt: Date.now() } : n,
    );
    set({ folders, notebooks, folderId: get().folderId === id ? null : get().folderId });
    await enqueue("folder", async () => {
      await db.delFolder(id);
      for (const n of notebooks.filter((n) => n.folderId === null)) await db.putNotebook(n);
    });
  },

  createNotebook: async (input) => {
    const id = nid();
    const dim = pageDimensions(input.pageSize, input.orientation);
    const count = input.pages ?? 3;
    const t = Date.now();
    const nb: Notebook = {
      id,
      folderId: input.folderId,
      name: input.name,
      favorite: false,
      cover: { color: input.cover || COVER_COLORS[0]! },
      defaultPaper: input.paper,
      pageSize: input.pageSize,
      orientation: input.orientation,
      pdfAssetId: null,
      thumbnail: null,
      pageCount: count,
      createdAt: t,
      updatedAt: t,
      lastOpenedAt: t,
      lastPageIndex: 0,
      lastZoom: 1,
      deletedAt: null,
    };
    const pages: PageRecord[] = [];
    const objectsByPage = { ...get().objectsByPage };
    for (let i = 0; i < count; i++) {
      const p: PageRecord = {
        id: nid(),
        notebookId: id,
        index: i,
        paper: input.paper,
        rotation: 0,
        width: dim.width,
        height: dim.height,
        pdfPage: null,
        createdAt: t,
        updatedAt: t,
      };
      pages.push(p);
      objectsByPage[p.id] = [];
    }
    set({
      notebooks: [nb, ...get().notebooks],
      pages: get().activeNotebookId === id ? pages : get().pages,
      objectsByPage,
    });
    await enqueue("create-notebook", async () => {
      await db.putNotebook(nb);
      for (const p of pages) {
        await db.putPage(p);
        await db.putObjects(p.id, []);
      }
    });
    return id;
  },

  importPdf: async (file, folderId = get().folderId) => {
    if (!file.type.includes("pdf") && !file.name.toLowerCase().endsWith(".pdf")) {
      throw new Error("Chỉ nhập được tệp PDF.");
    }
    const buf = await file.arrayBuffer();
    const blob = new Blob([buf], { type: "application/pdf" });
    const assetId = nid();
    await db.putAsset({
      id: assetId,
      kind: "pdf",
      mime: "application/pdf",
      name: file.name,
      byteLength: blob.size,
      blob,
      createdAt: Date.now(),
    });
    const { loadPdfDocument, pdfPageSizes } = await import("./pdf");
    const doc = await loadPdfDocument(assetId, buf);
    const sizes = await pdfPageSizes(doc);
    const t = Date.now();
    const id = nid();
    const name = file.name.replace(/\.pdf$/i, "");
    const nb: Notebook = {
      id,
      folderId: folderId ?? null,
      name,
      favorite: false,
      cover: { color: COVER_COLORS[1]! },
      defaultPaper: DEFAULT_PAPER,
      pageSize: "a4",
      orientation: sizes[0] && sizes[0].width > sizes[0].height ? "landscape" : "portrait",
      pdfAssetId: assetId,
      thumbnail: null,
      pageCount: sizes.length,
      createdAt: t,
      updatedAt: t,
      lastOpenedAt: t,
      lastPageIndex: 0,
      lastZoom: 1,
      deletedAt: null,
    };
    const pages: PageRecord[] = sizes.map((s, i) => ({
      id: nid(),
      notebookId: id,
      index: i,
      paper: DEFAULT_PAPER,
      rotation: 0,
      width: s.width,
      height: s.height,
      pdfPage: i + 1,
      createdAt: t,
      updatedAt: t,
    }));
    set({ notebooks: [nb, ...get().notebooks] });
    await enqueue("import-pdf", async () => {
      await db.putNotebook(nb);
      for (const p of pages) {
        await db.putPage(p);
        await db.putObjects(p.id, []);
      }
    });
    return id;
  },

  renameNotebook: async (id, name) => patchNb(id, { name }),
  toggleFavorite: async (id) => {
    const n = get().notebooks.find((x) => x.id === id);
    if (n) patchNb(id, { favorite: !n.favorite });
  },
  moveNotebook: async (id, folderId) => patchNb(id, { folderId }),
  setCover: async (id, color) => patchNb(id, { cover: { color } }),

  duplicateNotebook: async (id) => {
    const src = get().notebooks.find((n) => n.id === id);
    if (!src) throw new Error("Không tìm thấy sổ.");
    const payload = await db.loadNotebookPayload(id);
    const newId = nid();
    const t = Date.now();
    const copy: Notebook = {
      ...src,
      id: newId,
      name: `${src.name} (bản sao)`,
      createdAt: t,
      updatedAt: t,
      lastOpenedAt: t,
      deletedAt: null,
    };
    const idMap = new Map<string, string>();
    await enqueue("duplicate", async () => {
      if (src.pdfAssetId) {
        const asset = await db.getAsset(src.pdfAssetId);
        if (asset) {
          const nidAsset = nid();
          await db.putAsset({ ...asset, id: nidAsset, createdAt: t });
          copy.pdfAssetId = nidAsset;
        }
      }
      await db.putNotebook(copy);
      for (const p of payload.pages) {
        const np = { ...p, id: nid(), notebookId: newId };
        idMap.set(p.id, np.id);
        const objs = (payload.objects[p.id] ?? []).map((o) => {
          const next = { ...o, id: nid() };
          return next;
        });
        await db.putPage(np);
        await db.putObjects(np.id, objs);
      }
    });
    set({ notebooks: [copy, ...get().notebooks] });
    return newId;
  },

  trashNotebook: async (id) => patchNb(id, { deletedAt: Date.now() }),
  restoreNotebook: async (id) => patchNb(id, { deletedAt: null }),

  destroyNotebook: async (id) => {
    const n = get().notebooks.find((x) => x.id === id);
    const payload = await db.loadNotebookPayload(id);
    const assetIds = new Set<string>();
    if (n?.pdfAssetId) assetIds.add(n.pdfAssetId);
    for (const pageObjects of Object.values(payload.objects)) {
      for (const object of pageObjects) {
        if (object.type === "image") assetIds.add(object.assetId);
      }
    }
    set({
      notebooks: get().notebooks.filter((x) => x.id !== id),
      settings: {
        ...get().settings,
        openTabIds: get().settings.openTabIds.filter((t) => t !== id),
      },
      activeNotebookId: get().activeNotebookId === id ? null : get().activeNotebookId,
    });
    await enqueue("destroy", async () => {
      for (const p of payload.pages) await db.delPage(p.id);
      for (const bookmark of payload.bookmarks) await db.delBookmark(bookmark.id);
      for (const assetId of assetIds) {
        if (n?.pdfAssetId === assetId) {
          const { evictPdf } = await import("./pdf");
          evictPdf(assetId);
        }
        db.revokeObjectUrl(assetId);
        // On desktop this removes the corresponding file from NotesData/assets;
        // in the browser it removes the IndexedDB blob and releases its quota.
        await db.delAsset(assetId);
      }
      await db.delNotebook(id);
    });
  },

  emptyTrash: async () => {
    const ids = get()
      .notebooks.filter((n) => n.deletedAt)
      .map((n) => n.id);
    for (const id of ids) await get().destroyNotebook(id);
  },

  openNotebook: async (id) => {
    await drainPendingObjectSaves();
    const payload = await db.loadNotebookPayload(id);
    const nb = get().notebooks.find((n) => n.id === id);
    const tabs = get().settings.openTabIds.includes(id)
      ? get().settings.openTabIds
      : [...get().settings.openTabIds, id];
    set({
      activeNotebookId: id,
      pages: payload.pages,
      objectsByPage: { ...get().objectsByPage, ...payload.objects },
      bookmarks: payload.bookmarks,
      currentPageIndex: nb?.lastPageIndex ?? 0,
      zoom: nb?.lastZoom ?? 1,
      toc: [],
      pdfSearchHits: [],
    });
    get().persistSettings({ openTabIds: tabs });
    patchNb(id, { lastOpenedAt: Date.now() });
    if (nb?.pdfAssetId) {
      try {
        const { loadStoredPdfDocument, pdfOutline } = await import("./pdf");
        const doc = await loadStoredPdfDocument(nb.pdfAssetId);
        const toc = await pdfOutline(doc);
        set({ toc });
      } catch {
        /* outline optional */
      }
    }
  },

  closeTab: async (id) => {
    await drainPendingObjectSaves();
    const tabs = get().settings.openTabIds.filter((t) => t !== id);
    get().persistSettings({ openTabIds: tabs });
    if (get().activeNotebookId === id) {
      set({ activeNotebookId: tabs[0] ?? null, pages: [], bookmarks: [] });
    }
  },

  flushPendingWrites: () => drainPendingObjectSaves(true),

  setPageIndex: (index) => {
    set({ currentPageIndex: index });
    const id = get().activeNotebookId;
    if (id) patchNb(id, { lastPageIndex: index });
  },
  setZoom: (z) => {
    const zoom = Math.max(0.35, Math.min(3.5, z));
    set({ zoom });
    const id = get().activeNotebookId;
    if (id) patchNb(id, { lastZoom: zoom });
  },
  rememberView: () => {
    const id = get().activeNotebookId;
    if (!id) return;
    patchNb(id, { lastPageIndex: get().currentPageIndex, lastZoom: get().zoom });
  },

  addPage: async (after) => {
    const nbId = get().activeNotebookId;
    const nb = get().notebooks.find((n) => n.id === nbId);
    if (!nb || !nbId) return;
    const idx = after ?? get().pages.length - 1;
    const dim = pageDimensions(nb.pageSize, nb.orientation);
    const page: PageRecord = {
      id: nid(),
      notebookId: nbId,
      index: idx + 1,
      paper: nb.defaultPaper,
      rotation: 0,
      width: dim.width,
      height: dim.height,
      pdfPage: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const pages = get()
      .pages.map((p) => (p.index > idx ? { ...p, index: p.index + 1 } : p))
      .concat(page)
      .sort((a, b) => a.index - b.index);
    set({
      pages,
      objectsByPage: { ...get().objectsByPage, [page.id]: [] },
    });
    patchNb(nbId, { pageCount: pages.length });
    await enqueue("add-page", async () => {
      await db.putPagesBatch(pages);
      await db.putObjects(page.id, []);
    });
  },

  duplicatePage: async (pageId) => {
    const src = get().pages.find((p) => p.id === pageId);
    if (!src) return;
    const copy: PageRecord = { ...src, id: nid(), index: src.index + 1, pdfPage: null };
    const objs = (get().objectsByPage[pageId] ?? []).map((o) => ({ ...o, id: nid() }));
    const pages = get()
      .pages.map((p) => (p.index > src.index ? { ...p, index: p.index + 1 } : p))
      .concat(copy)
      .sort((a, b) => a.index - b.index);
    set({ pages, objectsByPage: { ...get().objectsByPage, [copy.id]: objs } });
    const nbId = get().activeNotebookId;
    if (nbId) patchNb(nbId, { pageCount: pages.length });
    await enqueue("dup-page", async () => {
      await db.putPagesBatch(pages);
      await db.putObjects(copy.id, objs);
    });
  },

  deletePage: async (pageId) => {
    if (get().pages.length <= 1) return;
    await drainPendingObjectSaves();
    const pages = get()
      .pages.filter((p) => p.id !== pageId)
      .map((p, i) => ({ ...p, index: i }));
    const objectsByPage = { ...get().objectsByPage };
    delete objectsByPage[pageId];
    set({
      pages,
      objectsByPage,
      currentPageIndex: Math.min(get().currentPageIndex, pages.length - 1),
    });
    const nbId = get().activeNotebookId;
    if (nbId) patchNb(nbId, { pageCount: pages.length });
    await enqueue("del-page", async () => {
      await db.delPage(pageId);
      await db.putPagesBatch(pages);
    });
  },

  rotatePage: async (pageId) => {
    const pages = get().pages.map((p) =>
      p.id === pageId
        ? {
            ...p,
            rotation: ((p.rotation + 90) % 360) as PageRecord["rotation"],
            updatedAt: Date.now(),
          }
        : p,
    );
    set({ pages });
    const page = pages.find((p) => p.id === pageId);
    if (page) await enqueue("rotate", () => db.putPage(page));
  },

  setPagePaper: async (pageId, paper) => {
    const pages = get().pages.map((p) =>
      p.id === pageId ? { ...p, paper, updatedAt: Date.now() } : p,
    );
    set({ pages });
    const page = pages.find((p) => p.id === pageId);
    if (page) await enqueue("paper", () => db.putPage(page));
  },

  reorderPages: async (from, to) => {
    const pages = [...get().pages].sort((a, b) => a.index - b.index);
    const [moved] = pages.splice(from, 1);
    if (!moved) return;
    pages.splice(to, 0, moved);
    const next = pages.map((p, i) => ({ ...p, index: i }));
    set({ pages: next });
    await enqueue("reorder", async () => {
      await db.putPagesBatch(next);
    });
  },

  commitObjects: (pageId, objects, undoable = true, beforeState) => {
    if (undoable) {
      const nbId = get().activeNotebookId ?? "x";
      const hist = get().history[nbId] ?? { past: [], future: [] };
      hist.past = [
        ...hist.past.slice(-49),
        { pageId, objects: beforeState ?? get().objectsByPage[pageId] ?? [] },
      ];
      hist.future = [];
      set({ history: { ...get().history, [nbId]: hist } });
    }
    set({ objectsByPage: { ...get().objectsByPage, [pageId]: objects } });
    
    queueObjectSave(pageId, objects);

    const nbId = get().activeNotebookId;
    if (nbId) patchNb(nbId, {});
  },

  undo: () => {
    const nbId = get().activeNotebookId;
    if (!nbId) return;
    const hist = get().history[nbId];
    if (!hist?.past.length) return;
    const snap = hist.past[hist.past.length - 1]!;
    const current = get().objectsByPage[snap.pageId] ?? [];
    hist.past = hist.past.slice(0, -1);
    hist.future = [...hist.future, { pageId: snap.pageId, objects: current }];
    set({
      history: { ...get().history, [nbId]: hist },
      objectsByPage: { ...get().objectsByPage, [snap.pageId]: snap.objects },
    });
    queueObjectSave(snap.pageId, snap.objects);
  },

  redo: () => {
    const nbId = get().activeNotebookId;
    if (!nbId) return;
    const hist = get().history[nbId];
    if (!hist?.future.length) return;
    const snap = hist.future[hist.future.length - 1]!;
    const current = get().objectsByPage[snap.pageId] ?? [];
    hist.future = hist.future.slice(0, -1);
    hist.past = [...hist.past, { pageId: snap.pageId, objects: current }];
    set({
      history: { ...get().history, [nbId]: hist },
      objectsByPage: { ...get().objectsByPage, [snap.pageId]: snap.objects },
    });
    queueObjectSave(snap.pageId, snap.objects);
  },

  addBookmark: async (pageId, title) => {
    const nbId = get().activeNotebookId;
    if (!nbId) return;
    const b: Bookmark = { id: nid(), notebookId: nbId, pageId, title, createdAt: Date.now() };
    set({ bookmarks: [...get().bookmarks, b] });
    await enqueue("bookmark", () => db.putBookmark(b));
  },
  removeBookmark: async (id) => {
    set({ bookmarks: get().bookmarks.filter((b) => b.id !== id) });
    await enqueue("bookmark", () => db.delBookmark(id));
  },

  exportPdf: async (notebookId) => {
    const nb = get().notebooks.find((n) => n.id === notebookId);
    if (!nb) throw new Error("Không tìm thấy sổ.");
    const payload = await db.loadNotebookPayload(notebookId);
    const { exportNotebookPdf } = await import("./io");
    const bytes = await exportNotebookPdf({
      notebook: nb,
      pages: payload.pages,
      objects: payload.objects,
    });
    if (bytes.length < 100) throw new Error("Tệp PDF xuất ra quá nhỏ, có thể bị lỗi.");
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    if (header !== "%PDF-") throw new Error("Tệp xuất ra không đúng định dạng PDF (sai header).");
    const footerStr = new TextDecoder().decode(bytes.slice(-200));
    if (!footerStr.includes("%%EOF")) throw new Error("Tệp xuất ra không đúng định dạng PDF (thiếu EOF).");
    
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    const { downloadBlob } = await import("@/lib/utils");
    await downloadBlob(blob, `${nb.name}.pdf`);
  },

  exportBackup: async (kind, notebookId) => {
    const { buildVerifiedBackupZip } = await import("./io");
    const { blob, manifest } = await buildVerifiedBackupZip(kind, notebookId);
    const { downloadBlob } = await import("@/lib/utils");
    const stamp = new Date().toISOString().slice(0, 10);
    const name =
      kind === "notebook"
        ? `${get().notebooks.find((n) => n.id === notebookId)?.name ?? "so"}-${stamp}.notesbackup`
        : `notes-${stamp}.notesbackup`;
    await downloadBlob(blob, name);
    const rec = {
      id: nid(),
      createdAt: Date.now(),
      name,
      byteLength: blob.size,
      kind: "manual" as const,
      notebookCount: manifest.notebookCount,
      pageCount: manifest.pageCount,
      blob,
    };
    await db.putBackup(rec);
    const { blob: _b, ...meta } = rec;
    set({ backups: [meta, ...get().backups] });
    get().persistSettings({ lastBackupAt: Date.now() });
  },

  previewBackup: async (file) => {
    const { inspectBackup } = await import("./io");
    return inspectBackup(file);
  },

  restoreStoredBackup: async (backupId) => {
    useNotesStore.setState({ isNavigating: true });
    try {
      const { restoreBackupChain } = await import("./desktop-db");
      await restoreBackupChain(backupId);
      // Wait for DB to settle and reload page
      setTimeout(() => window.location.reload(), 500);
    } catch (e) {
      useNotesStore.setState({ isNavigating: false });
      throw e;
    }
  },
  importBackupFile: async (file, mode) => {
    const { inspectBackup, remapBackupDump, buildVerifiedBackupZip } = await import("./io");
    const preview = await inspectBackup(file);
    if (mode === "replace") {
      const safety = await buildVerifiedBackupZip("full");
      await db.putBackup({
        id: nid(),
        createdAt: Date.now(),
        name: "truoc-thay-the.notesbackup",
        byteLength: safety.blob.size,
        kind: "manual",
        notebookCount: safety.manifest.notebookCount,
        pageCount: safety.manifest.pageCount,
        blob: safety.blob,
      });
      await db.replaceAll(preview.dump);
    } else {
      await db.mergeDump(remapBackupDump(preview.dump));
    }
    const lib = await db.loadLibrary();
    set({ folders: lib.folders, notebooks: lib.notebooks, settings: lib.settings });
    return { names: preview.notebookNames, warnings: preview.warnings };
  },

  runAutoBackup: async () => {
    const s = get().settings;
    if (!s.autoBackup) return;
    const day = 24 * 3600 * 1000;
    if (s.lastBackupAt && Date.now() - s.lastBackupAt < day) return;
    try {
      const { buildVerifiedBackupZip } = await import("./io");
      const { blob, manifest } = await buildVerifiedBackupZip("full");
      const rec = {
        id: nid(),
        createdAt: Date.now(),
        name: `auto-${new Date().toISOString().slice(0, 10)}.notesbackup`,
        byteLength: blob.size,
        kind: "auto" as const,
        notebookCount: manifest.notebookCount,
        pageCount: manifest.pageCount,
        blob,
      };
      await db.putBackup(rec);
      const all = await db.listBackups();
      const autos = all
        .filter((backup) => backup.kind === "auto")
        .sort((left, right) => right.createdAt - left.createdAt);
      const keep = s.backupKeep || 7;
      for (const old of autos.slice(keep)) {
        await db.delBackup(old.id);
        }
      const list = (await db.listBackups()).map(({ blob: _b, ...rest }) => rest);
      set({ backups: list });
      get().persistSettings({ lastBackupAt: Date.now() });
    } catch (err) {
      console.warn("[notes] auto-backup", err);
    }
  },

  downloadStoredBackup: async (id) => {
    const all = await db.listBackups();
    const rec = all.find((b) => b.id === id);
    if (!rec) return;
    const { downloadBlob } = await import("@/lib/utils");
    downloadBlob(rec.blob, rec.name);
  },
  deleteStoredBackup: async (id) => {
    await db.delBackup(id);
    set({ backups: get().backups.filter((b) => b.id !== id) });
  },
}));

export function visibleNotebooks() {
  const s = useNotesStore.getState();
  let list = s.notebooks;
  if (s.section === "trash") list = list.filter((n) => n.deletedAt);
  else {
    list = list.filter((n) => !n.deletedAt);
    if (s.section === "favorites") list = list.filter((n) => n.favorite);
    if (s.section === "recent") {
      list = list
        .filter((n) => n.lastOpenedAt)
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
    }
    if (s.section === "all") {
      if (s.folderId) {
        list = list.filter((n) => n.folderId === s.folderId);
      } else if (!s.query.trim()) {
        list = list.filter((n) => !n.folderId);
      }
    }
  }
  if (s.query.trim()) {
    const q = s.query.trim().toLowerCase();
    list = list.filter((n) => n.name.toLowerCase().includes(q));
  }
  if (s.section !== "recent") {
    list = [...list].sort((a, b) =>
      s.sort === "name" ? a.name.localeCompare(b.name, "vi") : b.updatedAt - a.updatedAt,
    );
  }
  return list;
}

export function currentPen(): { color: string; width: number; kind: PenKind } {
  const t = useNotesStore.getState().tool;
  if (t.name === "highlighter") {
    return { color: t.highlighterColor, width: t.highlighterWidth, kind: "highlighter" };
  }
  if (t.name === "ballpoint" || t.name === "fountain" || t.name === "pencil") {
    return { color: t.color, width: t.width, kind: t.name };
  }
  return { color: t.color, width: t.width, kind: "ballpoint" };
}
