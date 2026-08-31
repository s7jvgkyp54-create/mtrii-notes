import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  UpdateCheckResult,
  downloadAndInstallUpdate,
  openExternalUrl,
} from "@/lib/notes/updater";
import { isDesktopRuntime } from "@/lib/notes/desktop-db";
import {
  Sparkles,
  Download,
  ExternalLink,
  Loader2,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { toast } from "sonner";

export function UpdateDialog({
  updateInfo,
  open,
  onOpenChange,
}: {
  updateInfo: UpdateCheckResult | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (!updateInfo) return null;

  const isDesktop = isDesktopRuntime();
  const formatSize = (bytes: number | null) => {
    if (!bytes) return "";
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleInstall = async () => {
    if (!updateInfo.downloadUrl) {
      void openExternalUrl(updateInfo.releaseUrl);
      return;
    }

    if (!isDesktop) {
      void openExternalUrl(updateInfo.downloadUrl);
      return;
    }

    setDownloading(true);
    setDownloadError(null);

    try {
      toast.info("Đang tải bản cập nhật và chuẩn bị nâng cấp...");
      await downloadAndInstallUpdate(updateInfo.downloadUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDownloadError(msg);
      toast.error(`Lỗi cập nhật: ${msg}`);
      setDownloading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (downloading) return; // Prevent closing while downloading
        onOpenChange(v);
      }}
      title="Bản cập nhật mới sẵn sàng"
      className="w-[min(94vw,520px)] max-h-[85vh] overflow-y-auto"
    >
      <div className="space-y-4 pt-1">
        {/* Version banner */}
        <div className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary/5 p-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-fg shadow-sm">
              <Sparkles className="size-5" />
            </div>
            <div>
              <p className="font-semibold text-sm leading-tight text-fg">
                {updateInfo.releaseTitle || `Phiên bản ${updateInfo.latestVersion}`}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <span>v{updateInfo.currentVersion}</span>
                <ArrowRight className="size-3 text-muted/60" />
                <span className="font-semibold text-primary">v{updateInfo.latestVersion}</span>
              </div>
            </div>
          </div>
          {updateInfo.assetSize && (
            <span className="rounded-md bg-surface-3 px-2 py-1 text-[11px] font-medium text-muted">
              {formatSize(updateInfo.assetSize)}
            </span>
          )}
        </div>

        {/* Release notes */}
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            Nội dung thay đổi
          </p>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-surface-1 p-3 text-xs leading-relaxed text-fg/90 whitespace-pre-wrap">
            {updateInfo.releaseNotes || "Phiên bản mới bao gồm các cải tiến hiệu năng và sửa lỗi."}
          </div>
        </div>

        {/* Download error banner if any */}
        {downloadError && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">Không thể tự động tải bản cập nhật:</p>
              <p className="mt-0.5 opacity-90">{downloadError}</p>
            </div>
          </div>
        )}

        {/* Download progress / spinner */}
        {downloading && (
          <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-center">
            <div className="flex items-center justify-center gap-2 text-xs font-medium text-fg">
              <Loader2 className="size-4 animate-spin text-primary" />
              Đang tải bộ cài đặt từ GitHub và chuẩn bị nâng cấp...
            </div>
            <p className="text-[11px] text-muted">
              Sau khi tải xong, bộ cài đặt sẽ tự động mở để nâng cấp ứng dụng.
            </p>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={downloading}
            onClick={() => onOpenChange(false)}
          >
            Để sau
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void openExternalUrl(updateInfo.releaseUrl)}
            className="gap-1.5"
          >
            <ExternalLink className="size-3.5" />
            Xem trên GitHub
          </Button>

          <Button
            size="sm"
            disabled={downloading}
            onClick={() => void handleInstall()}
            className="gap-1.5 bg-primary text-primary-fg"
          >
            {downloading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Đang tải...
              </>
            ) : (
              <>
                <Download className="size-3.5" />
                {isDesktop && updateInfo.downloadUrl
                  ? "Cập nhật và Khởi động lại"
                  : "Tải bản cập nhật"}
              </>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}