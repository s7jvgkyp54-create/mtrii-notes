export interface CloseRequestLike {
  preventDefault: () => void;
}

interface CloseGuardOptions {
  flush: () => Promise<void>;
  destroy: () => Promise<void>;
  onError: (error: unknown) => void;
}

/**
 * Prevent native close requests until durable storage has acknowledged every
 * pending write. A failed flush leaves the window open and allows a retry.
 */
export function createCloseGuard({ flush, destroy, onError }: CloseGuardOptions) {
  let closing = false;

  return async (event: CloseRequestLike) => {
    // Prevent every request, including a second click while the first flush is
    // running. Otherwise that second event can bypass the guard.
    event.preventDefault();
    if (closing) return;
    closing = true;
    try {
      await flush();
      await destroy();
    } catch (error) {
      closing = false;
      onError(error);
    }
  };
}
