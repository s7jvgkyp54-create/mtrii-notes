import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTextDraftCount,
  collectActiveTextDrafts,
  registerActiveTextDraft,
} from "./text-draft-registry.ts";

const identity = {
  sessionId: "session-a",
  notebookId: "notebook-a",
  pageId: "page-a",
  objectId: "object-a",
};

test("collects the current editor and ignores a stale unregister", () => {
  const collected: string[] = [];
  const unregisterOld = registerActiveTextDraft(identity, () => collected.push("old"));
  const unregisterCurrent = registerActiveTextDraft(identity, () => collected.push("current"));

  unregisterOld();
  assert.equal(activeTextDraftCount(), 1);
  collectActiveTextDrafts();
  assert.deepEqual(collected, ["current"]);

  unregisterCurrent();
  assert.equal(activeTextDraftCount(), 0);
});
