import React, { useEffect, useState } from "react";
import { History, Clock, RotateCcw } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getNoteVersions, putDocument } from "@/lib/notes/db";
import { NoteVersion } from "@/lib/notes/types";
import { format } from "date-fns";

interface VersionHistoryProps {
  noteId: string;
}

export const VersionHistory: React.FC<VersionHistoryProps> = ({ noteId }) => {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<NoteVersion | null>(null);

  useEffect(() => {
    if (open) {
      loadVersions();
    }
  }, [open, noteId]);

  const loadVersions = async () => {
    setLoading(true);
    try {
      const v = await getNoteVersions(noteId);
      setVersions(v);
      if (v.length > 0) setSelectedVersion(v[0]);
    } catch (error) {
      console.error("Failed to load versions:", error);
    }
    setLoading(false);
  };

  const handleRestore = async () => {
    if (!selectedVersion) return;
    if (confirm("Bạn có chắc chắn muốn khôi phục phiên bản này? Nội dung hiện tại sẽ bị ghi đè.")) {
      try {
        const content = JSON.parse(selectedVersion.content);
        await putDocument(noteId, content);
        alert("Khôi phục thành công! Vui lòng tải lại trang để xem thay đổi.");
        setOpen(false);
        window.location.reload();
      } catch (error) {
        console.error("Restore failed", error);
        alert("Lỗi khi khôi phục phiên bản.");
      }
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-1.5 text-muted-foreground hover:bg-overlay rounded-md transition-colors"
        title="Lịch sử phiên bản"
      >
        <History className="w-5 h-5" />
      </button>

      <Dialog 
        open={open} 
        onOpenChange={setOpen} 
        title="Lịch sử phiên bản" 
        className="max-w-4xl h-[80vh] flex flex-col"
      >
        <div className="flex-1 flex gap-4 overflow-hidden min-h-0 mt-4">
          {/* Sidebar danh sách phiên bản */}
          <div className="w-1/3 border-r overflow-y-auto pr-2 flex flex-col gap-2">
            {loading ? (
              <div className="text-center text-sm text-muted-foreground mt-10">Đang tải...</div>
            ) : versions.length === 0 ? (
              <div className="text-center text-sm text-muted-foreground mt-10">
                Chưa có phiên bản nào được lưu. Hệ thống sẽ tự động lưu sau mỗi 5 phút.
              </div>
            ) : (
              versions.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSelectedVersion(v)}
                  className={`flex flex-col text-left p-3 rounded-md transition-colors ${
                    selectedVersion?.id === v.id
                      ? "bg-accent-soft border border-accent/20"
                      : "bg-surface hover:bg-overlay border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1 text-sm font-medium">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    {format(new Date(v.createdAt), "dd/MM/yyyy HH:mm:ss")}
                  </div>
                  <span className="text-xs text-muted-foreground">{v.reason}</span>
                </button>
              ))
            )}
          </div>

          {/* Cửa sổ Preview nội dung */}
          <div className="w-2/3 flex flex-col bg-surface-2 rounded-md p-4 overflow-hidden border">
            {selectedVersion ? (
              <>
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-semibold text-sm">
                    Xem trước bản lưu: {format(new Date(selectedVersion.createdAt), "HH:mm:ss")}
                  </h3>
                  <Button size="sm" onClick={handleRestore} className="gap-2">
                    <RotateCcw className="w-4 h-4" /> Khôi phục
                  </Button>
                </div>
                <div className="flex-1 bg-background rounded-md p-4 overflow-y-auto text-sm opacity-80 border pointer-events-none">
                   <pre className="whitespace-pre-wrap font-sans">
                     {selectedVersion.content.replace(/({|}|"|:|,|\[|\])/g, " ")} 
                   </pre>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                Chọn một phiên bản để xem
              </div>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
};
