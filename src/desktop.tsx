import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { AppBoot } from "@/components/notes/app-boot";
import { EditorView } from "@/components/notes/editor-view";
import { LibraryView } from "@/components/notes/library-view";
import { SettingsView } from "@/components/notes/settings-view";
import {
  NotesNavigationProvider,
  type NotesDestination,
} from "@/lib/notes/navigation";
import "./styles.css";

type DesktopRoute =
  | { view: "library" }
  | { view: "settings" }
  | { view: "notebook"; id: string };

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
        {route.view === "settings" ? <SettingsView /> : null}
        {route.view === "notebook" ? <EditorView notebookId={route.id} /> : null}
      </AppBoot>
      <Toaster />
    </NotesNavigationProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Không tìm thấy điểm khởi động Notes.");

createRoot(root).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);
