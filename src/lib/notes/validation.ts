import type { AppSettings, Folder, Notebook } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

export function normalizeSettings(value: unknown, safeMode = false): AppSettings {
  if (safeMode || !value || typeof value !== "object" || Array.isArray(value)) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  const raw = value as Partial<AppSettings>;
  const pomodoro =
    raw.pomodoro && typeof raw.pomodoro === "object" ? raw.pomodoro : DEFAULT_SETTINGS.pomodoro;
  return {
    pomodoro: {
      focusDuration: finiteNumber(pomodoro.focusDuration, DEFAULT_SETTINGS.pomodoro.focusDuration),
      shortBreakDuration: finiteNumber(
        pomodoro.shortBreakDuration,
        DEFAULT_SETTINGS.pomodoro.shortBreakDuration,
      ),
      longBreakDuration: finiteNumber(
        pomodoro.longBreakDuration,
        DEFAULT_SETTINGS.pomodoro.longBreakDuration,
      ),
      longBreakInterval: finiteNumber(
        pomodoro.longBreakInterval,
        DEFAULT_SETTINGS.pomodoro.longBreakInterval,
      ),
      autoStartBreak: booleanValue(
        pomodoro.autoStartBreak,
        DEFAULT_SETTINGS.pomodoro.autoStartBreak,
      ),
      autoStartFocus: booleanValue(
        pomodoro.autoStartFocus,
        DEFAULT_SETTINGS.pomodoro.autoStartFocus,
      ),
      soundEnabled: booleanValue(pomodoro.soundEnabled, DEFAULT_SETTINGS.pomodoro.soundEnabled),
      soundVolume: Math.min(
        1,
        Math.max(0, finiteNumber(pomodoro.soundVolume, DEFAULT_SETTINGS.pomodoro.soundVolume)),
      ),
      notificationsEnabled: booleanValue(
        pomodoro.notificationsEnabled,
        DEFAULT_SETTINGS.pomodoro.notificationsEnabled,
      ),
      showMiniClock: booleanValue(
        pomodoro.showMiniClock,
        DEFAULT_SETTINGS.pomodoro.showMiniClock,
      ),
      pinFloatingWindow: booleanValue(
        pomodoro.pinFloatingWindow,
        DEFAULT_SETTINGS.pomodoro.pinFloatingWindow,
      ),
    },
    theme: raw.theme === "dark" ? "dark" : "light",
    penOnly: booleanValue(raw.penOnly, DEFAULT_SETTINGS.penOnly),
    favoriteColors: Array.isArray(raw.favoriteColors)
      ? raw.favoriteColors.filter((color): color is string => typeof color === "string").slice(0, 24)
      : [...DEFAULT_SETTINGS.favoriteColors],
    autoBackup: booleanValue(raw.autoBackup, DEFAULT_SETTINGS.autoBackup),
    backupKeep: Math.min(50, Math.max(1, finiteNumber(raw.backupKeep, DEFAULT_SETTINGS.backupKeep))),
    lastBackupAt: raw.lastBackupAt === null ? null : finiteNumber(raw.lastBackupAt, 0) || null,
    lastSaveAt: raw.lastSaveAt === null ? null : finiteNumber(raw.lastSaveAt, 0) || null,
    autoCheckUpdates: booleanValue(raw.autoCheckUpdates, DEFAULT_SETTINGS.autoCheckUpdates),
    googleDriveClientId: stringValue(raw.googleDriveClientId, ""),
    googleDriveClientSecret: stringValue(raw.googleDriveClientSecret, ""),
    googleDriveAccessToken:
      raw.googleDriveAccessToken === null
        ? null
        : typeof raw.googleDriveAccessToken === "string"
          ? raw.googleDriveAccessToken
          : null,
    githubRepo: stringValue(raw.githubRepo, DEFAULT_SETTINGS.githubRepo),
    lastUpdateCheckAt:
      raw.lastUpdateCheckAt === null ? null : finiteNumber(raw.lastUpdateCheckAt, 0) || null,
    openTabIds: Array.isArray(raw.openTabIds)
      ? raw.openTabIds.filter((id): id is string => typeof id === "string").slice(0, 50)
      : [],
    pageMode: raw.pageMode === "single" ? "single" : "continuous",
  };
}

function validId(value: unknown) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function partitionFolders(values: unknown[]) {
  const valid: Folder[] = [];
  let quarantined = 0;
  for (const value of values) {
    const candidate = value as Partial<Folder> | null;
    if (!candidate || !validId(candidate.id) || typeof candidate.name !== "string") {
      quarantined += 1;
      continue;
    }
    valid.push(value as Folder);
  }
  return { valid, quarantined };
}

export function partitionNotebooks(values: unknown[]) {
  const valid: Notebook[] = [];
  let quarantined = 0;
  for (const value of values) {
    const candidate = value as Partial<Notebook> | null;
    if (
      !candidate ||
      !validId(candidate.id) ||
      typeof candidate.name !== "string" ||
      !candidate.cover ||
      typeof candidate.cover.color !== "string"
    ) {
      quarantined += 1;
      continue;
    }
    valid.push(value as Notebook);
  }
  return { valid, quarantined };
}
