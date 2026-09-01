import React from "react";
import { type Editor } from "@tiptap/react";
import { useDocumentSaveStore } from "@/lib/notes/document-save";

interface EditorToolbarProps {
  editor: Editor | null;
  noteId: string;
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({ editor, noteId }) => {
  const saveState = useDocumentSaveStore((s) => s.states[noteId]);

  if (!editor) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-background border-b z-10 sticky top-0">
      <div className="flex gap-1 flex-1">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`p-2 rounded ${editor.isActive("bold") ? "bg-accent" : "hover:bg-accent/50"}`}
        >
          Bold
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`p-2 rounded ${editor.isActive("italic") ? "bg-accent" : "hover:bg-accent/50"}`}
        >
          Italic
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`p-2 rounded ${editor.isActive("heading", { level: 2 }) ? "bg-accent" : "hover:bg-accent/50"}`}
        >
          H2
        </button>
      </div>

      <div className="text-sm text-muted-foreground">
        {saveState?.status === "saving" && "Đang lưu…"}
        {saveState?.status === "saved" && saveState.lastSavedAt && `Đã lưu lúc ${new Date(saveState.lastSavedAt).toLocaleTimeString()}`}
        {saveState?.status === "error" && (
          <span className="text-destructive">Lỗi lưu — Thử lại</span>
        )}
        {!saveState && "Chưa lưu"}
      </div>
    </div>
  );
};
