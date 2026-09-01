import { useState, useMemo } from "react";
import { Folder as FolderIcon, Search, ChevronRight } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNotesStore } from "@/lib/notes/store";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Folder } from "@/lib/notes/types";

interface MoveNotebookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookIds: string[];
}

export function MoveNotebookDialog({ open, onOpenChange, notebookIds }: MoveNotebookDialogProps) {
  const folders = useNotesStore((s) => s.folders).filter((f) => !f.deletedAt);
  const notebooks = useNotesStore((s) => s.notebooks);
  const [query, setQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(undefined!);

  // When opening, initialize selectedFolderId to the first notebook's folder
  // If moving multiple, just default to null (Root)
  const initialFolderId = useMemo(() => {
    if (notebookIds.length === 1) {
      const nb = notebooks.find((n) => n.id === notebookIds[0]);
      return nb?.folderId || null;
    }
    return null;
  }, [notebookIds, notebooks, open]);

  if (selectedFolderId === undefined) {
    if (open) setSelectedFolderId(initialFolderId);
  } else if (!open && selectedFolderId !== undefined) {
    // reset when closed
    setSelectedFolderId(undefined!);
    setQuery("");
  }

  const filteredFolders = useMemo(() => {
    if (!query.trim()) return folders;
    const q = query.trim().toLowerCase();
    return folders.filter((f) => f.name.toLowerCase().includes(q));
  }, [folders, query]);

  const handleConfirm = async () => {
    if (selectedFolderId === undefined) return;
    const s = useNotesStore.getState();
    const originalFolderIds = notebookIds.map((id) => {
      const nb = s.notebooks.find((n) => n.id === id);
      return { id, folderId: nb?.folderId || null };
    });

    try {
      await Promise.all(notebookIds.map((id) => s.moveNotebook(id, selectedFolderId)));
      onOpenChange(false);
      
      const folderName = selectedFolderId ? folders.find((f) => f.id === selectedFolderId)?.name || "Thư mục" : "Tất cả tài liệu";
      toast.success(`Đã di chuyển ${notebookIds.length} sổ tay đến ${folderName}`, {
        action: {
          label: "Hoàn tác",
          onClick: () => {
            originalFolderIds.forEach(({ id, folderId }) => {
              void s.moveNotebook(id, folderId);
            });
            toast.success("Đã hoàn tác di chuyển");
          },
        },
      });
    } catch (e) {
      toast.error("Lỗi khi di chuyển sổ tay");
    }
  };

  const hasChanged = selectedFolderId !== undefined && selectedFolderId !== initialFolderId;

  const tree = useMemo(() => {
    return [...filteredFolders].sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredFolders]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Di chuyển sổ tay">
      <div className="mt-2 flex flex-col gap-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            placeholder="Tìm thư mục..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-surface-2 p-1">
          <button
            onClick={() => setSelectedFolderId(null)}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-overlay text-left cursor-pointer",
              selectedFolderId === null ? "bg-accent-soft text-accent" : "text-fg",
            )}
          >
            <FolderIcon className="size-4 shrink-0" />
            <span className="flex-1">Tất cả tài liệu (Gốc)</span>
            {initialFolderId === null && <span className="text-xs text-muted">(Hiện tại)</span>}
          </button>
          {tree.map((f) => (
            <button
              key={f.id}
              onClick={() => setSelectedFolderId(f.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-overlay text-left cursor-pointer",
                selectedFolderId === f.id ? "bg-accent-soft text-accent" : "text-fg",
              )}
            >
              <FolderIcon className="size-4 shrink-0" style={f.color ? { color: f.color } : {}} />
              <span className="flex-1 truncate">{f.name}</span>
              {initialFolderId === f.id && <span className="text-xs text-muted">(Hiện tại)</span>}
            </button>
          ))}
          {tree.length === 0 && query && (
            <div className="p-4 text-center text-sm text-muted">Không tìm thấy thư mục</div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button onClick={handleConfirm} disabled={!hasChanged}>
            Di chuyển
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
