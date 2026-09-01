import { lazy, StrictMode, Suspense, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { LoaderCircle } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { AppBoot } from "@/components/notes/app-boot";
import { AppErrorBoundary } from "@/components/notes/app-error-boundary";
import { LibraryView } from "@/components/notes/library-view";
import {
  NotesNavigationProvider,
  type NotesDestination,
} from "@/lib/notes/navigation";
import { startupMonitor } from "@/lib/notes/startup";
import "./styles.css";

const EditorView = lazy(() =>
  import("@/components/notes/editor-view").then((module) => ({ default: module.EditorView })),
);
const SettingsView = lazy(() =>
  import("@/components/notes/settings-view").then((module) => ({ default: module.SettingsView })),
);

type DesktopRoute =
  | { view: "library" }
  | { view: "settings" }
  | { view: "notebook"; id: string };

function ViewLoading({ label }: { label: string }) {
  return (
    <main className="grid min-h-svh place-items-center bg-bg px-4 text-fg" aria-busy="true">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-[var(--shadow-soft)]">
        <LoaderCircle className="size-5 animate-spin text-accent" aria-hidden />
        <p className="text-sm font-medium">{label}</p>
      </div>
    </main>
  );
}

function DesktopApp() {
  const [route, setRoute] = useState<DesktopRoute>({ view: "library" });
  const navigate = useCallback((destination: NotesDestination) => {
    if (destination.to === "/settings") setRoute({ view: "settings" });
    else if (destination.to === "/notebook/$id") {
      setRoute({ view: "notebook", id: destination.params.id });
    } else setRoute({ view: "library" });
  }, []);

  return (
    <NotesNavigationProvider navigate={navigate}>
      <AppBoot>
        {route.view === "library" ? <LibraryView /> : null}
        {route.view === "settings" ? (
          <Suspense fallback={<ViewLoading label="Đang mở cài đặt…" />}>
            <SettingsView />
          </Suspense>
        ) : null}
        {route.view === "notebook" ? (
          <Suspense fallback={<ViewLoading label="Đang chuẩn bị sổ tay…" />}>
            <EditorView notebookId={route.id} />
          </Suspense>
        ) : null}
      </AppBoot>
      <Toaster />
    </NotesNavigationProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Không tìm thấy điểm khởi động Notes.");
startupMonitor.beginSession();
startupMonitor.mark("javascript-started");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <DesktopApp />
    </AppErrorBoundary>
  </StrictMode>,
);
