import assert from "node:assert/strict";
import test from "node:test";
import { createCloseGuard } from "./close-guard.ts";

test("keeps the native window open after a failed flush and permits retry", async () => {
  let fail = true;
  let destroys = 0;
  let prevented = 0;
  const errors: unknown[] = [];
  const close = createCloseGuard({
    flush: async () => {
      if (fail) throw new Error("write failed");
    },
    destroy: async () => {
      destroys += 1;
    },
    onError: (error) => errors.push(error),
  });

  await close({
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.equal(destroys, 0);
  assert.equal(errors.length, 1);

  fail = false;
  await close({
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.equal(destroys, 1);
  assert.equal(prevented, 2);
});

test("a repeated close request cannot bypass an in-flight flush", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let destroys = 0;
  let prevented = 0;
  const close = createCloseGuard({
    flush: () => pending,
    destroy: async () => {
      destroys += 1;
    },
    onError: () => undefined,
  });

  const first = close({
    preventDefault: () => {
      prevented += 1;
    },
  });
  await close({
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.equal(destroys, 0);
  release();
  await first;
  assert.equal(destroys, 1);
  assert.equal(prevented, 2);
});
