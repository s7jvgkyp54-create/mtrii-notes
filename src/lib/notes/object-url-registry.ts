export interface ObjectUrlLease {
  readonly url: string;
  release(): void;
}

interface ObjectUrlEntry {
  readonly assetId: string;
  readonly url: string;
  readonly encodedBytes: number;
  refs: number;
  reusable: boolean;
  revoked: boolean;
}

const reusableEntries = new Map<string, ObjectUrlEntry>();
const liveEntries = new Set<ObjectUrlEntry>();

let liveRefs = 0;
let encodedBytes = 0;
let creates = 0;
let revokes = 0;

function revokeEntry(entry: ObjectUrlEntry) {
  if (entry.revoked || entry.refs !== 0) return;

  entry.revoked = true;
  entry.reusable = false;
  if (reusableEntries.get(entry.assetId) === entry) {
    reusableEntries.delete(entry.assetId);
  }
  liveEntries.delete(entry);
  encodedBytes = Math.max(0, encodedBytes - entry.encodedBytes);
  revokes += 1;

  // Cleanup paths (including React effect teardown) must remain safe even if a
  // host provides an incomplete URL implementation.
  try {
    URL.revokeObjectURL(entry.url);
  } catch {
    // The generation is still retired so it can never be reused or revoked twice.
  }
}

function invalidateEntry(entry: ObjectUrlEntry) {
  entry.reusable = false;
  if (reusableEntries.get(entry.assetId) === entry) {
    reusableEntries.delete(entry.assetId);
  }
  revokeEntry(entry);
}

export function acquireObjectUrl(assetId: string, blob: Blob): ObjectUrlLease {
  let entry = reusableEntries.get(assetId);
  if (!entry || entry.revoked || !entry.reusable) {
    const url = URL.createObjectURL(blob);
    entry = {
      assetId,
      url,
      encodedBytes: blob.size,
      refs: 0,
      reusable: true,
      revoked: false,
    };
    reusableEntries.set(assetId, entry);
    liveEntries.add(entry);
    encodedBytes += entry.encodedBytes;
    creates += 1;
  }

  entry.refs += 1;
  liveRefs += 1;
  const leasedEntry = entry;
  let released = false;

  return {
    url: leasedEntry.url,
    release() {
      if (released) return;
      released = true;
      leasedEntry.refs = Math.max(0, leasedEntry.refs - 1);
      liveRefs = Math.max(0, liveRefs - 1);
      if (leasedEntry.refs === 0) revokeEntry(leasedEntry);
    },
  };
}

export function invalidateObjectUrl(assetId: string) {
  const entry = reusableEntries.get(assetId);
  if (entry) invalidateEntry(entry);
}

export function invalidateAllObjectUrls() {
  reusableEntries.clear();
  for (const entry of [...liveEntries]) invalidateEntry(entry);
}

export function getObjectUrlRegistryStats() {
  return {
    liveEntries: liveEntries.size,
    liveRefs,
    encodedBytes,
    creates,
    revokes,
  };
}
