import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNotesStore } from "@/lib/notes/store";
import { APP_VERSION } from "@/lib/notes/types";
import type { UpdateCheckResult } from "@/lib/notes/updater";
import { startupMonitor, type BootSnapshot } from "@/lib/notes/startup";
import { RecoveryScreen, StartupLoading } from "./startup-ui";

const UpdateDialog = lazy(() =>
  import("./update-dialog").then((module) => ({ default: module.UpdateDialog })),
);

function useStartupSnapshot() {
  const [snapshot, setSnapshot] = useState<BootSnapshot>(() => startupMonitor.getSnapshot());
  useEffect(() => startupMonitor.subscribe(() => setSnapshot(startupMonitor.getSnapshot())), []);
  return snapshot;
}

export function AppBoot({ children }: { children: ReactNode }) {
  const [offerSafeMode, setOfferSafeMode] = useState(() => startupMonitor.shouldOfferSafeMode());
  const snapshot = useStartupSnapshot();
  const bootError = useNotesStore((state) => state.bootError);
  const ready = useNotesStore((state) => state.ready);
  const settings = useNotesStore((state) => state.settings);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const checkedRef = useRef(false);

  useLayoutEffect(() => {
    document.getElementById("boot-fallback")?.setAttribute("hidden", "");
    startupMonitor.mark("recovery-ready");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let unlistenResize: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    let closing = false;
    void Promise.all([
      import("@tauri-apps/api/window"),
      import("@tauri-apps/api/webviewWindow"),
    ])
      .then(([{ getCurrentWindow }, { WebviewWindow }]) => {
        const current = getCurrentWindow();
        if (current.label !== "main") return;
        const resize = current.onResized(async () => {
          if (await current.isMinimized()) {
            if (useNotesStore.getState().pomodoroSession) {
              void new WebviewWindow("pomodoro", {
                url: "/pomodoro-floating",
                title: "Pomodoro",
                width: 140,
                height: 80,
                transparent: true,
                decorations: false,
                alwaysOnTop: true,
                resizable: false,
                skipTaskbar: true,
              });
            }
          } else {
            try {
              await (await WebviewWindow.getByLabel("pomodoro"))?.close();
            } catch {
              // The floating window may not exist.
            }
          }
        });
        const close = current.onCloseRequested(async (event) => {
          if (closing) return;
          event.preventDefault();
          closing = true;
          try {
            await useNotesStore.getState().flushPendingWrites();
          } catch (error) {
            startupMonitor.warn(`Không thể hoàn tất lưu dữ liệu trước khi đóng: ${String(error)}`);
          } finally {
            try {
              await current.destroy();
            } catch (error) {
              closing = false;
              startupMonitor.warn(`Không thể đóng cửa sổ ứng dụng: ${String(error)}`);
            }
          }
        });
        return Promise.all([resize, close]);
      })
      .then((stops) => {
        if (!stops) return;
        [unlistenResize, unlistenClose] = stops;
      })
      .catch((error) => startupMonitor.warn(`Không bật được cửa sổ Pomodoro: ${String(error)}`));
    return () => {
      unlistenResize?.();
      unlistenClose?.();
    };
  }, []);

  useEffect(() => {
    if (offerSafeMode) return;
    let active = true;
    const safeMode = startupMonitor.isSafeModeRequested();
    const skipLastSession = startupMonitor.shouldSkipLastSession();
    startupMonitor.startAttempt({ safeMode, skipLastSession });
    startupMonitor.mark("html-loaded");
    startupMonitor.mark("javascript-started");
    startupMonitor.mark("recovery-ready");
    void useNotesStore
      .getState()
      .hydrate({
        safeMode,
        skipLastSession,
        onStage: (stage, detail) => startupMonitor.mark(stage, detail),
        onWarning: (message) => startupMonitor.warn(message),
      })
      .then(() => {
        if (active) startupMonitor.mark("ready");
      })
      .catch((error) => {
        if (active) startupMonitor.fail(error);
      });
    return () => {
      active = false;
    };
  }, [offerSafeMode]);

  useEffect(() => {
    if (!ready || bootError || snapshot.safeMode || checkedRef.current) return;
    checkedRef.current = true;
    if (!settings.autoCheckUpdates || !settings.githubRepo) return;
    const timer = window.setTimeout(async () => {
      try {
        const { checkForGithubUpdates } = await import("@/lib/notes/updater");
        const result = await checkForGithubUpdates(settings.githubRepo, APP_VERSION);
        if (result.ok && result.result?.updateAvailable) {
          setUpdateInfo(result.result);
          setShowUpdateDialog(true);
          useNotesStore.getState().persistSettings({ lastUpdateCheckAt: Date.now() });
        }
      } catch {
        // Update checks are optional and never participate in startup health.
      }
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [bootError, ready, settings.autoCheckUpdates, settings.githubRepo, snapshot.safeMode]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void import("@/lib/notes/performance").then((monitor) => {
        monitor.startPerformanceMonitoring();
        monitor.sampleFrameRate("library-idle");
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [ready]);

  if (offerSafeMode) {
    return (
      <RecoveryScreen
        crashPrompt
        snapshot={snapshot}
        onContinue={() => setOfferSafeMode(false)}
      />
    );
  }
  if (bootError || snapshot.status === "failed") {
    return <RecoveryScreen snapshot={snapshot} />;
  }
  if (!ready) return <StartupLoading snapshot={snapshot} />;

  return (
    <>
      {snapshot.safeMode ? (
        <div className="fixed inset-x-0 top-0 z-50 flex min-h-11 items-center justify-center bg-accent px-4 py-2 text-center text-sm font-medium text-accent-fg">
          Chế độ an toàn đang bật — phiên trước, cập nhật, đồng bộ và tự động sao lưu đã được bỏ qua.
        </div>
      ) : null}
      <div className={snapshot.safeMode ? "pt-11" : undefined}>{children}</div>
      {showUpdateDialog && updateInfo ? (
        <Suspense fallback={null}>
          <UpdateDialog
            updateInfo={updateInfo}
            open={showUpdateDialog}
            onOpenChange={setShowUpdateDialog}
          />
        </Suspense>
      ) : null}
    </>
  );
}
