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
  fontSize: 16,
  shapeSnap: true,
};

interface HistoryBuf {
  past: { pageId: string; objects: CanvasObject[] }[];
  future: { pageId: string; objects: CanvasObject[] }[];
}

interface NotesState {
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

  hydrate: () => Promise<void>;
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
  closeTab: (id: string) => void;
  setPageIndex: (index: number) => void;
  setZoom: (z: number) => void;
  rememberView: () => void;

  addPage: (after?: number) => Promise<void>;
  duplicatePage: (pageId: string) => Promise<void>;
  deletePage: (pageId: string) => Promise<void>;
  rotatePage: (pageId: string) => Promise<void>;
  setPagePaper: (pageId: string, paper: PaperStyle) => Promise<void>;
  reorderPages: (from: number, to: number) => Promise<void>;

  commitObjects: (pageId: string, objects: CanvasObject[], undoable?: boolean) => void;
  undo: () => void;
  redo: () => void;
  addBookmark: (pageId: string, title: string) => Promise<void>;
  removeBookmark: (id: string) => Promise<void>;

  exportPdf: (notebookId: string) => Promise<void>;
  exportBackup: (kind: "full" | "notebook", notebookId?: string) => Promise<void>;
  importBackupFile: (file: File, mode: "merge" | "replace") => Promise<{ names: string[]; warnings: string[] }>;
  previewBackup: (file: File) => Promise<BackupPreview>;
  runAutoBackup: () => Promise<void>;
  downloadStoredBackup: (id: string) => Promise<void>;
  deleteStoredBackup: (id: string) => Promise<void>;
}

let writeChain: Promise<void> = Promise.resolve();

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
  const notebooks = useNotesStore.getState().notebooks.map((n) =>
    n.id === id ? { ...n, ...partial, updatedAt: Date.now() } : n,
  );
  useNotesStore.setState({ notebooks });
  const nb = notebooks.find((n) => n.id === id);
  if (nb) void enqueue("notebook", () => db.putNotebook(nb));
}

export const useNotesStore = create<NotesState>((set, get) => ({
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

  hydrate: async () => {
    try {
      const lib = await db.loadLibrary();
      const meta = lib.meta as { initialized?: boolean };
      if (!meta.initialized) {
        const { seedLibrary } = await import("./seed");
        await seedLibrary();
        await db.putMeta({ initialized: true, schemaVersion: 1 });
        await db.putSettings(DEFAULT_SETTINGS);
      }
      const again = await db.loadLibrary();
      const backups = (await db.listBackups()).map(({ blob: _b, ...rest }) => rest);
      const validTabs = Array.from(
        new Set((again.settings.openTabIds || []).filter((t) => again.notebooks.some((n) => n.id === t))),
      );
      again.settings.openTabIds = validTabs;
      set({
        ready: true,
        folders: again.folders,
        notebooks: again.notebooks,
        settings: again.settings,
        lastSaveAt: again.settings.lastSaveAt,
        backups,
      });
      document.documentElement.classList.toggle("dark", again.settings.theme === "dark");
      void get().refreshStorage();
      void get().runAutoBackup();
      try {
        await navigator.storage?.persist?.();
      } catch {
        /* ignore */
      }
    } catch (err) {
      set({
        bootError: err instanceof Error ? err.message : "Không mở được kho dữ liệu.",
        ready: true,
      });
    }
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
    const folders = get().folders.map((f) => (f.id === id ? { ...f, name, updatedAt: Date.now() } : f));
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
      if (n?.pdfAssetId) {
        const { evictPdf } = await import("./pdf");
        evictPdf(n.pdfAssetId);
        await db.delAsset(n.pdfAssetId);
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
        const asset = await db.getAsset(nb.pdfAssetId);
        if (asset) {
          const { loadPdfDocument, pdfOutline } = await import("./pdf");
          const doc = await loadPdfDocument(nb.pdfAssetId, await asset.blob.arrayBuffer());
          const toc = await pdfOutline(doc);
          set({ toc });
        }
      } catch {
        /* outline optional */
      }
    }
  },

  closeTab: (id) => {
    const tabs = get().settings.openTabIds.filter((t) => t !== id);
    get().persistSettings({ openTabIds: tabs });
    if (get().activeNotebookId === id) {
      set({ activeNotebookId: tabs[0] ?? null, pages: [], bookmarks: [] });
    }
  },

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
      await db.putPage(page);
      await db.putObjects(page.id, []);
      for (const p of pages) await db.putPage(p);
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
      await db.putPage(copy);
      await db.putObjects(copy.id, objs);
      for (const p of pages) await db.putPage(p);
    });
  },

  deletePage: async (pageId) => {
    if (get().pages.length <= 1) return;
    const pages = get()
      .pages.filter((p) => p.id !== pageId)
      .map((p, i) => ({ ...p, index: i }));
    const objectsByPage = { ...get().objectsByPage };
    delete objectsByPage[pageId];
    set({ pages, objectsByPage, currentPageIndex: Math.min(get().currentPageIndex, pages.length - 1) });
    const nbId = get().activeNotebookId;
    if (nbId) patchNb(nbId, { pageCount: pages.length });
    await enqueue("del-page", async () => {
      await db.delPage(pageId);
      for (const p of pages) await db.putPage(p);
    });
  },

  rotatePage: async (pageId) => {
    const pages = get().pages.map((p) =>
      p.id === pageId
        ? { ...p, rotation: ((p.rotation + 90) % 360) as PageRecord["rotation"], updatedAt: Date.now() }
        : p,
    );
    set({ pages });
    const page = pages.find((p) => p.id === pageId);
    if (page) await enqueue("rotate", () => db.putPage(page));
  },

  setPagePaper: async (pageId, paper) => {
    const pages = get().pages.map((p) => (p.id === pageId ? { ...p, paper, updatedAt: Date.now() } : p));
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
      for (const p of next) await db.putPage(p);
    });
  },

  commitObjects: (pageId, objects, undoable = true) => {
    if (undoable) {
      const nbId = get().activeNotebookId ?? "x";
      const hist = get().history[nbId] ?? { past: [], future: [] };
      hist.past = [...hist.past.slice(-49), { pageId, objects: get().objectsByPage[pageId] ?? [] }];
      hist.future = [];
      set({ history: { ...get().history, [nbId]: hist } });
    }
    set({ objectsByPage: { ...get().objectsByPage, [pageId]: objects } });
    void enqueue("objects", () => db.putObjects(pageId, objects));
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
    void enqueue("undo", () => db.putObjects(snap.pageId, snap.objects));
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
    void enqueue("redo", () => db.putObjects(snap.pageId, snap.objects));
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
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
    const { downloadBlob } = await import("@/lib/utils");
    downloadBlob(blob, `${nb.name}.pdf`);
  },

  exportBackup: async (kind, notebookId) => {
    const { buildBackupZip } = await import("./io");
    const { blob, manifest } = await buildBackupZip(kind, notebookId);
    const { downloadBlob } = await import("@/lib/utils");
    const stamp = new Date().toISOString().slice(0, 10);
    const name =
      kind === "notebook"
        ? `${get().notebooks.find((n) => n.id === notebookId)?.name ?? "so"}-${stamp}.notesbackup`
        : `notes-${stamp}.notesbackup`;
    downloadBlob(blob, name);
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

  importBackupFile: async (file, mode) => {
    const { inspectBackup, remapBackupDump, buildBackupZip } = await import("./io");
    const preview = await inspectBackup(file);
    if (mode === "replace") {
      const safety = await buildBackupZip("full");
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
      const { buildBackupZip } = await import("./io");
      const { blob, manifest } = await buildBackupZip("full");
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
      const autos = all.filter((b) => b.kind === "auto");
      const keep = s.backupKeep || 7;
      for (const old of autos.slice(keep)) await db.delBackup(old.id);
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
      list = list.filter((n) => n.lastOpenedAt).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
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
