import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorCodeFor, nextConsecutiveCrashCount } from "./startup.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { normalizeSettings, partitionFolders, partitionNotebooks } from "./validation.ts";

describe("startup crash policy", () => {
  it("offers recovery after two consecutive unclean startup sessions", () => {
    const now = 1_000_000;
    const first = nextConsecutiveCrashCount(
      { status: "starting", at: now - 1_000, consecutiveCrashes: 0 },
      now,
    );
    const second = nextConsecutiveCrashCount(
      { status: "starting", at: now, consecutiveCrashes: first },
      now + 1_000,
    );
    assert.equal(first, 1);
    assert.equal(second, 2);
  });

  it("does not count a clean close or a stale marker as a crash", () => {
    assert.equal(
      nextConsecutiveCrashCount({ status: "clean", at: 10, consecutiveCrashes: 5 }, 20),
      0,
    );
    assert.equal(
      nextConsecutiveCrashCount(
        { status: "starting", at: 10, consecutiveCrashes: 5 },
        2 * 24 * 60 * 60 * 1_000,
      ),
      0,
    );
  });

  it("assigns a stable storage error code without exposing a stack", () => {
    assert.equal(
      errorCodeFor("database-opened", new Error("database is locked")),
      "NTS-DATABASE_OPENED-STORAGE",
    );
  });
});

describe("startup data isolation", () => {
  it("replaces corrupt settings with complete safe defaults", () => {
    const settings = normalizeSettings({
      theme: "neon",
      backupKeep: -100,
      pomodoro: { soundVolume: 5 },
      openTabIds: ["ok", 42, null],
    });
    assert.equal(settings.theme, "light");
    assert.equal(settings.backupKeep, 1);
    assert.equal(settings.pomodoro.soundVolume, 1);
    assert.deepEqual(settings.openTabIds, ["ok"]);
    assert.equal(settings.pomodoro.focusDuration, DEFAULT_SETTINGS.pomodoro.focusDuration);
  });

  it("uses temporary defaults in safe mode without reading prior values", () => {
    const settings = normalizeSettings(
      { theme: "dark", googleDriveAccessToken: "private-token", openTabIds: ["crash-note"] },
      true,
    );
    assert.equal(settings.theme, DEFAULT_SETTINGS.theme);
    assert.equal(settings.googleDriveAccessToken, null);
    assert.deepEqual(settings.openTabIds, []);
  });

  it("quarantines malformed folders and notebooks without mutating valid rows", () => {
    const folder = { id: "folder-1", name: "Học tập" };
    const notebook = { id: "note-1", name: "Đại số", cover: { color: "#0f766e" } };
    const folders = partitionFolders([folder, { id: "", name: "broken" }, null]);
    const notebooks = partitionNotebooks([notebook, { id: "bad", name: "broken" }]);
    assert.deepEqual(folders.valid, [folder]);
    assert.equal(folders.quarantined, 2);
    assert.deepEqual(notebooks.valid, [notebook]);
    assert.equal(notebooks.quarantined, 1);
  });
});
