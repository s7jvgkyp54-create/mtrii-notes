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
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, MenuItem, MenuSep } from "@/components/ui/dropdown-menu";
import { Dialog } from "@/components/ui/dialog";
import { cn, formatBytes, relativeVi } from "@/lib/utils";
import { useNotesStore, visibleNotebooks } from "@/lib/notes/store";
import { useNotesNavigate } from "@/lib/notes/navigation";
import type { Folder, LibrarySection, Notebook } from "@/lib/notes/types";
import { MtriiMark } from "./logo";
import { NotebookCover } from "./cover";
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
  const layout = useNotesStore((s) => s.layout);
  const sort = useNotesStore((s) => s.sort);
  const notebooks = useNotesStore((s) => s.notebooks);
  const sidebarOpen = useNotesStore((s) => s.sidebarOpen);
  const selecting = useNotesStore((s) => s.selecting);
  const selectedIds = useNotesStore((s) => s.selectedIds);
  const storageUsage = useNotesStore((s) => s.storageUsage);
  const [createOpen, setCreateOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("Thư mục mới");
  const [dragging, setDragging] = useState(false);
  const [mounted, setMounted] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => visibleNotebooks(), [notebooks, section, folderId, query, sort]);

  const visibleFolders = useMemo(() => {
    if (section !== "all" && section !== "trash") return [];
    let list = folders;
    if (section === "trash") list = list.filter((f) => f.deletedAt);
    else {
      list = list.filter((f) => !f.deletedAt);
      if (folderId) list = list.filter((f) => f.parentId === folderId);
      else if (!query.trim()) list = list.filter((f) => !f.parentId);
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((f) => f.name.toLowerCase().includes(q));
    }
    return list;
  }, [folders, section, folderId, query]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const currentFolder = folders.find((f) => f.id === folderId);
  const title =
    section === "all"
      ? folderId
        ? (currentFolder?.name ?? "Thư mục")
        : "Tất cả tài liệu"
      : NAV.find((n) => n.id === section)?.label ?? "";

  async function openNb(id: string) {
    await useNotesStore.getState().openNotebook(id);
    await navigate({ to: "/notebook/$id", params: { id } });
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
          <MtriiMark className="size-9" />
          <div>
            <p className="text-sm font-semibold tracking-tight">Mtrii Notes</p>
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
                  useNotesStore.getState().setFolder(null);
                  useNotesStore.getState().setSidebarOpen(false);
                }}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-md px-3 text-sm cursor-pointer",
                  active ? "bg-accent-soft font-medium text-accent" : "text-fg hover:bg-overlay",
                )}
              >
                <Icon className="size-4" />
                {n.label}
              </button>
            );
          })}
          <p className="mt-4 mb-1 px-3 text-[11px] font-medium tracking-wide text-subtle uppercase">Thư mục</p>
          {folders
            .filter((f) => !f.deletedAt)
            .map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  useNotesStore.getState().setSection("all");
                  useNotesStore.getState().setFolder(f.id);
                  useNotesStore.getState().setSidebarOpen(false);
                }}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-md px-3 text-sm cursor-pointer",
                  section === "all" && folderId === f.id ? "bg-accent-soft font-medium text-accent" : "hover:bg-overlay",
                )}
              >
                <FolderIcon className="size-4 text-accent/80" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          <button
            type="button"
            onClick={() => setFolderOpen(true)}
            className="mt-1 flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted hover:bg-overlay cursor-pointer"
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
          <Button variant="outline" onClick={() => setFolderOpen(true)} className="gap-1.5">
            <FolderPlus className="size-4" />
            <span className="hidden sm:inline">Thư mục</span>
          </Button>
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <FileUp />
            <span className="hidden sm:inline">Nhập PDF</span>
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Tạo mới
          </Button>
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

        <div className="flex-1 overflow-auto p-4 pb-24 md:p-6 md:pb-6">
          {/* Breadcrumb Navigation when inside a folder */}
          {folderId && currentFolder ? (
            <nav aria-label="Breadcrumb" className="mb-5 flex items-center gap-1.5 text-xs text-muted">
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
          ) : null}

          {isEmpty ? (
            <EmptyLibrary
              onCreate={() => setCreateOpen(true)}
              onNewFolder={() => setFolderOpen(true)}
              onImport={() => fileRef.current?.click()}
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
                      {items.map((nb) => (
                        <NotebookTile
                          key={nb.id}
                          notebook={nb}
                          selected={selectedIds.includes(nb.id)}
                          selecting={selecting}
                          onOpen={() =>
                            selecting
                              ? useNotesStore.getState().toggleSelected(nb.id)
                              : void openNb(nb.id)
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2">
                      {items.map((nb) => (
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
                            <button type="button" className="w-10 shrink-0 cursor-pointer" onClick={() => void openNb(nb.id)}>
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
          <p className="rounded-xl bg-surface-2 px-6 py-4 text-sm font-medium shadow-md">Thả PDF để nhập vào thư mục</p>
        </div>
      ) : null}

      {selecting ? <SelectionBar selectedIds={selectedIds} section={section} /> : null}

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
      <Dialog open={folderOpen} onOpenChange={setFolderOpen} title={folderId ? "Thư mục con mới" : "Thư mục mới"}>
        <Input value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="Tên thư mục..." />
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
          useNotesStore.getState().setSection("all");
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
          useNotesStore.getState().setSection("all");
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
  const [name, setName] = useState(folder.name);
  const s = useNotesStore.getState();

  return (
    <>
      <DropdownMenu
        trigger={
          <Button variant="ghost" size="icon" className="size-7 bg-surface-2/90" aria-label="Tùy chọn thư mục">
            <MoreHorizontal className="size-3.5" />
          </Button>
        }
      >
        <MenuItem onSelect={() => setRenameOpen(true)}>Đổi tên</MenuItem>
        <MenuSep />
        <MenuItem
          danger
          onSelect={() => {
            void s.deleteFolder(folder.id);
            toast.success(`Đã xóa thư mục ${folder.name}`);
          }}
        >
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
    </>
  );
}

function EmptyLibrary({
  onCreate,
  onNewFolder,
  onImport,
  isFolder,
}: {
  onCreate: () => void;
  onNewFolder: () => void;
  onImport: () => void;
  isFolder: boolean;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-accent/10 text-accent mb-2 shadow-sm">
        {isFolder ? <FolderOpen className="size-8" /> : <MtriiMark className="size-10" />}
      </div>
      <h2 className="mt-3 text-lg font-semibold">{isFolder ? "Thư mục này đang trống" : "Chưa có tài liệu nào"}</h2>
      <p className="mt-1.5 text-xs text-muted max-w-xs">
        {isFolder
          ? "Tạo sổ mới hoặc thêm thư mục con vào thư mục này để bắt đầu."
          : "Tạo thư mục để phân loại hoặc tạo sổ mới ngay để bắt đầu viết."}
      </p>
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
      </div>
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
    <article className="group relative">
      <button type="button" onClick={onOpen} className="block w-full text-left cursor-pointer">
        <div className={cn("rounded-lg transition-transform group-hover:scale-[1.02]", selected && "ring-2 ring-accent ring-offset-2 ring-offset-bg")}>
          <NotebookCover notebook={notebook} />
        </div>
        <h3 className="mt-2 truncate text-sm font-medium text-fg group-hover:text-accent transition-colors">{notebook.name}</h3>
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
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            for (const id of selectedIds) void useNotesStore.getState().restoreNotebook(id);
            useNotesStore.getState().setSelecting(false);
          }}
        >
          Khôi phục
        </Button>
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
                if (notebook && !notebook.favorite) void useNotesStore.getState().toggleFavorite(id);
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
          <Button variant="icon" size="icon" className="size-8 bg-surface-2/80 shadow-sm" aria-label="Tùy chọn sổ">
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
            <MenuItem onSelect={() => void s.exportBackup("notebook", notebook.id)}>Xuất bản sao sổ</MenuItem>
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