import type { StoredDocumentContent } from "./types";

export function normalizeDocumentContent(
  noteId: string,
  value: unknown,
): StoredDocumentContent {
  if (value && typeof value === "object") {
    const v = value as any;
    if (v.schemaVersion === 1 && v.type === "tiptap" && v.doc && v.doc.type === "doc") {
      return {
        noteId,
        schemaVersion: 1,
        type: "tiptap",
        doc: v.doc,
      };
    }
  }

  // Fallback to empty safe document
  return {
    noteId,
    schemaVersion: 1,
    type: "tiptap",
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
        },
      ],
    },
  };
}
