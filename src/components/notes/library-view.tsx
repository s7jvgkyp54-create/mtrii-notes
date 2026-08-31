import { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  FileUp,
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
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, MenuItem, MenuSep } from "@/components/ui/dropdown-menu";
import { Dialog } from "@/components/ui/dialog";
import { cn, formatBytes, relativeVi } from "@/lib/utils";
import { useNotesStore, visibleNotebooks } from "@/lib/notes/store";
import { useNotesNavigate } from "@/lib/notes/navigation";
import type { LibrarySection, Notebook } from "@/lib/notes/types";
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

  useEffect(() => {
    setMounted(true);
  }, []);

  const title =
    section === "all"
      ? folderId
        ? (folders.find((f) => f.id === folderId)?.name ?? "Thư mục")
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
                  "flex h-11 items-center gap-3 rounded-md px-3 text-sm",
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
                  useNotesStore.getState().setFolder(f.id);
                  useNotesStore.getState().setSidebarOpen(false);
                }}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-md px-3 text-sm",
                  folderId === f.id ? "bg-accent-soft text-accent" : "hover:bg-overlay",
                )}
              >
                <span className="size-1.5 rounded-full bg-accent" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          <button
            type="button"
            onClick={() => setFolderOpen(true)}
            className="mt-1 flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted hover:bg-overlay"
          >
            <FolderPlus className="size-4" />
            Thư mục mới
          </button>
        </nav>
        <div className="border-t border-border p-3 pb-20 md:pb-3">
          <button
            type="button"
            onClick={() => navigate({ to: "/settings" })}
            className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm hover:bg-overlay"
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
            variant="icon"
            size="icon"
            className="md:hidden"
            onClick={() => useNotesStore.getState().setSidebarOpen(true)}
            aria-label="Mở menu"
          >
            <Menu />
          </Button>
          <h1 className="mr-auto text-lg font-semibold tracking-tight">{title}</h1>
          <div className="relative w-full max-w-64 sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
            <Input
              className="pl-9"
              placeholder="Tìm sổ…"
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
          {items.length === 0 ? (
            <EmptyLibrary onCreate={() => setCreateOpen(true)} onImport={() => fileRef.current?.click()} />
          ) : layout === "grid" ? (
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
                        "grid size-10 shrink-0 place-items-center rounded-full border",
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
                    <button type="button" className="w-10 shrink-0" onClick={() => void openNb(nb.id)}>
                      <NotebookCover notebook={nb} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
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
        </div>
      </main>

      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-accent/20">
          <p className="rounded-xl bg-surface-2 px-6 py-4 text-sm font-medium shadow-md">Thả PDF để nhập vào thư viện</p>
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
      <Dialog open={folderOpen} onOpenChange={setFolderOpen} title="Thư mục mới">
        <Input value={folderName} onChange={(e) => setFolderName(e.target.value)} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setFolderOpen(false)}>
            Hủy
          </Button>
          <Button
            onClick={() => {
              void useNotesStore.getState().createFolder(folderName.trim() || "Thư mục", null);
              setFolderOpen(false);
            }}
          >
            Tạo
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function EmptyLibrary({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center py-20 text-center">
      <MtriiMark className="size-16" />
      <h2 className="mt-4 text-xl font-semibold">Chưa có sổ nào</h2>
      <p className="mt-2 text-sm text-muted">Tạo sổ tay mới hoặc nhập PDF để bắt đầu viết.</p>
      <div className="mt-5 flex gap-2">
        <Button onClick={onCreate}>
          <Plus /> Tạo sổ mới
        </Button>
        <Button variant="outline" onClick={onImport}>
          <FileUp /> Nhập PDF
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
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className={cn("rounded-lg", selected && "ring-2 ring-accent ring-offset-2 ring-offset-bg")}>
          <NotebookCover notebook={notebook} />
        </div>
        <h3 className="mt-2 truncate text-sm font-medium">{notebook.name}</h3>
        <p className="text-xs text-muted">
          {notebook.pageCount} trang · {relativeVi(notebook.updatedAt)}
        </p>
      </button>
      {selecting ? (
        <span
          className={cn(
            "absolute top-2 left-2 grid size-7 place-items-center rounded-full border",
            selected ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface-2",
          )}
          aria-hidden
        >
          {selected ? <Check className="size-4" /> : null}
        </span>
      ) : (
        <div className="absolute top-1 right-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
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
    <div className="selection-toolbar fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-surface-2 p-2 text-sm text-fg">
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
          <Button variant="icon" size="icon" className="size-8 bg-surface-2/80" aria-label="Tùy chọn sổ">
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
