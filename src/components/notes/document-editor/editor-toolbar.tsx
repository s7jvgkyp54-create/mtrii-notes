import React from "react";
import { type Editor } from "@tiptap/react";
import { useDocumentSaveStore } from "@/lib/notes/document-save";
import { VersionHistory } from "./version-history";
import { downloadBlob } from "@/lib/utils";
import { FileText, Printer } from "lucide-react";
import { toast } from "sonner";

interface EditorToolbarProps {
  editor: Editor | null;
  noteId: string;
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({ editor, noteId }) => {
  const saveState = useDocumentSaveStore((s) => s.states[noteId]);

  if (!editor) return null;

  const handleExportMarkdown = () => {
    try {
      const markdown = (editor.storage as any).markdown.getMarkdown();
      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      downloadBlob(blob, `Document_${noteId}.md`);
      toast.success("Đã xuất Markdown");
    } catch (e) {
      toast.error("Lỗi xuất Markdown");
      console.error(e);
    }
  };

  const handleExportPdf = () => {
    window.print();
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-background border-b z-10 sticky top-0 print:hidden">
      <div className="flex gap-1 flex-1">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`p-2 rounded ${editor.isActive("bold") ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
        >
          Bold
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`p-2 rounded ${editor.isActive("italic") ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
        >
          Italic
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`p-2 rounded ${editor.isActive("heading", { level: 2 }) ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"}`}
        >
          H2
        </button>
      </div>

      <div className="text-sm text-muted-foreground flex items-center gap-4">
        <span>
          {saveState?.status === "saving" && "Đang lưu…"}
          {saveState?.status === "saved" && saveState.lastSavedAt && `Đã lưu lúc ${new Date(saveState.lastSavedAt).toLocaleTimeString()}`}
          {saveState?.status === "error" && (
            <span className="text-destructive">Lỗi lưu — Thử lại</span>
          )}
          {!saveState && "Chưa lưu"}
        </span>
        
        <VersionHistory noteId={noteId} />

        <div className="flex gap-1 border-l pl-4 ml-2 border-border">
          <button
            onClick={handleExportMarkdown}
            className="p-2 rounded hover:bg-accent/50 flex items-center gap-1 text-xs font-medium text-foreground"
            title="Xuất Markdown"
          >
            <FileText className="w-4 h-4" />
            <span className="hidden sm:inline">Markdown</span>
          </button>
          <button
            onClick={handleExportPdf}
            className="p-2 rounded hover:bg-accent/50 flex items-center gap-1 text-xs font-medium text-foreground"
            title="In / Xuất PDF"
          >
            <Printer className="w-4 h-4" />
            <span className="hidden sm:inline">PDF</span>
          </button>
        </div>
      </div>
    </div>
  );
};
