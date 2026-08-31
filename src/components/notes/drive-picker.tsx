import { useState, useEffect } from "react";
import { Folder, File, ChevronRight, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

export function DrivePicker({
  open,
  accessToken,
  onClose,
  onPick,
}: {
  open: boolean;
  accessToken: string | null;
  onClose: () => void;
  onPick: (file: DriveFile) => void;
}) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [folderStack, setFolderStack] = useState<{ id: string; name: string }[]>([{ id: "root", name: "Drive" }]);
  const [error, setError] = useState("");

  const currentFolder = folderStack[folderStack.length - 1]!;

  useEffect(() => {
    if (!open || !accessToken) return;
    let cancel = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const q = `'${currentFolder.id}' in parents and trashed = false`;
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&orderBy=folder,name`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!res.ok) throw new Error("Lỗi tải danh sách file");
        const data = await res.json();
        if (!cancel) setFiles(data.files || []);
      } catch (e: any) {
        if (!cancel) setError(e.message);
      } finally {
        if (!cancel) setLoading(false);
      }
    }
    load();
    return () => { cancel = true; };
  }, [open, accessToken, currentFolder.id]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Chọn file từ Google Drive" className="w-[600px] h-[500px] flex flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3 text-sm">
        {folderStack.map((f, i) => (
          <div key={f.id} className="flex items-center gap-2">
            <button
              className="hover:underline"
              onClick={() => setFolderStack(folderStack.slice(0, i + 1))}
            >
              {f.name}
            </button>
            {i < folderStack.length - 1 && <ChevronRight className="size-4 text-muted" />}
          </div>
        ))}
      </div>
      
      <div className="flex-1 overflow-auto p-2">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-red-500">{error}</div>
        ) : files.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted text-sm">Thư mục trống</div>
        ) : (
          <div className="flex flex-col gap-1">
            {files.map((file) => {
              const isFolder = file.mimeType === "application/vnd.google-apps.folder";
              const isSupported = isFolder || file.mimeType === "application/pdf" || file.mimeType.startsWith("image/");
              return (
                <button
                  key={file.id}
                  disabled={!isSupported}
                  onClick={() => {
                    if (isFolder) setFolderStack([...folderStack, { id: file.id, name: file.name }]);
                    else onPick(file);
                  }}
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${
                    isSupported ? "hover:bg-accent/10" : "opacity-50 cursor-not-allowed"
                  }`}
                >
                  {isFolder ? <Folder className="size-5 text-blue-500" /> : <File className="size-5 text-gray-500" />}
                  <span className="truncate">{file.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
