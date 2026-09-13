import assert from "node:assert/strict";
import test from "node:test";
import { LatestWriteQueue } from "./latest-write-queue.ts";

class ManualClock {
  now = 0;
  private nextId = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delay: number) => {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (timer: ReturnType<typeof setTimeout>) => {
    this.tasks.delete(timer as unknown as number);
  };

  async advance(milliseconds: number) {
    const target = this.now + milliseconds;
    while (true) {
      const due = Array.from(this.tasks.entries())
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.tasks.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
    this.now = target;
    await Promise.resolve();
  }
}

test("coalesces typing but forces a checkpoint at the maximum wait", async () => {
  const clock = new ManualClock();
  const writes: string[][] = [];
  const queue = new LatestWriteQueue<string, string>({
    debounceMs: 10,
    maxWaitMs: 30,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    write: async (entries) => {
      writes.push(entries.map((entry) => entry.value));
    },
  });

  queue.enqueue("page", "a");
  await clock.advance(9);
  queue.enqueue("page", "ab");
  await clock.advance(9);
  queue.enqueue("page", "abc");
  await clock.advance(9);
  queue.enqueue("page", "abcd");
  assert.equal(writes.length, 0);
  await clock.advance(3);
  await queue.flush();

  assert.deepEqual(writes, [["abcd"]]);
  assert.equal(queue.getSnapshot().status, "saved");
});

test("a slow old write cannot mark or overwrite a newer draft", async () => {
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const writes: string[][] = [];
  const statuses: string[] = [];
  const queue = new LatestWriteQueue<string, string>({
    write: async (entries) => {
      writes.push(entries.map((entry) => entry.value));
      if (writes.length === 1) await firstWrite;
    },
    onStatus: (status) => statuses.push(status),
  });

  queue.enqueue("page", "A");
  const flushing = queue.flush();
  await Promise.resolve();
  queue.enqueue("page", "B");
  assert.equal(statuses.at(-1), "dirty");
  releaseFirst();
  await flushing;

  assert.deepEqual(writes, [["A"], ["B"]]);
  assert.equal(statuses.at(-1), "saved");
});

test("a failed write retains the newest value and succeeds on retry", async () => {
  let rejectWrite = true;
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const attempts: string[][] = [];
  const queue = new LatestWriteQueue<string, string>({
    write: async (entries) => {
      attempts.push(entries.map((entry) => entry.value));
      if (attempts.length === 1) {
        await firstWrite;
        if (rejectWrite) throw new Error("disk full");
      }
    },
  });

  queue.enqueue("page", "A");
  const failedFlush = queue.flush();
  await Promise.resolve();
  queue.enqueue("page", "B");
  releaseFirst();
  await assert.rejects(failedFlush, /disk full/);
  assert.equal(queue.getSnapshot().status, "error");
  assert.equal(queue.getSnapshot().pending, 1);

  rejectWrite = false;
  await queue.retry();
  assert.deepEqual(attempts, [["A"], ["B"]]);
  assert.equal(queue.getSnapshot().status, "saved");
  assert.equal(queue.getSnapshot().pending, 0);
});

test("a durable flush repeats when a new draft appears during its checkpoint", async () => {
  const writes: string[][] = [];
  let checkpoints = 0;
  const queue = new LatestWriteQueue<string, string>({
    write: async (entries) => {
      writes.push(entries.map((entry) => entry.value));
    },
  });

  queue.enqueue("page", "A");
  await queue.flushThroughCheckpoint(async () => {
    checkpoints += 1;
    if (checkpoints === 1) queue.enqueue("page", "B");
  });

  assert.deepEqual(writes, [["A"], ["B"]]);
  assert.equal(checkpoints, 2);
  assert.equal(queue.getSnapshot().status, "saved");
});
