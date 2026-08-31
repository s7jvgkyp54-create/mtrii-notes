import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, FileText, Users } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function DrivePicker({
  open,
  accessToken,
  onClose,
  onPick,
}: {
  open: boolean;
  accessToken: string | null;
  onClose: () => void;
  onPick: (file: { id: string; name: string; mimeType: string }) => void;
}) {
  const [files, setFiles] = useState<{ id: string; name: string; mimeType: string; isShared?: boolean }[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open || !accessToken) return;
    let mounted = true;
    
    async function loadFiles() {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          q: "mimeType='application/pdf' and trashed=false",
          // Include files from Shared with me and Shared drives, not just My Drive.
          corpora: "user",
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
          fields: "files(id,name,mimeType,sharedWithMeTime,driveId)",
          orderBy: "modifiedTime desc",
          pageSize: "100",
        });
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error("Không thể lấy danh sách file");
        const data = await res.json();
        if (mounted) {
          const uniqueFiles = new Map<string, { id: string; name: string; mimeType: string; isShared?: boolean }>();
          for (const file of data.files || []) {
            uniqueFiles.set(file.id, {
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              isShared: Boolean(file.sharedWithMeTime || file.driveId),
            });
          }
          setFiles([...uniqueFiles.values()]);
        }
      } catch (err: any) {
        if (mounted) toast.error(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    
    loadFiles();
    
    return () => { mounted = false; };
  }, [open, accessToken]);

  if (!open) return null;

  if (!accessToken) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Chưa kết nối">
        <div className="py-6 text-center">
          <p className="text-sm font-medium text-danger">Chưa kết nối Google Drive</p>
          <p className="text-sm text-muted mt-2">Vui lòng vào phần Cài đặt để đăng nhập trước.</p>
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose}>Đóng</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Chọn PDF từ Google Drive" className="w-[min(90vw,600px)]">
      <div className="mt-4 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted" />
          <Input
            autoFocus
            type="text"
            placeholder="Tìm kiếm file PDF..."
            className="w-full pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-[300px] max-h-[60vh] border rounded-md mt-4 p-2 bg-surface">
        {loading ? (
          <div className="flex h-full min-h-[280px] items-center justify-center">
            <Loader2 className="size-6 animate-spin text-accent" />
          </div>
        ) : files.length === 0 ? (
          <div className="flex h-full min-h-[280px] items-center justify-center text-sm text-muted">
            Không tìm thấy file PDF nào trong Drive của bạn.
          </div>
        ) : files.filter(f => f.name.toLowerCase().includes(search.toLowerCase())).length === 0 ? (
          <div className="flex h-full min-h-[280px] items-center justify-center text-sm text-muted">
            Không có file nào khớp với từ khóa "{search}".
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-1">
            {files.filter(f => f.name.toLowerCase().includes(search.toLowerCase())).map(f => (
              <button
                key={f.id}
                onClick={() => onPick(f)}
                className="flex items-center gap-3 w-full p-3 rounded hover:bg-overlay text-left transition-colors"
              >
                <FileText className="size-8 text-danger shrink-0" />
                <span className="truncate text-sm font-medium flex-1">{f.name}</span>
                {f.isShared ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted" title="Tệp được chia sẻ">
                    <Users className="size-3.5" /> Đã chia sẻ
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
