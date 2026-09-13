import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acquireObjectUrl,
  getObjectUrlRegistryStats,
  invalidateAllObjectUrls,
  invalidateObjectUrl,
} from "./object-url-registry.ts";

function withObjectUrlSpies(run: (calls: { created: string[]; revoked: string[] }) => void) {
  invalidateAllObjectUrls();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const calls = { created: [] as string[], revoked: [] as string[] };

  URL.createObjectURL = (blob: Blob) => {
    const url = `blob:notes-test-${calls.created.length + 1}-${blob.size}`;
    calls.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    calls.revoked.push(url);
  };

  try {
    run(calls);
  } finally {
    invalidateAllObjectUrls();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
}

describe("object URL registry", () => {
  it("shares one URL until the final consumer releases it", () => {
    withObjectUrlSpies((calls) => {
      const before = getObjectUrlRegistryStats();
      const blob = new Blob(["shared-image"]);
      const first = acquireObjectUrl("asset-shared", blob);
      const second = acquireObjectUrl("asset-shared", blob);

      assert.equal(first.url, second.url);
      assert.equal(calls.created.length, 1);
      assert.deepEqual(getObjectUrlRegistryStats(), {
        liveEntries: 1,
        liveRefs: 2,
        encodedBytes: blob.size,
        creates: before.creates + 1,
        revokes: before.revokes,
      });

      first.release();
      assert.equal(calls.revoked.length, 0);
      assert.equal(getObjectUrlRegistryStats().liveRefs, 1);

      second.release();
      assert.deepEqual(calls.revoked, [first.url]);
      assert.equal(getObjectUrlRegistryStats().liveEntries, 0);
      assert.equal(getObjectUrlRegistryStats().liveRefs, 0);
      assert.equal(getObjectUrlRegistryStats().encodedBytes, 0);
    });
  });

  it("makes release idempotent for React StrictMode-style cleanup", () => {
    withObjectUrlSpies((calls) => {
      const lease = acquireObjectUrl("asset-strict", new Blob(["strict"]));

      lease.release();
      lease.release();

      assert.deepEqual(calls.revoked, [lease.url]);
      assert.equal(getObjectUrlRegistryStats().liveEntries, 0);
      assert.equal(getObjectUrlRegistryStats().liveRefs, 0);
      assert.equal(getObjectUrlRegistryStats().encodedBytes, 0);
    });
  });

  it("retires an active generation and lets a future acquire create a new one", () => {
    withObjectUrlSpies((calls) => {
      const before = getObjectUrlRegistryStats();
      const oldBlob = new Blob(["old"]);
      const newBlob = new Blob(["replacement"]);
      const oldLease = acquireObjectUrl("asset-replaced", oldBlob);

      invalidateObjectUrl("asset-replaced");
      assert.equal(calls.revoked.length, 0);
      assert.equal(getObjectUrlRegistryStats().liveEntries, 1);

      const newLease = acquireObjectUrl("asset-replaced", newBlob);
      assert.notEqual(newLease.url, oldLease.url);
      assert.equal(calls.created.length, 2);
      assert.deepEqual(getObjectUrlRegistryStats(), {
        liveEntries: 2,
        liveRefs: 2,
        encodedBytes: oldBlob.size + newBlob.size,
        creates: before.creates + 2,
        revokes: before.revokes,
      });

      oldLease.release();
      assert.deepEqual(calls.revoked, [oldLease.url]);
      assert.equal(getObjectUrlRegistryStats().liveEntries, 1);

      const sharedNewLease = acquireObjectUrl("asset-replaced", newBlob);
      assert.equal(sharedNewLease.url, newLease.url);
      assert.equal(calls.created.length, 2);

      newLease.release();
      assert.deepEqual(calls.revoked, [oldLease.url]);
      sharedNewLease.release();
      assert.deepEqual(calls.revoked, [oldLease.url, newLease.url]);
      assert.equal(getObjectUrlRegistryStats().liveEntries, 0);
      assert.equal(getObjectUrlRegistryStats().liveRefs, 0);
      assert.equal(getObjectUrlRegistryStats().encodedBytes, 0);
    });
  });

  it("invalidates every reusable generation without revoking active consumers early", () => {
    withObjectUrlSpies((calls) => {
      const first = acquireObjectUrl("asset-a", new Blob(["a"]));
      const second = acquireObjectUrl("asset-b", new Blob(["bb"]));

      invalidateAllObjectUrls();
      assert.equal(calls.revoked.length, 0);

      const replacement = acquireObjectUrl("asset-a", new Blob(["aaa"]));
      assert.notEqual(replacement.url, first.url);
      replacement.release();
      first.release();
      second.release();

      assert.equal(calls.created.length, 3);
      assert.equal(new Set(calls.revoked).size, 3);
      assert.equal(getObjectUrlRegistryStats().liveEntries, 0);
      assert.equal(getObjectUrlRegistryStats().liveRefs, 0);
      assert.equal(getObjectUrlRegistryStats().encodedBytes, 0);
    });
  });
});
