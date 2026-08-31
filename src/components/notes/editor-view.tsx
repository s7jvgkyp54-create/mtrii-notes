import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookmarkPlus,
  Circle,
  Eraser,
  Highlighter,
  ImagePlus,
  Lasso,
  Minus,
  PenLine,
  Pencil,
  Plus,
  Redo2,
  RotateCw,
  Square,
  Type,
  Undo2,
  Hand,
  ArrowUpRight,
  FileDown,
  Search,
  PanelLeft,
  MoreHorizontal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { DropdownMenu, MenuItem, MenuSep } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  HIGHLIGHTER_COLORS,
  PEN_COLORS,
  type PageRecord,
  type PaperPattern,
  type ToolName,
} from "@/lib/notes/types";
import { useNotesStore } from "@/lib/notes/store";
import { displaySize } from "@/lib/notes/geometry";
import { searchPdfText, loadPdfDocument } from "@/lib/notes/pdf";
import { getAsset } from "@/lib/notes/db";
import { useNotesNavigate } from "@/lib/notes/navigation";
import { PageSurface } from "./page-surface";
import { PageThumbnail } from "./page-thumbnail";
import { NotesMark } from "./logo";

const PENS: { id: ToolName; label: string; icon: typeof PenLine }[] = [
  { id: "ballpoint", label: "Bút bi", icon: PenLine },
  { id: "fountain", label: "Bút máy", icon: Pencil },
  { id: "pencil", label: "Bút chì", icon: Pencil },
  { id: "highlighter", label: "Đánh dấu", icon: Highlighter },
];

export function EditorView({ notebookId }: { notebookId: string }) {
  const navigate = useNotesNavigate();
  const notebook = useNotesStore((s) => s.notebooks.find((n) => n.id === notebookId));
  const pages = useNotesStore((s) => s.pages);
  const zoom = useNotesStore((s) => s.zoom);
  const pageIndex = useNotesStore((s) => s.currentPageIndex);
  const tool = useNotesStore((s) => s.tool);
  const saveStatus = useNotesStore((s) => s.saveStatus);
  const saveError = useNotesStore((s) => s.saveError);
  const tabs = useNotesStore((s) => s.settings.openTabIds);
  const notebooks = useNotesStore((s) => s.notebooks);
  const pageMode = useNotesStore((s) => s.settings.pageMode);
  const [sideOpen, setSideOpen] = useState(true);
  const [sideTab, setSideTab] = useState<"pages" | "toc" | "marks">("pages");
  const [search, setSearch] = useState("");
  const [dragPageIndex, setDragPageIndex] = useState<number | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const ready = useNotesStore((s) => s.activeNotebookId === notebookId && pages.length > 0);

  useEffect(() => {
    if (useNotesStore.getState().activeNotebookId !== notebookId) {
      void useNotesStore.getState().openNotebook(notebookId);
    }
  }, [notebookId]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          useNotesStore.getState().redo();
        } else {
          useNotesStore.getState().undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useNotesStore.getState().redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const z = useNotesStore.getState().zoom;
        useNotesStore.getState().setZoom(z * (e.deltaY > 0 ? 0.92 : 1.08));
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handleCloseTab = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const remaining = tabs.filter((t) => t !== id);
    useNotesStore.getState().closeTab(id);
    if (id === notebookId) {
      if (remaining.length > 0) {
        const nextId = remaining[remaining.length - 1];
        void navigate({ to: "/notebook/$id", params: { id: nextId } });
      } else {
        void navigate({ to: "/" });
      }
    }
  };

  const visiblePages = useMemo(() => {
    if (pageMode === "single") return pages.filter((_, i) => i === pageIndex);
    return pages;
  }, [pages, pageMode, pageIndex]);

  if (!notebook) {
    return (
      <div className="grid min-h-svh place-items-center bg-bg text-fg">
        <p>Không tìm thấy sổ.</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex h-svh flex-col bg-desk text-fg">
        <header className="flex items-center gap-2 border-b border-border bg-surface px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              useNotesStore.getState().rememberView();
              void navigate({ to: "/" });
            }}
          >
            <ArrowLeft /> Thư viện
          </Button>
          <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex">
            {Array.from(new Set(tabs)).map((id) => {
              const n = notebooks.find((x) => x.id === id);
              if (!n) return null;
              const on = id === notebookId;
              return (
                <div
                  key={id}
                  onClick={() => void navigate({ to: "/notebook/$id", params: { id } })}
                  onAuxClick={(e) => {
                    if (e.button === 1) handleCloseTab(id, e);
                  }}
                  className={cn(
                    "group flex max-w-48 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors select-none",
                    on
                      ? "bg-accent-soft text-accent"
                      : "text-muted hover:bg-overlay hover:text-fg",
                  )}
                >
                  <span className="truncate">{n.name}</span>
                  <button
                    type="button"
                    onClick={(e) => handleCloseTab(id, e)}
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm transition-opacity hover:bg-black/15 dark:hover:bg-white/15 hover:text-destructive",
                      on ? "opacity-70 hover:opacity-100" : "opacity-0 group-hover:opacity-70 hover:opacity-100",
                    )}
                    title="Đóng tệp này"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="truncate text-sm font-semibold md:hidden">{notebook.name}</p>
          <span
            className={cn(
              "ml-auto text-xs tabular-nums",
              saveStatus === "saving" && "text-muted",
              saveStatus === "saved" && "text-success",
              saveStatus === "error" && "text-danger",
            )}
          >
            {saveStatus === "saving" && "Đang lưu"}
            {saveStatus === "saved" && "Đã lưu"}
            {saveStatus === "error" && (saveError ?? "Lỗi lưu")}
          </span>
          <DropdownMenu
            trigger={
              <Button variant="ghost" size="icon" aria-label="Xuất">
                <MoreHorizontal />
              </Button>
            }
          >
            <MenuItem
              onSelect={() =>
                void useNotesStore
                  .getState()
                  .exportPdf(notebookId)
                  .then(() => toast.success("Đã xuất PDF"))
                  .catch((e) => toast.error(String(e)))
              }
            >
              <FileDown className="size-4" /> Xuất PDF (gộp ghi chú)
            </MenuItem>
            <MenuItem onSelect={() => void useNotesStore.getState().exportBackup("notebook", notebookId)}>
              Xuất bản sao sổ (.notesbackup)
            </MenuItem>
            <MenuSep />
            <MenuItem onSelect={() => useNotesStore.getState().persistSettings({ penOnly: !useNotesStore.getState().settings.penOnly })}>
              {useNotesStore.getState().settings.penOnly ? "Tắt chế độ chỉ bút" : "Chỉ viết bằng bút"}
            </MenuItem>
          </DropdownMenu>
        </header>

        <Toolbar />

        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-[var(--motion-fast)]",
              sideOpen ? "w-52" : "w-0 overflow-hidden",
            )}
          >
            <div className="flex gap-1 p-2">
              {(
                [
                  ["pages", "Trang"],
                  ["toc", "Mục lục"],
                  ["marks", "Dấu trang"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSideTab(id)}
                  className={cn(
                    "flex-1 rounded-md py-1 text-[11px]",
                    sideTab === id ? "bg-accent-soft text-accent" : "hover:bg-overlay",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
              {sideTab === "pages" &&
                pages.map((p, i) => (
                  <article
                    key={p.id}
                    draggable
                    onDragStart={() => setDragPageIndex(i)}
                    onDragEnd={() => setDragPageIndex(null)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (dragPageIndex !== null && dragPageIndex !== i) {
                        void useNotesStore.getState().reorderPages(dragPageIndex, i);
                      }
                      setDragPageIndex(null);
                    }}
                    className={cn(
                      "group relative mb-2 rounded-lg border bg-surface-2 p-1.5",
                      i === pageIndex ? "border-accent" : "border-border",
                      dragPageIndex === i && "opacity-60",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        useNotesStore.getState().setPageIndex(i);
                        document.getElementById(`page-${p.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                      className="block w-full text-left"
                      aria-current={i === pageIndex ? "page" : undefined}
                    >
                      <PageThumbnail page={p} />
                      <p className="mt-1 text-center text-xs text-muted">{i + 1}</p>
                    </button>
                    <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      <PageMenu page={p} pageIndex={i} pageCount={pages.length} />
                    </div>
                  </article>
                ))}
              {sideTab === "toc" && <TocList />}
              {sideTab === "marks" && <BookmarkList />}
            </div>
            <div className="flex gap-1 border-t border-border p-2">
              <Button size="sm" variant="ghost" onClick={() => void useNotesStore.getState().addPage(pageIndex)}>
                <Plus className="size-3.5" /> Trang
              </Button>
            </div>
          </aside>

          <div ref={stageRef} className="relative min-w-0 flex-1 overflow-auto">
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-2 left-2 z-10 bg-surface/80"
              onClick={() => setSideOpen((v) => !v)}
              aria-label="Thu gọn trang"
            >
              <PanelLeft />
            </Button>
            {!ready ? (
              <div className="grid h-full place-items-center">
                <NotesMark />
              </div>
            ) : (
              <div className="mx-auto flex flex-col items-center gap-6 py-8">
                {visiblePages.map((p) => (
                  <div key={p.id} id={`page-${p.id}`} className="flex flex-col items-center gap-2">
                    <PageSurface page={p} zoom={zoom} active={pages[pageIndex]?.id === p.id || pageMode === "continuous"} />
                    <p className="text-xs tabular-nums text-muted">
                      {p.index + 1} / {pages.length}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-1.5 pb-16 text-xs md:pb-1.5">
          <Button variant="ghost" size="sm" onClick={() => useNotesStore.getState().setZoom(zoom / 1.1)}>
            <Minus className="size-3.5" />
          </Button>
          <span className="w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="sm" onClick={() => useNotesStore.getState().setZoom(zoom * 1.1)}>
            <Plus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const p = pages[pageIndex];
              if (!p || !stageRef.current) return;
              const { w } = displaySize(p);
              const z = (stageRef.current.clientWidth - 48) / w;
              useNotesStore.getState().setZoom(z);
            }}
          >
            Vừa rộng
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const p = pages[pageIndex];
              if (!p || !stageRef.current) return;
              const { w, h } = displaySize(p);
              const z = Math.min((stageRef.current.clientWidth - 48) / w, (stageRef.current.clientHeight - 48) / h);
              useNotesStore.getState().setZoom(z);
            }}
          >
            Vừa trang
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              useNotesStore.getState().persistSettings({
                pageMode: pageMode === "continuous" ? "single" : "continuous",
              })
            }
          >
            {pageMode === "continuous" ? "Cuộn liên tục" : "Từng trang"}
          </Button>
          <form
            className="ml-auto flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(notebookId, search);
            }}
          >
            <Search className="size-3.5 text-subtle" />
            <Input
              className="h-8 w-40"
              placeholder="Tìm trong PDF…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
        </footer>
      </div>
    </TooltipProvider>
  );
}

function Toolbar() {
  const tool = useNotesStore((s) => s.tool);
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-surface px-2 py-1">
      <ToolBtn id="lasso" label="Lasso" icon={Lasso} />
      <ToolBtn id="hand" label="Di chuyển" icon={Hand} />
      <span className="mx-1 h-6 w-px bg-border" />
      {PENS.map((p) => (
        <PenBtn key={p.id} id={p.id} label={p.label} icon={p.id === "highlighter" ? Highlighter : p.icon} />
      ))}
      <EraserBtn />
      <span className="mx-1 h-6 w-px bg-border" />
      <ToolBtn id="text" label="Chữ" icon={Type} />
      <ToolBtn id="image" label="Ảnh" icon={ImagePlus} />
      <ToolBtn id="line" label="Đường thẳng" icon={Minus} />
      <ToolBtn id="arrow" label="Mũi tên" icon={ArrowUpRight} />
      <ToolBtn id="rect" label="Hình chữ nhật" icon={Square} />
      <ToolBtn id="ellipse" label="Hình tròn" icon={Circle} />
      <span className="mx-1 h-6 w-px bg-border" />
      <Tooltip content="Hoàn tác (Ctrl+Z)">
        <Button variant="ghost" size="icon" onClick={() => useNotesStore.getState().undo()}>
          <Undo2 />
        </Button>
      </Tooltip>
      <Tooltip content="Làm lại">
        <Button variant="ghost" size="icon" onClick={() => useNotesStore.getState().redo()}>
          <Redo2 />
        </Button>
      </Tooltip>
      <Tooltip content="Xoay trang">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            const pages = useNotesStore.getState().pages;
            const i = useNotesStore.getState().currentPageIndex;
            const p = pages[i];
            if (p) void useNotesStore.getState().rotatePage(p.id);
          }}
        >
          <RotateCw />
        </Button>
      </Tooltip>
      <div
        className="ml-2 size-6 rounded-full border border-border"
        style={{
          background: tool.name === "highlighter" ? tool.highlighterColor : tool.color,
        }}
        aria-hidden
      />
    </div>
  );
}

function PageMenu({
  page,
  pageIndex,
  pageCount,
}: {
  page: PageRecord;
  pageIndex: number;
  pageCount: number;
}) {
  const patterns: PaperPattern[] = ["blank", "lined", "grid", "dots", "cornell"];
  const current = patterns.indexOf(page.paper.pattern);
  const nextPattern = patterns[(current + 1) % patterns.length] ?? "blank";
  return (
    <DropdownMenu
      trigger={
        <Button
          variant="icon"
          size="icon"
          className="size-8 bg-surface-2/90"
          aria-label={`Tùy chọn trang ${pageIndex + 1}`}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      }
    >
      <MenuItem onSelect={() => void useNotesStore.getState().duplicatePage(page.id)}>
        Nhân bản trang
      </MenuItem>
      <MenuItem onSelect={() => void useNotesStore.getState().rotatePage(page.id)}>
        Xoay 90°
      </MenuItem>
      <MenuItem
        onSelect={() =>
          void useNotesStore
            .getState()
            .setPagePaper(page.id, { ...page.paper, pattern: nextPattern })
        }
      >
        Đổi mẫu giấy
      </MenuItem>
      <MenuItem
        onSelect={() =>
          void useNotesStore.getState().addBookmark(page.id, `Trang ${pageIndex + 1}`)
        }
      >
        Thêm dấu trang
      </MenuItem>
      <MenuSep />
      <MenuItem
        danger
        disabled={pageCount <= 1}
        onSelect={() => void useNotesStore.getState().deletePage(page.id)}
      >
        Xóa trang
      </MenuItem>
    </DropdownMenu>
  );
}

function ToolBtn({ id, label, icon: Icon }: { id: ToolName; label: string; icon: typeof PenLine }) {
  const active = useNotesStore((s) => s.tool.name === id);
  return (
    <Tooltip content={label}>
      <Button
        variant="ghost"
        size="icon"
        className={cn(active && "tool-active")}
        aria-pressed={active}
        onClick={() => useNotesStore.getState().setTool({ name: id })}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}

function PenBtn({ id, label, icon: Icon }: { id: ToolName; label: string; icon: typeof PenLine }) {
  const active = useNotesStore((s) => s.tool.name === id);
  const tool = useNotesStore((s) => s.tool);
  const colors = id === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
  const color = id === "highlighter" ? tool.highlighterColor : tool.color;
  const width = id === "highlighter" ? tool.highlighterWidth : tool.width;
  return (
    <Popover
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className={cn(active && "tool-active")}
          aria-label={label}
          onClick={() => {
            if (!active) useNotesStore.getState().setTool({ name: id });
          }}
        >
          <Icon />
        </Button>
      }
    >
      <p className="mb-2 text-xs font-medium">{label}</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            className={cn("size-7 rounded-full border-2", color === c ? "border-fg" : "border-transparent")}
            style={{ background: c }}
            onClick={() =>
              useNotesStore.getState().setTool(
                id === "highlighter" ? { name: id, highlighterColor: c } : { name: id, color: c },
              )
            }
          />
        ))}
      </div>
      <p className="mb-1 text-[11px] text-muted">Độ dày</p>
      <Slider
        min={id === "highlighter" ? 8 : 0.8}
        max={id === "highlighter" ? 36 : 12}
        step={0.2}
        value={width}
        onValueChange={(v) =>
          useNotesStore.getState().setTool(id === "highlighter" ? { highlighterWidth: v } : { width: v })
        }
      />
    </Popover>
  );
}

function EraserBtn() {
  const active = useNotesStore((s) => s.tool.name === "eraser");
  const mode = useNotesStore((s) => s.tool.eraserMode);
  return (
    <Popover
      trigger={
        <Button
          variant="ghost"
          size="icon"
          className={cn(active && "tool-active")}
          aria-label="Tẩy"
          onClick={() => {
            if (!active) useNotesStore.getState().setTool({ name: "eraser" });
          }}
        >
          <Eraser />
        </Button>
      }
    >
      <p className="mb-2 text-xs font-medium">Tẩy</p>
      {(
        [
          ["stroke", "Cả nét"],
          ["partial", "Một phần nét"],
          ["highlighter", "Chỉ highlight"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={cn("mb-1 block w-full rounded-md px-2 py-1.5 text-left text-xs", mode === id && "bg-accent-soft")}
          onClick={() => useNotesStore.getState().setTool({ name: "eraser", eraserMode: id })}
        >
          {label}
        </button>
      ))}
      <p className="mt-2 mb-1 text-[11px] text-muted">Kích thước</p>
      <Slider
        min={4}
        max={40}
        value={useNotesStore.getState().tool.eraserWidth}
        onValueChange={(v) => useNotesStore.getState().setTool({ eraserWidth: v })}
      />
    </Popover>
  );
}

function TocList() {
  const toc = useNotesStore((s) => s.toc);
  if (!toc.length) return <p className="px-1 text-xs text-muted">Không có mục lục.</p>;
  return (
    <ul className="space-y-1">
      {toc.map((t, i) => (
        <li key={i}>
          <button
            type="button"
            className="w-full rounded-md px-1 py-1 text-left text-xs hover:bg-overlay"
            onClick={() => useNotesStore.getState().setPageIndex(t.pageIndex)}
          >
            {t.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

function BookmarkList() {
  const bookmarks = useNotesStore((s) => s.bookmarks);
  const pages = useNotesStore((s) => s.pages);
  return (
    <div>
      <Button
        size="sm"
        variant="outline"
        className="mb-2 w-full"
        onClick={() => {
          const p = pages[useNotesStore.getState().currentPageIndex];
          if (p) void useNotesStore.getState().addBookmark(p.id, `Trang ${p.index + 1}`);
        }}
      >
        <BookmarkPlus className="size-3.5" /> Thêm dấu trang
      </Button>
      {bookmarks.map((b) => (
        <button
          key={b.id}
          type="button"
          className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left text-xs hover:bg-overlay"
          onClick={() => {
            const idx = pages.findIndex((p) => p.id === b.pageId);
            if (idx >= 0) useNotesStore.getState().setPageIndex(idx);
          }}
        >
          {b.title}
        </button>
      ))}
    </div>
  );
}

async function runSearch(notebookId: string, q: string) {
  const nb = useNotesStore.getState().notebooks.find((n) => n.id === notebookId);
  if (!nb?.pdfAssetId || !q.trim()) {
    toast.message("Chỉ tìm được chữ có sẵn trong PDF.");
    return;
  }
  try {
    const asset = await getAsset(nb.pdfAssetId);
    if (!asset) return;
    const doc = await loadPdfDocument(nb.pdfAssetId, await asset.blob.arrayBuffer());
    const hits = await searchPdfText(doc, q);
    useNotesStore.setState({ pdfSearchHits: hits });
    if (!hits.length) toast.message("Không thấy kết quả.");
    else {
      toast.success(`${hits.length} trang có “${q}”`);
      useNotesStore.getState().setPageIndex(hits[0]!.pageIndex);
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Không tìm được");
  }
}
