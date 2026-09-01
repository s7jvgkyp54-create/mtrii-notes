import { create } from "zustand";
import { putDocument, putNoteVersion } from "./db";
import type { StoredDocumentContent, NoteVersion } from "./types";
import { nid } from "@/lib/utils";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

export interface NoteSaveState {
  status: SaveStatus;
  lastSavedAt: number | null;
  lastVersionAt: number | null;
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
        lastVersionAt: null,
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

export async function performSave(noteId: string, doc: StoredDocumentContent, revision: number, forceSnapshot = false) {
  const store = useDocumentSaveStore.getState();
  store.setSaveState(noteId, { status: "saving", revision });

  try {
    await putDocument(noteId, doc);
    
    const currentState = useDocumentSaveStore.getState().states[noteId];
    
    // Version snapshot logic: Every 5 minutes (300000 ms) or if forced
    const now = Date.now();
    const lastVersionAt = currentState?.lastVersionAt || 0;
    let createdVersion = false;
    
    if (forceSnapshot || now - lastVersionAt > 300000) {
      const contentStr = JSON.stringify(doc);
      const version: NoteVersion = {
        id: nid(),
        noteId,
        content: contentStr,
        contentHash: contentStr.length.toString(), // Simple size metric as "hash"
        createdAt: now,
        reason: forceSnapshot ? "Manual snapshot" : "Autosave snapshot",
      };
      await putNoteVersion(version);
      createdVersion = true;
    }

    if (currentState?.revision === revision) {
      store.setSaveState(noteId, {
        status: "saved",
        lastSavedAt: now,
        ...(createdVersion ? { lastVersionAt: now } : {}),
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
