import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  FileUp,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Star,
  Trash2,
  Menu,
  Check,
  CheckSquare2,
  X,
  ChevronRight,
  ArrowLeft,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, MenuItem, MenuSep } from "@/components/ui/dropdown-menu";
import { Dialog } from "@/components/ui/dialog";
import { cn, formatBytes, relativeVi } from "@/lib/utils";
import { useNotesStore } from "@/lib/notes/store";
import { useNotesNavigate } from "@/lib/notes/navigation";
import type { Folder, LibrarySection, Notebook } from "@/lib/notes/types";
import { NotesMark } from "./logo";
import { NotebookCover } from "./cover";
import { DrivePicker } from "./drive-picker";
import { Cloud } from "lucide-react";
import { CreateNotebookDialog } from "./create-dialog";

const NAV: { id: LibrarySection; label: string; icon: typeof LayoutGrid }[] = [
  { id: "all", label: "Tất cả tài liệu", icon: LayoutGrid },
  { id: "recent", label: "Gần đây", icon: Clock },
  { id: "favorites", label: "Yêu thích", icon: Star },
  { id: "trash", label: "Thùng rác", icon: Trash2 },
];

export function LibraryView() {
  const navigate = useNotesNavigate();
  const section = useNotesStore((s) => s.section);
  const folders = useNotesStore((s) => s.folders);
  const folderId = useNotesStore((s) => s.folderId);
  const query = useNotesStore((s) => s.query);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);
  const layout = useNotesStore((s) => s.layout);
  const sort = useNotesStore((s) => s.sort);
  const notebooks = useNotesStore((s) => s.notebooks);
  const sidebarOpen = useNotesStore((s) => s.sidebarOpen);
  const selecting = useNotesStore((s) => s.selecting);
  const selectedIds = useNotesStore((s) => s.selectedIds);
  const storageUsage = useNotesStore((s) => s.storageUsage);
  const [createOpen, setCreateOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const settings = useNotesStore((s) => s.settings);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("Thư mục mới");
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [trashModalNb, setTrashModalNb] = useState<Notebook | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mounted, setMounted] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const libraryScrollRef = useRef<HTMLDivElement>(null);
  const [renderCount, setRenderCount] = useState(50);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const libraryStateKey = `notes.library.view.${section}.${folderId ?? "root"}.${layout}.${sort}.${debouncedQuery}`;

  useEffect(() => {
    let restoredCount = 50;
    let restoredScroll = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem(libraryStateKey) || "null") as
        | { renderCount?: number; scrollTop?: number }
        | null;
      restoredCount = Math.max(50, Number(saved?.renderCount) || 50);
      restoredScroll = Math.max(0, Number(saved?.scrollTop) || 0);
    } catch {
      // Scroll restoration is optional.
    }
    setRenderCount(restoredCount);
    const frame = requestAnimationFrame(() => {
      if (libraryScrollRef.current) libraryScrollRef.current.scrollTop = restoredScroll;
    });
    return () => cancelAnimationFrame(frame);
  }, [libraryStateKey]);

  const items = useMemo(() => {
    let list = notebooks.filter((n) => !n.deletedAt);
    if (section === "trash") list = notebooks.filter((n) => n.deletedAt);
    else if (section === "favorites") list = list.filter((n) => n.favorite);
    else if (section === "recent") list = list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);

    if (section === "all") {
      if (folderId) list = list.filter((n) => n.folderId === folderId);
      else if (!debouncedQuery.trim()) list = list.filter((n) => !n.folderId);
    }

    if (debouncedQuery.trim()) {
      const q = debouncedQuery.trim().toLowerCase();
      list = list.filter((n) => n.name.toLowerCase().includes(q));
    }

    if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "updated") list.sort((a, b) => b.updatedAt - a.updatedAt);

    return list;
  }, [notebooks, section, folderId, debouncedQuery, sort]);

  useEffect(() => {
    if (!loadMoreRef.current) return;
    observerRef.current = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setRenderCount((count) => count + 50);
    });
    observerRef.current.observe(loadMoreRef.current);
    return () => observerRef.current?.disconnect();
  }, [items]);

  const visibleFolders = useMemo(() => {
    if (section !== "all") return [];
    let list = folders.filter((f) => !f.deletedAt);
    if (folderId) list = list.filter((f) => f.parentId === folderId);
    else if (!debouncedQuery.trim()) list = list.filter((f) => !f.parentId);

    if (debouncedQuery.trim()) {
      const q = debouncedQuery.trim().toLowerCase();
      list = list.filter((f) => f.name.toLowerCase().includes(q));
    }
    return list;
  }, [folders, section, folderId, debouncedQuery]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const currentFolder = folders.find((f) => f.id === folderId);
  const title =
    section === "all"
      ? folderId
        ? (currentFolder?.name ?? "Thư mục")
        : "Tất cả tài liệu"
      : (NAV.find((n) => n.id === section)?.label ?? "");

  async function openNb(id: string) {
    await useNotesStore.getState().openNotebook(id);
    await navigate({ to: "/notebook/$id", params: { id } });
  }

  async function onDriveImport(driveFile: { id: string; name: string; mimeType: string }) {
    setDriveOpen(false);
    const id = toast.loading("Đang tải file từ Google Drive...");
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${driveFile.id}?alt=media`,
        {
          headers: { Authorization: `Bearer ${settings.googleDriveAccessToken}` },
        },
      );
      if (!res.ok) throw new Error("Lỗi tải file");
      const blob = await res.blob();
      const file = new File([blob], driveFile.name, { type: driveFile.mimeType });

      const nbId = await useNotesStore.getState().importPdf(file);
      toast.success(`Đã nhập ${file.name}`, { id });
      await openNb(nbId);
    } catch (err: any) {
      toast.error(err.message || "Không tải được file", { id });
    }
  }

  async function onImport(files: FileList | File[]) {
    for (const file of [...files]) {
      try {
        const id = await useNotesStore.getState().importPdf(file);
        toast.success(`Đã nhập ${file.name}`);
        await openNb(id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Không nhập được PDF");
      }
    }
  }

  const isEmpty = items.length === 0 && visibleFolders.length === 0;

  return (
    <div
      className="flex min-h-svh bg-bg text-fg"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) void onImport(e.dataTransfer.files);
      }}
    >
      <aside
        className={cn(
          "z-30 w-64 flex-col border-r border-border bg-surface",
          sidebarOpen ? "fixed inset-y-0 left-0 flex" : "hidden md:flex",
        )}
      >
        <div className="flex items-center gap-2.5 px-4 py-4">
          <NotesMark className="size-9" />
          <div>
            <p className="text-sm font-semibold tracking-tight">Notes</p>
            <p className="text-[11px] text-subtle">Sổ tay của bạn</p>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = section === n.id && (n.id !== "all" || !folderId);
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  useNotesStore.getState().setSection(n.id);
                  useNotesStore.getState().setSidebarOpen(false);
                }}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-md px-3 text-sm cursor-pointer transition-colors",
                  active ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-overlay",
                )}
              >
                <Icon className="size-4" />
                {n.label}
              </button>
            );
          })}
          <p className="mt-4 mb-1 px-3 text-[11px] font-medium tracking-wide text-subtle uppercase">
            Thư mục
          </p>
          {folders
            .filter((f) => !f.deletedAt)
            .map((f) => (
              <div
                key={f.id}
                className={cn(
                  "group flex h-10 items-center justify-between rounded-md px-2.5 text-sm transition-colors",
                  section === "all" && folderId === f.id
                    ? "bg-accent-soft font-medium text-accent"
                    : "hover:bg-overlay text-fg",
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    useNotesStore.getState().setFolder(f.id);
                    useNotesStore.getState().setSidebarOpen(false);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left cursor-pointer"
                >
                  <FolderIcon className="size-4 shrink-0 text-accent/80" />
                  <span className="truncate">{f.name}</span>
                </button>
                <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <FolderMenu folder={f} />
                </div>
              </div>
            ))}
          <button
            type="button"
            onClick={() => setFolderOpen(true)}
            className="mt-1 flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted hover:bg-overlay cursor-pointer transition-colors"
          >
            <FolderPlus className="size-4" />
            Thư mục mới
          </button>
        </nav>
        <div className="border-t border-border p-3 pb-20 md:pb-3">
          <button
            type="button"
            onClick={() => navigate({ to: "/settings" })}
            className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm hover:bg-overlay cursor-pointer"
          >
            <Settings className="size-4" />
            Cài đặt
          </button>
          <p className="mt-2 px-3 text-[11px] text-subtle">Kho: {formatBytes(storageUsage)}</p>
        </div>
      </aside>
      {sidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-fg/30 md:hidden"
          aria-label="Đóng menu"
          onClick={() => useNotesStore.getState().setSidebarOpen(false)}
        />
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/80 px-4 py-3 backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => useNotesStore.getState().setSidebarOpen(true)}
            aria-label="Mở menu"
          >
            <Menu />
          </Button>
          <div className="mr-auto flex items-center gap-2">
            {folderId ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => useNotesStore.getState().setFolder(null)}
                className="gap-1.5 text-muted hover:text-fg"
              >
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">Quay lại</span>
              </Button>
            ) : null}
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          </div>
          <div className="relative w-full max-w-64 sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <Input
              className="pl-9"
              placeholder="Tìm sổ hoặc thư mục…"
              value={query}
              onChange={(e) => useNotesStore.getState().setQuery(e.target.value)}
            />
          </div>
          <select
            className="h-10 rounded-md border border-border bg-surface-2 px-2 text-sm"
            value={sort}
            onChange={(e) => useNotesStore.getState().setSort(e.target.value as "name" | "updated")}
            aria-label="Sắp xếp"
          >
            <option value="updated">Ngày sửa</option>
            <option value="name">Tên</option>
          </select>
          <Button
            variant="ghost"
            size="icon"
            aria-label={layout === "grid" ? "Danh sách" : "Lưới"}
            onClick={() => useNotesStore.getState().setLayout(layout === "grid" ? "list" : "grid")}
          >
            {layout === "grid" ? <List /> : <LayoutGrid />}
          </Button>
          <Button
            variant={selecting ? "secondary" : "ghost"}
            onClick={() => useNotesStore.getState().setSelecting(!selecting)}
          >
            {selecting ? <X /> : <CheckSquare2 />}
            <span className="hidden sm:inline">{selecting ? "Xong" : "Chọn"}</span>
          </Button>
          {section === "trash" ? (
            <Button
              variant="danger"
              size="sm"
              disabled={items.length === 0}
              onClick={() => setEmptyTrashOpen(true)}
              className="gap-1.5"
            >
              <Trash2 className="size-4" />
              <span className="hidden sm:inline">Dọn sạch thùng rác</span>
            </Button>
          ) : (
            <>
              {section === "all" ? (
                <Button variant="outline" onClick={() => setFolderOpen(true)} className="gap-1.5">
                  <FolderPlus className="size-4" />
                  <span className="hidden 2xl:inline">Thư mục</span>
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <FileUp />
                <span className="hidden 2xl:inline">Nhập PDF</span>
              </Button>
              <Button variant="outline" onClick={() => setDriveOpen(true)}>
                <Cloud />
                <span className="hidden 2xl:inline">Nhập Drive</span>
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus />
                Tạo mới
              </Button>
            </>
          )}
          {mounted ? (
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void onImport(e.target.files);
                e.target.value = "";
              }}
            />
          ) : null}
        </header>

        <div
          ref={libraryScrollRef}
          className="flex-1 overflow-auto p-4 pb-24 md:p-6 md:pb-6"
          onScroll={(event) => {
            try {
              sessionStorage.setItem(
                libraryStateKey,
                JSON.stringify({ renderCount, scrollTop: event.currentTarget.scrollTop }),
              );
            } catch {
              // The library remains usable when session storage is unavailable.
            }
          }}
        >
          {/* Breadcrumb Navigation when inside a folder */}
          {folderId && currentFolder ? (
            <div className="mb-5 flex items-center justify-between">
              <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted">
                <button
                  type="button"
                  onClick={() => useNotesStore.getState().setFolder(null)}
                  className="flex items-center gap-1 font-medium hover:text-accent cursor-pointer transition-colors"
                >
                  <LayoutGrid className="size-3.5" />
                  Tất cả tài liệu
                </button>
                <ChevronRight className="size-3 text-muted/40" />
                <span className="flex items-center gap-1 font-semibold text-fg">
                  <FolderOpen className="size-3.5 text-accent" />
                  {currentFolder.name}
                </span>
              </nav>
              <div className="flex items-center gap-1">
                <FolderMenu folder={currentFolder} />
              </div>
            </div>
          ) : null}

          {isEmpty ? (
            <EmptyLibrary
              onCreate={() => setCreateOpen(true)}
              onNewFolder={() => setFolderOpen(true)}
              onImport={() => fileRef.current?.click()}
              onImportDrive={() => setDriveOpen(true)}
              section={section}
              isFolder={Boolean(folderId)}
            />
          ) : (
            <div className="space-y-6">
              {/* Folders Section */}
              {visibleFolders.length > 0 ? (
                <section>
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                    Thư mục ({visibleFolders.length})
                  </p>
                  {layout === "grid" ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                      {visibleFolders.map((f) => (
                        <FolderTile key={f.id} folder={f} />
                      ))}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2">
                      {visibleFolders.map((f) => (
                        <FolderRow key={f.id} folder={f} />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              {/* Notebooks Section */}
              {items.length > 0 ? (
                <section>
                  {visibleFolders.length > 0 ? (
                    <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
                      Sổ tay ({items.length})
                    </p>
                  ) : null}
                  {layout === "grid" ? (
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                      {items.slice(0, renderCount).map((nb) => (
                        <NotebookTile
                          key={nb.id}
                          notebook={nb}
                          selected={selectedIds.includes(nb.id)}
                          selecting={selecting}
                          onOpen={() => {
                            if (selecting) {
                              useNotesStore.getState().toggleSelected(nb.id);
                            } else if (section === "trash") {
                              setTrashModalNb(nb);
                            } else {
                              void openNb(nb.id);
                            }
                          }}
                        />
                      ))}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2">
                      {items.slice(0, renderCount).map((nb) => (
                        <li key={nb.id} className="flex items-center gap-3 px-3 py-2">
                          {selecting ? (
                            <button
                              type="button"
                              className={cn(
                                "grid size-10 shrink-0 place-items-center rounded-full border cursor-pointer",
                                selectedIds.includes(nb.id)
                                  ? "border-accent bg-accent text-accent-fg"
                                  : "border-border bg-surface",
                              )}
                              onClick={() => useNotesStore.getState().toggleSelected(nb.id)}
                              aria-label={`Chọn ${nb.name}`}
                            >
                              {selectedIds.includes(nb.id) ? <Check className="size-4" /> : null}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="w-10 shrink-0 cursor-pointer"
                              onClick={() => void openNb(nb.id)}
                            >
                              <NotebookCover notebook={nb} />
                            </button>
                          )}
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left cursor-pointer"
                            onClick={() =>
                              selecting
                                ? useNotesStore.getState().toggleSelected(nb.id)
                                : void openNb(nb.id)
                            }
                          >
                            <p className="truncate font-medium">{nb.name}</p>
                            <p className="text-xs text-muted">
                              {nb.pageCount} trang · {relativeVi(nb.updatedAt)}
                            </p>
                          </button>
                          {!selecting ? <NotebookMenu notebook={nb} /> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}
            </div>
          )}
        </div>
      </main>

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/20">
          <p className="rounded-xl bg-surface-2 px-6 py-4 text-sm font-medium shadow-md">
            Thả PDF để nhập vào thư mục
          </p>
        </div>
      ) : null}

      {selecting ? <SelectionBar selectedIds={selectedIds} section={section} /> : null}

      <DrivePicker
        open={driveOpen}
        accessToken={settings.googleDriveAccessToken}
        onClose={() => setDriveOpen(false)}
        onPick={onDriveImport}
      />
      <CreateNotebookDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(v) => {
          void useNotesStore
            .getState()
            .createNotebook({ ...v, folderId: useNotesStore.getState().folderId })
            .then((id) => openNb(id));
        }}
      />
      <Dialog
        open={folderOpen}
        onOpenChange={setFolderOpen}
        title={folderId ? "Thư mục con mới" : "Thư mục mới"}
      >
        <Input
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          placeholder="Tên thư mục..."
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setFolderOpen(false)}>
            Hủy
          </Button>
          <Button
            onClick={() => {
              void useNotesStore.getState().createFolder(folderName.trim() || "Thư mục", folderId);
              setFolderOpen(false);
              setFolderName("Thư mục mới");
            }}
          >
            Tạo
          </Button>
        </div>
      </Dialog>

      {/* Empty Trash Dialog */}
      <Dialog open={emptyTrashOpen} onOpenChange={setEmptyTrashOpen} title="Dọn sạch thùng rác">
        <p className="text-sm text-muted">
          Bạn có chắc chắn muốn xóa vĩnh viễn tất cả <strong>{items.length}</strong> sổ tay trong
          thùng rác không? Thao tác này sẽ giải phóng dung lượng và không thể khôi phục lại.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEmptyTrashOpen(false)}>
            Hủy
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              await useNotesStore.getState().emptyTrash();
              setEmptyTrashOpen(false);
              toast.success("Đã dọn sạch thùng rác!");
            }}
          >
            Xóa vĩnh viễn tất cả
          </Button>
        </div>
      </Dialog>

      {/* Click Item in Trash Dialog */}
      {trashModalNb ? (
        <Dialog
          open={Boolean(trashModalNb)}
          onOpenChange={(v) => {
            if (!v) setTrashModalNb(null);
          }}
          title="Tài liệu trong Thùng rác"
        >
          <p className="text-sm text-muted">
            Sổ tay <strong>{trashModalNb.name}</strong> hiện đang nằm trong Thùng rác. Bạn muốn khôi
            phục sổ này để tiếp tục ghi chép hay xóa vĩnh viễn khỏi máy tính?
          </p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setTrashModalNb(null)}>
              Hủy
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                const id = trashModalNb.id;
                await useNotesStore.getState().restoreNotebook(id);
                setTrashModalNb(null);
                toast.success(`Đã khôi phục ${trashModalNb.name}`);
                await openNb(id);
              }}
              className="gap-1.5"
            >
              <RotateCcw className="size-4" />
              Khôi phục & Mở
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const id = trashModalNb.id;
                await useNotesStore.getState().destroyNotebook(id);
                setTrashModalNb(null);
                toast.success(`Đã xóa vĩnh viễn ${trashModalNb.name}`);
              }}
              className="gap-1.5"
            >
              <Trash2 className="size-4" />
              Xóa vĩnh viễn
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function FolderTile({ folder }: { folder: Folder }) {
  const notebooks = useNotesStore((s) => s.notebooks);
  const count = notebooks.filter((n) => !n.deletedAt && n.folderId === folder.id).length;

  return (
    <article className="group relative">
      <button
        type="button"
        onClick={() => {
          useNotesStore.getState().setFolder(folder.id);
        }}
        className="flex h-28 w-full flex-col justify-between rounded-xl border border-border bg-surface-2 p-3 text-left transition-all hover:border-accent/60 hover:bg-surface-3 hover:shadow-md cursor-pointer select-none"
      >
        <div className="flex items-center justify-between w-full">
          <div className="flex size-9 items-center justify-center rounded-lg bg-accent/15 text-accent group-hover:bg-accent group-hover:text-accent-fg transition-colors shadow-sm">
            <FolderIcon className="size-5" />
          </div>
          <span className="text-[11px] font-medium text-muted tabular-nums bg-surface px-2 py-0.5 rounded-full border border-border/50">
            {count} sổ
          </span>
        </div>
        <div className="w-full">
          <h3 className="truncate font-semibold text-sm text-fg group-hover:text-accent transition-colors">
            {folder.name}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted truncate">
            {count > 0 ? `${count} sổ tay bên trong` : "Thư mục trống"}
          </p>
        </div>
      </button>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <FolderMenu folder={folder} />
      </div>
    </article>
  );
}

function FolderRow({ folder }: { folder: Folder }) {
  const notebooks = useNotesStore((s) => s.notebooks);
  const count = notebooks.filter((n) => !n.deletedAt && n.folderId === folder.id).length;

  return (
    <li className="flex items-center gap-3 px-3 py-2.5 hover:bg-overlay transition-colors">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left cursor-pointer"
        onClick={() => {
          useNotesStore.getState().setFolder(folder.id);
        }}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent shadow-sm">
          <FolderIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-sm text-fg">{folder.name}</p>
          <p className="text-xs text-muted">Thư mục · {count} sổ tay</p>
        </div>
      </button>
      <FolderMenu folder={folder} />
    </li>
  );
}

function FolderMenu({ folder }: { folder: Folder }) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(folder.name);
  const s = useNotesStore.getState();

  return (
    <>
      <DropdownMenu
        trigger={
          <Button
            variant="ghost"
            size="icon"
            className="size-10 bg-surface-2/90"
            aria-label="Tùy chọn thư mục"
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        }
      >
        <MenuItem onSelect={() => setRenameOpen(true)}>Đổi tên</MenuItem>
        <MenuSep />
        <MenuItem danger onSelect={() => setDeleteOpen(true)}>
          Xóa thư mục
        </MenuItem>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen} title="Đổi tên thư mục">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenameOpen(false)}>
            Hủy
          </Button>
          <Button
            onClick={() => {
              void s.renameFolder(folder.id, name.trim() || folder.name);
              setRenameOpen(false);
            }}
          >
            Lưu
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Xóa thư mục "${folder.name}"?`}
      >
        <p className="text-sm text-muted">
          Bạn có chắc chắn muốn xóa thư mục này không? Các sổ tay bên trong sẽ được chuyển ra ngoài
          màn hình chính (không bị mất dữ liệu).
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
            Hủy
          </Button>
          <Button
            variant="danger"
            onClick={async () => {
              await s.deleteFolder(folder.id);
              setDeleteOpen(false);
              toast.success(`Đã xóa thư mục ${folder.name}`);
            }}
          >
            Xóa thư mục
          </Button>
        </div>
      </Dialog>
    </>
  );
}

function EmptyLibrary({
  onCreate,
  onNewFolder,
  onImport,
  onImportDrive,
  section,
  isFolder,
}: {
  onCreate: () => void;
  onNewFolder: () => void;
  onImport: () => void;
  onImportDrive: () => void;
  section: LibrarySection;
  isFolder: boolean;
}) {
  let title = "Chưa có tài liệu nào";
  let desc = "Tạo thư mục để phân loại hoặc tạo sổ mới ngay để bắt đầu viết.";

  if (isFolder) {
    title = "Thư mục này đang trống";
    desc = "Tạo sổ mới hoặc thêm thư mục con vào thư mục này để bắt đầu.";
  } else if (section === "recent") {
    title = "Chưa có tài liệu mở gần đây";
    desc = "Các sổ tay bạn vừa xem hoặc chỉnh sửa sẽ xuất hiện tại đây.";
  } else if (section === "favorites") {
    title = "Chưa có tài liệu yêu thích";
    desc = "Bấm vào biểu tượng '...' trên sổ tay và chọn 'Yêu thích' để ghim vào đây.";
  } else if (section === "trash") {
    title = "Thùng rác đang trống";
    desc = "Các sổ tay đã xóa sẽ được lưu tạm tại đây trước khi xóa vĩnh viễn.";
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/10 text-accent mb-2 shadow-sm">
        {isFolder ? <FolderOpen className="size-8" /> : <NotesMark className="size-10" />}
      </div>
      <h2 className="mt-3 text-lg font-semibold">{title}</h2>
      <p className="mt-1.5 text-xs text-muted max-w-xs">{desc}</p>
      {section === "all" ? (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button onClick={onCreate} size="sm">
            <Plus className="size-4" /> Tạo sổ mới
          </Button>
          <Button variant="outline" size="sm" onClick={onNewFolder}>
            <FolderPlus className="size-4" /> Tạo thư mục
          </Button>
          <Button variant="outline" size="sm" onClick={onImport}>
            <FileUp className="size-4" /> Nhập PDF
          </Button>
          <Button variant="outline" size="sm" onClick={onImportDrive}>
            <Cloud className="size-4" /> Nhập Drive
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function NotebookTile({
  notebook,
  onOpen,
  selecting,
  selected,
}: {
  notebook: Notebook;
  onOpen: () => void;
  selecting: boolean;
  selected: boolean;
}) {
  return (
    <article className="library-card group relative">
      <button type="button" onClick={onOpen} className="block w-full text-left cursor-pointer">
        <div
          className={cn(
            "rounded-lg transition-transform group-hover:scale-[1.02]",
            selected && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
          )}
        >
          <NotebookCover notebook={notebook} />
        </div>
        <h3 className="mt-2 truncate text-sm font-medium text-fg group-hover:text-accent transition-colors">
          {notebook.name}
        </h3>
        <p className="text-xs text-muted">
          {notebook.pageCount} trang · {relativeVi(notebook.updatedAt)}
        </p>
      </button>
      {selecting ? (
        <span
          className={cn(
            "absolute top-2 left-2 grid size-7 place-items-center rounded-full border cursor-pointer",
            selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
          )}
          aria-hidden
        >
          {selected ? <Check className="size-4" /> : null}
        </span>
      ) : (
        <div className="absolute top-1 right-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <NotebookMenu notebook={notebook} />
        </div>
      )}
    </article>
  );
}

function SelectionBar({
  selectedIds,
  section,
}: {
  selectedIds: string[];
  section: LibrarySection;
}) {
  const disabled = selectedIds.length === 0;
  return (
    <div className="selection-toolbar fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-surface-2 p-2 text-sm text-fg shadow-xl border border-border">
      <span className="px-2 font-medium tabular-nums">{selectedIds.length} đã chọn</span>
      {section === "trash" ? (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              for (const id of selectedIds) void useNotesStore.getState().restoreNotebook(id);
              useNotesStore.getState().setSelecting(false);
              toast.success(`Đã khôi phục ${selectedIds.length} sổ tay`);
            }}
          >
            <RotateCcw className="size-4" /> Khôi phục
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={disabled}
            onClick={async () => {
              for (const id of selectedIds) await useNotesStore.getState().destroyNotebook(id);
              useNotesStore.getState().setSelecting(false);
              toast.success(`Đã xóa vĩnh viễn ${selectedIds.length} sổ tay`);
            }}
          >
            <Trash2 className="size-4" /> Xóa vĩnh viễn ({selectedIds.length})
          </Button>
        </>
      ) : (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              const notebooks = useNotesStore.getState().notebooks;
              for (const id of selectedIds) {
                const notebook = notebooks.find((item) => item.id === id);
                if (notebook && !notebook.favorite)
                  void useNotesStore.getState().toggleFavorite(id);
              }
              useNotesStore.getState().setSelecting(false);
            }}
          >
            <Star className="size-4" /> Yêu thích
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            className="text-danger"
            onClick={() => {
              for (const id of selectedIds) void useNotesStore.getState().trashNotebook(id);
              useNotesStore.getState().setSelecting(false);
            }}
          >
            <Trash2 className="size-4" /> Xóa
          </Button>
        </>
      )}
    </div>
  );
}

function NotebookMenu({ notebook }: { notebook: Notebook }) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(notebook.name);
  const s = useNotesStore.getState();
  const inTrash = Boolean(notebook.deletedAt);
  return (
    <>
      <DropdownMenu
        trigger={
          <Button
            variant="icon"
            size="icon"
            className="size-10 bg-surface-2/80 shadow-sm"
            aria-label="Tùy chọn sổ"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      >
        {inTrash ? (
          <>
            <MenuItem onSelect={() => void s.restoreNotebook(notebook.id)}>Khôi phục</MenuItem>
            <MenuItem danger onSelect={() => void s.destroyNotebook(notebook.id)}>
              Xóa vĩnh viễn
            </MenuItem>
          </>
        ) : (
          <>
            <MenuItem onSelect={() => setRenameOpen(true)}>Đổi tên</MenuItem>
            <MenuItem onSelect={() => void s.duplicateNotebook(notebook.id)}>Nhân bản</MenuItem>
            <MenuItem onSelect={() => void s.toggleFavorite(notebook.id)}>
              {notebook.favorite ? "Bỏ yêu thích" : "Yêu thích"}
            </MenuItem>
            <MenuItem onSelect={() => void s.exportPdf(notebook.id)}>Xuất PDF</MenuItem>
            <MenuItem onSelect={() => void s.exportBackup("notebook", notebook.id).then(() => toast.success("Đã xuất bản sao")).catch((e) => toast.error(String(e)))}>
              Xuất bản sao sổ
            </MenuItem>
            <MenuSep />
            <MenuItem danger onSelect={() => void s.trashNotebook(notebook.id)}>
              Chuyển vào thùng rác
            </MenuItem>
          </>
        )}
      </DropdownMenu>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen} title="Đổi tên sổ">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRenameOpen(false)}>
            Hủy
          </Button>
          <Button
            onClick={() => {
              void s.renameNotebook(notebook.id, name.trim() || notebook.name);
              setRenameOpen(false);
            }}
          >
            Lưu
          </Button>
        </div>
      </Dialog>
    </>
  );
}
