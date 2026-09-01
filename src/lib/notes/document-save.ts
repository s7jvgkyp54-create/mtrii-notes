import { create } from "zustand";
import { putDocument } from "./db";
import type { StoredDocumentContent } from "./types";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface NoteSaveState {
  status: SaveStatus;
  lastSavedAt: number | null;
  error: string | null;
  revision: number;
}

interface DocumentSaveStore {
  states: Record<string, NoteSaveState>;
  setSaveState: (noteId: string, partial: Partial<NoteSaveState>) => void;
}

export const useDocumentSaveStore = create<DocumentSaveStore>((set) => ({
  states: {},
  setSaveState: (noteId, partial) =>
    set((state) => {
      const current = state.states[noteId] || {
        status: "idle",
        lastSavedAt: null,
        error: null,
        revision: 0,
      };
      return {
        states: {
          ...state.states,
          [noteId]: { ...current, ...partial },
        },
      };
    }),
}));

const pendingSaves: Record<string, { doc: StoredDocumentContent; revision: number; timer: ReturnType<typeof setTimeout> }> = {};

export function scheduleSaveDocument(noteId: string, doc: StoredDocumentContent) {
  const store = useDocumentSaveStore.getState();
  const current = store.states[noteId];
  const nextRevision = (current?.revision || 0) + 1;

  store.setSaveState(noteId, { status: "dirty", revision: nextRevision });

  if (pendingSaves[noteId]) {
    clearTimeout(pendingSaves[noteId].timer);
  }

  pendingSaves[noteId] = {
    doc,
    revision: nextRevision,
    timer: setTimeout(() => {
      void performSave(noteId, doc, nextRevision);
    }, 800),
  };
}

export async function performSave(noteId: string, doc: StoredDocumentContent, revision: number) {
  const store = useDocumentSaveStore.getState();
  store.setSaveState(noteId, { status: "saving", revision });

  try {
    await putDocument(noteId, doc);
    
    const currentState = useDocumentSaveStore.getState().states[noteId];
    if (currentState?.revision === revision) {
      store.setSaveState(noteId, {
        status: "saved",
        lastSavedAt: Date.now(),
        error: null,
        revision,
      });
      if (pendingSaves[noteId]) {
        delete pendingSaves[noteId];
      }
    }
  } catch (error: any) {
    store.setSaveState(noteId, {
      status: "error",
      error: error.message || "Failed to save document",
      revision,
    });
  }
}

export async function flushSaveDocument(noteId: string) {
  const pending = pendingSaves[noteId];
  if (pending) {
    clearTimeout(pending.timer);
    await performSave(noteId, pending.doc, pending.revision);
  }
}
