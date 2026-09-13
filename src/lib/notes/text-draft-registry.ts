export interface TextDraftIdentity {
  sessionId: string;
  notebookId: string;
  pageId: string;
  objectId: string;
}

interface ActiveTextDraft {
  identity: TextDraftIdentity;
  collect: () => void;
}

const activeDrafts = new Map<string, ActiveTextDraft>();

/** Register a live editor so global flushes can synchronously collect its DOM value. */
export function registerActiveTextDraft(identity: TextDraftIdentity, collect: () => void) {
  const registration = { identity, collect };
  activeDrafts.set(identity.sessionId, registration);
  return () => {
    // A stale StrictMode cleanup must not unregister a newer incarnation.
    if (activeDrafts.get(identity.sessionId) === registration)
      activeDrafts.delete(identity.sessionId);
  };
}

export function collectActiveTextDrafts() {
  // Snapshot first because collecting can synchronously end an editing session.
  for (const draft of Array.from(activeDrafts.values())) draft.collect();
}

export function activeTextDraftCount() {
  return activeDrafts.size;
}
