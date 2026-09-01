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

import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { all, createLowlight } from "lowlight";
import { MathExtension } from "@aarkue/tiptap-math-extension";
import Link from "@tiptap/extension-link";
import Dropcursor from "@tiptap/extension-dropcursor";
// @ts-expect-error: no type declaration for this module
import GlobalDragHandle from "tiptap-extension-global-drag-handle";
import { WikilinkExtension, wikilinkSuggestion } from "./wikilink-extension";
import { NotesImageExtension } from "./image-extension";
import { putAsset } from "@/lib/notes/db";
import { nid } from "@/lib/utils";

import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./editor.css";

const lowlight = createLowlight(all);

interface DocumentEditorProps {
  noteId: string;
}

export const DocumentEditor: React.FC<DocumentEditorProps> = ({ noteId }) => {
  const [loading, setLoading] = useState(true);
  const currentNoteId = useRef(noteId);

  const handleImageFile = async (file: File, view: any, pos: number) => {
    try {
      const id = nid();
      await putAsset({
        id,
        kind: "image",
        mime: file.type,
        name: file.name,
        byteLength: file.size,
        blob: file,
        createdAt: Date.now(),
      });
      const node = view.state.schema.nodes.image.create({ src: `asset-id:${id}` });
      const tr = view.state.tr.insert(pos, node);
      view.dispatch(tr);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false, // Disable default codeBlock to use lowlight
      }),
      Placeholder.configure({
        placeholder: "Gõ '/' để mở menu lệnh, hoặc bắt đầu viết...",
      }),
      SlashCommands.configure({
        suggestion: slashSuggestion,
      }),
      CodeBlockLowlight.configure({
        lowlight,
      }),
      MathExtension.configure({
        evaluation: false,
      }),
      Link.configure({
        openOnClick: true,
        autolink: true,
      }),
      WikilinkExtension.configure({
        suggestion: wikilinkSuggestion,
      }),
      Dropcursor.configure({
        color: 'var(--accent)',
        width: 2,
      }),
      GlobalDragHandle.configure({
        dragHandleWidth: 20,
        scrollTreshold: 100,
      }),
      NotesImageExtension,
    ],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    autofocus: false,
    editorProps: {
      handleDrop: function(view, event, slice, moved) {
        if (!moved && event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
          const file = event.dataTransfer.files[0];
          if (file && file.type.startsWith("image/")) {
            const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (coordinates) {
              void handleImageFile(file, view, coordinates.pos);
              return true;
            }
          }
        }
        return false;
      },
      handlePaste: function(view, event, slice) {
        if (event.clipboardData && event.clipboardData.files && event.clipboardData.files.length > 0) {
          const file = event.clipboardData.files[0];
          if (file && file.type.startsWith("image/")) {
            void handleImageFile(file, view, view.state.selection.from);
            return true;
          }
        }
        return false;
      }
    },
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
