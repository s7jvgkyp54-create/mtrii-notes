import { APP_VERSION } from "./types.ts";

export const BOOT_STAGES = [
  { id: "window-created", label: "Cửa sổ desktop đã tạo" },
  { id: "html-loaded", label: "HTML gốc đã tải" },
  { id: "javascript-started", label: "JavaScript chính đã chạy" },
  { id: "recovery-ready", label: "Giao diện khôi phục đã sẵn sàng" },
  { id: "database-opened", label: "Cơ sở dữ liệu đã mở" },
  { id: "migration-complete", label: "Migration đã hoàn tất" },
  { id: "settings-loaded", label: "Cài đặt đã tải" },
  { id: "library-loaded", label: "Thư viện ghi chú đã tải" },
  { id: "session-restored", label: "Phiên làm việc trước đã khôi phục" },
  { id: "ready", label: "Ứng dụng sẵn sàng sử dụng" },
] as const;

export type BootStageId = (typeof BOOT_STAGES)[number]["id"];
export type BootStatus = "idle" | "starting" | "failed" | "ready";

export interface BootEvent {
  stage: BootStageId;
  at: number;
  elapsedMs: number;
  detail?: string;
}

export interface BootFailure {
  code: string;
  message: string;
  stack?: string;
  stage: BootStageId;
}

export interface BootSnapshot {
  status: BootStatus;
  stage: BootStageId;
  startedAt: number;
  updatedAt: number;
  safeMode: boolean;
  skipLastSession: boolean;
  consecutiveCrashes: number;
  events: BootEvent[];
  warnings: string[];
  failure?: BootFailure;
}

interface SessionMarker {
  status: "starting" | "running" | "clean";
  at: number;
  consecutiveCrashes: number;
}

export function nextConsecutiveCrashCount(
  previous: Pick<SessionMarker, "status" | "at" | "consecutiveCrashes"> | null,
  now: number,
) {
  const recentUnclean =
    previous && previous.status !== "clean" && now - previous.at < CRASH_WINDOW_MS;
  return recentUnclean ? previous.consecutiveCrashes + 1 : 0;
}

interface EarlyBootState {
  startedAt?: number;
  events?: Array<{ stage?: string; at?: number; detail?: string }>;
  failure?: { message?: string; stack?: string };
}

declare global {
  interface Window {
    __NOTES_EARLY_BOOT__?: EarlyBootState;
  }
}

const SESSION_KEY = "notes.startup.session.v1";
const SAFE_MODE_KEY = "notes.startup.safe-mode-once";
const SKIP_LAST_KEY = "notes.startup.skip-last-once";
const MAX_EVENT_COUNT = 60;
const MAX_WARNING_COUNT = 20;
const CRASH_WINDOW_MS = 24 * 60 * 60 * 1000;

function storageAvailable() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readMarker(): SessionMarker | null {
  if (!storageAvailable()) return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(SESSION_KEY) || "null") as SessionMarker;
    if (!value || typeof value.at !== "number" || typeof value.consecutiveCrashes !== "number") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function writeMarker(marker: SessionMarker) {
  if (!storageAvailable()) return;
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(marker));
  } catch {
    // Startup monitoring must never become a startup dependency itself.
  }
}

function safeText(value: unknown) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
    .replace(/([A-Za-z]:\\|\/Users\/|\/home\/)[^\s)\]]+/g, "<local-path>")
    .slice(0, 4_000);
}

export function errorCodeFor(stage: BootStageId, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  let family = "UNKNOWN";
  if (/database|sqlite|locked|readonly|permission|quyền/i.test(message)) family = "STORAGE";
  else if (/migration|schema|table|column/i.test(message)) family = "MIGRATION";
  else if (/json|setting|cài đặt|parse/i.test(message)) family = "SETTINGS";
  else if (/webview|chunk|module|script|asset|worker/i.test(message)) family = "RUNTIME";
  return `NTS-${stage.toUpperCase().replaceAll("-", "_")}-${family}`;
}

class StartupMonitor {
  private listeners = new Set<() => void>();
  private sessionStarted = false;
  private snapshot: BootSnapshot = {
    status: "idle",
    stage: "window-created",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    safeMode: false,
    skipLastSession: false,
    consecutiveCrashes: 0,
    events: [],
    warnings: [],
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    for (const listener of this.listeners) listener();
  }

  beginSession() {
    if (this.sessionStarted || typeof window === "undefined") return;
    this.sessionStarted = true;
    const now = Date.now();
    const previous = readMarker();
    const consecutiveCrashes = nextConsecutiveCrashCount(previous, now);
    const early = window.__NOTES_EARLY_BOOT__;
    const startedAt = early?.startedAt && Number.isFinite(early.startedAt) ? early.startedAt : now;
    const events: BootEvent[] = [];
    for (const event of early?.events ?? []) {
      const stage = BOOT_STAGES.find((item) => item.id === event.stage)?.id;
      if (!stage) continue;
      const at = typeof event.at === "number" ? event.at : now;
      events.push({ stage, at, elapsedMs: Math.max(0, at - startedAt), detail: event.detail });
    }
    this.snapshot = {
      ...this.snapshot,
      status: "starting",
      stage: events.at(-1)?.stage ?? "window-created",
      startedAt,
      updatedAt: now,
      safeMode: this.isSafeModeRequested(),
      skipLastSession: this.shouldSkipLastSession(),
      consecutiveCrashes,
      events,
    };
    writeMarker({ status: "starting", at: now, consecutiveCrashes });
    const markClean = () => {
      const marker = readMarker();
      writeMarker({
        status: "clean",
        at: Date.now(),
        consecutiveCrashes: marker?.consecutiveCrashes ?? consecutiveCrashes,
      });
    };
    window.addEventListener("pagehide", markClean, { once: true });
    window.addEventListener("beforeunload", markClean, { once: true });
    this.emit();
  }

  startAttempt(options?: { safeMode?: boolean; skipLastSession?: boolean }) {
    this.beginSession();
    const now = Date.now();
    this.snapshot = {
      ...this.snapshot,
      status: "starting",
      startedAt: now,
      updatedAt: now,
      safeMode: options?.safeMode ?? this.isSafeModeRequested(),
      skipLastSession: options?.skipLastSession ?? this.shouldSkipLastSession(),
      events: [],
      warnings: [],
      failure: undefined,
    };
    this.mark("window-created");
  }

  mark(stage: BootStageId, detail?: string) {
    const at = Date.now();
    const next: BootEvent = {
      stage,
      at,
      elapsedMs: Math.max(0, at - this.snapshot.startedAt),
      detail: detail ? safeText(detail) : undefined,
    };
    this.snapshot = {
      ...this.snapshot,
      status: stage === "ready" ? "ready" : "starting",
      stage,
      updatedAt: at,
      events: [...this.snapshot.events, next].slice(-MAX_EVENT_COUNT),
    };
    if (stage === "ready") {
      writeMarker({ status: "running", at, consecutiveCrashes: 0 });
      this.clearOneTimeFlags();
      this.snapshot = { ...this.snapshot, consecutiveCrashes: 0 };
    }
    this.emit();
  }

  warn(message: string) {
    this.snapshot = {
      ...this.snapshot,
      updatedAt: Date.now(),
      warnings: [...this.snapshot.warnings, safeText(message)].slice(-MAX_WARNING_COUNT),
    };
    this.emit();
  }

  fail(error: unknown, stage = this.snapshot.stage) {
    const parsed = error instanceof Error ? error : new Error(String(error));
    const at = Date.now();
    this.snapshot = {
      ...this.snapshot,
      status: "failed",
      stage,
      updatedAt: at,
      failure: {
        code: errorCodeFor(stage, parsed),
        message: safeText(parsed.message || "Notes không thể khởi động hoàn chỉnh."),
        stack: parsed.stack ? safeText(parsed.stack) : undefined,
        stage,
      },
    };
    this.emit();
  }

  shouldOfferSafeMode() {
    this.beginSession();
    return this.snapshot.consecutiveCrashes >= 2 && !this.snapshot.safeMode;
  }

  isSafeModeRequested() {
    if (!storageAvailable()) return false;
    return window.localStorage.getItem(SAFE_MODE_KEY) === "1";
  }

  requestSafeMode() {
    if (storageAvailable()) window.localStorage.setItem(SAFE_MODE_KEY, "1");
    this.snapshot = { ...this.snapshot, safeMode: true };
    this.emit();
  }

  requestSkipLastSession() {
    if (storageAvailable()) window.localStorage.setItem(SKIP_LAST_KEY, "1");
    this.snapshot = { ...this.snapshot, skipLastSession: true };
    this.emit();
  }

  shouldSkipLastSession() {
    if (!storageAvailable()) return false;
    return window.localStorage.getItem(SKIP_LAST_KEY) === "1";
  }

  clearOneTimeFlags() {
    if (!storageAvailable()) return;
    window.localStorage.removeItem(SAFE_MODE_KEY);
    window.localStorage.removeItem(SKIP_LAST_KEY);
  }

  clearRecoveryFlags() {
    this.clearOneTimeFlags();
    writeMarker({ status: "clean", at: Date.now(), consecutiveCrashes: 0 });
    this.snapshot = {
      ...this.snapshot,
      safeMode: false,
      skipLastSession: false,
      consecutiveCrashes: 0,
    };
    this.emit();
  }

  report(extra: Record<string, unknown> = {}) {
    return {
      reportFormat: 1,
      appVersion: APP_VERSION,
      generatedAt: new Date().toISOString(),
      startup: this.snapshot,
      ...extra,
    };
  }
}

export const startupMonitor = new StartupMonitor();
