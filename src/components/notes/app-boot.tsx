import { useEffect, useState, useRef, type ReactNode } from "react";
import { useNotesStore } from "@/lib/notes/store";
import { APP_VERSION } from "@/lib/notes/types";
import { checkForGithubUpdates, type UpdateCheckResult } from "@/lib/notes/updater";
import { UpdateDialog } from "./update-dialog";

export function AppBoot({ children }: { children: ReactNode }) {
  const bootError = useNotesStore((s) => s.bootError);
  const ready = useNotesStore((s) => s.ready);
  const settings = useNotesStore((s) => s.settings);

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    void useNotesStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (!ready || checkedRef.current) return;
    checkedRef.current = true;

    if (settings.autoCheckUpdates && settings.githubRepo) {
      const timer = setTimeout(async () => {
        try {
          const res = await checkForGithubUpdates(settings.githubRepo, APP_VERSION);
          if (res.ok && res.result?.updateAvailable) {
            setUpdateInfo(res.result);
            setShowUpdateDialog(true);
            useNotesStore.getState().persistSettings({
              lastUpdateCheckAt: Date.now(),
            });
          }
        } catch {
          // Silent fail on background boot check
        }
      }, 1200);

      return () => clearTimeout(timer);
    }
  }, [ready, settings.autoCheckUpdates, settings.githubRepo]);

  if (bootError) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg">
        <p className="text-lg font-semibold">Không mở được kho dữ liệu</p>
        <p className="max-w-md text-sm text-muted">{bootError}</p>
      </div>
    );
  }

  return (
    <>
      {children}
      <UpdateDialog
        updateInfo={updateInfo}
        open={showUpdateDialog}
        onOpenChange={setShowUpdateDialog}
      />
    </>
  );
}