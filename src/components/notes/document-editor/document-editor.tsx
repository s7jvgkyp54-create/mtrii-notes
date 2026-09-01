import React, { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

import { EditorToolbar } from "./editor-toolbar";
import { BubbleMenu } from "./bubble-menu";
import { SlashCommands, slashSuggestion } from "./slash-extension";
import { getDocument } from "@/lib/notes/db";
import { normalizeDocumentContent } from "@/lib/notes/document-content";
import { scheduleSaveDocument, flushSaveDocument } from "@/lib/notes/document-save";
import "./editor.css";

interface DocumentEditorProps {
  noteId: string;
}

export const DocumentEditor: React.FC<DocumentEditorProps> = ({ noteId }) => {
  const [loading, setLoading] = useState(true);
  const currentNoteId = useRef(noteId);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Gõ '/' để mở menu lệnh, hoặc bắt đầu viết...",
      }),
      SlashCommands.configure({
        suggestion: slashSuggestion,
      }),
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: false,
    onUpdate: ({ editor }) => {
      // Don't save if we are loading or switching notes
      if (loading) return;
      scheduleSaveDocument(currentNoteId.current, editor.getJSON() as any);
    },
  });

  useEffect(() => {
    let active = true;

    const loadNote = async () => {
      if (currentNoteId.current !== noteId) {
        // Flush the previous note before switching
        await flushSaveDocument(currentNoteId.current);
      }
      currentNoteId.current = noteId;
      setLoading(true);

      try {
        const raw = await getDocument(noteId);
        const normalized = normalizeDocumentContent(noteId, raw);

        if (active && editor) {
          // Temporarily disable updates while setting content
          // so we don't trigger a save of the initial load
          editor.commands.setContent(normalized.doc as any, { emitUpdate: false });
          setLoading(false);
        }
      } catch (error) {
        console.error("Failed to load document:", error);
      }
    };

    void loadNote();

    return () => {
      active = false;
      // When unmounting or switching to a new ID, flush the old one
      void flushSaveDocument(currentNoteId.current);
    };
  }, [noteId, editor]);

  if (!editor) return null;

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      <EditorToolbar editor={editor} noteId={noteId} />
      <BubbleMenu editor={editor} />
      <div className="flex-1 overflow-y-auto w-full relative">
        <div className="max-w-[850px] mx-auto bg-background min-h-full">
          {loading ? (
            <div className="p-8 opacity-50">Đang tải...</div>
          ) : (
            <EditorContent editor={editor} />
          )}
        </div>
      </div>
    </div>
  );
};
